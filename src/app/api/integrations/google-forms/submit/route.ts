import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/supabase/admin'
import { ingestFormSubmission } from '@/utils/scheduler/ingest-submission'

/**
 * POST /api/integrations/google-forms/submit
 *
 * Called by Google Apps Script onFormSubmit triggers.
 * Required headers:
 *   X-Volecule-Secret: <INGESTION_SHARED_SECRET>
 *
 * Required body fields:
 *   project_id         — UUID of the project (preferred when available), OR
 *   project_code       — stable public code of the project (e.g. BLR-001)
 *   shift              — "morning" | "evening" (hidden form field)
 *   external_submission_id — unique ID from Apps Script (timestamp+formId)
 *   submitted_at       — ISO 8601 timestamp of the form submission
 *   form_values        — object with the engineer's answers
 *
 * Backward-compatible aliases accepted:
 *   site_id, site_code
 *
 * Optional body fields (under form_values):
 *   headcount             — object/array
 *   targets_selected      — object/array
 *   targets_achieved      — object/array
 *   free_notes            — string
 *   escalate_to_volecule  — boolean, or a "yes"/"true"/"escalate" string
 *
 * The actual log-upsert + schedule-propagation logic lives in
 * src/utils/scheduler/ingest-submission.ts, shared with the date-override
 * testing console (spec §11 item 2) so both go through the exact same
 * code path.
 */
export async function POST(req: NextRequest) {
  // 1. Shared secret check
  const secret = req.headers.get('x-volecule-secret')
  const expectedSecret = process.env.INGESTION_SHARED_SECRET

  if (!expectedSecret) {
    console.error('[ingestion] INGESTION_SHARED_SECRET is not set')
    return NextResponse.json(
      { error: 'Server misconfiguration' },
      { status: 500 },
    )
  }

  if (!secret || secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Parse body
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const {
    project_id,
    project_code,
    site_id,
    site_code,
    shift,
    external_submission_id,
    submitted_at,
    form_values,
  } = body

  // 3. Validate required fields
  const projectId =
    typeof project_id === 'string'
      ? project_id.trim()
      : typeof site_id === 'string'
        ? site_id.trim()
        : ''
  const projectCode =
    typeof project_code === 'string'
      ? project_code.trim()
      : typeof site_code === 'string'
        ? site_code.trim()
        : ''

  if (!projectId && !projectCode) {
    return NextResponse.json(
      { error: 'Provide either project_id or project_code' },
      { status: 400 },
    )
  }

  if (shift !== 'morning' && shift !== 'evening') {
    return NextResponse.json(
      { error: 'shift must be "morning" or "evening"' },
      { status: 400 },
    )
  }

  if (!external_submission_id || typeof external_submission_id !== 'string') {
    return NextResponse.json(
      { error: 'Missing or invalid external_submission_id' },
      { status: 400 },
    )
  }

  if (!submitted_at || typeof submitted_at !== 'string') {
    return NextResponse.json(
      { error: 'Missing or invalid submitted_at' },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()

  const result = await ingestFormSubmission(supabase, {
    projectId,
    projectCode,
    shift,
    externalSubmissionId: external_submission_id,
    submittedAt: submitted_at,
    formValues: (form_values ?? {}) as Record<string, unknown>,
    sourcePayload: body,
    source: 'google_form',
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json(
    { ok: true, log_date: result.logDate, shift: result.shift },
    { status: 200 },
  )
}
