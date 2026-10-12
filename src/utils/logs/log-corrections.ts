import type { SupabaseClient } from '@supabase/supabase-js'
import { isIsoDate } from '@/utils/dates'
import { recordEdit } from '@/utils/logs/edit-history'
import { PHOTO_BUCKET } from '@/utils/photos/photo-naming'
import { removePhotoObjects } from '@/utils/photos/photo-storage'
import { ingestFormSubmission } from '@/utils/scheduler/ingest-submission'

/**
 * Operator corrections to logs and their photos (the Updates page's Logs
 * tab). Editing a log changes the RECORD only — headcount, notes, the
 * escalation flag — and never re-runs the schedule rules: those pushes are
 * one-per-check and not idempotent, so replaying a corrected log would
 * double-apply them. Schedule fixes are made explicitly on the Tasks tab.
 *
 * A log the engineer never submitted is entered through the normal
 * ingestion path instead, because that is the case where the schedule
 * rules genuinely still need to run once.
 *
 * Every action leaves a project_log_edits row (db/updates_v1.sql) holding
 * what changed and the operator's note. That row is best-effort: if the
 * table isn't there yet the correction still goes through and the result
 * says the history entry wasn't saved.
 */

export type LogCorrectionResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

const HISTORY_WARNING =
  ' (History entry not saved: run db/updates_v1.sql in Supabase.)'

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** Compares JSON values ignoring object key order, at every depth. */
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([key, inner]) => [key, canonical(inner)]),
      )
    }
    return value
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

export async function updateLogRecord({
  supabase,
  projectId,
  logId,
  userId,
  headcount,
  freeNotes,
  escalate,
  note,
}: {
  supabase: SupabaseClient
  projectId: string
  logId: string
  userId: string
  /** Replaces the log's headcount; null leaves it as it is. */
  headcount: Record<string, string> | null
  freeNotes: string | null
  escalate: boolean
  note: string | null
}): Promise<LogCorrectionResult> {
  const { data: log, error } = await supabase
    .from('project_logs')
    .select('id, project_id, headcount_json, free_notes, escalate_to_volecule')
    .eq('id', logId)
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!log || log.project_id !== projectId) {
    return { ok: false, error: 'Log not found in this project.' }
  }

  const nextHeadcount =
    headcount === null
      ? log.headcount_json
      : Object.fromEntries(
          Object.entries(headcount).map(([key, value]) => [key, clean(value)]),
        )
  const nextNotes = clean(freeNotes)

  const previous = {
    headcount_json: log.headcount_json,
    free_notes: log.free_notes,
    escalate_to_volecule: log.escalate_to_volecule,
  }
  const next = {
    headcount_json: nextHeadcount,
    free_notes: nextNotes,
    escalate_to_volecule: escalate,
  }

  if (sameJson(previous, next)) {
    return { ok: true, message: 'Nothing changed.' }
  }

  const { error: updateError } = await supabase
    .from('project_logs')
    .update(next)
    .eq('id', logId)
  if (updateError) return { ok: false, error: updateError.message }

  const recorded = await recordEdit(supabase, {
    projectId,
    logId,
    userId,
    kind: 'log_edited',
    details: { previous, next },
    note,
  })

  return {
    ok: true,
    message: `Log updated.${recorded ? '' : HISTORY_WARNING}`,
  }
}

