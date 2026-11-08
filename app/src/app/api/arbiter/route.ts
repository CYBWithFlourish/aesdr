/**
 * Arbiter console API: inspect and settle.
 *
 * GET lists the sessions the seller knows about, joined with live chain state.
 * POST runs the deterministic verdict and, if told to, settles it. Keeping the
 * verdict in `@aesdr/sdk` means the API cannot disagree with the tests.
 */
import { NextResponse, type NextRequest } from "next/server";

import { EscrowState, evaluate, sha256Hex } from "@aesdr/sdk";

import { PAYLOAD_SHAPE } from "@/lib/config";
import { aesdr, roleSigner } from "@/lib/solana";
import { listSessions } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const sessions = listSessions();

  const rows = await Promise.all(
    sessions.map(async (session) => {
      // The escrow address only exists once a buyer has paid, so an unpaid
      // session is reported as such rather than probed at a guessed address.
      const escrow = session.paid?.escrow;
      const view = escrow
        ? await aesdr()
            .read(escrow)
            .catch(() => null)
        : null;

      return {
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        // Defensive: Next's dev hot-reload can keep this module's in-memory map
        // alive across a code change, so a pre-upgrade session with the old
        // single-`amount` shape can still be in there. Reporting zeros beats a
        // 500 that takes the whole console down.
        prices: {
          spl: String(session.prices?.spl ?? 0n),
          lamports: String(session.prices?.lamports ?? 0n),
        },
        mint: session.mint ?? null,
        inputPreview: session.input.slice(0, 120),
        // `amount` is a bigint and `JSON.stringify` throws on those, so every
        // bigint leaves this route as a string. Spreading `session.paid` here
        // is what produced an empty 500 on the live deployment: the session
        // list only worked while no session had been paid yet.
        paid: session.paid
          ? {
              buyer: session.paid.buyer,
              txSignature: session.paid.txSignature,
              escrow: session.paid.escrow,
              asset: session.paid.asset,
              amount: String(session.paid.amount),
              at: session.paid.at,
            }
          : null,
        delivery: session.delivery
          ? {
              payloadHash: session.delivery.payloadHash,
              model: session.delivery.model,
              at: session.delivery.at,
              body: session.delivery.body,
            }
          : null,
        escrow: view
          ? {
              address: view.address,
              state: view.state,
              stateLabel: view.stateLabel,
              amount: String(view.amount),
              asset: view.asset,
              mint: view.mint,
              buyer: view.buyer,
              seller: view.seller,
              deadline: view.deadline,
              reclaimable: view.reclaimable,
            }
          : null,
      };
    })
  );

  return NextResponse.json({ sessions: rows });
}
type SettleBody = {
  escrow?: unknown;
  /** Run the verdict and settle in one call. Omit to only inspect. */
  settle?: unknown;
  /** For dispute replay: the body the buyer says it received. */
  body?: unknown;
  /** The hash the seller committed to in the delivery header. */
  expectedHash?: unknown;
  httpStatus?: unknown;
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: SettleBody;
  try {
    body = (await request.json()) as SettleBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const escrowAddress = typeof body.escrow === "string" ? body.escrow : "";
  if (!escrowAddress) {
    return NextResponse.json({ error: "escrow_required" }, { status: 400 });
  }

  const view = await aesdr().read(escrowAddress as never);
  if (!view) {
    return NextResponse.json({ error: "escrow_not_found" }, { status: 404 });
  }

  if (view.state !== EscrowState.Open) {
    return NextResponse.json(
      {
        error: "already_settled",
        state: view.stateLabel,
      },
      { status: 409 }
    );
  }

  // The verdict only makes sense against a delivery, so a request that supplies
  // one runs the five checks. Without one, the caller is just inspecting.
  const verdict =
    typeof body.body === "string"
      ? await evaluate({
          httpStatus:
            typeof body.httpStatus === "number" ? body.httpStatus : 200,
          body: body.body,
          expectedHash:
            typeof body.expectedHash === "string"
              ? body.expectedHash
              : undefined,
          requiredKeys: [...PAYLOAD_SHAPE.requiredKeys],
          textKey: PAYLOAD_SHAPE.textKey,
          minLength: PAYLOAD_SHAPE.minLength,
        })
      : null;

  if (body.settle !== true) {
    return NextResponse.json({
      escrow: { address: view.address, state: view.stateLabel },
      verdict,
      payloadHash: verdict?.payloadHash ?? (await sha256Hex("")),
    });
  }

  const arbiter = await roleSigner("arbiter");

  // A PASS releases; anything else refunds and slashes. This mapping is the
  // whole arbitration policy, and it is one line on purpose.
  const signature =
    verdict?.outcome === "PASS"
      ? await aesdr().release({ arbiter, escrow: view.address })
      : await aesdr().refund({ arbiter, escrow: view.address });

  return NextResponse.json({
    outcome: verdict?.outcome ?? "BREACH",
    // A PASS has no reason; a BREACH with no verdict means nothing was
    // delivered, which is a different story from a delivered-but-bad payload.
    reason: verdict ? verdict.reason : "no_delivery",
    signature,
    escrow: view.address,
  });
}
