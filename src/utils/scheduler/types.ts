export type ParsedTaskRow = {
  externalRef: string
  name: string
  vendorTeam: string | null
  durationDays: number
  plannedStart: string
  plannedEnd: string
  predecessorRefs: string[]
  sourceRow: number
  /** Set (to the task's own plannedStart — "started on time," no
   * independent actual-start signal exists in the sheet) whenever an
   * optional STATUS @ ENTRY column is present and reads "Completed" or
   * "In Progress" — the ongoing-project onboarding case (open flag B).
   * Null for a normal Schedule Zero import, or a row whose status is
   * "Not Started"/blank — those import exactly like today, as a fresh
   * unconfirmed pending task. */
  actualStart: string | null
  /** Set only when status reads "Completed", from the sheet's own
   * DATE OF COMPLETION column — the one case with a real, independent
   * date rather than an assumption. Null for every other status,
   * "In Progress" included: an in-progress task has genuinely started
   * but not finished, so there's no end to record yet. */
  actualEnd: string | null
}

export type ParseIssue = {
  row: number
  message: string
}

export type ParseResult =
  | { ok: true; tasks: ParsedTaskRow[]; warnings: ParseIssue[] }
  | { ok: false; errors: ParseIssue[] }
