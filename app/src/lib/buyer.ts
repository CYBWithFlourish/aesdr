"use client";

/**
 * The buyer's side of the x402 handshake, in the browser.
 *
 * Three steps, in the order the protocol dictates:
 *
 *   1. POST without `X-PAYMENT` and read the 402 challenge
 *   2. lock the quoted amount in escrow, producing a transaction signature
 *   3. POST again with `X-PAYMENT` carrying that signature
 *
 * The lock is the only step that needs a signature, so the wallet prompt is
 * bounded to it. Nothing here settles: the money stays in escrow until the
 * arbiter rules.
 */
import {
  Aesdr,
  SCHEME,
  encodePayment,
  hexDecode,
  type Challenge,
} from "@aesdr/sdk";
import type { TransactionSigner } from "@solana/kit";
import { createSolanaRpc } from "@solana/kit";

import { rpcUrl } from "@/lib/config";

export type Accept = Challenge["accepts"][number];

export type Delivery = {
  status: number;
  /** Raw response body, exactly as received. This is what the arbiter hashes. */
  body: string;
  payloadHash: string | null;
  sessionId: string;
  headers: Record<string, string>;
};

export type BuyerAttempt = {
  challenge: Challenge;
  accepted: Accept;
  escrow: string;
  vault: string;
  lockSignature: string;
  delivery: Delivery;
};

/** Read the challenge out of a 402, whether it came in the header or the body. */
export function parseChallenge(response: Response, body: string): Challenge {
  const header = response.headers.get("x-payment-required");
  if (header) {
    try {
      return JSON.parse(atob(header)) as Challenge;
    } catch {
      // Fall through to the body, which is the canonical location.
    }
  }
  return JSON.parse(body) as Challenge;
}

/**
 * Pick the accept entry the buyer wants to pay with.
 *
 * Both entries share a session nonce, so choosing here does not change the
 * escrow address - it only changes the asset the vault holds.
 */
export function chooseAccept(
  challenge: Challenge,
  asset: "lamports" | "spl"
): Accept {
  const wanted = challenge.accepts.find((accept) =>
    asset === "lamports"
      ? accept.asset === "lamports"
      : accept.asset !== "lamports"
  );
  if (!wanted) {
    throw new Error(
      `seller did not quote ${asset === "lamports" ? "SOL" : "USDC"}`
    );
  }
  return wanted;
}

/**
 * Run the whole handshake and return what the seller sent.
 *
 * `onStep` is called as each phase begins so the UI can narrate the flow rather
 * than showing a single spinner over three distinct network round trips.
 */
export async function buyWithEscrow(args: {
  input: string;
  asset: "lamports" | "spl";
  buyer: TransactionSigner;
  onStep?: (step: "quote" | "lock" | "deliver") => void;
}): Promise<BuyerAttempt> {
  args.onStep?.("quote");

  const first = await fetch("/api/summarize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: args.input, asset: args.asset }),
  });

  const firstBody = await first.text();
  if (first.status !== 402) {
    throw new Error(
      `expected HTTP 402 from the seller, got ${
        first.status
      }: ${firstBody.slice(0, 200)}`
    );
  }

  const challenge = parseChallenge(first, firstBody);
  const accepted = chooseAccept(challenge, args.asset);

  args.onStep?.("lock");

  const rpc = createSolanaRpc(rpcUrl());
  const aesdr = new Aesdr({ rpc });

  const mint = accepted.asset?.includes("/token:")
    ? (accepted.asset.split("/token:")[1] as never)
    : undefined;

  const lock = await aesdr.lock({
    buyer: args.buyer,
    seller: accepted.extra.seller as never,
    arbiter: accepted.extra.arbiter as never,
    sessionId: hexDecode(accepted.extra.sessionId),
    amount: BigInt(accepted.maxAmountRequired),
    minBond: BigInt(accepted.extra.minBond),
    deadlineSeconds: accepted.extra.deadlineSeconds,
    asset:
      args.asset === "spl"
        ? { kind: "spl", mint: mint! }
        : { kind: "lamports" },
  });

  args.onStep?.("deliver");

  const header = encodePayment({
    x402Version: 1,
    scheme: SCHEME,
    network: accepted.network,
    payload: {
      txSignature: lock.signature,
      sessionId: accepted.extra.sessionId,
      buyer: args.buyer.address,
    },
  });

  const second = await fetch("/api/summarize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment": header,
      "x-aesdr-session": accepted.extra.sessionId,
    },
    body: JSON.stringify({ input: args.input, asset: args.asset }),
  });

  const secondBody = await second.text();
  if (!second.ok) {
    throw new Error(
      `seller rejected the payment (HTTP ${second.status}): ${secondBody.slice(
        0,
        300
      )}`
    );
  }

  const headers: Record<string, string> = {};
  second.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    challenge,
    accepted,
    escrow: lock.escrow,
    vault: lock.vault,
    lockSignature: lock.signature,
    delivery: {
      status: second.status,
      body: secondBody,
      payloadHash: second.headers.get("x-aesdr-payload-hash"),
      sessionId: accepted.extra.sessionId,
      headers,
    },
  };
}
