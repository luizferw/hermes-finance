CREATE TYPE "public"."credit_card_cycle_status" AS ENUM('open', 'closed', 'paid', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."forecast_confidence" AS ENUM('actual', 'confirmed', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."installment_status" AS ENUM('projected', 'billed', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('pix', 'boleto', 'cash', 'credit_card', 'debit_card');--> statement-breakpoint
CREATE TYPE "public"."purchase_item_priority" AS ENUM('must_have', 'high', 'medium', 'low', 'optional');--> statement-breakpoint
CREATE TYPE "public"."purchase_item_status" AS ENUM('idea', 'planned', 'ready', 'purchased', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."purchase_plan_status" AS ENUM('active', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."financial_reserve_kind" AS ENUM('hard', 'soft');--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"observed_at" date NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"import_file_id" uuid,
	"created_at" date DEFAULT CURRENT_DATE NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_card_billing_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_card_id" uuid NOT NULL,
	"statement_month" date NOT NULL,
	"opened_at" date NOT NULL,
	"closed_at" date,
	"due_at" date NOT NULL,
	"confirmed_total_minor" bigint,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" "credit_card_cycle_status" DEFAULT 'open' NOT NULL,
	CONSTRAINT "credit_card_cycles_date_order" CHECK ("credit_card_billing_cycles"."due_at" >= "credit_card_billing_cycles"."opened_at")
);
--> statement-breakpoint
CREATE TABLE "credit_card_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_card_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"purchase_date" date NOT NULL,
	"category_id" uuid,
	"merchant" text,
	"total_amount_minor" bigint NOT NULL,
	CONSTRAINT "credit_card_purchases_total_positive" CHECK ("credit_card_purchases"."total_amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"issuer" text,
	"currency_code" text NOT NULL,
	"credit_limit_minor" bigint NOT NULL,
	"default_closing_day" integer NOT NULL,
	"default_due_day" integer NOT NULL,
	"payment_account_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" date DEFAULT CURRENT_DATE NOT NULL,
	CONSTRAINT "credit_cards_limit_nonnegative" CHECK ("credit_cards"."credit_limit_minor" >= 0),
	CONSTRAINT "credit_cards_closing_day_valid" CHECK ("credit_cards"."default_closing_day" BETWEEN 1 AND 31),
	CONSTRAINT "credit_cards_due_day_valid" CHECK ("credit_cards"."default_due_day" BETWEEN 1 AND 31)
);
--> statement-breakpoint
CREATE TABLE "financial_reserves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "financial_reserve_kind" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" date DEFAULT CURRENT_DATE NOT NULL,
	CONSTRAINT "financial_reserves_amount_nonnegative" CHECK ("financial_reserves"."amount_minor" >= 0),
	CONSTRAINT "financial_reserves_currency_code_check" CHECK ("financial_reserves"."currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "installment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_card_purchase_id" uuid NOT NULL,
	"total_installments" integer NOT NULL,
	"first_installment_number" integer DEFAULT 1 NOT NULL,
	"created_at" date DEFAULT CURRENT_DATE NOT NULL,
	CONSTRAINT "installment_plans_total_positive" CHECK ("installment_plans"."total_installments" > 0),
	CONSTRAINT "installment_plans_first_valid" CHECK ("installment_plans"."first_installment_number" BETWEEN 1 AND "installment_plans"."total_installments")
);
--> statement-breakpoint
CREATE TABLE "installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installment_plan_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"billing_cycle_id" uuid,
	"expected_at" date NOT NULL,
	"status" "installment_status" DEFAULT 'projected' NOT NULL,
	"transaction_id" uuid,
	CONSTRAINT "installments_number_positive" CHECK ("installments"."number" > 0),
	CONSTRAINT "installments_amount_positive" CHECK ("installments"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_item_id" uuid NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"card_id" uuid,
	"cash_price_minor" bigint,
	"installments" integer,
	"installment_amount_minor" bigint,
	"total_cost_minor" bigint NOT NULL,
	"first_payment_date" date,
	CONSTRAINT "payment_options_total_nonnegative" CHECK ("payment_options"."total_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "projected_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"logical_key" text NOT NULL,
	"event_type" text NOT NULL,
	"expected_at" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"account_id" uuid,
	"category_id" uuid,
	"source_type" text NOT NULL,
	"source_id" text,
	"confidence" "forecast_confidence" NOT NULL,
	"resolved_by_transaction_id" uuid,
	"created_at" date DEFAULT CURRENT_DATE NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_plan_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" "purchase_item_priority" DEFAULT 'medium' NOT NULL,
	"estimated_price_minor" bigint NOT NULL,
	"actual_price_minor" bigint,
	"earliest_purchase_date" date,
	"deadline" date,
	"status" "purchase_item_status" DEFAULT 'idea' NOT NULL,
	"notes" text,
	CONSTRAINT "purchase_items_estimated_nonnegative" CHECK ("purchase_items"."estimated_price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_date" date,
	"budget_minor" bigint,
	"currency_code" text NOT NULL,
	"status" "purchase_plan_status" DEFAULT 'active' NOT NULL,
	"created_at" date DEFAULT CURRENT_DATE NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_simulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_item_id" uuid NOT NULL,
	"payment_option_id" uuid NOT NULL,
	"forecast_version" text NOT NULL,
	"current_balance_minor" bigint NOT NULL,
	"minimum_balance_minor" bigint NOT NULL,
	"safe_to_spend_before_minor" bigint NOT NULL,
	"safe_to_spend_after_minor" bigint NOT NULL,
	"reserve_violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_cost_minor" bigint NOT NULL,
	"last_installment_date" date,
	"recommendation_score" integer,
	"created_at" date DEFAULT CURRENT_DATE NOT NULL
);
--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_billing_cycles" ADD CONSTRAINT "credit_card_billing_cycles_credit_card_id_credit_cards_id_fk" FOREIGN KEY ("credit_card_id") REFERENCES "public"."credit_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchases" ADD CONSTRAINT "credit_card_purchases_credit_card_id_credit_cards_id_fk" FOREIGN KEY ("credit_card_id") REFERENCES "public"."credit_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchases" ADD CONSTRAINT "credit_card_purchases_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchases" ADD CONSTRAINT "credit_card_purchases_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_payment_account_id_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_reserves" ADD CONSTRAINT "financial_reserves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_credit_card_purchase_id_credit_card_purchases_id_fk" FOREIGN KEY ("credit_card_purchase_id") REFERENCES "public"."credit_card_purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_installment_plan_id_installment_plans_id_fk" FOREIGN KEY ("installment_plan_id") REFERENCES "public"."installment_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_billing_cycle_id_credit_card_billing_cycles_id_fk" FOREIGN KEY ("billing_cycle_id") REFERENCES "public"."credit_card_billing_cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_options" ADD CONSTRAINT "payment_options_purchase_item_id_purchase_items_id_fk" FOREIGN KEY ("purchase_item_id") REFERENCES "public"."purchase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_options" ADD CONSTRAINT "payment_options_card_id_credit_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."credit_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projected_events" ADD CONSTRAINT "projected_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projected_events" ADD CONSTRAINT "projected_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projected_events" ADD CONSTRAINT "projected_events_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projected_events" ADD CONSTRAINT "projected_events_resolved_by_transaction_id_transactions_id_fk" FOREIGN KEY ("resolved_by_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_plan_id_purchase_plans_id_fk" FOREIGN KEY ("purchase_plan_id") REFERENCES "public"."purchase_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_plans" ADD CONSTRAINT "purchase_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_simulations" ADD CONSTRAINT "purchase_simulations_purchase_item_id_purchase_items_id_fk" FOREIGN KEY ("purchase_item_id") REFERENCES "public"."purchase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_simulations" ADD CONSTRAINT "purchase_simulations_payment_option_id_payment_options_id_fk" FOREIGN KEY ("payment_option_id") REFERENCES "public"."payment_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "balance_snapshots_account_observed_unique" ON "balance_snapshots" USING btree ("account_id","observed_at");--> statement-breakpoint
CREATE INDEX "balance_snapshots_user_observed_idx" ON "balance_snapshots" USING btree ("user_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_card_cycles_card_month_unique" ON "credit_card_billing_cycles" USING btree ("credit_card_id","statement_month");--> statement-breakpoint
CREATE INDEX "credit_card_cycles_due_idx" ON "credit_card_billing_cycles" USING btree ("due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_card_purchases_transaction_unique" ON "credit_card_purchases" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "credit_card_purchases_card_date_idx" ON "credit_card_purchases" USING btree ("credit_card_id","purchase_date");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_cards_user_name_unique" ON "credit_cards" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_cards_account_unique" ON "credit_cards" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "financial_reserves_user_idx" ON "financial_reserves" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installments_plan_number_unique" ON "installments" USING btree ("installment_plan_id","number");--> statement-breakpoint
CREATE INDEX "installments_expected_idx" ON "installments" USING btree ("expected_at");--> statement-breakpoint
CREATE INDEX "payment_options_item_idx" ON "payment_options" USING btree ("purchase_item_id");--> statement-breakpoint
CREATE INDEX "projected_events_user_date_idx" ON "projected_events" USING btree ("user_id","expected_at");--> statement-breakpoint
CREATE INDEX "projected_events_key_idx" ON "projected_events" USING btree ("user_id","logical_key");--> statement-breakpoint
CREATE INDEX "purchase_items_plan_idx" ON "purchase_items" USING btree ("purchase_plan_id");--> statement-breakpoint
CREATE INDEX "purchase_plans_user_idx" ON "purchase_plans" USING btree ("user_id");