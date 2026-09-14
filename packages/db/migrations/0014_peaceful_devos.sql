CREATE TABLE "open_finance_account_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"account_id" uuid,
	"credit_card_id" uuid,
	"provider_type" text NOT NULL,
	"provider_subtype" text,
	"provider_name" text,
	"provider_number_mask" text,
	"currency_code" text NOT NULL,
	"link_mode" text NOT NULL,
	"link_confidence" text,
	"link_decision_note" text,
	"synced_through" date,
	"last_transaction_synced_at" timestamp with time zone,
	"provider_balance_minor" bigint,
	"provider_balance_observed_at" timestamp with time zone,
	"opening_balance_derived_at" timestamp with time zone,
	"is_sync_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_finance_account_links_currency_code_check" CHECK ("open_finance_account_links"."currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "open_finance_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'pluggy' NOT NULL,
	"item_id" text NOT NULL,
	"label" text,
	"connector_id" integer,
	"connector_name" text,
	"connector_image_url" text,
	"status" text DEFAULT 'unknown' NOT NULL,
	"execution_status" text,
	"provider_last_updated_at" timestamp with time zone,
	"consent_expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_error" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_finance_connections_provider_check" CHECK ("open_finance_connections"."provider" ~ '^[a-z_]+$')
);
--> statement-breakpoint
CREATE TABLE "open_finance_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" uuid,
	"source" text DEFAULT 'OPEN_FINANCE' NOT NULL,
	"institution" text,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"records_seen" integer DEFAULT 0 NOT NULL,
	"records_created" integer DEFAULT 0 NOT NULL,
	"records_updated" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"needs_review" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"error" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "open_finance_account_links" ADD CONSTRAINT "open_finance_account_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_finance_account_links" ADD CONSTRAINT "open_finance_account_links_connection_id_open_finance_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."open_finance_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_finance_account_links" ADD CONSTRAINT "open_finance_account_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_finance_account_links" ADD CONSTRAINT "open_finance_account_links_credit_card_id_credit_cards_id_fk" FOREIGN KEY ("credit_card_id") REFERENCES "public"."credit_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_finance_connections" ADD CONSTRAINT "open_finance_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_finance_sync_runs" ADD CONSTRAINT "open_finance_sync_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_finance_sync_runs" ADD CONSTRAINT "open_finance_sync_runs_connection_id_open_finance_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."open_finance_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "open_finance_account_links_connection_account_unique" ON "open_finance_account_links" USING btree ("connection_id","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "open_finance_account_links_account_unique" ON "open_finance_account_links" USING btree ("account_id") WHERE "open_finance_account_links"."account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "open_finance_account_links_user_idx" ON "open_finance_account_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "open_finance_account_links_connection_idx" ON "open_finance_account_links" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "open_finance_connections_user_item_unique" ON "open_finance_connections" USING btree ("user_id","provider","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "open_finance_connections_id_user_unique" ON "open_finance_connections" USING btree ("id","user_id");--> statement-breakpoint
CREATE INDEX "open_finance_connections_user_idx" ON "open_finance_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "open_finance_sync_runs_user_started_idx" ON "open_finance_sync_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "open_finance_sync_runs_connection_idx" ON "open_finance_sync_runs" USING btree ("connection_id");