-- Recreate github_accounts with composite PK (user_id, owner_id)
-- This allows the same GitHub user to be bound by multiple owners independently
CREATE TABLE github_accounts_new (
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'individual',
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  owner_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, owner_id)
);

INSERT INTO github_accounts_new (user_id, token, account_type, login, name, avatar_url, owner_id)
  SELECT user_id, token, account_type, login, name, avatar_url, COALESCE(owner_id, '')
  FROM github_accounts;

DROP TABLE github_accounts;
ALTER TABLE github_accounts_new RENAME TO github_accounts;
