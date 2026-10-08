import { describe, expect, it } from 'vitest'
import { createFakeSupabase } from '@/test/fake-supabase'
import { PHOTO_BUCKET } from './photo-naming'
import { attachPhotos, signPhotoUploads } from './photo-ingest'

const PROJECT = { id: 'p1', public_code: 'BLR-001' }
const LOG = {
  id: 'log1',
  project_id: 'p1',
  log_date: '2026-10-07',
  shift: 'evening',
  external_submission_id: 'sub-1',
}
const ref = { projectId: '', projectCode: 'BLR-001' }

const PATH_1 = 'BLR-001/2026-10-07/evening/BLR-001_2026-10-07_evening_01.jpg'
const PATH_2 = 'BLR-001/2026-10-07/evening/BLR-001_2026-10-07_evening_02.jpg'
const PATH_3 = 'BLR-001/2026-10-07/evening/BLR-001_2026-10-07_evening_03.jpg'

function setup(photoRows: Record<string, unknown>[] = []) {
  return createFakeSupabase({
    projects: [PROJECT],
    project_logs: [LOG],
    project_log_photos: photoRows,
  })
}

const file = (driveFileId: string, overrides = {}) => ({
  driveFileId,
  originalFilename: `${driveFileId}.jpg`,
  mimeType: 'image/jpeg',
  sizeBytes: 2_000_000,
  question: 'Site photo',
  ...overrides,
})

