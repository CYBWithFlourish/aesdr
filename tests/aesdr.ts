/**
 * Program-level tests, driven through the SDK on @solana/kit.
 *
 * The previous version of this file used Anchor's provider and web3.js v1.
 * Both are legacy: web3.js 1.x is in maintenance mode and Kit is the
 * recommended client. Assertions here are on lamport deltas and decoded state,
 * so they prove the program moves money rather than merely returning Ok.
 *
 * Requires a validator with the program loaded - see README, or run
 * `npm run test:local` which starts one.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  fetchEncodedAccount,
  lamports,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { assert } from "chai";

import { Aesdr, EscrowState, sol, usdc } from "@aesdr/sdk";
import type { Asset } from "@aesdr/sdk";

const RPC_URL = process.env.AESDR_RPC ?? "http://127.0.0.1:8899";
const KEY_DIR = mkdtempSync(join(tmpdir(), "aesdr-prog-"));

const rpc = createSolanaRpc(RPC_URL) as Rpc<SolanaRpcApi>;
const aesdr = new Aesdr({ rpc });

/**
 * Create a throwaway SPL mint, returning its address.
 *
 * Only needed for the SPL tests: on devnet the demo uses the official USDC
 * mint, but a local validator has no USDC, so the tests mint their own.
 */
function createTestMint(): Address {
  const out = spawnSync(
    "spl-token",
    [
      "create-token",
      "--url",
      RPC_URL,
      "--fee-payer",
      `${process.env.HOME}/.config/solana/id.json`,
    ],
    { encoding: "utf8" }
  );
  if (out.status !== 0)
    throw new Error(`spl-token create-token failed: ${out.stderr}`);
  const mint = /Creating token (\w+)/.exec(out.stdout)?.[1];
  if (!mint) throw new Error(`could not parse mint from: ${out.stdout}`);
  return mint as Address;
}

/** Create an owner's ATA for a mint and return it. */
function createAta(mint: Address, owner: Address): Address {
  const out = spawnSync(
    "spl-token",
    [
      "create-account",
      String(mint),
      "--url",
      RPC_URL,
      "--fee-payer",
      `${process.env.HOME}/.config/solana/id.json`,
      "--owner",
      String(owner),
    ],
    { encoding: "utf8" }
  );
  if (out.status !== 0)
    throw new Error(`spl-token create-account failed: ${out.stderr}`);
  const ata = /Creating account (\w+)/.exec(out.stdout)?.[1];
  if (!ata) throw new Error(`could not parse ATA from: ${out.stdout}`);
  return ata as Address;
}

/**
 * The buyer's ATA for a mint, created once and cached.
 *
 * `spl-token create-account` fails when the account already exists, so tests
 * that need the same ATA twice must not call it again.
 */
const ataCache = new Map<string, Address>();
/** Set in `before`; the ATA helper runs after signer setup. */
let currentBuyer: Address | undefined;
async function buyerAtaFor(mint: Address): Promise<Address> {
  const cached = ataCache.get(String(mint));
  if (cached) return cached;
  const ata = createAta(mint, currentBuyer!);
  ataCache.set(String(mint), ata);
  return ata;
}

/** Mint test tokens into an ATA. */
function mintTo(mint: Address, ata: Address, amount: number): void {
  const out = spawnSync(
    "spl-token",
    [
      "mint",
      String(mint),
      String(amount),
      "--url",
      RPC_URL,
      "--fee-payer",
      `${process.env.HOME}/.config/solana/id.json`,
      String(ata),
    ],
    { encoding: "utf8" }
  );
  if (out.status !== 0) throw new Error(`spl-token mint failed: ${out.stderr}`);
}

async function fundedSigner(
  name: string,
  amountSol = 5
): Promise<KeyPairSigner> {
  const path = join(KEY_DIR, `${name}.json`);
  spawnSync(
    "solana-keygen",
    ["new", "--no-bip39-passphrase", "-s", "-o", path, "--force"],
    {
      stdio: "pipe",
    }
  );
  const address = spawnSync("solana-keygen", ["pubkey", path], {
    encoding: "utf8",
  }).stdout.trim();
  const transfer = spawnSync(
    "solana",
    [
      "transfer",
      "--allow-unfunded-recipient",
      "--url",
      RPC_URL,
      "--keypair",
      `${process.env.HOME}/.config/solana/id.json`,
      address,
      String(amountSol),
    ],
    { stdio: "pipe" }
  );
  if (transfer.status !== 0) {
    throw new Error(`faucet transfer failed: ${transfer.stderr.toString()}`);
  }
  return createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync(path, "utf8")))
  );
}

/** Chain time, not wall time. */
async function chainNow(): Promise<number> {
  const slot = await rpc.getSlot().send();
  const blockTime = await rpc.getBlockTime(slot).send();
  return Number(blockTime ?? 0);
}

