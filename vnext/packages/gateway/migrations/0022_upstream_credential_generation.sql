-- Credential identity must survive routine state and transport changes while
-- distinguishing an explicit replacement, even when its bytes are unchanged.
ALTER TABLE upstreams ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 0 CHECK (credential_generation >= 0);

CREATE TRIGGER upstreams_credential_generation_monotonic BEFORE UPDATE OF credential_generation ON upstreams
WHEN NEW.credential_generation < OLD.credential_generation
BEGIN
  SELECT RAISE(ABORT, 'credential generation cannot decrease');
END;
