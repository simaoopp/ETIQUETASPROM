-- PromoPilot — article database sync hardening for files up to 300,000 articles.

alter table if exists public.article_sync_logs
  add column if not exists last_batch_index integer not null default -1;

-- artigo is already the primary key in the canonical schema, so PostgreSQL
-- already has a btree index for the 300k lookup path.
analyze public.articles;
analyze public.article_sync_logs;
