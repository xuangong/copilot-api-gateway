-- Preserve historical credentials while giving every physical row a distinct identity.
ALTER TABLE upstreams ADD COLUMN row_incarnation TEXT NOT NULL DEFAULT '';
UPDATE upstreams SET row_incarnation = lower(hex(randomblob(16)));

-- Older SQL callers omit the new column. Repository inserts generate it explicitly
-- because RETURNING observes values before AFTER INSERT triggers execute.
CREATE TRIGGER upstreams_initialize_incarnation AFTER INSERT ON upstreams
WHEN NEW.row_incarnation = ''
BEGIN
  UPDATE upstreams SET row_incarnation = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

CREATE TRIGGER upstreams_immutable_incarnation BEFORE UPDATE OF row_incarnation ON upstreams
WHEN OLD.row_incarnation <> '' AND OLD.row_incarnation IS NOT NEW.row_incarnation
BEGIN
  SELECT RAISE(ABORT, 'upstream row incarnation is immutable');
END;
