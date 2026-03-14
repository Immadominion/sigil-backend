import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { db } from "../db/index.js";
import { agents, activityLog, pendingApprovals } from "../db/schema.js";
import { jwtAuth, getAuthPayload } from "../middleware/auth.js";
import { encryptKeypairSecret } from "../services/crypto.js";
import { deriveWalletPda, deriveAgentPda, checkAgentExists } from "../services/solana.js";
import { revokeAgentSessions, createSession } from "../services/session-broker.js";
import { eventBus } from "../services/event-bus.js";

const agent = new Hono();
agent.use("*", jwtAuth);

// ═══════════════════════════════════════════════════════════════
// GET / — List all agents for the authenticated wallet
// ═══════════════════════════════════════════════════════════════
agent.get("/", async (c) => {
  const { walletId } = getAuthPayload(c);

  const result = await db.query.agents.findMany({
    where: eq(agents.walletId, walletId),
    with: {
      pairingTokens: {
        columns: { id: true, label: true, revoked: true, expiresAt: true, createdAt: true },
      },
      sessions: {
        columns: { id: true, sessionPda: true, isActive: true, expiresAt: true, createdAt: true },
      },
    },
    orderBy: (a, { desc }) => desc(a.createdAt),
  });

  // Strip encrypted secrets from response
  return c.json(
    result.map(({ encryptedSecret, ...rest }) => rest)
  );
});

// ═══════════════════════════════════════════════════════════════
// POST / — Register a new agent
// ═══════════════════════════════════════════════════════════════
const createAgentBody = z.object({
  name: z.string().min(1).max(32),
  allowedPrograms: z.array(z.string()).optional().default([]),
  autoApprove: z.boolean().optional().default(false),
  dailyLimitSol: z.number().min(0.01).max(1000).optional().default(5),
  perTxLimitSol: z.number().min(0.01).max(100).optional().default(1),
});

agent.post("/", async (c) => {
  const { walletId, sub: ownerAddress } = getAuthPayload(c);
  const parsed = createAgentBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { name, allowedPrograms, autoApprove, dailyLimitSol, perTxLimitSol } = parsed.data;

  // Validate allowed program addresses
  for (const prog of allowedPrograms) {
    try {
      new PublicKey(prog);
    } catch {
      return c.json({ error: `Invalid program address: ${prog}` }, 400);
    }
  }

  // Generate agent keypair
  const agentKeypair = Keypair.generate();
  const encryptedSecret = encryptKeypairSecret(agentKeypair.secretKey);

  // Derive PDAs
  const [walletPda] = deriveWalletPda(new PublicKey(ownerAddress));
  const [agentConfigPda] = deriveAgentPda(walletPda, agentKeypair.publicKey);

  const [inserted] = await db
    .insert(agents)
    .values({
      walletId,
      agentPubkey: agentKeypair.publicKey.toBase58(),
      encryptedSecret,
      agentConfigPda: agentConfigPda.toBase58(),
      name,
      allowedPrograms,
      autoApprove,
      dailyLimitLamports: Math.round(dailyLimitSol * 1e9),
      perTxLimitLamports: Math.round(perTxLimitSol * 1e9),
    })
    .returning();

  // Log activity
  await db.insert(activityLog).values({
    walletId,
    agentId: inserted!.id,
    action: "agent_registered",
    details: { name, agentPubkey: agentKeypair.publicKey.toBase58() },
  });

  // Return agent info (without encrypted secret, but with the pubkey
  // the user needs to register on-chain via their wallet)
  const { encryptedSecret: _, ...agentData } = inserted!;
  return c.json(
    {
      ...agentData,
      // The user's app must call RegisterAgent on-chain with this pubkey
      registrationRequired: true,
      instructions: "Use your wallet to call RegisterAgent on the Seal program with this agent pubkey.",
    },
    201
  );
});

// ═══════════════════════════════════════════════════════════════
// GET /approvals — List pending session approval requests
// (Must be before /:id to prevent "approvals" matching as an id)
// ═══════════════════════════════════════════════════════════════
agent.get("/approvals", async (c) => {
  const { walletId } = getAuthPayload(c);

  const pending = await db.query.pendingApprovals.findMany({
    where: and(
      eq(pendingApprovals.walletId, walletId),
      eq(pendingApprovals.status, "pending")
    ),
    with: {
      agent: { columns: { id: true, name: true, agentPubkey: true } },
    },
    orderBy: (p, { desc }) => desc(p.createdAt),
  });

  return c.json(pending);
});

