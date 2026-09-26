'use client'

import { useActionState } from 'react'
import { refreshScheduleAction } from '@/app/protected/scheduler/actions'
import { Button } from '@/components/ui/button'

/**
 * Manual refresh sweep (spec §13 item C) — a single button, no date
 * picker. Unlike ConfirmStartForm (a deliberate backdating tool), this is
 * meant for "I'm checking in right now" — it always reconciles up through
 * the project's real current date, whatever the gap since the last real
 * form submission actually was (propagate.ts's catchupPushDays catches up
 * the whole gap in one step, so there's nothing an operator-chosen date
 * would add here). The date-override testing console has its own version
 * of this that does take a fake date, for exercising a gap without
 * waiting for real time to pass.
 */
export function RefreshSweepForm({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState(
    refreshScheduleAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="project_id" value={projectId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Refreshing…' : 'Refresh schedule'}
      </Button>
      {state && !state.success && (
        <p className="text-destructive max-w-[260px] text-right text-xs">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p className="max-w-[260px] text-right text-xs text-green-600">
          {state.message}
        </p>
      )}
    </form>
  )
}
