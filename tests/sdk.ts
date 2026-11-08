/**
 * AESDR test suite - @solana/kit end to end.
 *
 * Runs against a local validator that already has the program loaded:
 *
 *   solana-test-validator --reset --ledger /tmp/aesdr-ledger \
 *     --bpf-program 82Tq33Ekqk1TYrruXgpiPtLgoTM2Fjo8VEmpkzcF4BTD target/deploy/aesdr.so
 *
 * Funding uses the CLI faucet rather than `requestAirdrop`, because a
 * `solana-test-validator` faucet rejects a Kit-shaped airdrop request.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { assert } from "chai";

import {
  AESDR_ERROR__BOND_TOO_SMALL,
  AESDR_ERROR__DEADLINE_NOT_REACHED,
  Aesdr,
  AesdrTransactionError,
  EscrowState,
  buildChallenge,
  decodePayment,
  encodePayment,
  evaluate,
  parseCustomErrorCode,
  sha256Hex,
  sol,
  toAesdrError,
  usdc,
} from "@aesdr/sdk";

const RPC_URL = process.env.AESDR_RPC ?? "http://127.0.0.1:8899";
const LOT = mkdtempSync(join(tmpdir(), "aesdr-keys-"));

const rpc = createSolanaRpc(RPC_URL) as Rpc<SolanaRpcApi>;
const aesdr = new Aesdr({ rpc });

/**
 * Create a throwaway SPL mint and return its address.
 *
 * A local validator has no USDC, so the SPL tests mint their own. On devnet the
 * demo uses the official USDC mint instead.
 */
