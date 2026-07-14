CREATE TABLE "confidence_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"score" smallint NOT NULL,
	"band" text NOT NULL,
	"on_top" boolean DEFAULT false NOT NULL,
	"factors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "confidence_snapshots" ADD CONSTRAINT "confidence_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "confidence_snapshots_user_date_unique" ON "confidence_snapshots" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "confidence_snapshots_user_idx" ON "confidence_snapshots" USING btree ("user_id");