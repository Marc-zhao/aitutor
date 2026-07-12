revoke all on function public.consume_ai_quota(integer) from public, anon;
revoke all on function public.complete_ai_registration(text,text) from public, anon;
revoke all on function public.is_ai_teacher() from public, anon;
revoke all on function public.teaches_ai_class(uuid) from public, anon;
revoke all on function public.can_access_ai_student(uuid) from public, anon;
revoke all on function public.validate_ai_invite(text,text) from public;
grant execute on function public.consume_ai_quota(integer) to authenticated;
grant execute on function public.complete_ai_registration(text,text) to authenticated;
grant execute on function public.is_ai_teacher() to authenticated;
grant execute on function public.teaches_ai_class(uuid) to authenticated;
grant execute on function public.can_access_ai_student(uuid) to authenticated;
-- Anonymous execution is intentional only for exact-code validation.
grant execute on function public.validate_ai_invite(text,text) to anon, authenticated;

drop index if exists public.idx_ai_assignments_student;
drop index if exists public.idx_ai_submissions_assignment;