// ═══════════════════════════════════════════════════════════════
// POST /approvals/:approvalId/approve — Approve a session request
// ═══════════════════════════════════════════════════════════════
agent.post("/approvals/:approvalId/approve", async (c) => {
  const { walletId } = getAuthPayload(c);
  const approvalId = parseInt(c.req.param("approvalId"));

  const approval = await db.query.pendingApprovals.findFirst({
    where: and(
      eq(pendingApprovals.id, approvalId),
      eq(pendingApprovals.walletId, walletId),
      eq(pendingApprovals.status, "pending")
    ),
  });

  if (!approval) {
    return c.json({ error: "Pending approval not found" }, 404);
  }

  try {
    const result = await createSession({
      agentId: approval.agentId,
      pairingTokenId: approval.pairingTokenId,
      durationSecs: approval.durationSecs,
      maxAmountSol: approval.maxAmountLamports / 1_000_000_000,
      maxPerTxSol: approval.maxPerTxLamports / 1_000_000_000,
    });

    await db
      .update(pendingApprovals)
      .set({ status: "approved", resolvedAt: new Date() })
      .where(eq(pendingApprovals.id, approvalId));

    await db.insert(activityLog).values({
      walletId,
      agentId: approval.agentId,
      action: "session_approved",
      details: { approvalId, sessionPda: result.sessionPda },
    });

    return c.json({ success: true, session: result }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Session creation failed";
    return c.json({ error: message }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /approvals/:approvalId/reject — Reject a session request
// ═══════════════════════════════════════════════════════════════
agent.post("/approvals/:approvalId/reject", async (c) => {
  const { walletId } = getAuthPayload(c);
  const approvalId = parseInt(c.req.param("approvalId"));

  const [updated] = await db
    .update(pendingApprovals)
    .set({ status: "rejected", resolvedAt: new Date() })
    .where(
      and(
        eq(pendingApprovals.id, approvalId),
        eq(pendingApprovals.walletId, walletId),
        eq(pendingApprovals.status, "pending")
      )
    )
    .returning();

  if (!updated) {
    return c.json({ error: "Pending approval not found" }, 404);
  }

  await db.insert(activityLog).values({
    walletId,
    agentId: updated.agentId,
    action: "session_rejected",
    details: { approvalId },
  });

  return c.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// GET /:id — Get agent details
// ═══════════════════════════════════════════════════════════════
agent.get("/:id", async (c) => {
  const { walletId } = getAuthPayload(c);
  const agentId = parseInt(c.req.param("id"));

  const result = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.walletId, walletId)),
    with: {
      pairingTokens: true,
      sessions: true,
    },
  });

  if (!result) {
    return c.json({ error: "Agent not found" }, 404);
  }

  // Check on-chain status
  const [walletPda] = deriveWalletPda(new PublicKey(getAuthPayload(c).sub));
  const { exists: onChain } = await checkAgentExists(
    walletPda,
    new PublicKey(result.agentPubkey)
  );

  const { encryptedSecret, ...agentData } = result;
  return c.json({ ...agentData, onChain });
});

// ═══════════════════════════════════════════════════════════════
// PUT /:id — Update agent configuration
// ═══════════════════════════════════════════════════════════════
const updateAgentBody = z.object({
  name: z.string().min(1).max(32).optional(),
  autoApprove: z.boolean().optional(),
  dailyLimitSol: z.number().min(0.01).max(1000).optional(),
  perTxLimitSol: z.number().min(0.01).max(100).optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

agent.put("/:id", async (c) => {
  const { walletId } = getAuthPayload(c);
  const agentId = parseInt(c.req.param("id"));
  const parsed = updateAgentBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name) updates.name = parsed.data.name;
  if (parsed.data.autoApprove !== undefined) updates.autoApprove = parsed.data.autoApprove;
  if (parsed.data.dailyLimitSol) {
    updates.dailyLimitLamports = Math.round(parsed.data.dailyLimitSol * 1e9);
  }
  if (parsed.data.perTxLimitSol) {
    updates.perTxLimitLamports = Math.round(parsed.data.perTxLimitSol * 1e9);
  }
  if (parsed.data.status) updates.status = parsed.data.status;

  const [updated] = await db
    .update(agents)
    .set(updates)
    .where(and(eq(agents.id, agentId), eq(agents.walletId, walletId)))
    .returning();

  if (!updated) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const { encryptedSecret, ...agentData } = updated;
  return c.json(agentData);
});

// ═══════════════════════════════════════════════════════════════
// DELETE /:id — Deregister agent (soft delete)
// ═══════════════════════════════════════════════════════════════
agent.delete("/:id", async (c) => {
  const { walletId } = getAuthPayload(c);
  const agentId = parseInt(c.req.param("id"));

  const [updated] = await db
    .update(agents)
    .set({ status: "deregistered" })
    .where(and(eq(agents.id, agentId), eq(agents.walletId, walletId)))
    .returning();

  if (!updated) {
    return c.json({ error: "Agent not found" }, 404);
  }

  await db.insert(activityLog).values({
    walletId,
    agentId,
    action: "agent_deregistered",
  });

  return c.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// POST /:id/revoke-sessions — Revoke all active sessions for an agent
// ═══════════════════════════════════════════════════════════════
agent.post("/:id/revoke-sessions", async (c) => {
  const { walletId } = getAuthPayload(c);
  const agentId = parseInt(c.req.param("id"));

  // Verify agent belongs to this wallet
  const agentRecord = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.walletId, walletId)),
  });

  if (!agentRecord) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const revokedCount = await revokeAgentSessions(agentId);

  await db.insert(activityLog).values({
    walletId,
    agentId,
    action: "sessions_revoked",
    details: { revokedCount },
  });

  eventBus.emit({
    type: "session_revoked",
    walletId,
    data: { agentId, agentName: agentRecord.name, revokedCount },
    timestamp: new Date().toISOString(),
  });

  return c.json({ success: true, revokedCount });
});

export default agent;
