'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/supabase/server'
import { buildReminderMessage, sendWhatsAppTemplate } from '@/utils/reminders'
import {
  generatePublicCode,
  isPublicCodeConflict,
  parseProjectFormData,
  type DbError,
} from '@/app/protected/project-form'

const PROJECT_WRITE_MAX_RETRIES = 5

export type ActionResult = { success: true } | { success: false; error: string }

export async function getAuthenticatedUserId(): Promise<
  { userId: string } | { error: string }
> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user?.id) {
    return { error: 'You must be authenticated to perform this action.' }
  }
  return { userId: data.user.id }
}

export async function saveProjectWithPublicCodeRetries({
  projectName,
  providedPublicCode,
  writeWithPublicCode,
}: {
  projectName: string
  providedPublicCode: string | null
  writeWithPublicCode: (publicCode: string) => Promise<DbError | null>
}): Promise<DbError | null> {
  if (providedPublicCode) {
    return writeWithPublicCode(providedPublicCode)
  }

  let lastError: DbError | null = null

  for (let attempt = 0; attempt < PROJECT_WRITE_MAX_RETRIES; attempt += 1) {
    const generatedPublicCode = generatePublicCode(projectName)
    const error = await writeWithPublicCode(generatedPublicCode)
    if (!error) return null
    lastError = error
    if (!isPublicCodeConflict(error)) {
      return error
    }
  }

  return lastError
}

