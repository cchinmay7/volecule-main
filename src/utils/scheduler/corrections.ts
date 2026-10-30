import type { SupabaseClient } from '@supabase/supabase-js'
import { isIsoDate } from '@/utils/dates'
import { recordEdit } from '@/utils/logs/edit-history'
import { filterEligibleCandidates } from '@/utils/scheduler/gating'
import {
  addDaysIso,
  applyManualOverride,
  diffDaysIso,
  type ManualTaskValues,
  type PropagationOutcome,
} from '@/utils/scheduler/propagate'
import {
  MAX_TASK_NAME_LENGTH,
  normalizeTaskId,
} from '@/utils/scheduler/task-id'

/**
 * Operator corrections to the live schedule — what the Updates page calls
 * when a site engineer got something wrong (ticked the wrong task, forgot a
 * start, mistyped a date). Each function checks that the requested change
 * makes sense for the task as it stands, works out the task's new state,
 * and hands it to applyManualOverride, which persists it and cascades the
 * effect through the dependency graph with a 'manual_override' audit trail.
 *
 * These deliberately do not re-run the form-ingestion rules: those pushes
 * are one-per-check and not idempotent, so replaying a corrected log would
 * double-apply them. A correction states the end result instead.
 */

export type CorrectionResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

type TaskRow = {
  id: string
  project_id: string
  external_ref: string | null
  name: string
  status: 'pending' | 'done' | 'retired'
  original_planned_start: string
  original_planned_end: string
  current_planned_start: string
  current_planned_end: string
  duration_days: number
  actual_start: string | null
  actual_end: string | null
}

const TASK_COLUMNS =
  'id, project_id, external_ref, name, status, original_planned_start, original_planned_end, current_planned_start, current_planned_end, duration_days, actual_start, actual_end'

function label(task: Pick<TaskRow, 'external_ref' | 'name'>): string {
  return task.external_ref ?? task.name
}

async function loadTask(
  supabase: SupabaseClient,
  projectId: string,
  taskId: string,
): Promise<{ ok: true; task: TaskRow } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('schedule_tasks')
    .select(TASK_COLUMNS)
    .eq('id', taskId)
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data || data.project_id !== projectId) {
    return { ok: false, error: 'Task not found in this project.' }
  }
  const task = data as TaskRow
  if (task.status === 'retired') {
    return {
      ok: false,
      error: `${label(task)} is retired and can't be corrected.`,
    }
  }
  return { ok: true, task }
}

/** Direct dependents of the task that have already started or finished —
 * correcting the task underneath them would leave the plan contradicting
 * itself, so those must be corrected first. */
async function startedDependents(
  supabase: SupabaseClient,
  taskId: string,
): Promise<{ ok: true; labels: string[] } | { ok: false; error: string }> {
  const { data: edges, error: edgesError } = await supabase
    .from('schedule_task_dependencies')
    .select('task_id')
    .eq('depends_on_task_id', taskId)
  if (edgesError) return { ok: false, error: edgesError.message }

  const dependentIds = (edges ?? []).map((edge) => edge.task_id as string)
  if (dependentIds.length === 0) return { ok: true, labels: [] }

  const { data: rows, error: rowsError } = await supabase
    .from('schedule_tasks')
    .select('id, external_ref, name, status, actual_start')
    .in('id', dependentIds)
  if (rowsError) return { ok: false, error: rowsError.message }

  return {
    ok: true,
    labels: (rows ?? [])
      .filter((row) => row.status === 'done' || row.actual_start !== null)
      .map((row) => label(row as Pick<TaskRow, 'external_ref' | 'name'>)),
  }
}