describe('signPhotoUploads', () => {
  it('issues numbered paths and signed URLs, rejecting bad files without using up a number', async () => {
    const { supabase } = setup()

    const result = await signPhotoUploads({
      supabase,
      ref,
      externalSubmissionId: 'sub-1',
      files: [
        file('d1'),
        file('d2', { mimeType: 'application/pdf' }),
        file('d3', { sizeBytes: 50 * 1024 * 1024 }),
        file('d4', { mimeType: 'IMAGE/JPG' }),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files[0]).toMatchObject({
      driveFileId: 'd1',
      status: 'ready',
      path: PATH_1,
      contentType: 'image/jpeg',
    })
    expect(result.files[0]).toHaveProperty('uploadUrl')
    expect(result.files[1]).toEqual({
      driveFileId: 'd2',
      status: 'rejected',
      reason: 'unsupported_type',
    })
    expect(result.files[2]).toEqual({
      driveFileId: 'd3',
      status: 'rejected',
      reason: 'too_large',
    })
    // The rejected files didn't consume sequence numbers.
    expect(result.files[3]).toMatchObject({ status: 'ready', path: PATH_2 })
  })

  it('numbers a resubmission after the photos already filed under the log', async () => {
    const { supabase } = setup([
      {
        project_log_id: 'log1',
        drive_file_id: 'old',
        storage_path: PATH_2,
        sequence: 2,
      },
    ])

    const result = await signPhotoUploads({
      supabase,
      ref,
      externalSubmissionId: 'sub-1',
      files: [file('new')],
    })

    expect(result.ok && result.files[0]).toMatchObject({
      status: 'ready',
      path: PATH_3,
    })
  })

  it('tells a retry that an already-attached photo needs no upload', async () => {
    const { supabase } = setup([
      {
        project_log_id: 'log1',
        drive_file_id: 'd1',
        storage_path: PATH_1,
        sequence: 1,
      },
    ])

    const result = await signPhotoUploads({
      supabase,
      ref,
      externalSubmissionId: 'sub-1',
      files: [file('d1')],
    })

    expect(result.ok && result.files[0]).toEqual({
      driveFileId: 'd1',
      status: 'already_attached',
      path: PATH_1,
    })
  })

  it('returns the same paths when the same request is retried before attach', async () => {
    const { supabase } = setup()
    const request = {
      supabase,
      ref,
      externalSubmissionId: 'sub-1',
      files: [file('d1'), file('d2')],
    }

    const first = await signPhotoUploads(request)
    const second = await signPhotoUploads(request)

    const paths = (r: typeof first) =>
      r.ok ? r.files.map((f) => ('path' in f ? f.path : null)) : []
    expect(paths(second)).toEqual(paths(first))
  })

  it('refuses when the form data was never ingested', async () => {
    const { supabase } = setup()

    const result = await signPhotoUploads({
      supabase,
      ref,
      externalSubmissionId: 'does-not-exist',
      files: [file('d1')],
    })

    expect(result).toMatchObject({ ok: false, status: 404 })
  })

  it('rejects an unknown project and an empty file list', async () => {
    const { supabase } = setup()

    expect(
      await signPhotoUploads({
        supabase,
        ref: { projectId: '', projectCode: 'NOPE' },
        externalSubmissionId: 'sub-1',
        files: [file('d1')],
      }),
    ).toMatchObject({ ok: false, status: 400 })
    expect(
      await signPhotoUploads({
        supabase,
        ref,
        externalSubmissionId: 'sub-1',
        files: [],
      }),
    ).toMatchObject({ ok: false, status: 400 })
  })
})

describe('attachPhotos', () => {
  const photo = (path: string, driveFileId = 'd1') => ({
    driveFileId,
    path,
    originalFilename: 'IMG_001 - Rahul.jpg',
    question: 'Site photo',
  })

  it("records a verified photo using the stored object's type and size, not the caller's", async () => {
    const { supabase, tables, putObject } = setup()
    putObject(PHOTO_BUCKET, PATH_1, {
      size: 1_234_567,
      contentType: 'image/jpeg',
    })

    const result = await attachPhotos({
      supabase,
      ref,
      externalSubmissionId: 'sub-1',
      photos: [photo(PATH_1)],
    })

    expect(result).toEqual({ ok: true, attached: [PATH_1], rejected: [] })
    expect(tables.project_log_photos).toHaveLength(1)
    expect(tables.project_log_photos[0]).toMatchObject({
      project_id: 'p1',
      project_log_id: 'log1',
      storage_bucket: PHOTO_BUCKET,
      storage_path: PATH_1,
      sequence: 1,
      mime_type: 'image/jpeg',
      size_bytes: 1_234_567,
      original_filename: 'IMG_001 - Rahul.jpg',
      drive_file_id: 'd1',
      external_submission_id: 'sub-1',
    })
  })

  it('is idempotent — attaching the same path twice leaves one row', async () => {
    const { supabase, tables, putObject } = setup()
    putObject(PHOTO_BUCKET, PATH_1, { size: 100, contentType: 'image/jpeg' })
    const request = {
      supabase,
      ref,
      externalSubmissionId: 'sub-1',
      photos: [photo(PATH_1)],
    }

    await attachPhotos(request)
    await attachPhotos(request)

    expect(tables.project_log_photos).toHaveLength(1)
  })

  it('rejects an object that was never uploaded', async () => {
    const { supabase, tables } = setup()

    const result = await attachPhotos({
      supabase,
      ref,
      externalSubmissionId: 'sub-1',
      photos: [photo(PATH_1)],
    })

    expect(result).toEqual({
      ok: true,
      attached: [],
      rejected: [{ path: PATH_1, reason: 'object_missing' }],
    })
    expect(tables.project_log_photos).toHaveLength(0)
  })

  it("refuses paths that weren't issued for this project's log", async () => {
    const { supabase, tables, putObject } = setup()
    const otherDate =
      'BLR-001/2026-10-06/evening/BLR-001_2026-10-06_evening_01.jpg'
    putObject(PHOTO_BUCKET, otherDate, { size: 100, contentType: 'image/jpeg' })

    const result = await attachPhotos({
      supabase,
      ref,
      externalSubmissionId: 'sub-1',
      photos: [
        photo(otherDate, 'a'),
        photo(
          'OTHER-9/2026-10-07/evening/OTHER-9_2026-10-07_evening_01.jpg',
          'b',
        ),
        photo('../../etc/passwd', 'c'),
      ],
    })

    expect(result.ok && result.attached).toEqual([])
    expect(result.ok && result.rejected.map((r) => r.reason)).toEqual([
      'path_mismatch',
      'invalid_path',
      'invalid_path',
    ])
    expect(tables.project_log_photos).toHaveLength(0)
  })

  it('removes and rejects an oversized or non-image object', async () => {
    const { supabase, hasObject, putObject } = setup()
    putObject(PHOTO_BUCKET, PATH_1, {
      size: 40 * 1024 * 1024,
      contentType: 'image/jpeg',
    })
    putObject(PHOTO_BUCKET, PATH_2, {
      size: 100,
      contentType: 'application/pdf',
    })

    const result = await attachPhotos({
      supabase,
      ref,
      externalSubmissionId: 'sub-1',
      photos: [photo(PATH_1, 'a'), photo(PATH_2, 'b')],
    })

    expect(result.ok && result.rejected).toEqual([
      { path: PATH_1, reason: 'too_large' },
      { path: PATH_2, reason: 'unsupported_type' },
    ])
    expect(hasObject(PHOTO_BUCKET, PATH_1)).toBe(false)
    expect(hasObject(PHOTO_BUCKET, PATH_2)).toBe(false)
  })

  it("rejects an object whose type doesn't match the extension it was issued with", async () => {
    const { supabase, tables, hasObject, putObject } = setup()
    putObject(PHOTO_BUCKET, PATH_1, { size: 100, contentType: 'image/png' })

    const result = await attachPhotos({
      supabase,
      ref,
      externalSubmissionId: 'sub-1',
      photos: [photo(PATH_1)],
    })

    expect(result.ok && result.rejected).toEqual([
      { path: PATH_1, reason: 'type_mismatch' },
    ])
    expect(tables.project_log_photos).toHaveLength(0)
    // Not deleted: it is a valid image, it just wasn't uploaded as issued.
    expect(hasObject(PHOTO_BUCKET, PATH_1)).toBe(true)
  })
})
