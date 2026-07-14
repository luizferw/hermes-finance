ALTER TABLE "recurring_transactions" DROP CONSTRAINT "recurring_transactions_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_messages" DROP CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_id_user_unique" ON "accounts" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversations_id_user_unique" ON "ai_conversations" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_account_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_owner_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."accounts"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_owner_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."ai_conversations"("id","user_id") ON DELETE cascade ON UPDATE no action;
