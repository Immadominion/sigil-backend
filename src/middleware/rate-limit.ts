/**
 * Simple in-memory rate limiter middleware for Hono.
 * For production, replace with Redis-backed rate limiting.
 */
import type { MiddlewareHandler } from "hono";

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

export function rateLimiter(opts: {
    windowMs: number;
    max: number;
    keyGenerator?: (c: { req: { header: (name: string) => string | undefined } }) => string;
}): MiddlewareHandler {
    const { windowMs, max } = opts;

    // Each limiter instance gets its own store
    const store = new Map<string, RateLimitEntry>();

    // Clean up expired entries every 60 seconds
    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of store) {
            if (entry.resetAt <= now) {
                store.delete(key);
            }
        }
    }, 60_000);

    // Allow GC to clean up the interval if the reference is lost
    if (cleanup.unref) cleanup.unref();

    return async (c, next) => {
        const key = opts.keyGenerator
            ? opts.keyGenerator(c)
            : c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";

        const now = Date.now();
        let entry = store.get(key);

        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            store.set(key, entry);
        }

        entry.count++;

        c.header("X-RateLimit-Limit", String(max));
        c.header("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
        c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

        if (entry.count > max) {
            return c.json(
                { error: "Too many requests. Please try again later." },
                429
            );
        }

        await next();
    };
}
