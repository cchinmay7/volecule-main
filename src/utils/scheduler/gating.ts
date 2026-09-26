import type { SupabaseClient } from '@supabase/supabase-js'
import { arePredecessorsDone } from '@/utils/scheduler/derive-status'

export type IngestionFlagType =
  | 'start_confirmed_before_predecessor_done'
  | 'target_ticked_before_confirmed_start'
  | 'optimistic_start_reverted'

export type PredecessorInfo = {
  status: string
  currentPlannedEnd: string
}

/**
 * The loosened half of the same-day boundary fix, pulled out as a pure,
 * directly-testable predicate: every predecessor must be either genuinely
 * `done`, or merely due — its own `current_planned_end` on or before
 * `asOfDate` — even if it's been overdue for several days and nobody's
 * marked it done. `arePredecessorsDone` (derive-status.ts) is the strict
 * version this loosens; this function assumes strict has already failed
 * (it's always true whenever strict is), so callers check strict first
 * and only fall back to this if needed.
 */
export function arePredecessorsClearedOrDue(
  predecessors: PredecessorInfo[],
  asOfDate: string,
): boolean {
  return predecessors.every(
    (p) => p.status === 'done' || p.currentPlannedEnd <= asOfDate,
  )
}

/**
 * A task that isn't genuinely in progress (predecessors not all done)
 * must never be touched by form-driven processing, in either direction —
 * regardless of what the submitted payload says about it (spec §11 item
 * 1d). Ticking a blocked task's box shouldn't mark it done, and a blocked
 * task whose own deadline has passed shouldn't be flagged delayed
 * independently of the predecessor that's actually still open; its dates
 * only ever move via cascade from that predecessor.
 *
 * A task with no predecessors is always eligible — there's nothing to
 * gate it on.
 *
 * `treatDueAsClearedAsOf`, when given, ALSO computes a second, looser set
 * (`looseEligibleTaskIds`) for the *start* side only — never use it for
 * the evening completion check, which stays strict via
 * `eligibleTaskIds`. In the loose set, a predecessor that isn't done yet
 * still counts as cleared if its own `current_planned_end` is on or
 * before this date — the zero-gap same-day boundary (a child can start
 * the same calendar day its parent is due to finish), extended to cover
 * a predecessor that's overdue by several days too, on the theory that
 * an engineer confirming a child started is implicitly asserting the
 * predecessor handoff has happened, however many days it's actually been
 * running late. `eligibleTaskIds` is always the strict set, computed
 * regardless of whether this is passed — callers that only want the
 * strict rule can ignore `looseEligibleTaskIds` entirely.
 *
 * A *ticked* confirmation is safe to accept against the loose set —
 * accepting a bet the engineer is making. An *unticked* task must never
 * be independently pushed except through the strict set (delayed-start
 * pushes still require the predecessor to genuinely be done) — otherwise
 * a task loosely-but-not-strictly eligible could get pushed twice for
 * the same lateness: once directly here, and again via cascade once its
 * predecessor's own push actually happens. The evening completion push
 * (applyDelayedEnds) is responsible for reverting any start the loose
 * set let through, if the predecessor turns out to not actually be done
 * that evening.
 *
 * Shared by the log-driven ingestion route, the manual-override action,
 * and (once built) the manual refresh sweep, so the gate is defined
 * once, not per trigger.
 */
export async function filterEligibleCandidates(
  supabase: SupabaseClient,
  candidateTaskIds: string[],
  treatDueAsClearedAsOf?: string,
): Promise<
  | {
      ok: true
      eligibleTaskIds: Set<string>
      looseEligibleTaskIds: Set<string>
    }
  | { ok: false; error: string }
