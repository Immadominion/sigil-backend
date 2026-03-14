import {
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  bigint,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════
// Wallets — Seal smart wallets registered by owners
// ═══════════════════════════════════════════════════════════════
export const wallets = pgTable(
  "wallets",
  {
    id: serial("id").primaryKey(),
    ownerAddress: text("owner_address").notNull(),
    sealWalletAddress: text("seal_wallet_address").notNull(),
    label: text("label"),
    isLocked: boolean("is_locked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("wallets_owner_address_idx").on(t.ownerAddress),
    uniqueIndex("wallets_seal_wallet_address_idx").on(t.sealWalletAddress),
  ]
);

export const walletsRelations = relations(wallets, ({ many }) => ({
  agents: many(agents),
  activityLogs: many(activityLog),
}));

// ═══════════════════════════════════════════════════════════════
// Agents — registered agents on Seal wallets
// ═══════════════════════════════════════════════════════════════
export const agents = pgTable(
  "agents",
  {
    id: serial("id").primaryKey(),
    walletId: serial("wallet_id")
      .references(() => wallets.id, { onDelete: "cascade" })
      .notNull(),
    agentPubkey: text("agent_pubkey").notNull(),
    encryptedSecret: text("encrypted_secret").notNull(),
    agentConfigPda: text("agent_config_pda").notNull(),
    name: text("name").notNull(),
    allowedPrograms: text("allowed_programs").array().notNull().default([]),
    autoApprove: boolean("auto_approve").notNull().default(true),
    dailyLimitLamports: bigint("daily_limit_lamports", { mode: "number" })
      .notNull()
      .default(5_000_000_000), // 5 SOL default
    perTxLimitLamports: bigint("per_tx_limit_lamports", { mode: "number" })
      .notNull()
      .default(1_000_000_000), // 1 SOL default
    status: text("status", { enum: ["active", "suspended", "deregistered"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("agents_pubkey_idx").on(t.agentPubkey),
    index("agents_wallet_id_idx").on(t.walletId),
  ]
);

export const agentsRelations = relations(agents, ({ one, many }) => ({
  wallet: one(wallets, { fields: [agents.walletId], references: [wallets.id] }),
  pairingTokens: many(pairingTokens),
  sessions: many(sessions),
  activityLogs: many(activityLog),
}));

// ═══════════════════════════════════════════════════════════════
// Pairing Tokens — copyable tokens for agent auth
// ═══════════════════════════════════════════════════════════════
export const pairingTokens = pgTable(
  "pairing_tokens",
  {
    id: serial("id").primaryKey(),
    agentId: serial("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    tokenHash: text("token_hash").notNull(),
    label: text("label").notNull().default("default"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked: boolean("revoked").notNull().default(false),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("pairing_tokens_agent_id_idx").on(t.agentId)]
);

export const pairingTokensRelations = relations(pairingTokens, ({ one, many }) => ({
  agent: one(agents, { fields: [pairingTokens.agentId], references: [agents.id] }),
  sessions: many(sessions),
}));

// ═══════════════════════════════════════════════════════════════
// Sessions — active session keys issued to agents
// ═══════════════════════════════════════════════════════════════
export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    agentId: serial("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    pairingTokenId: serial("pairing_token_id")
      .references(() => pairingTokens.id)
      .notNull(),
    sessionPda: text("session_pda").notNull(),
    sessionPubkey: text("session_pubkey").notNull(),
    encryptedSessionSecret: text("encrypted_session_secret").notNull(),
    walletPda: text("wallet_pda").notNull(),
    agentConfigPda: text("agent_config_pda").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxAmountLamports: bigint("max_amount_lamports", { mode: "number" }).notNull(),
    maxPerTxLamports: bigint("max_per_tx_lamports", { mode: "number" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    txSignature: text("tx_signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("sessions_agent_id_idx").on(t.agentId),
    index("sessions_pairing_token_id_idx").on(t.pairingTokenId),
    uniqueIndex("sessions_session_pda_idx").on(t.sessionPda),
  ]
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  agent: one(agents, { fields: [sessions.agentId], references: [agents.id] }),
  pairingToken: one(pairingTokens, {
    fields: [sessions.pairingTokenId],
    references: [pairingTokens.id],
  }),
}));

// ═══════════════════════════════════════════════════════════════
// Activity Log — audit trail for all actions
// ═══════════════════════════════════════════════════════════════
export const activityLog = pgTable(
  "activity_log",
  {
    id: serial("id").primaryKey(),
    walletId: serial("wallet_id")
      .references(() => wallets.id, { onDelete: "cascade" })
      .notNull(),
    agentId: serial("agent_id").references(() => agents.id),
    action: text("action").notNull(),
    details: jsonb("details"),
    txSignature: text("tx_signature"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("activity_log_wallet_id_idx").on(t.walletId),
    index("activity_log_agent_id_idx").on(t.agentId),
    index("activity_log_created_at_idx").on(t.createdAt),
  ]
);

export const activityLogRelations = relations(activityLog, ({ one }) => ({
  wallet: one(wallets, { fields: [activityLog.walletId], references: [wallets.id] }),
  agent: one(agents, { fields: [activityLog.agentId], references: [agents.id] }),
}));

// ═══════════════════════════════════════════════════════════════
// Auth Nonces — for SIWS replay protection
// ═══════════════════════════════════════════════════════════════
export const authNonces = pgTable("auth_nonces", {
  id: serial("id").primaryKey(),
  nonce: text("nonce").notNull().unique(),
  walletAddress: text("wallet_address"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════
// Pending Approvals — session requests awaiting manual approval
// ═══════════════════════════════════════════════════════════════
export const pendingApprovals = pgTable(
  "pending_approvals",
  {
    id: serial("id").primaryKey(),
    agentId: serial("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    pairingTokenId: serial("pairing_token_id")
      .references(() => pairingTokens.id)
      .notNull(),
    walletId: serial("wallet_id")
      .references(() => wallets.id, { onDelete: "cascade" })
      .notNull(),
    durationSecs: bigint("duration_secs", { mode: "number" }).notNull(),
    maxAmountLamports: bigint("max_amount_lamports", { mode: "number" }).notNull(),
    maxPerTxLamports: bigint("max_per_tx_lamports", { mode: "number" }).notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "expired"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("pending_approvals_wallet_id_idx").on(t.walletId),
    index("pending_approvals_agent_id_idx").on(t.agentId),
  ]
);

export const pendingApprovalsRelations = relations(pendingApprovals, ({ one }) => ({
  agent: one(agents, { fields: [pendingApprovals.agentId], references: [agents.id] }),
  pairingToken: one(pairingTokens, {
    fields: [pendingApprovals.pairingTokenId],
    references: [pairingTokens.id],
  }),
  wallet: one(wallets, { fields: [pendingApprovals.walletId], references: [wallets.id] }),
}));
