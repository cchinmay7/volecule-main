'use client'

import { useActionState, useRef } from 'react'
import { importScheduleAction } from '@/app/protected/scheduler/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function ImportScheduleForm({ projectId }: { projectId: string }) {
  const formRef = useRef<HTMLFormElement>(null)
  const [state, formAction, pending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof importScheduleAction>> | null,
      formData: FormData,
    ) => {
      const result = await importScheduleAction(prevState, formData)
      if (result.success) formRef.current?.reset()
      return result
    },
    null,
  )

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="project_id" value={projectId} />
      <div className="space-y-2">
        <Label htmlFor="schedule_file">Schedule Zero (.xlsx)</Label>
        <Input
          id="schedule_file"
          name="file"
          type="file"
          accept=".xlsx"
          required
          disabled={pending}
        />
        <p className="text-muted-foreground text-xs">
          Expects WORK / ACTIVITY / PRED. / DUR (d) / START / FINISH columns.
          Re-uploading reconciles against the existing schedule by Task ID —
          matched tasks keep their progress, new ones are added, dropped ones
          are retired.
        </p>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Importing…' : 'Import schedule'}
      </Button>
      {state && !state.success && (
        <pre className="text-destructive text-sm whitespace-pre-wrap">
          {state.error}
        </pre>
      )}
      {state?.success && (
        <p className="text-sm text-green-600">{state.message}</p>
      )}
    </form>
  )
}
