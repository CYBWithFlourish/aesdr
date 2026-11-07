use anchor_lang::prelude::*;
use anchor_lang::system_program;

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
pub fn vault_seeds<'a>(escrow: &'a Pubkey, bump: &'a [u8]) -> [&'a [u8]; 3] {
    [VAULT_SEED, escrow.as_ref(), bump]
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
