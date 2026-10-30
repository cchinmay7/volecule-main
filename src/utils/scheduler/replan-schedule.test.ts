import { describe, expect, it } from 'vitest'
import { createFakeSupabase, type Row } from '@/test/fake-supabase'
import { planReplan, replanSchedule, type ReplanTask } from './replan-schedule'
import type { ParsedTaskRow } from './types'

const PROJECT = 'project-1'
const TODAY = '2026-01-07'

function task(
  id: string,
  start: string,
  end: string,
  extra: Partial<ReplanTask> = {},
): ReplanTask {
  return {
    id,
    external_ref: id,
    name: `Task ${id}`,
    status: 'pending',
    current_planned_start: start,
    current_planned_end: end,
    duration_days: 2,
    actual_start: null,
    actual_end: null,
    ...extra,
  }
}

function row(
  ref: string,
  start: string,
  end: string,
  preds: string[] = [],
  name = `Task ${ref}`,
): ParsedTaskRow {
  return {
    externalRef: ref,
    name,
    vendorTeam: null,
    durationDays: 2,
    plannedStart: start,
    plannedEnd: end,
    predecessorRefs: preds,
    sourceRow: 1,
    actualStart: null,
    actualEnd: null,
  }
}

/** W1, W2 done; W3 in progress and slipped to end Jan 10; W4 -> W5 not
 * started yet. */
const SITE: ReplanTask[] = [
  task('W1', '2026-01-01', '2026-01-03', {
    status: 'done',
    actual_start: '2026-01-01',
    actual_end: '2026-01-03',
  }),
  task('W2', '2026-01-03', '2026-01-05', {
    status: 'done',
    actual_start: '2026-01-03',
    actual_end: '2026-01-05',
  }),
  task('W3', '2026-01-05', '2026-01-10', { actual_start: '2026-01-05' }),
  task('W4', '2026-01-10', '2026-01-12'),
  task('W5', '2026-01-12', '2026-01-14'),
]

/** Same history; W4 renamed, W5 dropped, W6 -> W7 new after W3, with W6
 * planned before W3 actually ends. */
const SHEET: ParsedTaskRow[] = [
  row('W1', '2026-01-01', '2026-01-03'),
  row('W2', '2026-01-03', '2026-01-05', ['W1']),
  row('W3', '2026-01-05', '2026-01-08', ['W2']),
  row('W4', '2026-01-08', '2026-01-10', ['W3'], 'Brickwork'),
  row('W6', '2026-01-08', '2026-01-10', ['W3']),
  row('W7', '2026-01-10', '2026-01-12', ['W6']),
]

describe('planReplan', () => {
  it('keeps started work, replaces the rest, and anchors on the task in progress', () => {
    const result = planReplan(SITE, SHEET, TODAY)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    const { plan } = result

    expect(plan.anchorKind).toBe('in_progress')
    expect(plan.anchors).toEqual(['W3'])
    expect(plan.keptIds).toEqual(['W1', 'W2', 'W3'])
    expect(plan.deleteIds).toEqual(['W4', 'W5'])
    expect(plan.inserts.map((i) => i.externalRef)).toEqual(['W4', 'W6', 'W7'])
    expect(plan.inserts[0].name).toBe('Brickwork')
  })

  it('links new tasks to kept ones and pushes those that would start too early', () => {
    const result = planReplan(SITE, SHEET, TODAY)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    const { plan } = result

    expect(plan.keptLinks).toEqual([
      ['W4', 'W3'],
      ['W6', 'W3'],
    ])
    const w6 = plan.inserts.find((i) => i.externalRef === 'W6')
    const w7 = plan.inserts.find((i) => i.externalRef === 'W7')
    // W3 now ends Jan 10, so W6 (sheet: Jan 8) starts then, and W7 follows.
    expect(w6).toMatchObject({
      plannedStart: '2026-01-08',
      currentStart: '2026-01-10',
      currentEnd: '2026-01-12',
    })
    expect(w7).toMatchObject({
      currentStart: '2026-01-12',
      currentEnd: '2026-01-14',
    })
    expect(plan.shifted.sort()).toEqual(['W4', 'W6', 'W7'])
  })

  it('refuses when the task in progress has a different name in the sheet', () => {
    const sheet = SHEET.map((r) =>
      r.externalRef === 'W3' ? { ...r, name: 'Plastering' } : r,
    )
    const result = planReplan(SITE, sheet, TODAY)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('W3')
    expect(result.errors[0]).toContain('"Task W3"')
    expect(result.errors[0]).toContain('"Plastering"')
  })

  it('ignores case and spacing when comparing names', () => {
    const sheet = SHEET.map((r) =>
      r.externalRef === 'W3' ? { ...r, name: '  task   w3 ' } : r,
    )
    expect(planReplan(SITE, sheet, TODAY).ok).toBe(true)
  })

  it('refuses when the task in progress is missing from the sheet', () => {
    const sheet = SHEET.filter((r) => r.externalRef !== 'W3').map((r) => ({
      ...r,
      predecessorRefs: r.predecessorRefs.filter((p) => p !== 'W3'),
    }))
    const result = planReplan(SITE, sheet, TODAY)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain("W3 (Task W3) is in progress but isn't")
  })

  it('refuses when a finished task the sheet lists has another name', () => {
    const sheet = SHEET.map((r) =>
      r.externalRef === 'W1' ? { ...r, name: 'Excavation' } : r,
    )
    expect(planReplan(SITE, sheet, TODAY).ok).toBe(false)
  })

  it('anchors on the last finished task when nothing is in progress', () => {
    const site = SITE.filter((t) => t.id !== 'W3').map((t) =>
      t.id === 'W4' ? { ...t, external_ref: 'W4' } : t,
    )
    const sheet = [
      row('W1', '2026-01-01', '2026-01-03'),
      row('W2', '2026-01-03', '2026-01-05', ['W1']),
      row('W8', '2026-01-05', '2026-01-07', ['W2']),
    ]
    const result = planReplan(site, sheet, TODAY)
    if (!result.ok) throw new Error(result.errors.join('\n'))

    expect(result.plan.anchorKind).toBe('last_done')
    expect(result.plan.anchors).toEqual(['W2'])
    expect(result.plan.deleteIds).toEqual(['W4', 'W5'])
    expect(result.plan.inserts.map((i) => i.externalRef)).toEqual(['W8'])
  })

  it('replaces everything when nothing has started', () => {
    const site = [
      task('W1', '2026-01-01', '2026-01-03'),
      task('W2', '2026-01-03', '2026-01-05'),
    ]
    const result = planReplan(site, SHEET, TODAY)
    if (!result.ok) throw new Error(result.errors.join('\n'))

    expect(result.plan.anchorKind).toBe('none')
    expect(result.plan.deleteIds).toEqual(['W1', 'W2'])
    expect(result.plan.inserts).toHaveLength(SHEET.length)
  })

  it('also clears a retired task whose code the sheet brings back', () => {
    const site = [...SITE, task('old-W6', '2025-12-01', '2025-12-03')].map(
      (t) =>
        t.id === 'old-W6'
          ? { ...t, external_ref: 'W6', status: 'retired' as const }
          : t,
    )
    const result = planReplan(site, SHEET, TODAY)
    if (!result.ok) throw new Error(result.errors.join('\n'))

    expect(result.plan.deleteIds).toContain('old-W6')
    expect(result.plan.removedCount).toBe(2)
  })
})

