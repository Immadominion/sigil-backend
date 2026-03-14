import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { pairingTokens, agents, activityLog } from "../db/schema.js";
import { jwtAuth, getAuthPayload } from "../middleware/auth.js";

const pairing = new Hono();
pairing.use("*", jwtAuth);

const BCRYPT_ROUNDS = 12;

// ═══════════════════════════════════════════════════════════════
// POST /:agentId/pairing — Generate a new pairing token
// ═══════════════════════════════════════════════════════════════
const createPairingBody = z.object({
  label: z.string().min(1).max(64).optional().default("default"),
  expiresInDays: z.number().min(1).max(365).optional().default(30),
});

pairing.post("/:agentId/pairing", async (c) => {
  const { walletId } = getAuthPayload(c);
  const agentId = parseInt(c.req.param("agentId"));
  const parsed = createPairingBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  // Verify agent belongs to this wallet
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.walletId, walletId)),
  });

  if (!agent) {
    return c.json({ error: "Agent not found" }, 404);
  }

  // Generate a cryptographically random pairing token
  // Format: sgil_<nanoid(32)> — 'sgil' prefix for identification
  const rawToken = `sgil_${nanoid(32)}`;
  const tokenHash = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);

  const expiresAt = new Date(
    Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000
  );

  const [inserted] = await db
    .insert(pairingTokens)
    .values({
      agentId,
      tokenHash,
      label: parsed.data.label,
      expiresAt,
    })
    .returning();

  // Log activity
  await db.insert(activityLog).values({
    walletId,
    agentId,
    action: "pairing_token_created",
    details: { label: parsed.data.label, tokenId: inserted!.id },
  });

  // Return the raw token ONCE — it cannot be recovered after this
  return c.json(
    {
      id: inserted!.id,
      token: rawToken,
      label: parsed.data.label,
      expiresAt: expiresAt.toISOString(),
      warning: "Store this token securely. It cannot be retrieved again.",
    },
    201
  );
});

// ═══════════════════════════════════════════════════════════════
// GET /:agentId/pairing — List pairing tokens for an agent
// ═══════════════════════════════════════════════════════════════
pairing.get("/:agentId/pairing", async (c) => {
  const { walletId } = getAuthPayload(c);
  const agentId = parseInt(c.req.param("agentId"));

  // Verify agent belongs to this wallet
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.walletId, walletId)),
  });

  if (!agent) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const tokens = await db.query.pairingTokens.findMany({
    where: eq(pairingTokens.agentId, agentId),
    columns: {
      id: true,
      label: true,
      expiresAt: true,
      revoked: true,
      lastUsedAt: true,
      createdAt: true,
      // tokenHash is NEVER returned
    },
    orderBy: (t, { desc }) => desc(t.createdAt),
  });

  return c.json(tokens);
});

// ═══════════════════════════════════════════════════════════════
// DELETE /:agentId/pairing/:tokenId — Revoke a pairing token
// ═══════════════════════════════════════════════════════════════
pairing.delete("/:agentId/pairing/:tokenId", async (c) => {
  const { walletId } = getAuthPayload(c);
  const agentId = parseInt(c.req.param("agentId"));
  const tokenId = parseInt(c.req.param("tokenId"));

  // Verify agent belongs to this wallet
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.walletId, walletId)),
  });

  if (!agent) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const [updated] = await db
    .update(pairingTokens)
    .set({ revoked: true })
    .where(
      and(eq(pairingTokens.id, tokenId), eq(pairingTokens.agentId, agentId))
    )
    .returning();

  if (!updated) {
    return c.json({ error: "Pairing token not found" }, 404);
  }

  await db.insert(activityLog).values({
    walletId,
    agentId,
    action: "pairing_token_revoked",
    details: { tokenId },
  });

  return c.json({ success: true });
});

export default pairing;
