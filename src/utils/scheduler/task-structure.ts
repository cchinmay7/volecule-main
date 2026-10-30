import type { SupabaseClient } from '@supabase/supabase-js'
import { isIsoDate } from '@/utils/dates'
import { recordEdit } from '@/utils/logs/edit-history'
import { startsWithOwnCode } from '@/utils/scheduler/corrections'
import {
  addDaysIso,
  applyStructureChange,
  type PropagationOutcome,
} from '@/utils/scheduler/propagate'
import {
  MAX_TASK_DURATION_DAYS,
  MAX_TASK_NAME_LENGTH,
  normalizeTaskId,
} from '@/utils/scheduler/task-id'

/**
 * Operator changes to the shape of the schedule, from the Updates page:
 * adding a task (wired in under whichever parents and above whichever
 * children the operator picks) and deleting one. Edges are plain
 * finish-to-start links, the same as the spreadsheet's PRED. column, and
 * after either change the plan is re-settled with applyStructureChange so
 * no task is left starting before something it now depends on ends.
 */

export type StructureResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

const HISTORY_WARNING =
  ' (History entry not saved: run db/updates_v3.sql in Supabase.)'

type GraphTask = {
  id: string
  external_ref: string | null
  name: string
  status: 'pending' | 'done' | 'retired'
  current_planned_end: string
  actual_start: string | null
}

type Edge = { task_id: string; depends_on_task_id: string }

function label(task: Pick<GraphTask, 'external_ref' | 'name'>): string {
  return task.external_ref ?? task.name
}

function moved(outcome: Extract<PropagationOutcome, { success: true }>) {
  const n = outcome.tasksChanged
  return n > 0
    ? ` ${n} later task${n === 1 ? '' : 's'} moved to follow it.`
    : ''
}

async function loadGraph(
  supabase: SupabaseClient,
  projectId: string,
): Promise<
  | { ok: true; tasks: Map<string, GraphTask>; edges: Edge[] }
  | { ok: false; error: string }
> {
  const { data: taskRows, error: tasksError } = await supabase
    .from('schedule_tasks')
    .select('id, external_ref, name, status, current_planned_end, actual_start')
    .eq('project_id', projectId)
  if (tasksError) return { ok: false, error: tasksError.message }

  const tasks = new Map(
    ((taskRows ?? []) as GraphTask[]).map((task) => [task.id, task]),
  )
  if (tasks.size === 0) return { ok: true, tasks, edges: [] }

  const { data: edgeRows, error: edgesError } = await supabase
    .from('schedule_task_dependencies')
    .select('task_id, depends_on_task_id')
    .in('task_id', Array.from(tasks.keys()))
  if (edgesError) return { ok: false, error: edgesError.message }

  return { ok: true, tasks, edges: (edgeRows ?? []) as Edge[] }
}

/** Every task downstream of `fromIds` (following dependents), themselves
 * included. */
