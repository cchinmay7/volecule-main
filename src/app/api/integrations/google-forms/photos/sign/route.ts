import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/supabase/admin'
import { checkIngestionSecret } from '@/utils/integrations/auth'
import { signPhotoUploads } from '@/utils/photos/photo-ingest'
import { parseProjectRef, parseSignFiles } from '@/utils/photos/request'

/**
 * POST /api/integrations/google-forms/photos/sign
 *
 * Step 1 of photo ingestion, called by Google Apps Script right AFTER it
 * has posted the form's own data to /submit (so the log already exists).
 * For each photo in the form response it returns where the photo should be
 * stored and a short-lived signed URL to PUT the bytes to — directly to
 * Supabase Storage, because a Vercel function can't accept a request body
 * over ~4.5 MB.
 *
 * Required headers:
 *   X-Volecule-Secret: <INGESTION_SHARED_SECRET>
 *
 * Body:
 *   project_code | project_id   (site_code / site_id accepted as aliases)
 *   external_submission_id      — the same id sent to /submit
 *   files: [{ drive_file_id, original_filename, mime_type, size_bytes,
 *             question }]
 *
 * Response:
 *   { ok, upload_headers, files: [
 *       { drive_file_id, status: "ready", path, upload_url, content_type }
 *     | { drive_file_id, status: "already_attached", path }
 *     | { drive_file_id, status: "rejected", reason } ] }
 *
 * The caller PUTs each "ready" file's bytes to upload_url with
 * upload_headers plus Content-Type: content_type, then calls
 * /photos/attach. See the "Site Photo Storage" design doc.
 */
export async function POST(req: NextRequest) {
  const unauthorized = checkIngestionSecret(req)
  if (unauthorized) return unauthorized

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const ref = parseProjectRef(body)
  if (!ref) {
    return NextResponse.json(
      { error: 'Provide either project_id or project_code' },
      { status: 400 },
    )
  }

  const externalSubmissionId =
    typeof body.external_submission_id === 'string'
      ? body.external_submission_id.trim()
      : ''
  if (!externalSubmissionId) {
    return NextResponse.json(
      { error: 'Missing or invalid external_submission_id' },
      { status: 400 },
    )
  }

  const files = parseSignFiles(body.files)
  if (!files) {
    return NextResponse.json(
      {
        error:
          'files must be an array of { drive_file_id, mime_type, ... } objects',
      },
      { status: 400 },
    )
  }

  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!publishableKey) {
    console.error('[photos] NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set')
    return NextResponse.json(
      { error: 'Server misconfiguration' },
      { status: 500 },
    )
  }

  const result = await signPhotoUploads({
    supabase: createAdminClient(),
    ref,
    externalSubmissionId,
    files,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({
    ok: true,
    // The gateway wants the project's public (publishable) key on every
    // Storage request; the signed token in the URL is what authorises the
    // write itself. Safe to hand to the caller — it's already public.
    upload_headers: {
      apikey: publishableKey,
      'x-upsert': 'true',
      'cache-control': 'max-age=3600',
    },
    files: result.files.map((file) => {
      if (file.status === 'ready') {
        return {
          drive_file_id: file.driveFileId,
          status: file.status,
          path: file.path,
          upload_url: file.uploadUrl,
          content_type: file.contentType,
        }
      }
      if (file.status === 'already_attached') {
        return {
          drive_file_id: file.driveFileId,
          status: file.status,
          path: file.path,
        }
      }
      return {
        drive_file_id: file.driveFileId,
        status: file.status,
        reason: file.reason,
      }
    }),
  })
}
