import { describe, expect, it } from 'vitest'
import { createFakeSupabase, type Row } from '@/test/fake-supabase'
import { renameTask } from './corrections'

const PROJECT = 'project-1'

type TaskSpec = {
  id: string
  start: string
  end: string
  status?: 'pending' | 'done' | 'retired'
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
    actual_start: null,
    actual_end: null,
  }
}

function setup(
  tasks: TaskSpec[],
  options?: Parameters<typeof createFakeSupabase>[1],
) {
  return createFakeSupabase(
    {
      schedule_tasks: tasks.map(task),
      schedule_task_dependencies: [],
      schedule_versions: [],
      schedule_task_revisions: [],
      schedule_version_tasks: tasks.map((t) => ({
        id: `snap-${t.id}`,
        task_id: t.id,
        name: `Task ${t.id}`,
      })),
      project_log_edits: [],
    },
    options,
  )
}

const row = (tables: Record<string, Row[]>, id: string) =>
  tables.schedule_tasks.find((r) => r.id === id) as Row

const rename = {
  projectId: PROJECT,
  userId: 'operator-1',
  note: null as string | null,
}

const plan: TaskSpec[] = [
  { id: 'W41', start: '2026-09-01', end: '2026-09-03' },
  { id: 'W42', start: '2026-09-03', end: '2026-09-05' },
]

describe('renameTask', () => {
  it('changes the name and leaves the code and every date alone', async () => {
    const { supabase, tables } = setup(plan)

    const result = await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: 'Column Shuttering',
    })

    expect(result).toEqual({
      ok: true,
      message: 'Renamed. The code W41 is unchanged.',
    })
    const renamed = row(tables, 'W41')
    expect(renamed.name).toBe('Column Shuttering')
    expect(renamed.external_ref).toBe('W41')
    expect(renamed.current_planned_start).toBe('2026-09-01')
    expect(renamed.current_planned_end).toBe('2026-09-03')
    expect(row(tables, 'W42').current_planned_start).toBe('2026-09-03')
    expect(row(tables, 'W42').name).toBe('Task W42')
  })

  it('does not cut a schedule version or add a revision', async () => {
    const { supabase, tables } = setup(plan)

    await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: 'Column Shuttering',
    })

    expect(tables.schedule_versions).toHaveLength(0)
    expect(tables.schedule_task_revisions).toHaveLength(0)
  })

  it('leaves past schedule versions with the name they had', async () => {
    const { supabase, tables } = setup(plan)

    await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: 'Column Shuttering',
    })

    const snapshot = tables.schedule_version_tasks.find(
      (r) => r.task_id === 'W41',
    ) as Row
    expect(snapshot.name).toBe('Task W41')
  })

  it('records who renamed it, from what to what, and why', async () => {
    const { supabase, tables } = setup(plan)

    await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: 'Column Shuttering',
      note: 'Matches the drawing',
    })

    expect(tables.project_log_edits).toEqual([
      expect.objectContaining({
        project_id: PROJECT,
        project_log_id: null,
        edited_by: 'operator-1',
        kind: 'task_renamed',
        note: 'Matches the drawing',
        details: {
          task_id: 'W41',
          code: 'W41',
          previous: 'Task W41',
          next: 'Column Shuttering',
        },
      }),
    ])
  })

  it('tidies stray spaces in the new name', async () => {
    const { supabase, tables } = setup(plan)

    await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: '  Column   Shuttering \n',
    })

    expect(row(tables, 'W41').name).toBe('Column Shuttering')
  })

  it('renames a finished task too', async () => {
    const { supabase, tables } = setup([
      { id: 'W41', start: '2026-09-01', end: '2026-09-03', status: 'done' },
    ])

    const result = await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: 'Column Shuttering',
    })

    expect(result.ok).toBe(true)
    expect(row(tables, 'W41').name).toBe('Column Shuttering')
    expect(row(tables, 'W41').status).toBe('done')
  })

  it('says nothing changed, and records nothing, when the name is the same', async () => {
    const { supabase, tables } = setup(plan)

    const result = await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: ' Task  W41 ',
    })

    expect(result).toEqual({ ok: true, message: 'Nothing changed.' })
    expect(tables.project_log_edits).toHaveLength(0)
  })

  it('refuses an empty name', async () => {
    const { supabase, tables } = setup(plan)

    const result = await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: '   ',
    })

    expect(result).toEqual({ ok: false, error: 'Enter a name for the task.' })
    expect(row(tables, 'W41').name).toBe('Task W41')
  })

  it('refuses a name that is too long', async () => {
    const { supabase, tables } = setup(plan)

    const result = await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: 'x'.repeat(201),
    })

    expect(result).toMatchObject({ ok: false })
    expect(row(tables, 'W41').name).toBe('Task W41')
  })

  it.each([
    'W41 — Column Shuttering',
    'w41: Column Shuttering',
    'W-41 - Column Shuttering',
    ' W 41 – Column Shuttering',
  ])('refuses a name that repeats the code: %s', async (name) => {
    const { supabase, tables } = setup(plan)

    const result = await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name,
    })

    expect(result).toEqual({
      ok: false,
      error:
        'Leave the code out of the name. W41 is shown in front of it automatically.',
    })
    expect(row(tables, 'W41').name).toBe('Task W41')
  })

  it.each(['W410 Column Shuttering', 'Level 2 — Slab', 'W42 — Beams'])(
    'accepts a name that only looks a bit like a code: %s',
    async (name) => {
      const { supabase, tables } = setup(plan)

      const result = await renameTask({
        ...rename,
        supabase,
        taskId: 'W41',
        name,
      })

      expect(result.ok).toBe(true)
      expect(row(tables, 'W41').name).toBe(name)
    },
  )

  it('lets a plain number lead a name when the code is a number too', async () => {
    const { supabase, tables } = setup([
      { id: '38', start: '2026-09-01', end: '2026-09-03' },
    ])

    const result = await renameTask({
      ...rename,
      supabase,
      taskId: '38',
      name: '38 inch pipe laying',
    })

    expect(result.ok).toBe(true)
    expect(row(tables, '38').name).toBe('38 inch pipe laying')
  })

  it("won't rename a task in another project", async () => {
    const { supabase, tables } = setup(plan)

    const result = await renameTask({
      ...rename,
      projectId: 'someone-elses-project',
      supabase,
      taskId: 'W41',
      name: 'Column Shuttering',
    })

    expect(result).toEqual({
      ok: false,
      error: 'Task not found in this project.',
    })
    expect(row(tables, 'W41').name).toBe('Task W41')
  })

  it("won't rename a retired task", async () => {
    const { supabase, tables } = setup([
      { id: 'W41', start: '2026-09-01', end: '2026-09-03', status: 'retired' },
    ])

    const result = await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: 'Column Shuttering',
    })

    expect(result).toMatchObject({ ok: false })
    expect(row(tables, 'W41').name).toBe('Task W41')
  })

  it('still renames, and says so, if the history entry cannot be saved', async () => {
    const { supabase, tables } = setup(plan, {
      failInserts: ['project_log_edits'],
    })

    const result = await renameTask({
      ...rename,
      supabase,
      taskId: 'W41',
      name: 'Column Shuttering',
    })

    expect(result).toEqual({
      ok: true,
      message:
        'Renamed. The code W41 is unchanged. (History entry not saved: run db/updates_v2.sql in Supabase.)',
    })
    expect(row(tables, 'W41').name).toBe('Column Shuttering')
  })
})
