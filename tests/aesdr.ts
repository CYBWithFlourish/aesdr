import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Aesdr } from "../target/types/aesdr";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";

const ESCROW = Buffer.from("escrow");
const VAULT = Buffer.from("vault");
const BOND = Buffer.from("bond");

const AMOUNT = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
const MIN_BOND = new anchor.BN(0.02 * LAMPORTS_PER_SOL);

describe("aesdr", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.aesdr as Program<Aesdr>;
  const connection = provider.connection;

  const buyer = Keypair.generate();
  const seller = Keypair.generate();
  const arbiter = Keypair.generate();
  const stranger = Keypair.generate();

  const sessionId = (n: number) => {
    const b = Buffer.alloc(32);
    b.writeUInt32LE(n, 0);
    return Array.from(b);
  };

  const escrowPda = (sid: number[]) =>
    PublicKey.findProgramAddressSync(
      [ESCROW, buyer.publicKey.toBuffer(), seller.publicKey.toBuffer(), Buffer.from(sid)],
      program.programId
    )[0];

  const vaultPda = (escrow: PublicKey) =>
    PublicKey.findProgramAddressSync([VAULT, escrow.toBuffer()], program.programId)[0];

  const bondPda = (who: PublicKey) =>
    PublicKey.findProgramAddressSync([BOND, who.toBuffer()], program.programId)[0];

  /** Chain time, not wall time. Deadline checks are against the validator clock. */
  const chainNow = async (): Promise<number> => {
    const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    const data = clock!.data;
    // unix_timestamp is an i64 at byte offset 32 of the Clock sysvar.
    return Number(data.readBigInt64LE(32));
  };

  /**
   * The test validator only advances its clock as slots are produced, and it
   * does not produce idle slots. Nudge it with a self-transfer until the chain
   * agrees the deadline has passed.
   */
  const waitForChainTime = async (target: number, timeoutMs = 90_000) => {
    const start = Date.now();
    while ((await chainNow()) < target) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`chain clock stuck at ${await chainNow()}, wanted ${target}`);
      }
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: buyer.publicKey,
          toPubkey: buyer.publicKey,
          lamports: 1,
        })
      );
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.feePayer = buyer.publicKey;
      tx.sign(buyer);
      await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  const airDrop = async (who: PublicKey, sol: number) => {
    const sig = await connection.requestAirdrop(who, sol * LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  };

  /** Reads the raw Escrow struct straight off the account buffer. */
  const readEscrow = async (escrow: PublicKey) => {
    const info = await connection.getAccountInfo(escrow);
    return program.coder.accounts.decode("escrow", info!.data);
  };

  const initEscrow = async (sid: number[], deadline: number, minBond = MIN_BOND) => {
    const escrow = escrowPda(sid);
    await program.methods
      .initEscrow(sid, AMOUNT, minBond, new anchor.BN(deadline))
      .accountsPartial({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        arbiter: arbiter.publicKey,
        escrow,
        vault: vaultPda(escrow),
        bond: bondPda(seller.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();
    return escrow;
  };

  before(async () => {
    await airDrop(buyer.publicKey, 10);
    await airDrop(seller.publicKey, 10);
    await airDrop(stranger.publicKey, 2);
  });

  it("seller posts a collateral bond", async () => {
    await program.methods
      .postBond(MIN_BOND)
      .accountsPartial({ seller: seller.publicKey, bond: bondPda(seller.publicKey) })
      .signers([seller])
      .rpc();

    const bond = await connection.getAccountInfo(bondPda(seller.publicKey));
    assert.equal(bond!.lamports, MIN_BOND.toNumber());
    assert.equal(bond!.data.length, 0, "bond must hold lamports and no data");
  });

  it("rejects an escrow the bond cannot cover", async () => {
    const sid = sessionId(900);
    const now = await chainNow();
    let failed = false;
    try {
      await initEscrow(sid, now + 300, MIN_BOND.muln(50));
    } catch (e: any) {
      failed = true;
      assert.match(e.toString(), /BondTooSmall|0x1776/i);
    }
    assert.isTrue(failed, "escrow should not open without enough collateral");
  });

  it("happy path: lock, verdict, release", async () => {
    const sid = sessionId(1);
    const now = await chainNow();
    const escrow = await initEscrow(sid, now + 300);

    const vault = vaultPda(escrow);
    assert.equal(
      (await connection.getAccountInfo(vault))!.lamports,
      AMOUNT.toNumber(),
      "vault must hold the locked amount"
    );

    const state = await readEscrow(escrow);
    assert.equal(state.state, 0, "OPEN");
    assert.equal(state.amount.toString(), AMOUNT.toString());
    assert.ok(state.buyer.equals(buyer.publicKey));
    assert.ok(state.arbiter.equals(arbiter.publicKey));

    const sellerBefore = await connection.getBalance(seller.publicKey);

    await program.methods
      .release()
      .accountsPartial({
        arbiter: arbiter.publicKey,
        escrow,
        seller: seller.publicKey,
        vault,
      })
      .signers([arbiter])
      .rpc();

    const sellerAfter = await connection.getBalance(seller.publicKey);
    assert.equal(sellerAfter - sellerBefore, AMOUNT.toNumber());
    assert.equal((await readEscrow(escrow)).state, 1, "RELEASED");

    // A drained vault is purged by the runtime at the end of the transaction.
    const vaultInfo = await connection.getAccountInfo(vault);
    assert.isTrue(vaultInfo === null || vaultInfo.lamports === 0, "vault drained");
  });

  it("rejects a second release on the same escrow", async () => {
    const sid = sessionId(1);
    const escrow = escrowPda(sid);
    let failed = false;
    try {
      await program.methods
        .release()
        .accountsPartial({
          arbiter: arbiter.publicKey,
          escrow,
          seller: seller.publicKey,
          vault: vaultPda(escrow),
        })
        .signers([arbiter])
        .rpc();
    } catch (e: any) {
      failed = true;
      assert.match(e.toString(), /EscrowNotOpen|0x1777/i);
    }
    assert.isTrue(failed, "release must not be replayable");
  });

  it("breach path: refund the buyer and slash 10% of the bond", async () => {
    const sid = sessionId(2);
    const now = await chainNow();
    const escrow = await initEscrow(sid, now + 300);

    const bond = bondPda(seller.publicKey);
    const bondBefore = (await connection.getAccountInfo(bond))!.lamports;
    const buyerBefore = await connection.getBalance(buyer.publicKey);

    await program.methods
      .refund()
      .accountsPartial({
        arbiter: arbiter.publicKey,
        escrow,
        buyer: buyer.publicKey,
        vault: vaultPda(escrow),
        bond,
      })
      .signers([arbiter])
      .rpc();

    const expectedSlash = MIN_BOND.toNumber() / 10;
    const buyerAfter = await connection.getBalance(buyer.publicKey);
    const bondAfter = (await connection.getAccountInfo(bond))!.lamports;

    assert.equal(buyerAfter - buyerBefore, AMOUNT.toNumber() + expectedSlash);
    assert.equal(bondBefore - bondAfter, expectedSlash, "bond slashed by 10%");
    assert.equal((await readEscrow(escrow)).state, 2, "REFUNDED");

    // The slash left the seller under-collateralized. Top it back up so the
    // remaining tests exercise a seller that is again eligible to be paid.
    await program.methods
      .postBond(new anchor.BN(expectedSlash))
      .accountsPartial({ seller: seller.publicKey, bond })
      .signers([seller])
      .rpc();
    assert.equal((await connection.getAccountInfo(bond))!.lamports, MIN_BOND.toNumber());
  });

  it("rejects a verdict from anyone but the arbiter", async () => {
    const sid = sessionId(3);
    const now = await chainNow();
    const escrow = await initEscrow(sid, now + 300);

    let failed = false;
    try {
      await program.methods
        .release()
        .accountsPartial({
          arbiter: stranger.publicKey,
          escrow,
          seller: seller.publicKey,
          vault: vaultPda(escrow),
        })
        .signers([stranger])
        .rpc();
    } catch (e: any) {
      failed = true;
    }
    assert.isTrue(failed, "a stranger must not settle the escrow");
  });

  it("buyer cannot reclaim before the deadline", async () => {
    const sid = sessionId(4);
    const now = await chainNow();
    const escrow = await initEscrow(sid, now + 300);

    let failed = false;
    try {
      await program.methods
        .reclaim()
        .accountsPartial({
          buyer: buyer.publicKey,
          escrow,
          vault: vaultPda(escrow),
        })
        .signers([buyer])
        .rpc();
    } catch (e: any) {
      failed = true;
      assert.match(e.toString(), /DeadlineNotReached|0x177a/i);
    }
    assert.isTrue(failed, "early reclaim must fail");
  });

  it("buyer reclaims unilaterally after the deadline, with no bond slash", async () => {
    const sid = sessionId(5);
    const now = await chainNow();
    const deadline = now + 3;
    const escrow = await initEscrow(sid, deadline);

    await waitForChainTime(deadline);

    const bond = bondPda(seller.publicKey);
    const bondBefore = (await connection.getAccountInfo(bond))!.lamports;
    const buyerBefore = await connection.getBalance(buyer.publicKey);

    await program.methods
      .reclaim()
      .accountsPartial({
        buyer: buyer.publicKey,
        escrow,
        vault: vaultPda(escrow),
      })
      .signers([buyer])
      .rpc();

    const buyerAfter = await connection.getBalance(buyer.publicKey);
    assert.equal(buyerAfter - buyerBefore, AMOUNT.toNumber(), "full refund, no slash");
    assert.equal((await connection.getAccountInfo(bond))!.lamports, bondBefore);
    assert.equal((await readEscrow(escrow)).state, 2, "REFUNDED");
  });
});