/**
 * The validator produces no idle slots, so its clock freezes between
 * transactions. Poll until the chain agrees, nudging with a no-op transfer.
 */
async function waitForChainTime(
  target: number,
  timeoutMs = 90_000
): Promise<void> {
  const start = Date.now();
  while ((await chainNow()) < target) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `chain clock stuck at ${await chainNow()}, wanted ${target}`
      );
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** Fee actually charged for a confirmed transaction. */
async function feePaid(signature: Signature): Promise<bigint> {
  const tx = await rpc
    .getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
      encoding: "json",
    })
    .send();
  return BigInt(tx?.meta?.fee ?? 0);
}

describe("aesdr program", () => {
  let buyer: KeyPairSigner;
  let seller: KeyPairSigner;
  let arbiter: KeyPairSigner;
  let testMint: Address;

  const AMOUNT = sol(0.01);
  const MIN_BOND = sol(0.02);

  const newSession = (): Uint8Array => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytes;
  };

  const lock = (
    opts: {
      amount?: bigint;
      minBond?: bigint;
      deadlineSeconds?: number;
      asset?: Asset;
      buyerTokenAccount?: Address;
    } = {}
  ) =>
    aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId: newSession(),
      amount: opts.amount ?? AMOUNT,
      minBond: opts.minBond ?? MIN_BOND,
      deadlineSeconds: opts.deadlineSeconds ?? 300,
      asset: opts.asset,
      buyerTokenAccount: opts.buyerTokenAccount,
    });

  before(async function () {
    this.timeout(120_000);
    buyer = await fundedSigner("buyer");
    seller = await fundedSigner("seller");
    arbiter = await fundedSigner("arbiter", 2);
    currentBuyer = buyer.address;
    testMint = createTestMint();
    await aesdr.postBond({ seller, amount: MIN_BOND });
  });

  it("opens a lamport escrow even though SPL accounts are declared", async () => {
    const { escrow } = await lock();
    const view = await aesdr.read(escrow);
    assert.equal(view!.asset, 0, "lamport escrow records asset 0");
    assert.equal(view!.amount, AMOUNT);
  });

  it("posts a collateral bond as a bare system account", async () => {
    assert.equal(await aesdr.bondBalance(seller.address), MIN_BOND);
  });

  it("refuses to open an escrow the bond cannot cover", async () => {
    const err = await lock({ minBond: MIN_BOND * 50n }).then(
      () => null,
      (e: Error) => e
    );
    assert.isNotNull(err);
    assert.match(err!.message, /BondTooSmall|bond is smaller/i);
  });

  it("locks funds in the vault, not on the escrow account", async () => {
    const { escrow, vault } = await lock();

    const view = await aesdr.read(escrow);
    assert.equal(view!.amount, AMOUNT);
    assert.equal(view!.vaultLamports, AMOUNT, "vault holds the lamports");
    assert.equal(view!.state, EscrowState.Open);

    const { value: vaultBalance } = await rpc.getBalance(vault).send();
    assert.equal(vaultBalance, AMOUNT);
  });

  it("pays the seller on release, and drains the vault", async () => {
    const { escrow, vault } = await lock();
    const before = (await rpc.getBalance(seller.address).send()).value;

    await aesdr.release({ arbiter, escrow });

    const after = (await rpc.getBalance(seller.address).send()).value;
    assert.equal(after - before, AMOUNT);
    assert.equal((await aesdr.read(escrow))!.state, EscrowState.Released);

    // A vault drained to zero is purged by the runtime, so this reads as 0.
    assert.equal((await rpc.getBalance(vault).send()).value, lamports(0n));
  });

  it("refunds the buyer and slashes 10% of the bond on breach", async () => {
    const { escrow } = await lock();
    const bondBefore = await aesdr.bondBalance(seller.address);
    const before = (await rpc.getBalance(buyer.address).send()).value;
    const slash = MIN_BOND / 10n;

    await aesdr.refund({ arbiter, escrow });

    const after = (await rpc.getBalance(buyer.address).send()).value;
    assert.equal(after - before, AMOUNT + slash, "refund plus slash");
    assert.equal(bondBefore - (await aesdr.bondBalance(seller.address)), slash);
    assert.equal((await aesdr.read(escrow))!.state, EscrowState.Refunded);

    await aesdr.postBond({ seller, amount: slash });
  });

  it("refuses a verdict from a key that is not the arbiter", async () => {
    const { escrow } = await lock();
    const err = await aesdr.release({ arbiter: seller, escrow }).then(
      () => null,
      (e: Error) => e
    );
    assert.isNotNull(err, "only the escrow's arbiter may settle");
  });

  it("refuses an early reclaim", async () => {
    const { escrow } = await lock();
    const err = await aesdr.reclaim({ buyer, escrow }).then(
      () => null,
      (e: Error) => e
    );
    assert.isNotNull(err);
    assert.match(err!.message, /DeadlineNotReached|not been reached/i);
  });

  it("lets the buyer reclaim after the deadline with no bond slash", async () => {
    const { escrow } = await lock({ deadlineSeconds: 5 });
    const view = await aesdr.read(escrow);
    await waitForChainTime(view!.deadline);

    const bondBefore = await aesdr.bondBalance(seller.address);
    const buyerBefore = await rpc.getBalance(buyer.address).send();

    const signature = await aesdr.reclaim({ buyer, escrow });

    // The buyer signs, so it also pays the fee: the vault pays the full amount
    // and the buyer's net delta is short by exactly the fee. Asserting against
    // the real fee keeps this exact instead of a tolerance, and proves the
    // vault paid out in full.
    const fee = await feePaid(signature);

    const buyerAfter = await rpc.getBalance(buyer.address).send();
    assert.equal(buyerAfter.value - buyerBefore.value, AMOUNT - fee);
    assert.equal(
      await aesdr.bondBalance(seller.address),
      bondBefore,
      "reclaim is not a verdict"
    );
    assert.equal((await aesdr.read(escrow))!.state, EscrowState.Refunded);
  });

  // ------------------------------------------------------- SPL / USDC path

  it("locks SPL tokens into the vault ATA and pays the seller on release", async () => {
    const buyerAta = await buyerAtaFor(testMint);
    mintTo(testMint, buyerAta, 1_000_000);

    const TOKEN_AMOUNT = usdc(0.25);
    const { escrow, vault } = await lock({
      amount: TOKEN_AMOUNT,
      minBond: MIN_BOND,
      asset: { kind: "spl", mint: testMint },
      buyerTokenAccount: buyerAta,
    });

    const view = await aesdr.read(escrow);
    assert.equal(view!.asset, 1, "SPL escrow records asset 1");
    assert.equal(view!.mint, testMint);
    assert.equal(view!.amount, TOKEN_AMOUNT);

    const { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS, fetchToken } =
      await import("@solana-program/token");
    const [vaultAta] = await findAssociatedTokenPda({
      owner: vault,
      mint: testMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const vaultBalance = await fetchToken(rpc, vaultAta);
    assert.equal(
      vaultBalance.data.amount,
      TOKEN_AMOUNT,
      "vault ATA holds the lock"
    );

    const [sellerAta] = await findAssociatedTokenPda({
      owner: seller.address,
      mint: testMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    // The seller never created this account: settlement must create it in the
    // same transaction, since a PDA cannot pay its own rent.
    assert.isFalse((await fetchEncodedAccount(rpc, sellerAta)).exists);

    await aesdr.release({ arbiter, escrow });

    const paid = await fetchToken(rpc, sellerAta);
    assert.equal(paid.data.amount, TOKEN_AMOUNT, "seller received the tokens");
    assert.equal((await aesdr.read(escrow))!.state, EscrowState.Released);
  });

  it("refunds SPL tokens to the buyer on a breach verdict", async () => {
    // Reuse the buyer's ATA: `create-account` is not idempotent.
    const buyerAta = await buyerAtaFor(testMint);
    mintTo(testMint, buyerAta, 1_000_000);

    const TOKEN_AMOUNT = usdc(0.1);
    const { escrow } = await lock({
      amount: TOKEN_AMOUNT,
      asset: { kind: "spl", mint: testMint },
      buyerTokenAccount: buyerAta,
    });

    const { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS, fetchToken } =
      await import("@solana-program/token");
    const [buyerAtaAddr] = await findAssociatedTokenPda({
      owner: buyer.address,
      mint: testMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const before = await fetchToken(rpc, buyerAtaAddr);

    const bondBefore = await aesdr.bondBalance(seller.address);
    await aesdr.refund({ arbiter, escrow });

    const after = await fetchToken(rpc, buyerAtaAddr);
    assert.equal(
      after.data.amount - before.data.amount,
      TOKEN_AMOUNT,
      "tokens came back"
    );
    assert.isBelow(
      Number(await aesdr.bondBalance(seller.address)),
      Number(bondBefore),
      "bond was slashed even though the escrow was a token"
    );
    assert.equal((await aesdr.read(escrow))!.state, EscrowState.Refunded);
  });

  it("rejects an SPL escrow whose source account holds the wrong mint", async () => {
    // The breach test above slashed the bond, and the bond check runs before
    // the mint check, so top the collateral back up to isolate this failure.
    await aesdr.postBond({ seller, amount: MIN_BOND });

    const otherMint = createTestMint();
    const otherAta = await buyerAtaFor(otherMint);
    mintTo(otherMint, otherAta, 1_000_000);

    const err = await lock({
      amount: usdc(0.1),
      asset: { kind: "spl", mint: testMint },
      buyerTokenAccount: otherAta,
    }).then(
      () => null,
      (e: Error) => e
    );

    assert.isNotNull(err, "a mismatched source account must be rejected");
    assert.match(err!.message, /MintMismatch|mint does not match/i);
  });
});
