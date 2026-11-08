import type { Metadata } from "next";

import "./globals.css";
import { Providers } from "@/components/providers";
import { Nav } from "@/components/nav";

export const metadata: Metadata = {
  title: "AESDR - escrow-backed x402 payments",
  description:
    "Pay per request in SOL or USDC, held in escrow until an arbiter attests delivery.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-full">
        <Providers>
          <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-5 py-6">
            <Nav />
            <main className="flex-1">{children}</main>
            <footer className="border-t border-ink-800 pt-4 text-xs text-ink-400">
              Funds are held by a program-owned vault. Nothing settles until the
              arbiter attests delivery.
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
