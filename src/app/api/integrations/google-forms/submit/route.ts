import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/supabase/admin'

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
 *   headcount          — object/array
 *   targets_selected   — object/array
 *   targets_achieved   — object/array
 *   free_notes         — string
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

  const submittedDate = new Date(submitted_at)
  if (isNaN(submittedDate.getTime())) {
    return NextResponse.json(
      { error: 'submitted_at is not a valid ISO 8601 timestamp' },
      { status: 400 },
    )
  }

  // 4. Look up project and resolve log_date using project timezone
  const supabase = createAdminClient()

  const query = supabase
    .from('projects')
    .select('id, public_code, status, timezone')
  const { data: project, error: projectError } = projectId
    ? await query.eq('id', projectId).single()
    : await query.eq('public_code', projectCode).single()

  if (projectError || !project) {
    const idType = projectId ? 'project_id' : 'project_code'
    return NextResponse.json({ error: `Unknown ${idType}` }, { status: 400 })
  }

  if (projectId && projectCode && project.public_code !== projectCode) {
    return NextResponse.json(
      {
        error: 'project_id and project_code do not match the same project',
      },
      { status: 400 },
    )
  }

  if (project.status !== 'active') {
    return NextResponse.json(
      { error: 'Project is not active — submissions rejected' },
      { status: 400 },
    )
  }

  // Derive log_date in the project's local timezone
  const logDate = toLocalDateString(submittedDate, project.timezone)

  // 5. Map payload fields
  const fv = (form_values ?? {}) as Record<string, unknown>
  const headcountJson = fv.headcount ?? null
  const targetsSelectedJson = fv.targets_selected ?? null
  const targetsAchievedJson = fv.targets_achieved ?? null
  const freeNotes = typeof fv.free_notes === 'string' ? fv.free_notes : null

  // 6. Upsert — idempotent on (project_id, log_date, shift)
  const { error: upsertError } = await supabase.from('project_logs').upsert(
    {
      project_id: project.id,
      log_date: logDate,
      shift,
      headcount_json: headcountJson,
      targets_selected_json: targetsSelectedJson,
      targets_achieved_json: targetsAchievedJson,
      free_notes: freeNotes,
      source: 'google_form',
      external_submission_id,
      source_payload_json: body,
    },
    {
      onConflict: 'project_id,log_date,shift',
      ignoreDuplicates: false,
    },
  )

  if (upsertError) {
    console.error('[ingestion] upsert error', upsertError)
    return NextResponse.json({ error: 'Failed to save log' }, { status: 500 })
  }

  return NextResponse.json(
    { ok: true, log_date: logDate, shift },
    { status: 200 },
  )
}

/**
 * Convert a UTC Date to a YYYY-MM-DD string in the target IANA timezone.
 * Falls back to UTC if the timezone is invalid.
 */
function toLocalDateString(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)

    const year = parts.find((p) => p.type === 'year')?.value
    const month = parts.find((p) => p.type === 'month')?.value
    const day = parts.find((p) => p.type === 'day')?.value

    if (year && month && day) return `${year}-${month}-${day}`
  } catch {
    console.warn(
      '[ingestion] Invalid timezone',
      timezone,
      '— falling back to UTC',
    )
  }
  return date.toISOString().slice(0, 10)
}
