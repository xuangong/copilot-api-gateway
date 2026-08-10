-- Per-upstream blacklist of public model ids. Filtered out of
-- listProviderBindings so disabled ids disappear from /v1/models and from
-- any routing decision, while the dashboard catalog endpoint (which bypasses
-- the registry) keeps showing them so admins can toggle them back on.
ALTER TABLE upstreams ADD COLUMN disabled_public_model_ids TEXT NOT NULL DEFAULT '[]';
