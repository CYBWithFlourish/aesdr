/**
 * The 402 handshake, server side.
 *
 * Two responsibilities, in order: quote a price in a way a client can act on,
 * then verify the receipt it comes back with. Verification never trusts the
 * header's claims about amount or escrow address - it re-derives both from
 * chain state, which is the property that makes the escrow receipt a receipt.
 */
import {
  ASSET_LAMPORTS,
  ASSET_SPL,
  SCHEME,
  buildChallenge,
  decodePayment,
  encodePayment,
  hexDecode,
  newSessionId,
  type Address,
  type Challenge,
  type PaymentRequirements,
} from "@aesdr/sdk";

import {
  PAYLOAD_SHAPE,
  RESOURCE_PATH,
  deadlineSeconds,
  minBond,
  networkName,
  priceSol,
  priceUsdc,
  usdcMint,
  cluster,
} from "./config";
import { aesdr, roleSigner } from "./solana";
import { priceFor, putSession, type AssetKind, type Session } from "./sessions";

/** CAIP-19 asset id for a specific mint on the advertised network. */
function usdcAssetId(mint: Address): string {
  // The asset identifier must agree with the network the challenge advertises,
  // otherwise a conformance-checking client rejects the whole `accepts` entry.
  const [namespace, reference] = networkName().split(":");
  return `${namespace}:${reference}/token:${mint}`;
}

/**
 * The SPL mint this deployment can accept, or `null` when there is none.
 *
 * On localnet `usdcMint()` throws if setup has not run. Catching that here keeps
 * a missing `USDC_MINT` from taking down SOL payments, which need no mint at
 * all. Elsewhere this simply returns the official address.
 */
function splMintOrNull(): Address | null {
  try {
    return usdcMint();
  } catch {
    console.warn(
      "[aesdr] no USDC mint configured; offering the SOL price only. " +
        "Run `npm run setup:demo` and restart to enable USDC."
    );
    return null;
  }
}

/**
 * Quote both currencies for one request.
 *
 * Offering SOL and USDC side by side is what lets the buyer choose, and it is
 * also what makes the escrow asset field do real work: the same session can be
 * paid either way, and the program records which one actually happened.
 */
export async function quote(input: string): Promise<Challenge> {
  const [seller, arbiter] = await Promise.all([
    roleSigner("seller"),
    roleSigner("arbiter"),
  ]);

  const sessionId = newSessionId();

  // The SPL offer is only real if there is a mint to quote. On localnet that
  // means setup has run; elsewhere the official mint always exists. When it is
  // unavailable the session is SOL-only rather than broken, so one missing env
  // var cannot take down the whole endpoint.
  const mint = splMintOrNull();

  putSession({
    sessionId,
    seller: seller.address,
    arbiter: arbiter.address,
    prices: {
      spl: priceUsdc(),
      lamports: priceSol(),
    },
    ...(mint ? { mint } : {}),
    input,
    createdAt: Date.now(),
  });

  const common = {
    network: networkName(),
    resource: RESOURCE_PATH,
    programId: aesdr().address,
    arbiter: arbiter.address,
    seller: seller.address,
    minBond: minBond(),
    deadlineSeconds: deadlineSeconds(),
    sessionId,
  };

  // SOL is always offered: it needs no mint and no Circle deployment, so it is
  // the one payment every deployment can take. When there is no SPL mint this is
  // the entire challenge, which keeps a missing env var from breaking the route.
  const solChallenge = buildChallenge({
    ...common,
    payTo: seller.address,
    maxAmountRequired: priceSol(),
    description: "Summarize text. Funds are held in escrow until delivery.",
    asset: "lamports",
  });

  if (!mint) return solChallenge;

  const challenge = buildChallenge({
    ...common,
    payTo: seller.address,
    maxAmountRequired: priceUsdc(),
    description: "Summarize text. Funds are held in escrow until delivery.",
    asset: usdcAssetId(mint),
  });

  // Both entries share the session nonce, so the escrow address is the same
  // either way and a replay cannot settle twice.
  const solAccept: PaymentRequirements = {
    ...solChallenge.accepts[0],
    description: "Summarize text, paid in native SOL.",
  };

  return { ...challenge, accepts: [...challenge.accepts, solAccept] };
}

