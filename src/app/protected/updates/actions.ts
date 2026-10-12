'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/supabase/admin'
import { getAuthenticatedUserId } from '@/app/protected/actions'
import { toLocalDateString } from '@/utils/dates'
import {
  deleteLogPhoto,
  submitMissedLog,
  updateLogRecord,
} from '@/utils/logs/log-corrections'
import {
  clearTaskStart,
  markTaskDone,
  renameTask,
  reopenTask,
  setTaskDates,
  setTaskStart,
} from '@/utils/scheduler/corrections'

/**
 * Server actions behind the Updates page. They authenticate the operator,
 * pull the fields out of the form, and hand off to the tested correction
 * functions in utils/scheduler/corrections.ts and utils/logs/
 * log-corrections.ts; the rules live there, not here.
 */

export type UpdateActionState =
  | { success: true; message: string }
  | { success: false; error: string }

type Outcome = { ok: true; message: string } | { ok: false; error: string }

function toState(outcome: Outcome): UpdateActionState {
  return outcome.ok
    ? { success: true, message: outcome.message }
    : { success: false, error: outcome.error }
}

function field(formData: FormData, name: string): string {
  return formData.get(name)?.toString().trim() ?? ''
}

function optionalField(formData: FormData, name: string): string | null {
  const value = field(formData, name)
  return value === '' ? null : value
}

/** Headcount inputs are posted as hc__<key>; collects them back into an
 * object, or null if the form carried none. */
function headcountFrom(formData: FormData): Record<string, string> | null {
  const headcount: Record<string, string> = {}
  for (const [name, value] of formData.entries()) {
    if (name.startsWith('hc__')) {
      headcount[name.slice('hc__'.length)] = value.toString()
    }
  }
  return Object.keys(headcount).length > 0 ? headcount : null
}

async function withProject(
  formData: FormData,
  run: (context: {
    admin: ReturnType<typeof createAdminClient>
    projectId: string
    userId: string
    today: string
  }) => Promise<Outcome>,
): Promise<UpdateActionState> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) return { success: false, error: auth.error }

  const projectId = field(formData, 'project_id')
  if (!projectId) return { success: false, error: 'Project is required.' }

  const admin = createAdminClient()
  const { data: project, error } = await admin
    .from('projects')
    .select('timezone')
    .eq('id', projectId)
    .maybeSingle()
  if (error || !project) return { success: false, error: 'Project not found.' }

  const today = toLocalDateString(new Date(), project.timezone as string)
  const outcome = await run({ admin, projectId, userId: auth.userId, today })

  revalidatePath('/protected/updates')
  revalidatePath('/protected/logs')
  revalidatePath(`/protected/projects/${projectId}/scheduler`)

  return toState(outcome)
}

export async function markTaskDoneAction(
  _prev: UpdateActionState | null,
  formData: FormData,
): Promise<UpdateActionState> {
  return withProject(formData, ({ admin, projectId, today }) =>
    markTaskDone({
      supabase: admin,
      projectId,
      taskId: field(formData, 'task_id'),
      actualEnd: field(formData, 'actual_end'),
      startedOn: optionalField(formData, 'started_on'),
      note: optionalField(formData, 'note'),
      today,
    }),
  )
}

export async function reopenTaskAction(
  _prev: UpdateActionState | null,
  formData: FormData,
): Promise<UpdateActionState> {
  return withProject(formData, ({ admin, projectId, today }) =>
    reopenTask({
      supabase: admin,
      projectId,
      taskId: field(formData, 'task_id'),
      newEnd: field(formData, 'new_end'),
      note: optionalField(formData, 'note'),
      today,
    }),
  )
}

export async function setTaskStartAction(
  _prev: UpdateActionState | null,
  formData: FormData,
): Promise<UpdateActionState> {
  return withProject(formData, ({ admin, projectId, today }) =>
    setTaskStart({
      supabase: admin,
      projectId,
      taskId: field(formData, 'task_id'),
      startDate: field(formData, 'start_date'),
      note: optionalField(formData, 'note'),
      today,
    }),
  )
}

export async function clearTaskStartAction(
  _prev: UpdateActionState | null,
  formData: FormData,
): Promise<UpdateActionState> {
  return withProject(formData, ({ admin, projectId, today }) =>
    clearTaskStart({
      supabase: admin,
      projectId,
      taskId: field(formData, 'task_id'),
      expectedStart: field(formData, 'expected_start'),
      note: optionalField(formData, 'note'),
      today,
    }),
  )
}

export async function setTaskDatesAction(
  _prev: UpdateActionState | null,
  formData: FormData,
): Promise<UpdateActionState> {
  return withProject(formData, ({ admin, projectId, today }) =>
    setTaskDates({
      supabase: admin,
      projectId,
      taskId: field(formData, 'task_id'),
      start: field(formData, 'start'),
      end: field(formData, 'end'),
      note: optionalField(formData, 'note'),
      today,
    }),
  )
}

export async function renameTaskAction(
  _prev: UpdateActionState | null,
  formData: FormData,
): Promise<UpdateActionState> {
  return withProject(formData, ({ admin, projectId, userId }) =>
    renameTask({
      supabase: admin,
      projectId,
      taskId: field(formData, 'task_id'),
      name: field(formData, 'name'),
      userId,
      note: optionalField(formData, 'note'),
    }),
  )
}

export async function updateLogAction(
  _prev: UpdateActionState | null,
  formData: FormData,
): Promise<UpdateActionState> {
  return withProject(formData, ({ admin, projectId, userId }) =>
    updateLogRecord({
      supabase: admin,
      projectId,
      logId: field(formData, 'log_id'),
      userId,
      headcount: headcountFrom(formData),
      freeNotes: optionalField(formData, 'free_notes'),
      escalate: formData.get('escalate') === 'on',
      note: optionalField(formData, 'note'),
    }),
  )
}

export async function deleteLogPhotoAction(
  _prev: UpdateActionState | null,
  formData: FormData,
): Promise<UpdateActionState> {
  return withProject(formData, ({ admin, projectId, userId }) =>
    deleteLogPhoto({
      supabase: admin,
      admin,
      projectId,
      photoId: field(formData, 'photo_id'),
      userId,
      note: optionalField(formData, 'note'),
    }),
  )
}

export async function submitMissedLogAction(
  _prev: UpdateActionState | null,
  formData: FormData,
): Promise<UpdateActionState> {
  const shift = field(formData, 'shift')
  if (shift !== 'morning' && shift !== 'evening') {
    return { success: false, error: 'Shift must be morning or evening.' }
  }

  return withProject(formData, ({ admin, projectId, userId, today }) =>
    submitMissedLog({
      supabase: admin,
      projectId,
      userId,
      logDate: field(formData, 'log_date'),
      shift,
      headcount: headcountFrom(formData) ?? {},
      taskRefs: formData.getAll('task_ref').map((value) => value.toString()),
      freeNotes: optionalField(formData, 'free_notes'),
      escalate: formData.get('escalate') === 'on',
      note: optionalField(formData, 'note'),
      today,
    }),
  )
}
