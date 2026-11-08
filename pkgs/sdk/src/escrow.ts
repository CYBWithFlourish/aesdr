import {
  AESDR_PROGRAM_ADDRESS,
  BPS_DENOMINATOR,
  EscrowState,
  SLASH_BPS,
  STATE_LABEL,
  findBondPda,
  findEscrowPda,
  findVaultPda,
  getEscrowDecoder,
  getInitEscrowInstructionAsync,
  getPostBondInstructionAsync,
  getReclaimInstructionAsync,
  getRefundInstructionAsync,
  getReleaseInstructionAsync,
  type Escrow,
} from "@aesdr/client";
import {
  fetchEncodedAccount,
  lamports,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token";

import { signAndSendAll, type AesdrContext } from "./transport";

export { EscrowState, STATE_LABEL };
export type { Address, KeyPairSigner, Signature, TransactionSigner };

/** Lamports (native SOL) or an SPL token such as USDC. */
export const ASSET_LAMPORTS = 0;
export const ASSET_SPL = 1;

/** True when an escrow is denominated in the quoted asset. */
function sameAsset(
  view: { asset: number; mint: Address },
  expected: Asset
): boolean {
  if (expected.kind === "lamports") return view.asset === ASSET_LAMPORTS;
  return view.asset === ASSET_SPL && view.mint === expected.mint;
}

/** Human-readable asset, for error messages. */
function describeAsset(view: { asset: number; mint: Address } | Asset): string {
  if ("kind" in view) {
    return view.kind === "lamports" ? "lamports" : `token ${view.mint}`;
  }
  return view.asset === ASSET_SPL ? `token ${view.mint}` : "lamports";
}

export type Asset =
  | { kind: "lamports" }
  | { kind: "spl"; /** Mint address, e.g. USDC. */ mint: Address };

/** Everything needed to describe one paid session. */
export type LockParams = {
  /**
   * The buyer. A server-side script passes a `KeyPairSigner`; a browser passes
   * the sending signer a wallet hook returns. Both satisfy `TransactionSigner`.
   */
  buyer: TransactionSigner;
  seller: Address;
  arbiter: Address;
  /** 32-byte session nonce. */
  sessionId: Uint8Array;
  /** Amount the buyer locks: lamports, or token base units for SPL. */
  amount: bigint;
  /** Collateral the seller must already have posted, always in lamports. */
  minBond: bigint;
  /** Seconds from now until the buyer may reclaim unilaterally. */
  deadlineSeconds: number;
  /** Defaults to native lamports. */
  asset?: Asset;
  /**
   * SPL only: the buyer's source token account. Defaults to the buyer's ATA
   * for the mint, which is what almost everyone wants.
   */
  buyerTokenAccount?: Address;
};

/** Decoded, human-shaped view of an escrow. Numbers are converted, not raw. */
export type EscrowView = {
  address: Address;
  vault: Address;
  buyer: Address;
  seller: Address;
  arbiter: Address;
  /** Lowercase hex. */
  sessionId: string;
  /** 0 = lamports, 1 = SPL. */
  asset: number;
  /** Mint address for SPL escrows; the system program address for lamports. */
  mint: Address;
  amount: bigint;
  minBond: bigint;
  /** Unix seconds. */
  deadline: number;
  state: EscrowState;
  stateLabel: string;
  /** Lamports actually sitting in the vault. The truth, not a cached field. */
  vaultLamports: bigint;
  /** True once the deadline has passed and the escrow is still open. */
  reclaimable: boolean;
};

export class Aesdr {
  readonly programAddress: Address;

  constructor(
    private readonly ctx: AesdrContext,
    options: { programAddress?: Address } = {}
  ) {
    this.programAddress = options.programAddress ?? AESDR_PROGRAM_ADDRESS;
  }

  get address(): Address {
    return this.programAddress;
  }

  // ---------------------------------------------------------------- seller

  /** Post or top up seller collateral. Required once before being payable. */
  async postBond(args: {
    seller: TransactionSigner;
    amount: bigint;
  }): Promise<Signature> {
    const instruction = await getPostBondInstructionAsync(
      { seller: args.seller, amount: lamports(args.amount) },
      { programAddress: this.programAddress }
    );
    return signAndSendAll(this.ctx, [instruction], args.seller);
  }

  /** How much collateral a seller currently has locked. */
  async bondBalance(seller: Address): Promise<bigint> {
    const [bond] = await findBondPda(
      { seller },
      { programAddress: this.programAddress }
    );
    const account = await fetchEncodedAccount(this.ctx.rpc, bond);
    return account.exists ? account.lamports : 0n;
  }

  // ----------------------------------------------------------------- buyer

  /**
   * Lock funds for one session.
   *
   * Returns the escrow address and the lock signature - that signature is the
   * receipt the seller verifies before delivering anything.
   */
  async lock(args: LockParams): Promise<{
    escrow: Address;
    vault: Address;
    signature: Signature;
  }> {
    if (args.sessionId.length !== 32) {
      throw new Error(
        `sessionId must be 32 bytes, got ${args.sessionId.length}`
      );
    }

    const deadline = BigInt(
      Math.floor(Date.now() / 1000) + args.deadlineSeconds
    );

    const asset = args.asset ?? { kind: "lamports" as const };

    const [escrow] = await findEscrowPda(
      {
        buyer: args.buyer.address,
        seller: args.seller,
        sessionId: args.sessionId,
      },
      { programAddress: this.programAddress }
    );
    const [vault] = await findVaultPda(
      { escrow },
      { programAddress: this.programAddress }
    );

    const base = {
      buyer: args.buyer,
      seller: args.seller,
      arbiter: args.arbiter,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      sessionId: args.sessionId,
      amount: lamports(args.amount),
      minBond: lamports(args.minBond),
      deadline,
    };

    // Anchor's convention for an absent optional account is the program's own
    // address. The generated client forwards it verbatim, the runtime maps it
    // to `None`, and the handler never touches it on the lamport path.
    const none = this.programAddress;

    let mint: Address = none;
    let buyerTokenAccount: Address = none;
    let vaultAta: Address = none;

    if (asset.kind === "spl") {
      const [buyerAta] = await findAssociatedTokenPda({
        owner: args.buyer.address,
        mint: asset.mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const [derivedVaultAta] = await findAssociatedTokenPda({
        owner: vault,
        mint: asset.mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      mint = asset.mint;
      buyerTokenAccount = args.buyerTokenAccount ?? buyerAta;
      vaultAta = derivedVaultAta;
    }

    const instruction = await getInitEscrowInstructionAsync(
      {
        ...base,
        mint,
        buyerTokenAccount,
        vaultAta,
        asset: asset.kind === "spl" ? ASSET_SPL : ASSET_LAMPORTS,
      },
      { programAddress: this.programAddress }
    );

    // Creation is prepended instead of left to `init_if_needed`, because the
    // buyer cannot sign for the vault PDA: the idempotent create instruction
    // names the vault as authority while the buyer only pays.
    const instructions =
      asset.kind === "spl"
        ? [
            await createAtaIdempotent(args.buyer, vaultAta, vault, asset.mint),
            instruction,
          ]
        : [instruction];

    const signature = await signAndSendAll(this.ctx, instructions, args.buyer);

    return { escrow, vault, signature };
  }

  // ------------------------------------------------------------ any party

  /** Read an escrow by address. Returns null when it does not exist. */
  async read(escrow: Address): Promise<EscrowView | null> {
    const account = await fetchEncodedAccount(this.ctx.rpc, escrow);
    if (!account.exists) return null;

    let decoded: Escrow;
    try {
      decoded = getEscrowDecoder().decode(account.data);
    } catch {
      // Not an escrow account (wrong owner or layout).
      return null;
    }

    const [vault] = await findVaultPda(
      { escrow },
      { programAddress: this.programAddress }
    );
    const vaultAccount = await fetchEncodedAccount(this.ctx.rpc, vault);
    const vaultLamports = vaultAccount.exists ? vaultAccount.lamports : 0n;

    const state = decoded.state as EscrowState;
    const deadline = Number(decoded.deadline);
    const now = Math.floor(Date.now() / 1000);

    return {
      address: escrow,
      vault,
      buyer: decoded.buyer,
      seller: decoded.seller,
      arbiter: decoded.arbiter,
      sessionId: bytesToHex(decoded.sessionId),
      asset: decoded.asset,
      mint: decoded.mint,
      amount: decoded.amount,
      minBond: decoded.minBond,
      deadline,
      state,
      stateLabel: STATE_LABEL[state],
      vaultLamports,
      reclaimable: state === EscrowState.Open && now >= deadline,
    };
  }

  /**
   * Verify a lock receipt without trusting what the buyer claims about it.
   *
   * The escrow address is *derived* from buyer + seller + session id rather than
   * read out of logs or taken from the caller. A buyer therefore cannot point a
   * seller at an unrelated escrow, and a seller cannot be tricked into
   * delivering against an account it did not expect.
   */
  async verifyLock(args: {
    txSignature: Signature;
    sessionId: Uint8Array;
    buyer: Address;
    seller: Address;
    /** Price the seller quoted, in base units of `expectedAsset`. */
    expectedAmount?: bigint;
    /**
     * Currency the seller quoted. Checked when supplied, because an amount
     * alone is ambiguous: 250000 lamports and 0.25 USDC are the same number.
     */
    expectedAsset?: Asset;
  }): Promise<{ valid: boolean; reason?: string; escrow?: EscrowView }> {
    const tx = await this.ctx.rpc
      .getTransaction(args.txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
        encoding: "json",
      })
      .send();
    if (!tx) return { valid: false, reason: "transaction not found" };
    if (tx.meta?.err)
      return { valid: false, reason: "transaction failed on chain" };

    const [escrowAddress] = await findEscrowPda(
      { buyer: args.buyer, seller: args.seller, sessionId: args.sessionId },
      { programAddress: this.programAddress }
    );

    const escrow = await this.read(escrowAddress);
    if (!escrow) {
      return {
        valid: false,
        reason: "no escrow at the derived address (lock not confirmed?)",
      };
    }
    if (escrow.state !== EscrowState.Open) {
      return {
        valid: false,
        reason: `escrow is ${escrow.stateLabel}, not OPEN`,
      };
    }
    if (escrow.sessionId !== bytesToHex(args.sessionId)) {
      return { valid: false, reason: "session id mismatch" };
    }
    if (
      args.expectedAmount !== undefined &&
      escrow.amount !== args.expectedAmount
    ) {
      return {
        valid: false,
        reason: `locked ${escrow.amount} base units, expected ${args.expectedAmount}`,
      };
    }
    if (
      args.expectedAsset !== undefined &&
      !sameAsset(escrow, args.expectedAsset)
    ) {
      return {
        valid: false,
        reason: `locked ${describeAsset(escrow)} but expected ${describeAsset(
          args.expectedAsset
        )}`,
      };
    }

    // Compare against the vault that actually holds this currency. A token
    // escrow keeps its value in the vault's ATA, so the vault PDA's lamport
    // balance is only rent and says nothing about whether the lock landed.
    const held = await this.vaultHolds(escrow);
    if (held < escrow.amount) {
      return {
        valid: false,
        reason: `vault holds ${held} of ${escrow.amount} ${
          escrow.asset === ASSET_SPL ? "base units" : "lamports"
        }`,
      };
    }

    return { valid: true, escrow };
  }

  // --------------------------------------------------------------- arbiter

  /** Verdict PASS: pay the seller. Only the arbiter can sign this. */
  async release(args: {
    arbiter: TransactionSigner;
    escrow: Address;
  }): Promise<Signature> {
    const view = await this.requireOpen(args.escrow);
    const spl = await this.tokenAccountsFor(view);
    const none = this.programAddress;

    const instruction = await getReleaseInstructionAsync(
      {
        arbiter: args.arbiter,
        escrow: args.escrow,
        seller: view.seller,
        mint: spl?.mint ?? none,
        vaultAta: spl?.vaultAta ?? none,
        sellerAta: spl?.sellerAta ?? none,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      },
      { programAddress: this.programAddress }
    );

    const instructions = spl
      ? await this.prependAtaCreate(
          args.arbiter,
          spl.sellerAta,
          view.seller,
          spl.mint,
          instruction
        )
      : [instruction];

    return signAndSendAll(this.ctx, instructions, args.arbiter);
  }

  /** Verdict BREACH: refund the buyer and slash 10% of the seller's bond. */
  async refund(args: {
    arbiter: TransactionSigner;
    escrow: Address;
  }): Promise<Signature> {
    const view = await this.requireOpen(args.escrow);
    const [bond] = await findBondPda(
      { seller: view.seller },
      { programAddress: this.programAddress }
    );
    const spl = await this.tokenAccountsFor(view);
    const none = this.programAddress;

    const instruction = await getRefundInstructionAsync(
      {
        arbiter: args.arbiter,
        escrow: args.escrow,
        buyer: view.buyer,
        bond,
        mint: spl?.mint ?? none,
        vaultAta: spl?.vaultAta ?? none,
        buyerAta: spl?.buyerAta ?? none,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      },
      { programAddress: this.programAddress }
    );

    const instructions = spl
      ? await this.prependAtaCreate(
          args.arbiter,
          spl.buyerAta,
          view.buyer,
          spl.mint,
          instruction
        )
      : [instruction];

    return signAndSendAll(this.ctx, instructions, args.arbiter);
  }

  /** Deadline escape hatch: the buyer needs nobody's cooperation. */
  async reclaim(args: {
    buyer: TransactionSigner;
    escrow: Address;
  }): Promise<Signature> {
    const view = await this.requireOpen(args.escrow);
    const spl = await this.tokenAccountsFor(view);
    const none = this.programAddress;

    const instruction = await getReclaimInstructionAsync(
      {
        buyer: args.buyer,
        escrow: args.escrow,
        mint: spl?.mint ?? none,
        vaultAta: spl?.vaultAta ?? none,
        buyerAta: spl?.buyerAta ?? none,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      },
      { programAddress: this.programAddress }
    );

    const instructions = spl
      ? await this.prependAtaCreate(
          args.buyer,
          spl.buyerAta,
          view.buyer,
          spl.mint,
          instruction
        )
      : [instruction];

    return signAndSendAll(this.ctx, instructions, args.buyer);
  }

  /** Lamports a refund would return to the buyer on top of the escrow. */
  slashEstimate(minBond: bigint, bondLamports: bigint): bigint {
    const target = (minBond * BigInt(SLASH_BPS)) / BigInt(BPS_DENOMINATOR);
    return target < bondLamports ? target : bondLamports;
  }

  // ---------------------------------------------------------------- private

  /**
   * The SPL accounts a settlement instruction expects.
   *
   * Always returned, because the program declares them unconditionally; on a
   * lamport escrow they are never read. The recipient ATA is the one the buyer
   * or seller actually owns, so settlement lands where the money is expected.
   */
  private async tokenAccountsFor(view: EscrowView): Promise<{
    mint: Address;
    vaultAta: Address;
    buyerAta: Address;
    sellerAta: Address;
  } | null> {
    // Lamport escrows need none of this: the program never reads these
    // accounts, so they are omitted entirely.
    if (view.asset !== ASSET_SPL) return null;

    const [vaultAta] = await findAssociatedTokenPda({
      owner: view.vault,
      mint: view.mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [buyerAta] = await findAssociatedTokenPda({
      owner: view.buyer,
      mint: view.mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [sellerAta] = await findAssociatedTokenPda({
      owner: view.seller,
      mint: view.mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    return { mint: view.mint, vaultAta, buyerAta, sellerAta };
  }

  /**
   * How much of the escrow's currency the vault actually holds.
   *
   * Two different places depending on the asset: lamports sit directly on the
   * vault PDA, while tokens sit in the ATA the vault PDA owns.
   */
  private async vaultHolds(view: EscrowView): Promise<bigint> {
    if (view.asset !== ASSET_SPL) return view.vaultLamports;

    const [vaultAta] = await findAssociatedTokenPda({
      owner: view.vault,
      mint: view.mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    try {
      const token = await fetchToken(this.ctx.rpc, vaultAta);
      return token.data.amount;
    } catch {
      // No ATA yet, so nothing has been locked.
      return 0n;
    }
  }

  /**
   * Prepend an ATA create when the recipient has no account yet.
   *
   * Only called on the SPL path, so a SOL payout never pays token rent. The
   * create is idempotent, but skipping it when the account exists keeps the
   * settlement transaction to a single instruction in the common case.
   */
  private async prependAtaCreate(
    payer: TransactionSigner,
    ata: Address,
    owner: Address,
    mint: Address,
    instruction: Instruction
  ): Promise<Instruction[]> {
    if (await ataExists(this.ctx.rpc, ata)) return [instruction];
    return [await createAtaIdempotent(payer, ata, owner, mint), instruction];
  }

  private async requireOpen(escrow: Address): Promise<EscrowView> {
    const view = await this.read(escrow);
    if (!view) throw new Error(`escrow ${escrow} does not exist`);
    if (view.state !== EscrowState.Open) {
      throw new Error(
        `escrow is ${view.stateLabel}, settlement already happened`
      );
    }
    return view;
  }
}

/**
 * Build the idempotent ATA-create instruction for a recipient.
 *
 * Needed because the program no longer creates ATAs on settlement: a buyer
 * cannot sign for the seller's account, so the payer (whoever signs the
 * settlement) creates it explicitly. Idempotent means an existing ATA is a
 * no-op rather than an error.
 */
async function createAtaIdempotent(
  payer: TransactionSigner,
  ata: Address,
  owner: Address,
  mint: Address
): Promise<Instruction> {
  return getCreateAssociatedTokenIdempotentInstructionAsync({
    payer,
    ata,
    owner,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
}

function ataExists(rpc: AesdrContext["rpc"], ata: Address): Promise<boolean> {
  return fetchEncodedAccount(rpc, ata).then((a) => a.exists);
}

function bytesToHex(bytes: ReadonlyUint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
