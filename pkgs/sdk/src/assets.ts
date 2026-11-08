/**
 * Official USDC mints on Solana.
 *
 * Taken from `@x402/svm` (USDC_MAINNET_ADDRESS / USDC_DEVNET_ADDRESS), which is
 * the same source x402 itself uses. We never mint our own USDC: the demo uses
 * the real devnet mint, and local validator runs are the only place a
 * substitute token may appear.
 */
import type { Address } from "@solana/kit";

/** Circle's USDC on Solana mainnet. */
export const USDC_MAINNET_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;

/** Circle's USDC on devnet. This is what the demo pays in. */
export const USDC_DEVNET_MINT =
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

/** USDC has 6 decimals, so 1 USDC = 1_000_000 base units. */
export const USDC_DECIMALS = 6;

/** Convert a human USDC amount to base units. */
export function usdc(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

/** Network identifiers, CAIP-2 form, matching x402. */
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
