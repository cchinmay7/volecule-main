import { describe, expect, it } from 'vitest'
import { createFakeSupabase, type Row } from '@/test/fake-supabase'
import {
  clearTaskStart,
  markTaskDone,
  reopenTask,
  setTaskDates,
  setTaskStart,
} from './corrections'

const PROJECT = 'project-1'

type TaskSpec = {
  id: string
  start: string
  end: string
  status?: 'pending' | 'done'
  actualStart?: string | null
  actualEnd?: string | null
  duration?: number
  originalStart?: string
  originalEnd?: string
}

function task(spec: TaskSpec): Row {
  const duration =
    spec.duration ??
    Math.round((Date.parse(spec.end) - Date.parse(spec.start)) / 86_400_000)
  return {
    id: spec.id,
    project_id: PROJECT,
    external_ref: spec.id,
    name: `Task ${spec.id}`,
    vendor_team: null,
    status: spec.status ?? 'pending',
    original_planned_start: spec.originalStart ?? spec.start,
    original_planned_end: spec.originalEnd ?? spec.end,
    current_planned_start: spec.start,
    current_planned_end: spec.end,
    duration_days: duration,
    actual_start: spec.actualStart ?? null,
    actual_end: spec.actualEnd ?? null,
  }
}

function setup(tasks: TaskSpec[]) {
  // A straight chain in the order given: each task depends on the previous.
  const edges = tasks.slice(1).map((t, i) => ({
    task_id: t.id,
    depends_on_task_id: tasks[i].id,
    lag_days: 0,
  }))
  return createFakeSupabase({
    schedule_tasks: tasks.map(task),
    schedule_task_dependencies: edges,
    schedule_versions: [],
    schedule_task_revisions: [],
    schedule_version_tasks: [],
  })
}

const row = (tables: Record<string, Row[]>, id: string) =>
  tables.schedule_tasks.find((r) => r.id === id) as Row
const dates = (tables: Record<string, Row[]>, id: string) => {
  const r = row(tables, id)
  return `${r.current_planned_start}..${r.current_planned_end}`
}

const base = { projectId: PROJECT, note: 'Engineer ticked the wrong task' }

