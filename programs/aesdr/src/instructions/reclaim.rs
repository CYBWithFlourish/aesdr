use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{Mint, Token, TokenAccount},
};

use crate::constants::{STATE_REFUNDED, VAULT_SEED};
use crate::error::AesdrError;
use crate::state::{Escrow, EscrowRefunded};
use crate::utils::{require_same_mint, transfer_from_pda, transfer_spl_from_vault, vault_seeds};

#[derive(Accounts)]
pub struct Reclaim<'info> {
    /// Must match `escrow.buyer`. The liveness escape hatch.
    /// Writable: receives the refund, and pays the rent for `buyer_ata` if the
    /// account still has to be created.
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

    // ---- SPL accounts. Unread for lamport escrows.

    /// Only read for SPL escrows, so a SOL settlement passes `None`.
    pub mint: Option<Account<'info, Mint>>,

    #[account(mut)]
    pub vault_ata: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub buyer_ata: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
}

/// Trust-minimizing exit: after the deadline the buyer needs nobody's
/// cooperation to get the money back. No bond slash - this is not a verdict.
pub fn handle_reclaim(ctx: Context<Reclaim>) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    require!(escrow.is_open(), AesdrError::EscrowNotOpen);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= escrow.deadline, AesdrError::DeadlineNotReached);

    let amount = escrow.amount;
    let escrow_key = escrow.key();
    let buyer_key = escrow.buyer;
    let is_spl = escrow.is_spl();
    let escrow_mint = escrow.mint;
    let vault_bump = [escrow.vault_bump];

    if is_spl {
        let mint = ctx
            .accounts
            .mint
            .as_ref()
            .ok_or(error!(AesdrError::MissingTokenAccounts))?;
        let vault_ata = ctx
            .accounts
            .vault_ata
            .as_ref()
            .ok_or(error!(AesdrError::MissingTokenAccounts))?;
        let buyer_ata = ctx
            .accounts
            .buyer_ata
            .as_ref()
            .ok_or(error!(AesdrError::MissingTokenAccounts))?;

        require_same_mint(&escrow_mint, &mint.key())?;
        require_same_mint(&escrow_mint, &vault_ata.mint)?;
        require_same_mint(&escrow_mint, &buyer_ata.mint)?;

        require_keys_eq!(
            vault_ata.key(),
            get_associated_token_address(&ctx.accounts.vault.key(), &escrow_mint),
            AesdrError::MintMismatch
        );
        require_keys_eq!(
            buyer_ata.key(),
            get_associated_token_address(&buyer_key, &escrow_mint),
            AesdrError::MintMismatch
        );

        transfer_spl_from_vault(
            &ctx.accounts.token_program,
            vault_ata,
            buyer_ata,
            &ctx.accounts.vault.to_account_info(),
            &vault_seeds(&escrow_key, &vault_bump),
            amount,
        )?;
    } else {
        transfer_from_pda(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.buyer.to_account_info(),
            &vault_seeds(&escrow_key, &vault_bump),
            amount,
        )?;
    }

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
