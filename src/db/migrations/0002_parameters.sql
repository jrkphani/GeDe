CREATE TABLE "parameters" (
	"id" text PRIMARY KEY NOT NULL,
	"dimension_id" text NOT NULL,
	"parent_param_id" text,
	"name" text NOT NULL,
	"sort" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "parameters" ADD CONSTRAINT "parameters_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameters" ADD CONSTRAINT "parameters_parent_param_id_parameters_id_fk" FOREIGN KEY ("parent_param_id") REFERENCES "public"."parameters"("id") ON DELETE no action ON UPDATE no action;