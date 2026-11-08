use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{Mint, Token, TokenAccount},
};

use crate::constants::*;
use crate::error::AesdrError;
use crate::state::{Escrow, EscrowReleased};
use crate::utils::{require_same_mint, transfer_from_pda, transfer_spl_from_vault, vault_seeds};

#[derive(Accounts)]
pub struct Release<'info> {
    /// Must match `escrow.arbiter`. The verdict signer.
    /// Writable: pays the rent for `seller_ata` when it must be created.
    #[account(mut)]
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

    // ---- SPL accounts. Unread for lamport escrows, so they stay unchecked
    // and are deserialized by hand only when `escrow.asset == ASSET_SPL`.

    /// Only read for SPL escrows, so a SOL settlement passes `None`.
    pub mint: Option<Account<'info, Mint>>,

    /// Vault ATA. Authority is the vault PDA, not the escrow.
    #[account(mut)]
    pub vault_ata: Option<Account<'info, TokenAccount>>,

    /// Seller's destination. Must already exist; the arbiter creates it in the
    /// same transaction, since only the signer can pay for it.
    #[account(mut)]
    pub seller_ata: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
}

/// Happy path: the arbiter attests delivery and the escrow pays the seller.
pub fn handle_release(ctx: Context<Release>) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    require!(escrow.is_open(), AesdrError::EscrowNotOpen);

    let amount = escrow.amount;
    let escrow_key = escrow.key();
    let seller = escrow.seller;
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
        let seller_ata = ctx
            .accounts
            .seller_ata
            .as_ref()
            .ok_or(error!(AesdrError::MissingTokenAccounts))?;

        require_same_mint(&escrow_mint, &mint.key())?;
        require_same_mint(&escrow_mint, &vault_ata.mint)?;
        require_same_mint(&escrow_mint, &seller_ata.mint)?;

        // Both accounts must be the canonical ATAs for this mint, so a caller
        // cannot redirect the payout into an account it controls.
        require_keys_eq!(
            vault_ata.key(),
            get_associated_token_address(&ctx.accounts.vault.key(), &escrow_mint),
            AesdrError::MintMismatch
        );
        require_keys_eq!(
            seller_ata.key(),
            get_associated_token_address(&seller, &escrow_mint),
            AesdrError::MintMismatch
        );

        transfer_spl_from_vault(
            &ctx.accounts.token_program,
            vault_ata,
            seller_ata,
            &ctx.accounts.vault.to_account_info(),
            &vault_seeds(&escrow_key, &vault_bump),
            amount,
        )?;
    } else {
        transfer_from_pda(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.seller.to_account_info(),
            &vault_seeds(&escrow_key, &vault_bump),
            amount,
        )?;
    }

    ctx.accounts.escrow.state = STATE_RELEASED;

    emit!(EscrowReleased {
        escrow: escrow_key,
        seller,
        amount,
    });

    Ok(())
}
