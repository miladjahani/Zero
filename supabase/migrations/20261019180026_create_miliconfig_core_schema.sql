/*
# Create miliconfig core schema in Supabase

1. New Tables
- `profiles`: application profile linked to Supabase Auth, including role and deployment quota.
- `cf_tokens`, `render_tokens`, `railway_tokens`: provider credentials owned by one signed-in user.
- `deployments`, `railway_deploys`, `render_deploys`: deployment records and provider-specific deployment state.
- `bot_config`, `bot_users`, `bot_sessions`: Telegram bot configuration, users, and conversation state.
- `activity_logs`: per-user audit history.
- `optimizer_jobs`, `sub_groups`, `injector_jobs`: subscription and optimization jobs owned by a user.
- `worker_members`: subscription members belonging to a user's deployment.

2. Data types
- Supabase Auth UUIDs are used for ownership instead of the old D1 text identifiers.
- JSON-like D1 text fields are stored as PostgreSQL `jsonb`.
- Timestamps use `timestamptz` and default to the current time.

3. Security
- Row Level Security is enabled on every table.
- Authenticated users can only read and change rows owned by their own Auth account.
- Provider secrets remain in protected owner-scoped rows and are never public.

4. Important notes
- This migration is additive and does not remove or alter the existing Cloudflare D1 schema.
- The application API must be switched to these tables before D1 can be retired.
*/

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'user' check (role in ('user', 'admin')),
  max_deployments integer not null default 100,
  is_owner boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.cf_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  token text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.render_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  token text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  account_name text,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.railway_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  token text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  account_name text,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.deployments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  worker_code text not null default '',
  config jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'deploying', 'deployed', 'failed')),
  worker_url text,
  route text,
  error_message text,
  logs text,
  worker_uuid text,
  custom_path text,
  custom_domain text,
  kv_namespace_id text,
  panel_url text,
  sub_url text,
  method text not null default 'workers' check (method in ('workers', 'pages')),
  worker_source text not null default 'edgetunnel',
  cf_account_id text,
  cf_token_row_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.railway_deploys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  token_id uuid references public.railway_tokens(id) on delete set null,
  project_id text not null,
  service_id text not null,
  environment_id text not null,
  current_deployment_id text,
  region text not null default 'europe-west4-drams3a',
  domain text,
  branch text not null default 'main',
  commit_sha text,
  commit_url text,
  project_token text,
  tcp_proxy_id text,
  tcp_proxy_domain text,
  tcp_proxy_port integer,
  tcp_proxy_application_port integer,
  tcp_proxy_error text,
  tcp_proxies jsonb not null default '[]'::jsonb,
  auto_deploy boolean not null default true,
  name text,
  panel text,
  admin_username text,
  admin_password text,
  setup_done boolean not null default false,
  auto_update boolean not null default false,
  last_version text,
  last_updated_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.render_deploys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  token_id uuid references public.render_tokens(id) on delete set null,
  service_id text not null,
  name text,
  panel text,
  url text,
  admin_username text,
  admin_password text,
  setup_done boolean not null default false,
  auto_update boolean not null default false,
  last_version text,
  last_updated_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.bot_config (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  bot_token text not null,
  bot_username text,
  webhook_url text,
  webhook_secret text,
  is_active boolean not null default true,
  welcome_message text not null default 'سلام! به ربات miliconfig خوش آمدید. برای شروع /start را بفرستید.',
  chat_id text,
  claim_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bot_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  telegram_id text not null,
  username text,
  first_name text,
  last_name text,
  is_active boolean not null default true,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  last_activity timestamptz,
  unique (user_id, telegram_id)
);

