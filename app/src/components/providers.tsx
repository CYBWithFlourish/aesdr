"use client";

/**
 * Client providers.
 *
 * Kit publishes the RPC through `ClientProvider`, and wallet-standard supplies
 * the account. Both are needed before any page can read or sign, so they mount
 * once at the root rather than per page.
 *
 * Wallet discovery needs no adapter list: `@wallet-standard/react` reads
 * `window.navigator.wallets`, so anything installed is offered automatically.
 *
 * The selected-account key lives in `sessionStorage`: a reload keeps the wallet
 * connected, a new tab starts clean, which is what a demo wants.
 */
import { useState } from "react";
import {
  ClientProvider,
  SelectedWalletAccountContextProvider,
} from "@solana/react";
import { createClient, createSolanaRpc } from "@solana/kit";
import { rpcConnection } from "@solana/kit-plugin-rpc";
import type { UiWallet } from "@wallet-standard/react";

import { rpcUrl } from "@/lib/config";

const STORAGE_KEY = "aesdr.selectedWalletAccount";

/**
 * Sync the selected account to session storage.
 *
 * Module scope so the identity is stable: the provider re-syncs when
 * `stateSync` changes identity, and an inline object would do that every render.
 */
const stateSync = {
  getSelectedWallet: () =>
    typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem(STORAGE_KEY),
  storeSelectedWallet: (accountKey: string) => {
    window.sessionStorage.setItem(STORAGE_KEY, accountKey);
  },
  deleteSelectedWallet: () => {
    window.sessionStorage.removeItem(STORAGE_KEY);
  },
};

/** Every wallet is offered; filtering is a product decision this demo does not make. */
const filterWallets = (_wallet: UiWallet) => true;

function KitProvider({ children }: { children: React.ReactNode }) {
  // One client for the life of the tab. Injecting the RPC directly is all the
  // UI needs; no plugin adds behaviour that would go unused.
  const [client] = useState(() => {
    const rpc = createSolanaRpc(rpcUrl());
    return createClient().use(rpcConnection(rpc));
  });

  return <ClientProvider client={client}>{children}</ClientProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <KitProvider>
      <SelectedWalletAccountContextProvider
        filterWallets={filterWallets}
        stateSync={stateSync}
      >
        {children}
      </SelectedWalletAccountContextProvider>
    </KitProvider>
  );
}
