CREATE TABLE "tier1_props" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"rank" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tier1_purpose" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tier1_props" ADD CONSTRAINT "tier1_props_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier1_purpose" ADD CONSTRAINT "tier1_purpose_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tier1_purpose_project_idx" ON "tier1_purpose" USING btree ("project_id");