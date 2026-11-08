/**
 * The paid endpoint: POST /api/summarize
 *
 * The protocol shape is the point:
 *
 *   1. no `X-PAYMENT`  -> 402 with an x402 challenge quoting SOL and USDC
 *   2. `X-PAYMENT` set -> verify the lock on chain, then do the work
 *   3. response        -> body plus `X-AESDR-Payload-Hash`, the commitment the
 *                         arbiter hashes later to prove what was delivered
 *
 * Note what is *not* here: settlement. A verified lock does not move money, it
 * proves money is being held. Only the arbiter's verdict releases or refunds.
 */
import { NextResponse, type NextRequest } from "next/server";

import { sha256Hex } from "@aesdr/sdk";

import { PAYLOAD_SHAPE, sellerFault } from "@/lib/config";
import { LlmError, summarize } from "@/lib/llm";
import {
  PaymentError,
  paymentResponseHeader,
  quote,
  verifyPayment,
} from "@/lib/payment";
import { getSession, recordDelivery, recordPayment } from "@/lib/sessions";

export const runtime = "nodejs";
/** Chain reads and an LLM call both outlive the default edge budget. */
export const dynamic = "force-dynamic";

type Body = { input?: unknown; asset?: unknown };

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (input.length < 10) {
    return NextResponse.json(
      { error: "input_too_short", detail: "send at least 10 characters" },
      { status: 400 }
    );
  }

  const asset = body.asset === "lamports" ? "lamports" : "spl";
  const header = request.headers.get("x-payment");

  // Step 1: nothing has been paid yet, so quote. The session nonce is created
  // here and travels in `extra`, binding the retry to this exact quote.
  if (!header) {
    const challenge = await quote(input);
    const accepted = challenge.accepts.find(
      (a) => (a.asset === "lamports") === (asset === "lamports")
    );

    return NextResponse.json(challenge, {
      status: 402,
      headers: {
        // x402 clients read the header first and fall back to the body.
        "X-PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString(
          "base64"
        ),
        "cache-control": "no-store",
        ...(accepted ? { "x-aesdr-session": accepted.extra.sessionId } : {}),
      },
    });
  }

  // Step 2: verify. The session must exist, so a header cannot resurrect a
  // quote from a previous process and settle against stale terms.
  const sessionId = request.headers.get("x-aesdr-session");
  const session = sessionId ? getSession(sessionId) : undefined;
  if (!session) {
    return NextResponse.json(
      { error: "unknown_session", detail: "quote again without X-PAYMENT" },
      { status: 409 }
    );
  }

  try {
    const payment = await verifyPayment(header, { session });

    recordPayment(session.sessionId, {
      buyer: payment.buyer,
      txSignature: payment.txSignature,
      escrow: payment.escrow,
      asset: payment.asset,
      amount: payment.amount,
      at: Date.now(),
    });

    // Step 3: deliver. Fault injection is a demo lever, not a feature: it lets
    // the UI show the arbiter catching a bad delivery.
    if (sellerFault() === "error") {
      return NextResponse.json(
        { error: "seller_unavailable" },
        { status: 503 }
      );
    }

    const completion =
      sellerFault() === "empty"
        ? {
            summary: "ok",
            model: "fault-injected",
            body: JSON.stringify({
              summary: "ok",
              model: "fault-injected",
              inputLength: input.length,
            }),
          }
        : await summarize(input);

    const payloadHash = await sha256Hex(completion.body);

    recordDelivery(session.sessionId, {
      body: completion.body,
      payloadHash,
      model: completion.model,
      at: Date.now(),
    });

    return new NextResponse(completion.body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        // The commitment. A body that does not hash to this is a breach,
        // provable by anyone without trusting the seller.
        "X-AESDR-Payload-Hash": payloadHash,
        "X-AESDR-Session": session.sessionId,
        "X-PAYMENT-RESPONSE": paymentResponseHeader(payment),
        "cache-control": "no-store",
        // The arbiter's schema check needs to know what was promised.
        "X-AESDR-Required-Keys": PAYLOAD_SHAPE.requiredKeys.join(","),
      },
    });
  } catch (err) {
    if (err instanceof PaymentError) {
      return NextResponse.json(
        { error: "payment_required", detail: err.message },
        { status: err.status }
      );
    }
    if (err instanceof LlmError) {
      return NextResponse.json(
        { error: "model_error", detail: err.message },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { error: "internal_error", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