describe('markTaskDone', () => {
  it('records a late completion and pushes the dependents', async () => {
    const { supabase, tables } = setup([
      {
        id: 'T0',
        start: '2026-09-01',
        end: '2026-09-03',
        actualStart: '2026-09-01',
      },
      { id: 'T1', start: '2026-09-03', end: '2026-09-05' },
      { id: 'T2', start: '2026-09-05', end: '2026-09-07' },
    ])

    const result = await markTaskDone({
      ...base,
      supabase,
      taskId: 'T0',
      actualEnd: '2026-09-06',
      today: '2026-09-06',
    })

    expect(result).toEqual({
      ok: true,
      message: 'Saved. 2 dependent tasks moved as a result.',
    })
    expect(row(tables, 'T0')).toMatchObject({
      status: 'done',
      actual_start: '2026-09-01',
      actual_end: '2026-09-06',
      duration_days: 5,
    })
    expect(dates(tables, 'T1')).toBe('2026-09-06..2026-09-08')
    expect(dates(tables, 'T2')).toBe('2026-09-08..2026-09-10')

    // The correction itself is on the audit trail, with the operator's note.
    const revision = tables.schedule_task_revisions.find(
      (r) => r.task_id === 'T0',
    )
    expect(revision).toMatchObject({
      change_reason: 'manual_override',
      miss_reason: 'Engineer ticked the wrong task',
      previous_end: '2026-09-03',
      new_end: '2026-09-06',
    })
    expect(tables.schedule_versions).toHaveLength(1)
    expect(tables.schedule_version_tasks).toHaveLength(3)
  })

  it('pulls dependents forward for an early completion', async () => {
    const { supabase, tables } = setup([
      {
        id: 'T0',
        start: '2026-09-01',
        end: '2026-09-05',
        actualStart: '2026-09-01',
      },
      { id: 'T1', start: '2026-09-05', end: '2026-09-07' },
    ])

    await markTaskDone({
      ...base,
      supabase,
      taskId: 'T0',
      actualEnd: '2026-09-03',
      today: '2026-09-03',
    })

    expect(row(tables, 'T0')).toMatchObject({ duration_days: 2 })
    expect(dates(tables, 'T1')).toBe('2026-09-03..2026-09-05')
  })

  it("won't complete a task whose predecessor isn't done, and says which", async () => {
    const { supabase, tables } = setup([
      { id: 'T0', start: '2026-09-01', end: '2026-09-03' },
      { id: 'T1', start: '2026-09-03', end: '2026-09-05' },
    ])

    const result = await markTaskDone({
      ...base,
      supabase,
      taskId: 'T1',
      actualEnd: '2026-09-04',
      today: '2026-09-05',
    })

    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.error).toContain('T0')
    expect(row(tables, 'T1').status).toBe('pending')
  })

  it('refuses a future date, a bad date, and a date before the start', async () => {
    const { supabase } = setup([
      {
        id: 'T0',
        start: '2026-09-01',
        end: '2026-09-03',
        actualStart: '2026-09-02',
      },
    ])
    const call = (actualEnd: string) =>
      markTaskDone({
        ...base,
        supabase,
        taskId: 'T0',
        actualEnd,
        today: '2026-09-05',
      })

    expect(await call('2026-09-09')).toMatchObject({ ok: false })
    expect(await call('2026-02-31')).toMatchObject({ ok: false })
    const beforeStart = await call('2026-09-01')
    expect(beforeStart.ok === false && beforeStart.error).toContain(
      '2026-09-02',
    )
  })

  it('uses the given start for a task that was never marked started', async () => {
    const { supabase, tables } = setup([
      { id: 'T0', start: '2026-09-01', end: '2026-09-03' },
    ])

    await markTaskDone({
      ...base,
      supabase,
      taskId: 'T0',
      actualEnd: '2026-09-04',
      startedOn: '2026-09-02',
      today: '2026-09-05',
    })

    expect(row(tables, 'T0')).toMatchObject({
      actual_start: '2026-09-02',
      actual_end: '2026-09-04',
      duration_days: 2,
    })
  })

  it('changes the completion date of a task that is already done', async () => {
    const { supabase, tables } = setup([
      {
        id: 'T0',
        start: '2026-09-01',
        end: '2026-09-03',
        status: 'done',
        actualStart: '2026-09-01',
        actualEnd: '2026-09-03',
      },
      { id: 'T1', start: '2026-09-03', end: '2026-09-05' },
    ])

    await markTaskDone({
      ...base,
      supabase,
      taskId: 'T0',
      actualEnd: '2026-09-04',
      today: '2026-09-05',
    })

    expect(row(tables, 'T0')).toMatchObject({
      status: 'done',
      actual_end: '2026-09-04',
    })
    expect(dates(tables, 'T1')).toBe('2026-09-04..2026-09-06')
  })
})

describe('reopenTask', () => {
  const doneThenIdle = () =>
    setup([
      {
        id: 'T0',
        start: '2026-09-01',
        end: '2026-09-03',
        status: 'done',
        actualStart: '2026-09-01',
        actualEnd: '2026-09-03',
      },
      { id: 'T1', start: '2026-09-03', end: '2026-09-05' },
    ])

  it('puts a done task back in progress and pushes what follows', async () => {
    const { supabase, tables } = doneThenIdle()

    const result = await reopenTask({
      ...base,
      supabase,
      taskId: 'T0',
      newEnd: '2026-09-06',
      today: '2026-09-04',
    })

    expect(result.ok).toBe(true)
    expect(row(tables, 'T0')).toMatchObject({
      status: 'pending',
      actual_end: null,
      actual_start: '2026-09-01',
      current_planned_end: '2026-09-06',
      duration_days: 5,
    })
    expect(dates(tables, 'T1')).toBe('2026-09-06..2026-09-08')
  })

  it('refuses while a later task has already started', async () => {
    const { supabase, tables } = setup([
      {
        id: 'T0',
        start: '2026-09-01',
        end: '2026-09-03',
        status: 'done',
        actualStart: '2026-09-01',
        actualEnd: '2026-09-03',
      },
      {
        id: 'T1',
        start: '2026-09-03',
        end: '2026-09-05',
        actualStart: '2026-09-03',
      },
    ])

    const result = await reopenTask({
      ...base,
      supabase,
      taskId: 'T0',
      newEnd: '2026-09-06',
      today: '2026-09-04',
    })

    expect(result.ok === false && result.error).toContain('T1')
    expect(row(tables, 'T0').status).toBe('done')
  })

  it("refuses a task that isn't done, or an end before the start", async () => {
    const { supabase } = doneThenIdle()

    const notDone = await reopenTask({
      ...base,
      supabase,
      taskId: 'T1',
      newEnd: '2026-09-08',
      today: '2026-09-04',
    })
    const tooEarly = await reopenTask({
      ...base,
      supabase,
      taskId: 'T0',
      newEnd: '2026-09-01',
      today: '2026-09-04',
    })
    expect(notDone).toMatchObject({ ok: false })
    expect(tooEarly).toMatchObject({ ok: false })
  })
})

