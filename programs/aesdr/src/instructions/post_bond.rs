use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::{constants::*, error::AesdrError, state::BondPosted};

#[derive(Accounts)]
pub struct PostBond<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    /// Collateral vault. System-owned, zero data, holds lamports only.
    #[account(
        mut,
        seeds = [BOND_SEED, seller.key().as_ref()],
        bump,
    )]
    pub bond: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Lock seller collateral. Required once before any escrow can reference
/// this seller. Repeatable: subsequent calls top the bond up.
pub fn handle_post_bond(ctx: Context<PostBond>, amount: u64) -> Result<()> {
    require!(amount > 0, AesdrError::InvalidAmount);

    let before = ctx.accounts.bond.lamports();

    system_program::transfer(
        CpiContext::new(
            system_program::ID,
            system_program::Transfer {
                from: ctx.accounts.seller.to_account_info(),
                to: ctx.accounts.bond.to_account_info(),
            },
        ),
        amount,
    )?;

    let total = before.checked_add(amount).ok_or(AesdrError::Overflow)?;

    emit!(BondPosted {
        seller: ctx.accounts.seller.key(),
        bond: ctx.accounts.bond.key(),
        amount,
        total,
    });

    Ok(())
}
