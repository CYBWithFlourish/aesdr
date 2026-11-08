import Link from "next/link";
import { ArrowRight, Bot, Gavel, Lock, ShieldCheck, Store } from "lucide-react";

const FLOW = [
  {
    icon: Lock,
    title: "Buyer locks",
    body: "The 402 quote becomes an escrow. Funds leave the buyer's wallet but not the vault.",
  },
  {
    icon: Store,
    title: "Seller delivers",
    body: "A real LLM call runs only after the lock verifies on chain, and the response is hashed.",
  },
  {
    icon: Gavel,
    title: "Arbiter settles",
    body: "Five deterministic checks decide release or refund. A breach also slashes the seller's bond.",
  },
];

export default function HomePage() {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4 pt-6">
        <div className="flex items-center gap-2 text-xs text-ink-400">
          <ShieldCheck className="size-4 text-held" aria-hidden />
          Escrow-backed payments for the x402 protocol
        </div>

        <h1 className="max-w-3xl text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
          Pay per request, in SOL or USDC, without trusting the seller.
        </h1>

        <p className="max-w-2xl text-sm leading-relaxed text-ink-300">
          Standard x402 settles the moment the request is accepted, which is
          fine until the seller returns nothing. AESDR turns the payment into an
          escrow instead: the money is held by a program-owned vault, and only
          an arbiter verdict moves it. Delivery is proven by a hash, so a
          payload that does not match its own commitment is provable by anyone.
        </p>

        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/buyer"
            className="flex items-center gap-2 rounded-lg bg-held px-4 py-2.5 text-sm font-medium text-ink-950 hover:opacity-90"
          >
            <Bot className="size-4" aria-hidden />
            Try the buyer
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
          <Link
            href="/arbiter"
            className="flex items-center gap-2 rounded-lg border border-ink-700 px-4 py-2.5 text-sm hover:border-ink-600"
          >
            <Gavel className="size-4" aria-hidden />
            Open the arbiter console
          </Link>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {FLOW.map((step, index) => {
          const Icon = step.icon;
          return (
            <div key={step.title} className="card p-5">
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-ink-800 p-2">
                  <Icon className="size-4 text-held" aria-hidden />
                </span>
                <span className="tabular text-xs text-ink-400">
                  0{index + 1}
                </span>
              </div>
              <h2 className="mt-3 text-sm font-semibold">{step.title}</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
                {step.body}
              </p>
            </div>
          );
        })}
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-semibold">What makes breach provable</h2>
        <ul className="mt-3 flex flex-col gap-2.5 text-xs leading-relaxed text-ink-300">
          <li className="flex gap-2">
            <span className="tabular shrink-0 text-held">hash</span>
            The seller commits to SHA-256 of the exact bytes it sent. A swapped
            or truncated body cannot match its own commitment.
          </li>
          <li className="flex gap-2">
            <span className="tabular shrink-0 text-held">length</span>A
            structurally valid but substantively empty payload passes schema and
            fails length, which catches a seller that signs garbage.
          </li>
          <li className="flex gap-2">
            <span className="tabular shrink-0 text-held">bond</span>
            The seller posts collateral in lamports. A proven breach refunds the
            buyer and slashes 10% of that bond.
          </li>
        </ul>
      </section>
    </div>
  );
}
