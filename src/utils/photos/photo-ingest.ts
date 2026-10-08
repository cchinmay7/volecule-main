import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MAX_PHOTOS_PER_SUBMISSION,
  MAX_PHOTO_BYTES,
  PHOTO_BUCKET,
  buildPhotoPath,
  isAllowedPhotoMimeType,
  normalizeMimeType,
  parsePhotoPath,
} from '@/utils/photos/photo-naming'

/**
 * Two-step photo ingestion for the Google Forms integration (see the "Site
 * Photo Storage" design doc):
 *
 *   1. signPhotoUploads  — for each photo Apps Script found in the form
 *      response, validate it and hand back a path (per the naming
 *      convention) plus a short-lived signed upload URL. Apps Script PUTs
 *      the bytes straight to Storage, so they never pass through a Vercel
 *      function (which would cap the request body at ~4.5 MB — smaller than
 *      a typical phone photo).
 *   2. attachPhotos      — once uploaded, verify each object really exists
 *      in the bucket (and is an image of a sane size) and record it in
 *      project_log_photos.
 *
 * Both run AFTER the form's own data has been ingested, so they look the
 * log up by its external_submission_id. A photo problem therefore can never
 * lose a log or delay schedule propagation, and the Drive file id travels
 * with every photo so anything that fails can be re-synced later.
 */

export type PhotoServiceError = { ok: false; status: number; error: string }

type ProjectRef = { projectId: string; projectCode: string }

type ResolvedContext = {
  projectId: string
  projectCode: string
  logId: string
  logDate: string
  shift: 'morning' | 'evening'
}

async function resolveContext(
  supabase: SupabaseClient,
  ref: ProjectRef,
  externalSubmissionId: string,
): Promise<{ ok: true; context: ResolvedContext } | PhotoServiceError> {
  const query = supabase.from('projects').select('id, public_code')
  const { data: project, error: projectError } = ref.projectId
    ? await query.eq('id', ref.projectId).maybeSingle()
    : await query.eq('public_code', ref.projectCode).maybeSingle()

  if (projectError) {
    return { ok: false, status: 500, error: 'Failed to look up project' }
  }
  if (!project) {
    return { ok: false, status: 400, error: 'Unknown project' }
  }
  if (!project.public_code) {
    return {
      ok: false,
      status: 400,
      error: 'Project has no public code, so photos cannot be filed',
    }
  }

  const { data: log, error: logError } = await supabase
    .from('project_logs')
    .select('id, log_date, shift')
    .eq('project_id', project.id)
    .eq('external_submission_id', externalSubmissionId)
    .maybeSingle()

  if (logError) {
    return { ok: false, status: 500, error: 'Failed to look up log' }
  }
  if (!log) {
    return {
      ok: false,
      status: 404,
      error: 'No log found for this submission — submit the form data first',
    }
  }

  return {
    ok: true,
    context: {
      projectId: project.id as string,
      projectCode: project.public_code as string,
      logId: log.id as string,
      logDate: log.log_date as string,
      shift: log.shift as 'morning' | 'evening',
    },
  }
}

// ---------------------------------------------------------------------------
// Step 1: sign
// ---------------------------------------------------------------------------

export type SignFileInput = {
  driveFileId: string
  originalFilename: string | null
  mimeType: string
  sizeBytes: number | null
  question: string | null
}

export type SignFileResult =
  | {
      driveFileId: string
      status: 'ready'
      path: string
      uploadUrl: string
      contentType: string
    }
  | { driveFileId: string; status: 'already_attached'; path: string }
  | { driveFileId: string; status: 'rejected'; reason: string }

type ExistingPhotoRow = {
  drive_file_id: string | null
  storage_path: string
  sequence: number
}

