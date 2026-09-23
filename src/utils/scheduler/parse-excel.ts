import ExcelJS from 'exceljs'
import type { ParseIssue, ParseResult, ParsedTaskRow } from './types'
import { detectCycle, findDateInconsistencies } from './graph'
import { normalizeTaskId, parsePredecessorList } from './task-id'

const HEADER_LABELS = {
  work: 'WORK',
  activity: 'ACTIVITY',
  predecessors: 'PRED.',
  duration: 'DUR',
  start: 'START',
  finish: 'FINISH',
  status: 'STATUS',
  completion: 'DATE OF COMPLETION',
} as const

const COMPLETED_STATUS_TEXT = 'COMPLETED'
const IN_PROGRESS_STATUS_TEXT = 'IN PROGRESS'

type ColumnMap = {
  work: number
  activity: number
  predecessors: number
  duration: number
  start: number
  finish: number
  /** Optional pair — only present on a sheet carrying ongoing-project
   * progress (open flag B). Either both are set or both are null; never
   * required for the header row to be recognized. */
  status: number | null
  completion: number | null
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'result' in value) {
    return String((value as { result: unknown }).result ?? '')
  }
  if (typeof value === 'object' && 'richText' in value) {
    return (value as { richText: { text: string }[] }).richText
      .map((r) => r.text)
      .join('')
  }
  return String(value).trim()
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)

function cellDate(cell: ExcelJS.Cell): string | null {
  let value: unknown = cell.value
  if (value && typeof value === 'object' && 'result' in value) {
    value = (value as { result: unknown }).result
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'number') {
    const date = new Date(EXCEL_EPOCH_MS + value * 86400000)
    return date.toISOString().slice(0, 10)
  }
  return null
}

function cellNumber(cell: ExcelJS.Cell): number | null {
  let value: unknown = cell.value
  if (value && typeof value === 'object' && 'result' in value) {
    value = (value as { result: unknown }).result
  }
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function findHeaderRow(
  sheet: ExcelJS.Worksheet,
): { rowNumber: number; columns: ColumnMap } | null {
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r)
    const columns: Partial<ColumnMap> = {}

    for (let c = 1; c <= sheet.columnCount; c += 1) {
      const text = cellText(row.getCell(c)).toUpperCase()
      if (text === HEADER_LABELS.work) columns.work = c
      else if (text === HEADER_LABELS.activity) columns.activity = c
      else if (text === HEADER_LABELS.predecessors) columns.predecessors = c
      else if (text.startsWith(HEADER_LABELS.duration)) columns.duration = c
      else if (text === HEADER_LABELS.start) columns.start = c
      else if (text === HEADER_LABELS.finish) columns.finish = c
      else if (text.startsWith(HEADER_LABELS.status)) columns.status = c
      else if (text === HEADER_LABELS.completion) columns.completion = c
    }

    if (
      columns.work &&
      columns.activity &&
      columns.predecessors &&
      columns.duration &&
      columns.start &&
      columns.finish
    ) {
      return {
        rowNumber: r,
        columns: {
          work: columns.work,
          activity: columns.activity,
          predecessors: columns.predecessors,
          duration: columns.duration,
          start: columns.start,
          finish: columns.finish,
          status: columns.status ?? null,
          completion: columns.completion ?? null,
        },
      }
    }
  }
  return null
}

