-- Production RLS, secure registration, and server-side AI quota for AI-Tutor.

create table if not exists public.ai_request_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, window_start)
);
alter table public.ai_request_usage enable row level security;

create or replace function public.consume_ai_quota(p_limit integer default 120)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_window timestamptz := date_trunc('hour', now());
  v_count integer;
  v_limit integer := least(greatest(coalesce(p_limit, 120), 1), 300);
begin
  if v_user is null then return false; end if;
  insert into public.ai_request_usage(user_id, window_start, request_count)
  values (v_user, v_window, 1)
  on conflict (user_id, window_start) do update
    set request_count = public.ai_request_usage.request_count + 1
    where public.ai_request_usage.request_count < v_limit
  returning request_count into v_count;
  return v_count is not null and v_count <= v_limit;
end;
$$;
revoke all on function public.consume_ai_quota(integer) from public;
grant execute on function public.consume_ai_quota(integer) to authenticated;

create or replace function public.is_ai_teacher()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'teacher')
$$;

create or replace function public.teaches_ai_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.teacher_classes where teacher_id = auth.uid() and class_id = p_class_id
  ) or exists(
    select 1 from public.classes where id = p_class_id and created_by = auth.uid()
  )
$$;

create or replace function public.can_access_ai_student(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_student_id = auth.uid() or exists(
    select 1 from public.profiles p
    where p.id = p_student_id and public.teaches_ai_class(p.class_id)
  )
$$;

create or replace function public.validate_ai_invite(p_code text, p_role text)
returns table(role text, class_id uuid, class_name text)
language sql
stable
security definer
set search_path = public
as $$
  select i.role, i.class_id, c.name
  from public.invite_codes i
  left join public.classes c on c.id = i.class_id
  where upper(i.code) = upper(trim(p_code))
    and i.is_active = true
    and i.role = p_role
  limit 1
$$;

create or replace function public.complete_ai_registration(p_code text, p_name text)
returns table(role text, class_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_class_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select i.role, i.class_id into v_role, v_class_id
  from public.invite_codes i
  where upper(i.code) = upper(trim(p_code)) and i.is_active = true
  for update;
  if v_role is null then raise exception 'Invalid or used invite code'; end if;
  perform set_config('app.ai_registration', '1', true);
  insert into public.profiles(id, full_name, role, class_id, name_changed)
  values (auth.uid(), left(trim(p_name), 100), v_role, v_class_id, false)
  on conflict (id) do update set
    full_name = excluded.full_name,
    role = excluded.role,
    class_id = excluded.class_id;
  update public.invite_codes
  set used_by = auth.uid(), used_at = now(), is_active = false
  where upper(code) = upper(trim(p_code));
  return query select v_role, v_class_id;
end;
$$;

create or replace function public.protect_ai_profile_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if current_setting('app.ai_registration', true) <> '1' then
      raise exception 'Use complete_ai_registration';
    end if;
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'Role cannot be changed';
  end if;
  if old.class_id is not null and new.class_id is distinct from old.class_id then
    raise exception 'Class cannot be changed';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_ai_profile_fields_trigger on public.profiles;
create trigger protect_ai_profile_fields_trigger
before insert or update on public.profiles
for each row execute function public.protect_ai_profile_fields();

revoke all on function public.validate_ai_invite(text,text) from public;
revoke all on function public.complete_ai_registration(text,text) from public;
grant execute on function public.validate_ai_invite(text,text) to anon, authenticated;
grant execute on function public.complete_ai_registration(text,text) to authenticated;

do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies where schemaname='public' loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.teacher_classes enable row level security;
alter table public.invite_codes enable row level security;
alter table public.conversations enable row level security;
alter table public.content_flags enable row level security;
alter table public.ai_reply_flags enable row level security;
alter table public.ai_quality_logs enable row level security;
alter table public.assignments enable row level security;
alter table public.assignment_submissions enable row level security;
alter table public.prompts enable row level security;
alter table public.prompt_applications enable row level security;

create policy profiles_read on public.profiles for select to authenticated using (
  id = auth.uid() or public.can_access_ai_student(id)
);
create policy profiles_update_own on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy classes_read on public.classes for select to anon, authenticated using (true);
create policy classes_insert_teacher on public.classes for insert to authenticated with check (public.is_ai_teacher() and created_by = auth.uid());
create policy classes_update_owner on public.classes for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy classes_delete_owner on public.classes for delete to authenticated using (created_by = auth.uid());

create policy teacher_classes_read_own on public.teacher_classes for select to authenticated using (teacher_id = auth.uid());
create policy teacher_classes_insert_owned on public.teacher_classes for insert to authenticated with check (
  teacher_id = auth.uid() and exists(select 1 from public.classes c where c.id = class_id and c.created_by = auth.uid())
);
create policy teacher_classes_delete_own on public.teacher_classes for delete to authenticated using (teacher_id = auth.uid());

create policy invite_read_owner on public.invite_codes for select to authenticated using (created_by = auth.uid());
create policy invite_insert_owner on public.invite_codes for insert to authenticated with check (public.is_ai_teacher() and created_by = auth.uid());
create policy invite_update_owner on public.invite_codes for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy invite_delete_owner on public.invite_codes for delete to authenticated using (created_by = auth.uid());

create policy conversations_manage_own on public.conversations for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy conversations_teacher_read on public.conversations for select to authenticated using (public.can_access_ai_student(user_id));

create policy content_flags_insert_own on public.content_flags for insert to authenticated with check (user_id = auth.uid());
create policy content_flags_read on public.content_flags for select to authenticated using (
  user_id = auth.uid() or public.teaches_ai_class(class_id)
);
create policy content_flags_teacher_update on public.content_flags for update to authenticated using (public.teaches_ai_class(class_id)) with check (public.teaches_ai_class(class_id));

create policy reply_flags_insert_own on public.ai_reply_flags for insert to authenticated with check (user_id = auth.uid());
create policy reply_flags_read on public.ai_reply_flags for select to authenticated using (
  user_id = auth.uid() or public.teaches_ai_class(class_id)
);

create policy quality_logs_insert_own on public.ai_quality_logs for insert to authenticated with check (student_id = auth.uid());
create policy quality_logs_teacher_read on public.ai_quality_logs for select to authenticated using (public.can_access_ai_student(student_id));

create policy assignments_teacher_manage on public.assignments for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
create policy assignments_student_read on public.assignments for select to authenticated using (student_id = auth.uid() and status = 'published');

create policy submissions_student_read on public.assignment_submissions for select to authenticated using (student_id = auth.uid());
create policy submissions_student_insert on public.assignment_submissions for insert to authenticated with check (student_id = auth.uid());
create policy submissions_student_update on public.assignment_submissions for update to authenticated using (student_id = auth.uid()) with check (student_id = auth.uid());
create policy submissions_teacher_read on public.assignment_submissions for select to authenticated using (
  exists(select 1 from public.assignments a where a.id = assignment_id and a.teacher_id = auth.uid())
);
create policy submissions_teacher_update on public.assignment_submissions for update to authenticated using (
  exists(select 1 from public.assignments a where a.id = assignment_id and a.teacher_id = auth.uid())
) with check (exists(select 1 from public.assignments a where a.id = assignment_id and a.teacher_id = auth.uid()));

create policy prompts_read on public.prompts for select to authenticated using (is_public = true or created_by = auth.uid());
create policy prompts_insert_own on public.prompts for insert to authenticated with check (public.is_ai_teacher() and created_by = auth.uid());
create policy prompts_update_own on public.prompts for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy prompts_delete_own on public.prompts for delete to authenticated using (created_by = auth.uid());

create policy applications_manage_own on public.prompt_applications for all to authenticated using (teacher_id = auth.uid()) with check (
  teacher_id = auth.uid() and (class_id is null or public.teaches_ai_class(class_id))
);

create index if not exists idx_ai_profiles_class_id on public.profiles(class_id);
create index if not exists idx_ai_teacher_classes_teacher on public.teacher_classes(teacher_id, class_id);
create index if not exists idx_ai_conversations_user on public.conversations(user_id, updated_at desc);
create index if not exists idx_ai_flags_class on public.content_flags(class_id, created_at desc);
create index if not exists idx_ai_assignments_student on public.assignments(student_id, status);
create index if not exists idx_ai_submissions_assignment on public.assignment_submissions(assignment_id);

