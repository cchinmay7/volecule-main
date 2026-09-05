import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { parseScheduleWorkbook } from './parse-excel'

const REAL_WORKBOOK_PATH = path.resolve(
  __dirname,
  '__fixtures__/scheduler-zero.xlsx',
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
  })
})
