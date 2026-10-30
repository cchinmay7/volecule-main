-- Updates v3: the audit table can record tasks being added or deleted, and
-- a schedule being rebuilt from a newly uploaded spreadsheet.
--
-- The Updates page now lets an operator add a task (with any parents and
-- children), delete one, and upload a new schedule that replaces every task
-- not yet started. Each leaves one project_log_edits row:
--   task_added          details = { task_id, code, name, parents, children }
--   task_deleted        details = { task_id, code, name, reconnected,
--                                   parents, children }
--   schedule_replanned  details = { anchors, kept, removed, added, shifted,
--                                   filename }
-- This only widens the allowed kinds from db/updates_v2.sql.
--
-- Until this has been run those changes still save; the result just says the
-- history entry was not recorded.
--
-- Requires db/updates_v2.sql. This script is idempotent and safe to re-run.

alter table public.project_log_edits
  drop constraint if exists project_log_edits_kind_check;

alter table public.project_log_edits
  add constraint project_log_edits_kind_check
  check (kind in (
    'log_edited',
    'log_created',
    'photo_deleted',
    'task_renamed',
    'task_added',
    'task_deleted',
    'schedule_replanned'
  ));
