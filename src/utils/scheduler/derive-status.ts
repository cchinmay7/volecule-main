/**
 * Schedule Propagation Engine — see the "Schedule Propagation Engine"
 * spec §12, "Status: derive it, don't store it" (open question (e),
 * resolved in favor of collapsing).
 *
 * schedule_tasks.status is stored as only 'pending' | 'done' | 'retired'
 * — the three states that correspond to an actual one-time write event
 * (import, confirmed-done, re-import drop). Everything else a task can
 * display as — in progress, delayed to start, delayed to finish — is
 * computed here, at read time, from dates and actual_start. Nothing is
 * ever written to represent "this is currently delayed," so nothing can
 * go stale the way a stored label could if a future code path moved a
 * task's dates without also updating the word describing it.
 *
 * Used everywhere a task's effective status matters: the scheduler page,
 * the ingestion route's eligibility checks, and the test console — all
 * through this one function, so the three can't drift apart the way
 * spec §11 item 1 found the old predecessor-only in_progress check had.
 */

export type DerivedStatus =
  | 'pending'
  | 'in_progress'
  | 'delayed_start'
  | 'delayed_end'
  | 'done'
  | 'retired'

export type DerivableTask = {
  status: 'pending' | 'done' | 'retired'
  currentPlannedStart: string
  currentPlannedEnd: string
  actualStart: string | null
}

/** A task with no predecessors is vacuously eligible (spec §12 open
 * question (d) — root tasks get the identical treatment, no exemption). */
export function arePredecessorsDone(predecessorStatuses: string[]): boolean {
  return predecessorStatuses.every((status) => status === 'done')
}

/**
 * Derives a task's full display status from its stored fields, its
 * predecessors' done-ness, and today's date (in the project's own
 * timezone — callers must resolve that before calling this).
 *
 * Decision table (spec §12):
 *   status is done/retired                                   -> done/retired
 *   any predecessor not done                                  -> pending
 *   predecessors done, actual_start null, today < start        -> pending
 *   predecessors done, actual_start null, today >= start        -> delayed_start
 *   actual_start set, today <= current_planned_end              -> in_progress
 *   actual_start set, today > current_planned_end                -> delayed_end
 */
export function deriveTaskStatus(
  task: DerivableTask,
  allPredecessorsDone: boolean,
  today: string,
): DerivedStatus {
  if (task.status === 'done' || task.status === 'retired') {
    return task.status
  }

  if (task.actualStart !== null) {
    return today > task.currentPlannedEnd ? 'delayed_end' : 'in_progress'
  }

  if (!allPredecessorsDone) {
    return 'pending'
  }

  return today >= task.currentPlannedStart ? 'delayed_start' : 'pending'
}
