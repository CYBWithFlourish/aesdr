"use client";

/**
 * Wallet connect control.
 *
 * `useSelectedWalletAccount` is a tuple of the selected account plus a setter.
 * Connecting is delegated to the wallet itself, so this component never touches
 * keys: it asks, and the wallet renders its own prompt.
 */
import { useState } from "react";
import { useSelectedWalletAccount } from "@solana/react";
import { useConnect, useWallets } from "@wallet-standard/react";
import type { UiWallet, UiWalletAccount } from "@wallet-standard/react";
import { Check, ChevronDown, LogOut, Wallet } from "lucide-react";

import { truncateAddress } from "@/lib/format";

export function WalletButton() {
  const [open, setOpen] = useState(false);
  const wallets = useWallets();
  const [account, setAccount] = useSelectedWalletAccount();

  if (account) {
    return (
      <ConnectedPill
        address={account.address}
        onDisconnect={() => setAccount(undefined)}
      />
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100 hover:border-ink-600"
      >
        <Wallet className="size-4" aria-hidden />
        Connect wallet
        <ChevronDown className="size-3.5 text-ink-400" aria-hidden />
      </button>

      {open && (
        <div className="card absolute right-0 z-20 mt-2 w-64 p-1.5 shadow-2xl">
          {wallets.length === 0 && (
            <p className="px-3 py-2 text-xs leading-relaxed text-ink-400">
              No Solana wallet found. Install Phantom, Solflare or Backpack,
              then reload.
            </p>
          )}

          {wallets.map((candidate) => (
            <WalletRow
              key={candidate.name}
              wallet={candidate}
              onAccount={(picked) => {
                setAccount(picked);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WalletRow({
  wallet,
  onAccount,
}: {
  wallet: UiWallet;
  onAccount: (account: UiWalletAccount) => void;
}) {
  const [isConnecting, connect] = useConnect(wallet);

  return (
    <button
      type="button"
      disabled={isConnecting}
      onClick={async () => {
        const accounts = await connect();
        const first = accounts[0];
        if (first) onAccount(first);
      }}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-ink-100 hover:bg-ink-800 disabled:opacity-50"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={wallet.icon} alt="" className="size-5 rounded" />
      <span className="flex-1">{wallet.name}</span>
      {isConnecting && <span className="text-xs text-ink-400">...</span>}
    </button>
  );
}

function ConnectedPill({
  address,
  onDisconnect,
}: {
  address: string;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm hover:border-ink-600"
      >
        <Check className="size-4 text-pass" aria-hidden />
        <span className="tabular text-xs text-ink-300" title={address}>
          {truncateAddress(address)}
        </span>
      </button>

      {open && (
        <div className="card absolute right-0 z-20 mt-2 w-56 p-1.5 shadow-2xl">
          <p className="tabular break-all px-2.5 py-1.5 text-[11px] text-ink-300">
            {address}
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onDisconnect();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-breach hover:bg-ink-800"
          >
            <LogOut className="size-4" aria-hidden />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