/** Predecessors that aren't done yet, for explaining why a change is refused. */
async function openPredecessors(
  supabase: SupabaseClient,
  taskId: string,
): Promise<string[]> {
  const { data: edges } = await supabase
    .from('schedule_task_dependencies')
    .select('depends_on_task_id')
    .eq('task_id', taskId)
  const ids = (edges ?? []).map((edge) => edge.depends_on_task_id as string)
  if (ids.length === 0) return []

  const { data: rows } = await supabase
    .from('schedule_tasks')
    .select('external_ref, name, status')
    .in('id', ids)
  return (rows ?? [])
    .filter((row) => row.status !== 'done')
    .map((row) => label(row as Pick<TaskRow, 'external_ref' | 'name'>))
}

function describe(outcome: PropagationOutcome): CorrectionResult {
  if (!outcome.success) return { ok: false, error: outcome.error }
  const moved = outcome.tasksChanged - 1
  return {
    ok: true,
    message:
      moved > 0
        ? `Saved. ${moved} dependent task${moved === 1 ? '' : 's'} moved as a result.`
        : 'Saved. No other tasks needed to move.',
  }
}

type Base = { supabase: SupabaseClient; projectId: string; taskId: string }

export async function markTaskDone({
  supabase,
  projectId,
  taskId,
  actualEnd,
  startedOn,
  note,
  today,
}: Base & {
  actualEnd: string
  /** Only used when the task has no recorded start. */
  startedOn?: string | null
  note: string | null
  today: string
}): Promise<CorrectionResult> {
  if (!isIsoDate(actualEnd)) {
    return { ok: false, error: 'Enter the completion date as a valid date.' }
  }
  if (actualEnd > today) {
    return { ok: false, error: "A task can't be completed in the future." }
  }

  const loaded = await loadTask(supabase, projectId, taskId)
  if (!loaded.ok) return loaded
  const { task } = loaded

  if (task.status === 'pending') {
    const gate = await filterEligibleCandidates(supabase, [taskId])
    if (!gate.ok) return { ok: false, error: gate.error }
    if (!gate.eligibleTaskIds.has(taskId)) {
      const open = await openPredecessors(supabase, taskId)
      return {
        ok: false,
        error: `${label(task)} can't be marked done while ${open.join(', ') || 'a predecessor'} isn't done. Correct that first.`,
      }
    }
  }

  let start = task.actual_start
  if (!start) {
    start =
      startedOn && isIsoDate(startedOn)
        ? startedOn
        : task.current_planned_start < actualEnd
          ? task.current_planned_start
          : actualEnd
  }
  if (actualEnd < start) {
    return {
      ok: false,
      error: `The completion date can't be before the start (${start}).`,
    }
  }

  const values: ManualTaskValues = {
    status: 'done',
    actual_start: start,
    actual_end: actualEnd,
    current_planned_start: start,
    current_planned_end: actualEnd,
    duration_days: Math.max(1, diffDaysIso(start, actualEnd)),
  }

  return describe(
    await applyManualOverride({
      supabase,
      projectId,
      taskId,
      values,
      versionLabel: `Manual correction: ${label(task)} done ${actualEnd}`,
      note,
      today,
    }),
  )
}

export async function reopenTask({
  supabase,
  projectId,
  taskId,
  newEnd,
  note,
  today,
}: Base & {
  newEnd: string
  note: string | null
  today: string
}): Promise<CorrectionResult> {
  if (!isIsoDate(newEnd)) {
    return { ok: false, error: 'Enter the new expected end as a valid date.' }
  }

  const loaded = await loadTask(supabase, projectId, taskId)
  if (!loaded.ok) return loaded
  const { task } = loaded

  if (task.status !== 'done') {
    return { ok: false, error: `${label(task)} isn't marked done.` }
  }

  const blockers = await startedDependents(supabase, taskId)
  if (!blockers.ok) return blockers
  if (blockers.labels.length > 0) {
    return {
      ok: false,
      error: `${blockers.labels.join(', ')} already started or finished after ${label(task)}. Undo that first.`,
    }
  }

  const start = task.actual_start ?? task.current_planned_start
  if (newEnd <= start) {
    return {
      ok: false,
      error: `The new expected end must be after the start (${start}).`,
    }
  }

  const values: ManualTaskValues = {
    status: 'pending',
    actual_end: null,
    current_planned_start: start,
    current_planned_end: newEnd,
    duration_days: diffDaysIso(start, newEnd),
  }

  return describe(
    await applyManualOverride({
      supabase,
      projectId,
      taskId,
      values,
      versionLabel: `Manual correction: ${label(task)} reopened`,
      note,
      today,
    }),
  )
}

