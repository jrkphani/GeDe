CREATE TABLE "dimensions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"context_id" text,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"sort" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;