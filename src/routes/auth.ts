import { Hono } from "hono";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { eq, and, gt } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as jose from "jose";
import { db } from "../db/index.js";
import { authNonces, wallets } from "../db/schema.js";
import { config } from "../config.js";
import { deriveWalletPda } from "../services/solana.js";

const auth = new Hono();

const jwtSecret = new TextEncoder().encode(config.JWT_SECRET);

// ═══════════════════════════════════════════════════════════════
// GET /nonce — Generate a nonce for SIWS
// ═══════════════════════════════════════════════════════════════
const nonceQuery = z.object({
  walletAddress: z.string().min(32).max(50),
});

auth.get("/nonce", async (c) => {
  const parsed = nonceQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Invalid wallet address" }, 400);
  }

  const nonce = nanoid(32);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

  await db.insert(authNonces).values({
    nonce,
    walletAddress: parsed.data.walletAddress,
    expiresAt,
  });

  return c.json({ nonce, expiresAt: expiresAt.toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// POST /verify — Verify SIWS signature and issue JWT
// ═══════════════════════════════════════════════════════════════
const verifyBody = z.object({
  walletAddress: z.string().min(32).max(50),
  nonce: z.string(),
  signature: z.string(), // base64 encoded
  message: z.string(), // the signed message
});

auth.post("/verify", async (c) => {
  const parsed = verifyBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
  }

  const { walletAddress, nonce, signature, message } = parsed.data;

  // Verify nonce exists, belongs to this wallet, not used, not expired
  const storedNonce = await db.query.authNonces.findFirst({
    where: and(
      eq(authNonces.nonce, nonce),
      eq(authNonces.used, false),
      gt(authNonces.expiresAt, new Date())
    ),
  });

  if (!storedNonce) {
    return c.json({ error: "Invalid or expired nonce" }, 401);
  }

  if (storedNonce.walletAddress !== walletAddress) {
    return c.json({ error: "Nonce wallet mismatch" }, 401);
  }

  // Verify the message follows SIWS format and contains the nonce
  if (!message.includes(nonce)) {
    return c.json({ error: "Message does not contain nonce" }, 401);
  }
  // Verify the message includes the wallet address as the signer
  if (!message.includes(walletAddress)) {
    return c.json({ error: "Message does not reference signing wallet" }, 401);
  }

  // Verify ed25519 signature
  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = new PublicKey(walletAddress).toBytes();
  } catch {
    return c.json({ error: "Invalid wallet address" }, 400);
  }

  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = Buffer.from(signature, "base64");

  const valid = nacl.sign.detached.verify(
    messageBytes,
    signatureBytes,
    pubkeyBytes
  );

  if (!valid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Mark nonce as used
  await db
    .update(authNonces)
    .set({ used: true })
    .where(eq(authNonces.id, storedNonce.id));

  // Upsert wallet record
  const [walletPda] = deriveWalletPda(new PublicKey(walletAddress));
  const existing = await db.query.wallets.findFirst({
    where: eq(wallets.ownerAddress, walletAddress),
  });

  let walletId: number;
  if (existing) {
    walletId = existing.id;
  } else {
    const [inserted] = await db
      .insert(wallets)
      .values({
        ownerAddress: walletAddress,
        sealWalletAddress: walletPda.toBase58(),
      })
      .returning();
    walletId = inserted!.id;
  }

  // Issue JWT
  const token = await new jose.SignJWT({
    sub: walletAddress,
    walletId,
    sealWallet: walletPda.toBase58(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(config.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(config.JWT_EXPIRY)
    .sign(jwtSecret);

  return c.json({
    token,
    wallet: {
      id: walletId,
      ownerAddress: walletAddress,
      sealWalletAddress: walletPda.toBase58(),
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /refresh — Refresh JWT
// ═══════════════════════════════════════════════════════════════
auth.post("/refresh", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing token" }, 401);
  }

  try {
    const { payload } = await jose.jwtVerify(
      authHeader.slice(7),
      jwtSecret,
      { issuer: config.JWT_ISSUER }
    );

    const token = await new jose.SignJWT({
      sub: payload.sub,
      walletId: payload.walletId,
      sealWallet: payload.sealWallet,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(config.JWT_ISSUER)
      .setIssuedAt()
      .setExpirationTime(config.JWT_EXPIRY)
      .sign(jwtSecret);

    return c.json({ token });
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
});

export default auth;
