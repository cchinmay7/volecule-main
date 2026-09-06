import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeTaskId } from '@/utils/scheduler/task-id'
import {
  applyMissedTargets,
  applyTaskCompletions,
} from '@/utils/scheduler/propagate'
import { filterEligibleCandidates } from '@/utils/scheduler/gating'

/**
 * Core log-ingestion + schedule-propagation logic, shared by the real
 * Google Forms webhook (src/app/api/integrations/google-forms/submit)
 * and the date-override testing console (spec §11 item 2) — one code
 * path for both, so there's nothing test-only that can drift out of
 * sync with production behaviour.
 *
 * The caller is responsible for authentication (the shared-secret check
 * for the real webhook; being a logged-in operator for the test
 * console) and for validating the shape of the raw request body — this
 * function takes already-validated, already-typed inputs.
 */

export type IngestSubmissionInput = {
  projectId: string
  projectCode: string
  shift: 'morning' | 'evening'
  externalSubmissionId: string
  submittedAt: string
  formValues: {
    headcount?: unknown
    targets_selected?: unknown
    targets_achieved?: unknown
    free_notes?: unknown
    escalate_to_volecule?: unknown
  }
  /** Stored verbatim in project_logs.source_payload_json for traceability. */
  sourcePayload: unknown
  /** Must match project_logs.source's check constraint. The date-override
   * testing console (spec §11 item 2) uses 'manual' — there's no
   * dedicated value for it in the schema, and 'manual' already means
   * "not the real webhook". */
  source: 'google_form' | 'manual'
}

export type IngestSubmissionResult =
  | { ok: true; logDate: string; shift: 'morning' | 'evening' }
  | { ok: false; status: number; error: string }

export async function ingestFormSubmission(
  supabase: SupabaseClient,
  input: IngestSubmissionInput,
): Promise<IngestSubmissionResult> {
  const { projectId, projectCode } = input

  const query = supabase
    .from('projects')
    .select('id, public_code, status, timezone')
  const { data: project, error: projectError } = projectId
    ? await query.eq('id', projectId).single()
    : await query.eq('public_code', projectCode).single()

  if (projectError || !project) {
    const idType = projectId ? 'project_id' : 'project_code'
    return { ok: false, status: 400, error: `Unknown ${idType}` }
  }

  if (projectId && projectCode && project.public_code !== projectCode) {
    return {
      ok: false,
      status: 400,
      error: 'project_id and project_code do not match the same project',
    }
  }

  if (project.status !== 'active') {
    return {
      ok: false,
      status: 400,
      error: 'Project is not active — submissions rejected',
    }
  }

  const submittedDate = new Date(input.submittedAt)
  if (isNaN(submittedDate.getTime())) {
    return {
      ok: false,
      status: 400,
      error: 'submitted_at is not a valid ISO 8601 timestamp',
    }
  }

  const logDate = toLocalDateString(submittedDate, project.timezone)

  const fv = input.formValues
  const headcountJson = fv.headcount ?? null
  const targetsSelectedJson = fv.targets_selected ?? null
  const targetsAchievedJson = fv.targets_achieved ?? null
  const freeNotes = typeof fv.free_notes === 'string' ? fv.free_notes : null
  const escalateToVolecule = parseEscalateFlag(fv.escalate_to_volecule)

  const { data: upsertedLog, error: upsertError } = await supabase
    .from('project_logs')
    .upsert(
      {
        project_id: project.id,
        log_date: logDate,
        shift: input.shift,
        headcount_json: headcountJson,
        targets_selected_json: targetsSelectedJson,
        targets_achieved_json: targetsAchievedJson,
        free_notes: freeNotes,
        escalate_to_volecule: escalateToVolecule,
        source: input.source,
        external_submission_id: input.externalSubmissionId,
        source_payload_json: input.sourcePayload,
      },
      {
        onConflict: 'project_id,log_date,shift',
        ignoreDuplicates: false,
      },
    )
    .select('id')
    .single()

  if (upsertError) {
    console.error('[ingestion] upsert error', upsertError)
    return { ok: false, status: 500, error: 'Failed to save log' }
  }

  // Trigger schedule propagation for evening submissions. A project with
  // no imported schedule yet simply has no candidate tasks below, so
  // this is a no-op for it rather than needing its own check.
  if (input.shift === 'evening') {
    try {
      await runEveningPropagation({
        supabase,
        projectId: project.id,
        logDate,
        targetsAchievedJson,
        triggerProjectLogId: (upsertedLog?.id as string) ?? null,
        freeNotes,
      })
    } catch (propagationError) {
      console.error('[ingestion] schedule propagation error', propagationError)
      // Never fail log ingestion because of a propagation error.
    }
  }

  return { ok: true, logDate, shift: input.shift }
}

