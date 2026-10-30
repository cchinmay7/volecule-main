import { describe, expect, it } from 'vitest'
import { createFakeSupabase, type Row } from '@/test/fake-supabase'
import { addTask, deleteTask } from './task-structure'

const PROJECT = 'project-1'
const TODAY = '2026-01-02'

type TaskSpec = {
  id: string
  start: string
  end: string
  status?: 'pending' | 'done' | 'retired'
  actualStart?: string | null
}

/** A task whose id is also its code, named "Task <id>". */
function task(spec: TaskSpec): Row {
  return {
    id: spec.id,
    project_id: PROJECT,
    external_ref: spec.id,
    name: `Task ${spec.id}`,
    vendor_team: null,
    status: spec.status ?? 'pending',
    original_planned_start: spec.start,
    original_planned_end: spec.end,
    current_planned_start: spec.start,
    current_planned_end: spec.end,
    duration_days: 2,
    actual_start: spec.actualStart ?? null,
    actual_end: null,
  }
}

/** A -> B -> C, plus D on its own. */
function setup() {
  return createFakeSupabase({
    schedule_tasks: [
      task({ id: 'A', start: '2026-01-01', end: '2026-01-03' }),
      task({ id: 'B', start: '2026-01-03', end: '2026-01-05' }),
      task({ id: 'C', start: '2026-01-05', end: '2026-01-07' }),
      task({ id: 'D', start: '2026-01-01', end: '2026-01-03' }),
    ],
    schedule_task_dependencies: [
      { id: 'e1', task_id: 'B', depends_on_task_id: 'A', lag_days: 0 },
      { id: 'e2', task_id: 'C', depends_on_task_id: 'B', lag_days: 0 },
    ],
    schedule_versions: [],
    schedule_task_revisions: [],
    schedule_version_tasks: [],
    project_log_edits: [],
  })
}

const edgesOf = (tables: Record<string, Row[]>) =>
  tables.schedule_task_dependencies
    .map((e) => `${e.task_id}>${e.depends_on_task_id}`)
    .sort()

const byRef = (tables: Record<string, Row[]>, ref: string) =>
  tables.schedule_tasks.find((t) => t.external_ref === ref) as Row

const add = {
  projectId: PROJECT,
  name: 'Waterproofing',
  start: null,
  durationDays: 3,
  parentIds: [] as string[],
  childIds: [] as string[],
  userId: 'operator-1',
  note: null,
  today: TODAY,
}

