export type ParsedTaskRow = {
  externalRef: string
  name: string
  vendorTeam: string | null
  durationDays: number
  plannedStart: string
  plannedEnd: string
  predecessorRefs: string[]
  sourceRow: number
  /** Set only when the sheet carries an optional STATUS @ ENTRY /
   * DATE OF COMPLETION column pair and this row's status reads
   * "Completed" — the ongoing-project onboarding case (open flag B).
   * Null for a normal Schedule Zero import, or a row whose status is
   * anything else ("In Progress", "Not Started", blank) — those import
   * exactly like today, as a fresh pending task the algorithm confirms
   * the start of later. */
  actualEnd: string | null
}

export type ParseIssue = {
  row: number
  message: string
}

export type ParseResult =
  | { ok: true; tasks: ParsedTaskRow[]; warnings: ParseIssue[] }
  | { ok: false; errors: ParseIssue[] }