export async function setTaskStart({
  supabase,
  projectId,
  taskId,
  startDate,
  note,
  today,
}: Base & {
  startDate: string
  note: string | null
  today: string
}): Promise<CorrectionResult> {
  if (!isIsoDate(startDate)) {
    return { ok: false, error: 'Enter the start date as a valid date.' }
  }
  if (startDate > today) {
    return { ok: false, error: "A task can't have started in the future." }
  }

  const loaded = await loadTask(supabase, projectId, taskId)
  if (!loaded.ok) return loaded
  const { task } = loaded

  if (task.status !== 'pending') {
    return {
      ok: false,
      error: `${label(task)} is already done. Reopen it first.`,
    }
  }

  // Same boundary-day rule as the morning form: a predecessor that is done,
  // or due on or before the start date, doesn't hold the task back.
  const gate = await filterEligibleCandidates(supabase, [taskId], startDate)
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!gate.looseEligibleTaskIds.has(taskId)) {
    const open = await openPredecessors(supabase, taskId)
    return {
      ok: false,
      error: `${label(task)} can't start on ${startDate} while ${open.join(', ') || 'a predecessor'} isn't done or due by then.`,
    }
  }

  const values: ManualTaskValues = {
    actual_start: startDate,
    current_planned_start: startDate,
    current_planned_end: addDaysIso(startDate, task.duration_days),
    duration_days: task.duration_days,
  }

  return describe(
    await applyManualOverride({
      supabase,
      projectId,
      taskId,
      values,
      versionLabel: `Manual correction: ${label(task)} started ${startDate}`,
      note,
      today,
    }),
  )
}

export async function clearTaskStart({
  supabase,
  projectId,
  taskId,
  expectedStart,
  note,
  today,
}: Base & {
  expectedStart: string
  note: string | null
  today: string
}): Promise<CorrectionResult> {
  if (!isIsoDate(expectedStart)) {
    return { ok: false, error: 'Enter the expected start as a valid date.' }
  }

  const loaded = await loadTask(supabase, projectId, taskId)
  if (!loaded.ok) return loaded
  const { task } = loaded

  if (task.status !== 'pending' || task.actual_start === null) {
    return {
      ok: false,
      error: `${label(task)} hasn't been started, so there's no start to clear.`,
    }
  }

  const blockers = await startedDependents(supabase, taskId)
  if (!blockers.ok) return blockers
  if (blockers.labels.length > 0) {
    return {
      ok: false,
      error: `${blockers.labels.join(', ')} already started or finished after ${label(task)}. Undo that first.`,
    }
  }

  // The task is no longer running, so any overrun it had accumulated no
  // longer applies: it goes back to its originally planned span.
  const originalSpan = diffDaysIso(
    task.original_planned_start,
    task.original_planned_end,
  )
  const duration = originalSpan > 0 ? originalSpan : task.duration_days

  const values: ManualTaskValues = {
    actual_start: null,
    current_planned_start: expectedStart,
    current_planned_end: addDaysIso(expectedStart, duration),
    duration_days: duration,
  }

  return describe(
    await applyManualOverride({
      supabase,
      projectId,
      taskId,
      values,
      versionLabel: `Manual correction: ${label(task)} start cleared`,
      note,
      today,
    }),
  )
}

