import type { SupabaseClient } from '@supabase/supabase-js'
import { recordIngestionFlags } from '@/utils/scheduler/gating'

/**
 * Schedule Propagation Engine — see db/scheduler_v1.sql and the "Schedule
 * Propagation Engine" spec §06.
 *
 * This module assumes the caller has ALREADY decided which tasks are
 * delayed or completed (e.g. from a site log or an overdue sweep). Its
 * job is purely to compute and persist the cascading date changes that
 * follow from that decision — never to decide what's late.
 *
 * Structure mirrors parse-excel.ts / graph.ts: `computeCascade` below is a
 * pure, dependency-free relaxation over the DAG (unit-tested in
 * propagate.test.ts with no database involved); `applyDelayedEnds`,
 * `applyConfirmedStarts`, `applyDelayedStarts`, and `applyTaskCompletions`
 * are thin I/O wrappers that fetch plain objects from Supabase, call the
 * pure function, and write the results back.
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

/** Whole days from `from` to `to` (positive if `to` is later), using the
 * same UTC arithmetic as addDaysIso so the two are exact inverses. */
export function diffDaysIso(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const fromUtc = Date.UTC(fy, fm - 1, fd)
  const toUtc = Date.UTC(ty, tm - 1, td)
  return Math.round((toUtc - fromUtc) / 86_400_000)
}

/**
 * How far a single still-not-done check happening "as of" `asOfDate`
 * should push `fromDate` (a task's current_planned_start or _end) forward
 * by. In the steady state — a check runs every day, so `fromDate` already
 * equals `asOfDate` — this is exactly 1, matching the flat +1-per-check
 * push this generalizes. When checks have been skipped (a weekend with no
 * form submitted, or a manual refresh sweep run days later), `fromDate`
 * lags behind `asOfDate` and the whole gap is caught up in one step,
 * mirroring how applyTaskCompletions already reconciles a late completion
 * in one step rather than one row per skipped day — a single check, run
 * however late, should land on the same date a real check would have
 * every intervening day. Clamped to a minimum of 1: a check that finds a
 * task still not done always pushes forward, never backward, even if
 * called defensively against a date that isn't actually behind.
 */
export function catchupPushDays(fromDate: string, asOfDate: string): number {
  return Math.max(1, diffDaysIso(fromDate, asOfDate) + 1)
}

/**
 * Breadth-first relaxation over the dependency DAG. Given a set of tasks
 * whose `current_planned_end` just changed (`seeds`), propagates the
 * effect to every dependent, transitively, and returns the list of
 * further changes required — the seeds' own change is assumed already
 * applied by the caller and is NOT included in the result.
 *
 * Dates are treated as [currentStart, currentEnd) — an EXCLUSIVE end,
 * matching the source Excel's own convention (FINISH = START + DUR, no
 * -1) and its zero-day gap between a predecessor's FINISH and its
 * successor's START (see spec §11 item 1c). `end` is not "the last
 * working day"; it's the day work stops and, absent a lag, the day the
 * next task can start.
 *
 * Two distinct relaxation rules, chosen by `mode`:
 *
 * - 'push' (a task slipped / was delayed): for each dependent D of a task
 *   T that just moved, `required_start = T.currentEnd + lag`. D only
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
 *   over EVERY predecessor P of D of `P.currentEnd + lag(P->D)` — not
 *   just the edge that triggered this pass. D moves only if it hasn't
 *   reached its own scheduled start yet (`today < D.currentStart`) and
 *   the recomputed `earliest_start` is actually earlier than its current
 *   start. This is why a diamond dependency gated by a slower
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
        const requiredStart = addDaysIso(predecessor.currentEnd, edge.lagDays)
        if (!(requiredStart > dependent.currentStart)) continue
        newStart = requiredStart
      } else {
        const predecessorEdges = predecessorsOf.get(dependentId) ?? []
        let earliestStart: string | null = null
        for (const predEdge of predecessorEdges) {
          const predecessor = state.get(predEdge.dependsOnTaskId)
          if (!predecessor) continue
          const candidate = addDaysIso(predecessor.currentEnd, predEdge.lagDays)
          if (earliestStart === null || candidate > earliestStart) {
            earliestStart = candidate
          }
        }
        if (earliestStart === null) continue
        if (!(today < dependent.currentStart)) continue
        if (!(earliestStart < dependent.currentStart)) continue
        newStart = earliestStart
      }

      const newEnd = addDaysIso(newStart, dependent.durationDays)
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

/** The task state once `seeds` and the cascade they produced have been
 * applied — what a second pass (a pull after a push) should start from, so
 * it sees each predecessor's true end rather than the original one. */
