ALTER TYPE "public"."account_type" ADD VALUE 'wallet' BEFORE 'credit_card';--> statement-breakpoint
ALTER TYPE "public"."account_type" ADD VALUE 'investment';--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "country" text DEFAULT 'IN' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "financial_year_start_month" smallint DEFAULT 4 NOT NULL;