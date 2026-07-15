use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("6AubiksMrewquWECHWYsPhAZT4WM6xaWkF4nNZ14ika4");

const BPS_DENOMINATOR: u64 = 10_000;
const LOCKED_BPS: u64 = 9_250; // 92.5%
const FEE_15_BPS: u64 = 150; // 1.5%
const FEE_6_BPS: u64 = 600; // 6%
const LOCKED_BPS_SEED: [u8; 8] = LOCKED_BPS.to_le_bytes();
const FEE_15_BPS_SEED: [u8; 8] = FEE_15_BPS.to_le_bytes();
const FEE_6_BPS_SEED: [u8; 8] = FEE_6_BPS.to_le_bytes();

const fn ceil_div(numerator: u64, denominator: u64) -> u64 {
    (numerator + denominator - 1) / denominator
}

const MIN_AMOUNT_LAMPORTS: u64 = ceil_div(BPS_DENOMINATOR, FEE_15_BPS);

fn amount_for_bps(amount: u64, bps: u64) -> u64 {
    ((amount as u128 * bps as u128) / BPS_DENOMINATOR as u128) as u64
}

fn require_distribution_open(distribution: &PaymentDistribution) -> Result<()> {
    require!(!distribution.released, EscrowError::AlreadyReleased);
    require!(!distribution.cancelled, EscrowError::AlreadyCancelled);
    Ok(())
}

fn require_funder_or_fee_recipient(
    distribution: &PaymentDistribution,
    authority: Pubkey,
) -> Result<()> {
    require!(
        authority == distribution.funder || authority == distribution.recipient_fee_6,
        EscrowError::Unauthorized
    );
    Ok(())
}

fn require_fee_6_recipient(distribution: &PaymentDistribution, authority: Pubkey) -> Result<()> {
    require!(
        authority == distribution.recipient_fee_6,
        EscrowError::Unauthorized
    );
    Ok(())
}

fn transfer_from_vault<'info>(
    distribution: &PaymentDistribution,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let payment_id = distribution.payment_id.to_le_bytes();
    let vault_bump = [distribution.vault_bump];
    let signer_seeds = &[&[
        b"vault",
        distribution.funder.as_ref(),
        payment_id.as_ref(),
        LOCKED_BPS_SEED.as_ref(),
        FEE_15_BPS_SEED.as_ref(),
        FEE_6_BPS_SEED.as_ref(),
        vault_bump.as_ref(),
    ][..]];
    let cpi_accounts = Transfer { from, to };
    let cpi_context = CpiContext::new_with_signer(system_program, cpi_accounts, signer_seeds);
    transfer(cpi_context, amount)
}

fn close_vault_if_needed<'info>(
    distribution: &PaymentDistribution,
    vault: &UncheckedAccount<'info>,
    destination: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
) -> Result<()> {
    let remaining = vault.to_account_info().lamports();
    if remaining > 0 {
        transfer_from_vault(
            distribution,
            vault.to_account_info(),
            destination,
            system_program,
            remaining,
        )?;
    }
    Ok(())
}

#[program]
pub mod anchor_workspace {
    use super::*;

    pub fn initialize_distribution(
        ctx: Context<InitializeDistribution>,
        payment_id: u64,
        amount: u64,
        timelock_seconds: i64,
    ) -> Result<()> {
        require!(amount >= MIN_AMOUNT_LAMPORTS, EscrowError::InvalidAmount);
        require!(timelock_seconds > 0, EscrowError::InvalidTimelock);

        let fee_amount_15 = amount_for_bps(amount, FEE_15_BPS);
        let fee_amount_6 = amount_for_bps(amount, FEE_6_BPS);
        let locked_amount = amount
            .checked_sub(fee_amount_15)
            .and_then(|value| value.checked_sub(fee_amount_6))
            .ok_or(EscrowError::MathOverflow)?;

        let expected_locked = amount_for_bps(amount, LOCKED_BPS);
        require!(
            locked_amount >= expected_locked,
            EscrowError::InvalidDistribution
        );

        let clock = Clock::get()?;
        let release_at = clock
            .unix_timestamp
            .checked_add(timelock_seconds)
            .ok_or(EscrowError::MathOverflow)?;

        {
            let cpi_accounts = Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            };
            let cpi_context =
                CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
            transfer(cpi_context, locked_amount)?;
        }

