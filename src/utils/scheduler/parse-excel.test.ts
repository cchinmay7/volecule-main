import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { parseScheduleWorkbook } from './parse-excel'

const REAL_WORKBOOK_PATH = path.resolve(
  __dirname,
  '__fixtures__/scheduler-zero.xlsx',
)

const ONGOING_WORKBOOK_PATH = path.resolve(
  __dirname,
  '__fixtures__/scheduler-zero-ongoing.xlsx',
)

describe('parseScheduleWorkbook', () => {
  it('parses the real Scheduler Zero workbook', async () => {
    const buffer = readFileSync(REAL_WORKBOOK_PATH)
    const result = await parseScheduleWorkbook(buffer)

    if (!result.ok) {
      throw new Error(
        `Expected a successful parse, got errors: ${JSON.stringify(result.errors)}`,
      )
    }

    expect(result.tasks).toHaveLength(84)

    const w1 = result.tasks.find((t) => t.externalRef === 'W1')
    expect(w1).toBeTruthy()
    expect(w1?.predecessorRefs).toEqual([])
    expect(w1?.name).toBe('Excavation in Hard Rock up to 1.5 m (Footings)')
    expect(w1?.durationDays).toBe(7)
    expect(w1?.plannedStart).toBe('2026-04-27')
    expect(w1?.plannedEnd).toBe('2026-05-04')

    const w2 = result.tasks.find((t) => t.externalRef === 'W2')
    expect(w2?.predecessorRefs).toEqual(['W1'])

    const w84 = result.tasks.find((t) => t.externalRef === 'W84')
    expect(w84).toBeTruthy()
    expect(w84?.predecessorRefs).toEqual(['W83'])

    // Section headers and footer notes must not leak through as tasks.
    const bogus = result.tasks.find(
      (t) => t.name.includes('FOUNDATION') || t.name.includes('Baseline logic'),
    )
    expect(bogus).toBeUndefined()

    expect(result.warnings).toEqual([])

    // No STATUS @ ENTRY / DATE OF COMPLETION columns on this sheet — every
    // task must import as a normal fresh task, unaffected by open flag B.
    expect(result.tasks.every((t) => t.actualStart === null)).toBe(true)
    expect(result.tasks.every((t) => t.actualEnd === null)).toBe(true)
  })

  it('parses an ongoing-project workbook carrying STATUS @ ENTRY / DATE OF COMPLETION (open flag B)', async () => {
    const buffer = readFileSync(ONGOING_WORKBOOK_PATH)
    const result = await parseScheduleWorkbook(buffer)

    if (!result.ok) {
      throw new Error(
        `Expected a successful parse, got errors: ${JSON.stringify(result.errors)}`,
      )
    }

    expect(result.tasks).toHaveLength(84)

    // W1–W34 are "Completed" — actualStart assumed as their own planned
    // start, actualEnd a real DATE OF COMPLETION exactly matching their
    // own baseline FINISH in this fixture.
    const w1 = result.tasks.find((t) => t.externalRef === 'W1')
    expect(w1?.plannedStart).toBe('2026-04-27')
    expect(w1?.actualStart).toBe('2026-04-27')
    expect(w1?.plannedEnd).toBe('2026-05-04')
    expect(w1?.actualEnd).toBe('2026-05-04')

    const w34 = result.tasks.find((t) => t.externalRef === 'W34')
    expect(w34?.actualEnd).toBe('2026-09-12')

    // W35 is "In Progress" — assumed started on its own planned start
    // (no separate confirm-start needed), but not finished, so no
    // actualEnd.
    const w35 = result.tasks.find((t) => t.externalRef === 'W35')
    expect(w35?.plannedStart).toBe('2026-09-12')
    expect(w35?.actualStart).toBe('2026-09-12')
    expect(w35?.actualEnd).toBeNull()

    // W36 onward is "Not Started" — neither assumed, both null.
    const w36 = result.tasks.find((t) => t.externalRef === 'W36')
    expect(w36?.actualStart).toBeNull()
    expect(w36?.actualEnd).toBeNull()

    const completedCount = result.tasks.filter(
      (t) => t.actualEnd !== null,
    ).length
    expect(completedCount).toBe(34)

    const startedCount = result.tasks.filter(
      (t) => t.actualStart !== null,
    ).length
    expect(startedCount).toBe(35) // 34 Completed + 1 In Progress
  })
})
