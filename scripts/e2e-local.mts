/**
 * Headless end-to-end run against the app.
 *
 * A wallet is only ever the buyer's signing key. A keypair is the same thing,
 * so this script plays the buyer itself: it asks the app for a 402, locks funds
 * in escrow with `@aesdr/sdk`, retries with `X-PAYMENT`, then drives the
 * arbiter through both the PASS and the BREACH settlement.
 *
 * That covers every hop the browser demo covers, minus clicking, and it needs
 * no wallet extension, no browser and no funded UI account.
 *
 * Prerequisites: a validator with the program deployed, the app running, and
 * this buyer funded with SOL (and USDC if you also run the SPL case).
 *
 *   npx tsx scripts/e2e-local.mts
 *   AESDR_E2E_ASSET=lamports npx tsx scripts/e2e-local.mts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  getBase58Encoder,
  type KeyPairSigner,
} from "@solana/kit";
import { Aesdr, SCHEME, encodePayment, hexDecode, type Challenge } from "@aesdr/sdk";

const APP = process.env.AESDR_APP_URL ?? "http://127.0.0.1:3000";
const RPC = process.env.AESDR_RPC ?? "http://127.0.0.1:8899";
const ASSET = process.env.AESDR_E2E_ASSET === "lamports" ? "lamports" : "spl";

/** Load a 32-byte seed file, either the app's JSON or a bare base58 string. */
async function loadSigner(path: string): Promise<KeyPairSigner> {
  const raw = readFileSync(path, "utf8").trim();

  // The app writes `{ address, secretKey }`, where secretKey is base58 seed.
  let encoded = raw;
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw) as { secretKey?: string };
    encoded = parsed.secretKey ?? "";
  }

  if (/^\s*\[/.test(encoded)) {
    throw new Error(
      `${path} is a 64-byte keypair array; export a 32-byte seed instead`
    );
  }
  if (!encoded) throw new Error(`${path} does not contain a secretKey`);

  return createKeyPairSignerFromPrivateKeyBytes(getBase58Encoder().encode(encoded));
}

async function main() {
  const buyerPath =
    process.env.AESDR_BUYER_KEY ??
    join(process.cwd(), "app", ".keys", "buyer.json");

  console.log(`app:   ${APP}`);
  console.log(`rpc:   ${RPC}`);
  console.log(`asset: ${ASSET}`);

  let buyer: KeyPairSigner;
  try {
    buyer = await loadSigner(buyerPath);
  } catch (err) {
    console.error(`\ncannot load buyer key: ${(err as Error).message}`);
    console.error("set AESDR_BUYER_KEY to a 32-byte seed file");
    process.exit(1);
  }

  console.log(`buyer: ${buyer.address}`);

  const rpc = createSolanaRpc(RPC);
  const balance = await rpc.getBalance(buyer.address).send();
  console.log(`buyer balance: ${balance.value} lamports`);

  // ---------------------------------------------------------------- 1. quote

  const input =
    "Escrow-backed settlement replaces the assumption that a paid HTTP request " +
    "will be honoured. The buyer locks the quoted amount in a program-owned " +
    "vault, and the seller is paid only after delivery is attested by a " +
    "deterministic verdict over the response body.";

  const first = await fetch(`${APP}/api/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, asset: ASSET }),
  });

  console.log(`\n1. quote -> HTTP ${first.status}`);
  if (first.status !== 402) {
    console.error(await first.text());
    process.exit(1);
  }

  const challenge = (await first.json()) as Challenge;
  const accepted = challenge.accepts.find((a) =>
    ASSET === "lamports" ? a.asset === "lamports" : a.asset !== "lamports"
  );
  if (!accepted) {
    console.error(`no ${ASSET} accept entry in the challenge`);
    process.exit(1);
  }

  console.log(`   session: ${accepted.extra.sessionId}`);
  console.log(`   amount:  ${accepted.maxAmountRequired} (${accepted.asset})`);

  // ----------------------------------------------------------------- 2. lock

  const aesdr = new Aesdr({ rpc });
  const mint = accepted.asset?.includes("/token:")
    ? (accepted.asset.split("/token:")[1] as never)
    : undefined;

  console.log("\n2. locking in escrow");
  const lock = await aesdr.lock({
    buyer,
    seller: accepted.extra.seller as never,
    arbiter: accepted.extra.arbiter as never,
    sessionId: hexDecode(accepted.extra.sessionId),
    amount: BigInt(accepted.maxAmountRequired),
    minBond: BigInt(accepted.extra.minBond),
    deadlineSeconds: accepted.extra.deadlineSeconds,
    asset: ASSET === "spl" ? { kind: "spl", mint: mint! } : { kind: "lamports" },
  });

  console.log(`   escrow: ${lock.escrow}`);
  console.log(`   tx:     ${lock.signature}`);

  // -------------------------------------------------------------- 3. deliver

  const header = encodePayment({
    x402Version: 1,
    scheme: SCHEME,
    network: accepted.network,
    payload: {
      txSignature: lock.signature,
      sessionId: accepted.extra.sessionId,
      buyer: buyer.address,
    },
  });

  console.log("\n3. retrying with X-PAYMENT");
  const second = await fetch(`${APP}/api/summarize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment": header,
      "x-aesdr-session": accepted.extra.sessionId,
    },
    body: JSON.stringify({ input, asset: ASSET }),
  });

  const body = await second.text();
  const payloadHash = second.headers.get("x-aesdr-payload-hash");

  console.log(`   status:  HTTP ${second.status}`);
  console.log(`   hash:    ${payloadHash ?? "none"}`);

  if (!second.ok) {
    console.error(`\n${body.slice(0, 600)}`);
    process.exit(1);
  }

  let parsed: { summary?: string };
  try {
    parsed = JSON.parse(body) as { summary?: string };
  } catch {
    console.error(`response was not JSON: ${body.slice(0, 300)}`);
    process.exit(1);
  }

  console.log(`   summary: ${(parsed.summary ?? "").slice(0, 120)}...`);

  // --------------------------------------------------------------- 4. verdict

  console.log("\n4. arbiter verdict (inspect only)");
  const inspect = await fetch(`${APP}/api/arbiter`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      escrow: lock.escrow,
      body,
      expectedHash: payloadHash,
      settle: false,
    }),
  });

  const verdict = (await inspect.json()) as {
    verdict?: { outcome: string; reason: string | null };
  };
  console.log(`   outcome: ${verdict.verdict?.outcome}`);
  console.log(`   reason:  ${verdict.verdict?.reason ?? "all checks passed"}`);

  if (!inspect.ok) {
    console.error(JSON.stringify(verdict, null, 2));
    process.exit(1);
  }

  // -------------------------------------------------------------- 5. settle

  console.log("\n5. settling");
  const settle = await fetch(`${APP}/api/arbiter`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      escrow: lock.escrow,
      body,
      expectedHash: payloadHash,
      settle: true,
    }),
  });

  const result = (await settle.json()) as {
    outcome?: string;
    signature?: string;
    error?: string;
    detail?: string;
  };

  if (!settle.ok) {
    console.error(
      `   settled failed: ${result.detail ?? result.error ?? settle.status}`
    );
    process.exit(1);
  }

  console.log(`   outcome: ${result.outcome}`);
  console.log(`   tx:      ${result.signature}`);

  const view = await aesdr.read(lock.escrow);
  console.log(`   escrow is now: ${view?.stateLabel}`);

  console.log("\ndone");
}

main().catch((err) => {
  console.error("\nfailed:", err);
  process.exit(1);
});
