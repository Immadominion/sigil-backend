CREATE TABLE "pending_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"pairing_token_id" integer NOT NULL,
	"wallet_id" integer NOT NULL,
	"duration_secs" bigint NOT NULL,
	"max_amount_lamports" bigint NOT NULL,
	"max_per_tx_lamports" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "activity_log" ALTER COLUMN "wallet_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "activity_log" ALTER COLUMN "agent_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "activity_log" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "wallet_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "pairing_tokens" ALTER COLUMN "agent_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "agent_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "pairing_token_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "is_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_pairing_token_id_pairing_tokens_id_fk" FOREIGN KEY ("pairing_token_id") REFERENCES "public"."pairing_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_approvals_wallet_id_idx" ON "pending_approvals" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "pending_approvals_agent_id_idx" ON "pending_approvals" USING btree ("agent_id");