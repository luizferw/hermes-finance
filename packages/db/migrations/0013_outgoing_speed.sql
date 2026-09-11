ALTER TABLE "purchase_items" ADD COLUMN "purchase_date" date;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD COLUMN "installments" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_installments_positive" CHECK ("purchase_items"."installments" >= 1);