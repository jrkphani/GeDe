CREATE TABLE "applied_mutations" (
	"mutation_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
