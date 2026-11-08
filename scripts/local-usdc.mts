/**
 * Create a local USDC stand-in, fund a buyer with it, and print the mint.
 *
 * A local validator has no Circle deployment, so the demo needs its own token.
 * Three details make this work against the escrow program:
 *
 *   1. The mint is owned by the **legacy** token program. `spl-token` 5.5
 *      creates Token-2022 by default, and a 2022 mint fails ATA creation with
 *      `IncorrectProgramId` inside the escrow program.
 *   2. The buyer's ATA is created idempotently, so a rerun is safe.
 *   3. The mint keypair is persisted next to the app, so a restart reuses the
 *      mint instead of orphaning the buyer's balance.
 *
 * Prints the mint address on stdout; all narration goes to stderr so the caller
 * can capture the address with a plain command substitution.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Encoder,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintToInstruction,
} from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";

const RPC = process.env.AESDR_RPC ?? "http://127.0.0.1:8899";
const APP_DIR = process.env.AESDR_APP_DIR ?? join(process.cwd(), "app");
const KEYS_DIR = join(APP_DIR, ".keys");
const RECORD = join(APP_DIR, ".local-usdc-mint");

/** USDC has 6 decimals. */
const DECIMALS = 6;
/** Enough for many demo requests. */
const FUND_AMOUNT = 1_000_000_000n;
/** A mint account is always 82 bytes. */
const MINT_SPACE = 82n;

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function loadBuyer(): Promise<KeyPairSigner> {
  const raw = readFileSync(join(KEYS_DIR, "buyer.json"), "utf8");
  const parsed = JSON.parse(raw) as { secretKey: string };
  return createKeyPairSignerFromPrivateKeyBytes(
    getBase58Encoder().encode(parsed.secretKey)
  );
}

/**
 * Send a transaction and wait until it is confirmed on chain.
 *
 * Waiting is not incidental here. The ATA transaction is simulated against
 * chain state, so submitting it while the mint is still in flight makes the
 * simulation fail with a bare "Transaction simulation failed" that names
 * nothing. Confirming first turns that into a non-issue.
 *
 * Polling matches `pkgs/sdk`, which avoids holding a websocket open for a
 * one-shot setup script.
 */
async function send(
  rpc: ReturnType<typeof createSolanaRpc>,
  payer: KeyPairSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0]
): Promise<void> {
  const { value: blockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );

  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);

  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      preflightCommitment: "confirmed",
    })
    .send();

  await waitForConfirmation(rpc, signature);
}

/** Poll until confirmed, failed, or the wait window expires. */
async function waitForConfirmation(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await rpc
      .getSignatureStatuses([signature as never], {
        searchTransactionHistory: false,
      })
      .send();

    const status = value[0];

    if (status?.err) {
      throw new Error(
        `transaction ${signature} failed on chain: ${JSON.stringify(
          status.err
        )}`
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`transaction ${signature} was not confirmed in time`);
}

/**
 * Read a recorded mint address, tolerating the older bare-address format.
 *
 * The first version of this script wrote a plain address; the current one writes
 * JSON. Accepting both means an upgrade does not require manual cleanup.
 */
function loadRecordedMint(): string | null {
  if (!existsSync(RECORD)) return null;
  const raw = readFileSync(RECORD, "utf8").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    return (JSON.parse(raw) as { address?: string }).address ?? null;
  }
  return raw;
}

/**
 * True when the mint account is owned by the legacy token program.
 *
 * A Token-2022 mint parses fine as an address but fails inside the escrow
 * program at ATA creation, so the owner is the property that actually matters.
 */
async function isLegacyMint(
  rpc: ReturnType<typeof createSolanaRpc>,
  mint: Address
): Promise<boolean> {
  const { value: account } = await rpc
    .getAccountInfo(mint, { encoding: "base64", commitment: "confirmed" })
    .send();
  return account?.owner === TOKEN_PROGRAM_ADDRESS;
}

function saveRecord(mint: Address): void {
  writeFileSync(
    RECORD,
    JSON.stringify(
      {
        note: "local development only, never commit",
        address: mint,
        // The mint authority is the buyer, so the mint keypair is not needed
        // again to fund accounts.
      },
      null,
      2
    )
  );
}

/**
 * Write `USDC_MINT` into the app's `.env.local`.
 *
 * Done here rather than in the shell so the value can never outlive a failure
 * quietly: whatever mint this run confirmed is the one the app will quote.
 */
function persistEnv(mint: Address): void {
  const path = join(APP_DIR, ".env.local");
  const line = `USDC_MINT=${mint}`;

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const updated = /^USDC_MINT=/m.test(existing)
    ? existing.replace(/^USDC_MINT=.*$/m, line)
    : `${existing.replace(/\s*$/, "")}\n${line}\n`;

  writeFileSync(path, updated);
  log(`  wrote USDC_MINT=${mint} to .env.local`);
}

async function main(): Promise<void> {
  const buyer = await loadBuyer();
  const rpc = createSolanaRpc(RPC);

  let mint: Address | null = null;
  const recorded = loadRecordedMint();

  if (recorded) {
    const candidate = recorded as Address;
    if (await isLegacyMint(rpc, candidate)) {
      mint = candidate;
      log(`  reusing mint ${mint}`);
    } else {
      // Most likely a Token-2022 mint from an older run of this script. The
      // escrow program cannot use it, so make a correct one instead of failing.
      log(
        `  recorded mint ${candidate} is not a legacy SPL mint, replacing it`
      );
    }
  }

  if (!mint) {
    const mintSigner = await generateKeyPairSigner();
    mint = mintSigner.address;

    const rent = await rpc.getMinimumBalanceForRentExemption(MINT_SPACE).send();

    await send(rpc, buyer, [
      getCreateAccountInstruction({
        payer: buyer,
        newAccount: mintSigner,
        lamports: rent,
        space: MINT_SPACE,
        programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeMint2Instruction({
        mint: mintSigner.address,
        decimals: DECIMALS,
        // The buyer mints its own test funds, which is fine for a local
        // stand-in and never true of the real USDC mint.
        mintAuthority: buyer.address,
        freezeAuthority: null,
      }),
    ]);

    saveRecord(mint);
    log(`  created mint ${mint}`);
  }

  const [ata] = await findAssociatedTokenPda({
    owner: buyer.address,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  // Persist the env as soon as the mint itself is confirmed. A later funding
  // failure must not leave .env.local pointing at the *previous* mint, which is
  // how a stale Token-2022 address survived one failed run and kept quoting.
  persistEnv(mint);

  await send(rpc, buyer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: buyer,
      ata,
      owner: buyer.address,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    getMintToInstruction({
      mint,
      token: ata,
      mintAuthority: buyer,
      amount: FUND_AMOUNT,
    }),
  ]);

  log(`  funded ${ata} with ${FUND_AMOUNT} base units`);

  // The caller captures this.
  process.stdout.write(mint);
}

main().catch((err) => {
  log(`  USDC setup failed: ${(err as Error).message}`);
  process.exit(1);
});
