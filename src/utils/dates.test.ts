import { describe, expect, it } from 'vitest'
import { formatDateTime } from './dates'

describe('formatDateTime', () => {
  it('renders a UTC timestamp in IST', () => {
    expect(formatDateTime('2026-10-11T20:15:00Z')).toBe(
      '12 Oct 2026, 1:45 am IST',
    )
  })
})
