# AESDR

**Agentic Escrow & Sub-second Dispute Resolution** - the settlement layer x402 assumes you don't need.

[![Solana](https://img.shields.io/badge/Solana-devnet-9945FF)](https://solana.com)
[![Anchor](https://img.shields.io/badge/Anchor-1.2.2-blue)](https://www.anchor-lang.com)
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
anchor build
anchor test          # 8 tests, local validator
```

Deploy:

```bash
solana config set --url devnet
solana airdrop 5
anchor deploy
```

The program ID lives in three places and they must agree:
`declare_id!` in `lib.rs`, `[programs.devnet]` in `Anchor.toml`, and `target/deploy/aesdr-keypair.json`.
`anchor keys sync` fixes all three at once.

---

## Tests

```
✔ seller posts a collateral bond
✔ rejects an escrow the bond cannot cover
✔ happy path: lock, verdict, release
✔ rejects a second release on the same escrow
✔ breach path: refund the buyer and slash 10% of the bond
✔ rejects a verdict from anyone but the arbiter
✔ buyer cannot reclaim before the deadline
✔ buyer reclaims unilaterally after the deadline, with no bond slash
```

The suite asserts lamport deltas, not just return codes - a passing `release` that moves nothing would fail.

Two behaviours worth knowing, both discovered by the tests:

- A vault drained to zero lamports is **purged by the runtime** at the end of the transaction. Reading it afterwards yields `null`, not a zero-balance account.
- `solana-test-validator` does not produce idle slots, so its `Clock` freezes between transactions. Any deadline test must nudge the chain forward; see `waitForChainTime` in `tests/aesdr.ts`.

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
├── error.rs                11 typed errors
├── state.rs                Escrow + 4 events
├── utils.rs                PDA transfer, signing seeds, slash math
└── instructions/
    ├── post_bond.rs
    ├── init_escrow.rs
    ├── release.rs
    ├── refund.rs
    └── reclaim.rs
```

## License

GNU General Public License v3.0 - see [LICENSE](LICENSE).

GPLv3 is copyleft: anyone distributing a derivative of this protocol must
release their source under the same terms. That is deliberate for a settlement
layer - an escrow program whose behaviour a counterparty cannot audit is worse
than no escrow program at all.
