CREATE TABLE "tier2_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"description" text,
	"sort" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tier2_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"sort" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "parameters" ADD COLUMN "source_entry_id" text;--> statement-breakpoint
ALTER TABLE "tier2_entries" ADD CONSTRAINT "tier2_entries_table_id_tier2_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tier2_tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier2_entries" ADD CONSTRAINT "tier2_entries_parent_id_tier2_entries_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tier2_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier2_tables" ADD CONSTRAINT "tier2_tables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameters" ADD CONSTRAINT "parameters_source_entry_id_tier2_entries_id_fk" FOREIGN KEY ("source_entry_id") REFERENCES "public"."tier2_entries"("id") ON DELETE no action ON UPDATE no action;