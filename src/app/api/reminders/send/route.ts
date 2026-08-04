import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/supabase/admin'
import { buildReminderMessage, sendWhatsAppTemplate } from '@/utils/reminders'

/**
 * /api/reminders/send
 *
 * Call this from a cron job (e.g. Vercel Cron or Supabase pg_cron) every minute.
 * It reads all active projects whose morning or evening reminder time matches
 * the current time in the project's local timezone, then sends a WhatsApp message
 * with the correct Google Form link.
 *
 * Supports either:
 * - Header: Authorization: Bearer <CRON_SECRET> (Vercel Cron)
 * - Header: X-Volecule-Secret: <INGESTION_SHARED_SECRET> (manual/internal calls)
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runReminderDispatch()
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runReminderDispatch()
}

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  const isCronAuthorized = Boolean(
    cronSecret && authHeader === `Bearer ${cronSecret}`,
  )

  const secret = req.headers.get('x-volecule-secret')
  const expectedSecret = process.env.INGESTION_SHARED_SECRET
  const isIngestionAuthorized = Boolean(
    expectedSecret && secret === expectedSecret,
  )

  return isCronAuthorized || isIngestionAuthorized
}

async function runReminderDispatch() {
  const supabase = createAdminClient()

  const { data: projects, error } = await supabase
    .from('projects')
    .select(
      'id, name, timezone, reminder_time_morning, reminder_time_evening, google_form_url_morning, google_form_url_evening, whatsapp_target',
    )
    .eq('status', 'active')

  if (error) {
    console.error('[reminders] failed to fetch projects', error)
    return NextResponse.json(
      { error: 'Failed to load projects' },
      { status: 500 },
    )
  }

  const now = new Date()
  const currentMinuteUtc = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`

  const dispatched: string[] = []
  const failed: string[] = []

  for (const project of projects ?? []) {
    const localHHMM = toLocalHHMM(now, project.timezone)

    for (const shift of ['morning', 'evening'] as const) {
      const reminderTime =
        shift === 'morning'
          ? project.reminder_time_morning
          : project.reminder_time_evening
      const formUrl =
        shift === 'morning'
          ? project.google_form_url_morning
          : project.google_form_url_evening

      if (!reminderTime || !formUrl || !project.whatsapp_target) continue

      // Compare HH:mm only (seconds may differ in stored value)
      const storedHHMM = reminderTime.slice(0, 5)
      if (storedHHMM !== localHHMM) continue

      const message = buildReminderMessage(project.name, shift, formUrl)
      const ok = await sendWhatsAppTemplate(
        project.whatsapp_target,
        formUrl,
        message,
      )

      if (ok) {
        dispatched.push(`${project.id}:${shift}`)
      } else {
        failed.push(`${project.id}:${shift}`)
      }
    }
  }

  console.info(
    `[reminders] ${now.toISOString()} utc=${currentMinuteUtc} dispatched=${dispatched.length} failed=${failed.length}`,
  )

  return NextResponse.json({ dispatched, failed })
}

function toLocalHHMM(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date)

    const h = parts.find((p) => p.type === 'hour')?.value
    const m = parts.find((p) => p.type === 'minute')?.value

    if (h && m) return `${h}:${m}`
  } catch {
    console.warn('[reminders] Invalid timezone', timezone)
  }
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}
