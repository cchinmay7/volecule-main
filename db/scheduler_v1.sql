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
--
-- status is pending | done | missed | retired. in_progress is NOT a
-- stored value (Decision 6) — it's derived on read as
-- current_planned_start <= today <= current_planned_end and status not
-- in ('done', 'missed', 'retired'). Nothing ever writes actual_start;
-- it's reserved for a future manual entry only.
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
  status text not null default 'pending' check (status in ('pending', 'done', 'missed', 'retired')),
  created_in_version_id uuid references public.schedule_versions (id) on delete set null,
  created_at timestamptz not null default now(),
  check (original_planned_start <= original_planned_end),
  check (current_planned_start <= current_planned_end)
);

create unique index if not exists schedule_tasks_project_external_ref_unique
  on public.schedule_tasks (project_id, external_ref)
  where external_ref is not null;

create index if not exists schedule_tasks_project_deadline_idx
  on public.schedule_tasks (project_id, current_planned_end)
  where status in ('pending', 'missed');

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
  change_reason text not null check (change_reason in ('missed_target', 'early_finish', 'manual_override', 'excel_reimport')),
  trigger_project_log_id uuid references public.project_logs (id) on delete set null,
  miss_reason text,
  created_at timestamptz not null default now()
);

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

-- Row Level Security — same wide-open authenticated policy as every
-- existing table (single-operator model; see db/bootstrap_v1.sql).
alter table public.schedule_versions enable row level security;
alter table public.schedule_tasks enable row level security;
alter table public.schedule_task_dependencies enable row level security;
alter table public.schedule_version_tasks enable row level security;
alter table public.schedule_task_revisions enable row level security;
alter table public.schedule_imports enable row level security;

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
