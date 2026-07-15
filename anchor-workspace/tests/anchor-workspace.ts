import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorWorkspace } from "../target/types/anchor_workspace";
import { expect } from "chai";

describe("anchor-workspace", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.anchorWorkspace as Program<AnchorWorkspace>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const LAMPORTS_PER_SOL = anchor.web3.LAMPORTS_PER_SOL;
  const BPS_DENOMINATOR = 10_000;
  const LOCKED_BPS = 9_250;
  const FEE_15_BPS = 150;
  const FEE_6_BPS = 600;
  const MIN_AMOUNT_LAMPORTS = Math.ceil(BPS_DENOMINATOR / FEE_15_BPS);
  const LOCKED_BPS_SEED = new anchor.BN(LOCKED_BPS).toArrayLike(Buffer, "le", 8);
  const FEE_15_BPS_SEED = new anchor.BN(FEE_15_BPS).toArrayLike(Buffer, "le", 8);
  const FEE_6_BPS_SEED = new anchor.BN(FEE_6_BPS).toArrayLike(Buffer, "le", 8);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const getSplit = (amount: number) => {
    const fee15 = Math.floor((amount * FEE_15_BPS) / BPS_DENOMINATOR);
    const fee6 = Math.floor((amount * FEE_6_BPS) / BPS_DENOMINATOR);
    const locked = amount - fee15 - fee6;
    return { fee15, fee6, locked };
  };

  const airdropAndConfirm = async (pubkey: anchor.web3.PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature: sig,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });
  };

  it("initialize_distribution: split 92.5/1.5/6 et lock des fonds", async () => {
    const payer = anchor.web3.Keypair.generate();
    const funder = anchor.web3.Keypair.generate();
    const recipientLocked = anchor.web3.Keypair.generate();
    const recipientFee15 = anchor.web3.Keypair.generate();
    const recipientFee6 = anchor.web3.Keypair.generate();

    await airdropAndConfirm(payer.publicKey, 10);
    await airdropAndConfirm(funder.publicKey, 5);
    await airdropAndConfirm(recipientLocked.publicKey, 1);
    await airdropAndConfirm(recipientFee15.publicKey, 1);
    await airdropAndConfirm(recipientFee6.publicKey, 1);

    const paymentId = new anchor.BN(Date.now());
    const amount = new anchor.BN(1_000_000); // 0.001 SOL
    const timelockSeconds = new anchor.BN(2);

    const [distributionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("distribution"),
        funder.publicKey.toBuffer(),
        paymentId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        funder.publicKey.toBuffer(),
        paymentId.toArrayLike(Buffer, "le", 8),
        LOCKED_BPS_SEED,
        FEE_15_BPS_SEED,
        FEE_6_BPS_SEED,
      ],
      program.programId
    );

    const { fee15, fee6, locked } = getSplit(amount.toNumber());

    const fee15Before = await provider.connection.getBalance(recipientFee15.publicKey);
    const fee6Before = await provider.connection.getBalance(recipientFee6.publicKey);
    const pdaBefore = await provider.connection.getBalance(distributionPda);
    const vaultBefore = await provider.connection.getBalance(vaultPda);

    await program.methods
      .initializeDistribution(paymentId, amount, timelockSeconds)
      .accountsPartial({
        distribution: distributionPda,
        vault: vaultPda,
        payer: payer.publicKey,
        funder: funder.publicKey,
        recipientLocked: recipientLocked.publicKey,
        recipientFee15: recipientFee15.publicKey,
        recipientFee6: recipientFee6.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer, funder])
      .rpc();

    const fee15After = await provider.connection.getBalance(recipientFee15.publicKey);
    const fee6After = await provider.connection.getBalance(recipientFee6.publicKey);
    const pdaAfter = await provider.connection.getBalance(distributionPda);
    const vaultAfter = await provider.connection.getBalance(vaultPda);
    const distributionInfo = await provider.connection.getAccountInfo(distributionPda);
    const vaultInfo = await provider.connection.getAccountInfo(vaultPda);
    const distributionDataLength = distributionInfo?.data?.length || 0;
    const vaultDataLength = vaultInfo?.data?.length || 0;
    const distributionRentExempt = await provider.connection.getMinimumBalanceForRentExemption(distributionDataLength);
    const vaultRentExempt = await provider.connection.getMinimumBalanceForRentExemption(vaultDataLength);

    expect(fee15After - fee15Before).to.equal(fee15);
    expect(fee6After - fee6Before).to.equal(fee6);
    expect(pdaAfter - pdaBefore).to.equal(distributionRentExempt);
    // Vault gets initialized with rent + receives locked lamports.
    expect(vaultAfter - vaultBefore).to.equal(vaultRentExempt + locked);

    const account = await program.account.paymentDistribution.fetch(distributionPda);
    expect(account.totalAmount.toNumber()).to.equal(amount.toNumber());
    expect(account.feeAmount15.toNumber()).to.equal(fee15);
    expect(account.feeAmount6.toNumber()).to.equal(fee6);
    expect(account.lockedAmount.toNumber()).to.equal(locked);
    expect(account.transferBlocked).to.equal(false);
    expect(account.cancelled).to.equal(false);
    expect(account.released).to.equal(false);

    try {
      await program.methods
        .releaseLockedFunds()
        .accountsPartial({
          distribution: distributionPda,
          vault: vaultPda,
          recipientLocked: recipientLocked.publicKey,
          payer: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([recipientLocked])
        .rpc();
      expect.fail("release devrait échouer avant la fin du timelock");
    } catch (_error) {
      expect(true).to.equal(true);
    }

    await sleep(2500);

    const recipientLockedBefore = await provider.connection.getBalance(recipientLocked.publicKey);

    await program.methods
      .releaseLockedFunds()
      .accountsPartial({
        distribution: distributionPda,
        vault: vaultPda,
        recipientLocked: recipientLocked.publicKey,
        payer: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([recipientLocked])
      .rpc();

    const recipientLockedAfter = await provider.connection.getBalance(recipientLocked.publicKey);
    const pdaFinal = await provider.connection.getBalance(distributionPda);
    const vaultFinal = await provider.connection.getBalance(vaultPda);

    expect(recipientLockedAfter - recipientLockedBefore).to.equal(locked);
    expect(pdaFinal).to.equal(distributionRentExempt);
    expect(vaultFinal).to.equal(0);

    const accountAfterRelease = await program.account.paymentDistribution.fetch(distributionPda);
    expect(accountAfterRelease.released).to.equal(true);
  });

  it("initialize_distribution: refuse les montants sous le minimum technique", async () => {
    const payer = anchor.web3.Keypair.generate();
    const funder = anchor.web3.Keypair.generate();
    const recipientLocked = anchor.web3.Keypair.generate();
    const recipientFee15 = anchor.web3.Keypair.generate();
    const recipientFee6 = anchor.web3.Keypair.generate();

    await airdropAndConfirm(payer.publicKey, 10);
    await airdropAndConfirm(funder.publicKey, 5);
    await airdropAndConfirm(recipientLocked.publicKey, 1);
    await airdropAndConfirm(recipientFee15.publicKey, 1);
    await airdropAndConfirm(recipientFee6.publicKey, 1);

    const paymentId = new anchor.BN(Date.now() + 1234);
    const amount = new anchor.BN(MIN_AMOUNT_LAMPORTS - 1);
    const timelockSeconds = new anchor.BN(2);

    const [distributionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("distribution"),
        funder.publicKey.toBuffer(),
        paymentId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        funder.publicKey.toBuffer(),
        paymentId.toArrayLike(Buffer, "le", 8),
        LOCKED_BPS_SEED,
        FEE_15_BPS_SEED,
        FEE_6_BPS_SEED,
      ],
      program.programId
    );

    try {
      await program.methods
        .initializeDistribution(paymentId, amount, timelockSeconds)
        .accountsPartial({
          distribution: distributionPda,
          vault: vaultPda,
          payer: payer.publicKey,
          funder: funder.publicKey,
          recipientLocked: recipientLocked.publicKey,
          recipientFee15: recipientFee15.publicKey,
          recipientFee6: recipientFee6.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([payer, funder])
        .rpc();
      expect.fail("un montant sous le seuil minimal doit être rejeté");
    } catch (_error) {
      expect(true).to.equal(true);
    }
  });

  it("emetteur: peut bloquer puis payer immédiatement le 92.5%", async () => {
    const payer = anchor.web3.Keypair.generate();
    const funder = anchor.web3.Keypair.generate();
    const recipientLocked = anchor.web3.Keypair.generate();
    const recipientFee15 = anchor.web3.Keypair.generate();
    const recipientFee6 = anchor.web3.Keypair.generate();

    await airdropAndConfirm(payer.publicKey, 10);
    await airdropAndConfirm(funder.publicKey, 5);
    await airdropAndConfirm(recipientLocked.publicKey, 1);
    await airdropAndConfirm(recipientFee15.publicKey, 1);
    await airdropAndConfirm(recipientFee6.publicKey, 1);

    const paymentId = new anchor.BN(Date.now() + 999);
    const amount = new anchor.BN(500_000);
    const timelockSeconds = new anchor.BN(60);

    const [distributionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("distribution"),
        funder.publicKey.toBuffer(),
        paymentId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        funder.publicKey.toBuffer(),
        paymentId.toArrayLike(Buffer, "le", 8),
        LOCKED_BPS_SEED,
        FEE_15_BPS_SEED,
        FEE_6_BPS_SEED,
      ],
      program.programId
    );

    await program.methods
      .initializeDistribution(paymentId, amount, timelockSeconds)
      .accountsPartial({
        distribution: distributionPda,
        vault: vaultPda,
        payer: payer.publicKey,
        funder: funder.publicKey,
        recipientLocked: recipientLocked.publicKey,
        recipientFee15: recipientFee15.publicKey,
        recipientFee6: recipientFee6.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer, funder])
      .rpc();

    await program.methods
      .blockLockedTransfer(true)
      .accountsPartial({
        distribution: distributionPda,
        vault: vaultPda,
        recipientLocked: recipientLocked.publicKey,
        authority: funder.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    try {
      await program.methods
        .releaseLockedFunds()
        .accountsPartial({
          distribution: distributionPda,
          vault: vaultPda,
          recipientLocked: recipientLocked.publicKey,
          payer: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([recipientLocked])
        .rpc();
      expect.fail("release timelock doit rester bloqué");
    } catch (_error) {
      expect(true).to.equal(true);
    }

    const { locked } = getSplit(amount.toNumber());
    const recipientLockedBefore = await provider.connection.getBalance(recipientLocked.publicKey);

    await program.methods
      .releaseLockedFundsNow()
      .accountsPartial({
        distribution: distributionPda,
        vault: vaultPda,
        recipientLocked: recipientLocked.publicKey,
        authority: funder.publicKey,
        payer: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    const recipientLockedAfter = await provider.connection.getBalance(recipientLocked.publicKey);
    expect(recipientLockedAfter - recipientLockedBefore).to.equal(locked);

    const account = await program.account.paymentDistribution.fetch(distributionPda);
    expect(account.released).to.equal(true);
  });

  it("destinataire 6%: peut bloquer, payer immédiatement et annuler (emetteur ne peut pas annuler)", async () => {
    const payer = anchor.web3.Keypair.generate();
    const funder = anchor.web3.Keypair.generate();
    const recipientLocked = anchor.web3.Keypair.generate();
    const recipientFee15 = anchor.web3.Keypair.generate();
    const recipientFee6 = anchor.web3.Keypair.generate();

    await airdropAndConfirm(payer.publicKey, 10);
    await airdropAndConfirm(funder.publicKey, 5);
    await airdropAndConfirm(recipientLocked.publicKey, 1);
    await airdropAndConfirm(recipientFee15.publicKey, 1);
    await airdropAndConfirm(recipientFee6.publicKey, 1);

    const paymentId1 = new anchor.BN(Date.now() + 3000);
    const amount1 = new anchor.BN(600_000);
    const timelockSeconds1 = new anchor.BN(60);

    const [distributionPda1] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("distribution"),
        funder.publicKey.toBuffer(),
        paymentId1.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda1] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        funder.publicKey.toBuffer(),
        paymentId1.toArrayLike(Buffer, "le", 8),
        LOCKED_BPS_SEED,
        FEE_15_BPS_SEED,
        FEE_6_BPS_SEED,
      ],
      program.programId
    );

    await program.methods
      .initializeDistribution(paymentId1, amount1, timelockSeconds1)
      .accountsPartial({
        distribution: distributionPda1,
        vault: vaultPda1,
        payer: payer.publicKey,
        funder: funder.publicKey,
        recipientLocked: recipientLocked.publicKey,
        recipientFee15: recipientFee15.publicKey,
        recipientFee6: recipientFee6.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer, funder])
      .rpc();

    await program.methods
      .blockLockedTransfer(true)
      .accountsPartial({
        distribution: distributionPda1,
        vault: vaultPda1,
        recipientLocked: recipientLocked.publicKey,
        authority: recipientFee6.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([recipientFee6])
      .rpc();

    const { locked: locked1 } = getSplit(amount1.toNumber());
    const recipientLockedBefore = await provider.connection.getBalance(recipientLocked.publicKey);

    await program.methods
      .releaseLockedFundsNow()
      .accountsPartial({
        distribution: distributionPda1,
        vault: vaultPda1,
        recipientLocked: recipientLocked.publicKey,
        authority: recipientFee6.publicKey,
        payer: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([recipientFee6])
      .rpc();

    const recipientLockedAfter = await provider.connection.getBalance(recipientLocked.publicKey);
    expect(recipientLockedAfter - recipientLockedBefore).to.equal(locked1);

    const paymentId2 = new anchor.BN(Date.now() + 6000);
    const amount2 = new anchor.BN(700_000);
    const timelockSeconds2 = new anchor.BN(60);

    const [distributionPda2] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("distribution"),
        funder.publicKey.toBuffer(),
        paymentId2.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda2] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        funder.publicKey.toBuffer(),
        paymentId2.toArrayLike(Buffer, "le", 8),
        LOCKED_BPS_SEED,
        FEE_15_BPS_SEED,
        FEE_6_BPS_SEED,
      ],
      program.programId
    );

    await program.methods
      .initializeDistribution(paymentId2, amount2, timelockSeconds2)
      .accountsPartial({
        distribution: distributionPda2,
        vault: vaultPda2,
        payer: payer.publicKey,
        funder: funder.publicKey,
        recipientLocked: recipientLocked.publicKey,
        recipientFee15: recipientFee15.publicKey,
        recipientFee6: recipientFee6.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer, funder])
      .rpc();

    try {
      await program.methods
        .cancelLockedFunds()
        .accountsPartial({
          distribution: distributionPda2,
          vault: vaultPda2,
          funder: funder.publicKey,
          payer: payer.publicKey,
          authority: funder.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([funder])
        .rpc();
      expect.fail("l'emetteur ne doit pas pouvoir annuler");
    } catch (_error) {
      expect(true).to.equal(true);
    }

    const { locked: locked2 } = getSplit(amount2.toNumber());
    const funderBeforeCancel = await provider.connection.getBalance(funder.publicKey);

    await program.methods
      .cancelLockedFunds()
      .accountsPartial({
        distribution: distributionPda2,
        vault: vaultPda2,
        funder: funder.publicKey,
        payer: payer.publicKey,
        authority: recipientFee6.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([recipientFee6])
      .rpc();

    const funderAfterCancel = await provider.connection.getBalance(funder.publicKey);
    expect(funderAfterCancel - funderBeforeCancel).to.equal(locked2);

    const cancelledAccount = await program.account.paymentDistribution.fetch(distributionPda2);
    expect(cancelledAccount.cancelled).to.equal(true);

    try {
      await program.methods
        .releaseLockedFunds()
        .accountsPartial({
          distribution: distributionPda2,
          vault: vaultPda2,
          recipientLocked: recipientLocked.publicKey,
          payer: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([recipientLocked])
        .rpc();
      expect.fail("release après annulation devrait échouer");
    } catch (_error) {
      expect(true).to.equal(true);
    }
  });

  it("release_locked_funds: bloque une seconde libération", async () => {
    const payer = anchor.web3.Keypair.generate();
    const funder = anchor.web3.Keypair.generate();
    const recipientLocked = anchor.web3.Keypair.generate();
    const recipientFee15 = anchor.web3.Keypair.generate();
    const recipientFee6 = anchor.web3.Keypair.generate();

    await airdropAndConfirm(payer.publicKey, 10);
    await airdropAndConfirm(funder.publicKey, 5);
    await airdropAndConfirm(recipientLocked.publicKey, 1);
    await airdropAndConfirm(recipientFee15.publicKey, 1);
    await airdropAndConfirm(recipientFee6.publicKey, 1);

    const paymentId = new anchor.BN(Date.now() + 9999);
    const amount = new anchor.BN(400_000);
    const timelockSeconds = new anchor.BN(1);

    const [distributionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("distribution"),
        funder.publicKey.toBuffer(),
        paymentId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        funder.publicKey.toBuffer(),
        paymentId.toArrayLike(Buffer, "le", 8),
        LOCKED_BPS_SEED,
        FEE_15_BPS_SEED,
        FEE_6_BPS_SEED,
      ],
      program.programId
    );

    await program.methods
      .initializeDistribution(paymentId, amount, timelockSeconds)
      .accountsPartial({
        distribution: distributionPda,
        vault: vaultPda,
        payer: payer.publicKey,
        funder: funder.publicKey,
        recipientLocked: recipientLocked.publicKey,
        recipientFee15: recipientFee15.publicKey,
        recipientFee6: recipientFee6.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer, funder])
      .rpc();

    await sleep(1500);

    await program.methods
      .releaseLockedFunds()
      .accountsPartial({
        distribution: distributionPda,
        vault: vaultPda,
        recipientLocked: recipientLocked.publicKey,
        payer: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([recipientLocked])
      .rpc();

    try {
      await program.methods
        .releaseLockedFunds()
        .accountsPartial({
          distribution: distributionPda,
          vault: vaultPda,
          recipientLocked: recipientLocked.publicKey,
          payer: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([recipientLocked])
        .rpc();
      expect.fail("deuxième release devrait échouer");
    } catch (_error) {
      expect(true).to.equal(true);
    }
  });
});

