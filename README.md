# AESDR

**Agentic Escrow & Sub-second Dispute Resolution** - the settlement layer x402 assumes you don't need.

[![Solana](https://img.shields.io/badge/Solana-devnet-9945FF)](https://solana.com)
[![Anchor](https://img.shields.io/badge/Anchor-1.2.2-blue)](https://www.anchor-lang.com)
[![Solana Kit](https://img.shields.io/badge/%40solana%2Fkit-8.x-14F195)](https://solana.com/docs/clients/official/javascript)
[![License](https://img.shields.io/badge/license-GPLv3-blue)](LICENSE)

---

## The gap

x402 and MPP standardize the handshake: a seller answers `HTTP 402 Payment Required`, the agent retries with a `X-PAYMENT` header, money moves. They solve **negotiation**.

They do not solve **execution**. The only scheme in production, `exact`, is a single terminal transfer. On Solana that means:

| Problem | Consequence |
| --- | --- |
| Payment is unconditional | Seller is paid whether or not the payload is worth anything |
| No dispute path | An agent that receives garbage has no recourse, ever |
| No counterparty skin in the game | Nothing stops a provider serving cached hallucinations |

An autonomous agent spending fractions of a cent per call cannot file a chargeback. It needs the payment to be **conditional on delivery**, settled by code, within the same session.

AESDR is that condition.

```
   x402 / MPP           →  negotiation      (who owes what)
   AESDR                →  settlement       (does the seller actually get it)
```

---

## How it works

```
   Buyer agent                Seller API                  Solana
        │                         │                         │
        │  1. POST /api/tool      │                         │
        │────────────────────────>│                         │
        │  2. 402 + terms         │                         │
        │<────────────────────────│                         │
        │                                                   │
        │  3. init_escrow  ────────────────────────────────>│  funds → vault PDA
        │                         │                         │  state = OPEN
        │  4. retry + X-PAYMENT   │                         │
        │────────────────────────>│                         │
        │                         │  5. verify escrow ─────>│
        │  6. payload             │                         │
        │<────────────────────────│                         │
        │                                                   │
        │  7. buyer checks payload                          │
        │                                                   │
        │        ┌────────────────┴────────────────┐        │
        │        │                                 │        │
        │     PASS                              BREACH      │
        │        │                                 │        │
        │  8a. release ────────────────────────────────>│  seller paid
        │                                  8b. refund ───>│  buyer refunded
        │                                                   │  bond slashed 10%
        │                                                   │
        │  ⏱ deadline passes with no verdict                │
        │  9. reclaim ──────────────────────────────────>│  buyer refunded
        │                                                   │  (no cooperation needed)
```

The escrow is **never** permanently locked. If the arbiter goes dark, the deadline is a unilateral exit. That is the trust-minimizer, and it is three lines of `require!`.

---

## What is actually on-chain

Three PDAs per session. The split is not cosmetic: a program-owned account cannot be debited by `system_program::transfer`, so lamports must live in a system-owned address that the program signs for.

| Account | Seeds | Owns | Data |
| --- | --- | --- | --- |
| `Escrow` | `["escrow", buyer, seller, session_id]` | the program | 163 bytes |
| `vault` | `["vault", escrow]` | system program | none |
| `bond` | `["bond", seller]` | system program | none |

```rust
pub struct Escrow {
    pub buyer: Pubkey,        // who is paying
    pub seller: Pubkey,       // who is delivering
    pub arbiter: Pubkey,      // who judges - the future ZK verifier seat
    pub session_id: [u8; 32], // client nonce, one escrow per request
    pub amount: u64,          // lamports locked in the vault
    pub min_bond: u64,        // collateral this seller had to post
    pub deadline: i64,        // unix ts; after this the buyer exits alone
    pub state: u8,            // 0 OPEN · 1 RELEASED · 2 REFUNDED
    pub vault_bump: u8,       // cached so settlement re-derives nothing
}
```

### Instructions

| Instruction | Signer | Effect |
| --- | --- | --- |
| `post_bond(amount)` | seller | Top up collateral. Once per seller before being payable. |
| `init_escrow(session_id, amount, min_bond, deadline)` | buyer | Asserts bond covers `min_bond`, then locks `amount` in the vault. |
| `release()` | arbiter | Vault → seller. `state = RELEASED`. |
| `refund()` | arbiter | Vault → buyer **+ 10% of bond → buyer**. `state = REFUNDED`. |
| `reclaim()` | buyer | Requires `clock >= deadline`. Vault → buyer, no slash. |

Every instruction rejects a non-`OPEN` escrow, so replaying a settlement signature is a hard error rather than a double spend.

Events (`EscrowOpened`, `EscrowReleased`, `EscrowRefunded`, `BondPosted`) let a UI rebuild the timeline with no indexer.

---

## The x402 surface

AESDR is transport-compatible but ships **its own scheme**, because `exact` has nowhere to express "hold this until I check."

**Challenge**

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "aesdr-escrow",
    "network": "solana-devnet",
    "maxAmountRequired": "10000000",
    "payTo": "VAULT_PDA",
    "resource": "/api/tool/run",
    "description": "Summarize text - 0.01 SOL, refundable on breach",
    "extra": {
      "programId": "82Tq33Ekqk1TYrruXgpiPtLgoTM2Fjo8VEmpkzcF4BTD",
      "arbiter": "...", "minBond": "20000000",
      "deadlineSeconds": 300, "sessionId": "..."
    }
  }]
}
```

**Retry**

```
X-PAYMENT: base64({ x402Version, scheme: "aesdr-escrow", network,
                    payload: { txSignature, sessionId, buyer } })
```

`payload` is opaque to x402 by design; the spec never promises a facilitator can read it. Verification is `getTransaction(txSignature)` → escrow exists, amount matches, session matches. Settlement happens on the arbiter's verdict, not on the buyer's retry.

> **Claim discipline:** this is *x402-transport-compatible*, not "settles on a stock facilitator." The `exact` scheme has no refund path; that absence is the whole product.

---

## Trust model

| Path | Who decides | Trust required |
| --- | --- | --- |
| Happy path | Arbiter attests delivery | trusted arbiter |
| Breach | Arbiter attests breach | trusted arbiter |
| **Arbiter offline / malicious** | `deadline` passes, buyer calls `reclaim` | **none** |

The arbiter is trusted *today*. It is also exactly the seat where a Groth16 verifier drops in: the program only checks `has_one = arbiter`, so swapping a keypair signer for a proof check is a change to one handler, not to the escrow model.

---

## Quick start

```bash
# toolchain: rust 1.89+, anchor 1.2.2, solana 3.x, node 24
npm install
anchor build          # compiles the program and emits target/idl/aesdr.json
npm run codegen       # generates the Kit client from that IDL
npm test              # 34 tests, local validator
```

`npm test` boots a throwaway `solana-test-validator` with the program preloaded,
runs the suite against it, and tears it down. It does not use `anchor test`,
which would reintroduce web3.js v1.

Deploy:

```bash
solana config set --url devnet
solana airdrop 5
anchor deploy
```

The program ID lives in three places and they must agree:
`declare_id!` in `lib.rs`, `[programs.devnet]` in `Anchor.toml`, and `target/deploy/aesdr-keypair.json`.
`anchor keys sync` fixes all three at once. After changing it, rerun
`npm run codegen` so the generated client points at the new address.

### Running the app locally, end to end

One-time build first: the program `.so` and the package dists are both inputs.

```bash
anchor build && npm run build
```

Then the numbered path. Steps 1, 3 and 5 are long-running processes; keep each in
its own terminal.

**1. Start a validator with the program preloaded**

```bash
solana-test-validator --reset \
  --bpf-program "$(node -e "console.log(require('./target/idl/aesdr.json').address)")" \
  target/deploy/aesdr.so
```

`--reset` wipes balances, bonds and the local mint, so re-run step 4 after it.
Key files survive.

**2. Fund the payer**

```bash
solana -u http://127.0.0.1:8899 airdrop 10
```

**3. Configure and boot the app**

```bash
cp app/.env.example app/.env.local     # then set OPENAI_API_KEY
npm install
npm run dev                            # http://localhost:3000
```

Open the app once so it generates `app/.keys/seller.json` and
`app/.keys/arbiter.json`. Those files are never overwritten: the addresses are
baked into every escrow opened against them, so replacing one would make its
history unsettleable. Rotate on purpose with `npm run setup:demo:rotate`.

**4. Fund the roles, post the bond, create the local USDC mint**

```bash
npm run setup:demo
```

Expected output includes `created mint <addr>` and
`wrote USDC_MINT=<addr> to app/.env.local`.

Two things make this step matter more than it looks:

- The mint is created against the **legacy** token program. `spl-token` 5.5
  defaults to Token-2022, and the escrow program uses the legacy one, so a
  2022 mint fails ATA creation with `IncorrectProgramId`. `scripts/local-usdc.mts`
  passes the program id explicitly.
- It records the mint in `app/.env.local`, which is the only reason the app can
  quote a token that exists on this validator.

**5. Restart `npm run dev`**

Next reads env at boot, so the running server will not see `USDC_MINT`. Skip
this and the app falls back to the devnet Circle mint, which this validator has
never seen - the same `IncorrectProgramId` by a different route.

**6. Run both payment paths headlessly**

```bash
npm run e2e:sol    # native SOL -> amount: 10000000 (lamports)
npm run e2e        # USDC       -> amount: 250000 (local mint)
```

Both must pass. A SOL run that prints `amount: 10000000 (lamports)` and then
`HTTP 200` at the retry is the proof that the price is checked against the
currency actually locked, not against a single remembered amount.

**7. Open the UI** at `http://127.0.0.1:3000`.

### Testing without a wallet

The wallet is only the buyer's signing key, so a keypair plays the same role.
`scripts/e2e-local.mts` runs the entire flow headless: request a 402, lock funds
in escrow, retry with `X-PAYMENT`, run the verdict, settle.

Each run prints five stages. Read them as a check that the escrow is doing real
work, not just returning 200:

| Stage | What proves it worked |
| --- | --- |
| 1. quote | `HTTP 402`, plus the session id and the amount in the right unit |
| 2. lock | an escrow address and a transaction signature |
| 3. retry | `HTTP 200` and an `x-aesdr-payload-hash` header |
| 4. verdict | an outcome and a reason |
| 5. settle | the outcome, and a signature you can look up |

Run it while the app is up and watch the browser. Open `/arbiter` in another tab
and hit refresh: the session appears as it is quoted, then as the escrow opens,
then as it settles. Every step the script prints is a chain transaction you can
see reflected in the UI.

Set `AESDR_BUYER_KEY` to use a different buyer, or `SELLER_FAULT=empty` in
`app/.env.local` and restart to watch the seller breach and the arbiter refund
instead of release.

### When a step fails

| Symptom | Cause |
| --- | --- |
| `IncorrectProgramId` at lock | The quoted mint is Token-2022 or a devnet address. Re-run step 4 and restart. |
| `USDC_MINT is not set` | Step 5 was skipped; the server booted before the env was written. |
| `locked N base units, expected M` | Amount and currency disagree. Should be unreachable now: the asset is read off chain before the price is chosen. |
| `no validator at ...` | Step 1 is not up yet, or it exited. |
| `start the app once so it generates ...` | Step 4 ran before step 3 ever served a request. |

---

## Client stack

The JavaScript client targets **`@solana/kit`**, Solana's recommended SDK.
`@solana/web3.js` v1 is in maintenance mode and is not a dependency of this repo.

`pkgs/client/src/generated` is produced by **Codama** from the Anchor IDL, so the
instruction encoders, account decoders, PDA derivations and error codes can never
drift from the program. Do not edit that tree by hand - change the program and
rerun `npm run codegen`.

| Package | Responsibility |
| --- | --- |
| `@aesdr/client` | Generated Kit bindings (instructions, PDAs, accounts, errors) + `EscrowState` |
| `@aesdr/sdk` | x402 wire format, escrow lifecycle, `verifyLock`, verdict engine, error decoding |

```ts
import { createSolanaRpc } from "@solana/kit";
import { Aesdr, sol } from "@aesdr/sdk";

const aesdr = new Aesdr({ rpc: createSolanaRpc("https://api.devnet.solana.com") });

const { escrow, signature } = await aesdr.lock({
  buyer, seller: sellerAddress, arbiter: arbiterAddress,
  sessionId, amount: sol(0.01), minBond: sol(0.02), deadlineSeconds: 300,
});

// The seller verifies against a *derived* address, not one the buyer supplied.
const check = await aesdr.verifyLock({ txSignature: signature, sessionId, buyer: buyer.address, seller: sellerAddress });
```

Notes from building against Kit:

- Amounts are `bigint` and branded (`Lamports`, `UnixTimestamp`); the compiler
  rejects a bare `number` where lamports are expected.
- Kit reports a program rejection as a generic preflight failure and hides the
  logs in `context`. `@aesdr/sdk` decodes them, so callers see
  `Seller bond is smaller than the escrow requires (code 6005)` and can branch on
  `err.programError`.
- Confirmation is polled rather than subscribed, because a seller's server
  process should not need to hold a websocket open.

---

## Tests

```
aesdr program                 8 passing   lamport deltas, vault drain, slashing, deadline exit
aesdr program (via sdk)       8 passing   same flow through @aesdr/sdk
sdk: verifyLock               2 passing   derived-address verification, wrong price/session
error decoding                4 passing   program errors surfaced, transport errors untouched
x402 wire format              4 passing   header round trip, unknown scheme rejected
verdict engine                8 passing   status, schema, hash, length, quality
                              ----------
                              34 passing
```

The suite asserts lamport deltas, not just return codes - a passing `release` that moves nothing would fail.

Two behaviours worth knowing, both discovered by the tests:

- A vault drained to zero lamports is **purged by the runtime** at the end of the transaction. Reading it afterwards yields nothing, not a zero-balance account.
- `solana-test-validator` does not produce idle slots, so its `Clock` freezes between transactions. Any deadline test must nudge the chain forward; see `waitForChainTime` in `tests/aesdr.ts`.
- When the buyer signs `reclaim`, it also pays the fee, so its net delta is the escrowed amount minus the fee. The test reads the actual fee from the transaction rather than assuming a tolerance.

---

## Scope

This is the 12-hour build, deliberately. What is real and what is deferred:

| Component | Status |
| --- | --- |
| Escrow, vault, bond, slashing, deadline exit | **on-chain, tested** |
| x402 402-challenge and `X-PAYMENT` round trip | **implemented** |
| Arbiter settlement service | **implemented** |
| Deterministic verdict checks (status, schema, hash, length) | **implemented** |
| MagicBlock Ephemeral Rollups (sub-10ms streaming) | roadmap - replaced by a single lock + single settle |
| xark BN254 Groth16 dispute proofs | roadmap - replaced by the arbiter keypair |
| Multi-LLM TEE jury for subjective disputes | roadmap |
| Turnkey / Openfort MPC agent wallets | roadmap - plain keypair |

Cutting the ZK path does not weaken the escrow. It replaces one trusted party (a circuit) with another (a service), and keeps the property that matters: **the buyer can always get its money back without anyone's permission.**

---

## Layout

```
programs/aesdr/src/
├── lib.rs                  entrypoints
├── constants.rs            seeds, states, slash basis points
├── error.rs                typed errors
├── state.rs                Escrow + 4 events
├── utils.rs                PDA transfer, signing seeds, slash math
└── instructions/
    ├── post_bond.rs
    ├── init_escrow.rs
    ├── release.rs
    ├── refund.rs
    └── reclaim.rs

pkgs/client/                Codama-generated Kit bindings
pkgs/sdk/                   escrow client, x402 wire format, verdict engine
app/                        Next.js 16 consoles and the paid API
├── src/app/api/summarize/  the 402 endpoint, seller + arbiter in one route
├── src/app/api/seller/     seller status and bond balance
├── src/app/api/arbiter/    session list, verdict, settle
├── src/app/seller/         seller console
├── src/app/buyer/          buyer console, wallet-signed lock
└── src/app/arbiter/        verdict and settlement console
```

## License

GNU General Public License v3.0 - see [LICENSE](LICENSE).

GPLv3 is copyleft: anyone distributing a derivative of this protocol must
release their source under the same terms. That is deliberate for a settlement
layer - an escrow program whose behaviour a counterparty cannot audit is worse
than no escrow program at all.
