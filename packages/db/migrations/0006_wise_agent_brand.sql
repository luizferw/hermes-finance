DROP INDEX IF EXISTS "transactions_import_hash_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_import_hash_unique" ON "transactions" USING btree ("account_id","import_hash") WHERE "import_hash" IS NOT NULL AND "import_file_id" IS NOT NULL AND "deleted_at" IS NULL;
