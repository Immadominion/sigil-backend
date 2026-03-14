import { Hono } from "hono";
import * as jose from "jose";
import type { Context, Next } from "hono";
import { config } from "../config.js";

const jwtSecret = new TextEncoder().encode(config.JWT_SECRET);

export interface JwtPayload {
  sub: string; // wallet address
  walletId: number;
  sealWallet: string;
}

/**
 * JWT authentication middleware for wallet owner endpoints.
 * Extracts and verifies the Bearer token, attaching the payload to context.
 */
export async function jwtAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  try {
    const { payload } = await jose.jwtVerify(authHeader.slice(7), jwtSecret, {
      issuer: config.JWT_ISSUER,
    });

    c.set("jwtPayload", payload as unknown as JwtPayload);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

/**
 * Get the authenticated user's JWT payload from context.
 */
export function getAuthPayload(c: Context): JwtPayload {
  return c.get("jwtPayload") as JwtPayload;
}
