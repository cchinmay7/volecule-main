-- Updates v1: audit trail for operator corrections to logs and photos.
--
-- The Updates page lets an operator fix what a site engineer got wrong.
-- Corrections to the SCHEDULE are already audited in
-- schedule_task_revisions (change_reason = 'manual_override', operator's
-- note in miss_reason). Corrections to LOGS and PHOTOS have no equivalent,
-- and editing a log overwrites its previous values, so this keeps them:
--
--   project_log_edits   one row per operator action on a log:
--                         log_edited     headcount / notes / escalation changed
--                                        (details = { previous, next })
--                         log_created    a missed log entered on the
--                                        engineer's behalf
--                         photo_deleted  a wrong photo removed
--
-- Requires db/bootstrap_v1.sql. This script is idempotent and safe to re-run.

create table if not exists public.project_log_edits (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  project_log_id uuid references public.project_logs (id) on delete set null,
  edited_by uuid references auth.users (id),
  kind text not null check (kind in ('log_edited', 'log_created', 'photo_deleted')),
  details jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists project_log_edits_project_created_idx
  on public.project_log_edits (project_id, created_at desc);

create index if not exists project_log_edits_log_idx
  on public.project_log_edits (project_log_id);

-- Row Level Security — same wide-open authenticated policy as every other
-- table (single-operator model; see db/bootstrap_v1.sql).
alter table public.project_log_edits enable row level security;

drop policy if exists "authenticated_read_project_log_edits" on public.project_log_edits;
drop policy if exists "authenticated_insert_project_log_edits" on public.project_log_edits;
drop policy if exists "authenticated_update_project_log_edits" on public.project_log_edits;
drop policy if exists "authenticated_delete_project_log_edits" on public.project_log_edits;

create policy "authenticated_read_project_log_edits"
  on public.project_log_edits for select
  to authenticated
  using (true);

create policy "authenticated_insert_project_log_edits"
  on public.project_log_edits for insert
  to authenticated
  with check (true);

create policy "authenticated_update_project_log_edits"
  on public.project_log_edits for update
  to authenticated
  using (true);

create policy "authenticated_delete_project_log_edits"
  on public.project_log_edits for delete
  to authenticated
  using (true);
