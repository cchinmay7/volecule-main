import { describe, expect, it } from 'vitest'
import {
  arePredecessorsDone,
  deriveTaskStatus,
  type DerivableTask,
} from './derive-status'

describe('arePredecessorsDone', () => {
  it('is vacuously true for a root task with no predecessors', () => {
    expect(arePredecessorsDone([])).toBe(true)
  })

  it('is true only when every predecessor is done', () => {
    expect(arePredecessorsDone(['done'])).toBe(true)
    expect(arePredecessorsDone(['done', 'done'])).toBe(true)
    expect(arePredecessorsDone(['done', 'pending'])).toBe(false)
    expect(arePredecessorsDone(['retired'])).toBe(false)
  })
})

describe('deriveTaskStatus', () => {
  const today = '2026-09-10'

  function task(overrides: Partial<DerivableTask> = {}): DerivableTask {
    return {
      status: 'pending',
      currentPlannedStart: '2026-09-05',
      currentPlannedEnd: '2026-09-09',
      actualStart: null,
      ...overrides,
    }
  }

  it('passes through done and retired regardless of dates', () => {
    expect(deriveTaskStatus(task({ status: 'done' }), true, today)).toBe('done')
    expect(deriveTaskStatus(task({ status: 'retired' }), false, today)).toBe(
      'retired',
    )
  })

  it('reads pending when a predecessor is not done, even if the window has opened', () => {
    expect(deriveTaskStatus(task(), false, today)).toBe('pending')
  })

  it('reads pending when predecessors are done but the start date has not arrived yet', () => {
    expect(
      deriveTaskStatus(
        task({ currentPlannedStart: '2026-09-15' }),
        true,
        today,
      ),
    ).toBe('pending')
  })

  it('reads delayed_start once the recommended start has passed with no confirmation', () => {
    expect(deriveTaskStatus(task(), true, today)).toBe('delayed_start')
  })

  it('reads delayed_start on the exact start day too (>=, not >)', () => {
    expect(
      deriveTaskStatus(task({ currentPlannedStart: today }), true, today),
    ).toBe('delayed_start')
  })

  it('reads in_progress once actual_start is set and the deadline has not passed', () => {
    expect(
      deriveTaskStatus(
        task({ actualStart: '2026-09-08', currentPlannedEnd: '2026-09-13' }),
        true,
        today,
      ),
    ).toBe('in_progress')
  })

  it('reads in_progress on the exact deadline day too (<=, not <)', () => {
    expect(
      deriveTaskStatus(
        task({ actualStart: '2026-09-08', currentPlannedEnd: today }),
        true,
        today,
      ),
    ).toBe('in_progress')
  })

  it('reads delayed_end once actual_start is set and the deadline has passed', () => {
    expect(
      deriveTaskStatus(
        task({ actualStart: '2026-09-01', currentPlannedEnd: '2026-09-09' }),
        true,
        today,
      ),
    ).toBe('delayed_end')
  })

  it('ignores predecessor state once actual_start is set — already started overrides it', () => {
    expect(
      deriveTaskStatus(
        task({ actualStart: '2026-09-01', currentPlannedEnd: '2026-09-09' }),
        false,
        today,
      ),
    ).toBe('delayed_end')
  })
})