function splMint(decimals = 6): Address {
  const out = spawnSync(
    "spl-token",
    [
      "create-token",
      "--url",
      RPC_URL,
      "--decimals",
      String(decimals),
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

/** Create an owner's ATA for a mint and return it. Fails if it exists. */
function splAta(mint: Address, owner: Address): Address {
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

/** Mint test tokens into an ATA. */
function splMintTo(mint: Address, ata: Address, amount: number): void {
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

/** Generate a keypair with the CLI and fund it from the validator faucet. */
async function fundedSigner(
  name: string,
  amountSol = 5
): Promise<KeyPairSigner> {
  const path = join(LOT, `${name}.json`);
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

  const bytes = new Uint8Array(JSON.parse(readFileSync(path, "utf8")));
  return createKeyPairSignerFromBytes(bytes);
}

/** Chain time, not wall time: deadline checks are against the validator clock. */
async function chainNow(): Promise<number> {
  const slot = await rpc.getSlot().send();
  const blockTime = await rpc.getBlockTime(slot).send();
  return Number(blockTime ?? 0);
}

/**
 * The validator produces no idle slots, so its clock freezes between
 * transactions. Nudge it forward until the chain agrees the deadline passed.
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe("aesdr program (via sdk)", () => {
  let buyer: KeyPairSigner;
  let seller: KeyPairSigner;
  let arbiter: KeyPairSigner;
  let stranger: KeyPairSigner;

  const AMOUNT = sol(0.01);
  const MIN_BOND = sol(0.02);

  const newSession = (): Uint8Array => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytes;
  };

  before(async function () {
    this.timeout(120_000);
    buyer = await fundedSigner("buyer");
    seller = await fundedSigner("seller");
    arbiter = await fundedSigner("arbiter", 2);
    stranger = await fundedSigner("stranger", 2);

    await aesdr.postBond({ seller, amount: MIN_BOND });
  });

  it("seller posts a collateral bond", async () => {
    const bond = await aesdr.bondBalance(seller.address);
    assert.equal(bond, MIN_BOND);
  });

  it("rejects an escrow the bond cannot cover", async () => {
    const res = await aesdr
      .lock({
        buyer,
        seller: seller.address,
        arbiter: arbiter.address,
        sessionId: newSession(),
        amount: AMOUNT,
        minBond: MIN_BOND * 50n,
        deadlineSeconds: 300,
      })
      .then(
        () => null,
        (e: Error) => e
      );

    assert.isNotNull(res, "escrow should not open without enough collateral");
    assert.match(res!.message, /BondTooSmall|bond is smaller/i);
  });

  it("happy path: lock, verdict, release", async () => {
    const sessionId = newSession();
    const { escrow, vault, signature } = await aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId,
      amount: AMOUNT,
      minBond: MIN_BOND,
      deadlineSeconds: 300,
    });

    assert.isString(signature);

    const view = await aesdr.read(escrow);
    assert.isNotNull(view);
    assert.equal(view!.state, EscrowState.Open);
    assert.equal(view!.stateLabel, "OPEN");
    assert.equal(view!.amount, AMOUNT);
    assert.equal(view!.vaultLamports, AMOUNT);
    assert.equal(view!.vault, vault);
    assert.isFalse(view!.reclaimable);

    const sellerBefore = await rpc.getBalance(seller.address).send();

    await aesdr.release({ arbiter, escrow });

    const sellerAfter = await rpc.getBalance(seller.address).send();
    assert.equal(sellerAfter.value - sellerBefore.value, AMOUNT);

    const settled = await aesdr.read(escrow);
    assert.equal(settled!.state, EscrowState.Released);
  });

  it("rejects a second release on the same escrow", async () => {
    const sessionId = newSession();
    const { escrow } = await aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId,
      amount: AMOUNT,
      minBond: MIN_BOND,
      deadlineSeconds: 300,
    });

    await aesdr.release({ arbiter, escrow });

    const second = await aesdr.release({ arbiter, escrow }).then(
      () => null,
      (e: Error) => e
    );
    assert.isNotNull(second, "release must not be replayable");
    assert.match(second!.message, /RELEASED|settlement already happened/i);
  });

  it("breach path: refund the buyer and slash 10% of the bond", async () => {
    const sessionId = newSession();
    const { escrow } = await aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId,
      amount: AMOUNT,
      minBond: MIN_BOND,
      deadlineSeconds: 300,
    });

    const bondBefore = await aesdr.bondBalance(seller.address);
    const buyerBefore = await rpc.getBalance(buyer.address).send();
    const expectedSlash = MIN_BOND / 10n;

    await aesdr.refund({ arbiter, escrow });

    const buyerAfter = await rpc.getBalance(buyer.address).send();
    const bondAfter = await aesdr.bondBalance(seller.address);

    assert.equal(buyerAfter.value - buyerBefore.value, AMOUNT + expectedSlash);
    assert.equal(bondBefore - bondAfter, expectedSlash, "bond slashed by 10%");
    assert.equal((await aesdr.read(escrow))!.state, EscrowState.Refunded);

    // The slash left the seller under-collateralised; top it back up so the
    // remaining tests exercise a seller that is again eligible to be paid.
    await aesdr.postBond({ seller, amount: expectedSlash });
    assert.equal(await aesdr.bondBalance(seller.address), MIN_BOND);
  });

  it("rejects a verdict from anyone but the arbiter", async () => {
    const sessionId = newSession();
    const { escrow } = await aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId,
      amount: AMOUNT,
      minBond: MIN_BOND,
      deadlineSeconds: 300,
    });

    // The SDK refuses locally via has_one state, but the program must also
    // refuse on chain. Sign with the stranger and bypass SDK pre-checks.
    const failed = await aesdr.release({ arbiter: stranger, escrow }).then(
      () => null,
      (e: Error) => e
    );
    assert.isNotNull(failed, "a stranger must not settle the escrow");
  });

  it("buyer cannot reclaim before the deadline", async () => {
    const sessionId = newSession();
    const { escrow } = await aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId,
      amount: AMOUNT,
      minBond: MIN_BOND,
      deadlineSeconds: 300,
    });

    const failed = await aesdr.reclaim({ buyer, escrow }).then(
      () => null,
      (e: Error) => e
    );
    assert.isNotNull(failed, "early reclaim must fail");
    assert.match(failed!.message, /DeadlineNotReached|not been reached/i);
  });

  it("buyer reclaims unilaterally after the deadline, with no bond slash", async () => {
    const sessionId = newSession();
    const { escrow } = await aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId,
      amount: AMOUNT,
      minBond: MIN_BOND,
      deadlineSeconds: 5,
    });

    const view = await aesdr.read(escrow);
    await waitForChainTime(view!.deadline);

    const bondBefore = await aesdr.bondBalance(seller.address);
    const buyerBefore = await rpc.getBalance(buyer.address).send();

    const signature = await aesdr.reclaim({ buyer, escrow });

    // The buyer signs, so it pays the fee: the net delta is short by exactly
    // the fee, while the vault still paid out in full.
    const fee = await feePaid(signature);

    const buyerAfter = await rpc.getBalance(buyer.address).send();
    assert.equal(
      buyerAfter.value - buyerBefore.value,
      AMOUNT - fee,
      "full refund, no slash"
    );
    assert.equal(await aesdr.bondBalance(seller.address), bondBefore);
    assert.equal((await aesdr.read(escrow))!.state, EscrowState.Refunded);
  });
});

describe("sdk: verifyLock", () => {
  let buyer: KeyPairSigner;
  let seller: KeyPairSigner;
  let arbiter: KeyPairSigner;

  before(async function () {
    this.timeout(120_000);
    buyer = await fundedSigner("v-buyer");
    seller = await fundedSigner("v-seller");
    arbiter = await fundedSigner("v-arbiter", 2);
    await aesdr.postBond({ seller, amount: sol(0.02) });
  });

  const newSession = () => {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return b;
  };

  it("accepts a real lock and rejects a wrong price", async () => {
    const sessionId = newSession();
    const { signature } = await aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId,
      amount: sol(0.01),
      minBond: sol(0.02),
      deadlineSeconds: 300,
    });

    const ok = await aesdr.verifyLock({
      txSignature: signature,
      sessionId,
      buyer: buyer.address,
      seller: seller.address,
      expectedAmount: sol(0.01),
    });
    assert.isTrue(ok.valid, ok.reason);

    const wrong = await aesdr.verifyLock({
      txSignature: signature,
      sessionId,
      buyer: buyer.address,
      seller: seller.address,
      expectedAmount: sol(0.05),
    });
    assert.isFalse(wrong.valid);
    assert.match(wrong.reason!, /expected/);
  });

  it("rejects a session id that does not match the lock", async () => {
    const sessionId = newSession();
    const { signature } = await aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId,
      amount: sol(0.01),
      minBond: sol(0.02),
      deadlineSeconds: 300,
    });

    const wrong = await aesdr.verifyLock({
      txSignature: signature,
      sessionId: newSession(),
      buyer: buyer.address,
      seller: seller.address,
    });
    assert.isFalse(wrong.valid);
  });

  // A token escrow keeps its value in the vault's ATA, not in the vault PDA's
  // lamports, so verification must look in the right place. Checking lamports
  // here would reject every valid USDC payment.
  it("verifies an SPL lock by reading the vault ATA, not vault lamports", async () => {
    const mint = splMint();
    const buyerAta = splAta(mint, buyer.address);
    splMintTo(mint, buyerAta, 1_000_000);

    const sessionId = newSession();
    const amount = usdc(0.25);
    const { signature, escrow } = await aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId,
      amount,
      minBond: sol(0.02),
      deadlineSeconds: 300,
      asset: { kind: "spl", mint },
      buyerTokenAccount: buyerAta,
    });

    const view = await aesdr.read(escrow);
    assert.equal(view!.asset, 1);

    const ok = await aesdr.verifyLock({
      txSignature: signature,
      sessionId,
      buyer: buyer.address,
      seller: seller.address,
      expectedAmount: amount,
      expectedAsset: { kind: "spl", mint },
    });
    assert.isTrue(ok.valid, ok.reason);

    // The same number quoted in lamports must not pass as a token payment.
    const wrongAsset = await aesdr.verifyLock({
      txSignature: signature,
      sessionId,
      buyer: buyer.address,
      seller: seller.address,
      expectedAmount: amount,
      expectedAsset: { kind: "lamports" },
    });
    assert.isFalse(wrongAsset.valid);
    assert.match(wrongAsset.reason!, /expected lamports/);
  });

  it("rejects a lock that requested a different token than the price quoted", async () => {
    const mint = splMint();
    const otherMint = splMint();
    const buyerAta = splAta(mint, buyer.address);
    splMintTo(mint, buyerAta, 1_000_000);

    const sessionId = newSession();
    const { signature } = await aesdr.lock({
      buyer,
      seller: seller.address,
      arbiter: arbiter.address,
      sessionId,
      amount: usdc(0.1),
      minBond: sol(0.02),
      deadlineSeconds: 300,
      asset: { kind: "spl", mint },
      buyerTokenAccount: buyerAta,
    });

    const wrong = await aesdr.verifyLock({
      txSignature: signature,
      sessionId,
      buyer: buyer.address,
      seller: seller.address,
      expectedAsset: { kind: "spl", mint: otherMint },
    });
    assert.isFalse(wrong.valid);
    assert.match(wrong.reason!, /expected token/);
  });
});

describe("error decoding", () => {
  const anchorLogs = [
    "Program 82Tq33Ekqk1TYrruXgpiPtLgoTM2Fjo8VEmpkzcF4BTD invoke [1]",
    "Program log: AnchorError occurred. Error Code: BondTooSmall. Error Number: 6005. Error Message: Seller bond is smaller than the escrow requires.",
  ];

  it("turns a program rejection into the program's own message", () => {
    const err = toAesdrError({
      context: { logs: anchorLogs },
    }) as AesdrTransactionError;
    assert.instanceOf(err, AesdrTransactionError);
    assert.match(err.message, /Seller bond is smaller/);
    assert.equal(err.programError, AESDR_ERROR__BOND_TOO_SMALL);
  });

  it("reads the non-Anchor Custom(n) form too", () => {
    assert.equal(
      parseCustomErrorCode(["Program log: Error: Custom(6007)"]),
      6007
    );
  });

  it("does not claim an unrelated program error as its own", () => {
    const err = toAesdrError({
      context: { logs: ["Program log: Error: Custom(1234)"] },
    }) as AesdrTransactionError;
    assert.isNull(err.programError);
    assert.match(err.message, /program error 1234/);
  });

  it("leaves transport failures alone instead of inventing a verdict", () => {
    const original = new Error("blockhash not found");
    assert.equal(toAesdrError(original), original);
  });
});

describe("x402 wire format", () => {
  it("round-trips a payment header", () => {
    const payload = {
      x402Version: 1 as const,
      scheme: "aesdr-escrow" as const,
      network: "solana-devnet",
      payload: {
        txSignature: "5xYtest",
        sessionId: "aa".repeat(32),
        buyer: "11111111111111111111111111111111",
      },
    };
    assert.deepEqual(decodePayment(encodePayment(payload)), payload);
  });

  it("rejects an unknown scheme rather than guessing", () => {
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: "exact",
        payload: { txSignature: "x" },
      })
    ).toString("base64");
    assert.throws(() => decodePayment(header), /unsupported scheme "exact"/);
  });

  it("rejects a header that is not base64 JSON", () => {
    assert.throws(() => decodePayment("not-base64!!"), /not valid base64 JSON/);
  });

  it("builds a challenge with lamports as strings, never floats", () => {
    const challenge = buildChallenge({
      network: "solana-devnet",
      maxAmountRequired: sol(0.01),
      payTo: "11111111111111111111111111111111",
      resource: "/api/tool/run",
      description: "Summarize",
      programId: "82Tq33Ekqk1TYrruXgpiPtLgoTM2Fjo8VEmpkzcF4BTD",
      arbiter: "11111111111111111111111111111111",
      minBond: sol(0.02),
      deadlineSeconds: 300,
      sessionId: "bb".repeat(32),
    });
    assert.equal(challenge.accepts[0].maxAmountRequired, "10000000");
    assert.isString(challenge.accepts[0].extra.minBond);
  });
});

describe("verdict engine", () => {
  const goodBody = JSON.stringify({
    summary:
      "Solana settles transactions in about a second for a fraction of a cent, which makes metered machine payments viable.",
  });

  it("passes a valid, signed, substantial payload", async () => {
    const verdict = await evaluate({
      httpStatus: 200,
      body: goodBody,
      expectedHash: await sha256Hex(goodBody),
      requiredKeys: ["summary"],
    });
    assert.equal(verdict.outcome, "PASS");
    assert.isNull(verdict.reason);
  });

  it("flags a non-2xx before inspecting the body", async () => {
    const verdict = await evaluate({ httpStatus: 503, body: goodBody });
    assert.equal(verdict.reason, "status");
    assert.lengthOf(verdict.checks, 1);
  });

  it("flags malformed JSON", async () => {
    assert.equal(
      (await evaluate({ httpStatus: 200, body: "{ broken" })).reason,
      "schema"
    );
  });

  it("flags a body that does not match the seller's own commitment", async () => {
    const verdict = await evaluate({
      httpStatus: 200,
      body: goodBody,
      expectedHash: "0".repeat(64),
    });
    assert.equal(verdict.reason, "hash");
  });

  it("catches the break-it case: signed, valid, and empty", async () => {
    const truncated = JSON.stringify({ summary: "[TRUNCATED]" });
    const verdict = await evaluate({
      httpStatus: 200,
      body: truncated,
      expectedHash: await sha256Hex(truncated),
      requiredKeys: ["summary"],
    });

    assert.equal(verdict.outcome, "BREACH");
    assert.equal(
      verdict.reason,
      "length",
      "checks 1-3 pass; only length catches this"
    );
    assert.isTrue(verdict.checks.slice(0, 3).every((c) => c.passed));
  });

  it("runs an optional quality gate last", async () => {
    const verdict = await evaluate({
      httpStatus: 200,
      body: goodBody,
      qualityCheck: () => false,
    });
    assert.equal(verdict.reason, "quality");
  });

  it("treats a throwing quality check as a breach, not a crash", async () => {
    const verdict = await evaluate({
      httpStatus: 200,
      body: goodBody,
      qualityCheck: () => {
        throw new Error("judge timed out");
      },
    });
    assert.equal(verdict.reason, "quality");
    assert.match(verdict.checks.at(-1)!.detail, /judge timed out/);
  });

  it("skips the hash check when no commitment was supplied", async () => {
    const verdict = await evaluate({ httpStatus: 200, body: goodBody });
    assert.match(
      verdict.checks.find((c) => c.name === "hash")!.detail,
      /skipped/
    );
  });
});
