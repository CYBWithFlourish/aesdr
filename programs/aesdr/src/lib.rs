pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;
pub mod utils;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("82Tq33Ekqk1TYrruXgpiPtLgoTM2Fjo8VEmpkzcF4BTD");

/// AESDR - Agentic Escrow & Sub-second Dispute Resolution.
///
/// The escrow mechanism x402 leaves out: a seller may only be paid once an
/// arbiter attests to delivery, and the buyer always has a unilateral exit
/// after the deadline.
#[program]
pub mod aesdr {
    use super::*;

    /// Seller collateral. Required once before a seller can be paid.
    pub fn post_bond(ctx: Context<PostBond>, amount: u64) -> Result<()> {
        instructions::post_bond::handle_post_bond(ctx, amount)
    }

    /// Buyer locks funds into a vault for one paid session.
    ///
    /// `asset` is 0 for SOL (lamports) or 1 for an SPL token. SPL escrows also
    /// need the mint, the buyer's source account and the vault ATA.
    pub fn init_escrow(
        ctx: Context<InitEscrow>,
        session_id: [u8; 32],
        asset: u8,
        amount: u64,
        min_bond: u64,
        deadline: i64,
    ) -> Result<()> {
        instructions::init_escrow::handle_init_escrow(
            ctx, session_id, asset, amount, min_bond, deadline,
        )
    }

    /// Arbiter verdict: delivery confirmed, pay the seller.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        instructions::release::handle_release(ctx)
    }

    /// Arbiter verdict: breach proven, refund the buyer and slash the bond.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        instructions::refund::handle_refund(ctx)
    }

    /// Buyer exit after the deadline, requires nobody's cooperation.
    pub fn reclaim(ctx: Context<Reclaim>) -> Result<()> {
        instructions::reclaim::handle_reclaim(ctx)
    }
}
