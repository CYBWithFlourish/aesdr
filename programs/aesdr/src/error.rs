use anchor_lang::prelude::*;

#[error_code]
pub enum AesdrError {
    #[msg("Signer is not authorized for this escrow")]
    Unauthorized,

    #[msg("Escrow is not in the OPEN state")]
    EscrowNotOpen,

    #[msg("Escrow is already settled")]
    AlreadySettled,

    #[msg("Amount must be greater than zero")]
    InvalidAmount,

    #[msg("Required bond must be greater than zero")]
    InvalidBond,

    #[msg("Seller bond is smaller than the escrow requires")]
    BondTooSmall,

    #[msg("Deadline must be in the future and within 24 hours")]
    InvalidDeadline,

    #[msg("Deadline has not been reached yet")]
    DeadlineNotReached,

    #[msg("Session id must not be all zeroes")]
    InvalidSessionId,

    #[msg("Buyer and seller must be different keys")]
    SelfDealing,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Escrow asset must be lamports (0) or SPL (1)")]
    InvalidAsset,

    #[msg("This escrow needs token accounts that were not supplied")]
    MissingTokenAccounts,

    #[msg("Token mint does not match the escrow's mint")]
    MintMismatch,
}