describe('setTaskStart', () => {
  const chain = () =>
    setup([
      { id: 'T0', start: '2026-09-01', end: '2026-09-03' },
      { id: 'T1', start: '2026-09-03', end: '2026-09-05' },
    ])

  it('confirms a start on a past date and moves the window with it', async () => {
    const { supabase, tables } = chain()

    const result = await setTaskStart({
      ...base,
      supabase,
      taskId: 'T0',
      startDate: '2026-09-02',
      today: '2026-09-05',
    })

    expect(result.ok).toBe(true)
    expect(row(tables, 'T0')).toMatchObject({
      actual_start: '2026-09-02',
      current_planned_start: '2026-09-02',
      current_planned_end: '2026-09-04',
    })
    expect(dates(tables, 'T1')).toBe('2026-09-04..2026-09-06')
  })

  it('lets a task start the day its predecessor is due, but not before', async () => {
    const { supabase } = chain()

    const onTheDay = await setTaskStart({
      ...base,
      supabase,
      taskId: 'T1',
      startDate: '2026-09-03',
      today: '2026-09-05',
    })
    const dayBefore = await setTaskStart({
      ...base,
      supabase,
      taskId: 'T1',
      startDate: '2026-09-02',
      today: '2026-09-05',
    })

    expect(onTheDay.ok).toBe(true)
    expect(dayBefore.ok === false && dayBefore.error).toContain('T0')
  })

  it('refuses a start in the future', async () => {
    const { supabase } = chain()
    const result = await setTaskStart({
      ...base,
      supabase,
      taskId: 'T0',
      startDate: '2026-09-09',
      today: '2026-09-05',
    })
    expect(result).toMatchObject({ ok: false })
  })
})

describe('clearTaskStart', () => {
  it('un-starts a task and drops the overrun it had accumulated', async () => {
    const { supabase, tables } = setup([
      {
        id: 'T0',
        start: '2026-09-01',
        end: '2026-09-06',
        duration: 5,
        originalStart: '2026-09-01',
        originalEnd: '2026-09-03',
        actualStart: '2026-09-01',
      },
      { id: 'T1', start: '2026-09-06', end: '2026-09-08' },
    ])

    const result = await clearTaskStart({
      ...base,
      supabase,
      taskId: 'T0',
      expectedStart: '2026-09-04',
      today: '2026-09-05',
    })

    expect(result.ok).toBe(true)
    expect(row(tables, 'T0')).toMatchObject({
      actual_start: null,
      current_planned_start: '2026-09-04',
      current_planned_end: '2026-09-06',
      duration_days: 2,
    })
    // The cleared task now ends where T1 already started, so T1 stays put.
    expect(dates(tables, 'T1')).toBe('2026-09-06..2026-09-08')
  })

  it('refuses when a later task has started, or the task never started', async () => {
    const { supabase } = setup([
      {
        id: 'T0',
        start: '2026-09-01',
        end: '2026-09-03',
        actualStart: '2026-09-01',
      },
      {
        id: 'T1',
        start: '2026-09-03',
        end: '2026-09-05',
        actualStart: '2026-09-03',
      },
      { id: 'T2', start: '2026-09-05', end: '2026-09-07' },
    ])

    const blocked = await clearTaskStart({
      ...base,
      supabase,
      taskId: 'T0',
      expectedStart: '2026-09-04',
      today: '2026-09-05',
    })
    const neverStarted = await clearTaskStart({
      ...base,
      supabase,
      taskId: 'T2',
      expectedStart: '2026-09-06',
      today: '2026-09-05',
    })

    expect(blocked.ok === false && blocked.error).toContain('T1')
    expect(neverStarted).toMatchObject({ ok: false })
  })
})

