'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/supabase/server'

const DEFAULT_SITE_TIMEZONE = 'Asia/Kolkata'
const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/

export type ActionResult = { success: true } | { success: false; error: string }

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

export async function createProjectAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const name = formData.get('name')?.toString().trim()
  const clientName = formData.get('client_name')?.toString().trim()

  if (!name || !clientName) {
    return { success: false, error: 'Project name and client name are required.' }
  }

  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('projects').insert({
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

  const projectId = formData.get('project_id')?.toString().trim()
  const name = formData.get('name')?.toString().trim()
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
  const whatsappTarget = formData.get('whatsapp_target')?.toString().trim() || null

  if (!projectId || !name) {
    return { success: false, error: 'Project and site name are required.' }
  }

  if (reminderTimeMorning && !HH_MM_REGEX.test(reminderTimeMorning)) {
    return { success: false, error: 'Morning reminder must be in HH:mm format.' }
  }

  if (reminderTimeEvening && !HH_MM_REGEX.test(reminderTimeEvening)) {
    return { success: false, error: 'Evening reminder must be in HH:mm format.' }
  }

  if (reminderTimeMorning && !googleFormUrlMorning) {
    return {
      success: false,
      error: 'Morning form URL is required when morning reminder is set.',
    }
  }

  if (reminderTimeEvening && !googleFormUrlEvening) {
    return {
      success: false,
      error: 'Evening form URL is required when evening reminder is set.',
    }
  }

  const supabase = await createClient()

  // Validate that the project exists and is active.
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, status')
    .eq('id', projectId)
    .single()

  if (projectError || !project) {
    return { success: false, error: 'Project not found.' }
  }

  if (project.status !== 'active') {
    return { success: false, error: 'Cannot add a site to an inactive project.' }
  }

  const { error } = await supabase.from('sites').insert({
    project_id: projectId,
    name,
    timezone,
    google_form_url_morning: googleFormUrlMorning,
    google_form_url_evening: googleFormUrlEvening,
    reminder_time_morning: reminderTimeMorning,
    reminder_time_evening: reminderTimeEvening,
    whatsapp_target: whatsappTarget,
  })

  if (error) {
    return { success: false, error: error.message }
  }

  revalidatePath('/protected')
  revalidatePath('/protected/projects')
  revalidatePath('/protected/sites')
  revalidatePath('/protected/logs')
  return { success: true }
}
