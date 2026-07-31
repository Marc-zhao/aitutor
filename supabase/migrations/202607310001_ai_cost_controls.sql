-- Predictable AI spending limits for the public AI Tutor.

create table if not exists public.ai_budget_config (
  id smallint primary key default 1 check (id = 1),
  student_hourly_limit integer not null check (student_hourly_limit > 0),
  student_daily_limit integer not null check (student_daily_limit > 0),
  teacher_hourly_limit integer not null check (teacher_hourly_limit > 0),
  teacher_daily_limit integer not null check (teacher_daily_limit > 0),
  global_daily_token_limit integer not null check (global_daily_token_limit > 0),
  updated_at timestamptz not null default now()
);

insert into public.ai_budget_config (
  id,
  student_hourly_limit,
  student_daily_limit,
  teacher_hourly_limit,
  teacher_daily_limit,
  global_daily_token_limit
) values (1, 8, 20, 15, 60, 2000000)
on conflict (id) do nothing;

create table if not exists public.ai_usage_hourly (
  user_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  request_kind text not null,
  request_count integer not null default 0 check (request_count >= 0),
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  primary key (user_id, window_start, request_kind)
);

create table if not exists public.ai_usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  request_kind text not null,
  request_count integer not null default 0 check (request_count >= 0),
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  primary key (user_id, usage_date, request_kind)
);

create table if not exists public.ai_usage_global_daily (
  usage_date date not null,
  request_kind text not null,
  request_count integer not null default 0 check (request_count >= 0),
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  primary key (usage_date, request_kind)
);

alter table public.ai_budget_config enable row level security;
alter table public.ai_usage_hourly enable row level security;
alter table public.ai_usage_daily enable row level security;
alter table public.ai_usage_global_daily enable row level security;

create or replace function public.reserve_ai_budget(
  p_estimated_tokens integer default 1000,
  p_kind text default 'chat'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz := now();
  v_hour timestamptz := date_trunc('hour', v_now);
  v_day date := (v_now at time zone 'Asia/Shanghai')::date;
  v_kind text := left(regexp_replace(coalesce(p_kind, 'chat'), '[^a-zA-Z0-9_-]', '', 'g'), 32);
  v_estimated integer := least(greatest(coalesce(p_estimated_tokens, 1000), 100), 50000);
  v_is_teacher boolean := false;
  v_hour_limit integer;
  v_day_limit integer;
  v_global_limit integer;
  v_hour_count integer;
  v_day_count integer;
  v_global_tokens bigint;
begin
  if v_user is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthorized');
  end if;
  if v_kind = '' then v_kind := 'chat'; end if;

  perform pg_advisory_xact_lock(2026073101);

  select coalesce(role = 'teacher', false)
    into v_is_teacher
    from public.profiles
    where id = v_user;

  select
    case when v_is_teacher then teacher_hourly_limit else student_hourly_limit end,
    case when v_is_teacher then teacher_daily_limit else student_daily_limit end,
    global_daily_token_limit
  into v_hour_limit, v_day_limit, v_global_limit
  from public.ai_budget_config
  where id = 1;

  if v_hour_limit is null then
    return jsonb_build_object('allowed', false, 'reason', 'not_configured');
  end if;

  select coalesce(sum(request_count), 0) into v_hour_count
  from public.ai_usage_hourly
  where user_id = v_user and window_start = v_hour;

  select coalesce(sum(request_count), 0) into v_day_count
  from public.ai_usage_daily
  where user_id = v_user and usage_date = v_day;

  select coalesce(sum(reserved_tokens), 0) into v_global_tokens
  from public.ai_usage_global_daily
  where usage_date = v_day;

  if v_hour_count >= v_hour_limit then
    return jsonb_build_object('allowed', false, 'reason', 'hourly_limit');
  end if;
  if v_day_count >= v_day_limit then
    return jsonb_build_object('allowed', false, 'reason', 'daily_limit');
  end if;
  if v_global_tokens + v_estimated > v_global_limit then
    return jsonb_build_object('allowed', false, 'reason', 'global_budget');
  end if;

  insert into public.ai_usage_hourly(user_id, window_start, request_kind, request_count, reserved_tokens)
  values (v_user, v_hour, v_kind, 1, v_estimated)
  on conflict (user_id, window_start, request_kind) do update
    set request_count = public.ai_usage_hourly.request_count + 1,
        reserved_tokens = public.ai_usage_hourly.reserved_tokens + excluded.reserved_tokens;

  insert into public.ai_usage_daily(user_id, usage_date, request_kind, request_count, reserved_tokens)
  values (v_user, v_day, v_kind, 1, v_estimated)
  on conflict (user_id, usage_date, request_kind) do update
    set request_count = public.ai_usage_daily.request_count + 1,
        reserved_tokens = public.ai_usage_daily.reserved_tokens + excluded.reserved_tokens;

  insert into public.ai_usage_global_daily(usage_date, request_kind, request_count, reserved_tokens)
  values (v_day, v_kind, 1, v_estimated)
  on conflict (usage_date, request_kind) do update
    set request_count = public.ai_usage_global_daily.request_count + 1,
        reserved_tokens = public.ai_usage_global_daily.reserved_tokens + excluded.reserved_tokens;

  return jsonb_build_object(
    'allowed', true,
    'remaining_hourly', greatest(v_hour_limit - v_hour_count - 1, 0),
    'remaining_daily', greatest(v_day_limit - v_day_count - 1, 0),
    'global_remaining_tokens', greatest(v_global_limit - v_global_tokens - v_estimated, 0)
  );
end;
$$;

revoke all on function public.reserve_ai_budget(integer, text) from public, anon;
grant execute on function public.reserve_ai_budget(integer, text) to authenticated;
revoke execute on function public.consume_ai_quota(integer) from authenticated;

create index if not exists idx_ai_usage_hourly_window on public.ai_usage_hourly(window_start);
create index if not exists idx_ai_usage_daily_date on public.ai_usage_daily(usage_date);
create index if not exists idx_ai_usage_global_date on public.ai_usage_global_daily(usage_date);
