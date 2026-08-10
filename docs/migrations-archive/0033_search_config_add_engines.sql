-- Phase 13-C-5 (Spec 13 §12 Q1c): add credential slots for vNext-native
-- engines (bing / copilot / langsearch) adapted into the WebSearchProvider
-- abstraction. Bing SERP scrape needs no key so its column is unused; kept
-- for schema symmetry with the future dashboard UI.
ALTER TABLE search_config ADD COLUMN bing_api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE search_config ADD COLUMN copilot_github_token TEXT NOT NULL DEFAULT '';
ALTER TABLE search_config ADD COLUMN langsearch_api_key TEXT NOT NULL DEFAULT '';
