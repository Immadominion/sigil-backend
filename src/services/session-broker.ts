import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents, sessions, pairingTokens, activityLog } from "../db/schema.js";
import { encryptKeypairSecret, decryptKeypairSecret } from "./crypto.js";
import {
  createSessionOnChain,
  deriveWalletPda,
  deriveSessionPda,
  deriveAgentPda,
  getConnection,
} from "./solana.js";
import { eventBus } from "./event-bus.js";

export interface SessionRequest {
  agentId: number;
  pairingTokenId: number;
  durationSecs?: number;
  maxAmountSol?: number;
  maxPerTxSol?: number;
}

export interface SessionResult {
  sessionPubkey: string;
  sessionSecretKey: string; // base64 encoded (transmitted over HTTPS only)
  sessionPda: string;
  walletPda: string;
  agentConfigPda: string;
  agentPubkey: string;
  expiresAt: string;
  maxAmountLamports: string;
  maxPerTxLamports: string;
  txSignature: string;
}

const LAMPORTS_PER_SOL = 1_000_000_000;
const DEFAULT_SESSION_DURATION = 24 * 60 * 60; // 24 hours
const DEFAULT_MAX_AMOUNT_SOL = 5;
const DEFAULT_MAX_PER_TX_SOL = 1;

/**
 * Create a new session for an agent based on a validated pairing token.
 *
 * Flow:
 * 1. Load agent from DB
 * 2. Decrypt agent keypair
 * 3. Generate ephemeral session keypair
 * 4. Submit CreateSession transaction on-chain
 * 5. Encrypt & store session keypair
 * 6. Return session credentials to the requesting agent
 */
export async function createSession(
  request: SessionRequest
): Promise<SessionResult> {
  // 1. Load agent
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, request.agentId),
    with: { wallet: true },
  });

  if (!agent) {
    throw new Error("Agent not found");
  }
  if (agent.status !== "active") {
    throw new Error(`Agent is ${agent.status}`);
  }

  // 2. Decrypt agent keypair
  const agentSecretKey = decryptKeypairSecret(agent.encryptedSecret);
  const agentKeypair = Keypair.fromSecretKey(agentSecretKey);

  // Verify pubkey matches
  if (agentKeypair.publicKey.toBase58() !== agent.agentPubkey) {
    throw new Error("Agent keypair mismatch — data integrity error");
  }

  // 3. Generate ephemeral session keypair
  const sessionKeypair = Keypair.generate();
  const walletOwner = new PublicKey(agent.wallet.ownerAddress);

  // Resolve session parameters (use agent limits as caps)
  const durationSecs =
    request.durationSecs ?? DEFAULT_SESSION_DURATION;
  const requestedMaxAmount =
    (request.maxAmountSol ?? DEFAULT_MAX_AMOUNT_SOL) * LAMPORTS_PER_SOL;
  const requestedMaxPerTx =
    (request.maxPerTxSol ?? DEFAULT_MAX_PER_TX_SOL) * LAMPORTS_PER_SOL;

  // Cap at agent-level limits
  const maxAmountLamports = Math.min(requestedMaxAmount, agent.dailyLimitLamports);
  const maxPerTxLamports = Math.min(requestedMaxPerTx, agent.perTxLimitLamports);

  // 4. Submit on-chain (convert to BigInt for instruction encoding)
  const { signature, sessionPda } = await createSessionOnChain({
    agentKeypair,
    walletOwner,
    sessionKeypair,
    durationSecs: BigInt(durationSecs),
    maxAmountLamports: BigInt(maxAmountLamports),
    maxPerTxLamports: BigInt(maxPerTxLamports),
  });

  // 4a. Fund session keypair from agent keypair (~0.005 SOL for tx fees)
  // The agent keypair was funded during RegisterAgent in the Sigil app.
  const SESSION_FEE_FUND = 5_000_000; // 0.005 SOL — enough for ~1000 tx fees
  try {
    const connection = getConnection();
    const agentBalance = await connection.getBalance(agentKeypair.publicKey);
    if (agentBalance > SESSION_FEE_FUND + 5000) {
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: agentKeypair.publicKey,
          toPubkey: sessionKeypair.publicKey,
          lamports: SESSION_FEE_FUND,
        })
      );
      await sendAndConfirmTransaction(connection, fundTx, [agentKeypair]);
    }
  } catch (err) {
    // Non-fatal — session still created, agent SDK can fund later
    console.warn("Session fee funding failed (non-fatal):", err);
  }

  const [walletPda] = deriveWalletPda(walletOwner);
  const expiresAt = new Date(Date.now() + durationSecs * 1000);

  // 5. Encrypt & store
  const encryptedSessionSecret = encryptKeypairSecret(
    sessionKeypair.secretKey
  );

  const [inserted] = await db
    .insert(sessions)
    .values({
      agentId: agent.id,
      pairingTokenId: request.pairingTokenId,
      sessionPda: sessionPda.toBase58(),
      sessionPubkey: sessionKeypair.publicKey.toBase58(),
      encryptedSessionSecret,
      walletPda: walletPda.toBase58(),
      agentConfigPda: agent.agentConfigPda,
      expiresAt,
      maxAmountLamports,
      maxPerTxLamports,
      txSignature: signature,
    })
    .returning();

  // 6. Log activity
  await db.insert(activityLog).values({
    walletId: agent.walletId,
    agentId: agent.id,
    action: "session_created",
    details: {
      sessionPda: sessionPda.toBase58(),
      durationSecs: durationSecs.toString(),
      maxAmountLamports: maxAmountLamports.toString(),
    },
    txSignature: signature,
  });

  // 7. Return credentials
  // The session secret key is transmitted over HTTPS to the requesting agent.
  // The agent uses this to sign transactions directly against the Solana network.

  // 7a. Emit SSE event
  eventBus.emit({
    type: "session_created",
    walletId: agent.walletId,
    data: {
      agentId: agent.id,
      agentName: agent.name,
      sessionPda: sessionPda.toBase58(),
      expiresAt: expiresAt.toISOString(),
    },
    timestamp: new Date().toISOString(),
  });

  return {
    sessionPubkey: sessionKeypair.publicKey.toBase58(),
    sessionSecretKey: Buffer.from(sessionKeypair.secretKey).toString("base64"),
    sessionPda: sessionPda.toBase58(),
    walletPda: walletPda.toBase58(),
    agentConfigPda: agent.agentConfigPda,
    agentPubkey: agent.agentPubkey,
    expiresAt: expiresAt.toISOString(),
    maxAmountLamports: maxAmountLamports.toString(),
    maxPerTxLamports: maxPerTxLamports.toString(),
    txSignature: signature,
  };
}

/**
 * Revoke all active sessions for an agent.
 */
export async function revokeAgentSessions(agentId: number): Promise<number> {
  const result = await db
    .update(sessions)
    .set({ isActive: false })
    .where(and(eq(sessions.agentId, agentId), eq(sessions.isActive, true)))
    .returning();

  return result.length;
}

/**
 * Get active session for an agent (most recent).
 */
export async function getActiveSession(agentId: number) {
  return db.query.sessions.findFirst({
    where: and(eq(sessions.agentId, agentId), eq(sessions.isActive, true)),
    orderBy: (s, { desc }) => desc(s.createdAt),
  });
}
