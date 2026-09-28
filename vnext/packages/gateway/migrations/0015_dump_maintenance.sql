-- Persist scan progress across cron instances and restarts, including deleted keys.
CREATE TABLE maintenance_cursors (
  name TEXT PRIMARY KEY,
  cursor_key TEXT NOT NULL DEFAULT '',
  cursor_time INTEGER NOT NULL DEFAULT -1
);

CREATE INDEX idx_dump_request_file ON dump_records (json_extract(request_body_descriptor, '$.key'));
CREATE INDEX idx_dump_response_file ON dump_records (json_extract(response_body_descriptor, '$.key'));

-- Extend this view (and its indexed descriptor columns) when adding dump sides.
CREATE VIEW dump_file_references AS
  SELECT json_extract(request_body_descriptor, '$.key') AS file_key FROM dump_records
  UNION ALL
  SELECT json_extract(response_body_descriptor, '$.key') AS file_key FROM dump_records;

CREATE INDEX idx_dump_files_collectible ON spilled_files (collect_after, file_key)
  WHERE state != 'owned'
    AND owner_kind IN ('dump-request', 'dump-response')
    AND file_key GLOB 'dumps/v1/*';

-- An expired stage may already be claimed or deleted when a slow writer resumes.
-- Reject before the existing AFTER INSERT adoption triggers can silently miss it.
CREATE TRIGGER dump_records_guard_request_insert
BEFORE INSERT ON dump_records
WHEN NEW.request_body_descriptor IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'dump request file is not available for adoption')
  WHERE NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = json_extract(NEW.request_body_descriptor, '$.key')
      AND owner_kind = 'dump-request'
      AND owner_key = json_array(NEW.key_id, NEW.id)
      AND state = 'staged' AND claim_token IS NULL
  );
END;

CREATE TRIGGER dump_records_guard_response_insert
BEFORE INSERT ON dump_records
WHEN NEW.response_body_descriptor IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'dump response file is not available for adoption')
  WHERE NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = json_extract(NEW.response_body_descriptor, '$.key')
      AND owner_kind = 'dump-response'
      AND owner_key = json_array(NEW.key_id, NEW.id)
      AND state = 'staged' AND claim_token IS NULL
  );
END;

-- The writer is append-only. Until update adoption/retirement is implemented,
-- reject descriptor/identity changes rather than bypassing INSERT protection.
CREATE TRIGGER dump_records_guard_reference_update
BEFORE UPDATE OF key_id, id, request_body_descriptor, response_body_descriptor ON dump_records
WHEN NEW.key_id IS NOT OLD.key_id OR NEW.id IS NOT OLD.id
  OR NEW.request_body_descriptor IS NOT OLD.request_body_descriptor
  OR NEW.response_body_descriptor IS NOT OLD.response_body_descriptor
BEGIN
  SELECT RAISE(ABORT, 'dump file references are immutable');
END;

-- REPLACE bypasses UPDATE triggers and may not fire DELETE triggers when
-- recursive_triggers is off. Keep dump writes append-only on this path too.
CREATE TRIGGER dump_records_guard_replace
BEFORE INSERT ON dump_records
WHEN EXISTS (SELECT 1 FROM dump_records WHERE key_id = NEW.key_id AND id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'dump records cannot be replaced');
END;
