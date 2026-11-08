"use client";

/**
 * Buyer console.
 *
 * The demo this page exists to show: a request, a real 402, a real lock, and a
 * real LLM response whose hash the buyer can hand to the arbiter later.
 *
 * The wallet is used as a sending signer, which means the escrow SDK hands the
 * whole message to the wallet rather than signing bytes itself. That is why the
 * SDK accepts `TransactionSigner` and not just `KeyPairSigner`.
 */
import { useState } from "react";
import {
  useSelectedWalletAccount,
  useWalletAccountTransactionSendingSigner,
} from "@solana/react";
import {
  AlertTriangle,
  CheckCircle2,
  Coins,
  FileText,
  Loader2,
  Send,
  Wallet as WalletIcon,
} from "lucide-react";
import type { UiWalletAccount } from "@wallet-standard/react";

import { buyWithEscrow, type BuyerAttempt } from "@/lib/buyer";
import { truncateAddress } from "@/lib/format";
import { Chip, ErrorNote, Panel, Stat } from "@/components/ui";

type Step = "idle" | "quote" | "lock" | "deliver" | "done";

const SAMPLE =
  "Escrow-backed settlement replaces the assumption that a paid HTTP request " +
  "will be honoured. Instead of transferring funds at request time, the buyer " +
  "locks the quoted amount in a program-owned vault and the seller is paid only " +
  "after delivery is attested. The attestation can be deterministic: a hash of " +
  "the response bytes proves what was sent, so a mismatch is undeniable without " +
  "revealing the content.";

export default function BuyerPage() {
  const [account] = useSelectedWalletAccount();

  // The signing hook needs a real account and must not be called conditionally,
  // so the whole console mounts only once a wallet is connected.
  if (!account) {
    return (
      <Panel
        title="Connect a wallet"
        description="The buyer signs one transaction per request: the escrow lock. Nothing else needs approval."
        icon={WalletIcon}
      >
        <p className="text-xs leading-relaxed text-ink-400">
          Use the connect button in the header. A devnet wallet with a little
          SOL, plus USDC if you want to pay in the stablecoin, is all you need.
        </p>
      </Panel>
    );
  }

  return <BuyerConsole account={account} />;
}