function setup() {
  const asRow = (t: ReplanTask): Row => ({
    ...t,
    project_id: PROJECT,
    original_planned_start: t.current_planned_start,
    original_planned_end: t.current_planned_end,
  })
  return createFakeSupabase({
    schedule_tasks: SITE.map(asRow),
    schedule_task_dependencies: [
      { id: 'e1', task_id: 'W2', depends_on_task_id: 'W1', lag_days: 0 },
      { id: 'e2', task_id: 'W3', depends_on_task_id: 'W2', lag_days: 0 },
      { id: 'e3', task_id: 'W4', depends_on_task_id: 'W3', lag_days: 0 },
    ],
    schedule_versions: [{ id: 'v0', project_id: PROJECT, version_number: 0 }],
    schedule_version_tasks: [],
    schedule_imports: [],
    project_log_edits: [],
  })
}

const base = {
  projectId: PROJECT,
  sheet: SHEET,
  filename: 'plan-v2.xlsx',
  userId: 'operator-1',
  note: null,
  today: TODAY,
}

describe('replanSchedule', () => {
  it('only reports what would change when previewing', async () => {
    const fake = setup()
    const result = await replanSchedule({
      ...base,
      supabase: fake.supabase,
      preview: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.message).toContain('Picks up after W3 (in progress)')
    expect(result.message).toContain('removes 2 not started, adds 3')
    expect(fake.tables.schedule_tasks).toHaveLength(5)
    expect(fake.tables.schedule_versions).toHaveLength(1)
  })

  it('rebuilds the not-started tasks in a new version', async () => {
    const fake = setup()
    const result = await replanSchedule({
      ...base,
      supabase: fake.supabase,
      preview: false,
    })

    expect(result.ok).toBe(true)
    const refs = fake.tables.schedule_tasks.map((t) => t.external_ref).sort()
    expect(refs).toEqual(['W1', 'W2', 'W3', 'W4', 'W6', 'W7'])

    const byRef = new Map(
      fake.tables.schedule_tasks.map((t) => [t.external_ref, t]),
    )
    expect(byRef.get('W3')).toMatchObject({
      actual_start: '2026-01-05',
      current_planned_end: '2026-01-10',
    })
    expect(byRef.get('W4')).toMatchObject({
      name: 'Brickwork',
      original_planned_start: '2026-01-08',
      current_planned_start: '2026-01-10',
    })

    const w6 = byRef.get('W6') as Row
    const w7 = byRef.get('W7') as Row
    const edges = fake.tables.schedule_task_dependencies.map(
      (e) => `${e.task_id}>${e.depends_on_task_id}`,
    )
    expect(edges).toEqual(
      expect.arrayContaining([`${w6.id}>W3`, `${w7.id}>${w6.id}`]),
    )

    expect(fake.tables.schedule_versions).toHaveLength(2)
    expect(fake.tables.schedule_versions[1]).toMatchObject({
      version_number: 1,
      source: 'excel_import',
    })
    expect(fake.tables.schedule_version_tasks).toHaveLength(6)
    expect(fake.tables.project_log_edits[0]).toMatchObject({
      kind: 'schedule_replanned',
    })
  })

  it('changes nothing when the sheet disagrees with the site', async () => {
    const fake = setup()
    const sheet = SHEET.map((r) =>
      r.externalRef === 'W3' ? { ...r, name: 'Plastering' } : r,
    )
    const result = await replanSchedule({
      ...base,
      sheet,
      supabase: fake.supabase,
      preview: false,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Nothing was changed.')
    expect(fake.tables.schedule_tasks).toHaveLength(5)
    expect(fake.tables.schedule_versions).toHaveLength(1)
  })
})
