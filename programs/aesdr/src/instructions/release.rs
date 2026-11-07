use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AesdrError;
use crate::state::{Escrow, EscrowReleased};
use crate::utils::{transfer_from_pda, vault_seeds};

#[derive(Accounts)]
pub struct Release<'info> {
    /// Must match `escrow.arbiter`. The verdict signer.
    pub arbiter: Signer<'info>,

    #[account(mut, has_one = arbiter @ AesdrError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,

    /// CHECK: must equal `escrow.seller`, receives the payout.
    #[account(mut, address = escrow.seller @ AesdrError::Unauthorized)]
    pub seller: UncheckedAccount<'info>,

    /// CHECK: validated against the escrow seeds and cached bump.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Happy path: the arbiter attests delivery and the escrow pays the seller.
pub fn handle_release(ctx: Context<Release>) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    require!(escrow.is_open(), AesdrError::EscrowNotOpen);

    let amount = escrow.amount;
    let escrow_key = escrow.key();
    let seller = escrow.seller;
    let vault_bump = [escrow.vault_bump];

    transfer_from_pda(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.seller.to_account_info(),
        &vault_seeds(&escrow_key, &vault_bump),
        amount,
    )?;

    ctx.accounts.escrow.state = STATE_RELEASED;

    emit!(EscrowReleased {
        escrow: escrow_key,
        seller,
        amount,
    });

    Ok(())
}
