import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { activityLog } from "../db/schema.js";
import { jwtAuth, getAuthPayload } from "../middleware/auth.js";

const activity = new Hono();
activity.use("*", jwtAuth);

// ═══════════════════════════════════════════════════════════════
// GET / — Get activity feed for the authenticated wallet
// ═══════════════════════════════════════════════════════════════
activity.get("/", async (c) => {
  const { walletId } = getAuthPayload(c);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 200);
  const offset = parseInt(c.req.query("offset") ?? "0");

  const logs = await db.query.activityLog.findMany({
    where: eq(activityLog.walletId, walletId),
    orderBy: desc(activityLog.createdAt),
    limit,
    offset,
    with: {
      agent: {
        columns: { id: true, name: true, agentPubkey: true },
      },
    },
  });

  return c.json(logs);
});

export default activity;
