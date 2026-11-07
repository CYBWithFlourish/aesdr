use anchor_lang::prelude::*;

/// One paid session between a buyer agent and a seller API provider.
///
/// Lamports never live on this account. They live on the `vault` PDA
/// (seeds `["vault", escrow]`), which is a bare system-owned address with no
/// data. That split is required: a program-owned account cannot be debited with
/// `system_program::transfer`, whereas a system-owned PDA can once the program
/// signs for it.
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    /// Agent paying for the call.
    pub buyer: Pubkey,
    /// API provider delivering the payload.
    pub seller: Pubkey,
    /// Trusted judge that settles `PASS` / `BREACH`.
    /// This seat is where a Groth16 verifier drops in later.
    pub arbiter: Pubkey,
    /// Client-generated id, makes escrows unique per request.
    pub session_id: [u8; 32],
    /// Lamports locked by the buyer.
    pub amount: u64,
    /// Seller collateral that must be posted before the escrow opens.
    pub min_bond: u64,
    /// Unix timestamp after which the buyer may reclaim unilaterally.
    pub deadline: i64,
    /// 0 = Open, 1 = Released, 2 = Refunded.
    pub state: u8,
    /// Canonical bump of the vault PDA, cached so settlement needs no re-derivation.
    pub vault_bump: u8,
}

impl Escrow {
    pub const SPACE: usize = 8 + Self::INIT_SPACE;

    pub fn is_open(&self) -> bool {
        self.state == crate::constants::STATE_OPEN
    }
}

/// Emitted on every state transition so the UI can rebuild the timeline
/// without an indexer.
#[event]
pub struct EscrowOpened {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub session_id: [u8; 32],
    pub amount: u64,
    pub min_bond: u64,
    pub deadline: i64,
}

#[event]
pub struct EscrowReleased {
    pub escrow: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EscrowRefunded {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    pub slashed: u64,
    /// True when the refund came from a verdict, false when from the deadline.
    pub by_verdict: bool,
}

#[event]
pub struct BondPosted {
    pub seller: Pubkey,
    pub bond: Pubkey,
    pub amount: u64,
    pub total: u64,
}
