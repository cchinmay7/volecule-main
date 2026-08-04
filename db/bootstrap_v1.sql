create extension if not exists pgcrypto;

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  public_code text,
  timezone text not null default 'Asia/Kolkata',
  google_form_url_morning text,
  google_form_url_evening text,
  reminder_time_morning time,
  reminder_time_evening time,
  whatsapp_target text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references public.sites (id) on delete cascade,
  name text not null,
  client_name text not null,
  status text not null default 'active',
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- Ensure site_id exists on projects for site -> many projects model.
alter table public.projects
  add column if not exists site_id uuid references public.sites (id) on delete cascade;

-- Transitional compatibility: older schema had sites.project_id as NOT NULL.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sites'
      and column_name = 'project_id'
  ) then
    execute 'alter table public.sites alter column project_id drop not null';
  end if;
end $$;

-- Backfill projects.site_id from legacy sites.project_id where available.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sites'
      and column_name = 'project_id'
  ) then
    execute $sql$
      update public.projects p
      set site_id = legacy.id
      from (
        select distinct on (s.project_id)
          s.project_id,
          s.id
        from public.sites s
        where s.project_id is not null
        order by s.project_id, s.created_at asc
      ) legacy
      where p.site_id is null
        and p.id = legacy.project_id
    $sql$;
  end if;
end $$;

alter table public.sites
  add column if not exists public_code text;

-- Backfill existing sites with deterministic, unique public codes once.
-- Safe to re-run: only updates rows where public_code is currently null.
update public.sites
set public_code = concat(
  left(
    coalesce(
      nullif(
        trim(both '-' from regexp_replace(upper(name), '[^A-Z0-9]+', '-', 'g')),
        ''
      ),
      'SITE'
    ),
    24
  ),
  '-',
  upper(substr(replace(id::text, '-', ''), 1, 8))
)
where public_code is null;

create table if not exists public.site_logs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  log_date date not null,
  shift text not null check (shift in ('morning', 'evening')),
  headcount_json jsonb,
  targets_selected_json jsonb,
  targets_achieved_json jsonb,
  free_notes text,
  source text not null default 'google_form' check (source in ('google_form', 'manual')),
  external_submission_id text,
  source_payload_json jsonb,
  created_at timestamptz not null default now()
);

-- Uniqueness constraints
create unique index if not exists site_logs_site_date_shift_unique
  on public.site_logs (site_id, log_date, shift);

create unique index if not exists sites_public_code_unique
  on public.sites (public_code)
  where public_code is not null;

create unique index if not exists site_logs_site_external_submission_unique
  on public.site_logs (site_id, external_submission_id)
  where external_submission_id is not null;

-- Performance indexes
create index if not exists site_logs_site_id_created_at_idx
  on public.site_logs (site_id, created_at desc);

create index if not exists projects_site_id_idx
  on public.projects (site_id);

-- Row Level Security
-- v1: all authenticated users share access (single-tenant internal tool).
-- Harden to per-user ownership after roles are defined.
alter table public.projects enable row level security;
alter table public.sites enable row level security;
alter table public.site_logs enable row level security;

-- Projects: authenticated users can read/write all rows.
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

-- Sites: authenticated users can read/write all rows.
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

-- Site logs: authenticated users can read/write all rows.
-- The ingestion endpoint uses the service role key (bypasses RLS),
-- so no anon policy is needed for ingestion.
create policy "authenticated_read_site_logs"
  on public.site_logs for select
  to authenticated
  using (true);

create policy "authenticated_insert_site_logs"
  on public.site_logs for insert
  to authenticated
  with check (true);

create policy "authenticated_update_site_logs"
  on public.site_logs for update
  to authenticated
  using (true);

create policy "authenticated_delete_site_logs"
  on public.site_logs for delete
  to authenticated
  using (true);