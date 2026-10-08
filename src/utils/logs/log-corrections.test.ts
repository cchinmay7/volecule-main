import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase } from '@/test/fake-supabase'

const ingest = vi.hoisted(() => vi.fn())
vi.mock('@/utils/scheduler/ingest-submission', () => ({
  ingestFormSubmission: ingest,
}))

import {
  deleteLogPhoto,
  submitMissedLog,
  updateLogRecord,
} from './log-corrections'

const PROJECT = 'p1'
const USER = 'user-1'

const log = (overrides = {}) => ({
  id: 'log1',
  project_id: PROJECT,
  log_date: '2026-10-06',
  shift: 'evening',
  headcount_json: { masons: '4', helpers: '6' },
  free_notes: 'All good',
  escalate_to_volecule: false,
  ...overrides,
})

describe('updateLogRecord', () => {
  it('changes the record and keeps the previous values in the history', async () => {
    const { supabase, tables } = createFakeSupabase({
      project_logs: [log()],
      project_log_edits: [],
    })

    const result = await updateLogRecord({
      supabase,
      projectId: PROJECT,
      logId: 'log1',
      userId: USER,
      headcount: { masons: '5', helpers: ' ' },
      freeNotes: '  Rain delay in the afternoon ',
      escalate: true,
      note: 'Engineer mistyped the count',
    })

    expect(result).toEqual({ ok: true, message: 'Log updated.' })
    expect(tables.project_logs[0]).toMatchObject({
      headcount_json: { masons: '5', helpers: null },
      free_notes: 'Rain delay in the afternoon',
      escalate_to_volecule: true,
    })
    expect(tables.project_log_edits).toHaveLength(1)
    expect(tables.project_log_edits[0]).toMatchObject({
      project_id: PROJECT,
      project_log_id: 'log1',
      edited_by: USER,
      kind: 'log_edited',
      note: 'Engineer mistyped the count',
      details: {
        previous: {
          headcount_json: { masons: '4', helpers: '6' },
          free_notes: 'All good',
          escalate_to_volecule: false,
        },
      },
    })
  })

  it('does nothing, and records nothing, when nothing changed', async () => {
    const { supabase, tables } = createFakeSupabase({
      project_logs: [log()],
      project_log_edits: [],
    })

    const result = await updateLogRecord({
      supabase,
      projectId: PROJECT,
      logId: 'log1',
      userId: USER,
      headcount: { helpers: '6', masons: '4' },
      freeNotes: 'All good',
      escalate: false,
      note: null,
    })

    expect(result).toEqual({ ok: true, message: 'Nothing changed.' })
    expect(tables.project_log_edits).toHaveLength(0)
  })

  it('leaves the headcount alone when none is given', async () => {
    const { supabase, tables } = createFakeSupabase({
      project_logs: [log()],
      project_log_edits: [],
    })

    await updateLogRecord({
      supabase,
      projectId: PROJECT,
      logId: 'log1',
      userId: USER,
      headcount: null,
      freeNotes: 'All good',
      escalate: true,
      note: null,
    })

    expect(tables.project_logs[0].headcount_json).toEqual({
      masons: '4',
      helpers: '6',
    })
  })

  it("won't edit another project's log", async () => {
    const { supabase } = createFakeSupabase({ project_logs: [log()] })

    const result = await updateLogRecord({
      supabase,
      projectId: 'other',
      logId: 'log1',
      userId: USER,
      headcount: null,
      freeNotes: null,
      escalate: false,
      note: null,
    })

    expect(result).toMatchObject({ ok: false })
  })

  it('still saves the correction, and says so, if the history table is missing', async () => {
    const { supabase, tables } = createFakeSupabase(
      { project_logs: [log()] },
      { failInserts: ['project_log_edits'] },
    )

    const result = await updateLogRecord({
      supabase,
      projectId: PROJECT,
      logId: 'log1',
      userId: USER,
      headcount: null,
      freeNotes: 'Changed',
      escalate: false,
      note: null,
    })

    expect(result.ok && result.message).toContain('db/updates_v1.sql')
    expect(tables.project_logs[0].free_notes).toBe('Changed')
  })
})

