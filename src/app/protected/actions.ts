'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/supabase/server'
import { buildReminderMessage, sendWhatsAppTemplate } from '@/utils/reminders'

const DEFAULT_SITE_TIMEZONE = 'Asia/Kolkata'
const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/
const SITE_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/
const SITE_WRITE_MAX_RETRIES = 5

export type ActionResult = { success: true } | { success: false; error: string }
type SiteStatus = 'active' | 'inactive'

type SiteFormValues = {
  name: string
  publicCode: string | null
  timezone: string
  googleFormUrlMorning: string | null
  googleFormUrlEvening: string | null
  reminderTimeMorning: string | null
  reminderTimeEvening: string | null
  whatsappTarget: string | null
  status: SiteStatus
}

type DbError = {
  code?: string
  message: string
}

async function getAuthenticatedUserId(): Promise<
  { userId: string } | { error: string }
> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user?.id) {
    return { error: 'You must be authenticated to perform this action.' }
  }
  return { userId: data.user.id }
}

function normalizePublicCode(input: string): string {
  return input.trim().replace(/\s+/g, '-').toUpperCase()
}

function buildPublicCodeBase(siteName: string): string {
  const normalized = siteName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized ? normalized.slice(0, 24) : 'SITE'
}

function generatePublicCode(siteName: string): string {
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
  return `${buildPublicCodeBase(siteName)}-${suffix}`
}

function isPublicCodeConflict(error: DbError | null): boolean {
  return Boolean(
    error?.code === '23505' &&
    error.message.toLowerCase().includes('sites_public_code_unique'),
  )
}

function parseSiteFormData(
  formData: FormData,
  options: { requireStatus: boolean },
): { values: SiteFormValues } | { error: string } {
  const name = formData.get('name')?.toString().trim()
  const rawPublicCode = formData.get('public_code')?.toString() ?? ''
  const publicCode = rawPublicCode ? normalizePublicCode(rawPublicCode) : null
  const timezone =
    formData.get('timezone')?.toString().trim() || DEFAULT_SITE_TIMEZONE
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
  const status: SiteStatus = statusRaw === 'inactive' ? 'inactive' : 'active'

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

  if (publicCode && !SITE_CODE_REGEX.test(publicCode)) {
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

async function saveSiteWithPublicCodeRetries({
  siteName,
  providedPublicCode,
  writeWithPublicCode,
}: {
  siteName: string
  providedPublicCode: string | null
  writeWithPublicCode: (publicCode: string) => Promise<DbError | null>
}): Promise<DbError | null> {
  if (providedPublicCode) {
    return writeWithPublicCode(providedPublicCode)
  }

  let lastError: DbError | null = null

  for (let attempt = 0; attempt < SITE_WRITE_MAX_RETRIES; attempt += 1) {
    const generatedPublicCode = generatePublicCode(siteName)
    const error = await writeWithPublicCode(generatedPublicCode)
    if (!error) return null
    lastError = error
    if (!isPublicCodeConflict(error)) {
      return error
    }
  }

  return lastError
}

export async function createProjectAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const name = formData.get('name')?.toString().trim()
  const clientName = formData.get('client_name')?.toString().trim()
  const siteId = formData.get('site_id')?.toString().trim()

  if (!name || !clientName || !siteId) {
    return {
      success: false,
      error: 'Site name, client name, and project are required.',
    }
  }

  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const supabase = await createClient()

  const { data: site, error: siteError } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .maybeSingle()

  if (siteError || !site) {
    return { success: false, error: 'Project not found.' }
  }

  const { error } = await supabase.from('projects').insert({
    site_id: siteId,
    name,
    client_name: clientName,
    created_by: auth.userId,
  })

  if (error) {
    return { success: false, error: error.message }
  }

  revalidatePath('/protected')
  revalidatePath('/protected/projects')
  revalidatePath('/protected/sites')
  revalidatePath(`/protected/sites/${siteId}`)
  return { success: true }
}

export async function createSiteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const parsed = parseSiteFormData(formData, { requireStatus: false })
  if ('error' in parsed) {
    return { success: false, error: parsed.error }
  }

  const supabase = await createClient()

  const writeError = await saveSiteWithPublicCodeRetries({
    siteName: parsed.values.name,
    providedPublicCode: parsed.values.publicCode,
    writeWithPublicCode: async (publicCode) => {
      const { error } = await supabase.from('sites').insert({
        name: parsed.values.name,
        public_code: publicCode,
        timezone: parsed.values.timezone,
        google_form_url_morning: parsed.values.googleFormUrlMorning,
        google_form_url_evening: parsed.values.googleFormUrlEvening,
        reminder_time_morning: parsed.values.reminderTimeMorning,
        reminder_time_evening: parsed.values.reminderTimeEvening,
        whatsapp_target: parsed.values.whatsappTarget,
      })
      return error
    },
  })

  if (writeError && isPublicCodeConflict(writeError)) {
    return {
      success: false,
      error: 'Project code already exists. Use a different code.',
    }
  }

  if (writeError) {
    return { success: false, error: writeError.message }
  }

  revalidatePath('/protected')
  revalidatePath('/protected/projects')
  revalidatePath('/protected/sites')
  revalidatePath('/protected/logs')
  return { success: true }
}