async function runEveningPropagation({
  supabase,
  projectId,
  logDate,
  targetsAchievedJson,
  triggerProjectLogId,
  freeNotes,
}: {
  supabase: SupabaseClient
  projectId: string
  logDate: string
  targetsAchievedJson: unknown
  triggerProjectLogId: string | null
  freeNotes: string | null
}) {
  const achievedIds = new Set<string>()
  if (Array.isArray(targetsAchievedJson)) {
    for (const label of targetsAchievedJson) {
      if (typeof label !== 'string') continue
      const normalized = normalizeTaskId(label)
      if (normalized) achievedIds.add(normalized)
    }
  }

  const { data: candidateTasks, error: tasksError } = await supabase
    .from('schedule_tasks')
    .select('id, external_ref, current_planned_end')
    .eq('project_id', projectId)
    .in('status', ['pending', 'missed'])

  if (tasksError) {
    console.error('[ingestion] task query error', tasksError)
    return
  }
  if (!candidateTasks || candidateTasks.length === 0) return

  // Gate candidacy once, before the achieved/not-achieved split — a task
  // whose predecessors aren't all done is skipped entirely for this run,
  // whatever the payload says about it (spec §11 item 1d). Its dates only
  // ever move via cascade from whichever predecessor is actually still
  // open.
  const gate = await filterEligibleCandidates(
    supabase,
    candidateTasks.map((t) => t.id as string),
  )
  if (!gate.ok) {
    console.error('[ingestion] gating query error', gate.error)
    return
  }

  const completions: { taskId: string; actualEnd: string }[] = []
  const missed: string[] = []

  for (const task of candidateTasks) {
    if (!gate.eligibleTaskIds.has(task.id as string)) continue

    const externalRef = task.external_ref as string | null
    const normalized = externalRef ? normalizeTaskId(externalRef) : null
    const plannedEnd = task.current_planned_end as string

    if (normalized && achievedIds.has(normalized)) {
      completions.push({ taskId: task.id as string, actualEnd: logDate })
    } else if (plannedEnd <= logDate) {
      missed.push(task.id as string)
    }
    // else: not due yet — leave untouched
  }

  if (completions.length > 0) {
    const outcome = await applyTaskCompletions({
      supabase,
      projectId,
      completions,
      today: logDate,
    })
    if (outcome.success) {
      console.info('[ingestion] completions applied', {
        count: completions.length,
        tasksChanged: outcome.tasksChanged,
        versionNumber: outcome.versionNumber,
      })
    } else {
      console.error('[ingestion] completions failed', outcome.error)
    }
  }

  if (missed.length > 0) {
    const outcome = await applyMissedTargets({
      supabase,
      projectId,
      missedTaskIds: missed,
      triggerProjectLogId,
      missReason: freeNotes,
    })
    if (outcome.success) {
      console.info('[ingestion] missed targets applied', {
        count: missed.length,
        tasksChanged: outcome.tasksChanged,
        versionNumber: outcome.versionNumber,
      })
    } else {
      console.error('[ingestion] missed targets failed', outcome.error)
    }
  }
}

/**
 * The evening form's "Escalate to Volecule?" dropdown returns whatever
 * label the operator sees ("Yes"/"No" most likely, but this is defined
 * on the Google Form side, not here) — tolerant of a boolean, or a
 * string matching yes/true/escalate in any case, so a label change on
 * the form side doesn't silently stop being recognized as false.
 */
function parseEscalateFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return /^(yes|true|escalate)$/i.test(value.trim())
  }
  return false
}

/**
 * Convert a UTC Date to a YYYY-MM-DD string in the target IANA timezone.
 * Falls back to UTC if the timezone is invalid.
 */
function toLocalDateString(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)

    const year = parts.find((p) => p.type === 'year')?.value
    const month = parts.find((p) => p.type === 'month')?.value
    const day = parts.find((p) => p.type === 'day')?.value

    if (year && month && day) return `${year}-${month}-${day}`
  } catch {
    console.warn(
      '[ingestion] Invalid timezone',
      timezone,
      '— falling back to UTC',
    )
  }
  return date.toISOString().slice(0, 10)
}
