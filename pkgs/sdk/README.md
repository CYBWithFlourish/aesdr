# @aesdr/sdk

Escrow-backed settlement for x402 machine payments.

x402 standardises the handshake - `402 Payment Required`, an `X-PAYMENT` retry
header, a verify/settle facilitator split. The only scheme in production,
`exact`, is a single terminal transfer: the seller is paid whether or not the
payload was worth anything.

This package adds a scheme where payment is **conditional on delivery**, and a
buyer always keeps a unilateral exit.

## Install

```bash
npm install @aesdr/sdk @solana/kit
```

`@solana/kit` is the only Solana client dependency. `@solana/web3.js` v1 is in
maintenance mode and is not used here; `@solana/web3.js` v3 is a class-based
facade over Kit internals, so mixing it in is only worth it if you already have
v3-style code to keep.

## Seller: charge for an endpoint

```ts
import { createSolanaRpc } from "@solana/kit";
import { Aesdr, AESDR_PROGRAM_ADDRESS, buildChallenge, decodePayment, newSessionId } from "@aesdr/sdk";

const aesdr = new Aesdr({ rpc: createSolanaRpc(RPC_URL) });    // read-only is enough to verify

// 1. Unauthenticated request -> 402
if (!req.headers["x-payment"]) {
  return res.status(402).json(buildChallenge({
    network: "solana-devnet",
    maxAmountRequired: 10_000_000n,               // 0.01 SOL, in lamports
    payTo: sellerAddress,
    resource: "/api/summarize",
    programId: AESDR_PROGRAM_ADDRESS,
    arbiter: ARBITER_ADDRESS,
    minBond: 20_000_000n,
    deadlineSeconds: 300,
    sessionId: newSessionId(),
  }));
}

// 2. Retry -> verify the lock, then serve
const payment = decodePayment(req.headers["x-payment"]);
const { valid, reason } = await aesdr.verifyLock({
  txSignature: payment.payload.txSignature,
  sessionId: hexDecode(payment.payload.sessionId),
  buyer: payment.payload.buyer,                   // already an Address string
  seller: SELLER_ADDRESS,
  expectedAmount: 10_000_000n,
});
if (!valid) return res.status(402).json({ error: reason });
```

`verifyLock` derives the escrow address from buyer + seller + session id, so a
buyer cannot point you at an unrelated escrow, and you cannot be tricked into
delivering against an account you did not expect.

## Arbiter: judge and settle

```ts
import { evaluate } from "@aesdr/sdk";

const verdict = await evaluate({
  httpStatus: 200,
  body: rawBody,
  expectedHash: res.headers["x-aesdr-payload-hash"],
  requiredKeys: ["summary"],
});

if (verdict.outcome === "PASS") {
  await aesdr.release({ arbiter, escrow });
} else {
  await aesdr.refund({ arbiter, escrow });    // buyer refunded, bond slashed 10%
}
```

The verdict engine runs five checks in order and short-circuits on the first
failure, so `verdict.reason` tells you exactly why money went back:

| Check | Catches |
| --- | --- |
| `status` | non-2xx |
| `schema` | malformed JSON, missing required keys |
| `hash` | body does not match the seller's own commitment |
| `length` | signed, valid, and substantively empty |
| `quality` | optional caller-supplied predicate, e.g. an LLM judge |

The `length` check is what catches a seller that commits to garbage on purpose -
200 status, valid JSON, matching hash, worthless content. Checks 1-3 all pass and
only `length` fires. That is the demo.

## Trust model

The arbiter is trusted today. It is also exactly the seat where a Groth16
verifier drops in: the program only checks `has_one = arbiter`, so swapping a
keypair signer for a proof check changes one handler, not the escrow model.

What does *not* require trust: after `deadline`, the buyer calls `reclaim()` and
gets the money back with nobody's cooperation. No arbiter, no seller, no
facilitator.

## API

| Method | Signer | Effect |
| --- | --- | --- |
| `postBond({ seller, amount })` | seller | post/top up collateral |
| `bondBalance(seller)` | - | collateral currently locked |
| `lock({ buyer, seller, arbiter, sessionId, amount, minBond, deadlineSeconds })` | buyer | lock funds, return escrow + receipt |
| `read(escrow)` | - | decoded view, or `null` |
| `verifyLock({ txSignature, sessionId, buyer, seller, expectedAmount? })` | - | validate a receipt |
| `release({ arbiter, escrow })` | arbiter | pay seller |
| `refund({ arbiter, escrow })` | arbiter | refund buyer, slash bond |
| `reclaim({ buyer, escrow })` | buyer | escape hatch after deadline |

Lamports are `bigint` everywhere. Nothing is a float.

Program rejections surface the program's own message: `@aesdr/sdk` decodes the
logs Kit hides in the error context, so a caller sees `Seller bond is smaller
than the escrow requires (code 6005)` and can branch on `err.programError`
rather than string-matching `Transaction simulation failed`.