        {
            let cpi_accounts = Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.recipient_fee_15.to_account_info(),
            };
            let cpi_context =
                CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
            transfer(cpi_context, fee_amount_15)?;
        }

        {
            let cpi_accounts = Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.recipient_fee_6.to_account_info(),
            };
            let cpi_context =
                CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
            transfer(cpi_context, fee_amount_6)?;
        }

        let distribution = &mut ctx.accounts.distribution;
        distribution.payment_id = payment_id;
        distribution.payer = ctx.accounts.payer.key();
        distribution.funder = ctx.accounts.funder.key();
        distribution.recipient_locked = ctx.accounts.recipient_locked.key();
        distribution.recipient_fee_15 = ctx.accounts.recipient_fee_15.key();
        distribution.recipient_fee_6 = ctx.accounts.recipient_fee_6.key();
        distribution.total_amount = amount;
        distribution.locked_amount = locked_amount;
        distribution.fee_amount_15 = fee_amount_15;
        distribution.fee_amount_6 = fee_amount_6;
        distribution.release_at = release_at;
        distribution.vault = ctx.accounts.vault.key();
        distribution.vault_bump = ctx.bumps.vault;
        distribution.transfer_blocked = false;
        distribution.cancelled = false;
        distribution.released = false;
        distribution.bump = ctx.bumps.distribution;

        emit!(DistributionCreated {
            payment_id,
            distribution: distribution.key(),
            vault: distribution.vault,
            funder: distribution.funder,
            recipient_locked: distribution.recipient_locked,
            recipient_fee_15: distribution.recipient_fee_15,
            recipient_fee_6: distribution.recipient_fee_6,
            total_amount: amount,
            locked_amount,
            fee_amount_15,
            fee_amount_6,
            release_at,
        });

        Ok(())
    }

    pub fn release_locked_funds(ctx: Context<ReleaseLockedFunds>) -> Result<()> {
        let distribution = &mut ctx.accounts.distribution;

        require_distribution_open(distribution)?;
        require!(!distribution.transfer_blocked, EscrowError::TransferBlocked);

        let now = Clock::get()?.unix_timestamp;
        require!(now >= distribution.release_at, EscrowError::TimelockActive);

        let amount = distribution.locked_amount;
        require!(
            ctx.accounts.vault.to_account_info().lamports() >= amount,
            EscrowError::InsufficientVaultFunds
        );

        transfer_from_vault(
            distribution,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.recipient_locked.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            amount,
        )?;

        close_vault_if_needed(
            distribution,
            &ctx.accounts.vault,
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        )?;

        distribution.released = true;

        emit!(FundsReleased {
            payment_id: distribution.payment_id,
            distribution: distribution.key(),
            vault: distribution.vault,
            recipient_locked: distribution.recipient_locked,
            amount,
            immediate: false,
        });

        Ok(())
    }

    pub fn block_locked_transfer(
        ctx: Context<ManageLockedFundsByAuthority>,
        blocked: bool,
    ) -> Result<()> {
        let distribution = &mut ctx.accounts.distribution;
        require_distribution_open(distribution)?;

        let authority = ctx.accounts.authority.key();
        require_funder_or_fee_recipient(distribution, authority)?;

        distribution.transfer_blocked = blocked;
        Ok(())
    }

    pub fn release_locked_funds_now(ctx: Context<ReleaseLockedFundsNowByAuthority>) -> Result<()> {
        let distribution = &mut ctx.accounts.distribution;

        require_distribution_open(distribution)?;

        let authority = ctx.accounts.authority.key();
        require_funder_or_fee_recipient(distribution, authority)?;

        let amount = distribution.locked_amount;
        require!(
            ctx.accounts.vault.to_account_info().lamports() >= amount,
            EscrowError::InsufficientVaultFunds
        );

        transfer_from_vault(
            distribution,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.recipient_locked.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            amount,
        )?;

        close_vault_if_needed(
            distribution,
            &ctx.accounts.vault,
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        )?;

        distribution.released = true;
        distribution.transfer_blocked = false;

        emit!(FundsReleased {
            payment_id: distribution.payment_id,
            distribution: distribution.key(),
            vault: distribution.vault,
            recipient_locked: distribution.recipient_locked,
            amount,
            immediate: true,
        });

        Ok(())
    }

    pub fn cancel_locked_funds(ctx: Context<CancelLockedFunds>) -> Result<()> {
        let distribution = &mut ctx.accounts.distribution;

        require_distribution_open(distribution)?;

        let authority = ctx.accounts.authority.key();
        require_fee_6_recipient(distribution, authority)?;

        let amount = distribution.locked_amount;
        require!(
            ctx.accounts.vault.to_account_info().lamports() >= amount,
            EscrowError::InsufficientVaultFunds
        );

        transfer_from_vault(
            distribution,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.funder.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            amount,
        )?;

        close_vault_if_needed(
            distribution,
            &ctx.accounts.vault,
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        )?;

        distribution.cancelled = true;
        distribution.transfer_blocked = false;

        emit!(FundsCancelled {
            payment_id: distribution.payment_id,
            distribution: distribution.key(),
            vault: distribution.vault,
            funder: distribution.funder,
            cancelled_by: authority,
            amount,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(payment_id: u64, _amount: u64, _timelock_seconds: i64)]
pub struct InitializeDistribution<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + PaymentDistribution::INIT_SPACE,
        seeds = [b"distribution", funder.key().as_ref(), payment_id.to_le_bytes().as_ref()],
        bump
    )]
    pub distribution: Account<'info, PaymentDistribution>,

    #[account(
        init,
        payer = payer,
        space = 0,
        owner = system_program::ID,
        seeds = [
            b"vault",
            funder.key().as_ref(),
            payment_id.to_le_bytes().as_ref(),
            LOCKED_BPS_SEED.as_ref(),
            FEE_15_BPS_SEED.as_ref(),
            FEE_6_BPS_SEED.as_ref()
        ],
        bump
    )]
    /// CHECK: Vault PDA système (owner=SystemProgram) pour stocker les 92.5%.
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(mut)]
    pub recipient_locked: SystemAccount<'info>,

    #[account(mut)]
    pub recipient_fee_15: SystemAccount<'info>,

    #[account(mut)]
    pub recipient_fee_6: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseLockedFunds<'info> {
    #[account(
        mut,
        has_one = recipient_locked @ EscrowError::Unauthorized,
        seeds = [b"distribution", distribution.funder.as_ref(), distribution.payment_id.to_le_bytes().as_ref()],
        bump = distribution.bump
    )]
    pub distribution: Account<'info, PaymentDistribution>,

    #[account(
        mut,
        owner = system_program::ID,
        address = distribution.vault @ EscrowError::Unauthorized,
        seeds = [
            b"vault",
            distribution.funder.as_ref(),
            distribution.payment_id.to_le_bytes().as_ref(),
            LOCKED_BPS_SEED.as_ref(),
            FEE_15_BPS_SEED.as_ref(),
            FEE_6_BPS_SEED.as_ref()
        ],
        bump = distribution.vault_bump
    )]
    /// CHECK: Validé par seeds+bump+owner+address.
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub recipient_locked: Signer<'info>,

    #[account(mut, address = distribution.payer @ EscrowError::Unauthorized)]
    pub payer: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageLockedFundsByAuthority<'info> {
    #[account(
        mut,
        has_one = recipient_locked @ EscrowError::Unauthorized,
        seeds = [b"distribution", distribution.funder.as_ref(), distribution.payment_id.to_le_bytes().as_ref()],
        bump = distribution.bump
    )]
    pub distribution: Account<'info, PaymentDistribution>,

    #[account(
        mut,
        owner = system_program::ID,
        address = distribution.vault @ EscrowError::Unauthorized,
        seeds = [
            b"vault",
            distribution.funder.as_ref(),
            distribution.payment_id.to_le_bytes().as_ref(),
            LOCKED_BPS_SEED.as_ref(),
            FEE_15_BPS_SEED.as_ref(),
            FEE_6_BPS_SEED.as_ref()
        ],
        bump = distribution.vault_bump
    )]
    /// CHECK: Validé par seeds+bump+owner+address.
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub recipient_locked: SystemAccount<'info>,

    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseLockedFundsNowByAuthority<'info> {
    #[account(
        mut,
        has_one = recipient_locked @ EscrowError::Unauthorized,
        seeds = [b"distribution", distribution.funder.as_ref(), distribution.payment_id.to_le_bytes().as_ref()],
        bump = distribution.bump
    )]
    pub distribution: Account<'info, PaymentDistribution>,

    #[account(
        mut,
        owner = system_program::ID,
        address = distribution.vault @ EscrowError::Unauthorized,
        seeds = [
            b"vault",
            distribution.funder.as_ref(),
            distribution.payment_id.to_le_bytes().as_ref(),
            LOCKED_BPS_SEED.as_ref(),
            FEE_15_BPS_SEED.as_ref(),
            FEE_6_BPS_SEED.as_ref()
        ],
        bump = distribution.vault_bump
    )]
    /// CHECK: Validé par seeds+bump+owner+address.
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub recipient_locked: SystemAccount<'info>,

    pub authority: Signer<'info>,

    #[account(mut, address = distribution.payer @ EscrowError::Unauthorized)]
    pub payer: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelLockedFunds<'info> {
    #[account(
        mut,
        has_one = funder @ EscrowError::Unauthorized,
        seeds = [b"distribution", distribution.funder.as_ref(), distribution.payment_id.to_le_bytes().as_ref()],
        bump = distribution.bump
    )]
    pub distribution: Account<'info, PaymentDistribution>,

    #[account(
        mut,
        owner = system_program::ID,
        address = distribution.vault @ EscrowError::Unauthorized,
        seeds = [
            b"vault",
            distribution.funder.as_ref(),
            distribution.payment_id.to_le_bytes().as_ref(),
            LOCKED_BPS_SEED.as_ref(),
            FEE_15_BPS_SEED.as_ref(),
            FEE_6_BPS_SEED.as_ref()
        ],
        bump = distribution.vault_bump
    )]
    /// CHECK: Validé par seeds+bump+owner+address.
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub funder: SystemAccount<'info>,

    #[account(mut, address = distribution.payer @ EscrowError::Unauthorized)]
    pub payer: SystemAccount<'info>,

    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct PaymentDistribution {
    pub payment_id: u64,
    pub payer: Pubkey,
    pub funder: Pubkey,
    pub recipient_locked: Pubkey,
    pub recipient_fee_15: Pubkey,
    pub recipient_fee_6: Pubkey,
    pub total_amount: u64,
    pub locked_amount: u64,
    pub fee_amount_15: u64,
    pub fee_amount_6: u64,
    pub release_at: i64,
    pub vault: Pubkey,
    pub vault_bump: u8,
    pub transfer_blocked: bool,
    pub cancelled: bool,
    pub released: bool,
    pub bump: u8,
}

