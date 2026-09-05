'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/supabase/server'
import { createAdminClient } from '@/supabase/admin'
import { parseScheduleWorkbook } from '@/utils/scheduler/parse-excel'
import { importSchedule } from '@/utils/scheduler/import-schedule'

export type ImportScheduleResult =
  | { success: true; message: string }
  | { success: false; error: string }

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
    return {
      success: false,
      error: parseResult.errors
        .map((e) => (e.row > 0 ? `Row ${e.row}: ${e.message}` : e.message))
        .join('\n'),
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
    return { success: false, error: outcome.error }
  }

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
    created_by: auth.userId,
  })

  revalidatePath('/protected')
  revalidatePath(`/protected/projects/${projectId}`)

  const warningNote =
    parseResult.warnings.length > 0
      ? ` (${parseResult.warnings.length} date warning${parseResult.warnings.length > 1 ? 's' : ''} — see details below)`
      : ''

  return {
    success: true,
    message: `Imported schedule version ${outcome.versionNumber}: ${outcome.created} new, ${outcome.updated} updated, ${outcome.retired} retired.${warningNote}`,
  }
}
