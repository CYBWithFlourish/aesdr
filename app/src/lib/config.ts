/**
 * Server-side configuration.
 *
 * Every value that differs between local, devnet and a live demo is read here
 * and nowhere else, so flipping clusters is an env change rather than a code
 * change. Anything a browser must see is prefixed `NEXT_PUBLIC_`; keys are not.
 */
import { USDC_DEVNET_MINT, USDC_MAINNET_MINT, type Address } from "@aesdr/sdk";

export type Cluster = "localnet" | "devnet" | "mainnet";

/** Which cluster the consoles point at, inferred from the RPC URL. */
export function cluster(): Cluster {
  const url = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "";
  if (url.includes("mainnet")) return "mainnet";
  if (url.includes("devnet") || url.includes("api.devnet")) return "devnet";
  return "localnet";
}

export function rpcUrl(): string {
  return process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
}

/**
 * The USDC mint the seller accepts on the current cluster.
 *
 * Local validators have no Circle deployment, so the demo creates its own
 * six-decimal token. That substitution is confined to `localnet`: devnet and
 * mainnet always use Circle's addresses.
 *
 * On localnet the override is **required**, not merely preferred. Falling back
 * to the devnet mint there is what produced the original `IncorrectProgramId`:
 * the app quoted a mint the local validator has never seen, so ATA creation
 * failed deep inside the token program. An explicit error naming the missing
 * env var is far easier to act on than a program log.
 */
export function usdcMint(): Address {
  const override = process.env.USDC_MINT?.trim();
  if (override) return override as Address;

  switch (cluster()) {
    case "mainnet":
      return USDC_MAINNET_MINT;
    case "devnet":
      return USDC_DEVNET_MINT;
    default:
      throw new Error(
        "USDC_MINT is not set. On a local validator there is no Circle " +
          "deployment, so run `npm run setup:demo` and restart the dev server " +
          "to pick up the locally created mint."
      );
  }
}

/**
 * `usdcMint()` but `null` instead of throwing when the cluster has no mint.
 *
 * Used by endpoints that describe configuration rather than price a request: a
 * status page should say "no mint yet", not return a 500 that hides every
 * other field it was about to report.
 */
export function usdcMintOrNull(): Address | null {
  try {
    return usdcMint();
  } catch {
    return null;
  }
}

/** CAIP-2 network name, matching what x402 carries on the wire. */
export function networkName(): string {
  switch (cluster()) {
    case "mainnet":
      return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    case "devnet":
      return "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    default:
      return "solana:localnet";
  }
}

/**
 * Price the seller quotes per request, in USDC base units.
 *
 * USDC is the default because it is what x402 assumes, and because a
 * six-decimal stablecoin makes the escrow amounts legible. The env value is in
 * base units so no float ever touches a price.
 */
export function priceUsdc(): bigint {
  return BigInt(process.env.SELLER_PRICE_USDC ?? 250_000);
}

/** Same price expressed in lamports, for buyers paying in SOL. */
export function priceSol(): bigint {
  return BigInt(process.env.SELLER_PRICE_SOL ?? 10_000_000);
}

/** Collateral a seller must hold before it can be paid. Always lamports. */
export function minBond(): bigint {
  return BigInt(process.env.SELLER_MIN_BOND ?? 10_000_000);
}

export function deadlineSeconds(): number {
  return Number(process.env.ESCROW_DEADLINE_SECONDS ?? 900);
}

/**
 * Model configuration.
 *
 * `OPENAI_API_KEY` is required: the seller does real work and cannot call a
 * model without it. The base URL and model are optional overrides whose absence
 * means the official defaults.
 */
export function openaiConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseURL: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  };
}

/**
 * Demo lever. `empty` makes the seller return a substantively empty body, which
 * is the honest-looking breach the arbiter's length check is built to catch.
 * `none` behaves normally.
 */
export function sellerFault(): "none" | "empty" | "error" {
  const raw = (process.env.SELLER_FAULT ?? "none").toLowerCase();
  if (raw === "empty" || raw === "error") return raw;
  return "none";
}

/** Route the seller sells. x402 records this as the `resource` being paid for. */
export const RESOURCE_PATH = "/api/summarize";

/** What the seller promises to return, so the arbiter can check the shape. */
export const PAYLOAD_SHAPE = {
  requiredKeys: ["summary", "model", "inputLength"],
  textKey: "summary",
  minLength: 40,
} as const;
