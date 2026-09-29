ALTER TABLE dump_records ADD COLUMN upstream_exchanges_descriptor TEXT;

CREATE INDEX idx_dump_upstream_file ON dump_records (json_extract(upstream_exchanges_descriptor, '$.key'));

DROP VIEW dump_file_references;
CREATE VIEW dump_file_references AS
  SELECT json_extract(request_body_descriptor, '$.key') AS file_key FROM dump_records
  UNION ALL
  SELECT json_extract(response_body_descriptor, '$.key') AS file_key FROM dump_records
  UNION ALL
  SELECT json_extract(upstream_exchanges_descriptor, '$.key') AS file_key FROM dump_records;

DROP INDEX idx_dump_files_collectible;
CREATE INDEX idx_dump_files_collectible ON spilled_files (collect_after, file_key)
  WHERE state != 'owned'
    AND owner_kind IN ('dump-request', 'dump-response', 'dump-upstream')
    AND file_key GLOB 'dumps/v1/*';

CREATE TRIGGER dump_records_guard_upstream_insert
BEFORE INSERT ON dump_records
WHEN NEW.upstream_exchanges_descriptor IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'dump upstream file is not available for adoption')
  WHERE NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = json_extract(NEW.upstream_exchanges_descriptor, '$.key')
      AND owner_kind = 'dump-upstream'
      AND owner_key = json_array(NEW.key_id, NEW.id)
      AND state = 'staged' AND claim_token IS NULL
  );
END;

CREATE TRIGGER dump_records_adopt_upstream_insert
AFTER INSERT ON dump_records
WHEN NEW.upstream_exchanges_descriptor IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE file_key = json_extract(NEW.upstream_exchanges_descriptor, '$.key')
    AND owner_kind = 'dump-upstream'
    AND owner_key = json_array(NEW.key_id, NEW.id)
    AND state = 'staged'
    AND claim_token IS NULL;
END;

CREATE TRIGGER dump_records_retire_upstream_delete
AFTER DELETE ON dump_records
WHEN OLD.upstream_exchanges_descriptor IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'retired', collect_after = 0
  WHERE file_key = json_extract(OLD.upstream_exchanges_descriptor, '$.key')
    AND state = 'owned';
END;

DROP TRIGGER dump_records_guard_reference_update;
CREATE TRIGGER dump_records_guard_reference_update
BEFORE UPDATE OF key_id, id, request_body_descriptor, response_body_descriptor, upstream_exchanges_descriptor ON dump_records
WHEN NEW.key_id IS NOT OLD.key_id OR NEW.id IS NOT OLD.id
  OR NEW.request_body_descriptor IS NOT OLD.request_body_descriptor
  OR NEW.response_body_descriptor IS NOT OLD.response_body_descriptor
  OR NEW.upstream_exchanges_descriptor IS NOT OLD.upstream_exchanges_descriptor
BEGIN
  SELECT RAISE(ABORT, 'dump file references are immutable');
END;
