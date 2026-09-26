'use client'

import { useActionState, useState } from 'react'
import { refreshScheduleAction } from '@/app/protected/scheduler/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type ProjectOption = { id: string; name: string }

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Simulates the manual refresh sweep (spec §13 item C) against a fake
 * "as of" date, the same way TestConsoleForm simulates a morning/evening
 * submission — so a multi-day gap (e.g. a weekend with no form submitted)
 * can be exercised without waiting for real time to pass. Reuses
 * refreshScheduleAction directly; the production "Refresh" button on the
 * project's scheduler page calls the same action but omits as_of_date, so
 * it defaults to the project's real current date instead.
 */
export function RefreshSweepTestForm({
  projects,
}: {
  projects: ProjectOption[]
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [fakeDate, setFakeDate] = useState(todayIso())

  const [state, formAction, pending] = useActionState(
    refreshScheduleAction,
    null,
  )

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="as_of_date" value={fakeDate} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="sweep_project">Project</Label>
          <select
            id="sweep_project"
            className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={pending}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="sweep_fake_date">Fake &ldquo;as of&rdquo; date</Label>
          <Input
            id="sweep_fake_date"
            type="date"
            value={fakeDate}
            onChange={(e) => setFakeDate(e.target.value)}
            disabled={pending}
          />
        </div>
      </div>

      <Button type="submit" disabled={pending || !projectId}>
        {pending ? 'Running…' : 'Run refresh sweep'}
      </Button>

      {state && !state.success && (
        <p className="text-destructive text-sm">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-sm text-green-600">{state.message}</p>
      )}
    </form>
  )
}
