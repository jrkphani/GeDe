CREATE TABLE "bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"context_id" text NOT NULL,
	"dimension_id" text NOT NULL,
	"parameter_id" text NOT NULL,
	"tuple_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"parent_id" text,
	"symbol" text NOT NULL,
	"name" text,
	"justification" text,
	"sort" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_parameter_id_parameters_id_fk" FOREIGN KEY ("parameter_id") REFERENCES "public"."parameters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contexts" ADD CONSTRAINT "contexts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contexts" ADD CONSTRAINT "contexts_parent_id_contexts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bindings_context_dimension_idx" ON "bindings" USING btree ("context_id","dimension_id");--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;