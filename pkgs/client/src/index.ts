/**
 * @aesdr/client - Kit bindings for the AESDR escrow program.
 *
 * The `generated/` tree is produced by Codama from the Anchor IDL and is the
 * single source of truth for instruction encoders, account decoders, PDA
 * derivations and error codes. Everything exported from here is either
 * generated or a small hand-written addition on top of it.
 *
 * Regenerate with `npm run codegen` after changing the program.
 */
export * from "./generated";
export {
  BPS_DENOMINATOR,
  EscrowState,
  SEEDS,
  SLASH_BPS,
  STATE_LABEL,
} from "./state";