export async function createSiteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const name = formData.get('name')?.toString().trim()
  const clientName = formData.get('client_name')?.toString().trim()

  if (!name || !clientName) {
    return {
      success: false,
      error: 'Site name and client name are required.',
    }
  }

  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const supabase = await createClient()

  // A site precedes any project — it's a standalone top-level entity.
  // Projects are created under it later (from the Start page), and any
  // number of them can be.
  const { error } = await supabase.from('sites').insert({
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
  revalidatePath('/protected/start')
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
  if (!projectId) {
    return { success: false, error: 'Project id is required.' }
  }

  const siteId = formData.get('site_id')?.toString().trim() || null

  const parsed = parseProjectFormData(formData, { requireStatus: true })
  if ('error' in parsed) {
    return { success: false, error: parsed.error }
  }

  const supabase = await createClient()
  const { data: existingProject, error: existingProjectError } = await supabase
    .from('projects')
    .select('id, site_id')
    .eq('id', projectId)
    .maybeSingle()

  if (existingProjectError || !existingProject) {
    return { success: false, error: 'Project not found.' }
  }

  if (siteId) {
    const { data: site, error: siteError } = await supabase
      .from('sites')
      .select('id')
      .eq('id', siteId)
      .maybeSingle()

    if (siteError || !site) {
      return { success: false, error: 'Site not found.' }
    }
  }

  const writeError = await saveProjectWithPublicCodeRetries({
    projectName: parsed.values.name,
    providedPublicCode: parsed.values.publicCode,
    writeWithPublicCode: async (publicCode) => {
      const { error } = await supabase
        .from('projects')
        .update({
          site_id: siteId,
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
        .eq('id', projectId)
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
  revalidatePath(`/protected/projects/${projectId}`)
  revalidatePath('/protected/sites')
  if (existingProject.site_id) {
    revalidatePath(`/protected/sites/${existingProject.site_id}`)
  }
  if (siteId && siteId !== existingProject.site_id) {
    revalidatePath(`/protected/sites/${siteId}`)
  }
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
  const name = formData.get('name')?.toString().trim()
  const clientName = formData.get('client_name')?.toString().trim()
  const statusRaw = formData.get('status')?.toString().trim()

  if (!siteId || !name || !clientName) {
    return {
      success: false,
      error: 'Site id, site name, and client name are required.',
    }
  }

  if (statusRaw !== 'active' && statusRaw !== 'inactive') {
    return {
      success: false,
      error: 'Site status must be active or inactive.',
    }
  }

  const supabase = await createClient()

  const { data: existingSite, error: existingSiteError } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .maybeSingle()

  if (existingSiteError || !existingSite) {
    return { success: false, error: 'Site not found.' }
  }

  const { data, error } = await supabase
    .from('sites')
    .update({
      name,
      client_name: clientName,
      status: statusRaw,
    })
    .eq('id', siteId)
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
  revalidatePath('/protected/sites')
  revalidatePath(`/protected/sites/${siteId}`)
  revalidatePath('/protected/logs')
  return { success: true }
}

export async function sendProjectReminderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const projectId = formData.get('project_id')?.toString().trim()
  if (!projectId) {
    return { success: false, error: 'Project id is required.' }
  }

  const supabase = await createClient()

  const shiftRaw = formData.get('shift')?.toString().trim()
  if (shiftRaw !== 'morning' && shiftRaw !== 'evening') {
    return { success: false, error: 'Shift must be morning or evening.' }
  }

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select(
      'id, name, status, whatsapp_target, google_form_url_morning, google_form_url_evening',
    )
    .eq('id', projectId)
    .maybeSingle()

  if (projectError || !project) {
    return { success: false, error: 'Project not found.' }
  }

  if (project.status !== 'active') {
    return {
      success: false,
      error: 'Project must be active to send reminders.',
    }
  }

  if (!project.whatsapp_target) {
    return { success: false, error: 'WhatsApp target is required.' }
  }

  const formUrl =
    shiftRaw === 'morning'
      ? project.google_form_url_morning
      : project.google_form_url_evening

  if (!formUrl) {
    return {
      success: false,
      error:
        shiftRaw === 'morning'
          ? 'Morning form URL is required.'
          : 'Evening form URL is required.',
    }
  }

  const message = buildReminderMessage(project.name, shiftRaw, formUrl)
  const sent = await sendWhatsAppTemplate(
    project.whatsapp_target,
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
    return { success: false, error: 'Project id is required.' }
  }

  const supabase = await createClient()
  const { data: existingProject, error: existingProjectError } = await supabase
    .from('projects')
    .select('id, name, site_id')
    .eq('id', projectId)
    .maybeSingle()

  if (existingProjectError || !existingProject) {
    return { success: false, error: 'Project not found.' }
  }

  const confirmName = formData.get('confirm_name')?.toString().trim()
  if (confirmName !== (existingProject.name as string).trim()) {
    return {
      success: false,
      error: 'Type the exact project name to confirm deletion.',
    }
  }

  // Deleting a project never touches its site (or any sibling projects
  // under it) — a site precedes its projects, not the other way round,
  // so it always outlives them.
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
      error: 'Project exists but could not be deleted due to database policy.',
    }
  }

  revalidatePath('/protected')
  revalidatePath('/protected/projects')
  revalidatePath(`/protected/projects/${projectId}`)
  revalidatePath('/protected/sites')
  if (existingProject.site_id) {
    revalidatePath(`/protected/sites/${existingProject.site_id}`)
  }
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
    return { success: false, error: 'Site id is required.' }
  }

  const supabase = await createClient()

  const { data: existingSite, error: existingSiteError } = await supabase
    .from('sites')
    .select('id, name')
    .eq('id', siteId)
    .maybeSingle()

  if (existingSiteError || !existingSite) {
    return { success: false, error: 'Site not found.' }
  }

  const confirmName = formData.get('confirm_name')?.toString().trim()
  if (confirmName !== (existingSite.name as string).trim()) {
    return {
      success: false,
      error: 'Type the exact site name to confirm deletion.',
    }
  }

  // A site precedes its projects (one site, many projects). Deleting it
  // deletes every project under it via projects.site_id's real
  // on-delete-cascade FK — and, transitively, each of those projects' own
  // schedule_tasks/project_logs/etc. — no application-level fan-out
  // needed here.
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
      error: 'Site exists but could not be deleted due to database policy.',
    }
  }

  revalidatePath('/protected')
  revalidatePath('/protected/projects')
  revalidatePath('/protected/sites')
  revalidatePath(`/protected/sites/${siteId}`)
  revalidatePath('/protected/logs')
  return { success: true }
}
