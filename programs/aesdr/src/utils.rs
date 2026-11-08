use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{BOND_SEED, BPS_DENOMINATOR, SLASH_BPS, VAULT_SEED};
use crate::error::AesdrError;

/// Move lamports out of a program-signed system-owned PDA.
///
/// The source must be owned by the system program and carry no data; the
/// program's signature over `seeds` is what authorizes the debit.
pub fn transfer_from_pda<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    system_program::transfer(
        CpiContext::new_with_signer(
            system_program::ID,
            system_program::Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Signing seeds for the vault of a given escrow.
///
/// The vault PDA is both the lamport holder and the *authority* of the SPL
/// vault ATA, so the same seeds authorize both settlement paths.
pub fn vault_seeds<'a>(escrow: &'a Pubkey, bump: &'a [u8]) -> [&'a [u8]; 3] {
    [VAULT_SEED, escrow.as_ref(), bump]
}

/// Move tokens out of the vault's ATA, signed by the vault PDA.
///
/// The vault ATA is owned by the vault PDA rather than by the escrow, so
/// settlement needs no buyer signature and no per-escrow token account key.
pub fn transfer_spl_from_vault<'info>(
    token_program: &Program<'info, Token>,
    vault_ata: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: vault_ata.to_account_info(),
                to: destination.to_account_info(),
                authority: authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Assert two mints agree, so a settlement cannot be redirected to another token.
pub fn require_same_mint(expected: &Pubkey, actual: &Pubkey) -> Result<()> {
    require_keys_eq!(*expected, *actual, AesdrError::MintMismatch);
    Ok(())
}

/// Signing seeds for a seller's bond.
pub fn bond_seeds<'a>(seller: &'a Pubkey, bump: &'a [u8]) -> [&'a [u8]; 3] {
    [BOND_SEED, seller.as_ref(), bump]
}

/// 10% of the escrow's required bond, clamped to what the bond actually holds.
///
/// Clamping keeps `refund` from failing when a seller has already been slashed
/// down to dust: the buyer gets the escrow back either way, and a partial slash
/// is still a slash.
pub fn slash_amount(bond_lamports: u64, min_bond: u64) -> Result<u64> {
    let target = (min_bond as u128)
        .checked_mul(SLASH_BPS as u128)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR as u128))
        .ok_or(AesdrError::Overflow)?;

    let target = u64::try_from(target).map_err(|_| error!(AesdrError::Overflow))?;
    Ok(target.min(bond_lamports))
}
