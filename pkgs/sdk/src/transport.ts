import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isTransactionSendingSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";

import { toAesdrError } from "./errors";

/**
 * Minimal client shape.
 *
 * Kit composes a client from plugins; all this SDK needs is RPC access, so
 * accepting this narrow shape means callers can pass either a fully assembled
 * Kit client or a bare `createSolanaRpc(...)` result.
 */
export type AesdrContext = {
  rpc: Rpc<SolanaRpcApi>;
};

/**
 * Send one instruction and confirm it.
 *
 * Confirmation is table stakes here: a seller must never serve a payload on a
 * transaction that merely *submitted*. We poll `getSignatureStatuses` rather
 * than requiring a websocket subscription, because a seller's server process
 * usually has no business holding one open.
 */
export async function signAndSend(
  ctx: AesdrContext,
  instruction: Instruction,
  payer: TransactionSigner
): Promise<Signature> {
  return signAndSendAll(ctx, [instruction], payer);
}

/**
 * Send several instructions in one atomic transaction and confirm it.
 *
 * Escrow setup needs the token accounts to exist before the program can move
 * funds, so creation and payment travel together: either both land or neither
 * does, and a half-created escrow can never strand funds.
 *
 * Two signer styles are supported on purpose. A server-side keypair signs
 * locally, so the SDK broadcasts and confirms. A browser wallet exposes a
 * sending signer instead, which hands the whole message to the wallet and gets
 * a signature back. Both end up here as a `TransactionSigner` so callers never
 * branch on which one they hold.
 */
export async function signAndSendAll(
  ctx: AesdrContext,
  instructions: Instruction[],
  payer: TransactionSigner
): Promise<Signature> {
  const normalized = instructions.map(normalizeOptionalPlaceholders);

  const { value: latestBlockhash } = await ctx.rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(normalized, m),
    (m) => {
      // Kit validates that the program address is never writable at compile
      // time, including inside lookup tables, so normalize the metas here too.
      const fixed = m.instructions.map(normalizeOptionalPlaceholders);
      return { ...m, instructions: fixed } as typeof m;
    }
  );

  // A wallet signs and broadcasts in one step because it owns the keys.
  if (isTransactionSendingSigner(payer)) {
    try {
      // The wallet returns raw bytes; the SDK speaks base58 signatures.
      const bytes = await signAndSendTransactionMessageWithSigners(message);
      return getBase58Decoder().decode(bytes) as Signature;
    } catch (err) {
      // The wallet surfaces its own rejection/cancel errors; only program
      // failures carry the log context `toAesdrError` knows how to read.
      throw toAesdrError(err);
    }
  }

  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);

  try {
    await ctx.rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: "base64",
        preflightCommitment: "confirmed",
      })
      .send();
  } catch (err) {
    throw toAesdrError(err, signature);
  }

  await waitForSignature(ctx.rpc, signature);
  return signature;
}

/** Poll until a signature is confirmed, failed, or the wait window expires. */
async function waitForSignature(
  rpc: Rpc<SolanaRpcApi>,
  signature: Signature,
  timeoutMs = 60_000
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const { value } = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: false })
      .send();

    const status = value[0];

    if (status?.err) {
      // Preflight passed but execution failed. The status carries only a
      // structured error, so fetch the transaction to recover the logs and
      // turn them into the program's own error message.
      throw await explainLandedFailure(rpc, signature);
    }

    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }

    await sleep(1_000);
  }

  throw new Error(
    `transaction ${signature} was not confirmed within ${timeoutMs}ms`
  );
}

async function explainLandedFailure(
  rpc: Rpc<SolanaRpcApi>,
  signature: Signature
): Promise<unknown> {
  const tx = await rpc
    .getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
      encoding: "json",
    })
    .send();

  if (tx?.meta?.logMessages) {
    return toAesdrError({ context: { logs: tx.meta.logMessages } }, signature);
  }

  return new Error(`transaction ${signature} failed on chain`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Strip writability from optional-account placeholders.
 *
 * An absent optional account is passed as the program's own address, which is
 * how Anchor encodes `None`. Kit rejects a message where that address is both
 * invoked and writable, so the meta is rewritten read-only. This is safe: the
 * Anchor runtime compares against the program id only, ignores the flags for
 * this case, and maps it to `None` either way.
 */
function normalizeOptionalPlaceholders(
  instruction: Instruction & { programAddress?: string }
): Instruction {
  const programId = String(instruction.programAddress ?? "");
  if (!programId) return instruction;

  let changed = false;
  const accounts = instruction.accounts?.map((account) => {
    if (String(account.address) !== programId) return account;
    // AccountRole.WRITABLE is 1; AccountRole.WRITABLE_SIGNER is 3.
    if (account.role !== 1 && account.role !== 3) return account;
    changed = true;
    return { ...account, role: account.role === 3 ? 2 : 0 };
  });

  return changed ? ({ ...instruction, accounts } as Instruction) : instruction;
}

/**
 * Lamports helper, so callers never hand-write nine zeros.
 *
 * Deliberately rounds: this is for human-authored amounts like `sol(0.01)`,
 * never for arithmetic on a balance read off chain.
 */
export function sol(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000_000));
}

export type { Address, KeyPairSigner, Signature };
