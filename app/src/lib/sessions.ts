/**
 * In-memory session bookkeeping.
 *
 * A 402 challenge has to remember more than the wire format carries: which
 * request was quoted, what each currency costs, and what the seller ended up
 * sending. This process-local map is enough for a demo and honest about its
 * limits - a real deployment puts this in a database keyed by the session
 * nonce.
 */
import type { Address } from "@aesdr/sdk";

export type AssetKind = "lamports" | "spl";

export type Session = {
  /** 32-byte nonce, hex encoded. The escrow PDA seed. */
  sessionId: string;
  seller: Address;
  arbiter: Address;
  /**
   * Price per asset, in base units of that asset.
   *
   * Both are remembered because one session can be paid either way. Storing a
   * single `amount` is what let a SOL lock be checked against a USDC price.
   */
  prices: {
    /** USDC base units. */
    spl: bigint;
    /** Lamports. */
    lamports: bigint;
  };
  /** Mint address when paying in `spl`. */
  mint?: Address;
  /** The buyer's request, held so the retry does not have to resend it. */
  input: string;
  createdAt: number;
  /** Filled in once the seller has produced a payload. */
  delivery?: {
    body: string;
    payloadHash: string;
    model: string;
    at: number;
  };
  /** Set when a retry with X-PAYMENT verified against the lock. */
  paid?: {
    buyer: Address;
    txSignature: string;
    escrow: Address;
    /** Which quote was actually satisfied. */
    asset: AssetKind;
    amount: bigint;
    at: number;
  };
};

/**
 * Bounded store.
 *
 * Oldest-first eviction keeps a long-running demo from leaking, while still
 * holding far more sessions than a browser session will ever open.
 */
const MAX_SESSIONS = 500;
const sessions = new Map<string, Session>();

export function putSession(session: Session): void {
  sessions.set(session.sessionId, session);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next();
    if (!oldest.done) sessions.delete(oldest.value);
  }
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

/** The price this session quoted for one asset. */
export function priceFor(session: Session, asset: AssetKind): bigint {
  return asset === "spl" ? session.prices.spl : session.prices.lamports;
}

export function recordDelivery(
  sessionId: string,
  delivery: NonNullable<Session["delivery"]>
): void {
  const session = sessions.get(sessionId);
  if (session) session.delivery = delivery;
}

export function recordPayment(
  sessionId: string,
  payment: NonNullable<Session["paid"]>
): void {
  const session = sessions.get(sessionId);
  if (session) session.paid = payment;
}

/** Newest first, for the dashboards. */
export function listSessions(): Session[] {
  return [...sessionValues()].sort((a, b) => b.createdAt - a.createdAt);
}

function sessionValues(): Session[] {
  return [...sessions.values()];
}
