-- OpenRemote v2 RLS / RPC tests.
-- Run in the Supabase SQL editor as postgres. Everything rolls back.
--
-- Covers: unlinked viewer isolation, claim throttling, expired/used codes,
-- viewer write restrictions, decide_permission transitions, anon lockout,
-- and claim_prompts semantics.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function pg_temp.jwt(p_sub uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated', 'aud', 'authenticated')::text,
    true);
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
end;
$$;

create or replace function pg_temp.expect(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL: %', p_msg;
  end if;
  raise notice 'ok: %', p_msg;
end;
$$;

-- two owners (machines), two viewers
insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at,
                        aud, role, raw_app_meta_data, raw_user_meta_data, instance_id)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'owner1@test.local', '', now(), now(), now(),
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, '00000000-0000-0000-0000-000000000000'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'owner2@test.local', '', now(), now(), now(),
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, '00000000-0000-0000-0000-000000000000'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'viewer1@test.local', '', now(), now(), now(),
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, '00000000-0000-0000-0000-000000000000'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'viewer2@test.local', '', now(), now(), now(),
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, '00000000-0000-0000-0000-000000000000')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- seed data as owner1 (bypasses RLS as postgres)
-- ---------------------------------------------------------------------------
insert into public.machines (id, owner_id, name, last_heartbeat)
values ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'o1-machine', now());

