"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Gavel, ShieldCheck, Store, type LucideIcon } from "lucide-react";

import { WalletButton } from "./wallet-button";

type Tab = { href: string; label: string; icon: LucideIcon; hint: string };

const TABS: Tab[] = [
  { href: "/seller", label: "Seller", icon: Store, hint: "Bond and pricing" },
  { href: "/buyer", label: "Buyer", icon: Bot, hint: "Pay per request" },
  {
    href: "/arbiter",
    label: "Arbiter",
    icon: Gavel,
    hint: "Verdict and settle",
  },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="flex flex-wrap items-center gap-4">
      <Link href="/" className="flex items-center gap-2">
        <ShieldCheck className="size-6 text-held" aria-hidden />
        <span className="text-lg font-semibold tracking-tight">AESDR</span>
        <span className="hidden text-xs text-ink-400 sm:inline">
          escrow-backed x402
        </span>
      </Link>

      <nav className="flex flex-1 flex-wrap items-center gap-1">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              title={tab.hint}
              className={[
                "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-ink-800 text-ink-100"
                  : "text-ink-300 hover:bg-ink-850 hover:text-ink-100",
              ].join(" ")}
            >
              <Icon className="size-4" aria-hidden />
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <WalletButton />
    </header>
  );
}
