-- OpenRemote schema. Run in Supabase SQL editor.

create extension if not exists pgcrypto;

-- ---------- sessions ----------
create table public.sessions (
  id text primary key,                -- OpenCode session id
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  project_path text,
  model text,
  status text not null default 'offline' check (status in ('online','offline','busy')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.sessions enable row level security;
create policy "sessions: own" on public.sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- events ----------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null references public.sessions(id) on delete cascade,
  kind text not null,                 -- user_message | assistant_message | tool | error | status
  role text,
  content text,
  tool_name text,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index events_session_created_idx on public.events (session_id, created_at desc);
create index events_user_created_idx on public.events (user_id, created_at desc);

alter table public.events enable row level security;
create policy "events: own" on public.events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- prompts ----------
create table public.prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null references public.sessions(id) on delete cascade,
  text text not null,
  status text not null default 'pending' check (status in ('pending','processing','done','failed')),
  error text,
  created_at timestamptz not null default now(),
  processing_at timestamptz,
  processed_at timestamptz
);

create index prompts_pending_idx on public.prompts (session_id, status, created_at);

alter table public.prompts enable row level security;
create policy "prompts: own" on public.prompts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- attachments ----------
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  prompt_id uuid not null references public.prompts(id) on delete cascade,
  storage_path text not null,
  mime text,
  created_at timestamptz not null default now()
);

alter table public.attachments enable row level security;
create policy "attachments: own" on public.attachments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- pairing ----------
create table public.pairing_codes (
  code text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  password text not null,             -- single-use credential, expires in 10 minutes
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table public.pairing_codes enable row level security;
create policy "pairing: insert own" on public.pairing_codes
  for insert with check (auth.uid() = user_id);

create or replace function public.consume_pairing(p_code text)
returns table (email text, password text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.pairing_codes
     set used_at = now()
   where code = upper(p_code)
     and used_at is null
     and expires_at > now()
  returning public.pairing_codes.email, public.pairing_codes.password;
end;
$$;

grant execute on function public.consume_pairing(text) to anon, authenticated;

-- ---------- cleanup helpers ----------
create or replace function public.cleanup_old_events(p_session_id text default null, p_older_than interval default interval '7 days')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.events
   where user_id = auth.uid()
     and created_at < now() - p_older_than
     and (p_session_id is null or session_id = p_session_id);
end;
$$;

create or replace function public.cleanup_expired_prompts(p_session_id text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- never touch pending/processing
  delete from public.prompts
   where user_id = auth.uid()
     and status in ('done','failed')
     and processed_at < now() - interval '3 days'
     and (p_session_id is null or session_id = p_session_id);
end;
$$;

grant execute on function public.cleanup_old_events(text, interval) to authenticated;
grant execute on function public.cleanup_expired_prompts(text) to authenticated;

-- ---------- storage ----------
insert into storage.buckets (id, name, public) values ('openremote-attachments', 'openremote-attachments', false)
on conflict (id) do nothing;

create policy "attachments: own upload" on storage.objects for insert
  with check (bucket_id = 'openremote-attachments' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "attachments: own read" on storage.objects for select
  using (bucket_id = 'openremote-attachments' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "attachments: own delete" on storage.objects for delete
  using (bucket_id = 'openremote-attachments' and auth.uid()::text = (storage.foldername(name))[1]);
