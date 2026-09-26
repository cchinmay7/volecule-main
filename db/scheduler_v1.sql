-- Scheduler v1: dependency-aware construction schedule with automatic
-- propagation, driven by Google Form site logs.
--
-- Design reference: "Schedule Propagation Engine" spec (§02 Data model,
-- §04 Excel import, §06 Propagation algorithm, §09 Decisions).
--
-- schedule_tasks is the single live, mutable source of truth. Everything
-- else exists to preserve history without ever mutating that live row in
-- a way that loses information:
--   schedule_versions        one row per re-plan event, including the
--                            original Schedule Zero import
--   schedule_tasks           live state (current_planned_* mutated by
--                            propagation; original_planned_* immutable)
--   schedule_task_dependencies  the DAG — finish-to-start edges,
--                            multiple predecessors per task supported
--   schedule_version_tasks   frozen snapshot of every task, one set per
--                            version — "what did the plan say on date X"
--   schedule_task_revisions  append-only audit trail — "who slipped and
--                            why", one row per date change
--   schedule_imports         record of each uploaded spreadsheet
--   schedule_ingestion_flags append-only anomaly log — ingestion-time
--                            issues that were rejected rather than
--                            applied (e.g. a start confirmed before its
--                            predecessor was done), not a date change so
--                            not a schedule_task_revisions row
--
-- status is pending | done | retired — the three states that correspond
-- to an actual one-time write event (import, confirmed-done, re-import
-- drop). Everything else (in progress, delayed — start, delayed — end)
-- is derived at read time from current_planned_start/end, actual_start,
-- and today (spec §12, "Status: derive it, don't store it" — open
-- question (e), resolved in favor of collapsing). Nothing is ever
-- written to represent "this is currently delayed" — that's the whole
-- point: it can't go stale the way a stored label could if some future
-- code path moved a task's dates without also updating the word
-- describing it.
--
-- This script is idempotent and safe to re-run.

create table if not exists public.schedule_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  version_number int not null,
  source text not null check (source in ('excel_import', 'propagation', 'manual_edit')),
  label text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create unique index if not exists schedule_versions_project_version_unique
  on public.schedule_versions (project_id, version_number);

create table if not exists public.schedule_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  site_id uuid references public.sites (id) on delete set null,
  external_ref text,
  name text not null,
  vendor_team text,
  original_planned_start date not null,
  original_planned_end date not null,
  current_planned_start date not null,
  current_planned_end date not null,
  duration_days int not null check (duration_days > 0),
  actual_start date,
  actual_end date,
  status text not null default 'pending' check (status in ('pending', 'done', 'retired')),
  created_in_version_id uuid references public.schedule_versions (id) on delete set null,
  created_at timestamptz not null default now(),
  check (original_planned_start <= original_planned_end),
  check (current_planned_start <= current_planned_end)
);

