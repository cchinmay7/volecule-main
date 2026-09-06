create extension if not exists pgcrypto;

-- Canonical v1 model:
-- - sites: top-level, pre-existing physical/client entities — a site
--   precedes any project created for it and can have several
-- - projects: operational tracking wrapper for one site (projects.site_id),
--   each with its own Google Form pair and schedule
-- - project_logs: morning/evening logs linked to one project
--
-- Deleting a site cascades to delete every project under it (and, from
-- there, that project's own schedule_tasks/project_logs/etc., which
-- already cascade off projects.id). Deleting a project never touches its
-- site or sibling projects.
--
-- This script is safe to re-run and can migrate legacy swap state where:
-- - old "sites" held project config
-- - old "projects" held site rows with projects.site_id

-- 1) Swap legacy table names into canonical names when detected.
do $$
declare
  projects_has_public_code boolean;
  sites_has_public_code boolean;
  projects_has_site_id boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'projects'
      and column_name = 'public_code'
  ) into projects_has_public_code;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sites'
      and column_name = 'public_code'
  ) into sites_has_public_code;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'projects'
      and column_name = 'site_id'
  ) into projects_has_site_id;

  if sites_has_public_code and projects_has_site_id and not projects_has_public_code then
    execute 'alter table public.projects rename to sites_swap_tmp';
    execute 'alter table public.sites rename to projects';
    execute 'alter table public.sites_swap_tmp rename to sites';
  end if;
end $$;

-- 2) Create canonical tables if missing.
create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client_name text not null,
  status text not null default 'active',
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references public.sites (id) on delete cascade,
  name text not null,
  public_code text,
  timezone text not null default 'Asia/Kolkata',
  google_form_url_morning text,
  google_form_url_evening text,
  reminder_time_morning time,
  reminder_time_evening time,
  whatsapp_target text,
  status text not null default 'active',
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- 3) Reverse the sites/projects relationship: a site precedes its
-- projects — one site, many projects — not the other way round. Data is
-- disposable at this stage, so this drops the old sites.project_id
-- column outright rather than migrating rows across the FK reversal.
alter table public.sites
  drop column if exists project_id;

alter table public.projects
  add column if not exists site_id uuid references public.sites (id) on delete cascade;

alter table public.sites
  add column if not exists status text not null default 'active';
alter table public.sites
  add column if not exists created_by uuid references auth.users (id);
alter table public.sites
  add column if not exists created_at timestamptz not null default now();

alter table public.projects
  add column if not exists public_code text;
alter table public.projects
  add column if not exists timezone text not null default 'Asia/Kolkata';
alter table public.projects
  add column if not exists google_form_url_morning text;
alter table public.projects
  add column if not exists google_form_url_evening text;
alter table public.projects
  add column if not exists reminder_time_morning time;
alter table public.projects
  add column if not exists reminder_time_evening time;
alter table public.projects
  add column if not exists whatsapp_target text;
alter table public.projects
  add column if not exists status text not null default 'active';
alter table public.projects
  add column if not exists created_by uuid references auth.users (id);
alter table public.projects
  add column if not exists created_at timestamptz not null default now();

-- Remove legacy column that is no longer part of canonical project schema.
alter table public.projects
  drop column if exists project_id;

-- 4) Backfill project public codes once when missing.
update public.projects
set public_code = concat(
  left(
    coalesce(
      nullif(
        trim(both '-' from regexp_replace(upper(name), '[^A-Z0-9]+', '-', 'g')),
        ''
      ),
      'PROJECT'
    ),
    24
  ),
  '-',
  upper(substr(replace(id::text, '-', ''), 1, 8))
)
where public_code is null;

-- 5) Rename legacy site_logs -> project_logs.
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'site_logs'
  ) and not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'project_logs'
  ) then
    execute 'alter table public.site_logs rename to project_logs';
  end if;
end $$;

create table if not exists public.project_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  log_date date not null,
  shift text not null check (shift in ('morning', 'evening')),
  headcount_json jsonb,
  targets_selected_json jsonb,
  targets_achieved_json jsonb,
  free_notes text,
  escalate_to_volecule boolean not null default false,
  source text not null default 'google_form' check (source in ('google_form', 'manual')),
  external_submission_id text,
  source_payload_json jsonb,
  created_at timestamptz not null default now()
);