export async function updateProjectAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const projectId = formData.get('project_id')?.toString().trim()
  const siteId = formData.get('site_id')?.toString().trim()
  const name = formData.get('name')?.toString().trim()
  const clientName = formData.get('client_name')?.toString().trim()
  const statusRaw = formData.get('status')?.toString().trim()

  if (!projectId || !siteId || !name || !clientName) {
    return {
      success: false,
      error:
        'Site id, linked project, site name, and client name are required.',
    }
  }

  if (statusRaw !== 'active' && statusRaw !== 'inactive') {
    return {
      success: false,
      error: 'Site status must be active or inactive.',
    }
  }

  const supabase = await createClient()

  const { data: site, error: siteError } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .maybeSingle()

  if (siteError || !site) {
    return { success: false, error: 'Project not found.' }
  }

  const { data, error } = await supabase
    .from('projects')
    .update({
      site_id: siteId,
      name,
      client_name: clientName,
      status: statusRaw,
    })
    .eq('id', projectId)
    .select('id')
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  if (!data) {
    return { success: false, error: 'Site not found.' }
  }

  revalidatePath('/protected')
  revalidatePath('/protected/projects')
  revalidatePath(`/protected/projects/${projectId}`)
  revalidatePath('/protected/sites')
  revalidatePath(`/protected/sites/${siteId}`)
  revalidatePath('/protected/logs')
  return { success: true }
}

export async function updateSiteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const siteId = formData.get('site_id')?.toString().trim()
  if (!siteId) {
    return { success: false, error: 'Project id is required.' }
  }

  const parsed = parseSiteFormData(formData, { requireStatus: true })
  if ('error' in parsed) {
    return { success: false, error: parsed.error }
  }

  const supabase = await createClient()

  const { data: existingSite, error: existingSiteError } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .maybeSingle()

  if (existingSiteError || !existingSite) {
    return { success: false, error: 'Project not found.' }
  }

  const writeError = await saveSiteWithPublicCodeRetries({
    siteName: parsed.values.name,
    providedPublicCode: parsed.values.publicCode,
    writeWithPublicCode: async (publicCode) => {
      const { error } = await supabase
        .from('sites')
        .update({
          name: parsed.values.name,
          public_code: publicCode,
          timezone: parsed.values.timezone,
          google_form_url_morning: parsed.values.googleFormUrlMorning,
          google_form_url_evening: parsed.values.googleFormUrlEvening,
          reminder_time_morning: parsed.values.reminderTimeMorning,
          reminder_time_evening: parsed.values.reminderTimeEvening,
          whatsapp_target: parsed.values.whatsappTarget,
          status: parsed.values.status,
        })
        .eq('id', siteId)
        .select('id')
        .single()

      return error
    },
  })

  if (writeError && isPublicCodeConflict(writeError)) {
    return {
      success: false,
      error: 'Project code already exists. Use a different code.',
    }
  }

  if (writeError) {
    return { success: false, error: writeError.message }
  }

  revalidatePath('/protected')
  revalidatePath('/protected/projects')
  revalidatePath('/protected/sites')
  revalidatePath(`/protected/sites/${siteId}`)
  revalidatePath('/protected/logs')
  return { success: true }
}

