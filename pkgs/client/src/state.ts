/**
 * Escrow state, mirroring the `u8` on chain.
 *
 * Lives here rather than in the generated tree because the generated client
 * exposes the raw number, and a caller should never have to know that 2 means
 * "refunded".
 */
export enum EscrowState {
  Open = 0,
  Released = 1,
  Refunded = 2,
}

export const STATE_LABEL: Record<EscrowState, string> = {
  [EscrowState.Open]: "OPEN",
  [EscrowState.Released]: "RELEASED",
  [EscrowState.Refunded]: "REFUNDED",
};

/** Basis points of the seller bond slashed on a proven breach. */
export const SLASH_BPS = 1_000;
export const BPS_DENOMINATOR = 10_000;

/** Seed labels, for readers who want to derive a PDA without the generated helpers. */
export const SEEDS = {
  escrow: "escrow",
  vault: "vault",
  bond: "bond",
} as const;
