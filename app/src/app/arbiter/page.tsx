"use client";

/**
 * Arbiter console.
 *
 * This is the page that makes the whole model legible: pick a delivered
 * session, replay the five checks against what the seller actually sent, and
 * then either release or refund. The verdict is computed by the same
 * `evaluate` function the test suite uses, so what you see here is what the
 * tests assert.
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Gavel,
  Loader2,
  RefreshCw,
  Scale,
  XCircle,
} from "lucide-react";

import {
  fetchSessions,
  settle,
  sessionAmount,
  type SessionRow,
} from "@/lib/api";
import {
  formatAmount,
  formatEpoch,
  shortHash,
  truncateAddress,
} from "@/lib/format";
import { Chip, EmptyNote, ErrorNote, Panel, Stat } from "@/components/ui";

export default function ArbiterPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState<{
    outcome: string;
    reason: string | null;
    signature: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchSessions();
      setSessions(rows);
      // Keep the current selection fresh so its escrow state does not go stale.
      setSelected((current) =>
        current
          ? rows.find((r) => r.sessionId === current.sessionId) ?? null
          : null
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(shouldSettle: boolean) {
    if (!selected?.escrow || !selected.delivery) return;

    setBusy(true);
    setError(null);
    setSettled(null);

    try {
      const result = await settle({
        escrow: selected.escrow.address,
        body: selected.delivery.body,
        expectedHash: selected.delivery.payloadHash,
        settle: shouldSettle,
      });
      setSettled(result);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
      <Panel
        title="Sessions"
        description="Every quote this process issued, joined with live escrow state."
        icon={Gavel}
        aside={
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs text-ink-300 hover:border-ink-600"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Refresh
          </button>
        }
      >
        {loading && sessions.length === 0 && (
          <p className="flex items-center gap-2 text-xs text-ink-400">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading sessions...
          </p>
        )}

        {!loading && sessions.length === 0 && (
          <EmptyNote>
            No sessions yet. Run a request from the buyer console first.
          </EmptyNote>
        )}

        <ul className="flex flex-col gap-1.5">
          {sessions.map((row) => {
            const active = selected?.sessionId === row.sessionId;
            return (
              <li key={row.sessionId}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(row);
                    setSettled(null);
                  }}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    active
                      ? "border-held/50 bg-held/10"
                      : "border-ink-800 hover:border-ink-700"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="tabular text-xs text-ink-100">
                      {(() => {
                        const { amount, asset } = sessionAmount(row);
                        return formatAmount(amount, asset);
                      })()}
                    </span>
                    <SessionChip row={row} />
                  </div>
                  <p className="mt-1 truncate text-[11px] text-ink-400">
                    {row.inputPreview}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="flex flex-col gap-4">
        {error && (
          <Panel title="Error" icon={AlertTriangle}>
            <ErrorNote>{error}</ErrorNote>
          </Panel>
        )}

        {!selected && (
          <Panel
            title="Select a session"
            description="The verdict runs against the delivery the seller actually sent."
            icon={Scale}
          >
            <EmptyNote>
              Pick a paid session on the left to inspect its escrow and its
              delivery commitment.
            </EmptyNote>
          </Panel>
        )}

        {selected && (
          <>
            <Panel
              title="Escrow"
              description="Read straight from the chain, not from local state."
              icon={Scale}
              aside={<SessionChip row={selected} />}
            >
              {selected.escrow ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Stat
                    label="Address"
                    value={truncateAddress(selected.escrow.address, 7)}
                    hint={selected.escrow.address}
                  />
                  <Stat
                    label="State"
                    value={selected.escrow.stateLabel}
                    tone="held"
                  />
                  <Stat
                    label="Amount"
                    value={formatAmount(
                      selected.escrow.amount,
                      selected.escrow.asset === 1 ? "spl" : "lamports"
                    )}
                  />
                  <Stat
                    label="Deadline"
                    value={formatEpoch(selected.escrow.deadline * 1000)}
                    hint={
                      selected.escrow.reclaimable
                        ? "Buyer may reclaim now"
                        : "Buyer can reclaim after this"
                    }
                  />
                  <Stat
                    label="Buyer"
                    value={truncateAddress(selected.escrow.buyer, 6)}
                    hint={selected.escrow.buyer}
                  />
                  <Stat
                    label="Seller"
                    value={truncateAddress(selected.escrow.seller, 6)}
                    hint={selected.escrow.seller}
                  />
                </div>
              ) : (
                <EmptyNote>
                  This quote was never paid, so no escrow exists for it.
                </EmptyNote>
              )}
            </Panel>

            {selected.delivery && (
              <Panel
                title="Delivery"
                description="The exact bytes the seller sent, and the hash it committed to."
                icon={CheckCircle2}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <Stat
                    label="Committed hash"
                    value={shortHash(selected.delivery.payloadHash)}
                    hint={selected.delivery.payloadHash}
                    tone="pass"
                  />
                  <Stat
                    label="Model"
                    value={selected.delivery.model}
                    hint={formatEpoch(selected.delivery.at)}
                  />
                </div>

                <pre className="max-h-56 overflow-auto rounded-lg border border-ink-800 bg-ink-950/60 p-3 text-[11px] leading-relaxed text-ink-300">
                  {pretty(selected.delivery.body)}
                </pre>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy || !selected.escrow}
                    onClick={() => run(false)}
                    className="flex items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-xs hover:border-ink-600 disabled:opacity-40"
                  >
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Scale className="size-3.5" aria-hidden />
                    )}
                    Run verdict only
                  </button>
                  <button
                    type="button"
                    disabled={busy || !selected.escrow}
                    onClick={() => run(true)}
                    className="flex items-center gap-2 rounded-lg bg-held px-3 py-2 text-xs font-medium text-ink-950 hover:opacity-90 disabled:opacity-40"
                  >
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Gavel className="size-3.5" aria-hidden />
                    )}
                    Settle
                  </button>
                </div>

                <p className="text-[11px] leading-relaxed text-ink-400">
                  Settling calls <span className="tabular">release</span> on
                  PASS and <span className="tabular">refund</span> otherwise.
                  The refund also slashes 10% of the seller&apos;s bond.
                </p>
              </Panel>
            )}

            {settled && (
              <Panel
                title="Result"
                icon={settled.outcome === "PASS" ? CheckCircle2 : XCircle}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={settled.outcome === "PASS" ? "pass" : "breach"}>
                    {settled.outcome}
                  </Chip>
                  <span className="text-xs text-ink-300">
                    {settled.reason ?? "all checks passed"}
                  </span>
                </div>
                <Stat
                  label="Transaction"
                  value={truncateAddress(settled.signature, 8)}
                  hint={settled.signature}
                  tone={settled.outcome === "PASS" ? "pass" : "breach"}
                />
              </Panel>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Escrow state wins when it exists; otherwise show how far the session got. */
function SessionChip({ row }: { row: SessionRow }) {
  if (row.escrow) {
    const tone =
      row.escrow.state === 0
        ? "held"
        : row.escrow.state === 1
        ? "pass"
        : "breach";
    return <Chip tone={tone}>{row.escrow.stateLabel}</Chip>;
  }
  if (row.paid) return <Chip tone="warn">paid, unread</Chip>;
  if (row.delivery) return <Chip tone="warn">unpaid</Chip>;
  return <Chip tone="neutral">quoted</Chip>;
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
