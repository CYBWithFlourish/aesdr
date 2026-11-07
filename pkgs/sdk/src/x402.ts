/**
 * x402 wire format for the `aesdr-escrow` scheme.
 *
 * x402 standardises three things: the 402 challenge body, the `X-PAYMENT` retry
 * header, and the verify/settle facilitator split. The `scheme` field is a string
 * in the spec, not an enum, so adding escrow semantics means adding a scheme
 * rather than forking the transport.
 *
 * The stock `exact` scheme is a single terminal transfer. It cannot express
 * "hold this until I check", which is why AESDR ships its own.
 */

/** Scheme identifier this package implements. */
export const SCHEME = "aesdr-escrow" as const;

export type AesdrScheme = typeof SCHEME;

export type Network = "solana-devnet" | "solana-mainnet" | (string & {});

/** One acceptable way to pay. Mirrors x402's `accepts[]` entry. */
export type PaymentRequirements = {
  scheme: AesdrScheme;
  network: Network;
  /** Price in lamports, decimal string. x402 uses strings to avoid float drift. */
  maxAmountRequired: string;
  /** The vault PDA that receives the lock, not the seller's wallet. */
  payTo: string;
  /** Route being paid for. */
  resource: string;
  description?: string;
  extra: {
    programId: string;
    /** Key that signs `release` / `refund`. The future ZK verifier seat. */
    arbiter: string;
    /** Collateral the seller must have posted, in lamports. */
    minBond: string;
    /** Seconds from now until the buyer may reclaim unilaterally. */
    deadlineSeconds: number;
    /** 32-byte session nonce, hex encoded. Scopes the escrow PDA. */
    sessionId: string;
  };
};

/** The body a seller returns with `HTTP 402 Payment Required`. */
export type Challenge = {
  x402Version: 1;
  error?: string;
  accepts: PaymentRequirements[];
};

/** What the buyer puts in the `X-PAYMENT` header, before base64. */
export type PaymentPayload = {
  x402Version: 1;
  scheme: AesdrScheme;
  network: Network;
  payload: {
    /** Signature of the `init_escrow` transaction. The receipt of the lock. */
    txSignature: string;
    sessionId: string;
    buyer: string;
  };
};

export function buildChallenge(args: {
  network: Network;
  maxAmountRequired: bigint | number | string;
  payTo: string;
  resource: string;
  description?: string;
  programId: string;
  arbiter: string;
  minBond: bigint | number | string;
  deadlineSeconds: number;
  sessionId: string;
}): Challenge {
  return {
    x402Version: 1,
    error: "payment_required",
    accepts: [
      {
        scheme: SCHEME,
        network: args.network,
        maxAmountRequired: String(args.maxAmountRequired),
        payTo: args.payTo,
        resource: args.resource,
        ...(args.description ? { description: args.description } : {}),
        extra: {
          programId: args.programId,
          arbiter: args.arbiter,
          minBond: String(args.minBond),
          deadlineSeconds: args.deadlineSeconds,
          sessionId: args.sessionId,
        },
      },
    ],
  };
}

/** Encode the retry header. Uses standard base64, as x402 specifies. */
export function encodePayment(payload: PaymentPayload): string {
  return base64Encode(JSON.stringify(payload));
}

/** Decode and validate a retry header. Throws on anything unrecognised. */
export function decodePayment(header: string): PaymentPayload {
  if (!header || typeof header !== "string") {
    throw new Error("x402: missing X-PAYMENT header");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64Decode(header.trim()));
  } catch {
    throw new Error("x402: X-PAYMENT header is not valid base64 JSON");
  }

  const p = parsed as Partial<PaymentPayload>;
  if (p.x402Version !== 1) throw new Error("x402: unsupported x402Version");
  if (p.scheme !== SCHEME) {
    throw new Error(`x402: unsupported scheme "${String(p.scheme)}", expected "${SCHEME}"`);
  }
  if (!p.payload?.txSignature) throw new Error("x402: payload.txSignature is required");

  return p as PaymentPayload;
}

/** Lamports as a 32-byte hex session nonce. */
export function newSessionId(): string {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return hexEncode(bytes);
}

export function hexEncode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("x402: sessionId must be an even-length hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64Encode(text: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64Decode(text: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "base64").toString("utf8");
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
