import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeTaskId } from '@/utils/scheduler/task-id'
import {
  applyConfirmedStarts,
  applyDelayedEnds,
  applyDelayedStarts,
  applyTaskCompletions,
} from '@/utils/scheduler/propagate'
import {
  filterEligibleCandidates,
  recordIngestionFlags,
} from '@/utils/scheduler/gating'

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
    /** Morning-only: the dedicated start checklist (spec §12) — tasks
     * whose recommended start is due, ticked if actually started. A
     * separate question from targets_selected, which is deadline-scoped
     * ("what do you expect to finish today") and was never a start
     * signal at all. */
    starts_confirmed?: unknown
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
  const startsConfirmedJson = fv.starts_confirmed ?? null
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
        starts_confirmed_json: startsConfirmedJson,
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

  const triggerProjectLogId = (upsertedLog?.id as string) ?? null

  // Trigger schedule propagation. A project with no imported schedule yet
  // simply has no candidate tasks below, so this is a no-op for it rather
  // than needing its own check. Morning drives start-confirmation
  // (spec §12); evening drives completion/delayed-end, as before.
  try {
    if (input.shift === 'morning') {
      await runMorningPropagation({
        supabase,
        projectId: project.id,
        logDate,
        startsConfirmedJson,
        triggerProjectLogId,
      })
    } else {
      await runEveningPropagation({
        supabase,
        projectId: project.id,
        logDate,
        targetsAchievedJson,
        triggerProjectLogId,
        freeNotes,
      })
    }
  } catch (propagationError) {
    console.error('[ingestion] schedule propagation error', propagationError)
    // Never fail log ingestion because of a propagation error.
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
    .select('id, external_ref, current_planned_end, actual_start')
    .eq('project_id', projectId)
    .eq('status', 'pending')

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
  const delayedEnd: string[] = []
  const invalidFlags: { taskId: string; detail: string }[] = []

  for (const task of candidateTasks) {
    if (!gate.eligibleTaskIds.has(task.id as string)) continue

    const externalRef = task.external_ref as string | null
    const normalized = externalRef ? normalizeTaskId(externalRef) : null
    const plannedEnd = task.current_planned_end as string
    const actualStart = task.actual_start as string | null
    const wasTicked = normalized !== null && achievedIds.has(normalized)

    // spec §12 (c): a task never confirmed started is exempt from the
    // finish-deadline check entirely — it can't sensibly be judged
    // against a deadline that was never real to begin with. A tick
    // arriving anyway is the deadline-side mirror of open question (b),
    // resolved the same way in finding 4: reject, don't process, but
    // record it rather than silently drop it.
    if (actualStart === null) {
      if (wasTicked) {
        invalidFlags.push({
          taskId: task.id as string,
          detail: `Ticked achieved on ${logDate}, but actual_start was never confirmed.`,
        })
      }
      continue
    }

    if (wasTicked) {
      completions.push({ taskId: task.id as string, actualEnd: logDate })
    } else if (plannedEnd <= logDate) {
      delayedEnd.push(task.id as string)
    }
    // else: not due yet — leave untouched
  }

  if (invalidFlags.length > 0) {
    await recordIngestionFlags(
      supabase,
      projectId,
      triggerProjectLogId,
      'target_ticked_before_confirmed_start',
      invalidFlags,
    )
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

  if (delayedEnd.length > 0) {
    const outcome = await applyDelayedEnds({
      supabase,
      projectId,
      delayedTaskIds: delayedEnd,
      triggerProjectLogId,
      missReason: freeNotes,
    })
    if (outcome.success) {
      console.info('[ingestion] delayed ends applied', {
        count: delayedEnd.length,
        tasksChanged: outcome.tasksChanged,
        versionNumber: outcome.versionNumber,
      })
    } else {
      console.error('[ingestion] delayed ends failed', outcome.error)
    }
  }
}

/**
 * Morning-side counterpart to runEveningPropagation (spec §12): reads the
 * dedicated start checklist (starts_confirmed, distinct from
 * targets_selected) and either confirms a start or pushes it +1 day,
 * for every candidate whose recommended start is due
 * (current_planned_start <= today) and who hasn't been confirmed yet
 * (actual_start is null). Same eligibility gate as the evening side —
 * a task whose predecessors aren't all done can't be confirmed here
 * either, regardless of what the payload says (spec §12 open question
 * (b)).
 */
async function runMorningPropagation({
  supabase,
  projectId,
  logDate,
  startsConfirmedJson,
  triggerProjectLogId,
}: {
  supabase: SupabaseClient
  projectId: string
  logDate: string
  startsConfirmedJson: unknown
  triggerProjectLogId: string | null
}) {
  const confirmedIds = new Set<string>()
  if (Array.isArray(startsConfirmedJson)) {
    for (const label of startsConfirmedJson) {
      if (typeof label !== 'string') continue
      const normalized = normalizeTaskId(label)
      if (normalized) confirmedIds.add(normalized)
    }
  }

  const { data: candidateTasks, error: tasksError } = await supabase
    .from('schedule_tasks')
    .select('id, external_ref, current_planned_start')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .is('actual_start', null)

  if (tasksError) {
    console.error('[ingestion] morning task query error', tasksError)
    return
  }
  if (!candidateTasks || candidateTasks.length === 0) return

  // treatDueAsClearedAsOf lets a same-day (or overdue) predecessor's
  // handoff be trusted for a *ticked* confirmation (spec: parent/child
  // boundary-day fix) — looseEligibleTaskIds carries that; strict
  // eligibleTaskIds is still what gates an independent delayed-start
  // push, so an unconfirmed task never gets pushed twice (once here,
  // once via cascade from the predecessor's own eventual push).
  const gate = await filterEligibleCandidates(
    supabase,
    candidateTasks.map((t) => t.id as string),
    logDate,
  )
  if (!gate.ok) {
    console.error('[ingestion] morning gating query error', gate.error)
    return
  }

  const confirmed: string[] = []
  const delayedStart: string[] = []
  const invalidFlags: { taskId: string; detail: string }[] = []

  for (const task of candidateTasks) {
    const externalRef = task.external_ref as string | null
    const normalized = externalRef ? normalizeTaskId(externalRef) : null
    const plannedStart = task.current_planned_start as string
    const wasTicked = normalized !== null && confirmedIds.has(normalized)
    const taskId = task.id as string

    if (!gate.looseEligibleTaskIds.has(taskId)) {
      // spec §12 open question (b): confirmed before its predecessor was
      // done (and not even due/overdue) — reject, don't process, but
      // record it rather than silently drop it.
      if (wasTicked) {
        invalidFlags.push({
          taskId,
          detail: `Ticked started on ${logDate}, but a predecessor wasn't done or due yet.`,
        })
      }
      continue
    }

    if (wasTicked) {
      confirmed.push(taskId)
    } else if (gate.eligibleTaskIds.has(taskId) && plannedStart <= logDate) {
      delayedStart.push(taskId)
    }
    // else: not due yet, or only loosely (not strictly) eligible and
    // left unticked — leave untouched; its dates move via cascade once
    // its predecessor's own push actually happens.
  }

  if (invalidFlags.length > 0) {
    await recordIngestionFlags(
      supabase,
      projectId,
      triggerProjectLogId,
      'start_confirmed_before_predecessor_done',
      invalidFlags,
    )
  }

  if (confirmed.length > 0) {
    const outcome = await applyConfirmedStarts({
      supabase,
      projectId,
      confirmedTaskIds: confirmed,
      confirmedDate: logDate,
      triggerProjectLogId,
    })
    if (outcome.success) {
      console.info('[ingestion] confirmed starts applied', {
        count: confirmed.length,
        tasksChanged: outcome.tasksChanged,
        versionNumber: outcome.versionNumber,
      })
    } else {
      console.error('[ingestion] confirmed starts failed', outcome.error)
    }
  }

  if (delayedStart.length > 0) {
    const outcome = await applyDelayedStarts({
      supabase,
      projectId,
      delayedStartTaskIds: delayedStart,
      triggerProjectLogId,
      missReason: null,
    })
    if (outcome.success) {
      console.info('[ingestion] delayed starts applied', {
        count: delayedStart.length,
        tasksChanged: outcome.tasksChanged,
        versionNumber: outcome.versionNumber,
      })
    } else {
      console.error('[ingestion] delayed starts failed', outcome.error)
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
