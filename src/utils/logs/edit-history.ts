import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The operator's change history for things the schedule's own revision log
 * doesn't cover: edits to a log, a deleted photo, a task renamed, added or
 * deleted, a schedule rebuilt from a new spreadsheet. One row in
 * project_log_edits per action, holding what changed and the operator's note.
 *
 * Writing the row is best-effort. If the table, or a newer kind it doesn't
 * know yet, isn't in the database the correction still goes through, and the
 * caller tells the operator the history entry wasn't saved.
 */

export type EditKind =
  | 'log_edited'
  | 'log_created'
  | 'photo_deleted'
  | 'task_renamed'
  | 'task_added'
  | 'task_deleted'
  | 'schedule_replanned'

export async function recordEdit(
  supabase: SupabaseClient,
  edit: {
    projectId: string
    logId: string | null
    userId: string
    kind: EditKind
    details: Record<string, unknown>
    note: string | null
  },
): Promise<boolean> {
  const { error } = await supabase.from('project_log_edits').insert({
    project_id: edit.projectId,
    project_log_id: edit.logId,
    edited_by: edit.userId,
    kind: edit.kind,
    details: edit.details,
    note: edit.note,
  })
  if (error) {
    console.error('[updates] failed to record edit', error)
    return false
  }
  return true
}
