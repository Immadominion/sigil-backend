import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { db } from "../db/index.js";
import { wallets, agents, sessions, activityLog } from "../db/schema.js";
import { jwtAuth, getAuthPayload } from "../middleware/auth.js";
import { checkWalletExists } from "../services/solana.js";
import { revokeAgentSessions } from "../services/session-broker.js";
import { eventBus } from "../services/event-bus.js";

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

export default wallet;
