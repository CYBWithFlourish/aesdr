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
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Signature,
} from "@solana/kit";

import { signAndSend, type AesdrContext } from "./transport";

export { EscrowState, STATE_LABEL };
export type { Address, KeyPairSigner, Signature };

/** Everything needed to describe one paid session. */
export type LockParams = {
  buyer: KeyPairSigner;
  seller: Address;
  arbiter: Address;
  /** 32-byte session nonce. */
  sessionId: Uint8Array;
  /** Lamports the buyer locks. */
  amount: bigint;
  /** Collateral the seller must already have posted. */
  minBond: bigint;
  /** Seconds from now until the buyer may reclaim unilaterally. */
  deadlineSeconds: number;
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
  amount: bigint;
  minBond: bigint;
  /** Unix seconds. */
  deadline: number;
  state: EscrowState;
  stateLabel: string;
  /** Lamports actually sitting in the vault. The truth, not a cached field. */
  vaultLamports: bigint;  /** True once the deadline has passed and the escrow is still open. */
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
  async postBond(args: { seller: KeyPairSigner; amount: bigint }): Promise<Signature> {
    const instruction = await getPostBondInstructionAsync(
      { seller: args.seller, amount: lamports(args.amount) },
      { programAddress: this.programAddress }
    );
    return signAndSend(this.ctx, instruction, args.seller);
  }

  /** How much collateral a seller currently has locked. */
  async bondBalance(seller: Address): Promise<bigint> {
    const [bond] = await findBondPda({ seller }, { programAddress: this.programAddress });
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
      throw new Error(`sessionId must be 32 bytes, got ${args.sessionId.length}`);
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + args.deadlineSeconds);

    const instruction = await getInitEscrowInstructionAsync(
      {
        buyer: args.buyer,
        seller: args.seller,
        arbiter: args.arbiter,
        sessionId: args.sessionId,
        amount: lamports(args.amount),
        minBond: lamports(args.minBond),
        deadline,
      },
      { programAddress: this.programAddress }
    );

    const signature = await signAndSend(this.ctx, instruction, args.buyer);

    const [escrow] = await findEscrowPda(
      { buyer: args.buyer.address, seller: args.seller, sessionId: args.sessionId },
      { programAddress: this.programAddress }
    );
    const [vault] = await findVaultPda({ escrow }, { programAddress: this.programAddress });

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

    const [vault] = await findVaultPda({ escrow }, { programAddress: this.programAddress });
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
    /** Price the seller quoted, in lamports. A mismatch is a rejection. */
    expectedAmount?: bigint;
  }): Promise<{ valid: boolean; reason?: string; escrow?: EscrowView }> {
    const tx = await this.ctx.rpc
      .getTransaction(args.txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
        encoding: "json",
      })
      .send();
    if (!tx) return { valid: false, reason: "transaction not found" };
    if (tx.meta?.err) return { valid: false, reason: "transaction failed on chain" };

    const [escrowAddress] = await findEscrowPda(
      { buyer: args.buyer, seller: args.seller, sessionId: args.sessionId },
      { programAddress: this.programAddress }
    );

    const escrow = await this.read(escrowAddress);
    if (!escrow) {
      return { valid: false, reason: "no escrow at the derived address (lock not confirmed?)" };
    }
    if (escrow.state !== EscrowState.Open) {
      return { valid: false, reason: `escrow is ${escrow.stateLabel}, not OPEN` };
    }
    if (escrow.sessionId !== bytesToHex(args.sessionId)) {
      return { valid: false, reason: "session id mismatch" };
    }
    if (args.expectedAmount !== undefined && escrow.amount !== args.expectedAmount) {
      return {
        valid: false,
        reason: `locked ${escrow.amount} lamports, expected ${args.expectedAmount}`,
      };
    }
    if (escrow.vaultLamports < escrow.amount) {
      return { valid: false, reason: "vault holds less than the escrowed amount" };
    }

    return { valid: true, escrow };
  }

  // --------------------------------------------------------------- arbiter

  /** Verdict PASS: pay the seller. Only the arbiter can sign this. */
  async release(args: { arbiter: KeyPairSigner; escrow: Address }): Promise<Signature> {
    const view = await this.requireOpen(args.escrow);

    const instruction = await getReleaseInstructionAsync(
      {
        arbiter: args.arbiter,
        escrow: args.escrow,
        seller: view.seller,
      },
      { programAddress: this.programAddress }
    );

    return signAndSend(this.ctx, instruction, args.arbiter);
  }

  /** Verdict BREACH: refund the buyer and slash 10% of the seller's bond. */
  async refund(args: { arbiter: KeyPairSigner; escrow: Address }): Promise<Signature> {
    const view = await this.requireOpen(args.escrow);
    const [bond] = await findBondPda(
      { seller: view.seller },
      { programAddress: this.programAddress }
    );

    const instruction = await getRefundInstructionAsync(
      {
        arbiter: args.arbiter,
        escrow: args.escrow,
        buyer: view.buyer,
        bond,
      },
      { programAddress: this.programAddress }
    );

    return signAndSend(this.ctx, instruction, args.arbiter);
  }

  /** Deadline escape hatch: the buyer needs nobody's cooperation. */
  async reclaim(args: { buyer: KeyPairSigner; escrow: Address }): Promise<Signature> {
    await this.requireOpen(args.escrow);

    const instruction = await getReclaimInstructionAsync(
      { buyer: args.buyer, escrow: args.escrow },
      { programAddress: this.programAddress }
    );

    return signAndSend(this.ctx, instruction, args.buyer);
  }

  /** Lamports a refund would return to the buyer on top of the escrow. */
  slashEstimate(minBond: bigint, bondLamports: bigint): bigint {
    const target = (minBond * BigInt(SLASH_BPS)) / BigInt(BPS_DENOMINATOR);
    return target < bondLamports ? target : bondLamports;
  }

  // ---------------------------------------------------------------- private

  private async requireOpen(escrow: Address): Promise<EscrowView> {
    const view = await this.read(escrow);
    if (!view) throw new Error(`escrow ${escrow} does not exist`);
    if (view.state !== EscrowState.Open) {
      throw new Error(`escrow is ${view.stateLabel}, settlement already happened`);
    }
    return view;
  }
}

function bytesToHex(bytes: ReadonlyUint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
