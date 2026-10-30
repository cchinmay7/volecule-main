/**
 * Extracts and normalizes a Task ID from a label, tolerant of an optional
 * letter prefix and inconsistent spacing/dashes — see the "Schedule
 * Propagation Engine" spec, form wiring: real Task IDs seen in the wild
 * include both letter-prefixed (W41) and plain-digit (38) forms.
 *
 * "W41 — Column Steel Work" -> "W41"
 * "38 — 3rd Floor Columns: Reinforcement" -> "38"
 * "w 41: Column Steel Work" -> "W41"
 * "Column Steel Work" -> null (no ID found)
 */
export function normalizeTaskId(raw: string): string | null {
  const match = raw.match(/^\s*([A-Za-z]*[\s-]?\d+)/)
  if (!match) return null
  return match[1].replace(/[\s-]/g, '').toUpperCase()
}

/** Longest task name the Updates page accepts when renaming a task. */
export const MAX_TASK_NAME_LENGTH = 200

/** Longest a task added by hand on the Updates page may run. */
export const MAX_TASK_DURATION_DAYS = 3650

const NO_PREDECESSOR_TOKENS = new Set(['', '-', '—', '–', 'none', 'n/a'])

/**
 * Parses a Predecessors cell (e.g. "W40", "W38, W40", or "—" for none)
 * into a list of normalized Task IDs.
 */
export function parsePredecessorList(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[,;]/)
    .map((token) => token.trim())
    .filter((token) => !NO_PREDECESSOR_TOKENS.has(token.toLowerCase()))
    .map((token) => normalizeTaskId(token))
    .filter((id): id is string => id !== null)
}
