import { describe, expect, it } from 'vitest'
import { arePredecessorsClearedOrDue, type PredecessorInfo } from './gating'

describe('arePredecessorsClearedOrDue', () => {
  const today = '2026-09-25'

  it('is true when every predecessor is already done, regardless of dates', () => {
    const predecessors: PredecessorInfo[] = [
      { status: 'done', currentPlannedEnd: '2099-01-01' }, // date irrelevant once done
    ]
    expect(arePredecessorsClearedOrDue(predecessors, today)).toBe(true)
  })

  it('is true for a predecessor due exactly today (the zero-gap boundary case)', () => {
    const predecessors: PredecessorInfo[] = [
      { status: 'pending', currentPlannedEnd: today },
    ]
    expect(arePredecessorsClearedOrDue(predecessors, today)).toBe(true)
  })

  it('is true for a predecessor overdue by several days, still not done', () => {
    const predecessors: PredecessorInfo[] = [
      { status: 'pending', currentPlannedEnd: '2026-09-20' },
    ]
    expect(arePredecessorsClearedOrDue(predecessors, today)).toBe(true)
  })

  it('is false for a predecessor not yet due (deadline is in the future)', () => {
    const predecessors: PredecessorInfo[] = [
      { status: 'pending', currentPlannedEnd: '2026-09-26' },
    ]
    expect(arePredecessorsClearedOrDue(predecessors, today)).toBe(false)
  })

  it('requires every predecessor cleared or due, not just one (diamond dependency)', () => {
    const predecessors: PredecessorInfo[] = [
      { status: 'done', currentPlannedEnd: '2026-09-01' },
      { status: 'pending', currentPlannedEnd: '2026-09-26' }, // not due yet
    ]
    expect(arePredecessorsClearedOrDue(predecessors, today)).toBe(false)
  })

  it('is true when a diamond has one done and one merely due predecessor', () => {
    const predecessors: PredecessorInfo[] = [
      { status: 'done', currentPlannedEnd: '2026-09-01' },
      { status: 'pending', currentPlannedEnd: today },
    ]
    expect(arePredecessorsClearedOrDue(predecessors, today)).toBe(true)
  })

  it('is vacuously true for no predecessors at all', () => {
    expect(arePredecessorsClearedOrDue([], today)).toBe(true)
  })
})