#[event]
pub struct DistributionCreated {
    pub payment_id: u64,
    pub distribution: Pubkey,
    pub vault: Pubkey,
    pub funder: Pubkey,
    pub recipient_locked: Pubkey,
    pub recipient_fee_15: Pubkey,
    pub recipient_fee_6: Pubkey,
    pub total_amount: u64,
    pub locked_amount: u64,
    pub fee_amount_15: u64,
    pub fee_amount_6: u64,
    pub release_at: i64,
}

#[event]
pub struct FundsReleased {
    pub payment_id: u64,
    pub distribution: Pubkey,
    pub vault: Pubkey,
    pub recipient_locked: Pubkey,
    pub amount: u64,
    pub immediate: bool,
}

#[event]
pub struct FundsCancelled {
    pub payment_id: u64,
    pub distribution: Pubkey,
    pub vault: Pubkey,
    pub funder: Pubkey,
    pub cancelled_by: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("Montant invalide")]
    InvalidAmount,
    #[msg("Timelock invalide")]
    InvalidTimelock,
    #[msg("Action non autorisée")]
    Unauthorized,
    #[msg("Distribution déjà libérée")]
    AlreadyReleased,
    #[msg("Distribution déjà annulée")]
    AlreadyCancelled,
    #[msg("Timelock encore actif")]
    TimelockActive,
    #[msg("Transfert 92.5% bloqué")]
    TransferBlocked,
    #[msg("Distribution invalide")]
    InvalidDistribution,
    #[msg("Overflow arithmétique")]
    MathOverflow,
    #[msg("Erreur de sous-flux lamports")]
    LamportUnderflow,
    #[msg("Erreur de sur-flux lamports")]
    LamportOverflow,
    #[msg("Solde du vault insuffisant")]
    InsufficientVaultFunds,
}
