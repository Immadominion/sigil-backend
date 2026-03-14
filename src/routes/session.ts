import { Hono } from "hono";
import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import { pairingTokens, agents, sessions, activityLog, pendingApprovals, wallets } from "../db/schema.js";
import { createSession, revokeAgentSessions } from "../services/session-broker.js";
import { eventBus } from "../services/event-bus.js";

const session = new Hono();

// Pairing token format: sgil_ followed by 32 alphanumeric chars from nanoid
const PAIRING_TOKEN_REGEX = /^sgil_[A-Za-z0-9_-]{21,64}$/;

// ═══════════════════════════════════════════════════════════════
// Pairing token authentication middleware (for agent endpoints)
// ═══════════════════════════════════════════════════════════════
async function pairingAuth(
  token: string
): Promise<{ agentId: number; pairingTokenId: number } | null> {
  // Validate token format and length to prevent DoS via oversized bcrypt input
  if (!PAIRING_TOKEN_REGEX.test(token)) {
    return null;
  }

  // Find all non-revoked, non-expired pairing tokens and check hashes
  // This is O(N) bcrypt compares, but N is small (few tokens per agent)
  const allTokens = await db.query.pairingTokens.findMany({
    where: and(
      eq(pairingTokens.revoked, false),
      gt(pairingTokens.expiresAt, new Date())
    ),
    with: {
      agent: {
        columns: { id: true, status: true },
      },
    },
  });

  for (const pt of allTokens) {
    const matches = await bcrypt.compare(token, pt.tokenHash);
    if (matches) {
      if (pt.agent.status !== "active") {
        return null; // Agent is suspended/deregistered
      }

      // Update last used timestamp
      await db
        .update(pairingTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(pairingTokens.id, pt.id));

      return { agentId: pt.agentId, pairingTokenId: pt.id };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// POST /request — Agent requests a new session via pairing token
// ═══════════════════════════════════════════════════════════════
const sessionRequestBody = z.object({
  durationSecs: z.number().min(60).max(7 * 24 * 3600).optional(),
  maxAmountSol: z.number().min(0.001).max(1000).optional(),
  maxPerTxSol: z.number().min(0.001).max(100).optional(),
});

session.post("/request", async (c) => {
  // Extract pairing token from Authorization header
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing pairing token" }, 401);
  }

  const token = authHeader.slice(7);
  const auth = await pairingAuth(token);
  if (!auth) {
    return c.json({ error: "Invalid or expired pairing token" }, 401);
  }

  const parsed = sessionRequestBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  // Check if agent has auto-approve enabled
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, auth.agentId),
    with: { wallet: true },
  });

  if (!agent) {
    return c.json({ error: "Agent not found" }, 404);
  }

  // Check if wallet is locked
  const wallet = await db.query.wallets.findFirst({
    where: eq(wallets.id, agent.walletId),
  });

  if (wallet?.isLocked) {
    return c.json(
      { error: "Wallet is locked. No new sessions can be created." },
      403
    );
  }

  if (!agent.autoApprove) {
    // Store pending approval request
    const durationSecs = parsed.data.durationSecs ?? 24 * 60 * 60;
    const maxAmountLamports = Math.round(
      (parsed.data.maxAmountSol ?? 5) * 1_000_000_000
    );
    const maxPerTxLamports = Math.round(
      (parsed.data.maxPerTxSol ?? 1) * 1_000_000_000
    );

    const [pending] = await db
      .insert(pendingApprovals)
      .values({
        agentId: auth.agentId,
        pairingTokenId: auth.pairingTokenId,
        walletId: agent.walletId,
        durationSecs,
        maxAmountLamports,
        maxPerTxLamports,
      })
      .returning();

    // Push SSE event to the wallet owner's app
    eventBus.emit({
      type: "session_created", // reuse type; data.status distinguishes
      walletId: agent.walletId,
      data: {
        approvalId: pending!.id,
        agentId: auth.agentId,
        agentName: agent.name,
        status: "pending_approval",
        durationSecs,
        maxAmountLamports,
        maxPerTxLamports,
      },
      timestamp: new Date().toISOString(),
    });

    return c.json(
      {
        error: "Manual approval required",
        message: "Session request has been queued. Approve it in the Sigil app.",
        status: "pending_approval",
        approvalId: pending!.id,
      },
      202
    );
  }

  try {
    const result = await createSession({
      agentId: auth.agentId,
      pairingTokenId: auth.pairingTokenId,
      durationSecs: parsed.data.durationSecs,
      maxAmountSol: parsed.data.maxAmountSol,
      maxPerTxSol: parsed.data.maxPerTxSol,
    });

    return c.json(result, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Session creation failed";
    return c.json({ error: message }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /info — Get current session info for an agent (via pairing token)
// ═══════════════════════════════════════════════════════════════
session.get("/info", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing pairing token" }, 401);
  }

  const token = authHeader.slice(7);
  const auth = await pairingAuth(token);
  if (!auth) {
    return c.json({ error: "Invalid or expired pairing token" }, 401);
  }

  const activeSessions = await db.query.sessions.findMany({
    where: and(
      eq(sessions.agentId, auth.agentId),
      eq(sessions.isActive, true)
    ),
    columns: {
      id: true,
      sessionPda: true,
      sessionPubkey: true,
      walletPda: true,
      agentConfigPda: true,
      expiresAt: true,
      maxAmountLamports: true,
      maxPerTxLamports: true,
      isActive: true,
      createdAt: true,
      // encryptedSessionSecret is NOT returned here
    },
  });

  return c.json(activeSessions);
});

// ═══════════════════════════════════════════════════════════════
// POST /heartbeat — Agent reports status (via pairing token)
// ═══════════════════════════════════════════════════════════════
const heartbeatBody = z.object({
  sessionPda: z.string(),
  status: z.enum(["active", "idle", "trading"]).optional().default("active"),
  metadata: z.record(z.unknown()).optional(),
});

session.post("/heartbeat", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing pairing token" }, 401);
  }

  const token = authHeader.slice(7);
  const auth = await pairingAuth(token);
  if (!auth) {
    return c.json({ error: "Invalid or expired pairing token" }, 401);
  }

  const parsed = heartbeatBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request" }, 400);
  }

  // Log the heartbeat — validate session belongs to this agent
  const activeSession = await db.query.sessions.findFirst({
    where: and(
      eq(sessions.sessionPda, parsed.data.sessionPda),
      eq(sessions.agentId, auth.agentId),
      eq(sessions.isActive, true),
    ),
  });

  if (!activeSession) {
    return c.json({ error: "Session not found or does not belong to this agent" }, 404);
  }

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, auth.agentId),
  });

  if (agent) {
    // Sanitize metadata: only allow string/number values, limit keys
    const safeMetadata: Record<string, string | number> = {};
    if (parsed.data.metadata) {
      const keys = Object.keys(parsed.data.metadata).slice(0, 10);
      for (const k of keys) {
        const v = parsed.data.metadata[k];
        if (typeof v === "string") safeMetadata[k] = v.slice(0, 200);
        else if (typeof v === "number") safeMetadata[k] = v;
      }
    }

    await db.insert(activityLog).values({
      walletId: agent.walletId,
      agentId: auth.agentId,
      action: "agent_heartbeat",
      details: {
        sessionPda: parsed.data.sessionPda,
        status: parsed.data.status,
        ...safeMetadata,
      },
    });

    eventBus.emit({
      type: "agent_heartbeat",
      walletId: agent.walletId,
      data: {
        agentId: auth.agentId,
        agentName: agent.name,
        sessionPda: parsed.data.sessionPda,
        status: parsed.data.status,
      },
      timestamp: new Date().toISOString(),
    });
  }

  return c.json({ acknowledged: true });
});

export default session;
