import type { SupabaseClient } from '@supabase/supabase-js'
import { recordEdit } from '@/utils/logs/edit-history'
import {
  computeCascade,
  diffDaysIso,
  snapshotVersion,
  type CascadeSeed,
  type DependencyEdge,
  type TaskState,
} from '@/utils/scheduler/propagate'
import { normalizeTaskId } from '@/utils/scheduler/task-id'
import type { ParsedTaskRow } from '@/utils/scheduler/types'

/**
 * Rebuilds the not-yet-started part of a schedule from a newly uploaded
 * spreadsheet, keeping everything that has already happened.
 *
 *  1. Work that has started or finished is kept exactly as recorded: its
 *     dates, its actual start/end and its history.
 *  2. The anchors are the tasks in progress — or, when nothing is in
 *     progress, the task(s) finished most recently. Each anchor must be in
 *     the new sheet under the same code AND the same name; so must every
 *     other kept task the sheet lists. A mismatch means the sheet and the
 *     site disagree about what was done, and nothing is changed.
 *  3. Every task that hasn't started is deleted, and every sheet row whose
 *     code isn't a kept task is added fresh, with the sheet's dates and
 *     predecessors. A row may depend on a kept task (W36 after W35).
 *  4. A new task the sheet has starting before a kept predecessor ends is
 *     pushed later (and whatever follows it), the same as a delay would.
 *
 * planReplan is the pure part, used for the preview too; replanSchedule
 * writes it. Like the first import it is a sequence of calls, not one
 * transaction, so a failure partway can leave it half applied.
 */

export type ReplanTask = {
  id: string
  external_ref: string | null
  name: string
  status: 'pending' | 'done' | 'retired'
  current_planned_start: string
  current_planned_end: string
  duration_days: number
  actual_start: string | null
  actual_end: string | null
}

export type ReplanInsert = {
  externalRef: string
  name: string
  vendorTeam: string | null
  plannedStart: string
  plannedEnd: string
  currentStart: string
  currentEnd: string
  durationDays: number
  actualStart: string | null
  actualEnd: string | null
  status: 'pending' | 'done'
  predecessorRefs: string[]
}

export type ReplanPlan = {
  anchorKind: 'in_progress' | 'last_done' | 'none'
  anchors: string[]
  keptIds: string[]
  deleteIds: string[]
  /** Not-started tasks being replaced (deleteIds minus retired leftovers). */
  removedCount: number
  inserts: ReplanInsert[]
  /** Links from a new task to a kept task: [new ref, kept task id]. */
  keptLinks: [string, string][]
  shifted: string[]
  warnings: string[]
}

export type ReplanPlanResult =
  | { ok: true; plan: ReplanPlan }
  | { ok: false; errors: string[] }

function refOf(raw: string): string {
  return normalizeTaskId(raw) ?? raw.trim().toUpperCase()
}

function sameName(a: string, b: string): boolean {
  const clean = (value: string) =>
    value.replace(/\s+/g, ' ').trim().toLowerCase()
  return clean(a) === clean(b)
}

function code(task: Pick<ReplanTask, 'external_ref' | 'name'>): string {
  return task.external_ref ?? `"${task.name}"`
}

