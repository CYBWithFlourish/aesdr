/**
 * Seller status: who the seller is, what it charges, and whether it can be paid.
 *
 * The UI needs the seller's address and on-chain bond balance before it can
 * show anything honest, and the bond is a chain fact rather than a local one.
 */
import { NextResponse } from "next/server";

import { aesdr, roleSigner } from "@/lib/solana";
import {
  cluster,
  deadlineSeconds,
  minBond,
  networkName,
  priceSol,
  priceUsdc,
  sellerFault,
  usdcMintOrNull,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [seller, arbiter] = await Promise.all([
    roleSigner("seller"),
    roleSigner("arbiter"),
  ]);

  const bond = await aesdr()
    .bondBalance(seller.address)
    .catch(() => 0n);

  const required = minBond();

  return NextResponse.json({
    cluster: cluster(),
    network: networkName(),
    programId: aesdr().address,
    seller: seller.address,
    arbiter: arbiter.address,
    usdcMint: usdcMintOrNull(),
    price: {
      usdc: String(priceUsdc()),
      sol: String(priceSol()),
    },
    bond: {
      balance: String(bond),
      required: String(required),
      sufficient: bond >= required,
    },
    deadlineSeconds: deadlineSeconds(),
    faultInjection: sellerFault(),
  });
}
