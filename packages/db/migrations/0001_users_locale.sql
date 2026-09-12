-- 0001_users_locale — I18N-05: the locale choice persists per user.
-- Nullable: a user who has never chosen one gets the browser default in the SPA.
-- Validated by the API against en-US | en-GB | en-IN | ta-IN | hi-IN | te-IN.

ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text;
