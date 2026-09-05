'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/supabase/server'
import { createAdminClient } from '@/supabase/admin'
import {
  getAuthenticatedUserId,
  saveProjectWithPublicCodeRetries,
} from '@/app/protected/actions'
import {
  isPublicCodeConflict,
  parseProjectFormData,
} from '@/app/protected/project-form'
import { parseScheduleWorkbook } from '@/utils/scheduler/parse-excel'
import { importSchedule } from '@/utils/scheduler/import-schedule'
import type { ParseResult } from '@/utils/scheduler/types'

export type ImportScheduleResult =
  | { success: true; message: string }
  | { success: false; error: string }

export type InitializeProjectResult =
  | { success: true; message: string; projectId: string }
  | { success: false; error: string }

function formatParseErrors(
  parseResult: Extract<ParseResult, { ok: false }>,
): string {
  return parseResult.errors
    .map((e) => (e.row > 0 ? `Row ${e.row}: ${e.message}` : e.message))
    .join('\n')
}

async function recordScheduleImport({
  admin,
  projectId,
  file,
  parseResult,
  createdBy,
}: {
  admin: ReturnType<typeof createAdminClient>
  projectId: string
  file: File
  parseResult: Extract<ParseResult, { ok: true }>
  createdBy: string
}) {
  // Raw file archival is deferred — Vercel's serverless functions have no
  // persistent local filesystem (only /tmp, wiped per invocation), so
  // "store it locally" isn't viable in production the way it is in local
  // dev. Metadata is recorded now; real archival (Supabase Storage or
  // otherwise) is a later addition, not a blocker.
  await admin.from('schedule_imports').insert({
    project_id: projectId,
    schedule_version_id: null,
    storage_path: null,
    original_filename: file.name,
    row_count: parseResult.tasks.length,
    parsed_task_count: parseResult.tasks.length,
    parse_errors_json:
      parseResult.warnings.length > 0
        ? { warnings: parseResult.warnings }
        : null,
    created_by: createdBy,
  })
}

function warningNote(parseResult: Extract<ParseResult, { ok: true }>): string {
  return parseResult.warnings.length > 0
    ? ` (${parseResult.warnings.length} date warning${parseResult.warnings.length > 1 ? 's' : ''} — see details below)`
    : ''
}

/**
 * Re-imports a schedule for an EXISTING project — reconciled against its
 * current schedule_tasks by external_ref (spec §04/§09 decision 5).
 */
export async function importScheduleAction(
  _prev: ImportScheduleResult | null,
  formData: FormData,
): Promise<ImportScheduleResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const projectId = formData.get('project_id')?.toString().trim()
  if (!projectId) {
    return { success: false, error: 'Project is required.' }
  }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { success: false, error: 'An Excel file is required.' }
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  const parseResult = await parseScheduleWorkbook(buffer)
  if (!parseResult.ok) {
    return { success: false, error: formatParseErrors(parseResult) }
  }

  const admin = createAdminClient()

  const outcome = await importSchedule({
    supabase: admin,
    projectId,
    tasks: parseResult.tasks,
    createdBy: auth.userId,
  })

  if (!outcome.success) {
    return { success: false, error: outcome.error }
  }

  await recordScheduleImport({
    admin,
    projectId,
    file,
    parseResult,
    createdBy: auth.userId,
  })

  revalidatePath('/protected')
  revalidatePath(`/protected/projects/${projectId}`)
  revalidatePath(`/protected/projects/${projectId}/scheduler`)

  return {
    success: true,
    message: `Imported schedule version ${outcome.versionNumber}: ${outcome.created} new, ${outcome.updated} updated, ${outcome.retired} retired.${warningNote(parseResult)}`,
  }
}

/**
 * Creates a brand-new project, attaches it to an already-existing site
 * (site.project_id), and imports its Schedule Zero — all in one submit.
 * This is now the only way to create a project; the plain "create project"
 * flow (no schedule) has been retired in favor of this combined entry
 * point.
 */
