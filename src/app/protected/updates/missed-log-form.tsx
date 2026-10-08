'use client'

import { useActionState, useId, useState } from 'react'
import { submitMissedLogAction } from '@/app/protected/updates/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type ChecklistTask = {
  ref: string
  name: string
  started: boolean
}

/**
 * Enter a morning or evening log the engineer never submitted. Goes through
 * the same ingestion path as the Google Form, so the schedule rules run for
 * that day exactly once; the server refuses if a log already exists.
 */
export function MissedLogForm({
  projectId,
  today,
  headcountKeys,
  tasks,
}: {
  projectId: string
  today: string
  headcountKeys: string[]
  tasks: ChecklistTask[]
}) {
  const [state, action, pending] = useActionState(submitMissedLogAction, null)
  const [shift, setShift] = useState<'morning' | 'evening'>('evening')
  const id = useId()

  // Evening ticks what was achieved (tasks already running); morning ticks
  // what is being started (tasks not yet running).
  const checklist = tasks.filter((task) =>
    shift === 'evening' ? task.started : !task.started,
  )

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="project_id" value={projectId} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-date`} className="text-xs">
            Log date
          </Label>
          <Input
            id={`${id}-date`}
            name="log_date"
            type="date"
            max={today}
            defaultValue={today}
            required
            disabled={pending}
            className="h-8 w-[150px] text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-shift`} className="text-xs">
            Shift
          </Label>
          <select
            id={`${id}-shift`}
            name="shift"
            value={shift}
            onChange={(event) =>
              setShift(event.target.value as 'morning' | 'evening')
            }
            disabled={pending}
            className="border-input bg-background h-8 rounded-md border px-2 text-xs"
          >
            <option value="evening">Evening</option>
            <option value="morning">Morning</option>
          </select>
        </div>
      </div>

      {headcountKeys.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium">Headcount</p>
          <div className="flex flex-wrap gap-2">
            {headcountKeys.map((key) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`${id}-${key}`} className="text-xs capitalize">
                  {key}
                </Label>
                <Input
                  id={`${id}-${key}`}
                  name={`hc__${key}`}
                  disabled={pending}
                  className="h-8 w-24 text-xs"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-1">
        <p className="text-xs font-medium">
          {shift === 'evening'
            ? 'Tasks completed that day'
            : 'Tasks started that day'}
        </p>
        {checklist.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            {shift === 'evening'
              ? 'No tasks are currently in progress.'
              : 'No tasks are waiting to start.'}
          </p>
        ) : (
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
            {checklist.map((task) => (
              <label
                key={task.ref}
                className="hover:bg-muted/50 flex items-center gap-2 rounded px-1 py-1 text-sm"
              >
                <input
                  type="checkbox"
                  name="task_ref"
                  value={task.ref}
                  disabled={pending}
                />
                <span className="font-mono text-xs">{task.ref}</span>
                <span>{task.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${id}-notes`} className="text-xs">
          Notes
        </Label>
        <textarea
          id={`${id}-notes`}
          name="free_notes"
          rows={2}
          disabled={pending}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>

      {shift === 'evening' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="escalate" disabled={pending} />
          Escalate to Volecule
        </label>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[200px] flex-1 space-y-1">
          <Label htmlFor={`${id}-note`} className="text-xs">
            Note (why)
          </Label>
          <Input
            id={`${id}-note`}
            name="note"
            placeholder="e.g. Engineer forgot the evening form"
            disabled={pending}
            className="h-8 text-xs"
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Entering…' : 'Enter log'}
        </Button>
      </div>

      {state && !state.success && (
        <p className="text-destructive text-sm">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-sm text-green-600">{state.message}</p>
      )}
    </form>
  )
}
