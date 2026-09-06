import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A task that isn't genuinely in progress (predecessors not all done)
 * must never be touched by form-driven processing, in either direction —
 * regardless of what the submitted payload says about it (spec §11 item
 * 1d). Ticking a blocked task's box shouldn't mark it done, and a blocked
 * task whose own deadline has passed shouldn't be flagged missed
 * independently of the predecessor that's actually still open; its dates
 * only ever move via cascade from that predecessor.
 *
 * A task with no predecessors is always eligible — there's nothing to
 * gate it on.
 *
 * Shared by the log-driven ingestion route and (once built) the manual
 * refresh sweep, so the gate is defined once, not per trigger.
 */
export async function filterEligibleCandidates(
  supabase: SupabaseClient,
  candidateTaskIds: string[],
): Promise<
  { ok: true; eligibleTaskIds: Set<string> } | { ok: false; error: string }
> {
  if (candidateTaskIds.length === 0) {
    return { ok: true, eligibleTaskIds: new Set() }
  }

  const { data: edgeRows, error: edgesError } = await supabase
    .from('schedule_task_dependencies')
    .select('task_id, depends_on_task_id')
    .in('task_id', candidateTaskIds)

  if (edgesError) {
    return { ok: false, error: edgesError.message }
  }

  const edges = (edgeRows ?? []) as {
    task_id: string
    depends_on_task_id: string
  }[]

  if (edges.length === 0) {
    // None of the candidates have any predecessors at all.
    return { ok: true, eligibleTaskIds: new Set(candidateTaskIds) }
  }

  const predecessorIds = Array.from(
    new Set(edges.map((e) => e.depends_on_task_id)),
  )

  const { data: predecessorRows, error: predecessorsError } = await supabase
    .from('schedule_tasks')
    .select('id, status')
    .in('id', predecessorIds)

  if (predecessorsError) {
    return { ok: false, error: predecessorsError.message }
  }

  const predecessorStatusById = new Map(
    ((predecessorRows ?? []) as { id: string; status: string }[]).map((row) => [
      row.id,
      row.status,
    ]),
  )

  const predecessorsByTaskId = new Map<string, string[]>()
  for (const edge of edges) {
    const list = predecessorsByTaskId.get(edge.task_id) ?? []
    list.push(edge.depends_on_task_id)
    predecessorsByTaskId.set(edge.task_id, list)
  }

  const eligibleTaskIds = new Set<string>()
  for (const taskId of candidateTaskIds) {
    const predecessorIdsForTask = predecessorsByTaskId.get(taskId)
    if (!predecessorIdsForTask || predecessorIdsForTask.length === 0) {
      eligibleTaskIds.add(taskId)
      continue
    }
    const allDone = predecessorIdsForTask.every(
      (id) => predecessorStatusById.get(id) === 'done',
    )
    if (allDone) eligibleTaskIds.add(taskId)
  }

  return { ok: true, eligibleTaskIds }
}
