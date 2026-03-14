CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_id" serial NOT NULL,
	"agent_id" serial NOT NULL,
	"action" text NOT NULL,
	"details" jsonb,
	"tx_signature" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_id" serial NOT NULL,
	"agent_pubkey" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"agent_config_pda" text NOT NULL,
	"name" text NOT NULL,
	"allowed_programs" text[] DEFAULT '{}' NOT NULL,
	"auto_approve" boolean DEFAULT true NOT NULL,
	"daily_limit_lamports" bigint DEFAULT 5000000000 NOT NULL,
	"per_tx_limit_lamports" bigint DEFAULT 1000000000 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"id" serial PRIMARY KEY NOT NULL,
	"nonce" text NOT NULL,
	"wallet_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_nonces_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE TABLE "pairing_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" serial NOT NULL,
	"token_hash" text NOT NULL,
	"label" text DEFAULT 'default' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" serial NOT NULL,
	"pairing_token_id" serial NOT NULL,
	"session_pda" text NOT NULL,
	"session_pubkey" text NOT NULL,
	"encrypted_session_secret" text NOT NULL,
	"wallet_pda" text NOT NULL,
	"agent_config_pda" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_amount_lamports" bigint NOT NULL,
	"max_per_tx_lamports" bigint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"tx_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_address" text NOT NULL,
	"seal_wallet_address" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD CONSTRAINT "pairing_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pairing_token_id_pairing_tokens_id_fk" FOREIGN KEY ("pairing_token_id") REFERENCES "public"."pairing_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_wallet_id_idx" ON "activity_log" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "activity_log_agent_id_idx" ON "activity_log" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "activity_log_created_at_idx" ON "activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_pubkey_idx" ON "agents" USING btree ("agent_pubkey");--> statement-breakpoint
CREATE INDEX "agents_wallet_id_idx" ON "agents" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "pairing_tokens_agent_id_idx" ON "pairing_tokens" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "sessions_agent_id_idx" ON "sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "sessions_pairing_token_id_idx" ON "sessions" USING btree ("pairing_token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_session_pda_idx" ON "sessions" USING btree ("session_pda");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_owner_address_idx" ON "wallets" USING btree ("owner_address");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_seal_wallet_address_idx" ON "wallets" USING btree ("seal_wallet_address");