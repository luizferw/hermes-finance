CREATE TYPE "public"."amount_strategy" AS ENUM('fixed', 'variable');--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "amount_strategy" "amount_strategy" DEFAULT 'fixed' NOT NULL;