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
import {
  ingestFormSubmission,
  recordIngestionFlags,
} from '@/utils/scheduler/ingest-submission'
import { applyConfirmedStarts } from '@/utils/scheduler/propagate'
import { filterEligibleCandidates } from '@/utils/scheduler/gating'
import type { ParseResult } from '@/utils/scheduler/types'

export type ImportScheduleResult =
  | { success: true; message: string }
  | { success: false; error: string }

export type SubmitTestLogResult =
  | { success: true; message: string }
  | { success: false; error: string }

export type ConfirmTaskStartResult =
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
 * Creates a brand-new project under an already-existing site
 * (projects.site_id) and imports its Schedule Zero — all in one submit.
 * A site precedes its projects and can have several, so this never
 * "claims" or reassigns the site — it only ever adds a new project under
 * it. This is now the only way to create a project; the plain "create
 * project" flow (no schedule) has been retired in favor of this combined
 * entry point.
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
    .select('id')
    .eq('id', siteId)
    .maybeSingle()

  if (siteError || !site) {
    return { success: false, error: 'Site not found.' }
  }

  let createdProjectId: string | null = null

  const writeError = await saveProjectWithPublicCodeRetries({
    projectName: parsed.values.name,
    providedPublicCode: parsed.values.publicCode,
    writeWithPublicCode: async (publicCode) => {
      const { data, error } = await supabase
        .from('projects')
        .insert({
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

/**
 * Date-override testing console (spec §11 item 2) — exercises the exact
 * same ingestion + propagation code path a real evening Google Forms
 * submission takes (src/utils/scheduler/ingest-submission.ts), but with
 * an operator-chosen fake date instead of waiting for real time to pass.
 * A visibly separate, clearly-labelled entry point — not folded into the
 * normal operator workflow.
 */
export async function submitTestLogAction(
  _prev: SubmitTestLogResult | null,
  formData: FormData,
): Promise<SubmitTestLogResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const projectId = formData.get('project_id')?.toString().trim()
  if (!projectId) {
    return { success: false, error: 'Project is required.' }
  }

  const shift = formData.get('shift')?.toString()
  if (shift !== 'morning' && shift !== 'evening') {
    return { success: false, error: 'Shift must be "morning" or "evening".' }
  }

  const fakeDate = formData.get('fake_date')?.toString().trim()
  if (!fakeDate || !/^\d{4}-\d{2}-\d{2}$/.test(fakeDate)) {
    return { success: false, error: 'A valid date (YYYY-MM-DD) is required.' }
  }

  const achievedRefs = formData
    .getAll('achieved_task_ref')
    .map((v) => v.toString())
  const startedRefs = formData
    .getAll('started_task_ref')
    .map((v) => v.toString())

  const admin = createAdminClient()

  const externalSubmissionId = `test-console-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`

  const result = await ingestFormSubmission(admin, {
    projectId,
    projectCode: '',
    shift,
    externalSubmissionId,
    // Anchored at noon UTC so the timezone conversion in
    // toLocalDateString can't roll it onto the adjacent calendar day.
    submittedAt: `${fakeDate}T12:00:00.000Z`,
    formValues: {
      targets_achieved: achievedRefs,
      starts_confirmed: startedRefs,
      free_notes: 'Submitted via the date-override testing console.',
    },
    sourcePayload: {
      test_console: true,
      fake_date: fakeDate,
      achieved_task_refs: achievedRefs,
      started_task_refs: startedRefs,
    },
    source: 'manual',
  })

  if (!result.ok) {
    return { success: false, error: result.error }
  }

  revalidatePath(`/protected/projects/${projectId}/scheduler`)
  revalidatePath('/protected/scheduler/test')

  return {
    success: true,
    message: `Simulated ${shift} submission for ${fakeDate} (log_date resolved to ${result.logDate}). Refresh the project's scheduler view to see the effect.`,
  }
}

/**
 * Manual fallback for confirming a task's start independent of the
 * Google Form entirely (spec §12 open question (j)) — for the case a
 * morning form was never submitted at all, leaving a task stuck at
 * Delayed:Start with no automatic way out. Explicitly a catch-up tool:
 * the operator picks the date the work actually started, which can be
 * backdated ("actually started Monday, nobody submitted the form").
 *
 * Same eligibility gate as the automated morning trigger applies — this
 * does not bypass open question (b)'s predecessor check. A confirm
 * attempt for a task whose predecessors aren't all done is rejected and
 * flagged exactly like an invalid tick coming through the real form,
 * not silently allowed just because a human clicked the button. Whether
 * an operator should eventually be able to force past that gate with an
 * explicit override is a separate, smaller open question, not resolved
 * here.
 *
 * Reuses applyConfirmedStarts — the exact same function the morning
 * trigger calls — with change_reason: 'manual_override' instead of the
 * default 'confirmed_start', so the audit trail distinguishes a
 * form-driven confirmation from a human-initiated one.
 */
export async function confirmTaskStartAction(
  _prev: ConfirmTaskStartResult | null,
  formData: FormData,
): Promise<ConfirmTaskStartResult> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }

  const taskId = formData.get('task_id')?.toString().trim()
  const projectId = formData.get('project_id')?.toString().trim()
  if (!taskId || !projectId) {
    return { success: false, error: 'Task and project are required.' }
  }

  const startDate = formData.get('start_date')?.toString().trim()
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return {
      success: false,
      error: 'A valid start date (YYYY-MM-DD) is required.',
    }
  }

  const admin = createAdminClient()

  const { data: task, error: taskError } = await admin
    .from('schedule_tasks')
    .select('id, project_id, status, actual_start')
    .eq('id', taskId)
    .maybeSingle()

  if (taskError || !task || task.project_id !== projectId) {
    return { success: false, error: 'Task not found.' }
  }

  if (task.status !== 'pending') {
    return {
      success: false,
      error: `Only a pending task can be confirmed started (this one is ${task.status}).`,
    }
  }

  if (task.actual_start) {
    return {
      success: false,
      error: `Already confirmed started on ${task.actual_start}.`,
    }
  }

  const gate = await filterEligibleCandidates(admin, [taskId])
  if (!gate.ok) {
    return { success: false, error: gate.error }
  }

  if (!gate.eligibleTaskIds.has(taskId)) {
    await recordIngestionFlags(
      admin,
      projectId,
      null,
      'start_confirmed_before_predecessor_done',
      [
        {
          taskId,
          detail: `Manually confirmed started on ${startDate} by an operator, but a predecessor wasn't done yet.`,
        },
      ],
    )
    return {
      success: false,
      error:
        "This task's predecessors aren't all done yet — can't confirm a start ahead of them. Flagged for the record.",
    }
  }

  const outcome = await applyConfirmedStarts({
    supabase: admin,
    projectId,
    confirmedTaskIds: [taskId],
    confirmedDate: startDate,
    triggerProjectLogId: null,
    changeReason: 'manual_override',
  })

  if (!outcome.success) {
    return { success: false, error: outcome.error }
  }

  revalidatePath(`/protected/projects/${projectId}/scheduler`)

  return {
    success: true,
    message: `Confirmed started on ${startDate}. ${outcome.tasksChanged} task(s) updated.`,
  }
}
