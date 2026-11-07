/**
 * Deterministic verdict engine.
 *
 * This is the arbiter's brain. It answers one question: did the seller honour
 * the deal? Every check here is pure and reproducible - given the same request,
 * response, and commitment, it returns the same verdict with no network calls
 * and no model in the loop.
 *
 * The five checks, in order of cost. The first failure short-circuits and is
 * reported as the reason, so the UI can explain *why* money went back.
 *
 *   1. status     the seller did not return 2xx
 *   2. schema     the body is not the shape the contract promised
 *   3. hash       the body is not what the seller committed to
 *   4. length     the body is structurally valid but substantively empty
 *   5. quality    (optional) a caller-supplied predicate, e.g. an LLM judge
 *
 * Check 3 is what makes breach provable without zero-knowledge: the seller
 * signs a hash of what it sent, so a truncated or swapped payload fails to
 * match its own commitment. Check 4 is what catches a seller that commits to
 * garbage on purpose - the honest demo case.
 */

export type CheckName = "status" | "schema" | "hash" | "length" | "quality";

export type CheckResult = {
  name: CheckName;
  passed: boolean;
  detail: string;
};

export type Verdict = {
  outcome: "PASS" | "BREACH";
  /** The first failing check, or null on PASS. This is what the UI shows. */
  reason: CheckName | null;
  checks: CheckResult[];
  /** sha256 of the response body, lowercase hex. */
  payloadHash: string;
};

export type VerdictInput = {
  /** HTTP status the seller returned. */
  httpStatus: number;
  /** Raw response body exactly as received. */
  body: string;
  /**
   * The hash the seller committed to in `X-AESDR-Payload-Hash`. Optional: when
   * absent the hash check is skipped rather than failed, because an unsigned
   * response is a weaker claim, not a breach.
   */
  expectedHash?: string;
  /** Minimum meaningful length of the text field, when the schema declares one. */
  minLength?: number;
  /** JSON schema check: required top-level keys. */
  requiredKeys?: string[];
  /** The key holding the human-readable payload, used by the length check. */
  textKey?: string;
  /** Optional final gate for subjective quality. Returning false is a breach. */
  qualityCheck?: (body: string) => Promise<boolean> | boolean;
};

const DEFAULT_TEXT_KEY = "summary";
const DEFAULT_MIN_LENGTH = 40;

export async function evaluate(input: VerdictInput): Promise<Verdict> {
  const checks: CheckResult[] = [];
  const payloadHash = await sha256Hex(input.body);

  // 1. status
  const statusOk = input.httpStatus >= 200 && input.httpStatus < 300;
  checks.push({
    name: "status",
    passed: statusOk,
    detail: statusOk ? `HTTP ${input.httpStatus}` : `seller returned HTTP ${input.httpStatus}`,
  });
  if (!statusOk) return finish(checks, payloadHash);

  // 2. schema
  let parsed: unknown = null;
  let schemaDetail = "body is valid JSON";
  try {
    parsed = JSON.parse(input.body);
  } catch {
    schemaDetail = "body is not valid JSON";
  }

  const keys = input.requiredKeys ?? [];
  if (schemaDetail === "body is valid JSON" && keys.length > 0) {
    const obj = parsed as Record<string, unknown>;
    const missing = keys.filter((k) => !(k in (obj ?? {})));
    if (missing.length > 0) {
      schemaDetail = `missing required keys: ${missing.join(", ")}`;
      parsed = null;
    }
  }

  const schemaOk = parsed !== null;
  checks.push({ name: "schema", passed: schemaOk, detail: schemaDetail });
  if (!schemaOk) return finish(checks, payloadHash);

  // 3. hash - only enforced when the seller committed to one.
  if (input.expectedHash) {
    const expected = input.expectedHash.toLowerCase().trim();
    const hashOk = expected === payloadHash;
    checks.push({
      name: "hash",
      passed: hashOk,
      detail: hashOk
        ? "response matches the seller's commitment"
        : `committed ${expected.slice(0, 12)}… but received ${payloadHash.slice(0, 12)}…`,
    });
    if (!hashOk) return finish(checks, payloadHash);
  } else {
    checks.push({
      name: "hash",
      passed: true,
      detail: "no commitment supplied, check skipped",
    });
  }

  // 4. length - catches a seller that signed a substantively empty payload.
  const textKey = input.textKey ?? DEFAULT_TEXT_KEY;
  const minLength = input.minLength ?? DEFAULT_MIN_LENGTH;
  const obj = parsed as Record<string, unknown>;
  const raw = obj?.[textKey];
  const text = typeof raw === "string" ? raw : "";
  const lengthOk = text.trim().length >= minLength;
  checks.push({
    name: "length",
    passed: lengthOk,
    detail: lengthOk
      ? `${textKey} is ${text.trim().length} chars (min ${minLength})`
      : `${textKey} is ${text.trim().length} chars, below the ${minLength} minimum`,
  });
  if (!lengthOk) return finish(checks, payloadHash);

  // 5. quality - optional, caller-supplied.
  if (input.qualityCheck) {
    let passed = false;
    let detail = "quality check failed";
    try {
      passed = await input.qualityCheck(input.body);
      detail = passed ? "quality check passed" : "quality check rejected the payload";
    } catch (err) {
      detail = `quality check threw: ${(err as Error).message}`;
    }
    checks.push({ name: "quality", passed, detail });
    if (!passed) return finish(checks, payloadHash);
  }

  return finish(checks, payloadHash);
}

function finish(checks: CheckResult[], payloadHash: string): Verdict {
  const firstFailure = checks.find((c) => !c.passed);
  return {
    outcome: firstFailure ? "BREACH" : "PASS",
    reason: firstFailure ? firstFailure.name : null,
    checks,
    payloadHash,
  };
}

/** sha256 of a UTF-8 string, lowercase hex. Uses WebCrypto when present. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);

  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return hexEncode(new Uint8Array(digest));
  }

  // Node fallback for runtimes without WebCrypto on the global.
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

function hexEncode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
