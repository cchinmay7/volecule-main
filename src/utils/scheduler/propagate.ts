import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Schedule Propagation Engine — see db/scheduler_v1.sql and the "Schedule
 * Propagation Engine" spec §06.
 *
 * This module assumes the caller has ALREADY decided which tasks are
 * missed or completed (e.g. from a site log or an overdue sweep). Its job
 * is purely to compute and persist the cascading date changes that follow
 * from that decision — never to decide what's late.
 *
 * Structure mirrors parse-excel.ts / graph.ts: `computeCascade` below is a
 * pure, dependency-free relaxation over the DAG (unit-tested in
 * propagate.test.ts with no database involved); `applyMissedTargets` and
 * `applyTaskCompletions` are thin I/O wrappers that fetch plain objects
 * from Supabase, call the pure function, and write the results back.
 */

// ---------------------------------------------------------------------------
// Pure cascade logic
// ---------------------------------------------------------------------------

export type TaskState = {
  currentStart: string
  currentEnd: string
  durationDays: number
}

export type DependencyEdge = {
  taskId: string
  dependsOnTaskId: string
  lagDays: number
}

export type CascadeSeed = {
  taskId: string
  newEnd: string
}

export type CascadeChange = {
  taskId: string
  newStart: string
  newEnd: string
}

export type CascadeMode = 'push' | 'pull'

/**
 * Adds `days` (may be negative) to an ISO 'YYYY-MM-DD' date string, using
 * UTC arithmetic so the result is never off-by-one from a local-timezone
 * DST transition. Plain string comparison on the inputs/outputs is safe
 * because ISO dates sort lexicographically.
 */
