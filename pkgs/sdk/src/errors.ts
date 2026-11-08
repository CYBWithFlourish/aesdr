import {
  AESDR_ERROR__ALREADY_SETTLED,
  AESDR_ERROR__BOND_TOO_SMALL,
  AESDR_ERROR__DEADLINE_NOT_REACHED,
  AESDR_ERROR__ESCROW_NOT_OPEN,
  AESDR_ERROR__INVALID_AMOUNT,
  AESDR_ERROR__INVALID_BOND,
  AESDR_ERROR__INVALID_DEADLINE,
  AESDR_ERROR__INVALID_ASSET,
  AESDR_ERROR__INVALID_SESSION_ID,
  AESDR_ERROR__MINT_MISMATCH,
  AESDR_ERROR__MISSING_TOKEN_ACCOUNTS,
  AESDR_ERROR__OVERFLOW,
  AESDR_ERROR__SELF_DEALING,
  AESDR_ERROR__UNAUTHORIZED,
  getAesdrErrorMessage,
  type AesdrError,
} from "@aesdr/client";

/**
 * Every error the program can raise.
 *
 * Derived from the generated constants rather than a hardcoded range, so
 * adding an error to the program and rerunning codama keeps this correct.
 */
const KNOWN_ERRORS: ReadonlySet<number> = new Set<number>([
  AESDR_ERROR__UNAUTHORIZED,
  AESDR_ERROR__ESCROW_NOT_OPEN,
  AESDR_ERROR__ALREADY_SETTLED,
  AESDR_ERROR__INVALID_AMOUNT,
  AESDR_ERROR__INVALID_BOND,
  AESDR_ERROR__BOND_TOO_SMALL,
  AESDR_ERROR__INVALID_DEADLINE,
  AESDR_ERROR__DEADLINE_NOT_REACHED,
  AESDR_ERROR__INVALID_SESSION_ID,
  AESDR_ERROR__SELF_DEALING,
  AESDR_ERROR__OVERFLOW,
  AESDR_ERROR__INVALID_ASSET,
  AESDR_ERROR__MISSING_TOKEN_ACCOUNTS,
  AESDR_ERROR__MINT_MISMATCH,
]);

/**
 * A failed AESDR transaction, with the program's own error surfaced.
 *
 * Kit reports a preflight failure as a generic "Transaction simulation failed"
 * and puts the useful part - the program logs and the `Custom` error code - in
 * `context`. Left undecoded, every program rejection looks identical, which is
 * exactly the case a caller needs to distinguish: "bond too small, go post
 * more" is a different remedy from "already settled".
 */
export class AesdrTransactionError extends Error {
  constructor(
    message: string,
    readonly programError: AesdrError | null,
    readonly logs: string[],
    readonly signature?: string
  ) {
    super(message);
    this.name = "AesdrTransactionError";
  }
}

/** Pull the program's error number out of Anchor's log lines. */
export function parseCustomErrorCode(logs: readonly string[]): number | null {
  for (const line of logs) {
    // Anchor emits: "Program log: AnchorError occurred. Error Code: BondTooSmall. Error Number: 6005. Error Message: ..."
    const numbered = /Error Number: (\d+)/.exec(line);
    if (numbered) return Number(numbered[1]);

    // Non-Anchor programs emit: "Program log: Error: Custom(6005)".
    const custom = /Custom\((\d+)\)/.exec(line);
    if (custom) return Number(custom[1]);
  }
  return null;
}

/**
 * Normalise anything thrown while sending a transaction.
 *
 * Returns an `AesdrTransactionError` when the program complained, and the
 * original error untouched when the failure was transport-level (blockhash
 * expired, RPC down) so callers do not mistake infrastructure for a verdict.
 */
export function toAesdrError(err: unknown, signature?: string): unknown {
  const logs = extractLogs(err);
  if (logs.length === 0) return err;

  const code = parseCustomErrorCode(logs);
  if (code === null) {
    return new AesdrTransactionError(
      `transaction failed: ${firstMeaningfulLog(logs)}`,
      null,
      logs,
      signature
    );
  }

  const isOurs = KNOWN_ERRORS.has(code);
  const detail = isOurs
    ? getAesdrErrorMessage(code as AesdrError)
    : `program error ${code}`;

  return new AesdrTransactionError(
    `aesdr rejected the transaction: ${detail} (code ${code})`,
    isOurs ? (code as AesdrError) : null,
    logs,
    signature
  );
}

function extractLogs(err: unknown): string[] {
  if (typeof err !== "object" || err === null) return [];

  const context = (err as { context?: unknown }).context;
  if (typeof context === "object" && context !== null) {
    const logs = (context as { logs?: unknown }).logs;
    if (Array.isArray(logs))
      return logs.filter((l): l is string => typeof l === "string");
  }

  // Some failures nest program logs inside a simulation result.
  const sim = (err as { simulationResult?: { logs?: unknown } })
    .simulationResult;
  if (sim && Array.isArray(sim.logs)) {
    return sim.logs.filter((l): l is string => typeof l === "string");
  }

  // Some Kit versions nest the preflight result one level deeper.
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) return extractLogs(cause);

  return [];
}

function firstMeaningfulLog(logs: string[]): string {
  const programLog = logs.find((l) => l.includes("Program log: Error"));
  return programLog ?? logs[logs.length - 1] ?? "unknown error";
}