export async function sendSiteReminderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const siteId = formData.get('site_id')?.toString().trim()
  if (!siteId) {
    return { success: false, error: 'Project id is required.' }
  }

  const shiftRaw = formData.get('shift')?.toString().trim()
  if (shiftRaw !== 'morning' && shiftRaw !== 'evening') {
    return { success: false, error: 'Shift must be morning or evening.' }
  }

  const supabase = await createClient()
  const { data: site, error: siteError } = await supabase
    .from('sites')
    .select(
      'id, name, status, whatsapp_target, google_form_url_morning, google_form_url_evening',
    )
    .eq('id', siteId)
    .maybeSingle()

  if (siteError || !site) {
    return { success: false, error: 'Project not found.' }
  }

  if (site.status !== 'active') {
    return {
      success: false,
      error: 'Project must be active to send reminders.',
    }
  }

  if (!site.whatsapp_target) {
    return { success: false, error: 'WhatsApp target is required.' }
  }

  const formUrl =
    shiftRaw === 'morning'
      ? site.google_form_url_morning
      : site.google_form_url_evening

  if (!formUrl) {
    return {
      success: false,
      error:
        shiftRaw === 'morning'
          ? 'Morning form URL is required.'
          : 'Evening form URL is required.',
    }
  }

  const message = buildReminderMessage(site.name, shiftRaw, formUrl)
  const sent = await sendWhatsAppTemplate(
    site.whatsapp_target,
    formUrl,
    message,
  )

  if (!sent) {
    return {
      success: false,
      error:
        'Failed to send reminder. Check WhatsApp credentials and recipient access.',
    }
  }

  return { success: true }
}

export async function deleteProjectAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const projectId = formData.get('project_id')?.toString().trim()
  if (!projectId) {
    return { success: false, error: 'Site id is required.' }
  }

  const supabase = await createClient()
  const { data: existingProject, error: existingProjectError } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle()

  if (existingProjectError || !existingProject) {
    return { success: false, error: 'Site not found.' }
  }

  const { data: deletedProject, error } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId)
    .select('id')
    .maybeSingle()

  if (error) {
    return { success: false, error: error.message }
  }

  if (!deletedProject) {
    return {
      success: false,
      error: 'Site exists but could not be deleted due to database policy.',
    }
  }

  revalidatePath('/protected')
  revalidatePath('/protected/projects')
  revalidatePath(`/protected/projects/${projectId}`)
  revalidatePath('/protected/sites')
  revalidatePath('/protected/logs')
  return { success: true }
}

export async function deleteSiteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const siteId = formData.get('site_id')?.toString().trim()
  if (!siteId) {
    return { success: false, error: 'Project id is required.' }
  }

  const supabase = await createClient()

  const { data: existingSite, error: existingSiteError } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .maybeSingle()

  if (existingSiteError || !existingSite) {
    return { success: false, error: 'Project not found.' }
  }

  const { data: deletedSite, error } = await supabase
    .from('sites')
    .delete()
    .eq('id', siteId)
    .select('id')
    .maybeSingle()

  if (error) {
    return { success: false, error: error.message }
  }

  if (!deletedSite) {
    return {
      success: false,
      error: 'Project exists but could not be deleted due to database policy.',
    }
  }

  revalidatePath('/protected')
  revalidatePath('/protected/projects')
  revalidatePath('/protected/sites')
  revalidatePath(`/protected/sites/${siteId}`)
  revalidatePath('/protected/logs')
  return { success: true }
}
