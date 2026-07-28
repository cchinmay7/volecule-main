import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/supabase/admin'

/**
 * POST /api/reminders/send
 *
 * Call this from a cron job (e.g. Vercel Cron or Supabase pg_cron) every minute.
 * It reads all active sites whose morning or evening reminder time matches
 * the current time in the site's local timezone, then sends a WhatsApp message
 * with the correct Google Form link.
 *
 * Protected by the same shared secret used for ingestion.
 * Header: X-Volecule-Secret: <INGESTION_SHARED_SECRET>
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-volecule-secret')
  const expectedSecret = process.env.INGESTION_SHARED_SECRET

  if (!expectedSecret || !secret || secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()

  const { data: sites, error } = await supabase
    .from('sites')
    .select(
      'id, name, timezone, reminder_time_morning, reminder_time_evening, google_form_url_morning, google_form_url_evening, whatsapp_target',
    )
    .eq('status', 'active')

  if (error) {
    console.error('[reminders] failed to fetch sites', error)
    return NextResponse.json({ error: 'Failed to load sites' }, { status: 500 })
  }

  const now = new Date()
  const currentMinuteUtc = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`

  const dispatched: string[] = []
  const failed: string[] = []

  for (const site of sites ?? []) {
    const localHHMM = toLocalHHMM(now, site.timezone)

    for (const shift of ['morning', 'evening'] as const) {
      const reminderTime =
        shift === 'morning' ? site.reminder_time_morning : site.reminder_time_evening
      const formUrl =
        shift === 'morning' ? site.google_form_url_morning : site.google_form_url_evening

      if (!reminderTime || !formUrl || !site.whatsapp_target) continue

      // Compare HH:mm only (seconds may differ in stored value)
      const storedHHMM = reminderTime.slice(0, 5)
      if (storedHHMM !== localHHMM) continue

      const message = buildReminderMessage(site.name, shift, formUrl)
      const ok = await sendWhatsAppTemplate(site.whatsapp_target, formUrl, message)

      if (ok) {
        dispatched.push(`${site.id}:${shift}`)
      } else {
        failed.push(`${site.id}:${shift}`)
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

function buildReminderMessage(
  siteName: string,
  shift: 'morning' | 'evening',
  formUrl: string,
): string {
  const greeting = shift === 'morning' ? 'Good morning' : 'Good evening'
  const shiftLabel = shift === 'morning' ? 'morning' : 'evening'
  return `${greeting}! Please submit your ${shiftLabel} site log for *${siteName}*:\n${formUrl}`
}

/**
 * Send a WhatsApp template message via Meta Cloud API.
 * Wire up WHATSAPP_API_URL and WHATSAPP_API_KEY in .env.local.
 * Optional env vars:
 * - WHATSAPP_TEMPLATE_NAME (default: hello_world)
 * - WHATSAPP_TEMPLATE_LANG (default: en_US)
 * - WHATSAPP_TEMPLATE_BODY_VAR1_MODE=form_url
 * - WHATSAPP_TEMPLATE_BUTTON_URL_VAR1_MODE=form_url
 * - WHATSAPP_TEMPLATE_BUTTON_INDEX=0
 * Returns true on success.
 */
async function sendWhatsAppTemplate(
  to: string,
  formUrl: string,
  messageForLogs: string,
): Promise<boolean> {
  const apiUrl = process.env.WHATSAPP_API_URL
  const apiKey = process.env.WHATSAPP_API_KEY
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'hello_world'
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US'
  const templateBodyVar1Mode = process.env.WHATSAPP_TEMPLATE_BODY_VAR1_MODE || ''
  const templateButtonUrlVar1Mode =
    process.env.WHATSAPP_TEMPLATE_BUTTON_URL_VAR1_MODE || ''
  const templateButtonIndex = process.env.WHATSAPP_TEMPLATE_BUTTON_INDEX || '0'

  if (!apiUrl || !apiKey) {
    // Provider not configured — log and treat as a no-op in development.
    console.warn(
      '[reminders] WhatsApp provider not configured. Would send to',
      to,
      ':',
      messageForLogs,
    )
    return true
  }

  try {
    const normalizedTo = normalizeToE164Digits(to)

    if (!normalizedTo) {
      console.error('[reminders] Invalid whatsapp_target format:', to)
      return false
    }

    const components: Array<{
      type: 'body' | 'button'
      sub_type?: 'url'
      index?: string
      parameters: Array<{ type: 'text'; text: string }>
    }> = []

    if (templateBodyVar1Mode === 'form_url') {
      components.push({
        type: 'body',
        parameters: [{ type: 'text', text: formUrl }],
      })
    }

    if (templateButtonUrlVar1Mode === 'form_url') {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: templateButtonIndex,
        parameters: [{ type: 'text', text: formUrl }],
      })
    }

    const template: {
      name: string
      language: { code: string }
      components?: Array<{
        type: 'body' | 'button'
        sub_type?: 'url'
        index?: string
        parameters: Array<{ type: 'text'; text: string }>
      }>
    } = {
      name: templateName,
      language: { code: templateLang },
    }

    if (components.length > 0) {
      template.components = components
    }

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalizedTo,
        type: 'template',
        template,
      }),
    })

    if (!res.ok) {
      console.error('[reminders] WhatsApp provider error', res.status, await res.text())
      return false
    }

    return true
  } catch (err) {
    console.error('[reminders] WhatsApp send exception', err)
    return false
  }
}

function normalizeToE164Digits(to: string): string | null {
  const digitsOnly = to.replace(/\D/g, '')
  return digitsOnly.length >= 8 && digitsOnly.length <= 15 ? digitsOnly : null
}