-- Rename the 'missed' status to 'delayed' — a task that's overdue but
-- still recoverable via cascade, not permanently lost. Drop the old
-- check constraint (looked up dynamically, since its auto-generated name
-- shouldn't be hardcoded) before the data migration, since the old
-- constraint doesn't allow 'delayed' yet.
do $$
declare
  found_constraint text;
begin
  select con.conname into found_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'schedule_tasks'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%status%pending%';

  if found_constraint is not null then
    execute format('alter table public.schedule_tasks drop constraint %I', found_constraint);
  end if;
end $$;

update public.schedule_tasks set status = 'delayed' where status = 'missed';

alter table public.schedule_tasks
  add constraint schedule_tasks_status_check
  check (status in ('pending', 'done', 'delayed', 'retired'));

-- Collapse 'delayed' out of the stored enum entirely (spec §12 open
-- question (e), resolved in favor of deriving it). A stored 'delayed'
-- task is, structurally, just a 'pending' one whose dates say it's
-- overdue — the distinction is now computed at read time, never stored.
-- Same dynamic-lookup-and-drop pattern as the rename above, run a second
-- time against whatever constraint the previous step just installed.
do $$
declare
  found_constraint text;
begin
  select con.conname into found_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'schedule_tasks'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%status%pending%';

  if found_constraint is not null then
    execute format('alter table public.schedule_tasks drop constraint %I', found_constraint);
  end if;
end $$;

update public.schedule_tasks set status = 'pending' where status = 'delayed';

alter table public.schedule_tasks
  add constraint schedule_tasks_status_check
  check (status in ('pending', 'done', 'retired'));

create unique index if not exists schedule_tasks_project_external_ref_unique
  on public.schedule_tasks (project_id, external_ref)
  where external_ref is not null;

-- Recreate the deadline index without a status predicate at all —
-- 'delayed' is no longer a real column value to filter on, and every
-- non-final task (in progress, delayed-start, delayed-end included) is
-- simply 'pending' in storage now.
drop index if exists public.schedule_tasks_project_deadline_idx;
create index if not exists schedule_tasks_project_deadline_idx
  on public.schedule_tasks (project_id, current_planned_end)
  where status = 'pending';

create index if not exists schedule_tasks_site_id_idx
  on public.schedule_tasks (site_id);

create table if not exists public.schedule_task_dependencies (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.schedule_tasks (id) on delete cascade,
  depends_on_task_id uuid not null references public.schedule_tasks (id) on delete cascade,
  lag_days int not null default 0,
  created_at timestamptz not null default now(),
  check (task_id <> depends_on_task_id)
);

create unique index if not exists schedule_task_dependencies_edge_unique
  on public.schedule_task_dependencies (task_id, depends_on_task_id);

create index if not exists schedule_task_dependencies_depends_on_idx
  on public.schedule_task_dependencies (depends_on_task_id);

create table if not exists public.schedule_version_tasks (
  id uuid primary key default gen_random_uuid(),
  schedule_version_id uuid not null references public.schedule_versions (id) on delete cascade,
  task_id uuid not null references public.schedule_tasks (id) on delete cascade,
  name text not null,
  vendor_team text,
  planned_start date not null,
  planned_end date not null,
  status text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists schedule_version_tasks_version_task_unique
  on public.schedule_version_tasks (schedule_version_id, task_id);

create table if not exists public.schedule_task_revisions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.schedule_tasks (id) on delete cascade,
  schedule_version_id uuid references public.schedule_versions (id) on delete set null,
  previous_start date not null,
  previous_end date not null,
  new_start date not null,
  new_end date not null,
  change_reason text not null check (change_reason in ('delayed_end', 'delayed_start', 'confirmed_start', 'early_finish', 'manual_override', 'excel_reimport')),
  trigger_project_log_id uuid references public.project_logs (id) on delete set null,
  miss_reason text,
  created_at timestamptz not null default now()
);

-- Same rename as schedule_tasks.status above, applied to the audit trail's
-- own reason enum.
do $$
declare
  found_constraint text;
begin
  select con.conname into found_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'schedule_task_revisions'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%change_reason%';

  if found_constraint is not null then
    execute format('alter table public.schedule_task_revisions drop constraint %I', found_constraint);
  end if;
end $$;

update public.schedule_task_revisions
  set change_reason = 'delayed_target'
  where change_reason = 'missed_target';

alter table public.schedule_task_revisions
  add constraint schedule_task_revisions_change_reason_check
  check (change_reason in ('delayed_target', 'early_finish', 'manual_override', 'excel_reimport'));

-- §12: 'delayed_target' really only ever meant "delayed the end" — rename
-- it to 'delayed_end' for consistency with the new Start/End split, and
-- add 'delayed_start' (the start-side +1 push) and 'confirmed_start'
-- (actual_start genuinely written, by either the morning trigger or the
-- manual-override fallback). Same dynamic-lookup-and-drop pattern again.
do $$
declare
  found_constraint text;
begin
  select con.conname into found_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'schedule_task_revisions'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%change_reason%';

  if found_constraint is not null then
    execute format('alter table public.schedule_task_revisions drop constraint %I', found_constraint);
  end if;
end $$;

update public.schedule_task_revisions
  set change_reason = 'delayed_end'
  where change_reason = 'delayed_target';

alter table public.schedule_task_revisions
  add constraint schedule_task_revisions_change_reason_check
  check (change_reason in ('delayed_end', 'delayed_start', 'confirmed_start', 'early_finish', 'manual_override', 'excel_reimport'));

create index if not exists schedule_task_revisions_task_created_idx
  on public.schedule_task_revisions (task_id, created_at desc);

create index if not exists schedule_task_revisions_version_idx
  on public.schedule_task_revisions (schedule_version_id);

create table if not exists public.schedule_imports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  schedule_version_id uuid references public.schedule_versions (id) on delete set null,
  storage_path text,
  original_filename text,
  row_count int,
  parsed_task_count int,
  parse_errors_json jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- Raw file archival is deferred (see src/app/protected/scheduler/actions.ts) —
-- storage_path is nullable until real archival is added. Idempotent against
-- the already-applied version of this script, which had it NOT NULL.
alter table public.schedule_imports
  alter column storage_path drop not null;

create index if not exists schedule_imports_project_id_idx
  on public.schedule_imports (project_id);

-- §12: the morning form gains a second, independent checklist alongside
-- the existing targets_selected_json ("what do you expect to finish
-- today") — this one asks "have these, whose recommended start is due,
-- actually started?" project_logs itself is a bootstrap_v1.sql table,
-- but this column only exists to support the scheduler, so it's altered
-- here rather than there.
alter table public.project_logs
  add column if not exists starts_confirmed_json jsonb;

-- Anomalies caught at ingestion time that don't represent a date change
-- (so don't belong in schedule_task_revisions) but still need a permanent
-- record — e.g. a morning-form start confirmation for a task whose
-- predecessors weren't actually done yet, or an evening-form completion
-- tick for a task that was never confirmed started in the first place.
-- Most are rejected rather than applied; 'optimistic_start_reverted' is
-- the exception — that one *was* applied, provisionally, and is being
-- undone now that the bet it depended on didn't pay off (the same-day
-- parent/child boundary fix). Recorded either way, so none of these are
-- just a Vercel log line that scrolls away. flag_type is an enum, not
-- free text, so it's ready to hold future anomaly kinds without another
-- migration.
create table if not exists public.schedule_ingestion_flags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  task_id uuid references public.schedule_tasks (id) on delete cascade,
  project_log_id uuid references public.project_logs (id) on delete set null,
  flag_type text not null check (flag_type in ('start_confirmed_before_predecessor_done', 'target_ticked_before_confirmed_start', 'optimistic_start_reverted')),
  detail text,
  created_at timestamptz not null default now()
);

-- Adds 'optimistic_start_reverted' to an already-existing constraint —
-- same dynamic-lookup-and-drop pattern used elsewhere in this file.
do $$
declare
  found_constraint text;
begin
  select con.conname into found_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'schedule_ingestion_flags'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%flag_type%';

  if found_constraint is not null then
    execute format('alter table public.schedule_ingestion_flags drop constraint %I', found_constraint);
  end if;
end $$;

alter table public.schedule_ingestion_flags
  add constraint schedule_ingestion_flags_flag_type_check
  check (flag_type in ('start_confirmed_before_predecessor_done', 'target_ticked_before_confirmed_start', 'optimistic_start_reverted'));

create index if not exists schedule_ingestion_flags_project_created_idx
  on public.schedule_ingestion_flags (project_id, created_at desc);

create index if not exists schedule_ingestion_flags_task_id_idx
  on public.schedule_ingestion_flags (task_id);

-- Row Level Security — same wide-open authenticated policy as every
-- existing table (single-operator model; see db/bootstrap_v1.sql).
alter table public.schedule_versions enable row level security;
alter table public.schedule_tasks enable row level security;
alter table public.schedule_task_dependencies enable row level security;
alter table public.schedule_version_tasks enable row level security;
alter table public.schedule_task_revisions enable row level security;
alter table public.schedule_imports enable row level security;
alter table public.schedule_ingestion_flags enable row level security;

drop policy if exists "authenticated_read_schedule_versions" on public.schedule_versions;
drop policy if exists "authenticated_insert_schedule_versions" on public.schedule_versions;
drop policy if exists "authenticated_update_schedule_versions" on public.schedule_versions;
drop policy if exists "authenticated_delete_schedule_versions" on public.schedule_versions;

create policy "authenticated_read_schedule_versions"
  on public.schedule_versions for select
  to authenticated
  using (true);

create policy "authenticated_insert_schedule_versions"
  on public.schedule_versions for insert
  to authenticated
  with check (true);

create policy "authenticated_update_schedule_versions"
  on public.schedule_versions for update
  to authenticated
  using (true);

create policy "authenticated_delete_schedule_versions"
  on public.schedule_versions for delete
  to authenticated
  using (true);

drop policy if exists "authenticated_read_schedule_tasks" on public.schedule_tasks;
drop policy if exists "authenticated_insert_schedule_tasks" on public.schedule_tasks;
drop policy if exists "authenticated_update_schedule_tasks" on public.schedule_tasks;
drop policy if exists "authenticated_delete_schedule_tasks" on public.schedule_tasks;

create policy "authenticated_read_schedule_tasks"
  on public.schedule_tasks for select
  to authenticated
  using (true);

create policy "authenticated_insert_schedule_tasks"
  on public.schedule_tasks for insert
  to authenticated
  with check (true);

create policy "authenticated_update_schedule_tasks"
  on public.schedule_tasks for update
  to authenticated
  using (true);

create policy "authenticated_delete_schedule_tasks"
  on public.schedule_tasks for delete
  to authenticated
  using (true);

drop policy if exists "authenticated_read_schedule_task_dependencies" on public.schedule_task_dependencies;
drop policy if exists "authenticated_insert_schedule_task_dependencies" on public.schedule_task_dependencies;
drop policy if exists "authenticated_update_schedule_task_dependencies" on public.schedule_task_dependencies;
drop policy if exists "authenticated_delete_schedule_task_dependencies" on public.schedule_task_dependencies;

create policy "authenticated_read_schedule_task_dependencies"
  on public.schedule_task_dependencies for select
  to authenticated
  using (true);

create policy "authenticated_insert_schedule_task_dependencies"
  on public.schedule_task_dependencies for insert
  to authenticated
  with check (true);

create policy "authenticated_update_schedule_task_dependencies"
  on public.schedule_task_dependencies for update
  to authenticated
  using (true);

create policy "authenticated_delete_schedule_task_dependencies"
  on public.schedule_task_dependencies for delete
  to authenticated
  using (true);

drop policy if exists "authenticated_read_schedule_version_tasks" on public.schedule_version_tasks;
drop policy if exists "authenticated_insert_schedule_version_tasks" on public.schedule_version_tasks;
drop policy if exists "authenticated_update_schedule_version_tasks" on public.schedule_version_tasks;
drop policy if exists "authenticated_delete_schedule_version_tasks" on public.schedule_version_tasks;

create policy "authenticated_read_schedule_version_tasks"
  on public.schedule_version_tasks for select
  to authenticated
  using (true);

create policy "authenticated_insert_schedule_version_tasks"
  on public.schedule_version_tasks for insert
  to authenticated
  with check (true);

create policy "authenticated_update_schedule_version_tasks"
  on public.schedule_version_tasks for update
  to authenticated
  using (true);

create policy "authenticated_delete_schedule_version_tasks"
  on public.schedule_version_tasks for delete
  to authenticated
  using (true);

drop policy if exists "authenticated_read_schedule_task_revisions" on public.schedule_task_revisions;
drop policy if exists "authenticated_insert_schedule_task_revisions" on public.schedule_task_revisions;
drop policy if exists "authenticated_update_schedule_task_revisions" on public.schedule_task_revisions;
drop policy if exists "authenticated_delete_schedule_task_revisions" on public.schedule_task_revisions;

create policy "authenticated_read_schedule_task_revisions"
  on public.schedule_task_revisions for select
  to authenticated
  using (true);

create policy "authenticated_insert_schedule_task_revisions"
  on public.schedule_task_revisions for insert
  to authenticated
  with check (true);

create policy "authenticated_update_schedule_task_revisions"
  on public.schedule_task_revisions for update
  to authenticated
  using (true);

create policy "authenticated_delete_schedule_task_revisions"
  on public.schedule_task_revisions for delete
  to authenticated
  using (true);

drop policy if exists "authenticated_read_schedule_imports" on public.schedule_imports;
drop policy if exists "authenticated_insert_schedule_imports" on public.schedule_imports;
drop policy if exists "authenticated_update_schedule_imports" on public.schedule_imports;
drop policy if exists "authenticated_delete_schedule_imports" on public.schedule_imports;

create policy "authenticated_read_schedule_imports"
  on public.schedule_imports for select
  to authenticated
  using (true);

create policy "authenticated_insert_schedule_imports"
  on public.schedule_imports for insert
  to authenticated
  with check (true);

create policy "authenticated_update_schedule_imports"
  on public.schedule_imports for update
  to authenticated
  using (true);

create policy "authenticated_delete_schedule_imports"
  on public.schedule_imports for delete
  to authenticated
  using (true);

drop policy if exists "authenticated_read_schedule_ingestion_flags" on public.schedule_ingestion_flags;
drop policy if exists "authenticated_insert_schedule_ingestion_flags" on public.schedule_ingestion_flags;
drop policy if exists "authenticated_update_schedule_ingestion_flags" on public.schedule_ingestion_flags;
drop policy if exists "authenticated_delete_schedule_ingestion_flags" on public.schedule_ingestion_flags;

create policy "authenticated_read_schedule_ingestion_flags"
  on public.schedule_ingestion_flags for select
  to authenticated
  using (true);

create policy "authenticated_insert_schedule_ingestion_flags"
  on public.schedule_ingestion_flags for insert
  to authenticated
  with check (true);

create policy "authenticated_update_schedule_ingestion_flags"
  on public.schedule_ingestion_flags for update
  to authenticated
  using (true);

create policy "authenticated_delete_schedule_ingestion_flags"
  on public.schedule_ingestion_flags for delete
  to authenticated
  using (true);
