export type ParsedTaskRow = {
  externalRef: string
  name: string
  vendorTeam: string | null
  durationDays: number
  plannedStart: string
  plannedEnd: string
  predecessorRefs: string[]
  sourceRow: number
}

export type ParseIssue = {
  row: number
  message: string
}

export type ParseResult =
  | { ok: true; tasks: ParsedTaskRow[]; warnings: ParseIssue[] }
  | { ok: false; errors: ParseIssue[] }
