/**
 * Presentation helpers.
 *
 * Amounts live on chain as `bigint` base units, so every conversion happens in
 * one place. No float ever touches a balance.
 */
import { USDC_DECIMALS } from "@aesdr/sdk";

/** 7 lamports to the SOL. */
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** 12345678n -> "0.012345678" with trailing zeros trimmed. */
function withDecimals(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);

  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(decimals, "0");
  const trimmed = fraction.replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
}

/** Lamports as SOL, e.g. `0.01 SOL`. */
export function formatSol(lamports: bigint | string): string {
  return `${withDecimals(BigInt(lamports), 9)} SOL`;
}

/** USDC base units as USDC, e.g. `0.25 USDC`. */
export function formatUsdc(baseUnits: bigint | string): string {
  return `${withDecimals(BigInt(baseUnits), USDC_DECIMALS)} USDC`;
}

/** Render an amount in whichever asset it is denominated in. */
export function formatAmount(
  amount: bigint | string,
  asset: "lamports" | "spl"
): string {
  return asset === "spl" ? formatUsdc(amount) : formatSol(amount);
}

/** `7xKX...9fQ2`, the usual way to show an address in a list. */
export function truncateAddress(address: string, size = 4): string {
  if (address.length <= size * 2 + 3) return address;
  return `${address.slice(0, size)}...${address.slice(-size)}`;
}

/** A short hexadecimal digest, for showing commitments compactly. */
export function shortHash(hash: string, size = 8): string {
  return `${hash.slice(0, size)}...${hash.slice(-4)}`;
}

/** Unix seconds as a local time string. */
export function formatTime(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString();
}

/** Milliseconds as a local time string. */
export function formatEpoch(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/** Explorer link, or null on a local validator where none exists. */
export function explorerTx(signature: string, cluster: string): string | null {
  if (cluster === "localnet") return null;
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}
