-- Per-key quotas move from a UTC day window to a UTC calendar-month window.
--
-- Renamed rather than added alongside: daily quotas cease to exist, and two
-- parallel column pairs would be two places to write the limit wrong.
--
-- Existing values carry over unchanged, which tightens them ~30x. Only five
-- keys in production had a quota set; they get re-tuned by hand rather than
-- multiplied by 30 here, which would only invent numbers nobody chose.

ALTER TABLE api_keys RENAME COLUMN quota_requests_per_day TO quota_requests_per_month;
ALTER TABLE api_keys RENAME COLUMN quota_tokens_per_day TO quota_tokens_per_month;
