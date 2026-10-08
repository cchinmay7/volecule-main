/**
 * Site-photo storage conventions (see the "Site Photo Storage" design doc).
 *
 * Every photo lives in one private bucket under a path that identifies the
 * project, the log date and the shift, and whose filename repeats all of
 * that, so a file downloaded out of context still says what it is:
 *
 *   {project_code}/{YYYY-MM-DD}/{shift}/{project_code}_{YYYY-MM-DD}_{shift}_{NN}.{ext}
 *   BLR-001/2026-10-07/evening/BLR-001_2026-10-07_evening_01.jpg
 *
 * The extension comes from the verified MIME type, never from the
 * engineer's filename (which can be anything, including personal names);
 * the original filename is kept in the database instead.
 */

export const PHOTO_BUCKET = 'site-photos'
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024
export const MAX_PHOTOS_PER_SUBMISSION = 20

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

export const ALLOWED_PHOTO_MIME_TYPES = Object.keys(EXTENSION_BY_MIME)

/** Mime types a browser can render in an <img>; HEIC/HEIF are stored but
 * shown as a download link instead. */
export const BROWSER_RENDERABLE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
]

/** Lower-cases, strips parameters ("; charset=…") and folds the common
 * non-standard "image/jpg" alias into "image/jpeg". */
export function normalizeMimeType(raw: string): string {
  const base = raw.split(';')[0].trim().toLowerCase()
  return base === 'image/jpg' ? 'image/jpeg' : base
}

export function isAllowedPhotoMimeType(raw: string): boolean {
  return normalizeMimeType(raw) in EXTENSION_BY_MIME
}

/** Makes a project's public code safe to use as a path segment and as part
 * of a filename: anything outside [A-Za-z0-9._-] becomes "-". */
export function sanitizeCodeSegment(code: string): string {
  const cleaned = code
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.length > 0 ? cleaned : 'project'
}

function pad(sequence: number): string {
  return String(sequence).padStart(2, '0')
}

export function buildPhotoPath({
  projectCode,
  logDate,
  shift,
  sequence,
  mimeType,
}: {
  projectCode: string
  logDate: string
  shift: 'morning' | 'evening'
  sequence: number
  mimeType: string
}): string | null {
  const extension = EXTENSION_BY_MIME[normalizeMimeType(mimeType)]
  if (!extension || !Number.isInteger(sequence) || sequence < 1) return null

  const code = sanitizeCodeSegment(projectCode)
  return `${code}/${logDate}/${shift}/${code}_${logDate}_${shift}_${pad(sequence)}.${extension}`
}

export type ParsedPhotoPath = {
  logDate: string
  shift: 'morning' | 'evening'
  sequence: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Parses a path back into its parts, but only if it matches this project's
 * convention exactly — the folder and the filename must agree on date and
 * shift. Returns null for anything else, which is how `attach` refuses to
 * record an object that wasn't issued by `sign`. */
export function parsePhotoPath(
  path: string,
  projectCode: string,
): ParsedPhotoPath | null {
  const code = escapeRegExp(sanitizeCodeSegment(projectCode))
  const pattern = new RegExp(
    `^${code}/(\\d{4}-\\d{2}-\\d{2})/(morning|evening)/${code}_\\1_\\2_(\\d{2,})\\.(?:jpg|png|webp|heic|heif)$`,
  )
  const match = pattern.exec(path)
  if (!match) return null

  return {
    logDate: match[1],
    shift: match[2] as 'morning' | 'evening',
    sequence: Number(match[3]),
  }
}