-- Escalation flag — the evening form's "Escalate to Volecule?" answer.
-- Previously only visible buried in source_payload_json's raw dump; now a
-- first-class column so it can be surfaced as a badge (logs list,
-- dashboard) instead of requiring someone to open a log and read JSON.
alter table public.project_logs
  add column if not exists escalate_to_volecule boolean not null default false;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_logs'
      and column_name = 'site_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_logs'
      and column_name = 'project_id'
  ) then
    execute 'alter table public.project_logs rename column site_id to project_id';
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_logs'
      and column_name = 'site_id'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_logs'
      and column_name = 'project_id'
  ) then
    execute 'update public.project_logs set project_id = coalesce(project_id, site_id) where project_id is null and site_id is not null';
    execute 'alter table public.project_logs drop column site_id';
  end if;
end $$;

-- 6) Rebuild indexes using canonical names.
drop index if exists public.site_logs_site_date_shift_unique;
drop index if exists public.site_logs_site_external_submission_unique;
drop index if exists public.site_logs_site_id_created_at_idx;
drop index if exists public.sites_public_code_unique;
drop index if exists public.sites_project_id_idx;

create unique index if not exists project_logs_project_date_shift_unique
  on public.project_logs (project_id, log_date, shift);

create unique index if not exists projects_public_code_unique
  on public.projects (public_code)
  where public_code is not null;

create unique index if not exists project_logs_project_external_submission_unique
  on public.project_logs (project_id, external_submission_id)
  where external_submission_id is not null;

create index if not exists project_logs_project_id_created_at_idx
  on public.project_logs (project_id, created_at desc);

create index if not exists projects_site_id_idx
  on public.projects (site_id);

-- 7) Enable Row Level Security.
alter table public.projects enable row level security;
alter table public.sites enable row level security;
alter table public.project_logs enable row level security;

-- 8) Reset and recreate authenticated policies.
drop policy if exists "authenticated_read_projects" on public.projects;
drop policy if exists "authenticated_insert_projects" on public.projects;
drop policy if exists "authenticated_update_projects" on public.projects;
drop policy if exists "authenticated_delete_projects" on public.projects;

drop policy if exists "authenticated_read_sites" on public.sites;
drop policy if exists "authenticated_insert_sites" on public.sites;
drop policy if exists "authenticated_update_sites" on public.sites;
drop policy if exists "authenticated_delete_sites" on public.sites;

drop policy if exists "authenticated_read_project_logs" on public.project_logs;
drop policy if exists "authenticated_insert_project_logs" on public.project_logs;
drop policy if exists "authenticated_update_project_logs" on public.project_logs;
drop policy if exists "authenticated_delete_project_logs" on public.project_logs;
drop policy if exists "authenticated_read_site_logs" on public.project_logs;
drop policy if exists "authenticated_insert_site_logs" on public.project_logs;
drop policy if exists "authenticated_update_site_logs" on public.project_logs;
drop policy if exists "authenticated_delete_site_logs" on public.project_logs;

create policy "authenticated_read_projects"
  on public.projects for select
  to authenticated
  using (true);

create policy "authenticated_insert_projects"
  on public.projects for insert
  to authenticated
  with check (true);

create policy "authenticated_update_projects"
  on public.projects for update
  to authenticated
  using (true);

create policy "authenticated_delete_projects"
  on public.projects for delete
  to authenticated
  using (true);

create policy "authenticated_read_sites"
  on public.sites for select
  to authenticated
  using (true);

create policy "authenticated_insert_sites"
  on public.sites for insert
  to authenticated
  with check (true);

create policy "authenticated_update_sites"
  on public.sites for update
  to authenticated
  using (true);

create policy "authenticated_delete_sites"
  on public.sites for delete
  to authenticated
  using (true);

create policy "authenticated_read_project_logs"
  on public.project_logs for select
  to authenticated
  using (true);

create policy "authenticated_insert_project_logs"
  on public.project_logs for insert
  to authenticated
  with check (true);

create policy "authenticated_update_project_logs"
  on public.project_logs for update
  to authenticated
  using (true);

create policy "authenticated_delete_project_logs"
  on public.project_logs for delete
  to authenticated
  using (true);