export async function deleteLogPhoto({
  supabase,
  admin,
  projectId,
  photoId,
  userId,
  note,
}: {
  supabase: SupabaseClient
  /** Service-role client for removing the stored object. */
  admin: SupabaseClient
  projectId: string
  photoId: string
  userId: string
  note: string | null
}): Promise<LogCorrectionResult> {
  const { data: photo, error } = await supabase
    .from('project_log_photos')
    .select(
      'id, project_id, project_log_id, storage_path, original_filename, question',
    )
    .eq('id', photoId)
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!photo || photo.project_id !== projectId) {
    return { ok: false, error: 'Photo not found in this project.' }
  }

  const { error: deleteError } = await supabase
    .from('project_log_photos')
    .delete()
    .eq('id', photoId)
  if (deleteError) return { ok: false, error: deleteError.message }

  // The row is what the app shows; the stored object follows. A failure
  // removing it is logged, never a reason to undo the correction.
  await removePhotoObjects(admin, [photo.storage_path as string])

  const recorded = await recordEdit(supabase, {
    projectId,
    logId: photo.project_log_id as string,
    userId,
    kind: 'photo_deleted',
    details: {
      storage_bucket: PHOTO_BUCKET,
      storage_path: photo.storage_path,
      original_filename: photo.original_filename,
      question: photo.question,
    },
    note,
  })

  return {
    ok: true,
    message: `Photo deleted.${recorded ? '' : HISTORY_WARNING}`,
  }
}

export async function submitMissedLog({
  supabase,
  projectId,
  userId,
  logDate,
  shift,
  headcount,
  taskRefs,
  freeNotes,
  escalate,
  note,
  today,
}: {
  supabase: SupabaseClient
  projectId: string
  userId: string
  logDate: string
  shift: 'morning' | 'evening'
  headcount: Record<string, string>
  /** Evening: tasks achieved. Morning: tasks started. */
  taskRefs: string[]
  freeNotes: string | null
  escalate: boolean
  note: string | null
  today: string
}): Promise<LogCorrectionResult> {
  if (!isIsoDate(logDate)) {
    return { ok: false, error: 'Enter the log date as a valid date.' }
  }
  if (logDate > today) {
    return { ok: false, error: "A log can't be entered for a future date." }
  }

  // Ingestion upserts, and re-running the schedule rules for a day that
  // already had them applied would push things twice. If the engineer did
  // submit, the right tool is to edit that log.
  const { data: existing, error: existingError } = await supabase
    .from('project_logs')
    .select('id')
    .eq('project_id', projectId)
    .eq('log_date', logDate)
    .eq('shift', shift)
    .maybeSingle()
  if (existingError) return { ok: false, error: existingError.message }
  if (existing) {
    return {
      ok: false,
      error: `A ${shift} log already exists for ${logDate}. Edit that one instead.`,
    }
  }

  const cleanedHeadcount = Object.fromEntries(
    Object.entries(headcount).map(([key, value]) => [key, clean(value)]),
  )
  const externalSubmissionId = `manual-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`

  const result = await ingestFormSubmission(supabase, {
    projectId,
    projectCode: '',
    shift,
    externalSubmissionId,
    // Noon UTC keeps the project-timezone conversion on the same calendar day.
    submittedAt: `${logDate}T12:00:00.000Z`,
    formValues: {
      headcount: cleanedHeadcount,
      ...(shift === 'evening'
        ? { targets_achieved: taskRefs }
        : { starts_confirmed: taskRefs }),
      free_notes: clean(freeNotes),
      escalate_to_volecule: escalate,
    },
    sourcePayload: {
      manual_entry: true,
      entered_by: userId,
      log_date: logDate,
      shift,
      task_refs: taskRefs,
    },
    source: 'manual',
  })

  if (!result.ok) return { ok: false, error: result.error }

  const { data: created } = await supabase
    .from('project_logs')
    .select('id')
    .eq('project_id', projectId)
    .eq('log_date', result.logDate)
    .eq('shift', shift)
    .maybeSingle()

  const recorded = await recordEdit(supabase, {
    projectId,
    logId: (created?.id as string | undefined) ?? null,
    userId,
    kind: 'log_created',
    details: { log_date: result.logDate, shift, task_refs: taskRefs },
    note,
  })

  return {
    ok: true,
    message: `${shift === 'morning' ? 'Morning' : 'Evening'} log for ${result.logDate} entered and the schedule rules applied.${recorded ? '' : HISTORY_WARNING}`,
  }
}
