"use client";

/**
 * Seller console.
 *
 * Two truthful numbers matter here: what the seller charges, and whether its
 * collateral bond is large enough to be payable at all. The second is read from
 * chain, not from local state, because that is the one a buyer's lock checks.
 */
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Store,
  Zap,
} from "lucide-react";

import { fetchSellerStatus, type SellerStatus } from "@/lib/api";
import { formatAmount, formatSol, truncateAddress } from "@/lib/format";
import { Chip, ErrorNote, Panel, Stat } from "@/components/ui";

export default function SellerPage() {
  const [status, setStatus] = useState<SellerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchSellerStatus());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading && !status) {
    return (
      <Panel title="Loading seller" icon={Store}>
        <p className="flex items-center gap-2 text-xs text-ink-400">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Reading the on-chain bond...
        </p>
      </Panel>
    );
  }

  if (error && !status) {
    return (
      <Panel title="Seller unavailable" icon={AlertTriangle}>
        <ErrorNote>{error}</ErrorNote>
      </Panel>
    );
  }

  if (!status) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <Panel
        title="Seller"
        description="This is the account buyers pay. It signs nothing on the request path, so it can stay offline."
        icon={Store}
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
        <div className="grid gap-2 sm:grid-cols-2">
          <Stat
            label="Seller address"
            value={truncateAddress(status.seller, 6)}
            hint={status.seller}
          />
          <Stat
            label="Arbiter address"
            value={truncateAddress(status.arbiter, 6)}
            hint={status.arbiter}
          />
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Stat
            label="Price, USDC"
            value={formatAmount(status.price.usdc, "spl")}
            tone="held"
          />
          <Stat
            label="Price, SOL"
            value={formatSol(status.price.sol)}
            tone="held"
          />
        </div>

        <div>
          <p className="label mb-1.5">Bond</p>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-800 bg-ink-850/60 px-3 py-2.5">
            {status.bond.sufficient ? (
              <CheckCircle2 className="size-4 text-pass" aria-hidden />
            ) : (
              <AlertTriangle className="size-4 text-breach" aria-hidden />
            )}
            <span className="tabular text-sm">
              {formatSol(status.bond.balance)}
            </span>
            <span className="text-xs text-ink-400">
              of {formatSol(status.bond.required)} required
            </span>
            <Chip tone={status.bond.sufficient ? "pass" : "breach"}>
              {status.bond.sufficient ? "payable" : "cannot be paid"}
            </Chip>
          </div>
          {!status.bond.sufficient && (
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              Every escrow checks the bond before it accepts funds. Post
              collateral from the seller key to make this endpoint payable.
            </p>
          )}
        </div>
      </Panel>

      <div className="flex flex-col gap-4">
        <Panel
          title="Protocol"
          description="What the 402 challenge advertises."
          icon={ShieldCheck}
        >
          <div className="grid gap-2">
            <Stat label="Cluster" value={status.cluster} />
            <Stat label="Network" value={status.network} tone="neutral" />
            <Stat
              label="Program"
              value={truncateAddress(status.programId, 6)}
              hint={status.programId}
            />
            <Stat
              label="USDC mint"
              value={
                status.usdcMint
                  ? truncateAddress(status.usdcMint, 6)
                  : "not configured"
              }
              hint={
                status.usdcMint ??
                "run npm run setup:demo, then restart the dev server"
              }
            />
            <Stat
              label="Reclaim after"
              value={`${status.deadlineSeconds}s`}
              hint="Buyer exit needs nobody's cooperation"
            />
          </div>
        </Panel>

        <Panel
          title="Delivery"
          description="The seller uses the official OpenAI SDK. The environment only overrides the endpoint and model."
          icon={Zap}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={status.faultInjection === "none" ? "pass" : "warn"}>
              fault: {status.faultInjection}
            </Chip>
          </div>
          <p className="text-xs leading-relaxed text-ink-400">
            Set <span className="tabular">SELLER_FAULT=empty</span> to make the
            seller return a substantively empty body. The arbiter&apos;s length
            check then fires, which is the breach the refund path exists for.
          </p>
        </Panel>
      </div>
    </div>
  );
}