function downstreamOf(fromIds: string[], edges: Edge[]): Set<string> {
  const dependents = new Map<string, string[]>()
  for (const edge of edges) {
    const list = dependents.get(edge.depends_on_task_id) ?? []
    list.push(edge.task_id)
    dependents.set(edge.depends_on_task_id, list)
  }
  const seen = new Set(fromIds)
  const queue = [...fromIds]
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const next of dependents.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

/**
 * Adds a task by hand. `parentIds` must finish before it starts and
 * `childIds` start after it ends; any number of either is fine, and either
 * list may be empty. With no start given it starts when its last parent
 * ends (or today, with no parents). A start earlier than a parent's end is
 * kept as entered, the same as a spreadsheet date that overlaps.
 *
 * Children must not have started yet: a task already under way can't
 * suddenly be waiting on one that hasn't begun. Children that would now
 * start before the new task ends are pushed later, and so is everything
 * after them.
 */
export async function addTask({
  supabase,
  projectId,
  code,
  name,
  start,
  durationDays,
  parentIds,
  childIds,
  userId,
  note,
  today,
}: {
  supabase: SupabaseClient
  projectId: string
  code: string
  name: string
  start: string | null
  durationDays: number
  parentIds: string[]
  childIds: string[]
  userId: string
  note: string | null
  today: string
}): Promise<StructureResult> {
  const ref = normalizeTaskId(code)
  if (!ref || ref !== code.replace(/[\s-]/g, '').toUpperCase()) {
    return {
      ok: false,
      error: 'Enter a task code like W99 or 120: letters, then a number.',
    }
  }

  const taskName = name.replace(/\s+/g, ' ').trim()
  if (taskName === '') return { ok: false, error: 'Enter a name for the task.' }
  if (taskName.length > MAX_TASK_NAME_LENGTH) {
    return {
      ok: false,
      error: `Keep the name to ${MAX_TASK_NAME_LENGTH} characters or fewer.`,
    }
  }
  if (startsWithOwnCode(taskName, ref)) {
    return {
      ok: false,
      error: `Leave the code out of the name. ${ref} is shown in front of it automatically.`,
    }
  }

  if (
    !Number.isInteger(durationDays) ||
    durationDays < 1 ||
    durationDays > MAX_TASK_DURATION_DAYS
  ) {
    return {
      ok: false,
      error: `Duration must be a whole number of days, 1 to ${MAX_TASK_DURATION_DAYS}.`,
    }
  }
  if (start !== null && !isIsoDate(start)) {
    return { ok: false, error: 'Enter a valid start date.' }
  }

  const parents = Array.from(new Set(parentIds))
  const children = Array.from(new Set(childIds))
  const both = parents.filter((id) => children.includes(id))

  const graph = await loadGraph(supabase, projectId)
  if (!graph.ok) return graph
  const { tasks, edges } = graph

  if (both.length > 0) {
    const names = both.map((id) => {
      const task = tasks.get(id)
      return task ? label(task) : id
    })
    return {
      ok: false,
      error: `${names.join(', ')} can't come both before and after the new task.`,
    }
  }

  for (const id of [...parents, ...children]) {
    const task = tasks.get(id)
    if (!task || task.status === 'retired') {
      return { ok: false, error: 'A selected task is no longer in the plan.' }
    }
  }

  const startedChildren = children
    .map((id) => tasks.get(id) as GraphTask)
    .filter((task) => task.status === 'done' || task.actual_start !== null)
  if (startedChildren.length > 0) {
    return {
      ok: false,
      error: `${startedChildren.map(label).join(', ')} has already started, so it can't wait on a new task.`,
    }
  }

  // parent -> new -> child closes a loop if a child already leads to a parent.
  const afterChildren = downstreamOf(children, edges)
  const looping = parents.filter((id) => afterChildren.has(id))
  if (looping.length > 0) {
    return {
      ok: false,
      error: `That would make a loop: ${looping.map((id) => label(tasks.get(id) as GraphTask)).join(', ')} already comes after a selected child.`,
    }
  }

  const clash = Array.from(tasks.values()).find(
    (task) => task.external_ref === ref,
  )
  if (clash) {
    return {
      ok: false,
      error:
        clash.status === 'retired'
          ? `${ref} belongs to a retired task. Pick another code.`
          : `${ref} is already used by "${clash.name}". Pick another code.`,
    }
  }

  const parentEnd = parents
    .map((id) => (tasks.get(id) as GraphTask).current_planned_end)
    .reduce<string | null>((max, end) => (max && max > end ? max : end), null)
  const taskStart = start ?? parentEnd ?? today
  const taskEnd = addDaysIso(taskStart, durationDays)

  const { data: inserted, error: insertError } = await supabase
    .from('schedule_tasks')
    .insert({
      project_id: projectId,
      external_ref: ref,
      name: taskName,
      vendor_team: null,
      original_planned_start: taskStart,
      original_planned_end: taskEnd,
      current_planned_start: taskStart,
      current_planned_end: taskEnd,
      duration_days: durationDays,
      status: 'pending',
    })
    .select('id')
    .single()
  if (insertError || !inserted) {
    return { ok: false, error: insertError?.message ?? 'Could not add task.' }
  }
  const taskId = inserted.id as string

  const newEdges = [
    ...parents.map((id) => ({
      task_id: taskId,
      depends_on_task_id: id,
      lag_days: 0,
    })),
    ...children.map((id) => ({
      task_id: id,
      depends_on_task_id: taskId,
      lag_days: 0,
    })),
  ]
  if (newEdges.length > 0) {
    const { error: edgeError } = await supabase
      .from('schedule_task_dependencies')
      .insert(newEdges)
    if (edgeError) {
      return {
        ok: false,
        error: `${ref} was added, but linking it failed: ${edgeError.message}`,
      }
    }
  }

  const outcome = await applyStructureChange({
    supabase,
    projectId,
    seedTaskIds: [taskId],
    versionLabel: `Added ${ref}`,
    note,
    today,
  })
  if (!outcome.success) {
    return {
      ok: false,
      error: `${ref} was added, but the tasks after it could not be updated: ${outcome.error}`,
    }
  }

  const recorded = await recordEdit(supabase, {
    projectId,
    logId: null,
    userId,
    kind: 'task_added',
    details: {
      task_id: taskId,
      code: ref,
      name: taskName,
      parents: parents.map((id) => label(tasks.get(id) as GraphTask)),
      children: children.map((id) => label(tasks.get(id) as GraphTask)),
    },
    note,
  })

  const overlap =
    start !== null && parentEnd !== null && start < parentEnd
      ? ` Note: it starts before a parent ends (${parentEnd}).`
      : ''

  return {
    ok: true,
    message: `Added ${ref}, ${taskStart} to ${taskEnd}.${moved(outcome)}${overlap}${recorded ? '' : HISTORY_WARNING}`,
  }
}

/**
 * Deletes a task outright, with its links. With `reconnect`, each task that
 * came right after it is linked to each task that came right before it, so
 * the order around the gap is kept; without it they simply lose that link.
 * Later tasks are pushed if a new link requires it, never pulled earlier.
 *
 * Any task can be deleted, done or not. Its date history goes with it.
 */
export async function deleteTask({
  supabase,
  projectId,
  taskId,
  reconnect,
  userId,
  note,
  today,
}: {
  supabase: SupabaseClient
  projectId: string
  taskId: string
  reconnect: boolean
  userId: string
  note: string | null
  today: string
}): Promise<StructureResult> {
  const graph = await loadGraph(supabase, projectId)
  if (!graph.ok) return graph
  const { tasks, edges } = graph

  const task = tasks.get(taskId)
  if (!task || task.status === 'retired') {
    return { ok: false, error: 'Task not found in this project.' }
  }

  const parents = edges
    .filter((edge) => edge.task_id === taskId)
    .map((edge) => edge.depends_on_task_id)
  const children = edges
    .filter((edge) => edge.depends_on_task_id === taskId)
    .map((edge) => edge.task_id)

  const { error: edgesError } = await supabase
    .from('schedule_task_dependencies')
    .delete()
    .in('task_id', [taskId])
  if (edgesError) return { ok: false, error: edgesError.message }
  const { error: childEdgesError } = await supabase
    .from('schedule_task_dependencies')
    .delete()
    .in('depends_on_task_id', [taskId])
  if (childEdgesError) return { ok: false, error: childEdgesError.message }

  const { error: deleteError } = await supabase
    .from('schedule_tasks')
    .delete()
    .eq('id', taskId)
    .eq('project_id', projectId)
  if (deleteError) return { ok: false, error: deleteError.message }

  let bridged = 0
  if (reconnect && parents.length > 0 && children.length > 0) {
    const existing = new Set(
      edges.map((edge) => `${edge.task_id}>${edge.depends_on_task_id}`),
    )
    const bridges = children.flatMap((child) =>
      parents
        .filter((parent) => !existing.has(`${child}>${parent}`))
        .map((parent) => ({
          task_id: child,
          depends_on_task_id: parent,
          lag_days: 0,
        })),
    )
    if (bridges.length > 0) {
      const { error: bridgeError } = await supabase
        .from('schedule_task_dependencies')
        .insert(bridges)
      if (bridgeError) {
        return {
          ok: false,
          error: `${label(task)} was deleted, but relinking the tasks around it failed: ${bridgeError.message}`,
        }
      }
    }
    bridged = bridges.length
  }

  const outcome = await applyStructureChange({
    supabase,
    projectId,
    seedTaskIds: reconnect ? parents : [],
    versionLabel: `Deleted ${label(task)}`,
    note,
    today,
  })
  if (!outcome.success) {
    return {
      ok: false,
      error: `${label(task)} was deleted, but the plan could not be updated: ${outcome.error}`,
    }
  }

  const recorded = await recordEdit(supabase, {
    projectId,
    logId: null,
    userId,
    kind: 'task_deleted',
    details: {
      task_id: taskId,
      code: task.external_ref,
      name: task.name,
      reconnected: reconnect,
      parents: parents.map((id) => {
        const parent = tasks.get(id)
        return parent ? label(parent) : id
      }),
      children: children.map((id) => {
        const child = tasks.get(id)
        return child ? label(child) : id
      }),
    },
    note,
  })

  const links =
    bridged > 0
      ? ` Linked ${bridged} pair${bridged === 1 ? '' : 's'} of tasks around the gap.`
      : ''
  return {
    ok: true,
    message: `Deleted ${label(task)}.${links}${moved(outcome)}${recorded ? '' : HISTORY_WARNING}`,
  }
}
