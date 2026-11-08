use anchor_lang::prelude::*;

/// Seed prefix for the escrow state account.
/// ["escrow", buyer, seller, session_id]
#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

/// Seed prefix for the lamport-holding vault.
/// ["vault", escrow]
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Seed prefix for the seller's collateral bond.
/// ["bond", seller]
#[constant]
pub const BOND_SEED: &[u8] = b"bond";

/// Escrow is denominated in native lamports (SOL).
pub const ASSET_LAMPORTS: u8 = 0;
/// Escrow is denominated in an SPL token (e.g. USDC).
pub const ASSET_SPL: u8 = 1;

/// Escrow is open, funds are locked and awaiting a verdict.
pub const STATE_OPEN: u8 = 0;
/// Arbiter released the funds to the seller. Terminal.
pub const STATE_RELEASED: u8 = 1;
/// Funds were refunded to the buyer (by verdict or by deadline reclaim). Terminal.
pub const STATE_REFUNDED: u8 = 2;

/// Percentage of the seller bond slashed on a proven breach, in basis points.
pub const SLASH_BPS: u64 = 1_000;

/// Basis point denominator (100%).
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Reserved account space for the buyer to reclaim rent-free state later.
pub const MAX_ESCROW_LIFETIME_SECS: i64 = 86_400;
