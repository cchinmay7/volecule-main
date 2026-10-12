import { describe, expect, it } from 'vitest'
import { createFakeSupabase, type Row } from '@/test/fake-supabase'
import { ingestFormSubmission } from './ingest-submission'
import { runRefreshSweep } from './refresh-sweep'

/**
 * A task is pushed to tomorrow by the refresh sweep ("its recommended start
 * has arrived and nobody confirmed it"), and then the engineer submits that
 * same day's morning form with the task ticked as started. The start is
 * real after all, so the task goes back to today, and everything the sweep
 * pushed on its account should go back with it.
 *
 * The plan below is a chain W1 -> W2 -> W3 -> W4, two days each, laid end to
 * end from 1 Sep with no gaps (the exclusive-end convention): W1 1-3, W2 3-5,
 * W3 5-7, W4 7-9.
 */

const PROJECT_ID = 'project-1'
const PROJECT_CODE = 'P-1'

type Plan = { id: string; ref: string; start: string; end: string }

function task(plan: Plan, duration: number): Row {
  return {
    id: plan.id,
    project_id: PROJECT_ID,
    external_ref: plan.ref,
    name: `Task ${plan.ref}`,
    vendor_team: null,
    status: 'pending',
    actual_start: null,
    actual_end: null,
    current_planned_start: plan.start,
    current_planned_end: plan.end,
    duration_days: duration,
  }
}

function edge(task: string, dependsOn: string): Row {
  return { task_id: task, depends_on_task_id: dependsOn, lag_days: 0 }
}

function chain(): { tasks: Row[]; edges: Row[] } {
  const plans: Plan[] = [
    { id: 'T1', ref: 'W1', start: '2026-09-01', end: '2026-09-03' },
    { id: 'T2', ref: 'W2', start: '2026-09-03', end: '2026-09-05' },
    { id: 'T3', ref: 'W3', start: '2026-09-05', end: '2026-09-07' },
    { id: 'T4', ref: 'W4', start: '2026-09-07', end: '2026-09-09' },
  ]
  return {
    tasks: plans.map((plan) => task(plan, 2)),
    edges: [edge('T2', 'T1'), edge('T3', 'T2'), edge('T4', 'T3')],
  }
}

function database(tasks: Row[], edges: Row[]) {
  return createFakeSupabase(
    {
      projects: [
        {
          id: PROJECT_ID,
          public_code: PROJECT_CODE,
          status: 'active',
          timezone: 'Asia/Kolkata',
        },
      ],
      project_logs: [],
      schedule_tasks: tasks,
      schedule_task_dependencies: edges,
      schedule_versions: [],
      schedule_task_revisions: [],
      schedule_version_tasks: [],
      schedule_ingestion_flags: [],
    },
    { latencyMs: 0 },
  )
}

function windowOf(tables: Record<string, Row[]>, id: string) {
  const row = tables.schedule_tasks.find((r) => r.id === id) as Row
  return {
    start: row.current_planned_start,
    end: row.current_planned_end,
    actualStart: row.actual_start,
  }
}

/** The morning form for `date` (an IST calendar date), with `ticked` task
 * ids ticked as started. */
function morningForm(
  supabase: ReturnType<typeof database>['supabase'],
  date: string,
  ticked: string[],
) {
  return ingestFormSubmission(supabase, {
    projectId: PROJECT_ID,
    projectCode: PROJECT_CODE,
    shift: 'morning',
    externalSubmissionId: `form-${date}`,
    submittedAt: `${date}T03:00:00Z`, // 08:30 in Asia/Kolkata, same date
    formValues: {
      starts_confirmed: ticked.map((ref) => `${ref} — Task ${ref}`),
      free_notes: null,
    },
    sourcePayload: {},
    source: 'google_form',
  })
}

