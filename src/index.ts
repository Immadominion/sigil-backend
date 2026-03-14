import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { config } from "./config.js";
import { rateLimiter } from "./middleware/rate-limit.js";

import authRoutes from "./routes/auth.js";
import walletRoutes from "./routes/wallet.js";
import agentRoutes from "./routes/agent.js";
import pairingRoutes from "./routes/pairing.js";
import sessionRoutes from "./routes/session.js";
import activityRoutes from "./routes/activity.js";
import eventsRoutes from "./routes/events.js";

const app = new Hono();

// ═══════════════════════════════════════════════════════════════
// Global Middleware
// ═══════════════════════════════════════════════════════════════
app.use("*", logger());
app.use("*", secureHeaders());
app.use("*", bodyLimit({ maxSize: 1024 * 1024 })); // 1 MB max body
app.use(
  "*",
  cors({
    origin:
      config.NODE_ENV === "production"
        ? [config.FRONTEND_ORIGIN]
        : "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

// Rate limiting — global + stricter on auth endpoints
app.use("*", rateLimiter({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX_REQUESTS,
}));
app.use("/api/auth/*", rateLimiter({
  windowMs: 60_000,
  max: 20, // 20 auth attempts per minute per IP
}));
app.use("/api/agent/session/*", rateLimiter({
  windowMs: 60_000,
  max: 30, // 30 session requests per minute per IP
}));

// ═══════════════════════════════════════════════════════════════
// Health Check
// ═══════════════════════════════════════════════════════════════
app.get("/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

// ═══════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════

// Mobile/Web endpoints (JWT authenticated)
app.route("/api/auth", authRoutes);
app.route("/api/wallet", walletRoutes);
app.route("/api/agents", agentRoutes);
app.route("/api/agents", pairingRoutes); // /api/agents/:agentId/pairing
app.route("/api/activity", activityRoutes);

// Agent endpoints (pairing token authenticated)
app.route("/api/agent/session", sessionRoutes);

// SSE event stream (JWT authenticated)
app.route("/api/events", eventsRoutes);

// ═══════════════════════════════════════════════════════════════
// 404 Handler
// ═══════════════════════════════════════════════════════════════
app.notFound((c) => c.json({ error: "Not found" }, 404));

// ═══════════════════════════════════════════════════════════════
// Error Handler
// ═══════════════════════════════════════════════════════════════
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      error: config.NODE_ENV === "production" ? "Internal server error" : err.message,
    },
    500
  );
});

// ═══════════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════════
const port = config.PORT;

console.log(`
╔═══════════════════════════════════════════╗
║           ⬡ SIGIL BACKEND ⬡              ║
║   Seal Wallet Credential Broker           ║
╠═══════════════════════════════════════════╣
║  Port:    ${String(port).padEnd(30)}║
║  Env:     ${config.NODE_ENV.padEnd(30)}║
║  Cluster: ${config.SOLANA_CLUSTER.padEnd(30)}║
╚═══════════════════════════════════════════╝
`);

serve({ fetch: app.fetch, port });
