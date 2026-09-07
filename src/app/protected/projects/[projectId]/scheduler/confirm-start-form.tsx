'use client'

import { useActionState } from 'react'
import { confirmTaskStartAction } from '@/app/protected/scheduler/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Manual fallback for confirming a task's start independent of the
 * Google Form (spec §12 open question (j)) — shown next to any task that
 * hasn't been confirmed started yet, for the case a morning form was
 * never submitted and the task is stuck with no automatic way out.
 * Defaults to today but is editable, since this is explicitly a catch-up
 * tool ("actually started Monday, nobody submitted the form").
 */
export function ConfirmStartForm({
  projectId,
  taskId,
  defaultDate,
}: {
  projectId: string
  taskId: string
  defaultDate: string
}) {
  const [state, formAction, pending] = useActionState(
    confirmTaskStartAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="task_id" value={taskId} />
      <div className="flex items-center gap-1.5">
        <Input
          type="date"
          name="start_date"
          defaultValue={defaultDate}
          disabled={pending}
          className="h-7 w-[130px] text-xs"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={pending}
          className="h-7 px-2 text-xs"
        >
          {pending ? 'Confirming…' : 'Confirm start'}
        </Button>
      </div>
      {state && !state.success && (
        <p className="text-destructive max-w-[220px] text-right text-xs">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p className="max-w-[220px] text-right text-xs text-green-600">
          {state.message}
        </p>
      )}
    </form>
  )
}
