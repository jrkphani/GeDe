-- Editable display labels remain separate from stable semantic column ids.
-- Rich Name content is additive: `name` stays the canonical plain-text value
-- used by search, ARIA, promotion and linked-parameter propagation.
ALTER TABLE "tier1_purpose"
  ADD COLUMN "value_prop_name_header" text,
  ADD COLUMN "value_prop_description_header" text;

ALTER TABLE "tier1_props"
  ADD COLUMN "name_rich_text" text;

ALTER TABLE "tier2_tables"
  ADD COLUMN "name_header" text,
  ADD COLUMN "description_header" text;

ALTER TABLE "tier2_entries"
  ADD COLUMN "name_rich_text" text;