> {
  if (candidateTaskIds.length === 0) {
    return {
      ok: true,
      eligibleTaskIds: new Set(),
      looseEligibleTaskIds: new Set(),
    }
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
    const allCandidates = new Set(candidateTaskIds)
    return {
      ok: true,
      eligibleTaskIds: allCandidates,
      looseEligibleTaskIds: allCandidates,
    }
  }

  const predecessorIds = Array.from(
    new Set(edges.map((e) => e.depends_on_task_id)),
  )

  const { data: predecessorRows, error: predecessorsError } = await supabase
    .from('schedule_tasks')
    .select('id, status, current_planned_end')
    .in('id', predecessorIds)

  if (predecessorsError) {
    return { ok: false, error: predecessorsError.message }
  }

  const predecessorById = new Map(
    (
      (predecessorRows ?? []) as {
        id: string
        status: string
        current_planned_end: string
      }[]
    ).map((row) => [row.id, row]),
  )

  const predecessorsByTaskId = new Map<string, string[]>()
  for (const edge of edges) {
    const list = predecessorsByTaskId.get(edge.task_id) ?? []
    list.push(edge.depends_on_task_id)
    predecessorsByTaskId.set(edge.task_id, list)
  }

  const eligibleTaskIds = new Set<string>()
  const looseEligibleTaskIds = new Set<string>()
  for (const taskId of candidateTaskIds) {
    const predecessorIdsForTask = predecessorsByTaskId.get(taskId)
    if (!predecessorIdsForTask || predecessorIdsForTask.length === 0) {
      eligibleTaskIds.add(taskId)
      looseEligibleTaskIds.add(taskId)
      continue
    }
    const predecessorStatuses = predecessorIdsForTask.map(
      (id) => predecessorById.get(id)?.status ?? '',
    )
    if (arePredecessorsDone(predecessorStatuses)) {
      eligibleTaskIds.add(taskId)
      looseEligibleTaskIds.add(taskId)
      continue
    }
    if (treatDueAsClearedAsOf) {
      // A predecessor row that didn't come back at all (shouldn't happen,
      // but not impossible) must never read as "cleared" just because an
      // absent current_planned_end sorts before any real date string —
      // bail out of the whole loose check for this task rather than risk
      // that.
      const predecessorRowsForTask = predecessorIdsForTask.map((id) =>
        predecessorById.get(id),
      )
      if (predecessorRowsForTask.every((p) => p !== undefined)) {
        const predecessorInfos: PredecessorInfo[] = predecessorRowsForTask.map(
          (p) => ({
            status: p.status,
            currentPlannedEnd: p.current_planned_end,
          }),
        )
        if (
          arePredecessorsClearedOrDue(predecessorInfos, treatDueAsClearedAsOf)
        ) {
          looseEligibleTaskIds.add(taskId)
        }
      }
    }
  }

  return { ok: true, eligibleTaskIds, looseEligibleTaskIds }
}

/** Records ingestion-time anomalies that were rejected or reverted rather
 * than left standing (spec §12 open questions (b)/finding 4, and the
 * same-day boundary fix's optimistic-start reversion) — a console.error
 * for real-time visibility, plus a permanent schedule_ingestion_flags row
 * so it isn't just a log line that scrolls away. Never allowed to fail
 * the caller's own request. Lives here (not in ingest-submission.ts,
 * where it originated) because propagate.ts needs to call it too, and
 * propagate.ts is what ingest-submission.ts itself imports from — this
 * is the shared module both already depend on, so importing back from
 * ingest-submission.ts would be circular. */
export async function recordIngestionFlags(
  supabase: SupabaseClient,
  projectId: string,
  projectLogId: string | null,
  flagType: IngestionFlagType,
  items: { taskId: string; detail: string }[],
) {
  if (items.length === 0) return

  console.error(`[ingestion] flagged: ${flagType}`, items)

  const { error } = await supabase.from('schedule_ingestion_flags').insert(
    items.map((item) => ({
      project_id: projectId,
      task_id: item.taskId,
      project_log_id: projectLogId,
      flag_type: flagType,
      detail: item.detail,
    })),
  )

  if (error) {
    console.error('[ingestion] failed to record ingestion flag', error)
  }
}
