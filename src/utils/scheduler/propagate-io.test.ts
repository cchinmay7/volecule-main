import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  applyDelayedEnds,
  applyDelayedStarts,
  applyTaskCompletions,
} from './propagate'

type Row = Record<string, unknown>

/** Minimal in-memory stand-in for the slice of the Supabase query builder
 * the propagation wrappers use. Every request takes a fixed simulated
 * latency, and in-flight requests are tracked, so a test can see whether
 * writes are issued concurrently rather than one at a time. */
function createFakeSupabase(initial: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(initial)) {
    tables[name] = rows.map((row) => ({ ...row }))
  }
  const stats = { requests: 0, inFlight: 0, maxInFlight: 0 }
  let nextId = 0

  class Query implements PromiseLike<{ data: unknown; error: null }> {
    private op: 'select' | 'insert' | 'update' = 'select'
    private payload: unknown
    private filters: ((row: Row) => boolean)[] = []
    private wantSingle = false
    private maybe = false
    private limitN: number | null = null
    private orderCol: string | null = null
    private orderAsc = true

    constructor(private table: string) {}

    select() {
      return this
    }
    insert(payload: unknown) {
      this.op = 'insert'
      this.payload = payload
      return this
    }
    update(payload: unknown) {
      this.op = 'update'
      this.payload = payload
      return this
    }
    eq(col: string, val: unknown) {
      this.filters.push((row) => row[col] === val)
      return this
    }
    in(col: string, vals: unknown[]) {
      this.filters.push((row) => vals.includes(row[col]))
      return this
    }
    not(col: string, _op: string, _val: unknown) {
      this.filters.push((row) => row[col] !== null && row[col] !== undefined)
      return this
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderCol = col
      this.orderAsc = opts?.ascending ?? true
      return this
    }
    limit(n: number) {
      this.limitN = n
      return this
    }
    maybeSingle() {
      this.maybe = true
      return this
    }
    singleRow() {
      this.wantSingle = true
      return this
    }

    private execute(): unknown {
      const rows = (tables[this.table] ??= [])
      if (this.op === 'insert') {
        const incoming = (
          Array.isArray(this.payload) ? this.payload : [this.payload]
        ) as Row[]
        const inserted = incoming.map((row) => ({
          id: `gen-${nextId++}`,
          ...row,
        }))
        rows.push(...inserted)
        return this.wantSingle || this.maybe ? inserted[0] : inserted
      }
      const matching = rows.filter((row) => this.filters.every((f) => f(row)))
      if (this.op === 'update') {
        for (const row of matching) Object.assign(row, this.payload)
        return null
      }
      let result = [...matching]
      if (this.orderCol) {
        const col = this.orderCol
        result.sort((a, b) =>
          (a[col] as number) < (b[col] as number) ? -1 : 1,
        )
        if (!this.orderAsc) result.reverse()
      }
      if (this.limitN !== null) result = result.slice(0, this.limitN)
      return this.wantSingle || this.maybe ? (result[0] ?? null) : result
    }

    then<R1, R2>(
      onfulfilled?: (v: { data: unknown; error: null }) => R1 | PromiseLike<R1>,
      onrejected?: (reason: unknown) => R2 | PromiseLike<R2>,
    ): PromiseLike<R1 | R2> {
      return (async () => {
        stats.requests += 1
        stats.inFlight += 1
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        const data = this.execute()
        stats.inFlight -= 1
        return { data, error: null }
      })().then(onfulfilled, onrejected)
    }
  }

  const client = {
    from: (table: string) => {
      const query = new Query(table)
      // supabase-js exposes .single() after insert().select(); the fake
      // routes it to singleRow() so it can't collide with the class's own
      // field name.
      return Object.assign(query, {
        single: () => query.singleRow(),
      })
    },
  }

  return {
    supabase: client as unknown as SupabaseClient,
    tables,
    stats,
  }
}

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
