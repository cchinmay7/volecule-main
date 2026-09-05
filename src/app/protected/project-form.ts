// Plain module (no 'use server') — a file with that directive can only
// export async functions, since every export becomes a callable Server
// Action reference. This holds the sync validation/parsing logic shared by
// src/app/protected/actions.ts and src/app/protected/scheduler/actions.ts.

const DEFAULT_PROJECT_TIMEZONE = 'Asia/Kolkata'
const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/
const PROJECT_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/

export type EntityStatus = 'active' | 'inactive'

export type ProjectFormValues = {
  name: string
  publicCode: string | null
  timezone: string
  googleFormUrlMorning: string | null
  googleFormUrlEvening: string | null
  reminderTimeMorning: string | null
  reminderTimeEvening: string | null
  whatsappTarget: string | null
  status: EntityStatus
}

export type DbError = {
  code?: string
  message: string
}

function normalizePublicCode(input: string): string {
  return input.trim().replace(/\s+/g, '-').toUpperCase()
}

function buildPublicCodeBase(projectName: string): string {
  const normalized = projectName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized ? normalized.slice(0, 24) : 'PROJECT'
}

export function generatePublicCode(projectName: string): string {
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
  return `${buildPublicCodeBase(projectName)}-${suffix}`
}

export function isPublicCodeConflict(error: DbError | null): boolean {
  return Boolean(
    error?.code === '23505' &&
    error.message.toLowerCase().includes('projects_public_code_unique'),
  )
}

export function parseProjectFormData(
  formData: FormData,
  options: { requireStatus: boolean },
): { values: ProjectFormValues } | { error: string } {
  const name = formData.get('name')?.toString().trim()
  const rawPublicCode = formData.get('public_code')?.toString() ?? ''
  const publicCode = rawPublicCode ? normalizePublicCode(rawPublicCode) : null
  const timezone =
    formData.get('timezone')?.toString().trim() || DEFAULT_PROJECT_TIMEZONE
  const googleFormUrlMorning =
    formData.get('google_form_url_morning')?.toString().trim() || null
  const googleFormUrlEvening =
    formData.get('google_form_url_evening')?.toString().trim() || null
  const reminderTimeMorning =
    formData.get('reminder_time_morning')?.toString().trim() || null
  const reminderTimeEvening =
    formData.get('reminder_time_evening')?.toString().trim() || null
  const whatsappTarget =
    formData.get('whatsapp_target')?.toString().trim() || null
  const statusRaw = formData.get('status')?.toString().trim() || 'active'
  const status: EntityStatus = statusRaw === 'inactive' ? 'inactive' : 'active'

  if (!name) {
    return { error: 'Project name is required.' }
  }

  if (
    options.requireStatus &&
    statusRaw !== 'active' &&
    statusRaw !== 'inactive'
  ) {
    return { error: 'Project status must be active or inactive.' }
  }

  if (publicCode && !PROJECT_CODE_REGEX.test(publicCode)) {
    return {
      error:
        'Project code must be 2-64 chars using letters, numbers, underscores, or hyphens.',
    }
  }

  if (reminderTimeMorning && !HH_MM_REGEX.test(reminderTimeMorning)) {
    return { error: 'Morning reminder must be in HH:mm format.' }
  }

  if (reminderTimeEvening && !HH_MM_REGEX.test(reminderTimeEvening)) {
    return { error: 'Evening reminder must be in HH:mm format.' }
  }

  if (reminderTimeMorning && !googleFormUrlMorning) {
    return {
      error: 'Morning form URL is required when morning reminder is set.',
    }
  }

  if (reminderTimeEvening && !googleFormUrlEvening) {
    return {
      error: 'Evening form URL is required when evening reminder is set.',
    }
  }

  return {
    values: {
      name,
      publicCode,
      timezone,
      googleFormUrlMorning,
      googleFormUrlEvening,
      reminderTimeMorning,
      reminderTimeEvening,
      whatsappTarget,
      status,
    },
  }
}