describe('setTaskDates', () => {
  it('moves an unstarted task and pushes dependents when the end gets later', async () => {
    const { supabase, tables } = setup([
      { id: 'T0', start: '2026-09-01', end: '2026-09-03' },
      { id: 'T1', start: '2026-09-03', end: '2026-09-05' },
    ])

    await setTaskDates({
      ...base,
      supabase,
      taskId: 'T0',
      start: '2026-09-02',
      end: '2026-09-06',
      today: '2026-09-01',
    })

    expect(row(tables, 'T0')).toMatchObject({ duration_days: 4 })
    expect(dates(tables, 'T0')).toBe('2026-09-02..2026-09-06')
    expect(dates(tables, 'T1')).toBe('2026-09-06..2026-09-08')
  })

  it('pulls dependents forward when the end gets earlier and nothing else holds them', async () => {
    const { supabase, tables } = setup([
      { id: 'T0', start: '2026-09-05', end: '2026-09-09' },
      { id: 'T1', start: '2026-09-09', end: '2026-09-11' },
    ])

    await setTaskDates({
      ...base,
      supabase,
      taskId: 'T0',
      start: '2026-09-05',
      end: '2026-09-07',
      today: '2026-09-01',
    })

    expect(dates(tables, 'T1')).toBe('2026-09-07..2026-09-09')
  })

  it('keeps a started task anchored to its real start', async () => {
    const { supabase } = setup([
      {
        id: 'T0',
        start: '2026-09-01',
        end: '2026-09-03',
        actualStart: '2026-09-01',
      },
    ])

    const moved = await setTaskDates({
      ...base,
      supabase,
      taskId: 'T0',
      start: '2026-09-02',
      end: '2026-09-06',
      today: '2026-09-04',
    })
    const endOnly = await setTaskDates({
      ...base,
      supabase,
      taskId: 'T0',
      start: '2026-09-01',
      end: '2026-09-06',
      today: '2026-09-04',
    })

    expect(moved.ok === false && moved.error).toContain('Set start date')
    expect(endOnly.ok).toBe(true)
  })

  it('refuses an end that is not after the start, and a done task', async () => {
    const { supabase } = setup([
      { id: 'T0', start: '2026-09-01', end: '2026-09-03' },
      {
        id: 'T1',
        start: '2026-09-03',
        end: '2026-09-05',
        status: 'done',
        actualStart: '2026-09-03',
        actualEnd: '2026-09-05',
      },
    ])

    expect(
      await setTaskDates({
        ...base,
        supabase,
        taskId: 'T0',
        start: '2026-09-03',
        end: '2026-09-03',
        today: '2026-09-01',
      }),
    ).toMatchObject({ ok: false })
    expect(
      await setTaskDates({
        ...base,
        supabase,
        taskId: 'T1',
        start: '2026-09-03',
        end: '2026-09-07',
        today: '2026-09-06',
      }),
    ).toMatchObject({ ok: false })
  })
})

describe('project scoping', () => {
  it("won't touch a task that belongs to another project", async () => {
    const { supabase } = setup([
      {
        id: 'T0',
        start: '2026-09-01',
        end: '2026-09-03',
        actualStart: '2026-09-01',
      },
    ])

    const result = await markTaskDone({
      supabase,
      projectId: 'someone-elses-project',
      taskId: 'T0',
      actualEnd: '2026-09-03',
      note: null,
      today: '2026-09-05',
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Task not found in this project.',
    })
  })
})