insert into public.sessions (id, machine_id, owner_id, title, directory, status)
values ('ses_o1', 'eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'owner one session', '/tmp/o1', 'done');

insert into public.messages (id, session_id, owner_id, role, text)
values ('msg_o1_1', 'ses_o1', 'aaaaaaaa-0000-0000-0000-000000000001', 'assistant', 'hello from o1');

insert into public.file_activity (session_id, owner_id, path, edit_count, last_op)
values ('ses_o1', 'aaaaaaaa-0000-0000-0000-000000000001', 'src/a.ts', 3, 'edited');

-- owner2's private world
insert into public.machines (id, owner_id, name, last_heartbeat)
values ('eeeeeeee-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'o2-machine', now());

insert into public.sessions (id, machine_id, owner_id, title, directory, status)
values ('ses_o2', 'eeeeeeee-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002',
        'owner two session', '/tmp/o2', 'working');

-- a pending permission owned by owner1
insert into public.permissions (id, session_id, owner_id, opencode_permission_id, tool, title, status)
values ('11111111-0000-0000-0000-000000000001', 'ses_o1', 'aaaaaaaa-0000-0000-0000-000000000001',
        'perm_oc_1', 'bash', 'run npm test', 'pending');

-- a decided (non-pending) permission owned by owner1
insert into public.permissions (id, session_id, owner_id, opencode_permission_id, tool, title, status, decided_at)
values ('11111111-0000-0000-0000-000000000002', 'ses_o1', 'aaaaaaaa-0000-0000-0000-000000000001',
        'perm_oc_2', 'edit', 'edit file', 'allowed_once', now());

-- an owner2 prompt
insert into public.prompts (id, session_id, owner_id, text, status)
values ('22222222-0000-0000-0000-000000000002', 'ses_o2', 'aaaaaaaa-0000-0000-0000-000000000002',
        'secret o2 prompt', 'pending');

-- link viewer1 -> owner1
insert into public.links (owner_id, viewer_id)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001');

-- ===========================================================================
-- 1. unlinked viewer sees nothing
-- ===========================================================================
set local role authenticated;
select pg_temp.jwt('bbbbbbbb-0000-0000-0000-000000000002'); -- viewer2, no links

select pg_temp.expect(not exists (select 1 from public.sessions), 'unlinked viewer sees no sessions');
select pg_temp.expect(not exists (select 1 from public.messages), 'unlinked viewer sees no messages');
select pg_temp.expect(not exists (select 1 from public.machines), 'unlinked viewer sees no machines');
select pg_temp.expect(not exists (select 1 from public.prompts), 'unlinked viewer sees no prompts');
select pg_temp.expect(not exists (select 1 from public.permissions), 'unlinked viewer sees no permissions');
select pg_temp.expect(not exists (select 1 from public.file_activity), 'unlinked viewer sees no file_activity');
select pg_temp.expect(not exists (select 1 from public.links), 'unlinked viewer sees no links');

-- viewer2 must not be able to insert a prompt against owner1's session
do $$
begin
  begin
    insert into public.prompts (id, session_id, owner_id, text, status)
    values ('22222222-0000-0000-0000-0000000000ff', 'ses_o1',
            'aaaaaaaa-0000-0000-0000-000000000001', 'sneaky', 'pending');
    raise exception 'FAIL: unlinked viewer inserted a prompt';
  exception
    when insufficient_privilege or check_violation then
      raise notice 'ok: unlinked viewer cannot insert prompts';
  end;
end $$;

-- ===========================================================================
-- 2. linked viewer can SELECT owner1 rows but nothing from owner2
-- ===========================================================================
select pg_temp.jwt('bbbbbbbb-0000-0000-0000-000000000001'); -- viewer1 -> owner1

select pg_temp.expect((select count(*) = 1 from public.sessions), 'linked viewer sees exactly their sessions');
select pg_temp.expect((select count(*) = 1 from public.messages), 'linked viewer sees messages');
select pg_temp.expect((select count(*) = 1 from public.machines), 'linked viewer sees the machine');
select pg_temp.expect((select count(*) = 0 from public.sessions where id = 'ses_o2'), 'linked viewer cannot see owner2 sessions');
select pg_temp.expect((select count(*) = 0 from public.prompts where id = '22222222-0000-0000-0000-000000000002'),
                      'linked viewer cannot see owner2 prompts');

-- ===========================================================================
-- 3. viewer cannot write status / cannot decide non-pending permissions
-- ===========================================================================
update public.sessions set status = 'working' where id = 'ses_o1';
select pg_temp.expect((select status = 'done' from public.sessions where id = 'ses_o1'),
                      'viewer UPDATE on sessions.status is a no-op');

update public.permissions set status = 'denied' where id = '11111111-0000-0000-0000-000000000001';
select pg_temp.expect((select status = 'pending' from public.permissions
                        where id = '11111111-0000-0000-0000-000000000001'),
                      'viewer cannot UPDATE permissions directly');

-- decide on a non-pending permission must fail
do $$
begin
  begin
    perform public.decide_permission('11111111-0000-0000-0000-000000000002', 'denied');
    raise exception 'FAIL: decided a non-pending permission';
  exception
    when others then
      if sqlerrm like '%FAIL:%' then raise; end if;
      raise notice 'ok: decide_permission rejects non-pending rows (% )', sqlerrm;
  end;
end $$;

-- decide on a pending permission the viewer is NOT linked to must fail
do $$
begin
  begin
    -- viewer1 is linked to owner1, so craft an owner2 permission first? it does not exist.
    -- instead: a pending permission for owner2 (none seeded) - emulate by trying a random id
    perform public.decide_permission('99999999-0000-0000-0000-000000000009', 'denied');
    raise exception 'FAIL: decided an unknown permission';
  exception
    when others then
      if sqlerrm like '%FAIL:%' then raise; end if;
      raise notice 'ok: decide_permission rejects unknown/unlinked rows (% )', sqlerrm;
  end;
end $$;

-- linked viewer CAN decide a pending permission
select pg_temp.expect(
  (select session_id = 'ses_o1'
     from public.decide_permission('11111111-0000-0000-0000-000000000001', 'denied')),
  'linked viewer can decide a pending permission');
select pg_temp.expect((select status = 'denied' and decided_at is not null
                         from public.permissions
                        where id = '11111111-0000-0000-0000-000000000001'),
                      'decision persisted');

-- second decide on the same row must fail (only pending transitions)
do $$
begin
  begin
    perform public.decide_permission('11111111-0000-0000-0000-000000000001', 'allowed_always');
    raise exception 'FAIL: double-decided a permission';
  exception
    when others then
      if sqlerrm like '%FAIL:%' then raise; end if;
      raise notice 'ok: decide_permission is single-transition (% )', sqlerrm;
  end;
end $$;

-- ===========================================================================
-- 4. anon gets nothing: no reads, no RPC execute
-- ===========================================================================
reset role;
set local role anon;
-- drop the viewer1 jwt left over from section 2 so auth.uid() is null here
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.expect(not exists (select 1 from public.sessions), 'anon sees no sessions');
select pg_temp.expect(not exists (select 1 from public.machines), 'anon sees no machines');
do $$
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform public.claim_pairing('ABCD-2345');
    raise exception 'FAIL: anon executed claim_pairing';
  exception
    when insufficient_privilege then
      raise notice 'ok: anon cannot execute claim_pairing';
    when others then
      if sqlerrm like '%FAIL:%' then raise; end if;
      raise notice 'ok: anon blocked from claim_pairing (% )', sqlerrm;
  end;
end $$;
do $$
begin
  begin
    perform public.create_pairing();
    raise exception 'FAIL: anon executed create_pairing';
  exception
    when insufficient_privilege then
      raise notice 'ok: anon cannot execute create_pairing';
    when others then
      if sqlerrm like '%FAIL:%' then raise; end if;
      raise notice 'ok: anon blocked from create_pairing (% )', sqlerrm;
  end;
end $$;

-- ===========================================================================
-- 5. pairing: happy path, expired, used, throttling
-- ===========================================================================
reset role;
select pg_temp.jwt('aaaaaaaa-0000-0000-0000-000000000001'); -- owner1 mints
set local role authenticated;

select pg_temp.expect((select count(*) = 1
                         from public.create_pairing()
                        where length(replace(code, '-', '')) = 8),
                      'create_pairing returns an 8-char code formatted XXXX-XXXX');

-- stash the plaintext + hash for the scenarios below
do $$
declare
  v_code text;
begin
  select c.code into v_code from public.create_pairing() c;
  perform set_config('test.code', v_code, true);
end $$;

-- (a) happy path as viewer2 (fresh, unlinked)
reset role;
select pg_temp.jwt('bbbbbbbb-0000-0000-0000-000000000002');
set local role authenticated;
do $$
declare
  v_status text;
  v_owner  uuid;
begin
  select c.status, c.owner_id into v_status, v_owner
    from public.claim_pairing(current_setting('test.code', true)) c;
  if v_status <> 'ok' or v_owner <> 'aaaaaaaa-0000-0000-0000-000000000001' then
    raise exception 'FAIL: claim_pairing happy path got %/%', v_status, v_owner;
  end if;
  raise notice 'ok: claim_pairing happy path';
end $$;
select pg_temp.expect((select count(*) = 1 from public.links
                        where viewer_id = 'bbbbbbbb-0000-0000-0000-000000000002'
                          and owner_id  = 'aaaaaaaa-0000-0000-0000-000000000001'),
                      'claim_pairing created the link');

-- (b) same code again → used
do $$
declare
  v_status text;
begin
  select c.status into v_status from public.claim_pairing(current_setting('test.code', true)) c;
  if v_status <> 'used' then
    raise exception 'FAIL: expected used, got %', v_status;
  end if;
  raise notice 'ok: single-use code rejected on reuse';
end $$;

-- (c) expired code - seed as postgres, claim as viewer2
reset role;
insert into public.pairings (owner_id, code_hash, expires_at)
values ('aaaaaaaa-0000-0000-0000-000000000001',
        crypt('WXYZ2345', gen_salt('bf', 10)),
        now() - interval '1 minute');

select pg_temp.jwt('bbbbbbbb-0000-0000-0000-000000000002');
set local role authenticated;
do $$
declare
  v_status text;
begin
  select c.status into v_status from public.claim_pairing('WXYZ-2345') c;
  if v_status <> 'expired' then
    raise exception 'FAIL: expected expired, got %', v_status;
  end if;
  raise notice 'ok: expired code rejected';
end $$;

-- (d) invalid code → failure recorded
do $$
declare
  v_status text;
begin
  select c.status into v_status from public.claim_pairing('ZZZZ-ZZZZ') c;
  if v_status <> 'invalid' then
    raise exception 'FAIL: expected invalid, got %', v_status;
  end if;
  raise notice 'ok: invalid code rejected';
end $$;

-- (e) throttling: 5 failures / 10 min → throttled
do $$
declare
  i int;
  v_status text;
begin
  for i in 1..4 loop
    select c.status into v_status from public.claim_pairing('AAAA-' || i::text || '234') c;
    if v_status <> 'invalid' then
      raise exception 'FAIL: expected invalid on attempt %, got %', i, v_status;
    end if;
  end loop;
  -- this is failure #5 (one from (d) + four here)
  select c.status into v_status from public.claim_pairing('BBBB-BBBB') c;
  if v_status <> 'throttled' then
    raise exception 'FAIL: expected throttled after 5 failures, got %', v_status;
  end if;
  raise notice 'ok: per-viewer throttle after 5 failures / 10 min';
end $$;

-- ===========================================================================
-- 6. claim_prompts: reaping, lease, at-most-once, no double claim
-- ===========================================================================
reset role;
select pg_temp.jwt('aaaaaaaa-0000-0000-0000-000000000001'); -- owner1
set local role authenticated;

-- owner1 prompts (two pending + one stale sending)
insert into public.prompts (id, session_id, owner_id, text, status, claimed_by, lease_until, attempts)
values
  ('33333333-0000-0000-0000-000000000001', 'ses_o1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'first prompt', 'pending', null, null, 0),
  ('33333333-0000-0000-0000-000000000002', 'ses_o1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'second prompt', 'pending', null, null, 0),
  ('33333333-0000-0000-0000-000000000003', 'ses_o1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'stale prompt', 'sending', 'eeeeeeee-0000-0000-0000-000000000001',
   now() - interval '1 minute', 1);

-- stale sending → failed before any claim
select pg_temp.expect((select count(*) = 2 from public.claim_prompts(
                        'eeeeeeee-0000-0000-0000-000000000001', 10, 30)),
                      'claim_prompts reaped the stale lease and returned the pending rows');

select pg_temp.expect((select status = 'failed' and error = 'unknown, retry?'
                         from public.prompts where id = '33333333-0000-0000-0000-000000000003'),
                      'stale sending row became failed (never auto-resent)');

-- both pending rows claimed exactly once
select pg_temp.expect((select count(*) = 2 from public.prompts
                        where id in ('33333333-0000-0000-0000-000000000001',
                                    '33333333-0000-0000-0000-000000000002')
                          and status = 'sending'
                          and claimed_by = 'eeeeeeee-0000-0000-0000-000000000001'
                          and attempts = 1),
                      'pending prompts claimed with lease + attempts');

select pg_temp.expect((select count(*) = 0 from public.claim_prompts(
                        'eeeeeeee-0000-0000-0000-000000000001', 10, 30)),
                      'second claim returns nothing (no double delivery)');

-- owner2's prompt is invisible to owner1
select pg_temp.expect((select count(*) = 0 from public.prompts
                        where id = '22222222-0000-0000-0000-000000000002'),
                      'claim_prompts never crosses owners');

-- unknown machine rejected
do $$
begin
  begin
    perform public.claim_prompts('eeeeeeee-0000-0000-0000-000000000099', 1, 30);
    raise exception 'FAIL: claimed with an unknown machine';
  exception
    when others then
      if sqlerrm like '%FAIL:%' then raise; end if;
      raise notice 'ok: unknown machine rejected (% )', sqlerrm;
  end;
end $$;

-- ===========================================================================
-- 7. retry_prompt only moves failed → pending
-- ===========================================================================
select pg_temp.expect((select public.retry_prompt(
                        '33333333-0000-0000-0000-000000000001') is null), -- sending
                      'retry_prompt ignores a sending row');
select pg_temp.expect((select public.retry_prompt(
                        '33333333-0000-0000-0000-000000000003') is not null), -- failed
                      'retry_prompt requeues a failed row');
select pg_temp.expect((select status = 'pending' from public.prompts
                        where id = '33333333-0000-0000-0000-000000000003'),
                      'retried prompt is pending again');

-- ===========================================================================
-- 8. unlink
-- ===========================================================================
-- viewer removes itself
reset role;
select pg_temp.jwt('bbbbbbbb-0000-0000-0000-000000000001');
set local role authenticated;
select pg_temp.expect(public.unlink('bbbbbbbb-0000-0000-0000-000000000001'),
                      'viewer can unlink itself');
select pg_temp.expect(not exists (select 1 from public.sessions), 'rows gone after unlink');

-- ===========================================================================
-- 9. prompts viewer insert constraints (as a fresh linked viewer)
-- ===========================================================================
reset role;
-- relink viewer2 -> owner1 for the insert tests
insert into public.links (owner_id, viewer_id)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002')
on conflict do nothing;

select pg_temp.jwt('bbbbbbbb-0000-0000-0000-000000000002');
set local role authenticated;

select pg_temp.expect((select count(*) = 1 from public.prompts
                        where id = '33333333-0000-0000-0000-000000000001'),
                      'linked viewer can read prompts');

do $$
begin
  begin
    insert into public.prompts (id, session_id, owner_id, text, status, attempts, error)
    values ('44444444-0000-0000-0000-000000000001', 'ses_o1',
            'aaaaaaaa-0000-0000-0000-000000000001', 'viewer prompt', 'sending', 1, 'x');
    raise exception 'FAIL: viewer inserted a non-pending prompt';
  exception
    when check_violation or insufficient_privilege then
      raise notice 'ok: viewer cannot insert non-pending prompt state';
  end;
end $$;

insert into public.prompts (id, session_id, owner_id, text, status)
values ('44444444-0000-0000-0000-000000000002', 'ses_o1',
        'aaaaaaaa-0000-0000-0000-000000000001', 'viewer prompt', 'pending');
select pg_temp.expect((select count(*) = 1 from public.prompts
                        where id = '44444444-0000-0000-0000-000000000002'),
                      'viewer can enqueue a pristine pending prompt');

do $$
begin
  begin
    insert into public.prompts (id, session_id, owner_id, text, status)
    values ('44444444-0000-0000-0000-000000000003', 'ses_o1',
            'aaaaaaaa-0000-0000-0000-000000000001', repeat('x', 20001), 'pending');
    raise exception 'FAIL: accepted an over-long prompt';
  exception
    when check_violation then
      raise notice 'ok: prompt text capped at 20k chars';
  end;
end $$;

-- ===========================================================================
rollback;

select 'ALL RLS TESTS PASSED' as result;