describe('addTask', () => {
  it('starts after its last parent and pushes its children', async () => {
    const fake = setup()
    const result = await addTask({
      ...add,
      supabase: fake.supabase,
      code: 'w 9',
      parentIds: ['A', 'D'],
      childIds: ['C'],
    })

    expect(result).toMatchObject({ ok: true })
    const added = byRef(fake.tables, 'W9')
    expect(added).toMatchObject({
      name: 'Waterproofing',
      current_planned_start: '2026-01-03',
      current_planned_end: '2026-01-06',
      duration_days: 3,
      status: 'pending',
    })
    expect(edgesOf(fake.tables)).toEqual(
      ['B>A', 'C>B', `${added.id}>A`, `${added.id}>D`, `C>${added.id}`].sort(),
    )
    // C started Jan 5 but now waits for W9 to end Jan 6.
    expect(byRef(fake.tables, 'C')).toMatchObject({
      current_planned_start: '2026-01-06',
      current_planned_end: '2026-01-08',
    })
    expect(fake.tables.schedule_versions).toHaveLength(1)
    expect(fake.tables.project_log_edits[0]).toMatchObject({
      kind: 'task_added',
      details: { code: 'W9', parents: ['A', 'D'], children: ['C'] },
    })
  })

  it('starts today with no parents and no start given', async () => {
    const fake = setup()
    await addTask({ ...add, supabase: fake.supabase, code: 'W9' })

    expect(byRef(fake.tables, 'W9')).toMatchObject({
      current_planned_start: TODAY,
      current_planned_end: '2026-01-05',
    })
  })

  it('keeps a start the operator chose, even before a parent ends', async () => {
    const fake = setup()
    const result = await addTask({
      ...add,
      supabase: fake.supabase,
      code: 'W9',
      start: '2026-01-02',
      parentIds: ['A'],
    })

    expect(result.ok && result.message).toContain('starts before a parent ends')
    expect(byRef(fake.tables, 'W9').current_planned_start).toBe('2026-01-02')
  })

  it('refuses a loop', async () => {
    const fake = setup()
    const result = await addTask({
      ...add,
      supabase: fake.supabase,
      code: 'W9',
      parentIds: ['C'],
      childIds: ['A'],
    })

    expect(result).toMatchObject({ ok: false })
    expect(!result.ok && result.error).toContain('loop')
    expect(byRef(fake.tables, 'W9')).toBeUndefined()
  })

  it('refuses the same task as parent and child', async () => {
    const fake = setup()
    const result = await addTask({
      ...add,
      supabase: fake.supabase,
      code: 'W9',
      parentIds: ['D'],
      childIds: ['D'],
    })
    expect(!result.ok && result.error).toContain('both before and after')
  })

  it('refuses a child that has already started', async () => {
    const fake = setup()
    byRef(fake.tables, 'C').actual_start = '2026-01-05'
    const result = await addTask({
      ...add,
      supabase: fake.supabase,
      code: 'W9',
      childIds: ['C'],
    })
    expect(!result.ok && result.error).toContain('already started')
  })

  it('refuses a code already in use or a bad code', async () => {
    const fake = setup()
    const taken = await addTask({ ...add, supabase: fake.supabase, code: 'b' })
    expect(taken).toMatchObject({ ok: false })

    const bad = await addTask({
      ...add,
      supabase: fake.supabase,
      code: 'slab',
    })
    expect(!bad.ok && bad.error).toContain('task code')
  })
})

const remove = {
  projectId: PROJECT,
  userId: 'operator-1',
  note: null,
  today: TODAY,
}

describe('deleteTask', () => {
  it('links the tasks after it to the tasks before it', async () => {
    const fake = setup()
    const result = await deleteTask({
      ...remove,
      supabase: fake.supabase,
      taskId: 'B',
      reconnect: true,
    })

    expect(result).toMatchObject({ ok: true })
    expect(byRef(fake.tables, 'B')).toBeUndefined()
    expect(edgesOf(fake.tables)).toEqual(['C>A'])
    expect(fake.tables.project_log_edits[0]).toMatchObject({
      kind: 'task_deleted',
      details: { code: 'B', parents: ['A'], children: ['C'] },
    })
  })

  it('just drops the links when not reconnecting', async () => {
    const fake = setup()
    await deleteTask({
      ...remove,
      supabase: fake.supabase,
      taskId: 'B',
      reconnect: false,
    })

    expect(edgesOf(fake.tables)).toEqual([])
    expect(byRef(fake.tables, 'C').current_planned_start).toBe('2026-01-05')
  })

  it('pushes a child that would now start before its new parent ends', async () => {
    const fake = setup()
    // C was planned to overlap A; through B that didn't matter.
    Object.assign(byRef(fake.tables, 'A'), {
      current_planned_end: '2026-01-06',
    })
    await deleteTask({
      ...remove,
      supabase: fake.supabase,
      taskId: 'B',
      reconnect: true,
    })

    expect(byRef(fake.tables, 'C')).toMatchObject({
      current_planned_start: '2026-01-06',
      current_planned_end: '2026-01-08',
    })
  })

  it('refuses a task from another project', async () => {
    const fake = setup()
    const result = await deleteTask({
      ...remove,
      supabase: fake.supabase,
      taskId: 'nope',
      reconnect: true,
    })
    expect(result).toMatchObject({ ok: false })
  })
})
