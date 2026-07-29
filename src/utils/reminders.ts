export type ReminderShift = 'morning' | 'evening'

export function buildReminderMessage(
  siteName: string,
  shift: ReminderShift,
  formUrl: string,
): string {
  const greeting = shift === 'morning' ? 'Good morning' : 'Good evening'
  const shiftLabel = shift === 'morning' ? 'morning' : 'evening'
  return `${greeting}! Please submit your ${shiftLabel} site log for *${siteName}*:\n${formUrl}`
}

export async function sendWhatsAppTemplate(
  to: string,
  formUrl: string,
  messageForLogs: string,
): Promise<boolean> {
  const apiUrl = process.env.WHATSAPP_API_URL
  const apiKey = process.env.WHATSAPP_API_KEY
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'hello_world'
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US'
  const templateBodyVar1Mode =
    process.env.WHATSAPP_TEMPLATE_BODY_VAR1_MODE || ''
  const templateButtonUrlVar1Mode =
    process.env.WHATSAPP_TEMPLATE_BUTTON_URL_VAR1_MODE || ''
  const templateButtonIndex = process.env.WHATSAPP_TEMPLATE_BUTTON_INDEX || '0'

  if (!apiUrl || !apiKey) {
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
      console.error(
        '[reminders] WhatsApp provider error',
        res.status,
        await res.text(),
      )
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