export type VerifiedPayment = {
  buyer: Address;
  escrow: Address;
  txSignature: string;
  /** Which quote the buyer actually satisfied, read from chain. */
  asset: AssetKind;
  /** The amount actually locked, in base units of `asset`. */
  amount: bigint;
  sessionId: string;
};

/**
 * Turn an `X-PAYMENT` header into a trusted receipt, or throw.
 *
 * The header only carries the transaction signature and the buyer's claim. Three
 * things are then re-derived rather than believed:
 *
 *   1. the escrow address, from buyer + seller + session
 *   2. the asset, from the escrow the program actually opened
 *   3. the price, from the session's quote for *that* asset
 *
 * Step 2 before step 3 is the whole point. A session quotes both currencies at
 * different amounts, so checking a SOL lock against the USDC price rejects an
 * honest payment. Reading the asset first means the buyer's stated currency is
 * a hint, never the basis for verification.
 */
export async function verifyPayment(
  header: string | null,
  expected: { session: Session }
): Promise<VerifiedPayment> {
  if (!header) throw new PaymentError("missing X-PAYMENT header", 402);

  let payload;
  try {
    payload = decodePayment(header);
  } catch (err) {
    throw new PaymentError((err as Error).message, 402);
  }

  if (payload.scheme !== SCHEME) {
    throw new PaymentError(`unsupported scheme ${payload.scheme}`, 402);
  }
  if (payload.payload.sessionId !== expected.session.sessionId) {
    throw new PaymentError("payment does not match the quoted session", 402);
  }

  const [seller] = await Promise.all([roleSigner("seller")]);
  const buyer = payload.payload.buyer as Address;

  // Verify the lock first, but without an expectation. The point is to learn
  // which escrow the program actually opened and what currency it recorded,
  // rather than to assert what the header claimed.
  const result = await aesdr().verifyLock({
    txSignature: payload.payload.txSignature as never,
    sessionId: hexDecode(expected.session.sessionId),
    buyer,
    seller: seller.address,
  });

  if (!result.valid || !result.escrow) {
    throw new PaymentError(result.reason ?? "payment did not verify", 402);
  }

  const locked = result.escrow;
  const asset: AssetKind = locked.asset === ASSET_SPL ? "spl" : "lamports";
  const quoted = priceFor(expected.session, asset);

  // A token escrow is only good if it holds the mint this session quoted. Any
  // other mint is a different asset at a price we never agreed to, even if the
  // base-unit amount happens to match.
  if (asset === "spl") {
    if (!expected.session.mint) {
      throw new PaymentError("this session did not quote a token price", 402);
    }
    if (locked.mint !== expected.session.mint) {
      throw new PaymentError(
        `escrow holds mint ${locked.mint}, expected ${expected.session.mint}`,
        402
      );
    }
  }

  // The amount is checked against the quote for the currency that was actually
  // locked. This is the line that used to compare a SOL lock to the USDC price.
  if (locked.amount !== quoted) {
    throw new PaymentError(
      `locked ${locked.amount} base units, expected ${quoted}`,
      402
    );
  }

  return {
    buyer,
    escrow: locked.address,
    txSignature: payload.payload.txSignature,
    asset,
    amount: locked.amount,
    sessionId: expected.session.sessionId,
  };
}

/** Attach a verified payment to a successful response, as x402 expects. */
export function paymentResponseHeader(payment: VerifiedPayment): string {
  return encodePayment({
    x402Version: 1,
    scheme: SCHEME,
    network: networkName(),
    payload: {
      txSignature: payment.txSignature,
      sessionId: payment.sessionId,
      buyer: payment.buyer,
    },
  });
}

export class PaymentError extends Error {
  constructor(message: string, readonly status: 402 | 400) {
    super(message);
    this.name = "PaymentError";
  }
}

/** The shared shape the arbiter checks against, re-exported for the route. */
export { PAYLOAD_SHAPE };

/** Sentinel used when a caller asks for a lamport quote explicitly. */
export const LAMPORTS = ASSET_LAMPORTS;
