-- Updates v2: the audit table can record a task being renamed.
--
-- The Updates page now lets an operator change a task's name (never its
-- code, such as W41). Each rename leaves one project_log_edits row of kind
-- 'task_renamed' with details = { task_id, code, previous, next }. This only
-- widens the allowed kinds from db/updates_v1.sql.
--
-- Until this has been run a rename still saves; the result just says the
-- history entry was not recorded.
--
-- Requires db/updates_v1.sql. This script is idempotent and safe to re-run.

alter table public.project_log_edits
  drop constraint if exists project_log_edits_kind_check;

alter table public.project_log_edits
  add constraint project_log_edits_kind_check
  check (kind in ('log_edited', 'log_created', 'photo_deleted', 'task_renamed'));