describe('deleteLogPhoto', () => {
  const photoRow = {
    id: 'ph1',
    project_id: PROJECT,
    project_log_id: 'log1',
    storage_path:
      'BLR-001/2026-10-06/evening/BLR-001_2026-10-06_evening_01.jpg',
    original_filename: 'IMG_1.jpg',
    question: 'Site photo',
  }

  it('removes the row and the stored object, and records it', async () => {
    const fake = createFakeSupabase({
      project_log_photos: [photoRow],
      project_log_edits: [],
    })

    const result = await deleteLogPhoto({
      supabase: fake.supabase,
      admin: fake.supabase,
      projectId: PROJECT,
      photoId: 'ph1',
      userId: USER,
      note: 'Wrong site',
    })

    expect(result).toEqual({ ok: true, message: 'Photo deleted.' })
    expect(fake.tables.project_log_photos).toHaveLength(0)
    expect(fake.removedObjects).toEqual([
      `site-photos/${photoRow.storage_path}`,
    ])
    expect(fake.tables.project_log_edits[0]).toMatchObject({
      kind: 'photo_deleted',
      project_log_id: 'log1',
      note: 'Wrong site',
      details: { storage_path: photoRow.storage_path },
    })
  })

  it("won't delete another project's photo", async () => {
    const fake = createFakeSupabase({ project_log_photos: [photoRow] })

    const result = await deleteLogPhoto({
      supabase: fake.supabase,
      admin: fake.supabase,
      projectId: 'other',
      photoId: 'ph1',
      userId: USER,
      note: null,
    })

    expect(result).toMatchObject({ ok: false })
    expect(fake.tables.project_log_photos).toHaveLength(1)
    expect(fake.removedObjects).toHaveLength(0)
  })
})

describe('submitMissedLog', () => {
  beforeEach(() => {
    ingest.mockReset()
    ingest.mockResolvedValue({
      ok: true,
      logDate: '2026-10-06',
      shift: 'evening',
    })
  })

  const base = {
    projectId: PROJECT,
    userId: USER,
    logDate: '2026-10-06',
    shift: 'evening' as const,
    headcount: { masons: '4', helpers: '' },
    taskRefs: ['W12'],
    freeNotes: 'Entered from the phone call',
    escalate: false,
    note: 'Engineer forgot the evening form',
    today: '2026-10-07',
  }

  it('enters the log through the normal ingestion path', async () => {
    const { supabase, tables } = createFakeSupabase({
      project_logs: [],
      project_log_edits: [],
    })

    const result = await submitMissedLog({ ...base, supabase })

    expect(result.ok).toBe(true)
    expect(ingest).toHaveBeenCalledTimes(1)
    const input = ingest.mock.calls[0][1]
    expect(input).toMatchObject({
      projectId: PROJECT,
      shift: 'evening',
      source: 'manual',
      submittedAt: '2026-10-06T12:00:00.000Z',
      formValues: {
        headcount: { masons: '4', helpers: null },
        targets_achieved: ['W12'],
        free_notes: 'Entered from the phone call',
        escalate_to_volecule: false,
      },
    })
    expect(input.externalSubmissionId).toMatch(/^manual-/)
    expect(tables.project_log_edits[0]).toMatchObject({
      kind: 'log_created',
      note: 'Engineer forgot the evening form',
    })
  })

  it("sends a morning log's ticks as starts, not achievements", async () => {
    const { supabase } = createFakeSupabase({ project_logs: [] })
    ingest.mockResolvedValue({
      ok: true,
      logDate: '2026-10-06',
      shift: 'morning',
    })

    await submitMissedLog({ ...base, supabase, shift: 'morning' })

    expect(ingest.mock.calls[0][1].formValues).toMatchObject({
      starts_confirmed: ['W12'],
    })
    expect(ingest.mock.calls[0][1].formValues).not.toHaveProperty(
      'targets_achieved',
    )
  })

  it("refuses when a log already exists, so the rules can't run twice", async () => {
    const { supabase } = createFakeSupabase({ project_logs: [log()] })

    const result = await submitMissedLog({ ...base, supabase })

    expect(result.ok === false && result.error).toContain('already exists')
    expect(ingest).not.toHaveBeenCalled()
  })

  it('refuses a future or invalid date', async () => {
    const { supabase } = createFakeSupabase({ project_logs: [] })

    expect(
      await submitMissedLog({ ...base, supabase, logDate: '2026-10-08' }),
    ).toMatchObject({ ok: false })
    expect(
      await submitMissedLog({ ...base, supabase, logDate: 'yesterday' }),
    ).toMatchObject({ ok: false })
    expect(ingest).not.toHaveBeenCalled()
  })

  it('passes ingestion errors back to the operator', async () => {
    const { supabase } = createFakeSupabase({ project_logs: [] })
    ingest.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Project is not active — submissions rejected',
    })

    const result = await submitMissedLog({ ...base, supabase })

    expect(result).toEqual({
      ok: false,
      error: 'Project is not active — submissions rejected',
    })
  })
})
