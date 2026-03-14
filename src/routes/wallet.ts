import { Hono } from "hono";
import { eq, and, isNotNull } from "drizzle-orm";
import {
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import { db } from "../db/index.js";
import { wallets, agents, sessions, activityLog } from "../db/schema.js";
import { jwtAuth, getAuthPayload } from "../middleware/auth.js";
import {
  checkWalletExists,
  getConnection,
  deriveWalletPda,
  deriveAgentPda,
  SEAL_PROGRAM_ID,
} from "../services/solana.js";
import { decryptKeypairSecret } from "../services/crypto.js";
import { revokeAgentSessions } from "../services/session-broker.js";
import { eventBus } from "../services/event-bus.js";
import { config } from "../config.js";

const wallet = new Hono();
wallet.use("*", jwtAuth);

// ═══════════════════════════════════════════════════════════════
// GET / — Get the authenticated user's Seal wallet info
// ═══════════════════════════════════════════════════════════════
wallet.get("/", async (c) => {
  const { walletId } = getAuthPayload(c);

  const w = await db.query.wallets.findFirst({
    where: eq(wallets.id, walletId),
  });

  if (!w) {
    return c.json({ error: "Wallet not found" }, 404);
  }

  // Check on-chain status
  const { exists } = await checkWalletExists(new PublicKey(w.ownerAddress));

  return c.json({
    ...w,
    onChain: exists,
    isLocked: w.isLocked,
  });
});

// ═══════════════════════════════════════════════════════════════
// PUT / — Update wallet label
// ═══════════════════════════════════════════════════════════════
wallet.put("/", async (c) => {
  const { walletId } = getAuthPayload(c);
  const { label } = await c.req.json<{ label?: string }>();

  const [updated] = await db
    .update(wallets)
    .set({ label })
    .where(eq(wallets.id, walletId))
    .returning();

  return c.json(updated);
});

// ═══════════════════════════════════════════════════════════════
// POST /revoke-all — Emergency: revoke ALL sessions for ALL agents
// ═══════════════════════════════════════════════════════════════
wallet.post("/revoke-all", async (c) => {
  const { walletId } = getAuthPayload(c);

  // Find all agents belonging to this wallet
  const walletAgents = await db.query.agents.findMany({
    where: eq(agents.walletId, walletId),
    columns: { id: true, name: true },
  });

  let totalRevoked = 0;
  for (const agent of walletAgents) {
    totalRevoked += await revokeAgentSessions(agent.id);
  }

  // Log the emergency action
  await db.insert(activityLog).values({
    walletId,
    action: "emergency_revoke_all",
    details: {
      agentsAffected: walletAgents.length,
      sessionsRevoked: totalRevoked,
    },
  });

  eventBus.emit({
    type: "sessions_revoked_all",
    walletId,
    data: {
      agentsAffected: walletAgents.length,
      sessionsRevoked: totalRevoked,
    },
    timestamp: new Date().toISOString(),
  });

  return c.json({
    success: true,
    agentsAffected: walletAgents.length,
    sessionsRevoked: totalRevoked,
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /lock — Lock the wallet (blocks all new session creation)
// ═══════════════════════════════════════════════════════════════
wallet.post("/lock", async (c) => {
  const { walletId } = getAuthPayload(c);

  const [updated] = await db
    .update(wallets)
    .set({ isLocked: true })
    .where(eq(wallets.id, walletId))
    .returning();

  await db.insert(activityLog).values({
    walletId,
    action: "wallet_locked",
    details: { lockedAt: new Date().toISOString() },
  });

  eventBus.emit({
    type: "sessions_revoked_all",
    walletId,
    data: { action: "wallet_locked" },
    timestamp: new Date().toISOString(),
  });

  return c.json({ success: true, isLocked: true });
});

// ═══════════════════════════════════════════════════════════════
// POST /unlock — Unlock the wallet (allow session creation again)
// ═══════════════════════════════════════════════════════════════
wallet.post("/unlock", async (c) => {
  const { walletId } = getAuthPayload(c);

  const [updated] = await db
    .update(wallets)
    .set({ isLocked: false })
    .where(eq(wallets.id, walletId))
    .returning();

  await db.insert(activityLog).values({
    walletId,
    action: "wallet_unlocked",
    details: { unlockedAt: new Date().toISOString() },
  });

  eventBus.emit({
    type: "sessions_revoked_all",
    walletId,
    data: { action: "wallet_unlocked" },
    timestamp: new Date().toISOString(),
  });

  return c.json({ success: true, isLocked: false });
});

// ═══════════════════════════════════════════════════════════════
// GET /balance — SOL breakdown (wallet PDA + session signers)
// ═══════════════════════════════════════════════════════════════
wallet.get("/balance", async (c) => {
  const { walletId, sub: ownerAddress } = getAuthPayload(c);
  const ownerPubkey = new PublicKey(ownerAddress);
  const connection = getConnection();

  // Wallet PDA balance
  let walletLamports = 0;
  try {
    const [walletPda] = deriveWalletPda(ownerPubkey);
    walletLamports = await connection.getBalance(walletPda);
  } catch { /* wallet may not exist */ }

  // Session signer balances
  let sessionLamports = 0;
  const activeSessions = await db
    .select({
      sessionPubkey: sessions.sessionPubkey,
    })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(and(
      eq(agents.walletId, walletId),
      eq(sessions.isActive, true),
      isNotNull(sessions.sessionPubkey),
    ));

  const seen = new Set<string>();
  for (const row of activeSessions) {
    if (seen.has(row.sessionPubkey)) continue;
    seen.add(row.sessionPubkey);
    try {
      const bal = await connection.getBalance(new PublicKey(row.sessionPubkey));
      sessionLamports += bal;
    } catch { /* ignore */ }
  }

  const totalLamports = walletLamports + sessionLamports;
  return c.json({
    success: true,
    lamports: totalLamports,
    sol: +(totalLamports / LAMPORTS_PER_SOL).toFixed(6),
    walletLamports,
    sessionLamports,
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /withdraw — Withdraw SOL from session signers + wallet PDA
// ═══════════════════════════════════════════════════════════════

function buildDeregisterAgentIx(
  owner: PublicKey,
  walletPda: PublicKey,
  agentPda: PublicKey
) {
  return {
    programId: SEAL_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: agentPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([8]), // DeregisterAgent
  };
}

function buildCloseWalletIx(owner: PublicKey, walletPda: PublicKey) {
  return {
    programId: SEAL_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: walletPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([9]), // CloseWallet
  };
}

wallet.post("/withdraw", async (c) => {
  const { walletId, sub: ownerAddress } = getAuthPayload(c);
  const ownerPubkey = new PublicKey(ownerAddress);
  const connection = getConnection();

  const body = await c.req.json<{ amountSol?: number }>().catch(() => ({ amountSol: 0 }));
  const requestedSol = body.amountSol ?? 0;
  const requestedLamports = Math.floor(requestedSol * LAMPORTS_PER_SOL);
  const drainAll = requestedLamports === 0;

  // ── Check wallet PDA balance ──
  let walletPdaLamports = 0;
  let walletPda: PublicKey | null = null;
  let walletAccountExists = false;
  try {
    [walletPda] = deriveWalletPda(ownerPubkey);
    const walletAccount = await connection.getAccountInfo(walletPda);
    walletAccountExists = !!walletAccount;
    if (walletAccountExists) {
      walletPdaLamports = await connection.getBalance(walletPda);
    }
  } catch { /* wallet may not exist */ }

  // ── Fetch all session signers (with decryptable secrets) ──
  const sessionRows = await db
    .select({
      sessionId: sessions.id,
      sessionPubkey: sessions.sessionPubkey,
      encryptedSessionSecret: sessions.encryptedSessionSecret,
      agentPubkey: agents.agentPubkey,
      agentName: agents.name,
      agentId: agents.id,
    })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(and(
      eq(agents.walletId, walletId),
      isNotNull(sessions.sessionPubkey),
      isNotNull(sessions.encryptedSessionSecret),
    ));

  // Deduplicate by sessionPubkey and get on-chain balances
  const seen = new Set<string>();
  const sources: {
    kp: Keypair;
    balance: number;
    agentName: string;
    agentPubkey: string;
  }[] = [];

  for (const row of sessionRows) {
    if (seen.has(row.sessionPubkey)) continue;
    seen.add(row.sessionPubkey);
    try {
      const secretKey = decryptKeypairSecret(row.encryptedSessionSecret);
      const kp = Keypair.fromSecretKey(secretKey);
      const balance = await connection.getBalance(kp.publicKey);
      if (balance > 0) {
        sources.push({ kp, balance, agentName: row.agentName, agentPubkey: row.agentPubkey });
      }
    } catch (err: any) {
      console.error(`[withdraw] Failed to check session signer: ${err?.message}`);
    }
  }

  const totalSessionLamports = sources.reduce((sum, s) => sum + s.balance, 0);
  const totalAvailable = totalSessionLamports + walletPdaLamports;

  if (totalAvailable === 0) {
    return c.json({
      error: "No funds available to withdraw. All session signers and wallet PDA are at 0 SOL.",
    }, 404);
  }

  // Sort largest-balance-first for efficient draining
  sources.sort((a, b) => b.balance - a.balance);

  // Build transaction
  const tx = new Transaction();
  tx.feePayer = ownerPubkey;
  const signers: Keypair[] = [];
  let sessionDrained = 0;
  const drainDetails: { agent: string; lamports: number }[] = [];

  // ── 1. Drain session signers ──
  if (drainAll) {
    for (const source of sources) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: source.kp.publicKey,
          toPubkey: ownerPubkey,
          lamports: source.balance,
        })
      );
      signers.push(source.kp);
      drainDetails.push({ agent: source.agentName, lamports: source.balance });
      sessionDrained += source.balance;
    }
  } else {
    let remaining = Math.min(requestedLamports, totalSessionLamports);
    for (const source of sources) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, source.balance);
      tx.add(
        SystemProgram.transfer({
          fromPubkey: source.kp.publicKey,
          toPubkey: ownerPubkey,
          lamports: take,
        })
      );
      signers.push(source.kp);
      drainDetails.push({ agent: source.agentName, lamports: take });
      sessionDrained += take;
      remaining -= take;
    }
  }

  // ── 2. Close wallet PDA to recover its SOL (only when draining all) ──
  let closesWallet = false;
  if (drainAll && walletAccountExists && walletPda && walletPdaLamports > 0) {
    // Deregister all agents so CloseWallet can succeed
    const uniqueAgents = [
      ...new Set(
        sessionRows
          .map((r) => r.agentPubkey)
          .filter((v): v is string => Boolean(v))
      ),
    ];
    for (const agentPubkeyStr of uniqueAgents) {
      const agentPubkey = new PublicKey(agentPubkeyStr);
      const [agentPda] = deriveAgentPda(walletPda, agentPubkey);
      const agentAccount = await connection.getAccountInfo(agentPda);
      if (agentAccount) {
        tx.add(buildDeregisterAgentIx(ownerPubkey, walletPda, agentPda));
      }
    }
    tx.add(buildCloseWalletIx(ownerPubkey, walletPda));
    closesWallet = true;
  }

  if (tx.instructions.length === 0) {
    return c.json({ error: "No funds available to withdraw." }, 404);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  // Backend signs with session signers
  for (const signer of signers) {
    tx.partialSign(signer);
  }

  const totalWithdrawLamports = sessionDrained + (closesWallet ? walletPdaLamports : 0);
  const withdrawSol = totalWithdrawLamports / LAMPORTS_PER_SOL;

  // Log the withdrawal attempt
  await db.insert(activityLog).values({
    walletId,
    action: "withdraw_initiated",
    details: {
      withdrawSol: +withdrawSol.toFixed(6),
      closesWallet,
      sessionsDrained: drainDetails.length,
    },
  });

  return c.json({
    success: true,
    transaction: tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString("base64"),
    network: config.SOLANA_CLUSTER,
    withdrawSol: +withdrawSol.toFixed(6),
    totalAvailableSol: +(totalAvailable / LAMPORTS_PER_SOL).toFixed(6),
    walletPdaSol: +(walletPdaLamports / LAMPORTS_PER_SOL).toFixed(6),
    closesWallet,
    details: drainDetails.map((d) => ({
      agent: d.agent,
      sol: +(d.lamports / LAMPORTS_PER_SOL).toFixed(6),
    })),
    blockhash,
    lastValidBlockHeight,
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /submit-signed — Submit a fully-signed transaction
// ═══════════════════════════════════════════════════════════════
wallet.post("/submit-signed", async (c) => {
  const { walletId } = getAuthPayload(c);
  const body = await c.req.json<{ transaction: string }>();

  if (!body.transaction) {
    return c.json({ error: "Missing transaction field" }, 400);
  }

  const connection = getConnection();
  const txBuffer = Buffer.from(body.transaction, "base64");

  const signature = await sendAndConfirmRawTransaction(
    connection,
    txBuffer,
    { commitment: "confirmed" }
  );

  await db.insert(activityLog).values({
    walletId,
    action: "transaction_submitted",
    details: { signature },
    txSignature: signature,
  });

  return c.json({ success: true, signature });
});

export default wallet;
