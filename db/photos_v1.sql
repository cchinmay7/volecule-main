-- Photos v1: engineer-submitted site photos stored in Supabase Storage.
--
-- Design reference: "Site Photo Storage" design doc.
--
-- Photos used to stay in the Google Drive folder that Google Forms creates
-- for its file-upload question. Now Apps Script uploads each one straight
-- to a private Storage bucket (via short-lived signed upload URLs issued by
-- /api/integrations/google-forms/photos/sign) and then asks
-- /api/integrations/google-forms/photos/attach to verify the object and
-- record it here.
--
--   storage bucket "site-photos"   the bytes; private, 20 MB per file,
--                                  images only. Path convention:
--                                  {project_code}/{YYYY-MM-DD}/{shift}/
--                                  {project_code}_{YYYY-MM-DD}_{shift}_{NN}.{ext}
--   project_log_photos             one row per stored photo: which log it
--                                  belongs to, where the object lives, and
--                                  the original filename / Drive file id /
--                                  form question it came from.
--
-- Requires db/bootstrap_v1.sql (projects, project_logs) to have been run.
--
-- This script is idempotent and safe to re-run.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'site-photos',
  'site-photos',
  false,
  20971520,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.project_log_photos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  project_log_id uuid not null references public.project_logs (id) on delete cascade,
  storage_bucket text not null default 'site-photos',
  storage_path text not null,
  sequence int not null check (sequence > 0),
  original_filename text,
  mime_type text not null,
  size_bytes bigint,
  question text,
  drive_file_id text,
  external_submission_id text,
  created_at timestamptz not null default now()
);

-- One row per stored object; also the conflict target attach upserts on, so
-- retrying an attach is harmless.
create unique index if not exists project_log_photos_object_unique
  on public.project_log_photos (storage_bucket, storage_path);

-- The same Drive file is never attached to the same log twice (a retried
-- onFormSubmit re-sends the same Drive file ids).
create unique index if not exists project_log_photos_log_drive_file_unique
  on public.project_log_photos (project_log_id, drive_file_id)
  where drive_file_id is not null;

create index if not exists project_log_photos_log_sequence_idx
  on public.project_log_photos (project_log_id, sequence);

create index if not exists project_log_photos_project_created_idx
  on public.project_log_photos (project_id, created_at desc);

-- Row Level Security — same wide-open authenticated policy as every other
-- table (single-operator model; see db/bootstrap_v1.sql). The bucket itself
-- is private and has no storage.objects policies on purpose: the app only
-- touches it with the service role (signing uploads, verifying objects,
-- minting short-lived read URLs), so no client can read or write it
-- directly.
alter table public.project_log_photos enable row level security;

drop policy if exists "authenticated_read_project_log_photos" on public.project_log_photos;
drop policy if exists "authenticated_insert_project_log_photos" on public.project_log_photos;
drop policy if exists "authenticated_update_project_log_photos" on public.project_log_photos;
drop policy if exists "authenticated_delete_project_log_photos" on public.project_log_photos;

create policy "authenticated_read_project_log_photos"
  on public.project_log_photos for select
  to authenticated
  using (true);

create policy "authenticated_insert_project_log_photos"
  on public.project_log_photos for insert
  to authenticated
  with check (true);

create policy "authenticated_update_project_log_photos"
  on public.project_log_photos for update
  to authenticated
  using (true);

create policy "authenticated_delete_project_log_photos"
  on public.project_log_photos for delete
  to authenticated
  using (true);