export async function signPhotoUploads({
  supabase,
  ref,
  externalSubmissionId,
  files,
}: {
  supabase: SupabaseClient
  ref: ProjectRef
  externalSubmissionId: string
  files: SignFileInput[]
}): Promise<{ ok: true; files: SignFileResult[] } | PhotoServiceError> {
  if (files.length === 0) {
    return { ok: false, status: 400, error: 'files must not be empty' }
  }
  if (files.length > MAX_PHOTOS_PER_SUBMISSION) {
    return {
      ok: false,
      status: 400,
      error: `At most ${MAX_PHOTOS_PER_SUBMISSION} photos per submission`,
    }
  }

  const resolved = await resolveContext(supabase, ref, externalSubmissionId)
  if (!resolved.ok) return resolved
  const { context } = resolved

  const { data: existingRows, error: existingError } = await supabase
    .from('project_log_photos')
    .select('drive_file_id, storage_path, sequence')
    .eq('project_log_id', context.logId)

  if (existingError) {
    return { ok: false, status: 500, error: 'Failed to read existing photos' }
  }

  const existing = (existingRows ?? []) as ExistingPhotoRow[]
  const pathByDriveFile = new Map(
    existing
      .filter((row) => row.drive_file_id !== null)
      .map((row) => [row.drive_file_id as string, row.storage_path]),
  )

  // New photos are numbered after everything already filed under this log,
  // so a resubmission for the same project/date/shift adds to the set
  // instead of overwriting the earlier evidence. Retrying the same request
  // before anything is attached yields the same numbers (nothing has
  // changed), which is what makes a retry land on the same paths.
  let nextSequence =
    existing.reduce((max, row) => Math.max(max, row.sequence), 0) + 1

  const results: SignFileResult[] = []
  for (const file of files) {
    const alreadyAttachedPath = pathByDriveFile.get(file.driveFileId)
    if (alreadyAttachedPath) {
      results.push({
        driveFileId: file.driveFileId,
        status: 'already_attached',
        path: alreadyAttachedPath,
      })
      continue
    }

    if (!isAllowedPhotoMimeType(file.mimeType)) {
      results.push({
        driveFileId: file.driveFileId,
        status: 'rejected',
        reason: 'unsupported_type',
      })
      continue
    }
    if (file.sizeBytes !== null && file.sizeBytes > MAX_PHOTO_BYTES) {
      results.push({
        driveFileId: file.driveFileId,
        status: 'rejected',
        reason: 'too_large',
      })
      continue
    }

    const contentType = normalizeMimeType(file.mimeType)
    const path = buildPhotoPath({
      projectCode: context.projectCode,
      logDate: context.logDate,
      shift: context.shift,
      sequence: nextSequence,
      mimeType: contentType,
    })
    if (!path) {
      results.push({
        driveFileId: file.driveFileId,
        status: 'rejected',
        reason: 'unsupported_type',
      })
      continue
    }

    // upsert: true so a retried upload of the same photo overwrites its own
    // earlier partial attempt instead of failing with "already exists".
    const { data: signed, error: signError } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUploadUrl(path, { upsert: true })

    if (signError || !signed) {
      console.error('[photos] failed to sign upload', signError)
      results.push({
        driveFileId: file.driveFileId,
        status: 'rejected',
        reason: 'sign_failed',
      })
      continue
    }

    nextSequence += 1
    results.push({
      driveFileId: file.driveFileId,
      status: 'ready',
      path,
      uploadUrl: signed.signedUrl,
      contentType,
    })
  }

  return { ok: true, files: results }
}

// ---------------------------------------------------------------------------
// Step 2: attach
// ---------------------------------------------------------------------------

export type AttachPhotoInput = {
  driveFileId: string | null
  path: string
  originalFilename: string | null
  question: string | null
}

export type AttachRejection = { path: string; reason: string }

export async function attachPhotos({
  supabase,
  ref,
  externalSubmissionId,
  photos,
}: {
  supabase: SupabaseClient
  ref: ProjectRef
  externalSubmissionId: string
  photos: AttachPhotoInput[]
}): Promise<
  | { ok: true; attached: string[]; rejected: AttachRejection[] }
  | PhotoServiceError
