CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"tool_name" text NOT NULL,
	"status" text NOT NULL,
	"source" text DEFAULT 'session' NOT NULL,
	"summary" jsonb,
	"entity_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_actions_idem_unique" ON "agent_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_actions_user_idx" ON "agent_actions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tokens_hash_unique" ON "mcp_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_tokens_user_idx" ON "mcp_access_tokens" USING btree ("user_id");