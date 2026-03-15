import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { config } from "../config.js";

// ═══════════════════════════════════════════════════════════════
// Constants (mirrors seal-ts SDK)
// ═══════════════════════════════════════════════════════════════
export const SEAL_PROGRAM_ID = new PublicKey(config.SEAL_PROGRAM_ID);
const WALLET_SEED = Buffer.from("seal");
const AGENT_SEED = Buffer.from("agent");
const SESSION_SEED = Buffer.from("session");

const enum InstructionDiscriminant {
  CreateWallet = 0,
  RegisterAgent = 1,
  CreateSessionKey = 2,
  ExecuteViaSession = 3,
  RevokeSession = 4,
  TransferLamports = 13,
}

// ═══════════════════════════════════════════════════════════════
// Connection
// ═══════════════════════════════════════════════════════════════
let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  }
  return _connection;
}

// ═══════════════════════════════════════════════════════════════
// PDA Derivation
// ═══════════════════════════════════════════════════════════════
export function deriveWalletPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [WALLET_SEED, owner.toBuffer()],
    SEAL_PROGRAM_ID
  );
}

export function deriveAgentPda(
  wallet: PublicKey,
  agent: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [AGENT_SEED, wallet.toBuffer(), agent.toBuffer()],
    SEAL_PROGRAM_ID
  );
}

export function deriveSessionPda(
  wallet: PublicKey,
  agent: PublicKey,
  sessionPubkey: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      SESSION_SEED,
      wallet.toBuffer(),
      agent.toBuffer(),
      sessionPubkey.toBuffer(),
    ],
    SEAL_PROGRAM_ID
  );
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════
function encodeU64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function encodeI64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value);
  return buf;
}

// ═══════════════════════════════════════════════════════════════
// Instruction Builders
// ═══════════════════════════════════════════════════════════════

export interface CreateSessionArgs {
  agentKeypair: Keypair;
  walletOwner: PublicKey;
  sessionKeypair: Keypair;
  durationSecs: bigint;
  maxAmountLamports: bigint;
  maxPerTxLamports: bigint;
}

/**
 * Build a CreateSession instruction for the Seal program.
 */