describe('a start confirmed on the day a refresh pushed it', () => {
  it('gives the task itself today as its start', async () => {
    const { tasks, edges } = chain()
    const { supabase, tables } = database(tasks, edges)

    await runRefreshSweep({
      supabase,
      projectId: PROJECT_ID,
      asOfDate: '2026-09-01',
    })
    // The refresh slid W1 to tomorrow (2-4) and everything behind it by a day.
    expect(windowOf(tables, 'T1')).toMatchObject({
      start: '2026-09-02',
      end: '2026-09-04',
    })
    expect(windowOf(tables, 'T2')).toMatchObject({
      start: '2026-09-04',
      end: '2026-09-06',
    })

    const result = await morningForm(supabase, '2026-09-01', ['W1'])
    expect(result).toEqual({
      ok: true,
      logDate: '2026-09-01',
      shift: 'morning',
    })

    expect(windowOf(tables, 'T1')).toEqual({
      start: '2026-09-01',
      end: '2026-09-03',
      actualStart: '2026-09-01',
    })
  })

  it('brings the tasks the refresh pushed back to where the plan had them', async () => {
    const { tasks, edges } = chain()
    const { supabase, tables } = database(tasks, edges)

    await runRefreshSweep({
      supabase,
      projectId: PROJECT_ID,
      asOfDate: '2026-09-01',
    })
    await morningForm(supabase, '2026-09-01', ['W1'])

    // No work was actually late, so the plan should read as it did before the
    // refresh: W2 starts the day W1 ends, and so on down the chain.
    expect(windowOf(tables, 'T2')).toMatchObject({
      start: '2026-09-03',
      end: '2026-09-05',
    })
    expect(windowOf(tables, 'T3')).toMatchObject({
      start: '2026-09-05',
      end: '2026-09-07',
    })
    expect(windowOf(tables, 'T4')).toMatchObject({
      start: '2026-09-07',
      end: '2026-09-09',
    })
  })

  it('records the move of each pulled-back task in the revision history', async () => {
    const { tasks, edges } = chain()
    const { supabase, tables } = database(tasks, edges)

    await runRefreshSweep({
      supabase,
      projectId: PROJECT_ID,
      asOfDate: '2026-09-01',
    })
    await morningForm(supabase, '2026-09-01', ['W1'])

    const w2Revisions = tables.schedule_task_revisions.filter(
      (r) => r.task_id === 'T2',
    )
    // pushed by the refresh, then pulled back by the confirmed start
    expect(w2Revisions.map((r) => [r.new_start, r.change_reason])).toEqual([
      ['2026-09-04', 'delayed_start'],
      ['2026-09-03', 'confirmed_start'],
    ])
  })
})

describe('a confirmed start with no refresh before it', () => {
  it('leaves the tasks after it where they were when it starts on plan', async () => {
    const { tasks, edges } = chain()
    const { supabase, tables } = database(tasks, edges)

    await morningForm(supabase, '2026-09-01', ['W1'])

    expect(windowOf(tables, 'T1')).toMatchObject({
      start: '2026-09-01',
      end: '2026-09-03',
    })
    expect(windowOf(tables, 'T2')).toMatchObject({
      start: '2026-09-03',
      end: '2026-09-05',
    })
    expect(windowOf(tables, 'T4')).toMatchObject({
      start: '2026-09-07',
      end: '2026-09-09',
    })
  })

  it('still pushes the tasks after it when it starts late', async () => {
    const { tasks, edges } = chain()
    const { supabase, tables } = database(tasks, edges)

    // Planned for 1 Sep; the engineer only confirms it on 3 Sep.
    await morningForm(supabase, '2026-09-03', ['W1'])

    expect(windowOf(tables, 'T1')).toMatchObject({
      start: '2026-09-03',
      end: '2026-09-05',
    })
    expect(windowOf(tables, 'T2')).toMatchObject({
      start: '2026-09-05',
      end: '2026-09-07',
    })
    expect(windowOf(tables, 'T4')).toMatchObject({
      start: '2026-09-09',
      end: '2026-09-11',
    })
  })
})

describe('a task waiting on two predecessors', () => {
  /** A 1-3 and B 1-6 both feed C (6-8). */
  function diamond() {
    const tasks = [
      task({ id: 'A', ref: 'W1', start: '2026-09-01', end: '2026-09-03' }, 2),
      task({ id: 'B', ref: 'W2', start: '2026-09-01', end: '2026-09-06' }, 5),
      task({ id: 'C', ref: 'W3', start: '2026-09-06', end: '2026-09-08' }, 2),
    ]
    return { tasks, edges: [edge('C', 'A'), edge('C', 'B')] }
  }

  it("isn't pulled ahead of the predecessor that is still late", async () => {
    const { tasks, edges } = diamond()
    const { supabase, tables } = database(tasks, edges)

    await runRefreshSweep({
      supabase,
      projectId: PROJECT_ID,
      asOfDate: '2026-09-01',
    })
    // Only A is confirmed. B is still on its pushed dates (2-7), so C waits.
    await morningForm(supabase, '2026-09-01', ['W1'])

    expect(windowOf(tables, 'A')).toMatchObject({
      start: '2026-09-01',
      end: '2026-09-03',
    })
    expect(windowOf(tables, 'B')).toMatchObject({
      start: '2026-09-02',
      end: '2026-09-07',
    })
    expect(windowOf(tables, 'C')).toMatchObject({
      start: '2026-09-07',
      end: '2026-09-09',
    })
  })

  it('goes back to its original start once both predecessors are confirmed', async () => {
    const { tasks, edges } = diamond()
    const { supabase, tables } = database(tasks, edges)

    await runRefreshSweep({
      supabase,
      projectId: PROJECT_ID,
      asOfDate: '2026-09-01',
    })
    await morningForm(supabase, '2026-09-01', ['W1', 'W2'])

    expect(windowOf(tables, 'C')).toMatchObject({
      start: '2026-09-06',
      end: '2026-09-08',
    })
  })
})