function stateAfterCascade(
  tasks: Map<string, TaskState>,
  seeds: CascadeSeed[],
  changes: CascadeChange[],
): Map<string, TaskState> {
  const state = new Map(tasks)
  for (const seed of seeds) {
    const current = state.get(seed.taskId)
    if (current) {
      state.set(seed.taskId, { ...current, currentEnd: seed.newEnd })
    }
  }
  for (const change of changes) {
    state.set(change.taskId, {
      ...(state.get(change.taskId) as TaskState),
      currentStart: change.newStart,
      currentEnd: change.newEnd,
    })
  }
  return state
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

export type ChangeReason =
  | 'delayed_end'
  | 'delayed_start'
  | 'confirmed_start'
  | 'early_finish'
  | 'manual_override'
  | 'excel_reimport'

type RevisionInsert = {
  task_id: string
  schedule_version_id: string
  previous_start: string
  previous_end: string
  new_start: string
  new_end: string
  change_reason: ChangeReason
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
  changeReason: ChangeReason,
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

type TaskUpdate = {
  id: string
  values: Record<string, string | number | null>
}

const TASK_UPDATE_CONCURRENCY = 10

/** Applies per-row updates to schedule_tasks concurrently, a chunk at a
 * time. Each update targets a different row with different values, so
 * PostgREST has no bulk form for it — but awaiting them one by one made a
 * 49-task cascade take ~22s against a Supabase project in a far-away
 * region (one ~0.45s round trip per row), which left the Refresh button
 * hanging until the operator reloaded the page. Running a chunk in
 * parallel cuts that to a handful of round trips. Stops at the first
 * failed chunk, same as the sequential loops this replaces. */
async function updateTasksById(
  supabase: SupabaseClient,
  updates: TaskUpdate[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let i = 0; i < updates.length; i += TASK_UPDATE_CONCURRENCY) {
    const chunk = updates.slice(i, i + TASK_UPDATE_CONCURRENCY)
    const results = await Promise.all(
      chunk.map(({ id, values }) =>
        supabase.from('schedule_tasks').update(values).eq('id', id),
      ),
    )
    const failed = results.find((result) => result.error)
    if (failed?.error) {
      return { ok: false, error: failed.error.message }
    }
  }
  return { ok: true }
}

/**
 * The write tail shared by every push-style propagation (delayed end,
 * confirmed start, delayed start): apply the root tasks' own updates, cut
 * the schedule version, then write the cascaded dependents' new dates and
 * the revision rows together, then snapshot. `rootRevisions` carries the
 * roots' own revision rows without a version id — it isn't known until
 * the version is cut here.
 *
 * Root updates land before the cascade updates on purpose: a root that is
 * also downstream of another root in the same batch is written by both,
 * and the cascade's dates must win, as they did when this was sequential.
 */
async function persistPropagation({
  supabase,
  projectId,
  versionLabel,
  rootUpdates,
  rootRevisions,
  cascadeChanges,
  originalState,
  changeReason,
  triggerProjectLogId,
  missReason,
}: {
  supabase: SupabaseClient
  projectId: string
  versionLabel: string
  rootUpdates: TaskUpdate[]
  rootRevisions: Omit<RevisionInsert, 'schedule_version_id'>[]
  cascadeChanges: CascadeChange[]
  originalState: Map<string, TaskState>
  changeReason: ChangeReason
  triggerProjectLogId: string | null
  missReason: string | null
}): Promise<
  | { ok: true; versionNumber: number; cascadedCount: number }
  | { ok: false; error: string }
> {
  const rootUpdateResult = await updateTasksById(supabase, rootUpdates)
  if (!rootUpdateResult.ok) return rootUpdateResult

  const version = await createPropagationVersion(
    supabase,
    projectId,
    versionLabel,
  )
  if (!version.ok) return { ok: false, error: version.error }

  const { revisions: cascadeRevisions, finalByTask } = buildRevisions(
    cascadeChanges,
    originalState,
    version.id,
    changeReason,
    triggerProjectLogId,
    missReason,
  )

  const allRevisions: RevisionInsert[] = [
    ...rootRevisions.map((revision) => ({
      ...revision,
      schedule_version_id: version.id,
    })),
    ...cascadeRevisions,
  ]

  const cascadeUpdates: TaskUpdate[] = Array.from(
    finalByTask,
    ([id, change]) => ({
      id,
      values: {
        current_planned_start: change.newStart,
        current_planned_end: change.newEnd,
      },
    }),
  )

  const [cascadeResult, revisionsResult] = await Promise.all([
    updateTasksById(supabase, cascadeUpdates),
    allRevisions.length > 0
      ? supabase.from('schedule_task_revisions').insert(allRevisions)
      : Promise.resolve({ error: null }),
  ])
  if (!cascadeResult.ok) return cascadeResult
  if (revisionsResult.error) {
    return { ok: false, error: revisionsResult.error.message }
  }

  const snapshot = await snapshotVersion(supabase, projectId, version.id)
  if (!snapshot.ok) return { ok: false, error: snapshot.error }

  return {
    ok: true,
    versionNumber: version.versionNumber,
    cascadedCount: finalByTask.size,
  }
}

/**
 * Marks one or more already-started tasks delayed-to-finish and cascades
 * the resulting slip forward through the dependency graph.
 * `delayedTaskIds` should be batched into a single call for everything
 * confirmed delayed in one run (a log with several unticked boxes, or
 * one sweep finding several overdue tasks) — that produces one combined
 * schedule version rather than one per task.
 *
 * `current_planned_start` is never touched here — only a task that has
 * genuinely started (`actual_start` set) is eligible for this check at
 * all (spec §12, "Delayed: Start and Delayed: End" — mutual exclusivity),
 * so there's no ambiguity to resolve about when it began. `duration_days`
 * grows by however many days the end moves (catchupPushDays — 1 in the
 * steady state, more if checks were skipped), so it always stays equal to
 * `current_planned_end - current_planned_start` for a task that's
 * actually running long (spec §12, "Duration is dynamic").
 */
export async function applyDelayedEnds({
  supabase,
  projectId,
  delayedTaskIds,
  triggerProjectLogId,
  missReason,
  asOfDate,
}: {
  supabase: SupabaseClient
  projectId: string
  delayedTaskIds: string[]
  triggerProjectLogId: string | null
  missReason: string | null
  /** The date this check is being run as of — the log's own date for a
   * real submission, or the operator-chosen date for a manual refresh
   * sweep. Drives catchupPushDays, so a check run after a gap reconciles
   * the whole gap in one step instead of under-pushing by the usual 1. */
  asOfDate: string
}): Promise<PropagationOutcome> {
  if (delayedTaskIds.length === 0) {
    return { success: true, versionNumber: null, tasksChanged: 0 }
  }

  const { data: rootRows, error: rootFetchError } = await supabase
    .from('schedule_tasks')
    .select('id, current_planned_start, current_planned_end, duration_days')
    .in('id', delayedTaskIds)

  if (rootFetchError) {
    return { success: false, error: rootFetchError.message }
  }

  const rootTasks = (rootRows ?? []) as ScheduleTaskRow[]
  if (rootTasks.length === 0) {
    return { success: true, versionNumber: null, tasksChanged: 0 }
  }

  // A root being pushed here is, by definition, still 'pending' — not
  // done. The only way a direct dependent of it could already have
  // actual_start set is the loosened same-day/overdue morning-start
  // eligibility (gating.ts's looseEligibleTaskIds): normal confirmation
  // requires the predecessor already done, which this one isn't. That
  // bet just turned out wrong, so it's reverted — actual_start cleared
  // back to null — rather than left standing on a predecessor that
  // didn't actually finish. The date push itself needs no extra seeding:
  // computeCascade's push relaxation below already walks from these
  // roots to every direct dependent purely by current_planned_end/start,
  // with no awareness of actual_start either way, so a reverted child's
  // dates land in exactly the right place for free.
  const rootIds = rootTasks.map((r) => r.id)
  const { data: dependentEdgeRows, error: dependentEdgesError } = await supabase
    .from('schedule_task_dependencies')
    .select('task_id, depends_on_task_id')
    .in('depends_on_task_id', rootIds)

  if (dependentEdgesError) {
    return { success: false, error: dependentEdgesError.message }
  }

  const dependentIds = Array.from(
    new Set((dependentEdgeRows ?? []).map((e) => e.task_id as string)),
  )

  const revertTaskIds: string[] = []
  if (dependentIds.length > 0) {
    const { data: dependentRows, error: dependentRowsError } = await supabase
      .from('schedule_tasks')
      .select('id, actual_start')
      .in('id', dependentIds)
      .eq('status', 'pending')
      .not('actual_start', 'is', null)

    if (dependentRowsError) {
      return { success: false, error: dependentRowsError.message }
    }

    for (const row of dependentRows ?? []) {
      revertTaskIds.push(row.id as string)
    }
  }

  if (revertTaskIds.length > 0) {
    const { error: revertError } = await supabase
      .from('schedule_tasks')
      .update({ actual_start: null })
      .in('id', revertTaskIds)

    if (revertError) {
      return { success: false, error: revertError.message }
    }

    await recordIngestionFlags(
      supabase,
      projectId,
      triggerProjectLogId,
      'optimistic_start_reverted',
      revertTaskIds.map((taskId) => ({
        taskId,
        detail:
          'Confirmed started on the assumption its predecessor would finish that day — reverted, since the predecessor was marked not done this check.',
      })),
    )
  }

  const graph = await fetchProjectGraph(supabase, projectId)
  if (!graph.ok) {
    return { success: false, error: graph.error }
  }

  // Snapshot pre-change state before any writes, for revision "previous"
  // values — the root tasks' rows are included here with their
  // not-yet-updated current_planned_end.
  const originalState = graph.tasks

  const rootUpdates: TaskUpdate[] = []
  const rootRevisions: Omit<RevisionInsert, 'schedule_version_id'>[] = []
  const seeds: CascadeSeed[] = []
  for (const root of rootTasks) {
    const pushDays = catchupPushDays(root.current_planned_end, asOfDate)
    const newEnd = addDaysIso(root.current_planned_end, pushDays)

    rootUpdates.push({
      id: root.id,
      values: {
        current_planned_end: newEnd,
        duration_days: root.duration_days + pushDays,
      },
    })
    rootRevisions.push({
      task_id: root.id,
      previous_start: root.current_planned_start,
      previous_end: root.current_planned_end,
      new_start: root.current_planned_start,
      new_end: newEnd,
      change_reason: 'delayed_end',
      trigger_project_log_id: triggerProjectLogId,
      miss_reason: missReason,
    })
    seeds.push({ taskId: root.id, newEnd })
  }

  const cascadeChanges = computeCascade(
    graph.tasks,
    graph.edges,
    seeds,
    'push',
    '', // today is unused in 'push' mode
  )

  const persisted = await persistPropagation({
    supabase,
    projectId,
    versionLabel: `Delayed: ${delayedTaskIds.length} target(s)`,
    rootUpdates,
    rootRevisions,
    cascadeChanges,
    originalState,
    changeReason: 'delayed_end',
    triggerProjectLogId,
    missReason,
  })
  if (!persisted.ok) {
    return { success: false, error: persisted.error }
  }

  return {
    success: true,
    versionNumber: persisted.versionNumber,
    tasksChanged: rootTasks.length + persisted.cascadedCount,
  }
}

/**
 * Marks one or more not-yet-started tasks confirmed-started — from the
 * morning form's dedicated start checklist, or the manual-override
 * fallback (spec §12 open question (j), which reuses this same function
 * with `changeReason: 'manual_override'` instead of the default). Writes
 * `actual_start`, recomputes `current_planned_end` as
 * `confirmedDate + duration_days`, and cascades the result through the
 * dependents. A start confirmed after its planned start ends later than
 * planned and pushes them, exactly like applyDelayedEnds does. A start
 * confirmed on the day a refresh sweep had pushed the task to tomorrow
 * ends earlier than the pushed window, so what the sweep pushed behind it
 * is pulled back, but only where every other predecessor allows it.
 */
export async function applyConfirmedStarts({
  supabase,
  projectId,
  confirmedTaskIds,
  confirmedDate,
  triggerProjectLogId,
  changeReason = 'confirmed_start',
}: {
  supabase: SupabaseClient
  projectId: string
  confirmedTaskIds: string[]
  confirmedDate: string
  triggerProjectLogId: string | null
  changeReason?: ChangeReason
}): Promise<PropagationOutcome> {
  if (confirmedTaskIds.length === 0) {
    return { success: true, versionNumber: null, tasksChanged: 0 }
  }

  const { data: rootRows, error: rootFetchError } = await supabase
    .from('schedule_tasks')
    .select('id, current_planned_start, current_planned_end, duration_days')
    .in('id', confirmedTaskIds)

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
  const originalState = graph.tasks

  const rootUpdates: TaskUpdate[] = []
  const rootRevisions: Omit<RevisionInsert, 'schedule_version_id'>[] = []
  const lateSeeds: CascadeSeed[] = []
  const earlySeeds: CascadeSeed[] = []
  for (const root of rootTasks) {
    const newEnd = addDaysIso(confirmedDate, root.duration_days)

    rootUpdates.push({
      id: root.id,
      values: {
        current_planned_start: confirmedDate,
        current_planned_end: newEnd,
        actual_start: confirmedDate,
      },
    })
    rootRevisions.push({
      task_id: root.id,
      previous_start: root.current_planned_start,
      previous_end: root.current_planned_end,
      new_start: confirmedDate,
      new_end: newEnd,
      change_reason: changeReason,
      trigger_project_log_id: triggerProjectLogId,
      miss_reason: null,
    })
    // A start confirmed late ends later than planned. A start confirmed on
    // the very day a refresh had pushed the task to tomorrow ends earlier
    // than the pushed window, and what the refresh pushed behind it has to
    // come back with it.
    if (newEnd > root.current_planned_end) {
      lateSeeds.push({ taskId: root.id, newEnd })
    } else if (newEnd < root.current_planned_end) {
      earlySeeds.push({ taskId: root.id, newEnd })
    }
  }

  // Push first, then pull against the post-push state, as completions do.
  const pushChanges =
    lateSeeds.length > 0
      ? computeCascade(graph.tasks, graph.edges, lateSeeds, 'push', '')
      : []
  const pullChanges =
    earlySeeds.length > 0
      ? computeCascade(
          stateAfterCascade(graph.tasks, lateSeeds, pushChanges),
          graph.edges,
          earlySeeds,
          'pull',
          confirmedDate,
        )
      : []
  // A task touched by both passes (a diamond gated by one late and one early
  // root) takes the pull result: it was computed against the pushed state.
  const cascadeChanges = [...pushChanges, ...pullChanges]

  const persisted = await persistPropagation({
    supabase,
    projectId,
    versionLabel: `Confirmed start: ${confirmedTaskIds.length} task(s)`,
    rootUpdates,
    rootRevisions,
    cascadeChanges,
    originalState,
    changeReason,
    triggerProjectLogId,
    missReason: null,
  })
  if (!persisted.ok) {
    return { success: false, error: persisted.error }
  }

  return {
    success: true,
    versionNumber: persisted.versionNumber,
    tasksChanged: rootTasks.length + persisted.cascadedCount,
  }
}

/**
 * Pushes one or more not-yet-started tasks' whole window — start AND end
 * together — forward: the start-checklist equivalent of applyDelayedEnds,
 * for a task whose recommended start is due but wasn't ticked as started
 * this check. Both move by the same catchupPushDays amount (1 in the
 * steady state, more if checks were skipped, e.g. a weekend gap or a
 * manual refresh sweep run days later) — `duration_days` is untouched
 * either way, since the task hasn't begun, so there's nothing to widen
 * yet, only a date to slide later (spec §12, "Duration is dynamic" —
 * contrast with the End-side push, which widens the window because the
 * task has genuinely started and is now running long).
 */
export async function applyDelayedStarts({
  supabase,
  projectId,
  delayedStartTaskIds,
  triggerProjectLogId,
  missReason,
  asOfDate,
}: {
  supabase: SupabaseClient
  projectId: string
  delayedStartTaskIds: string[]
  triggerProjectLogId: string | null
  missReason: string | null
  /** Same role as in applyDelayedEnds — the date this check is run as of,
   * driving catchupPushDays so a gap is caught up in one step. */
  asOfDate: string
}): Promise<PropagationOutcome> {
  if (delayedStartTaskIds.length === 0) {
    return { success: true, versionNumber: null, tasksChanged: 0 }
  }

  const { data: rootRows, error: rootFetchError } = await supabase
    .from('schedule_tasks')
    .select('id, current_planned_start, current_planned_end, duration_days')
    .in('id', delayedStartTaskIds)

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
  const originalState = graph.tasks

  const rootUpdates: TaskUpdate[] = []
  const rootRevisions: Omit<RevisionInsert, 'schedule_version_id'>[] = []
  const seeds: CascadeSeed[] = []
  for (const root of rootTasks) {
    const pushDays = catchupPushDays(root.current_planned_start, asOfDate)
    const newStart = addDaysIso(root.current_planned_start, pushDays)
    const newEnd = addDaysIso(root.current_planned_end, pushDays)

    rootUpdates.push({
      id: root.id,
      values: {
        current_planned_start: newStart,
        current_planned_end: newEnd,
      },
    })
    rootRevisions.push({
      task_id: root.id,
      previous_start: root.current_planned_start,
      previous_end: root.current_planned_end,
      new_start: newStart,
      new_end: newEnd,
      change_reason: 'delayed_start',
      trigger_project_log_id: triggerProjectLogId,
      miss_reason: missReason,
    })
    seeds.push({ taskId: root.id, newEnd })
  }

  const cascadeChanges = computeCascade(
    graph.tasks,
    graph.edges,
    seeds,
    'push',
    '', // today is unused in 'push' mode
  )

  const persisted = await persistPropagation({
    supabase,
    projectId,
    versionLabel: `Delayed start: ${delayedStartTaskIds.length} task(s)`,
    rootUpdates,
    rootRevisions,
    cascadeChanges,
    originalState,
    changeReason: 'delayed_start',
    triggerProjectLogId,
    missReason,
  })
  if (!persisted.ok) {
    return { success: false, error: persisted.error }
  }

  return {
    success: true,
    versionNumber: persisted.versionNumber,
    tasksChanged: rootTasks.length + persisted.cascadedCount,
  }
}

/**
 * Records one or more task completions. Every completion always updates
 * that task's status to 'done' and stamps `actual_end`, regardless of
 * timing.
 *
 * A completion is reconciled against the plan in whichever direction
 * reality actually differs from it — not just early. Early was the only
 * direction originally handled here, on the assumption that a late
 * finish would already have been caught up to by daily applyDelayedEnds
 * pushes (§06 step 6). That assumption only holds if a check genuinely
 * ran every intervening day; with no refresh sweep built yet (§13 item
 * C) and no guarantee a form is submitted daily, a gap of skipped days
 * followed by an eventual late completion left current_planned_end
 * stuck wherever the last real check landed — silently under-reporting
 * the delay and never cascading it to dependents. Confirmed live: W2
 * completed on the 21st against a current_planned_end of the 18th
 * (a 3-day gap with no checks in between) read as neither early nor
 * exactly on time, so nothing happened — W3 never moved.
 *
 * Both directions now reconcile current_planned_end to the true
 * actual_end and cascade: early pulls dependents forward (pull mode —
 * see computeCascade's 'pull' mode for why a single edge isn't enough to
 * decide that safely) and shrinks duration_days; late pushes dependents
 * later (push mode, the same relaxation applyDelayedEnds uses) and
 * grows duration_days by the full caught-up gap in one step, rather than
 * the usual +1-per-check. Exactly on time still needs neither.
 *
 * A batch can contain both early and late completions for different
 * tasks. Late (push) is resolved first, then early (pull) against the
 * post-push state — a push only ever moves things later, so resolving
 * it first means a subsequent pull sees each predecessor's true,
 * already-caught-up end rather than a stale one that might make an
 * early pull look safe when it isn't. Both cascades are batched into one
 * schedule version. If every completion was exactly on time, tasks are
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

  const earlySeeds: CascadeSeed[] = []
  const lateSeeds: CascadeSeed[] = []
  const completionUpdates: TaskUpdate[] = []

  for (const completion of completions) {
    const row = rowsById.get(completion.taskId)
    if (!row) continue

    const isEarly = completion.actualEnd < row.current_planned_end
    const isLate = completion.actualEnd > row.current_planned_end
    const update: TaskUpdate['values'] = {
      status: 'done',
      actual_end: completion.actualEnd,
    }
    if (isEarly) {
      update.current_planned_end = completion.actualEnd
      const shrinkDays = diffDaysIso(
        completion.actualEnd,
        row.current_planned_end,
      )
      update.duration_days = row.duration_days - shrinkDays
    } else if (isLate) {
      update.current_planned_end = completion.actualEnd
      const growDays = diffDaysIso(
        row.current_planned_end,
        completion.actualEnd,
      )
      update.duration_days = row.duration_days + growDays
    }

    completionUpdates.push({ id: completion.taskId, values: update })

    if (isEarly) {
      earlySeeds.push({
        taskId: completion.taskId,
        newEnd: completion.actualEnd,
      })
    } else if (isLate) {
      lateSeeds.push({
        taskId: completion.taskId,
        newEnd: completion.actualEnd,
      })
    }
  }

  // Written before the graph is fetched below, as before — the graph then
  // reflects each completed task's reconciled end, which is what the
  // cascade's "previous" revision values are meant to start from.
  const completionResult = await updateTasksById(supabase, completionUpdates)
  if (!completionResult.ok) {
    return { success: false, error: completionResult.error }
  }
  const updatedCount = completionUpdates.length

  if (earlySeeds.length === 0 && lateSeeds.length === 0) {
    return { success: true, versionNumber: null, tasksChanged: updatedCount }
  }

  const graph = await fetchProjectGraph(supabase, projectId)
  if (!graph.ok) {
    return { success: false, error: graph.error }
  }
  const originalState = graph.tasks

  const pushChanges =
    lateSeeds.length > 0
      ? computeCascade(graph.tasks, graph.edges, lateSeeds, 'push', '')
      : []

  // Fold push results into a working copy before running pull, so pull
  // sees each predecessor's true, post-push state rather than the
  // original one.
  const stateAfterPush = stateAfterCascade(graph.tasks, lateSeeds, pushChanges)

  const pullChanges =
    earlySeeds.length > 0
      ? computeCascade(stateAfterPush, graph.edges, earlySeeds, 'pull', today)
      : []

  const version = await createPropagationVersion(
    supabase,
    projectId,
    `Completions: ${earlySeeds.length} early, ${lateSeeds.length} late (caught up)`,
  )
  if (!version.ok) {
    return { success: false, error: version.error }
  }

  const { revisions: pushRevisions, finalByTask: pushFinal } = buildRevisions(
    pushChanges,
    originalState,
    version.id,
    'delayed_end',
    null,
    null,
  )
  const { revisions: pullRevisions, finalByTask: pullFinal } = buildRevisions(
    pullChanges,
    stateAfterPush,
    version.id,
    'early_finish',
    null,
    null,
  )

  // Merge with pull last: if the same dependent was touched by both
  // passes (a diamond gated by one late and one early predecessor), the
  // pull result is the authoritative final one — it was computed against
  // the already-pushed state, not the stale pre-push one.
  const finalByTask = new Map([...pushFinal, ...pullFinal])
  const revisions = [...pushRevisions, ...pullRevisions]

  const cascadeUpdates: TaskUpdate[] = Array.from(
    finalByTask,
    ([id, change]) => ({
      id,
      values: {
        current_planned_start: change.newStart,
        current_planned_end: change.newEnd,
      },
    }),
  )

  const [cascadeResult, revisionsResult] = await Promise.all([
    updateTasksById(supabase, cascadeUpdates),
    revisions.length > 0
      ? supabase.from('schedule_task_revisions').insert(revisions)
      : Promise.resolve({ error: null }),
  ])
  if (!cascadeResult.ok) {
    return { success: false, error: cascadeResult.error }
  }
  if (revisionsResult.error) {
    return { success: false, error: revisionsResult.error.message }
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

export type ManualTaskValues = {
  status?: 'pending' | 'done'
  actual_start?: string | null
  actual_end?: string | null
  current_planned_start: string
  current_planned_end: string
  duration_days: number
}

/**
 * Applies an operator's correction to one task and cascades the effect on
 * its dependents — the primitive behind every action on the Updates page
 * (mark done, reopen, set or clear a start, edit dates). The caller decides
 * what the task's new state should be (and has validated it); this only
 * persists it and keeps the rest of the plan consistent:
 *
 *  - end moved later  -> dependents are pushed (same relaxation a delay uses)
 *  - end moved earlier -> dependents are pulled forward, but only where
 *    every predecessor allows it (same relaxation an early finish uses)
 *  - end unchanged    -> nothing downstream moves
 *
 * Everything lands in one new schedule version, with a 'manual_override'
 * revision per moved task so the audit trail says it was a human, and the
 * operator's note on the corrected task's own revision.
 */
export async function applyManualOverride({
  supabase,
  projectId,
  taskId,
  values,
  versionLabel,
  note,
  today,
}: {
  supabase: SupabaseClient
  projectId: string
  taskId: string
  values: ManualTaskValues
  versionLabel: string
  note: string | null
  today: string
}): Promise<PropagationOutcome> {
  const graph = await fetchProjectGraph(supabase, projectId)
  if (!graph.ok) {
    return { success: false, error: graph.error }
  }

  const original = graph.tasks.get(taskId)
  if (!original) {
    return { success: false, error: 'Task not found in this project.' }
  }

  const newEnd = values.current_planned_end
  const direction =
    newEnd > original.currentEnd
      ? 'push'
      : newEnd < original.currentEnd
        ? 'pull'
        : null

  const cascadeChanges = direction
    ? computeCascade(
        graph.tasks,
        graph.edges,
        [{ taskId, newEnd }],
        direction,
        today,
      )
    : []

  const persisted = await persistPropagation({
    supabase,
    projectId,
    versionLabel,
    rootUpdates: [{ id: taskId, values }],
    rootRevisions: [
      {
        task_id: taskId,
        previous_start: original.currentStart,
        previous_end: original.currentEnd,
        new_start: values.current_planned_start,
        new_end: values.current_planned_end,
        change_reason: 'manual_override',
        trigger_project_log_id: null,
        miss_reason: note,
      },
    ],
    cascadeChanges,
    originalState: graph.tasks,
    changeReason: 'manual_override',
    triggerProjectLogId: null,
    missReason: note,
  })
  if (!persisted.ok) {
    return { success: false, error: persisted.error }
  }

  return {
    success: true,
    versionNumber: persisted.versionNumber,
    tasksChanged: 1 + persisted.cascadedCount,
  }
}
