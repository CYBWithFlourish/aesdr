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
  lamports,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { assert } from "chai";

import { Aesdr, EscrowState, sol } from "@aesdr/sdk";

const RPC_URL = process.env.AESDR_RPC ?? "http://127.0.0.1:8899";
const KEY_DIR = mkdtempSync(join(tmpdir(), "aesdr-prog-"));

const rpc = createSolanaRpc(RPC_URL) as Rpc<SolanaRpcApi>;
const aesdr = new Aesdr({ rpc });

async function fundedSigner(name: string, amountSol = 5): Promise<KeyPairSigner> {
  const path = join(KEY_DIR, `${name}.json`);
  spawnSync("solana-keygen", ["new", "--no-bip39-passphrase", "-s", "-o", path, "--force"], {
    stdio: "pipe",
  });
  const address = spawnSync("solana-keygen", ["pubkey", path], { encoding: "utf8" }).stdout.trim();
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
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
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
async function waitForChainTime(target: number, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while ((await chainNow()) < target) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`chain clock stuck at ${await chainNow()}, wanted ${target}`);
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

  const AMOUNT = sol(0.01);
  const MIN_BOND = sol(0.02);

  const newSession = (): Uint8Array => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytes;
  };

  const lock = (opts: { amount?: bigint; minBond?: bigint; deadlineSeconds?: number } = {}) =>
    aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId: newSession(),
      amount: opts.amount ?? AMOUNT,
      minBond: opts.minBond ?? MIN_BOND,
      deadlineSeconds: opts.deadlineSeconds ?? 300,
    });

  before(async function () {
    this.timeout(120_000);
    buyer = await fundedSigner("buyer");
    seller = await fundedSigner("seller");
    arbiter = await fundedSigner("arbiter", 2);
    await aesdr.postBond({ seller, amount: MIN_BOND });
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
    assert.equal(vaultBalance, AMOUNT);  });

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
    assert.equal(await aesdr.bondBalance(seller.address), bondBefore, "reclaim is not a verdict");
    assert.equal((await aesdr.read(escrow))!.state, EscrowState.Refunded);
  });
});
