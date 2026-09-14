CREATE TABLE "open_finance_card_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_link_id" uuid NOT NULL,
	"account_id" uuid,
	"provider_transaction_id" text NOT NULL,
	"paid_at" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"matched_transaction_id" uuid,
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_finance_card_payments_amount_positive" CHECK ("open_finance_card_payments"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "open_finance_card_payments" ADD CONSTRAINT "open_finance_card_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_finance_card_payments" ADD CONSTRAINT "open_finance_card_payments_account_link_id_open_finance_account_links_id_fk" FOREIGN KEY ("account_link_id") REFERENCES "public"."open_finance_account_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_finance_card_payments" ADD CONSTRAINT "open_finance_card_payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "open_finance_card_payments_provider_unique" ON "open_finance_card_payments" USING btree ("account_link_id","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "open_finance_card_payments_user_paid_idx" ON "open_finance_card_payments" USING btree ("user_id","paid_at");--> statement-breakpoint
-- Card bill payments seen before this table existed were counted and thrown
-- away, so the outflows that settled them cannot be recognised yet. Clearing the
-- watermark on card links makes the next sync re-read their full history and
-- record the legs. Re-reading costs nothing: (account_id, external_id) is
-- unique, so no transaction is created twice.
UPDATE "open_finance_account_links"
SET "synced_through" = NULL
WHERE "provider_type" = 'CREDIT';
