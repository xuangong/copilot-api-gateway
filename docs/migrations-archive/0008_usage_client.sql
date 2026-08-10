-- Recreate usage table with client column in composite PK
CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  hour TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, model, hour, client)
);

INSERT INTO usage_new (key_id, model, hour, client, requests, input_tokens, output_tokens)
  SELECT key_id, model, hour, '', requests, input_tokens, output_tokens
  FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage (hour);
