DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_currency_code_check') THEN
    ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_code_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_balances_currency_code_check') THEN
    ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_currency_code_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_periods_currency_code_check') THEN
    ALTER TABLE "budget_periods" ADD CONSTRAINT "budget_periods_currency_code_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_periods_planned_nonnegative_check') THEN
    ALTER TABLE "budget_periods" ADD CONSTRAINT "budget_periods_planned_nonnegative_check" CHECK ("planned_amount_minor" >= 0);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_periods_date_order_check') THEN
    ALTER TABLE "budget_periods" ADD CONSTRAINT "budget_periods_date_order_check" CHECK ("period_end" >= "period_start");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bills_currency_code_check') THEN
    ALTER TABLE "bills" ADD CONSTRAINT "bills_currency_code_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bills_expected_amount_positive_check') THEN
    ALTER TABLE "bills" ADD CONSTRAINT "bills_expected_amount_positive_check" CHECK ("expected_amount_minor" > 0);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bills_due_day_check') THEN
    ALTER TABLE "bills" ADD CONSTRAINT "bills_due_day_check" CHECK ("due_day" IS NULL OR ("due_day" >= 1 AND "due_day" <= 31));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_currency_code_check') THEN
    ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_currency_code_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_amount_nonzero_check') THEN
    ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_amount_nonzero_check" CHECK ("amount_minor" <> 0);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_transfer_account_check') THEN
    ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transfer_account_check" CHECK (("type"::text = 'transfer' AND "transfer_account_id" IS NOT NULL) OR ("type"::text <> 'transfer'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'savings_goals_currency_code_check') THEN
    ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_currency_code_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'savings_goals_target_nonnegative_check') THEN
    ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_target_nonnegative_check" CHECK ("target_amount_minor" >= 0);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'savings_goals_current_nonnegative_check') THEN
    ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_current_nonnegative_check" CHECK ("current_amount_minor" >= 0);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_currency_code_check') THEN
    ALTER TABLE "transactions" ADD CONSTRAINT "transactions_currency_code_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_amount_sign_check') THEN
    ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_sign_check" CHECK (
      ("type"::text = 'income' AND "amount_minor" > 0)
      OR ("type"::text IN ('expense', 'transfer') AND "amount_minor" < 0)
      OR ("type"::text IN ('adjustment', 'opening_balance') AND "amount_minor" <> 0)
    );
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_transfer_account_check') THEN
    ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transfer_account_check" CHECK (
      ("type"::text = 'transfer' AND "transfer_account_id" IS NOT NULL)
      OR ("type"::text <> 'transfer' AND "transfer_account_id" IS NULL)
    );
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_import_hash_unique" ON "transactions" USING btree ("account_id","import_hash") WHERE "import_hash" IS NOT NULL AND "import_file_id" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_external_id_unique" ON "transactions" USING btree ("account_id","external_id") WHERE "external_id" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_rows_file_row_unique" ON "import_rows" USING btree ("import_file_id","row_index");