export function buildCreateSessionInstruction(
  args: CreateSessionArgs
): TransactionInstruction {
  const [walletPda] = deriveWalletPda(args.walletOwner);
  const [agentPda] = deriveAgentPda(walletPda, args.agentKeypair.publicKey);
  const [sessionPda, bump] = deriveSessionPda(
    walletPda,
    args.agentKeypair.publicKey,
    args.sessionKeypair.publicKey
  );

  const data = Buffer.concat([
    Buffer.from([InstructionDiscriminant.CreateSessionKey]),
    Buffer.from([bump]),
    args.sessionKeypair.publicKey.toBuffer(),
    encodeI64(args.durationSecs),
    encodeU64(args.maxAmountLamports),
    encodeU64(args.maxPerTxLamports),
  ]);

  return new TransactionInstruction({
    programId: SEAL_PROGRAM_ID,
    keys: [
      {
        pubkey: args.agentKeypair.publicKey,
        isSigner: true,
        isWritable: true,
      },
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: agentPda, isSigner: false, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data,
  });
}

/**
 * Build a RevokeSession instruction for the Seal program.
 */
export function buildRevokeSessionInstruction(args: {
  authority: PublicKey;
  walletOwner: PublicKey;
  agent: PublicKey;
  sessionPubkey: PublicKey;
}): TransactionInstruction {
  const [walletPda] = deriveWalletPda(args.walletOwner);
  const [sessionPda] = deriveSessionPda(walletPda, args.agent, args.sessionPubkey);

  return new TransactionInstruction({
    programId: SEAL_PROGRAM_ID,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: walletPda, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([InstructionDiscriminant.RevokeSession]),
  });
}

/**
 * Send a CreateSession transaction on-chain.
 *
 * When `fundSessionLamports` is provided, a TransferLamports instruction
 * is bundled into the SAME transaction so session creation + funding is
 * atomic — either both succeed or both fail. This eliminates the race
 * condition where a session is created but unfunded.
 *
 * Returns the transaction signature and session PDA.
 */
export async function createSessionOnChain(
  args: CreateSessionArgs & { fundSessionLamports?: bigint }
): Promise<{ signature: string; sessionPda: PublicKey }> {
  const connection = getConnection();
  const tx = new Transaction();

  // 1. CreateSession instruction
  tx.add(buildCreateSessionInstruction(args));

  const [walletPda] = deriveWalletPda(args.walletOwner);
  const [sessionPda] = deriveSessionPda(
    walletPda,
    args.agentKeypair.publicKey,
    args.sessionKeypair.publicKey
  );

  const signers: Keypair[] = [args.agentKeypair];

  // 2. Optionally bundle TransferLamports to fund the session keypair.
  //    Solana processes instructions sequentially within a TX, so the
  //    session PDA created by instruction 1 is available for instruction 2.
  if (args.fundSessionLamports && args.fundSessionLamports > 0n) {
    tx.add(
      buildTransferLamportsInstruction({
        sessionKeypair: args.sessionKeypair,
        walletOwner: args.walletOwner,
        agentPubkey: args.agentKeypair.publicKey,
        destination: args.sessionKeypair.publicKey,
        amountLamports: args.fundSessionLamports,
      })
    );
    // Session keypair must also sign (TransferLamports account #0 = signer)
    signers.push(args.sessionKeypair);
  }

  const signature = await sendAndConfirmTransaction(connection, tx, signers);

  return { signature, sessionPda };
}

/**
 * Check if a Seal wallet exists on-chain for the given owner.
 */
export async function checkWalletExists(
  ownerAddress: PublicKey
): Promise<{ exists: boolean; pda: PublicKey }> {
  const connection = getConnection();
  const [pda] = deriveWalletPda(ownerAddress);
  const account = await connection.getAccountInfo(pda);
  return { exists: account !== null, pda };
}

/**
 * Check if an agent config exists on-chain.
 */
export async function checkAgentExists(
  walletPda: PublicKey,
  agentPubkey: PublicKey
): Promise<{ exists: boolean; pda: PublicKey }> {
  const connection = getConnection();
  const [pda] = deriveAgentPda(walletPda, agentPubkey);
  const account = await connection.getAccountInfo(pda);
  return { exists: account !== null, pda };
}

// ═══════════════════════════════════════════════════════════════
// TransferLamports (disc 13) — move SOL from wallet PDA out
// ═══════════════════════════════════════════════════════════════

/**
 * Build a TransferLamports instruction for the Seal program.
 *
 * Moves SOL from the wallet PDA to a destination, authorized by
 * a valid session key. Used to fund session keypairs for tx fees.
 *
 * Accounts:
 *   0. session key (signer)
 *   1. wallet PDA (writable)
 *   2. agent config PDA (writable)
 *   3. session PDA (writable)
 *   4. destination (writable)
 *
 * Data: [disc=13][amount_u64_LE]
 */
export function buildTransferLamportsInstruction(args: {
  sessionKeypair: Keypair;
  walletOwner: PublicKey;
  agentPubkey: PublicKey;
  destination: PublicKey;
  amountLamports: bigint;
}): TransactionInstruction {
  const [walletPda] = deriveWalletPda(args.walletOwner);
  const [agentPda] = deriveAgentPda(walletPda, args.agentPubkey);
  const [sessionPda] = deriveSessionPda(
    walletPda,
    args.agentPubkey,
    args.sessionKeypair.publicKey
  );

  const data = Buffer.concat([
    Buffer.from([InstructionDiscriminant.TransferLamports]),
    encodeU64(args.amountLamports),
  ]);

  return new TransactionInstruction({
    programId: SEAL_PROGRAM_ID,
    keys: [
      { pubkey: args.sessionKeypair.publicKey, isSigner: true, isWritable: false },
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: agentPda, isSigner: false, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: args.destination, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Fund a session keypair from the wallet PDA using TransferLamports.
 *
 * If feePayerKeypair is provided, it pays the TX fee (useful when the
 * session keypair has 0 SOL). Otherwise the session keypair pays.
 */
export async function fundSessionFromWallet(args: {
  sessionKeypair: Keypair;
  walletOwner: PublicKey;
  agentPubkey: PublicKey;
  amountLamports: bigint;
  feePayerKeypair?: Keypair;
}): Promise<string> {
  const connection = getConnection();
  const ix = buildTransferLamportsInstruction({
    sessionKeypair: args.sessionKeypair,
    walletOwner: args.walletOwner,
    agentPubkey: args.agentPubkey,
    destination: args.sessionKeypair.publicKey,
    amountLamports: args.amountLamports,
  });
  const tx = new Transaction().add(ix);
  const signers: Keypair[] = [args.sessionKeypair];
  if (args.feePayerKeypair) {
    tx.feePayer = args.feePayerKeypair.publicKey;
    signers.unshift(args.feePayerKeypair);
  }
  return sendAndConfirmTransaction(connection, tx, signers);
}
