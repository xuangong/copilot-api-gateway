ALTER TABLE upstreams ADD COLUMN catalog_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE model_catalogs (
  upstream_id TEXT NOT NULL,
  catalog_revision INTEGER NOT NULL CHECK (catalog_revision > 0),
  row_incarnation TEXT NOT NULL,
  configuration_generation INTEGER NOT NULL CHECK (configuration_generation >= 0),
  configuration_fingerprint TEXT NOT NULL,
  publication_version INTEGER NOT NULL DEFAULT 0,
  models_json TEXT,
  refreshed_at_ms INTEGER,
  refresh_after_ms INTEGER,
  lease_token TEXT,
  lease_until_ms INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,
  retry_at_ms INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_used_at_ms INTEGER NOT NULL,
  PRIMARY KEY (upstream_id, catalog_revision)
);
CREATE INDEX model_catalogs_inactive ON model_catalogs(last_used_at_ms);

CREATE TRIGGER upstreams_catalog_generation_monotonic BEFORE UPDATE OF catalog_generation ON upstreams
WHEN NEW.catalog_generation < OLD.catalog_generation
BEGIN
  SELECT RAISE(ABORT, 'catalog generation cannot decrease');
END;

-- Explicit credential replacement already advances the generation in its UPDATE.
CREATE TRIGGER upstreams_catalog_generation AFTER UPDATE ON upstreams
WHEN NEW.catalog_generation = OLD.catalog_generation AND (
  OLD.id IS NOT NEW.id OR OLD.row_incarnation IS NOT NEW.row_incarnation OR
  OLD.owner_id IS NOT NEW.owner_id OR OLD.provider IS NOT NEW.provider OR
  OLD.config_json IS NOT NEW.config_json OR OLD.enabled IS NOT NEW.enabled OR
  OLD.proxy_fallback_list_json IS NOT NEW.proxy_fallback_list_json
)
BEGIN
  UPDATE upstreams SET catalog_generation = catalog_generation + 1 WHERE id = NEW.id;
END;

-- Generation-only credential replacements must invalidate remote configuration caches.
CREATE TRIGGER configuration_catalog_generation AFTER UPDATE OF catalog_generation ON upstreams
WHEN OLD.catalog_generation IS NOT NEW.catalog_generation
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;

-- Bun connections do not require foreign_keys=ON; cleanup must work there too.
CREATE TRIGGER upstreams_catalog_delete AFTER DELETE ON upstreams
BEGIN
  DELETE FROM model_catalogs WHERE upstream_id = OLD.id;
END;
CREATE TRIGGER upstreams_catalog_rename AFTER UPDATE OF id ON upstreams
WHEN OLD.id IS NOT NEW.id
BEGIN
  DELETE FROM model_catalogs WHERE upstream_id = OLD.id;
END;

CREATE TRIGGER proxies_catalog_insert AFTER INSERT ON proxies
BEGIN
  UPDATE upstreams SET catalog_generation = catalog_generation + 1
  WHERE EXISTS (SELECT 1 FROM json_each(upstreams.proxy_fallback_list_json) j
    WHERE json_extract(j.value, '$.id') = NEW.id AND NEW.id NOT IN ('direct_fetch', 'direct_connect'));
END;
CREATE TRIGGER proxies_catalog_update AFTER UPDATE ON proxies
WHEN OLD.id IS NOT NEW.id OR OLD.url IS NOT NEW.url OR OLD.dial_timeout_seconds IS NOT NEW.dial_timeout_seconds
BEGIN
  UPDATE upstreams SET catalog_generation = catalog_generation + 1
  WHERE EXISTS (SELECT 1 FROM json_each(upstreams.proxy_fallback_list_json) j
    WHERE json_extract(j.value, '$.id') IN (OLD.id, NEW.id)
      AND json_extract(j.value, '$.id') NOT IN ('direct_fetch', 'direct_connect'));
END;
CREATE TRIGGER proxies_catalog_delete AFTER DELETE ON proxies
BEGIN
  UPDATE upstreams SET catalog_generation = catalog_generation + 1
  WHERE EXISTS (SELECT 1 FROM json_each(upstreams.proxy_fallback_list_json) j
    WHERE json_extract(j.value, '$.id') = OLD.id AND OLD.id NOT IN ('direct_fetch', 'direct_connect'));
END;