export function planReplan(
  existing: ReplanTask[],
  sheet: ParsedTaskRow[],
  today: string,
): ReplanPlanResult {
  const live = existing.filter((task) => task.status !== 'retired')
  const kept = live.filter(
    (task) => task.status === 'done' || task.actual_start !== null,
  )

  const inProgress = kept.filter((task) => task.status === 'pending')
  let anchorKind: ReplanPlan['anchorKind'] = 'none'
  let anchors: ReplanTask[] = []
  if (inProgress.length > 0) {
    anchorKind = 'in_progress'
    anchors = inProgress
  } else if (kept.length > 0) {
    const finished = (task: ReplanTask) =>
      task.actual_end ?? task.current_planned_end
    const latest = kept.map(finished).reduce((a, b) => (a > b ? a : b))
    anchorKind = 'last_done'
    anchors = kept.filter((task) => finished(task) === latest)
  }

  const sheetByRef = new Map(sheet.map((row) => [refOf(row.externalRef), row]))
  const keptByRef = new Map(
    kept
      .filter((task) => task.external_ref)
      .map((task) => [refOf(task.external_ref as string), task]),
  )

  const errors: string[] = []
  const anchorWord = anchorKind === 'in_progress' ? 'in progress' : 'last done'
  for (const anchor of anchors) {
    if (!anchor.external_ref) {
      errors.push(
        `"${anchor.name}" is ${anchorWord} but has no task code, so it can't be matched to the sheet.`,
      )
    } else if (!sheetByRef.has(refOf(anchor.external_ref))) {
      errors.push(
        `${anchor.external_ref} (${anchor.name}) is ${anchorWord} but isn't in the new sheet.`,
      )
    }
  }
  for (const [ref, task] of keptByRef) {
    const row = sheetByRef.get(ref)
    if (row && !sameName(row.name, task.name)) {
      errors.push(
        `${task.external_ref}: the app has "${task.name}" but the sheet has "${row.name}". The sheet doesn't match what was done on site.`,
      )
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const warnings: string[] = []
  const insertRows = sheet.filter(
    (row) => !keptByRef.has(refOf(row.externalRef)),
  )
  const insertRefs = new Set(insertRows.map((row) => refOf(row.externalRef)))

  for (const row of sheet) {
    const task = keptByRef.get(refOf(row.externalRef))
    if (!task) continue
    const waitingOnNew = row.predecessorRefs.filter((pred) =>
      insertRefs.has(refOf(pred)),
    )
    if (waitingOnNew.length > 0) {
      warnings.push(
        `${task.external_ref} has already started, so its link to ${waitingOnNew.join(', ')} in the sheet was ignored.`,
      )
    }
  }

  const keptLinks: [string, string][] = []
  const inserts: ReplanInsert[] = insertRows.map((row) => {
    const ref = refOf(row.externalRef)
    const predecessorRefs: string[] = []
    for (const pred of row.predecessorRefs) {
      const predRef = refOf(pred)
      const keptPred = keptByRef.get(predRef)
      if (insertRefs.has(predRef)) predecessorRefs.push(predRef)
      else if (keptPred) keptLinks.push([ref, keptPred.id])
      else warnings.push(`${ref} lists ${predRef}, which isn't in the plan.`)
    }
    const isDone = row.actualEnd !== null
    return {
      externalRef: ref,
      name: row.name,
      vendorTeam: row.vendorTeam,
      plannedStart: row.plannedStart,
      plannedEnd: row.plannedEnd,
      currentStart: row.plannedStart,
      currentEnd: isDone ? (row.actualEnd as string) : row.plannedEnd,
      durationDays: isDone
        ? Math.max(1, diffDaysIso(row.plannedStart, row.actualEnd as string))
        : row.durationDays,
      actualStart: row.actualStart,
      actualEnd: row.actualEnd,
      status: isDone ? 'done' : 'pending',
      predecessorRefs,
    }
  })

  // Push new tasks that would start before a kept predecessor ends. Kept
  // tasks are keyed by id and new ones by `new:<ref>`, so one cascade runs
  // over both.
  const newKey = (ref: string) => `new:${ref}`
  const state = new Map<string, TaskState>()
  for (const task of kept) {
    state.set(task.id, {
      currentStart: task.current_planned_start,
      currentEnd: task.current_planned_end,
      durationDays: task.duration_days,
    })
  }
  for (const insert of inserts) {
    state.set(newKey(insert.externalRef), {
      currentStart: insert.currentStart,
      currentEnd: insert.currentEnd,
      durationDays: insert.durationDays,
    })
  }
  const cascadeEdges: DependencyEdge[] = [
    ...keptLinks.map(([ref, keptId]) => ({
      taskId: newKey(ref),
      dependsOnTaskId: keptId,
      lagDays: 0,
    })),
    ...inserts.flatMap((insert) =>
      insert.predecessorRefs.map((pred) => ({
        taskId: newKey(insert.externalRef),
        dependsOnTaskId: newKey(pred),
        lagDays: 0,
      })),
    ),
  ]
  const seeds: CascadeSeed[] = Array.from(
    new Set(keptLinks.map(([, keptId]) => keptId)),
  ).map((taskId) => ({
    taskId,
    newEnd: (state.get(taskId) as TaskState).currentEnd,
  }))
  const changes = computeCascade(state, cascadeEdges, seeds, 'push', today)

  const byKey = new Map(
    inserts.map((insert) => [newKey(insert.externalRef), insert]),
  )
  const shifted = new Set<string>()
  for (const change of changes) {
    const insert = byKey.get(change.taskId)
    if (!insert || insert.status === 'done') continue
    insert.currentStart = change.newStart
    insert.currentEnd = change.newEnd
    shifted.add(insert.externalRef)
  }

  const keptIds = new Set(kept.map((task) => task.id))
  const notStarted = live.filter((task) => !keptIds.has(task.id))
  // A retired task still holds its code; one the sheet brings back must go
  // too, or the new row can't take the code.
  const retiredClashes = existing.filter(
    (task) =>
      task.status === 'retired' &&
      task.external_ref !== null &&
      insertRefs.has(refOf(task.external_ref)),
  )

  // Links between kept tasks are left alone; links touching a deleted task
  // go with it (on delete cascade).
  return {
    ok: true,
    plan: {
      anchorKind,
      anchors: anchors.map(code),
      keptIds: kept.map((task) => task.id),
      deleteIds: [...notStarted, ...retiredClashes].map((task) => task.id),
      removedCount: notStarted.length,
      inserts,
      keptLinks,
      shifted: Array.from(shifted),
      warnings,
    },
  }
}

export function describePlan(plan: ReplanPlan): string {
  const anchor =
    plan.anchorKind === 'none'
      ? 'Nothing has started yet, so the whole schedule is replaced.'
      : `Picks up after ${plan.anchors.join(', ')} (${plan.anchorKind === 'in_progress' ? 'in progress' : 'last done'}).`
  const lines = [
    anchor,
    `Keeps ${plan.keptIds.length} started or finished task${plan.keptIds.length === 1 ? '' : 's'}, removes ${plan.removedCount} not started, adds ${plan.inserts.length} from the sheet.`,
  ]
  if (plan.shifted.length > 0) {
    lines.push(
      `${plan.shifted.length} new task${plan.shifted.length === 1 ? '' : 's'} start later than the sheet says, to follow work already under way: ${plan.shifted.join(', ')}.`,
    )
  }
  return [...lines, ...plan.warnings].join('\n')
}

export type ReplanOutcome =
  | { ok: true; message: string }
  | { ok: false; error: string }

/** Loads the project's schedule, plans the rebuild, and — unless `preview`
 * — writes it as a new schedule version. */
export async function replanSchedule({
  supabase,
  projectId,
  sheet,
  filename,
  userId,
  note,
  today,
  preview,
}: {
  supabase: SupabaseClient
  projectId: string
  sheet: ParsedTaskRow[]
  filename: string
  userId: string
  note: string | null
  today: string
  preview: boolean
}): Promise<ReplanOutcome> {
  const { data: taskRows, error: tasksError } = await supabase
    .from('schedule_tasks')
    .select(
      'id, external_ref, name, status, current_planned_start, current_planned_end, duration_days, actual_start, actual_end',
    )
    .eq('project_id', projectId)
  if (tasksError) return { ok: false, error: tasksError.message }
  const existing = (taskRows ?? []) as ReplanTask[]

  const planned = planReplan(existing, sheet, today)
  if (!planned.ok) {
    return {
      ok: false,
      error: ['Nothing was changed.', ...planned.errors].join('\n'),
    }
  }
  const { plan } = planned
  const summary = describePlan(plan)
  if (preview) {
    return { ok: true, message: `Check passed. If you replace:\n${summary}` }
  }

  const { data: latestVersion, error: versionQueryError } = await supabase
    .from('schedule_versions')
    .select('version_number')
    .eq('project_id', projectId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (versionQueryError) return { ok: false, error: versionQueryError.message }
  const versionNumber = latestVersion
    ? (latestVersion.version_number as number) + 1
    : 0

  const { data: version, error: versionError } = await supabase
    .from('schedule_versions')
    .insert({
      project_id: projectId,
      version_number: versionNumber,
      source: 'excel_import',
      label:
        plan.anchorKind === 'none'
          ? `New schedule (v${versionNumber})`
          : `New schedule after ${plan.anchors.join(', ')} (v${versionNumber})`,
      created_by: userId,
    })
    .select('id')
    .single()
  if (versionError || !version) {
    return {
      ok: false,
      error: versionError?.message ?? 'Failed to create schedule version.',
    }
  }
  const versionId = version.id as string

  if (plan.deleteIds.length > 0) {
    const { error } = await supabase
      .from('schedule_tasks')
      .delete()
      .in('id', plan.deleteIds)
    if (error) return { ok: false, error: error.message }
  }

  const idByRef = new Map<string, string>()
  if (plan.inserts.length > 0) {
    const { data: inserted, error } = await supabase
      .from('schedule_tasks')
      .insert(
        plan.inserts.map((insert) => ({
          project_id: projectId,
          external_ref: insert.externalRef,
          name: insert.name,
          vendor_team: insert.vendorTeam,
          original_planned_start: insert.plannedStart,
          original_planned_end: insert.plannedEnd,
          current_planned_start: insert.currentStart,
          current_planned_end: insert.currentEnd,
          duration_days: insert.durationDays,
          actual_start: insert.actualStart,
          actual_end: insert.actualEnd,
          status: insert.status,
          created_in_version_id: versionId,
        })),
      )
      .select('id, external_ref')
    if (error) {
      return {
        ok: false,
        error: `The not-started tasks were removed, but adding the new ones failed: ${error.message}`,
      }
    }
    for (const row of (inserted ?? []) as {
      id: string
      external_ref: string
    }[]) {
      idByRef.set(row.external_ref, row.id)
    }
  }

  const edgeRowsToInsert = [
    ...plan.keptLinks.map(([ref, keptId]) => ({
      task_id: idByRef.get(ref) as string,
      depends_on_task_id: keptId,
      lag_days: 0,
    })),
    ...plan.inserts.flatMap((insert) =>
      insert.predecessorRefs.map((pred) => ({
        task_id: idByRef.get(insert.externalRef) as string,
        depends_on_task_id: idByRef.get(pred) as string,
        lag_days: 0,
      })),
    ),
  ]
  if (edgeRowsToInsert.length > 0) {
    const { error } = await supabase
      .from('schedule_task_dependencies')
      .insert(edgeRowsToInsert)
    if (error) {
      return {
        ok: false,
        error: `The new tasks were added, but linking them failed: ${error.message}`,
      }
    }
  }

  const snapshot = await snapshotVersion(supabase, projectId, versionId)
  if (!snapshot.ok) return { ok: false, error: snapshot.error }

  // Best-effort records, as with the first import.
  await supabase.from('schedule_imports').insert({
    project_id: projectId,
    schedule_version_id: versionId,
    storage_path: null,
    original_filename: filename,
    row_count: sheet.length,
    parsed_task_count: sheet.length,
    parse_errors_json: null,
    created_by: userId,
  })
  const recorded = await recordEdit(supabase, {
    projectId,
    logId: null,
    userId,
    kind: 'schedule_replanned',
    details: {
      anchors: plan.anchors,
      kept: plan.keptIds.length,
      removed: plan.removedCount,
      added: plan.inserts.length,
      shifted: plan.shifted,
      filename,
    },
    note,
  })

  return {
    ok: true,
    message: `Schedule replaced (version ${versionNumber}).\n${summary}${recorded ? '' : '\n(History entry not saved: run db/updates_v3.sql in Supabase.)'}`,
  }
}