export function addDaysIso(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

/**
 * Breadth-first relaxation over the dependency DAG. Given a set of tasks
 * whose `current_planned_end` just changed (`seeds`), propagates the
 * effect to every dependent, transitively, and returns the list of
 * further changes required — the seeds' own change is assumed already
 * applied by the caller and is NOT included in the result.
 *
 * Two distinct relaxation rules, chosen by `mode`:
 *
 * - 'push' (a task slipped / was missed): for each dependent D of a task
 *   T that just moved, `required_start = T.currentEnd + 1 + lag`. D only
 *   moves if `required_start > D.currentStart` — checked against D's
 *   CURRENT start, not a max over all of D's predecessors. That's
 *   deliberate: D's current start already reflects whatever its
 *   most-constraining predecessor previously required, so a plain
 *   per-edge check is sufficient and a diamond-dependency task is never
 *   pushed earlier than its slowest predecessor already put it. A task
 *   that doesn't move is a dead branch and is not enqueued — nothing
 *   downstream of it needs re-checking.
 *
 * - 'pull' (a task finished early): pulling a dependent forward is only
 *   safe once ALL of its predecessors allow it, so for each dependent D
 *   of the task that just finished early, `earliest_start` is the max
 *   over EVERY predecessor P of D of `P.currentEnd + 1 + lag(P->D)` —
 *   not just the edge that triggered this pass. D moves only if it
 *   hasn't reached its own scheduled start yet (`today < D.currentStart`)
 *   and the recomputed `earliest_start` is actually earlier than its
 *   current start. This is why a diamond dependency gated by a slower
 *   predecessor silently absorbs an early finish on the faster branch
 *   until the slow branch also clears.
 *
 * In both modes, a task that moves is enqueued so its own dependents are
 * checked next, letting the cascade run transitively through the graph.
 */
export function computeCascade(
  tasks: Map<string, TaskState>,
  edges: DependencyEdge[],
  seeds: CascadeSeed[],
  mode: CascadeMode,
  today: string,
): CascadeChange[] {
  // Mutable working copy — seeds and cascaded changes are applied here as
  // the BFS proceeds so later lookups (e.g. a 'pull' predecessor scan)
  // see up-to-date state from earlier in this same pass.
  const state = new Map<string, TaskState>()
  for (const [id, task] of tasks) {
    state.set(id, { ...task })
  }

  // dependentsOf: predecessor id -> edges where it is the depends_on side.
  // predecessorsOf: dependent id -> edges where it is the task_id side.
  const dependentsOf = new Map<string, DependencyEdge[]>()
  const predecessorsOf = new Map<string, DependencyEdge[]>()
  for (const edge of edges) {
    const dependents = dependentsOf.get(edge.dependsOnTaskId) ?? []
    dependents.push(edge)
    dependentsOf.set(edge.dependsOnTaskId, dependents)

    const predecessors = predecessorsOf.get(edge.taskId) ?? []
    predecessors.push(edge)
    predecessorsOf.set(edge.taskId, predecessors)
  }

  const results: CascadeChange[] = []
  const queue: string[] = []

  for (const seed of seeds) {
    const current = state.get(seed.taskId)
    if (!current) continue
    state.set(seed.taskId, { ...current, currentEnd: seed.newEnd })
    queue.push(seed.taskId)
  }

  while (queue.length > 0) {
    const movedId = queue.shift() as string
    const dependentEdges = dependentsOf.get(movedId) ?? []

    for (const edge of dependentEdges) {
      const dependentId = edge.taskId
      const dependent = state.get(dependentId)
      if (!dependent) continue

      let newStart: string

      if (mode === 'push') {
        const predecessor = state.get(movedId)
        if (!predecessor) continue
        const requiredStart = addDaysIso(
          predecessor.currentEnd,
          1 + edge.lagDays,
        )
        if (!(requiredStart > dependent.currentStart)) continue
        newStart = requiredStart
      } else {
        const predecessorEdges = predecessorsOf.get(dependentId) ?? []
        let earliestStart: string | null = null
        for (const predEdge of predecessorEdges) {
          const predecessor = state.get(predEdge.dependsOnTaskId)
          if (!predecessor) continue
          const candidate = addDaysIso(
            predecessor.currentEnd,
            1 + predEdge.lagDays,
          )
          if (earliestStart === null || candidate > earliestStart) {
            earliestStart = candidate
          }
        }
        if (earliestStart === null) continue
        if (!(today < dependent.currentStart)) continue
        if (!(earliestStart < dependent.currentStart)) continue
        newStart = earliestStart
      }

      const newEnd = addDaysIso(newStart, dependent.durationDays - 1)
      state.set(dependentId, {
        ...dependent,
        currentStart: newStart,
        currentEnd: newEnd,
      })
      results.push({ taskId: dependentId, newStart, newEnd })
      queue.push(dependentId)
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// I/O wrappers
// ---------------------------------------------------------------------------

export type PropagationOutcome =
  | { success: true; versionNumber: number | null; tasksChanged: number }
  | { success: false; error: string }

type ScheduleTaskRow = {
  id: string
  current_planned_start: string
  current_planned_end: string
  duration_days: number
}

type DependencyEdgeRow = {
  task_id: string
  depends_on_task_id: string
  lag_days: number
}

type RevisionInsert = {
  task_id: string
  schedule_version_id: string
  previous_start: string
  previous_end: string
  new_start: string
  new_end: string
  change_reason: 'missed_target' | 'early_finish'
  trigger_project_log_id: string | null
  miss_reason: string | null
}

/** Fetches every task + dependency edge for a project, for use as the
 * universe `computeCascade` relaxes over. Propagation can touch any task
 * reachable from the seeds, so (as with import-schedule.ts's snapshot
 * step) the whole project is fetched rather than trying to predict the
 * blast radius up front. */
async function fetchProjectGraph(
  supabase: SupabaseClient,
  projectId: string,
): Promise<
  | { ok: true; tasks: Map<string, TaskState>; edges: DependencyEdge[] }
  | { ok: false; error: string }
> {
  const { data: taskRows, error: tasksError } = await supabase
    .from('schedule_tasks')
    .select('id, current_planned_start, current_planned_end, duration_days')
    .eq('project_id', projectId)

  if (tasksError) {
    return { ok: false, error: tasksError.message }
  }

  const rows = (taskRows ?? []) as ScheduleTaskRow[]
  const tasks = new Map<string, TaskState>(
    rows.map((row) => [
      row.id,
      {
        currentStart: row.current_planned_start,
        currentEnd: row.current_planned_end,
        durationDays: row.duration_days,
      },
    ]),
  )

  const taskIds = rows.map((row) => row.id)
  if (taskIds.length === 0) {
    return { ok: true, tasks, edges: [] }
  }

  const { data: edgeRows, error: edgesError } = await supabase
    .from('schedule_task_dependencies')
    .select('task_id, depends_on_task_id, lag_days')
    .in('task_id', taskIds)

  if (edgesError) {
    return { ok: false, error: edgesError.message }
  }

  const edges = ((edgeRows ?? []) as DependencyEdgeRow[]).map((row) => ({
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    lagDays: row.lag_days,
  }))

  return { ok: true, tasks, edges }
}

/** Turns an ordered list of cascade changes into revision rows, tracking
 * each task's "previous" value as the running state within this pass
 * (rather than always the originally-fetched value) so that if a task
 * happens to move more than once in a single run, each revision records
 * the delta that actually produced it. */
function buildRevisions(
  changes: CascadeChange[],
  originalState: Map<string, TaskState>,
  versionId: string,
  changeReason: 'missed_target' | 'early_finish',
  triggerProjectLogId: string | null,
  missReason: string | null,
): { revisions: RevisionInsert[]; finalByTask: Map<string, CascadeChange> } {
  const previousByTask = new Map<string, { start: string; end: string }>()
  for (const [id, task] of originalState) {
    previousByTask.set(id, { start: task.currentStart, end: task.currentEnd })
  }

  const revisions: RevisionInsert[] = []
  const finalByTask = new Map<string, CascadeChange>()

  for (const change of changes) {
    const previous = previousByTask.get(change.taskId)
    if (!previous) continue

    revisions.push({
      task_id: change.taskId,
      schedule_version_id: versionId,
      previous_start: previous.start,
      previous_end: previous.end,
      new_start: change.newStart,
      new_end: change.newEnd,
      change_reason: changeReason,
      trigger_project_log_id: triggerProjectLogId,
      miss_reason: missReason,
    })

    previousByTask.set(change.taskId, {
      start: change.newStart,
      end: change.newEnd,
    })
    finalByTask.set(change.taskId, change)
  }

  return { revisions, finalByTask }
}

/** Creates the next schedule_versions row for a project (source:
 * 'propagation') and returns its id + version_number, following the same
 * version-numbering convention as importSchedule. */
async function createPropagationVersion(
  supabase: SupabaseClient,
  projectId: string,
  label: string,
): Promise<
  { ok: true; id: string; versionNumber: number } | { ok: false; error: string }
> {
  const { data: latestVersion, error: versionQueryError } = await supabase
    .from('schedule_versions')
    .select('version_number')
    .eq('project_id', projectId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (versionQueryError) {
    return { ok: false, error: versionQueryError.message }
  }

  const versionNumber = latestVersion
    ? (latestVersion.version_number as number) + 1
    : 0

  const { data: newVersion, error: versionInsertError } = await supabase
    .from('schedule_versions')
    .insert({
      project_id: projectId,
      version_number: versionNumber,
      source: 'propagation',
      label,
      created_by: null,
    })
    .select('id')
    .single()

  if (versionInsertError || !newVersion) {
    return {
      ok: false,
      error:
        versionInsertError?.message ?? 'Failed to create schedule version.',
    }
  }

  return { ok: true, id: newVersion.id as string, versionNumber }
}

/** Snapshots the full current state of every task in the project into
 * schedule_version_tasks under the given version — same pattern as the
 * last step of importSchedule. Call this AFTER all schedule_tasks writes
 * for the run have landed. */
async function snapshotVersion(
  supabase: SupabaseClient,
  projectId: string,
  versionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: allCurrentTasks, error: allTasksError } = await supabase
    .from('schedule_tasks')
    .select(
      'id, name, vendor_team, current_planned_start, current_planned_end, status',
    )
    .eq('project_id', projectId)

  if (allTasksError) {
    return { ok: false, error: allTasksError.message }
  }

  const snapshotRows = (allCurrentTasks ?? []).map((t) => ({
    schedule_version_id: versionId,
    task_id: t.id as string,
    name: t.name as string,
    vendor_team: t.vendor_team as string | null,
    planned_start: t.current_planned_start as string,
    planned_end: t.current_planned_end as string,
    status: t.status as string,
  }))

  if (snapshotRows.length > 0) {
    const { error: snapshotError } = await supabase
      .from('schedule_version_tasks')
      .insert(snapshotRows)
    if (snapshotError) {
      return { ok: false, error: snapshotError.message }
    }
  }

  return { ok: true }
}

/**
 * Marks one or more tasks missed and cascades the resulting slip forward
 * through the dependency graph. `missedTaskIds` should be batched into a
 * single call for everything confirmed missed in one run (a log with
 * several unticked boxes, or one sweep finding several overdue tasks) —
 * that produces one combined schedule version rather than one per task.
 *
 * `current_planned_start` is never touched here: by the time a task can
 * be checked as missed, start <= end <= today already holds, so there's
 * no way to distinguish "started late" from "never started" — matching
 * the schema's deliberate omission of an `in_progress` status.
 */
export async function applyMissedTargets({
  supabase,
  projectId,
  missedTaskIds,
  triggerProjectLogId,
  missReason,
}: {
  supabase: SupabaseClient
  projectId: string
  missedTaskIds: string[]
  triggerProjectLogId: string | null
  missReason: string | null
}): Promise<PropagationOutcome> {
  if (missedTaskIds.length === 0) {
    return { success: true, versionNumber: null, tasksChanged: 0 }
  }

  const { data: rootRows, error: rootFetchError } = await supabase
    .from('schedule_tasks')
    .select('id, current_planned_start, current_planned_end, duration_days')
    .in('id', missedTaskIds)

  if (rootFetchError) {
    return { success: false, error: rootFetchError.message }
  }

  const rootTasks = (rootRows ?? []) as ScheduleTaskRow[]
  if (rootTasks.length === 0) {
    return { success: true, versionNumber: null, tasksChanged: 0 }
  }

  const graph = await fetchProjectGraph(supabase, projectId)
  if (!graph.ok) {
    return { success: false, error: graph.error }
  }

  // Snapshot pre-change state before any writes, for revision "previous"
  // values — the root tasks' rows are included here with their
  // not-yet-updated current_planned_end.
  const originalState = graph.tasks

  const seeds: CascadeSeed[] = []
  for (const root of rootTasks) {
    const newEnd = addDaysIso(root.current_planned_end, 1)

    const { error: updateError } = await supabase
      .from('schedule_tasks')
      .update({ current_planned_end: newEnd, status: 'missed' })
      .eq('id', root.id)

    if (updateError) {
      return { success: false, error: updateError.message }
    }

    seeds.push({ taskId: root.id, newEnd })
  }

  const cascadeChanges = computeCascade(
    graph.tasks,
    graph.edges,
    seeds,
    'push',
    '', // today is unused in 'push' mode
  )

  const version = await createPropagationVersion(
    supabase,
    projectId,
    `Missed: ${missedTaskIds.length} target(s)`,
  )
  if (!version.ok) {
    return { success: false, error: version.error }
  }

  const { revisions: cascadeRevisions, finalByTask } = buildRevisions(
    cascadeChanges,
    originalState,
    version.id,
    'missed_target',
    triggerProjectLogId,
    missReason,
  )

  const rootRevisions: RevisionInsert[] = rootTasks.map((root) => ({
    task_id: root.id,
    schedule_version_id: version.id,
    previous_start: root.current_planned_start,
    previous_end: root.current_planned_end,
    new_start: root.current_planned_start,
    new_end: addDaysIso(root.current_planned_end, 1),
    change_reason: 'missed_target',
    trigger_project_log_id: triggerProjectLogId,
    miss_reason: missReason,
  }))

  for (const [taskId, change] of finalByTask) {
    const { error: updateError } = await supabase
      .from('schedule_tasks')
      .update({
        current_planned_start: change.newStart,
        current_planned_end: change.newEnd,
      })
      .eq('id', taskId)

    if (updateError) {
      return { success: false, error: updateError.message }
    }
  }

  const allRevisions = [...rootRevisions, ...cascadeRevisions]
  if (allRevisions.length > 0) {
    const { error: revisionsError } = await supabase
      .from('schedule_task_revisions')
      .insert(allRevisions)
    if (revisionsError) {
      return { success: false, error: revisionsError.message }
    }
  }

  const snapshot = await snapshotVersion(supabase, projectId, version.id)
  if (!snapshot.ok) {
    return { success: false, error: snapshot.error }
  }

  return {
    success: true,
    versionNumber: version.versionNumber,
    tasksChanged: rootTasks.length + finalByTask.size,
  }
}

/**
 * Records one or more task completions. Every completion always updates
 * that task's status to 'done' and stamps `actual_end`, regardless of
 * timing. A completion that finished BEFORE its current planned end also
 * pulls its own `current_planned_end` forward and cascades the pull to
 * dependents (see computeCascade's 'pull' mode for why a single edge
 * isn't enough to decide that safely). On-time or late completions never
 * cascade — nothing about the plan's dates changed for them.
 *
 * All early-finish cascades from this call are batched into a single
 * schedule version. If none of the completions were early, tasks are
 * still updated but no version is created, since nothing about the plan
 * changed.
 */
export async function applyTaskCompletions({
  supabase,
  projectId,
  completions,
  today,
}: {
  supabase: SupabaseClient
  projectId: string
  completions: { taskId: string; actualEnd: string }[]
  today: string
}): Promise<PropagationOutcome> {
  if (completions.length === 0) {
    return { success: true, versionNumber: null, tasksChanged: 0 }
  }

  const taskIds = completions.map((c) => c.taskId)
  const { data: rows, error: fetchError } = await supabase
    .from('schedule_tasks')
    .select('id, current_planned_start, current_planned_end, duration_days')
    .in('id', taskIds)

  if (fetchError) {
    return { success: false, error: fetchError.message }
  }

  const rowsById = new Map(
    ((rows ?? []) as ScheduleTaskRow[]).map((row) => [row.id, row]),
  )

  const seeds: CascadeSeed[] = []
  let updatedCount = 0

  for (const completion of completions) {
    const row = rowsById.get(completion.taskId)
    if (!row) continue

    const isEarly = completion.actualEnd < row.current_planned_end
    const update: Record<string, string> = {
      status: 'done',
      actual_end: completion.actualEnd,
    }
    if (isEarly) {
      update.current_planned_end = completion.actualEnd
    }

    const { error: updateError } = await supabase
      .from('schedule_tasks')
      .update(update)
      .eq('id', completion.taskId)

    if (updateError) {
      return { success: false, error: updateError.message }
    }
    updatedCount += 1

    if (isEarly) {
      seeds.push({ taskId: completion.taskId, newEnd: completion.actualEnd })
    }
  }

  if (seeds.length === 0) {
    return { success: true, versionNumber: null, tasksChanged: updatedCount }
  }

  const graph = await fetchProjectGraph(supabase, projectId)
  if (!graph.ok) {
    return { success: false, error: graph.error }
  }
  const originalState = graph.tasks

  const cascadeChanges = computeCascade(
    graph.tasks,
    graph.edges,
    seeds,
    'pull',
    today,
  )

  const version = await createPropagationVersion(
    supabase,
    projectId,
    `Early finish: ${seeds.length} target(s)`,
  )
  if (!version.ok) {
    return { success: false, error: version.error }
  }

  const { revisions, finalByTask } = buildRevisions(
    cascadeChanges,
    originalState,
    version.id,
    'early_finish',
    null,
    null,
  )

  for (const [taskId, change] of finalByTask) {
    const { error: updateError } = await supabase
      .from('schedule_tasks')
      .update({
        current_planned_start: change.newStart,
        current_planned_end: change.newEnd,
      })
      .eq('id', taskId)

    if (updateError) {
      return { success: false, error: updateError.message }
    }
  }

  if (revisions.length > 0) {
    const { error: revisionsError } = await supabase
      .from('schedule_task_revisions')
      .insert(revisions)
    if (revisionsError) {
      return { success: false, error: revisionsError.message }
    }
  }

  const snapshot = await snapshotVersion(supabase, projectId, version.id)
  if (!snapshot.ok) {
    return { success: false, error: snapshot.error }
  }

  return {
    success: true,
    versionNumber: version.versionNumber,
    tasksChanged: updatedCount + finalByTask.size,
  }
}
