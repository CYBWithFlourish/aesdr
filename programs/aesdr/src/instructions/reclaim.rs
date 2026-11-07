use anchor_lang::prelude::*;

use crate::constants::{STATE_REFUNDED, VAULT_SEED};
use crate::error::AesdrError;
use crate::state::{Escrow, EscrowRefunded};
use crate::utils::{transfer_from_pda, vault_seeds};

#[derive(Accounts)]
pub struct Reclaim<'info> {
    /// Must match `escrow.buyer`. The liveness escape hatch.
    /// Writable: this is the account that receives the refund.
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, has_one = buyer @ AesdrError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,

    /// CHECK: validated by escrow seeds.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Trust-minimizing exit: after the deadline the buyer needs nobody's
/// cooperation to get the money back. No bond slash — this is not a verdict.
pub fn handle_reclaim(ctx: Context<Reclaim>) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    require!(escrow.is_open(), AesdrError::EscrowNotOpen);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= escrow.deadline, AesdrError::DeadlineNotReached);

    let amount = escrow.amount;
    let escrow_key = escrow.key();
    let buyer_key = escrow.buyer;
    let vault_bump = [escrow.vault_bump];

    transfer_from_pda(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.buyer.to_account_info(),
        &vault_seeds(&escrow_key, &vault_bump),
        amount,
    )?;

    ctx.accounts.escrow.state = STATE_REFUNDED;

    emit!(EscrowRefunded {
        escrow: escrow_key,
        buyer: buyer_key,
        amount,
        slashed: 0,
        by_verdict: false,
    });

    Ok(())
}