create table if not exists public.bot_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  telegram_id text not null,
  state text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  action text not null,
  entity_type text not null default 'general',
  entity_name text,
  details jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.optimizer_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  input jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  result_nodes jsonb not null default '[]'::jsonb,
  result_sub text not null default '',
  sub_token text not null unique,
  nodes_total integer not null default 0,
  nodes_alive integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sub_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  deployment_ids jsonb not null default '[]'::jsonb,
  sub_token text not null unique,
  ips jsonb not null default '[]'::jsonb,
  proxies jsonb not null default '[]'::jsonb,
  inject boolean not null default false,
  format text not null default 'base64',
  extra_links jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.injector_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  source text not null,
  ips jsonb not null default '[]'::jsonb,
  proxies jsonb not null default '[]'::jsonb,
  sub_token text not null unique,
  rotate_minutes integer,
  ech boolean not null default false,
  ech_sni text,
  ech_dns text,
  fragment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.worker_members (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  deployment_id uuid not null references public.deployments(id) on delete cascade,
  name text not null,
  token text not null unique,
  enabled boolean not null default true,
  expires_at timestamptz,
  quota_bytes bigint,
  request_quota bigint,
  ip_limit integer,
  used_bytes bigint not null default 0,
  used_requests bigint not null default 0,
  recent_ips jsonb not null default '[]'::jsonb,
  start_on_connect boolean not null default false,
  activated_at timestamptz,
  reset_period_days integer,
  last_reset_at timestamptz,
  notified_level integer not null default 0,
  usage_updated_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_cf_tokens_user on public.cf_tokens(user_id);
create index if not exists idx_render_tokens_user on public.render_tokens(user_id);
create index if not exists idx_railway_tokens_user on public.railway_tokens(user_id);
create index if not exists idx_deployments_user on public.deployments(user_id);
create index if not exists idx_deployments_status on public.deployments(status);
create index if not exists idx_railway_deploys_user on public.railway_deploys(user_id);
create index if not exists idx_render_deploys_user on public.render_deploys(user_id);
create index if not exists idx_bot_users_user on public.bot_users(user_id);
create index if not exists idx_bot_sessions_user on public.bot_sessions(user_id);
create index if not exists idx_activity_logs_user on public.activity_logs(user_id);
create index if not exists idx_optimizer_jobs_user on public.optimizer_jobs(user_id);
create index if not exists idx_sub_groups_user on public.sub_groups(user_id);
create index if not exists idx_injector_jobs_user on public.injector_jobs(user_id);
create index if not exists idx_worker_members_owner on public.worker_members(owner_user_id);
create index if not exists idx_worker_members_deployment on public.worker_members(deployment_id);

alter table public.profiles enable row level security;
alter table public.cf_tokens enable row level security;
alter table public.render_tokens enable row level security;
alter table public.railway_tokens enable row level security;
alter table public.deployments enable row level security;
alter table public.railway_deploys enable row level security;
alter table public.render_deploys enable row level security;
alter table public.bot_config enable row level security;
alter table public.bot_users enable row level security;
alter table public.bot_sessions enable row level security;
alter table public.activity_logs enable row level security;
alter table public.optimizer_jobs enable row level security;
alter table public.sub_groups enable row level security;
alter table public.injector_jobs enable row level security;
alter table public.worker_members enable row level security;

create or replace function public.create_profile_for_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.create_profile_for_user();

create policy "profiles_select_own" on public.profiles for select to authenticated using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
create policy "profiles_delete_own" on public.profiles for delete to authenticated using (auth.uid() = id);

create policy "cf_tokens_select_own" on public.cf_tokens for select to authenticated using (auth.uid() = user_id);
create policy "cf_tokens_insert_own" on public.cf_tokens for insert to authenticated with check (auth.uid() = user_id);
create policy "cf_tokens_update_own" on public.cf_tokens for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "cf_tokens_delete_own" on public.cf_tokens for delete to authenticated using (auth.uid() = user_id);

create policy "render_tokens_select_own" on public.render_tokens for select to authenticated using (auth.uid() = user_id);
create policy "render_tokens_insert_own" on public.render_tokens for insert to authenticated with check (auth.uid() = user_id);
create policy "render_tokens_update_own" on public.render_tokens for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "render_tokens_delete_own" on public.render_tokens for delete to authenticated using (auth.uid() = user_id);

create policy "railway_tokens_select_own" on public.railway_tokens for select to authenticated using (auth.uid() = user_id);
create policy "railway_tokens_insert_own" on public.railway_tokens for insert to authenticated with check (auth.uid() = user_id);
create policy "railway_tokens_update_own" on public.railway_tokens for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "railway_tokens_delete_own" on public.railway_tokens for delete to authenticated using (auth.uid() = user_id);

create policy "deployments_select_own" on public.deployments for select to authenticated using (auth.uid() = user_id);
create policy "deployments_insert_own" on public.deployments for insert to authenticated with check (auth.uid() = user_id);
create policy "deployments_update_own" on public.deployments for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "deployments_delete_own" on public.deployments for delete to authenticated using (auth.uid() = user_id);

create policy "railway_deploys_select_own" on public.railway_deploys for select to authenticated using (auth.uid() = user_id);
create policy "railway_deploys_insert_own" on public.railway_deploys for insert to authenticated with check (auth.uid() = user_id);
create policy "railway_deploys_update_own" on public.railway_deploys for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "railway_deploys_delete_own" on public.railway_deploys for delete to authenticated using (auth.uid() = user_id);

create policy "render_deploys_select_own" on public.render_deploys for select to authenticated using (auth.uid() = user_id);
create policy "render_deploys_insert_own" on public.render_deploys for insert to authenticated with check (auth.uid() = user_id);
create policy "render_deploys_update_own" on public.render_deploys for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "render_deploys_delete_own" on public.render_deploys for delete to authenticated using (auth.uid() = user_id);

create policy "bot_config_select_own" on public.bot_config for select to authenticated using (auth.uid() = user_id);
create policy "bot_config_insert_own" on public.bot_config for insert to authenticated with check (auth.uid() = user_id);
create policy "bot_config_update_own" on public.bot_config for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bot_config_delete_own" on public.bot_config for delete to authenticated using (auth.uid() = user_id);

create policy "bot_users_select_own" on public.bot_users for select to authenticated using (auth.uid() = user_id);
create policy "bot_users_insert_own" on public.bot_users for insert to authenticated with check (auth.uid() = user_id);
create policy "bot_users_update_own" on public.bot_users for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bot_users_delete_own" on public.bot_users for delete to authenticated using (auth.uid() = user_id);

create policy "bot_sessions_select_own" on public.bot_sessions for select to authenticated using (auth.uid() = user_id);
create policy "bot_sessions_insert_own" on public.bot_sessions for insert to authenticated with check (auth.uid() = user_id);
create policy "bot_sessions_update_own" on public.bot_sessions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bot_sessions_delete_own" on public.bot_sessions for delete to authenticated using (auth.uid() = user_id);

create policy "activity_logs_select_own" on public.activity_logs for select to authenticated using (auth.uid() = user_id);
create policy "activity_logs_insert_own" on public.activity_logs for insert to authenticated with check (auth.uid() = user_id);
create policy "activity_logs_update_own" on public.activity_logs for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "activity_logs_delete_own" on public.activity_logs for delete to authenticated using (auth.uid() = user_id);

create policy "optimizer_jobs_select_own" on public.optimizer_jobs for select to authenticated using (auth.uid() = user_id);
create policy "optimizer_jobs_insert_own" on public.optimizer_jobs for insert to authenticated with check (auth.uid() = user_id);
create policy "optimizer_jobs_update_own" on public.optimizer_jobs for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "optimizer_jobs_delete_own" on public.optimizer_jobs for delete to authenticated using (auth.uid() = user_id);

create policy "sub_groups_select_own" on public.sub_groups for select to authenticated using (auth.uid() = user_id);
create policy "sub_groups_insert_own" on public.sub_groups for insert to authenticated with check (auth.uid() = user_id);
create policy "sub_groups_update_own" on public.sub_groups for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "sub_groups_delete_own" on public.sub_groups for delete to authenticated using (auth.uid() = user_id);

create policy "injector_jobs_select_own" on public.injector_jobs for select to authenticated using (auth.uid() = user_id);
create policy "injector_jobs_insert_own" on public.injector_jobs for insert to authenticated with check (auth.uid() = user_id);
create policy "injector_jobs_update_own" on public.injector_jobs for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "injector_jobs_delete_own" on public.injector_jobs for delete to authenticated using (auth.uid() = user_id);

create policy "worker_members_select_own" on public.worker_members for select to authenticated using (auth.uid() = owner_user_id);
create policy "worker_members_insert_own" on public.worker_members for insert to authenticated with check (auth.uid() = owner_user_id);
create policy "worker_members_update_own" on public.worker_members for update to authenticated using (auth.uid() = owner_user_id) with check (auth.uid() = owner_user_id);
create policy "worker_members_delete_own" on public.worker_members for delete to authenticated using (auth.uid() = owner_user_id);
