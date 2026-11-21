-- BLOBS schema for Supabase Postgres.
--
-- The server applies this file on boot, so a brand-new Supabase project
-- bootstraps itself. It is idempotent: every statement is IF NOT EXISTS, so
-- re-running it, or pasting it into the Supabase SQL editor, is safe.
--
-- Conventions match the original SQLite schema deliberately:
--   * timestamps are BIGINT milliseconds since the epoch (never timestamptz),
--     so date maths in the app stays plain integer arithmetic;
--   * flags are INTEGER 0/1, so existing comparisons such as `pinned = 1`
--     and `ORDER BY pinned DESC` keep working unchanged.

create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at bigint not null
);

create table if not exists secrets (
  key text primary key,
  value text not null,
  updated_at bigint not null
);

create table if not exists owner (
  id integer primary key check (id = 1),
  name text not null,
  passphrase_hash text not null,
  salt text not null,
  created_at bigint not null
);

-- Email identity for Supabase Auth. Once SUPABASE_URL and the service-role
-- key are set, this row is the owner and the passphrase columns in `owner`
-- above are ignored; the password itself lives in Supabase Auth, not here.
create table if not exists owner_identity (
  id integer primary key check (id = 1),
  email text not null,
  supabase_user_id text,
  created_at bigint not null
);

create table if not exists sessions (
  token_hash text primary key,
  created_at bigint not null,
  expires_at bigint not null,
  last_seen bigint not null
);
create index if not exists idx_sessions_expires on sessions(expires_at);

create table if not exists conversations (
  id text primary key,
  channel text not null default 'web',
  title text,
  summary text,
  created_at bigint not null,
  updated_at bigint not null,
  archived integer not null default 0,
  meta text
);
create index if not exists idx_conversations_updated on conversations(updated_at desc);

create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations(id) on delete cascade,
  role text not null,
  content text not null,
  tool_calls text,
  tool_call_id text,
  tool_name text,
  untrusted integer not null default 0,
  model text,
  created_at bigint not null
);
create index if not exists idx_messages_conversation on messages(conversation_id, created_at);

create table if not exists memories (
  id text primary key,
  kind text not null default 'fact',
  content text not null,
  tags text not null default '',
  importance integer not null default 3,
  source text,
  pinned integer not null default 0,
  created_at bigint not null,
  updated_at bigint not null,
  last_used_at bigint,
  use_count integer not null default 0
);
create index if not exists idx_memories_kind on memories(kind);

-- Full-text search. The original schema used an FTS5 virtual table with the
-- porter tokenizer; Postgres gets the same behaviour from a GIN index over an
-- immutable tsvector expression, which needs no triggers and no shadow table.
create index if not exists idx_memories_search on memories
  using gin (to_tsvector('english', coalesce(content, '') || ' ' || coalesce(tags, '')));

