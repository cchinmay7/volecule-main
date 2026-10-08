import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/supabase/admin'
import { checkIngestionSecret } from '@/utils/integrations/auth'
import { attachPhotos } from '@/utils/photos/photo-ingest'
import { parseAttachPhotos, parseProjectRef } from '@/utils/photos/request'

/**
 * POST /api/integrations/google-forms/photos/attach
 *
 * Step 2 of photo ingestion: after Apps Script has PUT the bytes to the
 * signed URLs from /photos/sign, it calls this with the paths. Each object
 * is checked to really exist in the bucket (and to be an image of a sane
 * size) before being recorded in project_log_photos — a path that wasn't
 * issued by /photos/sign for this project's log is refused.
 *
 * Required headers:
 *   X-Volecule-Secret: <INGESTION_SHARED_SECRET>
 *
 * Body:
 *   project_code | project_id   (site_code / site_id accepted as aliases)
 *   external_submission_id      — the same id sent to /submit
 *   photos: [{ path, drive_file_id, original_filename, question }]
 *
 * Response:
 *   { ok, attached: [path…], rejected: [{ path, reason }…] }
 *
 * Idempotent: re-attaching a path just refreshes its row.
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

  const photos = parseAttachPhotos(body.photos)
  if (!photos) {
    return NextResponse.json(
      { error: 'photos must be an array of { path, ... } objects' },
      { status: 400 },
    )
  }

  const result = await attachPhotos({
    supabase: createAdminClient(),
    ref,
    externalSubmissionId,
    photos,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({
    ok: true,
    attached: result.attached,
    rejected: result.rejected,
  })
}
