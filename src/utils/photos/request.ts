import type {
  AttachPhotoInput,
  SignFileInput,
} from '@/utils/photos/photo-ingest'

export type ParsedProjectRef = { projectId: string; projectCode: string }

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNullableString(value: unknown): string | null {
  const trimmed = asString(value)
  return trimmed === '' ? null : trimmed
}

/** Same project addressing as the main submit endpoint, including the
 * site_id / site_code aliases older Apps Script copies still send. */
export function parseProjectRef(
  body: Record<string, unknown>,
): ParsedProjectRef | null {
  const projectId = asString(body.project_id) || asString(body.site_id)
  const projectCode = asString(body.project_code) || asString(body.site_code)
  if (!projectId && !projectCode) return null
  return { projectId, projectCode }
}

export function parseSignFiles(value: unknown): SignFileInput[] | null {
  if (!Array.isArray(value)) return null

  const files: SignFileInput[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const raw = item as Record<string, unknown>

    const driveFileId = asString(raw.drive_file_id)
    const mimeType = asString(raw.mime_type)
    if (!driveFileId || !mimeType) return null

    const size = raw.size_bytes
    files.push({
      driveFileId,
      originalFilename: asNullableString(raw.original_filename),
      mimeType,
      sizeBytes:
        typeof size === 'number' && Number.isFinite(size) && size >= 0
          ? size
          : null,
      question: asNullableString(raw.question),
    })
  }
  return files
}

export function parseAttachPhotos(value: unknown): AttachPhotoInput[] | null {
  if (!Array.isArray(value)) return null

  const photos: AttachPhotoInput[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const raw = item as Record<string, unknown>

    const path = asString(raw.path)
    if (!path) return null

    photos.push({
      driveFileId: asNullableString(raw.drive_file_id),
      path,
      originalFilename: asNullableString(raw.original_filename),
      question: asNullableString(raw.question),
    })
  }
  return photos
}