function BuyerConsole({ account }: { account: UiWalletAccount }) {
  const signer = useWalletAccountTransactionSendingSigner(
    account,
    "solana:localnet"
  );

  const [input, setInput] = useState(SAMPLE);
  const [asset, setAsset] = useState<"spl" | "lamports">("spl");
  const [step, setStep] = useState<Step>("idle");
  const [attempt, setAttempt] = useState<BuyerAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = step === "quote" || step === "lock" || step === "deliver";

  async function run() {
    setError(null);
    setAttempt(null);
    setStep("quote");

    try {
      const result = await buyWithEscrow({
        input,
        asset,
        buyer: signer,
        onStep: setStep,
      });
      setAttempt(result);
      setStep("done");
    } catch (err) {
      setError((err as Error).message);
      setStep("idle");
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
      <Panel
        title="Request"
        description="The text is sent with the quote, held server side, and only summarized after the lock verifies."
        icon={FileText}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={9}
          className="w-full resize-y rounded-lg border border-ink-700 bg-ink-950/60 p-3 text-xs leading-relaxed text-ink-100 outline-none focus:border-held/60"
          placeholder="Paste the text you want summarized"
        />

        <div className="flex flex-wrap items-center gap-2">
          <span className="label">Pay with</span>
          <button
            type="button"
            onClick={() => setAsset("spl")}
            className={`rounded-lg border px-3 py-1.5 text-xs ${
              asset === "spl"
                ? "border-held/50 bg-held/10 text-held"
                : "border-ink-700 text-ink-300 hover:border-ink-600"
            }`}
          >
            USDC
          </button>
          <button
            type="button"
            onClick={() => setAsset("lamports")}
            className={`rounded-lg border px-3 py-1.5 text-xs ${
              asset === "lamports"
                ? "border-held/50 bg-held/10 text-held"
                : "border-ink-700 text-ink-300 hover:border-ink-600"
            }`}
          >
            SOL
          </button>
        </div>

        <button
          type="button"
          onClick={run}
          disabled={busy || !account}
          className="flex items-center justify-center gap-2 rounded-lg bg-held px-4 py-2.5 text-sm font-medium text-ink-950 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Send className="size-4" aria-hidden />
          )}
          {busy ? STEP_LABEL[step] : "Request and pay"}
        </button>

        {!account && (
          <p className="text-xs text-ink-400">
            Connect a wallet in the header. The lock is the only signature
            required.
          </p>
        )}

        {error && <ErrorNote>{error}</ErrorNote>}
      </Panel>

      <div className="flex flex-col gap-4">
        <Panel
          title="Handshake"
          description="Each phase is a real network round trip."
          icon={Coins}
        >
          <ol className="flex flex-col gap-2">
            {(["quote", "lock", "deliver"] as const).map((name) => {
              const state = phaseState(name, step);
              return (
                <li key={name} className="flex items-center gap-3 text-xs">
                  {state === "done" ? (
                    <CheckCircle2 className="size-4 text-pass" aria-hidden />
                  ) : state === "active" ? (
                    <Loader2
                      className="size-4 animate-spin text-held"
                      aria-hidden
                    />
                  ) : state === "failed" ? (
                    <AlertTriangle className="size-4 text-breach" aria-hidden />
                  ) : (
                    <span className="size-4 rounded-full border border-ink-600" />
                  )}
                  <span
                    className={
                      state === "pending" ? "text-ink-400" : "text-ink-100"
                    }
                  >
                    {PHASE_LABEL[name]}
                  </span>
                </li>
              );
            })}
          </ol>
        </Panel>

        {attempt && (
          <Panel
            title="Receipt"
            description="The lock signature and the seller's commitment."
            icon={CheckCircle2}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <Stat
                label="Escrow"
                value={truncateAddress(attempt.escrow, 7)}
                tone="held"
                hint={attempt.escrow}
              />
              <Stat
                label="Lock tx"
                value={truncateAddress(attempt.lockSignature, 6)}
                hint={attempt.lockSignature}
              />
            </div>

            <div>
              <p className="label mb-1.5">Payload hash</p>
              <p className="tabular break-all rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2 text-[11px] text-pass">
                {attempt.delivery.payloadHash ?? "none supplied"}
              </p>
            </div>

            <div>
              <p className="label mb-1.5">Response</p>
              <pre className="max-h-64 overflow-auto rounded-lg border border-ink-800 bg-ink-950/60 p-3 text-[11px] leading-relaxed text-ink-300">
                {pretty(attempt.delivery.body)}
              </pre>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="held">
                {attempt.accepted.asset === "lamports"
                  ? "paid in SOL"
                  : "paid in USDC"}
              </Chip>
              <Chip tone="neutral">
                session {attempt.delivery.sessionId.slice(0, 10)}
              </Chip>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

const PHASE_LABEL = {
  quote: "POST without payment, read the 402 challenge",
  lock: "Lock the quoted amount in escrow",
  deliver: "Retry with X-PAYMENT, receive the payload",
} as const;

const STEP_LABEL: Record<Step, string> = {
  idle: "Request and pay",
  quote: "Requesting quote...",
  lock: "Confirm in wallet...",
  deliver: "Waiting for delivery...",
  done: "Request and pay",
};

/** Map the current step onto each phase's visual state. */
function phaseState(
  name: "quote" | "lock" | "deliver",
  step: Step
): "done" | "active" | "pending" | "failed" {
  const order = ["quote", "lock", "deliver"];
  const index = order.indexOf(name);
  const current = step === "done" ? order.length : order.indexOf(step);

  if (step === "idle") return "pending";
  if (index < current) return "done";
  if (index === current) return "active";
  return "pending";
}

/** Pretty-print JSON when possible, otherwise show the raw text. */
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
