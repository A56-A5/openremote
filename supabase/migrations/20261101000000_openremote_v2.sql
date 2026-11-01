-- OpenRemote v2 - schema, RLS, RPCs, Realtime publication.
-- Fresh install: run this whole file once in the Supabase SQL editor (as
-- postgres). No password or credential is stored anywhere.
--
-- Roles:
--   owner (O)      - anonymous user created on the machine by `openremote connect`.
--   viewer (V)     - anonymous user created in the browser after pairing.
--   anon           - gets nothing (no policies, no RPC execute).
--
-- Run in the Supabase SQL editor (as postgres).

create extension if not exists pgcrypto;

-- ===========================================================================
-- Data model (every row carries owner_id)
-- ===========================================================================

-- Machines are heartbeat holders; they are deliberately NOT in the Realtime
-- publication - the web reads them over REST every 60s.
create table if not exists public.machines (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  name           text not null default 'my machine',
  version        text,
  -- null means "stopped by `openremote stop`" → the web renders it offline.
  last_heartbeat timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists machines_owner_idx on public.machines (owner_id);

create table if not exists public.sessions (
  id            text primary key,              -- OpenCode session id
  machine_id    uuid not null references public.machines (id) on delete cascade,
  owner_id      uuid not null references auth.users (id) on delete cascade,
  title         text,
  directory     text,
  status        text not null default 'done'
                check (status in ('working', 'needs_you', 'done', 'error')),
  status_since  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists sessions_owner_idx on public.sessions (owner_id, updated_at desc);
create index if not exists sessions_machine_idx on public.sessions (machine_id);

-- Completed messages only. No deltas, ever.
create table if not exists public.messages (
  id          text primary key,                -- OpenCode message id
  session_id  text not null references public.sessions (id) on delete cascade,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  text        text not null default '',
  truncated   boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists messages_session_idx on public.messages (session_id, created_at);
create index if not exists messages_owner_idx on public.messages (owner_id, created_at desc);

create table if not exists public.file_activity (
  session_id text not null references public.sessions (id) on delete cascade,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  path       text not null,
  edit_count integer not null default 0,
  last_op    text not null check (last_op in ('created', 'edited', 'deleted')),
  first_at   timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  primary key (session_id, path)
);

create index if not exists file_activity_owner_idx on public.file_activity (owner_id, last_at desc);

create table if not exists public.prompts (
  id          uuid primary key,                -- client-generated
  session_id  text not null references public.sessions (id) on delete cascade,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  text        text not null check (char_length(text) <= 20000),
  status      text not null default 'pending'
              check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts    integer not null default 0,
  claimed_by  uuid references public.machines (id) on delete set null,
  lease_until timestamptz,
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists prompts_claim_idx on public.prompts (owner_id, status, created_at);
create index if not exists prompts_lease_idx on public.prompts (status, lease_until);

create table if not exists public.permissions (
  id                     uuid primary key default gen_random_uuid(),
  session_id             text not null references public.sessions (id) on delete cascade,
  owner_id               uuid not null references auth.users (id) on delete cascade,
  opencode_permission_id text not null unique,  -- OpenCode's permission id
  tool                   text,
  title                  text,
  detail                 jsonb not null default '{}'::jsonb,
  status                 text not null default 'pending'
                         check (status in ('pending', 'allowed_once', 'allowed_always',
                                           'denied', 'resolved_locally', 'expired')),
  decided_at             timestamptz,
  -- set by the worker after it has been applied to OpenCode
  applied_at             timestamptz,
  created_at             timestamptz not null default now()
);

create index if not exists permissions_session_idx on public.permissions (session_id, status);
create index if not exists permissions_owner_idx on public.permissions (owner_id, status);

-- Browser ↔ machine links. Many-to-many.
create table if not exists public.links (
  owner_id   uuid not null references auth.users (id) on delete cascade,
  viewer_id  uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, viewer_id)
);

create index if not exists links_viewer_idx on public.links (viewer_id);

-- Pairing codes: salted hash only, never the plaintext code, never a password.
create table if not exists public.pairings (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  code_hash  text not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  attempts   integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists pairings_owner_idx on public.pairings (owner_id, created_at desc);

-- Throttle fuel for claim_pairing. No client access at all.
create table if not exists public.pairing_failures (
  id       bigserial primary key,
  viewer_id uuid not null,
  at       timestamptz not null default now()
);

create index if not exists pairing_failures_viewer_idx on public.pairing_failures (viewer_id, at);
create index if not exists pairing_failures_at_idx on public.pairing_failures (at);

-- ===========================================================================
-- Row level security
-- ===========================================================================

alter table public.machines         enable row level security;
alter table public.sessions         enable row level security;
alter table public.messages         enable row level security;
alter table public.file_activity    enable row level security;
alter table public.prompts          enable row level security;
alter table public.permissions      enable row level security;
alter table public.links            enable row level security;
alter table public.pairings         enable row level security;
alter table public.pairing_failures enable row level security;

-- Helper: is the current user a viewer linked to p_owner?
create or replace function public.is_linked_viewer(p_owner uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.links l
     where l.owner_id = p_owner and l.viewer_id = auth.uid()
  );
$$;

revoke execute on function public.is_linked_viewer(uuid) from public, anon;
grant execute on function public.is_linked_viewer(uuid) to authenticated;

-- Owner: full access. Viewer: SELECT only. (Applied per table below.)
drop policy if exists "machines owner"      on public.machines;
drop policy if exists "machines viewer"     on public.machines;
create policy "machines owner"  on public.machines for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "machines viewer" on public.machines for select
  using (public.is_linked_viewer(owner_id));

drop policy if exists "sessions owner"      on public.sessions;
drop policy if exists "sessions viewer"     on public.sessions;
create policy "sessions owner"  on public.sessions for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "sessions viewer" on public.sessions for select
  using (public.is_linked_viewer(owner_id));

drop policy if exists "messages owner"      on public.messages;
drop policy if exists "messages viewer"     on public.messages;
create policy "messages owner"  on public.messages for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "messages viewer" on public.messages for select
  using (public.is_linked_viewer(owner_id));

drop policy if exists "file_activity owner"  on public.file_activity;
drop policy if exists "file_activity viewer" on public.file_activity;
create policy "file_activity owner"  on public.file_activity for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "file_activity viewer" on public.file_activity for select
  using (public.is_linked_viewer(owner_id));

drop policy if exists "prompts owner"         on public.prompts;
drop policy if exists "prompts viewer select" on public.prompts;
drop policy if exists "prompts viewer insert" on public.prompts;
create policy "prompts owner" on public.prompts for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "prompts viewer select" on public.prompts for select
  using (public.is_linked_viewer(owner_id));
-- Viewers may only enqueue a pristine pending prompt; claiming/delivery state
-- is worker-owned and reachable exclusively through claim_prompts().
create policy "prompts viewer insert" on public.prompts for insert
  with check (
    public.is_linked_viewer(owner_id)
    and status = 'pending'
    and attempts = 0
    and claimed_by is null
    and lease_until is null
    and error is null
    and char_length(text) <= 20000
  );

drop policy if exists "permissions owner"      on public.permissions;
drop policy if exists "permissions viewer"     on public.permissions;
create policy "permissions owner"  on public.permissions for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "permissions viewer" on public.permissions for select
  using (public.is_linked_viewer(owner_id));

-- links: visible to both sides; writes only through RPCs.
drop policy if exists "links select" on public.links;
create policy "links select" on public.links for select
  using (owner_id = auth.uid() or viewer_id = auth.uid());

-- pairings / pairing_failures: no client policies at all.

revoke all on public.pairings         from anon, authenticated;
revoke all on public.pairing_failures from anon, authenticated;

-- ===========================================================================
-- RPCs
-- ===========================================================================

-- Crockford base32 normalization: strip separators, fold I/L→1 and O→0,
-- reject anything outside the alphabet (including U).
create or replace function public.normalize_pairing_code(p_code text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text;
begin
  if p_code is null then
    return null;
  end if;
  v := upper(regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g'));
  v := replace(replace(replace(v, 'I', '1'), 'L', '1'), 'O', '0');
  if v !~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$' then
    return null;
  end if;
  return v;
end;
$$;

revoke execute on function public.normalize_pairing_code(text) from public, anon, authenticated;

-- Mint a single-use pairing code. Returns the plaintext ONCE; only a salted
-- bcrypt hash is stored. Valid10 minutes.
create or replace function public.create_pairing()
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner   uuid := auth.uid();
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes   bytea := gen_random_bytes(8);
  v_code    text := '';
  v_hash    text;
  i         int;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  -- keep the table small: drop this owner's spent/expired rows first
  delete from public.pairings
   where owner_id = v_owner
     and (used_at is not null or expires_at < now() - interval '1 day');

  if (select count(*) from public.pairings
       where owner_id = v_owner and used_at is null and expires_at > now()) >= 5 then
    raise exception 'too many active pairing codes';
  end if;

  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;

  v_hash := crypt(v_code, gen_salt('bf', 10));

  insert into public.pairings (owner_id, code_hash, expires_at)
  values (v_owner, v_hash, now() + interval '10 minutes');

  return query select substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4),
                      now() + interval '10 minutes';
end;
$$;

revoke execute on function public.create_pairing() from public, anon;
grant  execute on function public.create_pairing() to authenticated;

-- Throttles: max 5 failed attempts per viewer per 10 min, plus a global
-- circuit breaker (>20 failures in the last minute blocks claims for 60s).
create or replace function public.claim_pairing(p_code text)
returns table (status text, owner_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_viewer uuid := auth.uid();
  v_norm   text;
  v_row    record;
  v_fails  int;
begin
  if v_viewer is null then
    return query select 'unauthorized'::text, null::uuid;
    return;
  end if;

  v_norm := public.normalize_pairing_code(p_code);
  if v_norm is null or length(v_norm) <> 8 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  select count(*) into v_fails
    from public.pairing_failures
   where viewer_id = v_viewer and at > now() - interval '10 minutes';
  if v_fails >= 5 then
    return query select 'throttled'::text, null::uuid;
    return;
  end if;

  select count(*) into v_fails
    from public.pairing_failures
   where at > now() - interval '60 seconds';
  if v_fails > 20 then
    return query select 'throttled'::text, null::uuid;
    return;
  end if;

  for v_row in
    select id, owner_id, code_hash, expires_at, used_at
      from public.pairings
     where created_at > now() - interval '1 day'
     order by created_at desc
     limit 50
  loop
    if crypt(v_norm, v_row.code_hash) = v_row.code_hash then
      if v_row.used_at is not null then
        return query select 'used'::text, null::uuid;
        return;
      end if;
      if v_row.expires_at <= now() then
        return query select 'expired'::text, null::uuid;
        return;
      end if;
      update public.pairings
         set used_at = now(), attempts = attempts + 1
       where id = v_row.id and used_at is null;
      if not found then
        return query select 'used'::text, null::uuid;
        return;
      end if;
      insert into public.links (owner_id, viewer_id)
      values (v_row.owner_id, v_viewer)
      on conflict do nothing;
      return query select 'ok'::text, v_row.owner_id;
      return;
    end if;
  end loop;

  insert into public.pairing_failures (viewer_id) values (v_viewer);
  return query select 'invalid'::text, null::uuid;
end;
$$;

-- Never executable by anon, and never by PUBLIC (default Postgres grant).
revoke execute on function public.claim_pairing(text) from public, anon;
grant  execute on function public.claim_pairing(text) to authenticated;

-- Viewer decisions from the web. Only ever transitions out of `pending`.
create or replace function public.decide_permission(p_id uuid, p_decision text)
returns table (session_id text, opencode_permission_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_decision not in ('allowed_once', 'allowed_always', 'denied') then
    raise exception 'invalid decision';
  end if;

  update public.permissions
     set status = p_decision, decided_at = now()
   where id = p_id
     and status = 'pending'
     and (owner_id = v_uid or public.is_linked_viewer(owner_id))
  returning session_id, opencode_permission_id into v_row;

  if v_row is null then
    raise exception 'permission not pending';
  end if;

  return query select v_row.session_id, v_row.opencode_permission_id;
end;
$$;

revoke execute on function public.decide_permission(uuid, text) from public, anon;
grant  execute on function public.decide_permission(uuid, text) to authenticated;

-- Failed → pending again (manual Retry). Never touches sending/delivered.
create or replace function public.retry_prompt(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  update public.prompts
     set status = 'pending', error = null, claimed_by = null,
         lease_until = null, attempts = 0
   where id = p_id
     and status = 'failed'
     and (owner_id = v_uid or public.is_linked_viewer(owner_id))
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.retry_prompt(uuid) from public, anon;
grant  execute on function public.retry_prompt(uuid) to authenticated;

-- Claim queued prompts for this machine. FOR UPDATE SKIP LOCKED makes
-- concurrent claims safe; a stale `sending` row whose lease expired becomes
-- `failed` ("unknown, retry?") and is never auto-resent (at-most-once).
create or replace function public.claim_prompts(
  p_machine_id uuid,
  p_limit integer default 5,
  p_lease_seconds integer default 30
)
returns table (id uuid, session_id text, text text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.machines m where m.id = p_machine_id and m.owner_id = v_uid) then
    raise exception 'unknown machine';
  end if;

  update public.prompts
     set status = 'failed',
         error = 'unknown, retry?',
         claimed_by = null,
         lease_until = null
   where owner_id = v_uid
     and status = 'sending'
     and lease_until is not null
     and lease_until < now();

  return query
  with claimed as (
    update public.prompts p
       set status = 'sending',
           claimed_by = p_machine_id,
           lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 5)),
           attempts = p.attempts + 1
     where p.id in (
       select q.id
         from public.prompts q
        where q.owner_id = v_uid and q.status = 'pending'
        order by q.created_at
        limit greatest(p_limit, 1)
        for update skip locked
     )
    returning p.id, p.session_id, p.text
  )
  select c.id, c.session_id, c.text from claimed c;
end;
$$;

revoke execute on function public.claim_prompts(uuid, integer, integer) from public, anon;
grant  execute on function public.claim_prompts(uuid, integer, integer) to authenticated;

-- Revoke a browser. The owner may revoke any of their viewers; a viewer may
-- remove itself.
create or replace function public.unlink(p_viewer_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ok  boolean := false;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  delete from public.links
   where viewer_id = p_viewer_id
     and (owner_id = v_uid or viewer_id = v_uid);
  v_ok := found;
  return v_ok;
end;
$$;

revoke execute on function public.unlink(uuid) from public, anon;
grant  execute on function public.unlink(uuid) to authenticated;

-- pairing_failures has no client policies, so its maintenance is a definer RPC.
create or replace function public.cleanup_pairing_failures()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.pairing_failures where at < now() - interval '1 day';
end;
$$;

revoke execute on function public.cleanup_pairing_failures() from public, anon;
grant  execute on function public.cleanup_pairing_failures() to authenticated;

-- ===========================================================================
-- Realtime publication - machines and pairings stay out of it.
-- ===========================================================================

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['sessions', 'messages', 'file_activity', 'prompts', 'permissions']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
  end loop;
end $$;
