import { describe, expect, it } from 'vitest'
import { createFakeSupabase, type Row } from '@/test/fake-supabase'
import {
  applyDelayedEnds,
  applyDelayedStarts,
  applyTaskCompletions,
} from './propagate'

const PROJECT_ID = 'project-1'

/** A straight chain T0 -> T1 -> ... -> T(n-1), each 2 days long, each
 * starting the day its predecessor ends (exclusive-end convention). */
function buildChain(length: number, firstActualStart: string | null) {
  const tasks: Row[] = []
  const edges: Row[] = []
  for (let i = 0; i < length; i++) {
    const start = new Date(Date.UTC(2026, 8, 1 + i * 2))
      .toISOString()
      .slice(0, 10)
    const end = new Date(Date.UTC(2026, 8, 3 + i * 2))
      .toISOString()
      .slice(0, 10)
    tasks.push({
      id: `T${i}`,
      project_id: PROJECT_ID,
      name: `Task ${i}`,
      vendor_team: null,
      status: 'pending',
      actual_start: i === 0 ? firstActualStart : null,
      current_planned_start: start,
      current_planned_end: end,
      duration_days: 2,
    })
    if (i > 0) {
      edges.push({
        task_id: `T${i}`,
        depends_on_task_id: `T${i - 1}`,
        lag_days: 0,
      })
    }
  }
  return { tasks, edges }
}

function dates(tables: Record<string, Row[]>, id: string) {
  const row = tables.schedule_tasks.find((r) => r.id === id) as Row
  return {
    start: row.current_planned_start,
    end: row.current_planned_end,
    duration: row.duration_days,
  }
}

describe('applyDelayedEnds (I/O wrapper)', () => {
  it('pushes the root and cascades +1 down the chain, writing concurrently', async () => {
    const { tasks, edges } = buildChain(10, '2026-09-01')
    const { supabase, tables, stats } = createFakeSupabase({
      schedule_tasks: tasks,
      schedule_task_dependencies: edges,
      schedule_versions: [],
      schedule_task_revisions: [],
      schedule_version_tasks: [],
    })

    const outcome = await applyDelayedEnds({
      supabase,
      projectId: PROJECT_ID,
      delayedTaskIds: ['T0'],
      triggerProjectLogId: null,
      missReason: null,
      asOfDate: '2026-09-03', // T0 is due exactly today
    })

    expect(outcome).toEqual({
      success: true,
      versionNumber: 0,
      tasksChanged: 10, // root + 9 cascaded dependents
    })

    // Root: end +1, duration grows by the same amount, start untouched.
    expect(dates(tables, 'T0')).toEqual({
      start: '2026-09-01',
      end: '2026-09-04',
      duration: 3,
    })
    // Dependents slide +1 as a whole window; their own duration is untouched.
    expect(dates(tables, 'T1')).toEqual({
      start: '2026-09-04',
      end: '2026-09-06',
      duration: 2,
    })
    expect(dates(tables, 'T9')).toEqual({
      start: '2026-09-20',
      end: '2026-09-22',
      duration: 2,
    })

    expect(tables.schedule_task_revisions).toHaveLength(10)
    expect(tables.schedule_version_tasks).toHaveLength(10)
    expect(tables.schedule_versions).toHaveLength(1)

    // The 9 cascade updates go out together instead of one at a time.
    expect(stats.maxInFlight).toBeGreaterThan(1)
  })
})

describe('applyDelayedStarts (I/O wrapper)', () => {
  it('slides a not-yet-started task and its dependents, leaving duration alone', async () => {
    const { tasks, edges } = buildChain(4, null)
    const { supabase, tables } = createFakeSupabase({
      schedule_tasks: tasks,
      schedule_task_dependencies: edges,
      schedule_versions: [],
      schedule_task_revisions: [],
      schedule_version_tasks: [],
    })

    // Recommended start was 09-01; checked three days late (no form over a
    // weekend) — the whole gap is caught up in one push: 3 days + today's.
    const outcome = await applyDelayedStarts({
      supabase,
      projectId: PROJECT_ID,
      delayedStartTaskIds: ['T0'],
      triggerProjectLogId: null,
      missReason: null,
      asOfDate: '2026-09-04',
    })

    expect(outcome.success).toBe(true)
    expect(dates(tables, 'T0')).toEqual({
      start: '2026-09-05',
      end: '2026-09-07',
      duration: 2,
    })
    expect(dates(tables, 'T1')).toEqual({
      start: '2026-09-07',
      end: '2026-09-09',
      duration: 2,
    })
  })
})

describe('applyTaskCompletions (I/O wrapper)', () => {
  it('reconciles a late completion and pushes dependents', async () => {
    const { tasks, edges } = buildChain(3, '2026-09-01')
    const { supabase, tables } = createFakeSupabase({
      schedule_tasks: tasks,
      schedule_task_dependencies: edges,
      schedule_versions: [],
      schedule_task_revisions: [],
      schedule_version_tasks: [],
    })

    // T0 was planned to end 09-03 but is only ticked done on 09-06.
    const outcome = await applyTaskCompletions({
      supabase,
      projectId: PROJECT_ID,
      completions: [{ taskId: 'T0', actualEnd: '2026-09-06' }],
      today: '2026-09-06',
    })

    expect(outcome.success).toBe(true)
    const t0 = tables.schedule_tasks.find((r) => r.id === 'T0') as Row
    expect(t0.status).toBe('done')
    expect(t0.actual_end).toBe('2026-09-06')
    expect(dates(tables, 'T0')).toEqual({
      start: '2026-09-01',
      end: '2026-09-06',
      duration: 5,
    })
    expect(dates(tables, 'T1')).toEqual({
      start: '2026-09-06',
      end: '2026-09-08',
      duration: 2,
    })
    expect(dates(tables, 'T2')).toEqual({
      start: '2026-09-08',
      end: '2026-09-10',
      duration: 2,
    })
  })
})