export async function initializeProjectWithScheduleAction(
  _prev: InitializeProjectResult | null,
  formData: FormData,
): Promise<InitializeProjectResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const siteId = formData.get('site_id')?.toString().trim()
  if (!siteId) {
    return { success: false, error: 'Site is required.' }
  }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { success: false, error: 'An Excel file is required.' }
  }

  const parsed = parseProjectFormData(formData, { requireStatus: false })
  if ('error' in parsed) {
    return { success: false, error: parsed.error }
  }

  // Parse the workbook before writing anything — a bad file should fail
  // before a project or site attachment is created.
  const buffer = Buffer.from(await file.arrayBuffer())
  const parseResult = await parseScheduleWorkbook(buffer)
  if (!parseResult.ok) {
    return { success: false, error: formatParseErrors(parseResult) }
  }

  const supabase = await createClient()

  const { data: site, error: siteError } = await supabase
    .from('sites')
    .select('id, project_id')
    .eq('id', siteId)
    .maybeSingle()

  if (siteError || !site) {
    return { success: false, error: 'Site not found.' }
  }

  // Defensive re-check — the dropdown only lists unassigned sites, but a
  // second initialize could have claimed this one in between page load and
  // this submit. Never silently steal a site from another project.
  if (site.project_id) {
    return {
      success: false,
      error:
        'This site is already attached to another project. Refresh and pick a different one.',
    }
  }

  let createdProjectId: string | null = null

  const writeError = await saveProjectWithPublicCodeRetries({
    projectName: parsed.values.name,
    providedPublicCode: parsed.values.publicCode,
    writeWithPublicCode: async (publicCode) => {
      const { data, error } = await supabase
        .from('projects')
        .insert({
          name: parsed.values.name,
          public_code: publicCode,
          timezone: parsed.values.timezone,
          google_form_url_morning: parsed.values.googleFormUrlMorning,
          google_form_url_evening: parsed.values.googleFormUrlEvening,
          reminder_time_morning: parsed.values.reminderTimeMorning,
          reminder_time_evening: parsed.values.reminderTimeEvening,
          whatsapp_target: parsed.values.whatsappTarget,
          status: parsed.values.status,
          created_by: auth.userId,
        })
        .select('id')
        .single()

      if (!error && data) {
        createdProjectId = data.id as string
      }
      return error
    },
  })

  if (writeError && isPublicCodeConflict(writeError)) {
    return {
      success: false,
      error: 'Project code already exists. Use a different code.',
    }
  }
  if (writeError || !createdProjectId) {
    return {
      success: false,
      error: writeError?.message ?? 'Failed to create project.',
    }
  }

  const projectId: string = createdProjectId

  const { error: attachError } = await supabase
    .from('sites')
    .update({ project_id: projectId })
    .eq('id', siteId)

  if (attachError) {
    return {
      success: false,
      error: `Project "${parsed.values.name}" was created, but attaching the site failed: ${attachError.message}. The project exists without a schedule — fix the attachment and re-import from its detail page.`,
    }
  }

  const admin = createAdminClient()

  const outcome = await importSchedule({
    supabase: admin,
    projectId,
    tasks: parseResult.tasks,
    createdBy: auth.userId,
  })

  if (!outcome.success) {
    return {
      success: false,
      error: `Project "${parsed.values.name}" was created and the site attached, but the schedule failed to import: ${outcome.error}. Re-import from the project's detail page.`,
    }
  }

  await recordScheduleImport({
    admin,
    projectId,
    file,
    parseResult,
    createdBy: auth.userId,
  })

  revalidatePath('/protected')
  revalidatePath('/protected/projects')
  revalidatePath('/protected/sites')
  revalidatePath(`/protected/sites/${siteId}`)
  revalidatePath(`/protected/projects/${projectId}`)
  revalidatePath(`/protected/projects/${projectId}/scheduler`)

  return {
    success: true,
    projectId,
    message: `Project "${parsed.values.name}" created and schedule imported (version ${outcome.versionNumber}): ${outcome.created} tasks.${warningNote(parseResult)}`,
  }
}
