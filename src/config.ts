import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3003),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  DATABASE_URL: z.string().url(),

  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  SOLANA_CLUSTER: z.enum(["devnet", "testnet", "mainnet-beta"]).default("devnet"),

  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default("sigil"),
  JWT_EXPIRY: z.string().default("7d"),

  ENCRYPTION_KEY: z
    .string()
    .length(64, "ENCRYPTION_KEY must be 64 hex chars (32 bytes)")
    .regex(/^[0-9a-fA-F]+$/, "ENCRYPTION_KEY must be hex"),

  SEAL_PROGRAM_ID: z.string().default("EV3TKRVz7pTHpAqBTjP8jmwuvoRBRCpjmVSPHhcMnXqb"),

  FRONTEND_ORIGIN: z.string().url().default("https://sigil.app"),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(60),
});

export type Env = z.infer<typeof envSchema>;

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid environment variables:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
