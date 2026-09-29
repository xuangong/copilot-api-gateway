ALTER TABLE model_catalogs ADD COLUMN completed_lease_token TEXT;
ALTER TABLE model_catalogs ADD COLUMN completed_outcome TEXT CHECK (completed_outcome IN ('success', 'failure'));
ALTER TABLE model_catalogs ADD COLUMN completed_error_code TEXT CHECK (completed_error_code IN ('timeout', 'aborted', 'upstream_error', 'invalid_catalog', 'unavailable'));
ALTER TABLE model_catalogs ADD COLUMN completed_publication_version INTEGER;
