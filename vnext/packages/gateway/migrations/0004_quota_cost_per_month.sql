-- A third monthly quota dimension: spend in USD.
--
-- Added alongside the request and token quotas rather than replacing either.
-- The three gates run in parallel and any one being exceeded denies the
-- request. Cost alone is not enough: `usage.unit_price` is NULL for models
-- whose pricing has not been synced yet, and those rows contribute $0, so a
-- cost-only gate would let an unpriced model run unlimited. The weighted-token
-- quota is the backstop for exactly that case.
--
-- REAL because USD is fractional. NULL means unlimited, matching the other two.

ALTER TABLE api_keys ADD COLUMN quota_cost_per_month REAL;
