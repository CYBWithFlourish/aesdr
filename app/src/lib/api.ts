"use client";

/**
 * Typed client for the app's own JSON routes.
 *
 * Small on purpose: the pages need the seller's status and the arbiter's
 * session list, and nothing here should ever grow into a general API layer.
 */

export type SellerStatus = {
  cluster: string;
  network: string;
  programId: string;
  seller: string;
  arbiter: string;
  /** `null` when this cluster has no USDC mint configured yet. */
  usdcMint: string | null;
  price: { usdc: string; sol: string };
  bond: { balance: string; required: string; sufficient: boolean };
  deadlineSeconds: number;
  faultInjection: "none" | "empty" | "error";
};

export type SessionRow = {
  sessionId: string;
  createdAt: number;
  /**
   * Both quoted prices, because one session can be paid in either currency.
   * Display picks the one the buyer actually used, falling back to the SPL
   * price for a session that was only ever quoted.
   */
  prices: { spl: string; lamports: string };
  mint: string | null;
  inputPreview: string;
  paid: {
    buyer: string;
    txSignature: string;
    escrow: string;
    asset: "lamports" | "spl";
    amount: string;
    at: number;
  } | null;
  delivery: {
    payloadHash: string;
    model: string;
    at: number;
    body: string;
  } | null;
  escrow: {
    address: string;
    state: number;
    stateLabel: string;
    amount: string;
    asset: number;
    mint: string;
    buyer: string;
    seller: string;
    deadline: number;
    reclaimable: boolean;
  } | null;
};

/**
 * The amount and currency to show for a session.
 *
 * A paid session knows exactly what was locked; an unpaid one only has the
 * quote, and the SOL price is the one every deployment can offer.
 */
export function sessionAmount(row: SessionRow): {
  amount: string;
  asset: "lamports" | "spl";
} {
  if (row.paid) return { amount: row.paid.amount, asset: row.paid.asset };
  if (row.escrow) {
    return {
      amount: row.escrow.amount,
      asset: row.escrow.asset === 1 ? "spl" : "lamports",
    };
  }
  return { amount: row.prices.lamports, asset: "lamports" };
}

export async function fetchSellerStatus(): Promise<SellerStatus> {
  const response = await fetch("/api/seller", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`seller status failed: HTTP ${response.status}`);
  }
  return (await response.json()) as SellerStatus;
}

export async function fetchSessions(): Promise<SessionRow[]> {
  const response = await fetch("/api/arbiter", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`session list failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { sessions: SessionRow[] };
  return payload.sessions;
}

export type SettleResult = {
  outcome: "PASS" | "BREACH";
  reason: string | null;
  signature: string;
  escrow: string;
};

export async function settle(args: {
  escrow: string;
  body: string;
  expectedHash?: string;
  settle: boolean;
}): Promise<SettleResult> {
  const response = await fetch("/api/arbiter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      (payload as { detail?: string }).detail ??
        (payload as { error?: string }).error ??
        `settle failed: HTTP ${response.status}`
    );
  }

  return payload as SettleResult;
}
