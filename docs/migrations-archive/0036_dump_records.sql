-- Spec 14: dump_records + spilled_files backing the per-key request dump feature.
--
-- Bodies live in the FileProvider; the row carries only descriptors that
-- point at them. Keeps the row small and avoids base64 inflation.
--
-- `upstream_id` is its own column so list/get queries can LEFT JOIN against
-- `upstreams` and surface the current name and provider (kind). Freezing
-- those values into `meta_json` would let an admin rename go silently
-- un-honored on every historical record.

CREATE TABLE spilled_files (
  file_key TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'owned', 'retired')),
  collect_after INTEGER,
  claim_token TEXT,
  claimed_at INTEGER,
  CHECK (length(file_key) > 0),
  CHECK (length(owner_kind) > 0),
  CHECK (length(owner_key) > 0),
  CHECK ((state = 'owned') = (collect_after IS NULL)),
  CHECK ((claim_token IS NULL) = (claimed_at IS NULL)),
  CHECK (state != 'owned' OR claim_token IS NULL)
);

CREATE UNIQUE INDEX idx_spilled_files_owned_owner
  ON spilled_files (owner_kind, owner_key)
  WHERE state = 'owned';

CREATE INDEX idx_spilled_files_collectible
  ON spilled_files (collect_after, file_key)
  WHERE state != 'owned';

CREATE TABLE dump_records (
  key_id TEXT NOT NULL,
  id TEXT NOT NULL,            -- ULID
  created_at INTEGER NOT NULL, -- unix ms
  upstream_id TEXT,
  meta_json TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  response_headers_json TEXT,
  request_body_descriptor TEXT,
  response_body_descriptor TEXT,
  PRIMARY KEY (key_id, id)
);

-- The cron sweep filters by `(key_id, created_at < cutoff)` and the
-- dashboard list scans newest-first under one key, so a compound index
-- on (key_id, created_at DESC) drives both.
CREATE INDEX idx_dump_records_key_created ON dump_records(key_id, created_at DESC);

-- Adopt/retire triggers keep spilled_files in sync with dump_records.
-- Each descriptor is a JSON blob whose `key` field carries the file_key.

CREATE TRIGGER dump_records_adopt_request_insert
AFTER INSERT ON dump_records
WHEN NEW.request_body_descriptor IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE file_key = json_extract(NEW.request_body_descriptor, '$.key')
    AND owner_kind = 'dump-request'
    AND owner_key = json_array(NEW.key_id, NEW.id)
    AND state = 'staged'
    AND claim_token IS NULL;
END;

CREATE TRIGGER dump_records_adopt_response_insert
AFTER INSERT ON dump_records
WHEN NEW.response_body_descriptor IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE file_key = json_extract(NEW.response_body_descriptor, '$.key')
    AND owner_kind = 'dump-response'
    AND owner_key = json_array(NEW.key_id, NEW.id)
    AND state = 'staged'
    AND claim_token IS NULL;
END;

CREATE TRIGGER dump_records_retire_request_delete
AFTER DELETE ON dump_records
WHEN OLD.request_body_descriptor IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'retired', collect_after = 0
  WHERE file_key = json_extract(OLD.request_body_descriptor, '$.key')
    AND state = 'owned';
END;

CREATE TRIGGER dump_records_retire_response_delete
AFTER DELETE ON dump_records
WHEN OLD.response_body_descriptor IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'retired', collect_after = 0
  WHERE file_key = json_extract(OLD.response_body_descriptor, '$.key')
    AND state = 'owned';
END;
