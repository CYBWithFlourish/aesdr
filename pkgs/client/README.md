# @aesdr/client

Kit bindings for the AESDR escrow program. No opinions - just instructions,
PDAs, account decoders, error codes, and the program address.

Most people want [`@aesdr/sdk`](../sdk), which wraps this with the escrow
lifecycle, the x402 wire format, and the verdict engine.

## What's here

Everything in `src/generated` is produced by Codama from the Anchor IDL. Do not
edit it by hand: change the program and run `npm run codegen`.

| Export | Purpose |
| --- | --- |
| `AESDR_PROGRAM_ADDRESS` | The program address, taken from the IDL |
| `findEscrowPda`, `findVaultPda`, `findBondPda` | PDA derivation, matching the program's seeds |
| `getInitEscrowInstructionAsync` and friends | Typed instruction builders |
| `getEscrowDecoder`, `fetchEscrow` | Account decoding |
| `AESDR_ERROR__*`, `getAesdrErrorMessage` | Program error codes as constants |
| `EscrowState`, `STATE_LABEL` | The `u8` state field as an enum and a label |
| `SLASH_BPS`, `BPS_DENOMINATOR`, `SEEDS` | Program constants, for readers |

## Usage

```ts
import { createSolanaRpc } from "@solana/kit";
import { findEscrowPda, getEscrowDecoder, getInitEscrowInstructionAsync } from "@aesdr/client";

const [escrow] = await findEscrowPda({ buyer, seller, sessionId });

const instruction = await getInitEscrowInstructionAsync({
  buyer, seller, arbiter, sessionId,
  amount: 10_000_000n,
  minBond: 20_000_000n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
});
```

The generated builders take a signer for `buyer`, `seller` or `arbiter` and
resolve `escrow`, `vault`, `bond` and the system program themselves, so only the
accounts a caller actually knows need passing.

## Two things worth knowing

**Amounts are `bigint`, and branded.** Kit types lamports as `Lamports` and
timestamps as `UnixTimestamp`. Passing a bare `number` where lamports are
expected is a compile error, which is the point - it catches a `0.01` that
somebody meant as one cent but wrote as lamports.

**Account fields are snake_case in the IDL, but decoded values are typed.** The
decoder returns `sessionId` (camelCase) typed as `ReadonlyUint8Array`. Convert to
hex at the edge if you need a string; `@aesdr/sdk` does this in `read()`.
