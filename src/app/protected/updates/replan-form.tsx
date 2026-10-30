'use client'

import { useActionState, useId } from 'react'
import { replanScheduleAction } from '@/app/protected/updates/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Upload a new schedule spreadsheet. "Check sheet" says what would change
 * without touching anything; "Replace upcoming tasks" applies it.
 */
export function ReplanForm({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState(
    replanScheduleAction,
    null,
  )
  const id = useId()

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        const submitter = (event.nativeEvent as SubmitEvent)
          .submitter as HTMLButtonElement | null
        if (
          submitter?.value === 'apply' &&
          !window.confirm(
            'Delete every task that has not started and rebuild them from this sheet?',
          )
        ) {
          event.preventDefault()
        }
      }}
      className="space-y-3"
    >
      <input type="hidden" name="project_id" value={projectId} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-file`} className="text-xs">
            New schedule (.xlsx)
          </Label>
          <Input
            id={`${id}-file`}
            name="file"
            type="file"
            accept=".xlsx"
            required
            disabled={pending}
            className="h-9 text-xs"
          />
        </div>
        <div className="min-w-[180px] flex-1 space-y-1">
          <Label htmlFor={`${id}-note`} className="text-xs">
            Note (why)
          </Label>
          <Input
            id={`${id}-note`}
            name="note"
            placeholder="Optional"
            disabled={pending}
            className="h-9 text-xs"
          />
        </div>
        <Button
          type="submit"
          name="mode"
          value="preview"
          size="sm"
          variant="outline"
          disabled={pending}
        >
          Check sheet
        </Button>
        <Button
          type="submit"
          name="mode"
          value="apply"
          size="sm"
          variant="destructive"
          disabled={pending}
        >
          {pending ? 'Working…' : 'Replace upcoming tasks'}
        </Button>
      </div>

      {state && !state.success && (
        <pre className="text-destructive text-xs whitespace-pre-wrap">
          {state.error}
        </pre>
      )}
      {state?.success && (
        <pre className="text-xs whitespace-pre-wrap text-green-600">
          {state.message}
        </pre>
      )}
    </form>
  )
}
