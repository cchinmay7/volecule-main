import { describe, expect, it } from 'vitest'
import {
  addDaysIso,
  computeCascade,
  type CascadeChange,
  type DependencyEdge,
  type TaskState,
} from './propagate'

describe('addDaysIso', () => {
  it('adds and subtracts days across month/year boundaries', () => {
    expect(addDaysIso('2026-09-10', 1)).toBe('2026-09-11')
    expect(addDaysIso('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysIso('2026-09-10', -1)).toBe('2026-09-09')
  })
})

describe('computeCascade — pull mode (early finish, diamond dependency)', () => {
  // D depends on BOTH P1 and P2 (finish-to-start, no lag). Dates are
  // [start, end) — an EXCLUSIVE end, matching the source Excel's own
  // convention (FINISH = START + DUR) and its zero-day gap between a
  // predecessor's end and its successor's start (spec §11 item 1c).
  //   P1: 2026-09-01 -> 2026-09-06 (duration 5)
  //   P2: 2026-09-01 -> 2026-09-11 (duration 10)
  //   D:  required_start = max(P1.end, P2.end) = 2026-09-11, duration 5
  const edges: DependencyEdge[] = [
    { taskId: 'D', dependsOnTaskId: 'P1', lagDays: 0 },
    { taskId: 'D', dependsOnTaskId: 'P2', lagDays: 0 },
  ]

  function baseTasks(): Map<string, TaskState> {
    return new Map<string, TaskState>([
      [
        'P1',
        {
          currentStart: '2026-09-01',
          currentEnd: '2026-09-06',
          durationDays: 5,
        },
      ],
      [
        'P2',
        {
          currentStart: '2026-09-01',
          currentEnd: '2026-09-11',
          durationDays: 10,
        },
      ],
      [
        'D',
        {
          currentStart: '2026-09-11',
          currentEnd: '2026-09-16',
          durationDays: 5,
        },
      ],
    ])
  }

  const today = '2026-09-01'

  it('does NOT move D when only the faster predecessor (P1) finishes early', () => {
    const changes = computeCascade(
      baseTasks(),
      edges,
      [{ taskId: 'P1', newEnd: '2026-09-04' }],
      'pull',
      today,
    )

    // D is still gated by P2 (current end 2026-09-11 -> required
    // 2026-09-11, unchanged), so nothing about D should appear in the
    // result.
    expect(changes.find((c) => c.taskId === 'D')).toBeUndefined()
    expect(changes).toEqual([])
  })

  it('moves D once the slower predecessor (P2) also finishes early enough', () => {
    // Simulate the state after P1's early finish has already been
    // persisted (P1 now ends 2026-09-04), then P2 also finishes early.
    const tasksAfterP1 = baseTasks()
    tasksAfterP1.set('P1', {
      ...(tasksAfterP1.get('P1') as TaskState),
      currentEnd: '2026-09-04',
    })

    const changes = computeCascade(
      tasksAfterP1,
      edges,
      [{ taskId: 'P2', newEnd: '2026-09-07' }],
      'pull',
      today,
    )

    // earliest_start = max(P1.end, P2.end) = max(09-04, 09-07) = 09-07
    // 09-07 < D.currentStart (09-11), and today (09-01) < 09-11, so D
    // moves.
    const dChange = changes.find((c) => c.taskId === 'D')
    expect(dChange).toEqual({
      taskId: 'D',
      newStart: '2026-09-07',
      newEnd: '2026-09-12', // duration_days = 5 -> start + 5 (exclusive end)
    })
  })

  it('does not pull D forward once today has reached its current start', () => {
    // Same setup, but "today" has caught up to D's own scheduled start —
    // it's too late to pull it forward even though the math would allow it.
    const changes = computeCascade(
      baseTasks(),
      edges,
      [
        { taskId: 'P1', newEnd: '2026-09-04' },
        { taskId: 'P2', newEnd: '2026-09-07' },
      ],
      'pull',
      '2026-09-11', // == D.currentStart
    )

    expect(changes.find((c) => c.taskId === 'D')).toBeUndefined()
  })
})

describe('computeCascade — push mode (missed target, chain with slack)', () => {
  // A -> B -> C, finish-to-start, no lag. B has slack before A's slip
  // actually forces it to move (B's plan already starts well after A's
  // earliest possible finish); C has zero slack relative to B.
  const edges: DependencyEdge[] = [
    { taskId: 'B', dependsOnTaskId: 'A', lagDays: 0 },
    { taskId: 'C', dependsOnTaskId: 'B', lagDays: 0 },
  ]

  function makeLiveState(): Map<string, TaskState> {
    return new Map<string, TaskState>([
      [
        'A',
        {
          currentStart: '2026-09-01',
          currentEnd: '2026-09-06',
          durationDays: 5,
        },
      ],
      [
        'B',
        {
          currentStart: '2026-09-10',
          currentEnd: '2026-09-15',
          durationDays: 5,
        },
      ],
      [
        'C',
        {
          currentStart: '2026-09-15',
          currentEnd: '2026-09-20',
          durationDays: 5,
        },
      ],
    ])
  }

  it("absorbs repeated 1-day slips of A silently until the slip exceeds B's slack, then cascades", () => {
    const liveState = makeLiveState()
    const allChanges: CascadeChange[][] = []

    // Four 1-day slips of A: required_start for B climbs 09-07, 09-08,
    // 09-09, 09-10 — never exceeding B's current start (09-10) until the
    // fifth slip pushes it to 09-11.
    for (let i = 0; i < 4; i++) {
      const a = liveState.get('A') as TaskState
      const newEnd = addDaysIso(a.currentEnd, 1)
      const changes = computeCascade(
        liveState,
        edges,
        [{ taskId: 'A', newEnd }],
        'push',
        '',
      )
      allChanges.push(changes)
      liveState.set('A', { ...a, currentEnd: newEnd })
      // No downstream change yet, so B/C stay exactly as they were.
      expect(changes).toEqual([])
    }

    expect(liveState.get('A')?.currentEnd).toBe('2026-09-10')
    expect(liveState.get('B')).toEqual({
      currentStart: '2026-09-10',
      currentEnd: '2026-09-15',
      durationDays: 5,
    })

    // Fifth slip: A now ends 2026-09-11, required_start for B =
    // 2026-09-11, which finally exceeds B's current start (2026-09-10)
    // -> B moves, and that in turn pushes C (which had zero slack
    // relative to B).
    const a = liveState.get('A') as TaskState
    const finalNewEnd = addDaysIso(a.currentEnd, 1)
    const finalChanges = computeCascade(
      liveState,
      edges,
      [{ taskId: 'A', newEnd: finalNewEnd }],
      'push',
      '',
    )

    expect(finalNewEnd).toBe('2026-09-11')
    expect(finalChanges).toEqual([
      { taskId: 'B', newStart: '2026-09-11', newEnd: '2026-09-16' },
      { taskId: 'C', newStart: '2026-09-16', newEnd: '2026-09-21' },
    ])
  })

  it('never moves a dependent earlier, and a dead branch is not enqueued further', () => {
    const tasks = makeLiveState()
    // A slip that doesn't clear B's slack must not touch C either, since
    // B (the dead branch) is never enqueued.
    const changes = computeCascade(
      tasks,
      edges,
      [{ taskId: 'A', newEnd: '2026-09-07' }],
      'push',
      '',
    )
    expect(changes).toEqual([])
  })
})
