import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { jwtAuth, getAuthPayload } from "../middleware/auth.js";
import { eventBus, type SigilEvent } from "../services/event-bus.js";

const events = new Hono();
events.use("*", jwtAuth);

// ═══════════════════════════════════════════════════════════════
// GET / — SSE stream for real-time wallet events
// ═══════════════════════════════════════════════════════════════
events.get("/", async (c) => {
  const { walletId } = getAuthPayload(c);

  return streamSSE(c, async (stream) => {
    // Send initial connection event
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ walletId, timestamp: new Date().toISOString() }),
    });

    // Subscribe to events for this wallet
    const unsubscribe = eventBus.subscribe(
      walletId,
      (event: SigilEvent) => {
        stream
          .writeSSE({
            event: event.type,
            data: JSON.stringify(event.data),
          })
          .catch(() => {
            // Client disconnected, cleanup handled by onAbort
          });
      }
    );

    // Keep connection alive with periodic heartbeats
    const heartbeatInterval = setInterval(() => {
      stream
        .writeSSE({
          event: "ping",
          data: JSON.stringify({ timestamp: new Date().toISOString() }),
        })
        .catch(() => {});
    }, 30_000);

    // Cleanup on disconnect
    stream.onAbort(() => {
      unsubscribe();
      clearInterval(heartbeatInterval);
    });

    // Keep the stream open until client disconnects
    // The stream will stay open because of the event subscriptions
    await new Promise(() => {
      // Never resolves — stays open until abort
    });
  });
});

export default events;