export async function parseScheduleWorkbook(
  buffer: Buffer,
): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)

  const sheet = workbook.worksheets[0]
  if (!sheet) {
    return {
      ok: false,
      errors: [{ row: 0, message: 'The workbook has no sheets.' }],
    }
  }

  const header = findHeaderRow(sheet)
  if (!header) {
    return {
      ok: false,
      errors: [
        {
          row: 0,
          message:
            'Could not find the header row (expected columns WORK, ACTIVITY, PRED., DUR, START, FINISH).',
        },
      ],
    }
  }

  const errors: ParseIssue[] = []
  const tasks: ParsedTaskRow[] = []
  const seenRefs = new Set<string>()

  for (let r = header.rowNumber + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r)
    const durationCell = row.getCell(header.columns.duration)
    const startCell = row.getCell(header.columns.start)
    const finishCell = row.getCell(header.columns.finish)

    const durationText = cellText(durationCell)
    const startText = cellText(startCell)
    const finishText = cellText(finishCell)

    // Section headers and footer notes share column A with real tasks but
    // leave duration/start/finish empty — a real task always has all three.
    if (!durationText && !startText && !finishText) {
      continue
    }

    const workText = cellText(row.getCell(header.columns.work))
    const activityText = cellText(row.getCell(header.columns.activity))
    const predText = cellText(row.getCell(header.columns.predecessors))

    const externalRef = normalizeTaskId(workText)
    if (!externalRef) {
      errors.push({
        row: r,
        message: `Could not read a Task ID from "${workText}".`,
      })
      continue
    }

    if (!activityText) {
      errors.push({
        row: r,
        message: `Task ${externalRef} has no activity name.`,
      })
      continue
    }

    const durationDays = cellNumber(durationCell)
    if (durationDays === null || durationDays <= 0) {
      errors.push({
        row: r,
        message: `Task ${externalRef} has an invalid duration.`,
      })
      continue
    }

    const plannedStart = cellDate(startCell)
    const plannedEnd = cellDate(finishCell)
    if (!plannedStart || !plannedEnd) {
      errors.push({
        row: r,
        message: `Task ${externalRef} has an invalid start or finish date.`,
      })
      continue
    }
    if (plannedStart > plannedEnd) {
      errors.push({
        row: r,
        message: `Task ${externalRef} starts after it finishes.`,
      })
      continue
    }

    if (seenRefs.has(externalRef)) {
      errors.push({
        row: r,
        message: `Duplicate Task ID ${externalRef} in this file.`,
      })
      continue
    }
    seenRefs.add(externalRef)

    // Ongoing-project onboarding (open flag B): a task whose STATUS @
    // ENTRY reads "Completed" or "In Progress" is assumed to have
    // started exactly on schedule — actualStart is the task's own
    // plannedStart, since the sheet carries no independent actual-start
    // column (same "safer assumption" the propagation engine already
    // makes elsewhere for a task with no start signal, §06 step 2).
    // "Completed" additionally carries a real actual_end from DATE OF
    // COMPLETION. "Not Started", blank, or the STATUS column not
    // existing at all (an ordinary Schedule Zero sheet) import exactly
    // as before — both left null.
    let actualStart: string | null = null
    let actualEnd: string | null = null
    if (header.columns.status !== null) {
      const statusText = cellText(
        row.getCell(header.columns.status),
      ).toUpperCase()
      if (statusText === COMPLETED_STATUS_TEXT) {
        if (header.columns.completion === null) {
          errors.push({
            row: r,
            message: `Task ${externalRef} is marked Completed but this sheet has no DATE OF COMPLETION column.`,
          })
          continue
        }
        const completionDate = cellDate(row.getCell(header.columns.completion))
        if (!completionDate) {
          errors.push({
            row: r,
            message: `Task ${externalRef} is marked Completed but has no valid date of completion.`,
          })
          continue
        }
        if (completionDate < plannedStart) {
          errors.push({
            row: r,
            message: `Task ${externalRef}'s date of completion (${completionDate}) is before its own start (${plannedStart}).`,
          })
          continue
        }
        actualStart = plannedStart
        actualEnd = completionDate
      } else if (statusText === IN_PROGRESS_STATUS_TEXT) {
        actualStart = plannedStart
      }
    }

    tasks.push({
      externalRef,
      name: activityText,
      vendorTeam: null,
      durationDays,
      plannedStart,
      plannedEnd,
      predecessorRefs: parsePredecessorList(predText),
      sourceRow: r,
      actualStart,
      actualEnd,
    })
  }

  if (tasks.length === 0 && errors.length === 0) {
    errors.push({ row: 0, message: 'No task rows found below the header.' })
  }

  // Every predecessor reference must resolve to a Task ID in this same file.
  const refs = new Set(tasks.map((t) => t.externalRef))
  for (const task of tasks) {
    for (const predRef of task.predecessorRefs) {
      if (!refs.has(predRef)) {
        errors.push({
          row: task.sourceRow,
          message: `Task ${task.externalRef} depends on ${predRef}, which is not in this file.`,
        })
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  const cycle = detectCycle(tasks)
  if (cycle) {
    return {
      ok: false,
      errors: [
        { row: 0, message: `Circular dependency: ${cycle.join(' → ')}` },
      ],
    }
  }

  const warnings = findDateInconsistencies(tasks)

  return { ok: true, tasks, warnings }
}
