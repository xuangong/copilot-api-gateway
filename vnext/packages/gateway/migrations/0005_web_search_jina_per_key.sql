-- Per-key credential for the Jina search backend.
--
-- The shims pick a search backend from the API key's own configuration, and
-- five of the six backends already had somewhere to live on `api_keys`:
-- langsearch / tavily / msGrounding carry a key (and a `_ref` to borrow one
-- from another key), while bing needs no credential and copilot borrows a
-- GitHub token from the first enabled Copilot upstream. Jina had neither, so
-- it was the one backend the dashboard could not offer.
--
-- `_ref` mirrors the other three: when set, the credential is read off the
-- referenced key at request time instead of being duplicated here.

ALTER TABLE api_keys ADD COLUMN web_search_jina_key TEXT;
ALTER TABLE api_keys ADD COLUMN web_search_jina_ref TEXT;