create table if not exists projects (
  id text primary key,
  title text not null,
  objective text not null default '',
  status text not null default 'active',
  notes text not null default '',
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists tasks (
  id text primary key,
  project_id text references projects(id) on delete set null,
  title text not null,
  objective text not null,
  status text not null default 'queued',
  autonomy text not null default 'assisted',
  schedule text,
  next_run_at bigint,
  last_run_at bigint,
  heartbeat bigint,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  plan text,
  checkpoint text,
  result text,
  error text,
  origin text not null default 'owner',
  created_at bigint not null,
  updated_at bigint not null,
  completed_at bigint
);
create index if not exists idx_tasks_status on tasks(status, next_run_at);

create table if not exists task_steps (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  idx integer not null,
  description text not null,
  status text not null default 'pending',
  output text,
  started_at bigint,
  finished_at bigint
);
create index if not exists idx_task_steps_task on task_steps(task_id, idx);

create table if not exists responsibilities (
  id text primary key,
  project_id text references projects(id) on delete set null,
  title text not null,
  objective text not null default '',
  cadence_minutes integer not null default 1440,
  status text not null default 'active',
  last_run_at bigint,
  next_run_at bigint,
  last_outcome text,
  last_task_id text,
  run_count integer not null default 0,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists idx_responsibilities_due on responsibilities(status, next_run_at);

create table if not exists deliverables (
  id text primary key,
  task_id text,
  conversation_id text,
  responsibility_id text,
  title text not null,
  kind text not null default 'markdown',
  body text not null default '',
  public_token text,
  public_expires_at bigint,
  created_at bigint not null
);
create index if not exists idx_deliverables_created on deliverables(created_at desc);
create unique index if not exists idx_deliverables_token on deliverables(public_token);

create table if not exists oauth_connections (
  provider text primary key,
  account text,
  scopes text not null default '',
  access_expires_at bigint,
  connected_at bigint not null
);

create table if not exists oauth_states (
  state text primary key,
  provider text not null,
  client_id text not null,
  redirect_uri text not null,
  code_verifier text not null,
  scopes text not null default '',
  created_at bigint not null,
  expires_at bigint not null
);

create table if not exists approvals (
  id text primary key,
  kind text not null,
  title text not null,
  detail text not null default '',
  payload text not null,
  status text not null default 'pending',
  task_id text,
  conversation_id text,
  created_at bigint not null,
  decided_at bigint,
  decision_note text
);
create index if not exists idx_approvals_status on approvals(status, created_at desc);

create table if not exists activity (
  id text primary key,
  ts bigint not null,
  level text not null default 'info',
  category text not null default 'agent',
  message text not null,
  meta text,
  task_id text,
  conversation_id text
);
create index if not exists idx_activity_ts on activity(ts desc);

create table if not exists integrations (
  key text primary key,
  status text not null default 'disconnected',
  config text,
  updated_at bigint not null
);

create table if not exists comms_events (
  id text primary key,
  channel text not null,
  direction text not null,
  peer text,
  subject text,
  body text,
  status text not null default 'logged',
  external_id text,
  meta text,
  created_at bigint not null
);
create index if not exists idx_comms_created on comms_events(created_at desc);

create table if not exists usage_log (
  id text primary key,
  ts bigint not null,
  provider text not null,
  model text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  ok integer not null default 1,
  kind text not null default 'chat',
  task_id text
);
create index if not exists idx_usage_ts on usage_log(ts desc);

create table if not exists notifications (
  id text primary key,
  ts bigint not null,
  title text not null,
  body text not null default '',
  level text not null default 'info',
  read integer not null default 0,
  link text
);
create index if not exists idx_notifications_ts on notifications(ts desc);

-- Deep research: one row per run, the sources it read, and the claims it
-- extracted with a supporting quote. Excerpts are stored so a citation can be
-- checked after the page changes or the link dies.
create table if not exists research_runs (
  id text primary key,
  question text not null,
  depth text not null default 'quick',
  status text not null default 'running',
  plan text,
  deliverable_id text,
  source_count integer not null default 0,
  claim_count integer not null default 0,
  error text,
  created_at bigint not null,
  finished_at bigint
);
create index if not exists idx_research_runs_created on research_runs(created_at desc);

create table if not exists research_sources (
  id text primary key,
  run_id text not null references research_runs(id) on delete cascade,
  idx integer not null,
  url text not null,
  title text not null default '',
  domain text not null default '',
  published text not null default '',
  excerpt text not null default '',
  retrieved_at bigint not null
);
create index if not exists idx_research_sources_run on research_sources(run_id, idx);

create table if not exists research_claims (
  id text primary key,
  run_id text not null references research_runs(id) on delete cascade,
  source_idx integer not null,
  claim text not null,
  quote text not null default '',
  created_at bigint not null
);
create index if not exists idx_research_claims_run on research_claims(run_id, source_idx);

-- Proactive watches: a page, feed or search checked on a cadence. A changed
-- fingerprint notifies the owner and can queue an investigation task.
create table if not exists watches (
  id text primary key,
  kind text not null,
  target text not null,
  label text not null default '',
  cadence_minutes integer not null default 360,
  status text not null default 'active',
  notify_on_change integer not null default 1,
  create_task_on_change integer not null default 1,
  last_checked_at bigint,
  last_fingerprint text,
  last_change_at bigint,
  last_summary text,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists idx_watches_due on watches(status, last_checked_at);