export async function setTaskDates({
  supabase,
  projectId,
  taskId,
  start,
  end,
  note,
  today,
}: Base & {
  start: string
  end: string
  note: string | null
  today: string
}): Promise<CorrectionResult> {
  if (!isIsoDate(start) || !isIsoDate(end)) {
    return { ok: false, error: 'Enter the start and end as valid dates.' }
  }
  if (end <= start) {
    return { ok: false, error: 'The end must be after the start.' }
  }

  const loaded = await loadTask(supabase, projectId, taskId)
  if (!loaded.ok) return loaded
  const { task } = loaded

  if (task.status !== 'pending') {
    return {
      ok: false,
      error: `${label(task)} is already done. Reopen it first, or change its completion date.`,
    }
  }
  if (task.actual_start !== null && start !== task.actual_start) {
    return {
      ok: false,
      error: `${label(task)} started on ${task.actual_start}. Change that with "Set start date" instead.`,
    }
  }

  const values: ManualTaskValues = {
    current_planned_start: start,
    current_planned_end: end,
    duration_days: diffDaysIso(start, end),
  }

  return describe(
    await applyManualOverride({
      supabase,
      projectId,
      taskId,
      values,
      versionLabel: `Manual correction: ${label(task)} dates edited`,
      note,
      today,
    }),
  )
}

const RENAME_HISTORY_WARNING =
  ' (History entry not saved: run db/updates_v2.sql in Supabase.)'

/** True when `name` starts with the task's own code followed by a separator
 * ("W41 — Column Steel", "W-41: Column Steel"), which would show the code
 * twice since it is always printed in front of the name. A plain leading
 * number or word ("38 inch pipe", "Level 2 slab") is a name, not a code. */
export function startsWithOwnCode(name: string, code: string): boolean {
  const leading = name.match(/^\s*([A-Za-z]*[\s-]?\d+)\s*[-–—:]/)
  return (
    leading !== null && normalizeTaskId(leading[1]) === normalizeTaskId(code)
  )
}

/**
 * Changes a task's name, and only its name. The code (external_ref, such as
 * W41) is what the forms and the schedule import match on, so it is never
 * touched here, and nothing about the plan moves: no dates, no cascade, no
 * new schedule version. Past versions keep the name they had, since they are
 * a record of what the plan said at the time.
 *
 * A done task can be renamed too. The change is recorded in the operator's
 * history (best-effort, like log edits).
 */
export async function renameTask({
  supabase,
  projectId,
  taskId,
  name,
  userId,
  note,
}: Base & {
  name: string
  userId: string
  note: string | null
}): Promise<CorrectionResult> {
  const nextName = name.replace(/\s+/g, ' ').trim()
  if (nextName === '') {
    return { ok: false, error: 'Enter a name for the task.' }
  }
  if (nextName.length > MAX_TASK_NAME_LENGTH) {
    return {
      ok: false,
      error: `Keep the name to ${MAX_TASK_NAME_LENGTH} characters or fewer.`,
    }
  }

  const loaded = await loadTask(supabase, projectId, taskId)
  if (!loaded.ok) return loaded
  const { task } = loaded

  if (task.external_ref && startsWithOwnCode(nextName, task.external_ref)) {
    return {
      ok: false,
      error: `Leave the code out of the name. ${task.external_ref} is shown in front of it automatically.`,
    }
  }

  const previousName = task.name
  if (nextName === previousName) {
    return { ok: true, message: 'Nothing changed.' }
  }

  const { error } = await supabase
    .from('schedule_tasks')
    .update({ name: nextName })
    .eq('id', taskId)
    .eq('project_id', projectId)
  if (error) return { ok: false, error: error.message }

  const recorded = await recordEdit(supabase, {
    projectId,
    logId: null,
    userId,
    kind: 'task_renamed',
    details: {
      task_id: taskId,
      code: task.external_ref,
      previous: previousName,
      next: nextName,
    },
    note,
  })

  return {
    ok: true,
    message: `Renamed.${task.external_ref ? ` The code ${task.external_ref} is unchanged.` : ''}${recorded ? '' : RENAME_HISTORY_WARNING}`,
  }
}