> {
  if (photos.length === 0) {
    return { ok: false, status: 400, error: 'photos must not be empty' }
  }
  if (photos.length > MAX_PHOTOS_PER_SUBMISSION) {
    return {
      ok: false,
      status: 400,
      error: `At most ${MAX_PHOTOS_PER_SUBMISSION} photos per submission`,
    }
  }

  const resolved = await resolveContext(supabase, ref, externalSubmissionId)
  if (!resolved.ok) return resolved
  const { context } = resolved

  const rejected: AttachRejection[] = []
  const rowsToWrite: Record<string, unknown>[] = []
  const seenPaths = new Set<string>()

  const checks = await Promise.all(
    photos.map(async (photo) => {
      if (seenPaths.has(photo.path)) {
        return { photo, reason: 'duplicate' as const }
      }
      seenPaths.add(photo.path)

      const parsed = parsePhotoPath(photo.path, context.projectCode)
      if (!parsed) return { photo, reason: 'invalid_path' as const }
      if (
        parsed.logDate !== context.logDate ||
        parsed.shift !== context.shift
      ) {
        return { photo, reason: 'path_mismatch' as const }
      }

      const { data: info, error: infoError } = await supabase.storage
        .from(PHOTO_BUCKET)
        .info(photo.path)
      if (infoError || !info) {
        return { photo, reason: 'object_missing' as const }
      }

      const mimeType = normalizeMimeType(info.contentType ?? '')
      const size = typeof info.size === 'number' ? info.size : null
      if (!isAllowedPhotoMimeType(mimeType)) {
        return { photo, reason: 'unsupported_type' as const, remove: true }
      }
      if (size !== null && size > MAX_PHOTO_BYTES) {
        return { photo, reason: 'too_large' as const, remove: true }
      }

      // The extension in the path was chosen from the type we signed; if the
      // stored object's type disagrees the upload didn't go as issued.
      const expectedPath = buildPhotoPath({
        projectCode: context.projectCode,
        logDate: parsed.logDate,
        shift: parsed.shift,
        sequence: parsed.sequence,
        mimeType,
      })
      if (expectedPath !== photo.path) {
        return { photo, reason: 'type_mismatch' as const }
      }

      return {
        photo,
        row: {
          project_id: context.projectId,
          project_log_id: context.logId,
          storage_bucket: PHOTO_BUCKET,
          storage_path: photo.path,
          sequence: parsed.sequence,
          original_filename: photo.originalFilename,
          mime_type: mimeType,
          size_bytes: size,
          question: photo.question,
          drive_file_id: photo.driveFileId,
          external_submission_id: externalSubmissionId,
        },
      }
    }),
  )

  const toRemove: string[] = []
  for (const check of checks) {
    if ('row' in check && check.row) {
      rowsToWrite.push(check.row)
      continue
    }
    if ('reason' in check) {
      rejected.push({ path: check.photo.path, reason: check.reason })
      if ('remove' in check && check.remove) toRemove.push(check.photo.path)
    }
  }

  if (toRemove.length > 0) {
    // An object that isn't a valid photo shouldn't sit in the bucket.
    const { error: removeError } = await supabase.storage
      .from(PHOTO_BUCKET)
      .remove(toRemove)
    if (removeError) {
      console.error('[photos] failed to remove invalid objects', removeError)
    }
  }

  if (rowsToWrite.length > 0) {
    const { error: upsertError } = await supabase
      .from('project_log_photos')
      .upsert(rowsToWrite, { onConflict: 'storage_bucket,storage_path' })

    if (upsertError) {
      console.error('[photos] failed to record photos', upsertError)
      return { ok: false, status: 500, error: 'Failed to record photos' }
    }
  }

  return {
    ok: true,
    attached: rowsToWrite.map((row) => row.storage_path as string),
    rejected,
  }
}
