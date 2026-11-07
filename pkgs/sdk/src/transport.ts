import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
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
  const { value: latestBlockhash } = await ctx.rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstruction(instruction, m)
  );

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

  throw new Error(`transaction ${signature} was not confirmed within ${timeoutMs}ms`);
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
 * Lamports helper, so callers never hand-write nine zeros.
 *
 * Deliberately rounds: this is for human-authored amounts like `sol(0.01)`,
 * never for arithmetic on a balance read off chain.
 */
export function sol(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000_000));
}

export type { Address, KeyPairSigner, Signature };
