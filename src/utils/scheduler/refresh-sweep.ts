import type { SupabaseClient } from '@supabase/supabase-js'
import {
  applyDelayedEnds,
  applyDelayedStarts,
  type PropagationOutcome,
} from '@/utils/scheduler/propagate'
import { filterEligibleCandidates } from '@/utils/scheduler/gating'

export type RefreshSweepResult =
  | { ok: true; delayedStartCount: number; delayedEndCount: number }
  | { ok: false; error: string }

type CandidateRow = {
  id: string
  actual_start: string | null
  current_planned_start: string
  current_planned_end: string
}

/**
 * Manual refresh sweep (spec §13 item C / §12 open question (h)) — forces
 * the same delayed-start / delayed-end checks a real morning or evening
 * form submission would run, for a project where no payload arrived at
 * all over some stretch of days (e.g. the site was closed over a weekend
 * and nobody submitted a form). Not a parallel or backup mechanism to the
 * log-driven triggers in ingest-submission.ts — a substitute only for the
 * specific days a real submission never showed up; on a day a payload
 * does arrive, that payload's own check already covers everything the
 * sweep would have found.
 *
 * Two independent checks, sharing schedule_tasks as the source of truth:
 *   - delayed-start: actual_start is null, current_planned_start has
 *     already arrived (<= asOfDate).
 *   - delayed-end: actual_start is set, current_planned_end has already
 *     arrived.
 * Both are gated through the STRICT eligibility set only — nothing is
 * being ticked here, so the loosened same-day/overdue rule (which exists
 * specifically to accept a confirmed tick as a bet worth taking) never
 * applies; an unticked task is never independently pushed except through
 * strict eligibility (see gating.ts). A task that started on the
 * strength of that loosened rule but whose predecessor still isn't done
 * is left untouched by the delayed-end check here, exactly like a real
 * evening check already does — it's only reverted once the predecessor's
 * own push actually runs, inside applyDelayedEnds.
 *
 * Both pushes reconcile the full gap in one step via propagate.ts's
 * catchupPushDays, not a flat +1 — a sweep run after several skipped days
 * needs to catch the whole gap up at once, the same way a real check does
 * now too.
 *
 * Not tied to any project_logs row — there's no real submission behind
 * it, so trigger_project_log_id is null throughout, same as a manual
 * override.
 */
export async function runRefreshSweep({
  supabase,
  projectId,
  asOfDate,
}: {
  supabase: SupabaseClient
  projectId: string
  asOfDate: string
}): Promise<RefreshSweepResult> {
  const { data: candidateRows, error: candidatesError } = await supabase
    .from('schedule_tasks')
    .select('id, actual_start, current_planned_start, current_planned_end')
    .eq('project_id', projectId)
    .eq('status', 'pending')

  if (candidatesError) {
    return { ok: false, error: candidatesError.message }
  }

  const candidates = (candidateRows ?? []) as CandidateRow[]

  const delayedStartCandidateIds = candidates
    .filter(
      (t) => t.actual_start === null && t.current_planned_start <= asOfDate,
    )
    .map((t) => t.id)
  const delayedEndCandidateIds = candidates
    .filter((t) => t.actual_start !== null && t.current_planned_end <= asOfDate)
    .map((t) => t.id)

  const allCandidateIds = Array.from(
    new Set([...delayedStartCandidateIds, ...delayedEndCandidateIds]),
  )

  const gate = await filterEligibleCandidates(supabase, allCandidateIds)
  if (!gate.ok) {
    return { ok: false, error: gate.error }
  }

  const delayedStartIds = delayedStartCandidateIds.filter((id) =>
    gate.eligibleTaskIds.has(id),
  )
  const delayedEndIds = delayedEndCandidateIds.filter((id) =>
    gate.eligibleTaskIds.has(id),
  )

  if (delayedStartIds.length > 0) {
    const outcome: PropagationOutcome = await applyDelayedStarts({
      supabase,
      projectId,
      delayedStartTaskIds: delayedStartIds,
      triggerProjectLogId: null,
      missReason: null,
      asOfDate,
    })
    if (!outcome.success) {
      return { ok: false, error: outcome.error }
    }
  }

  if (delayedEndIds.length > 0) {
    const outcome: PropagationOutcome = await applyDelayedEnds({
      supabase,
      projectId,
      delayedTaskIds: delayedEndIds,
      triggerProjectLogId: null,
      missReason: null,
      asOfDate,
    })
    if (!outcome.success) {
      return { ok: false, error: outcome.error }
    }
  }

  return {
    ok: true,
    delayedStartCount: delayedStartIds.length,
    delayedEndCount: delayedEndIds.length,
  }
}
