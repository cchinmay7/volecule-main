'use client'

import { useActionState, useMemo, useState } from 'react'
import { submitTestLogAction } from '@/app/protected/scheduler/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'

type ProjectOption = { id: string; name: string }

type TaskOption = {
  id: string
  project_id: string
  external_ref: string | null
  name: string
  status: string
  current_planned_end: string
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function TestConsoleForm({
  projects,
  tasks,
}: {
  projects: ProjectOption[]
  tasks: TaskOption[]
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [shift, setShift] = useState<'morning' | 'evening'>('evening')
  const [fakeDate, setFakeDate] = useState(todayIso())
  const [achievedRefs, setAchievedRefs] = useState<Set<string>>(new Set())

  const [state, formAction, pending] = useActionState(submitTestLogAction, null)

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.project_id === projectId),
    [tasks, projectId],
  )

  function toggleRef(ref: string) {
    setAchievedRefs((prev) => {
      const next = new Set(prev)
      if (next.has(ref)) next.delete(ref)
      else next.add(ref)
      return next
    })
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="shift" value={shift} />
      <input type="hidden" name="fake_date" value={fakeDate} />
      {Array.from(achievedRefs).map((ref) => (
        <input key={ref} type="hidden" name="achieved_task_ref" value={ref} />
      ))}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="test_project">Project</Label>
          <select
            id="test_project"
            className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value)
              setAchievedRefs(new Set())
            }}
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
          <Label htmlFor="test_shift">Shift</Label>
          <select
            id="test_shift"
            className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
            value={shift}
            onChange={(e) => setShift(e.target.value as 'morning' | 'evening')}
            disabled={pending}
          >
            <option value="evening">Evening (triggers propagation)</option>
            <option value="morning">Morning (log only, no propagation)</option>
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="test_fake_date">Fake submission date</Label>
          <Input
            id="test_fake_date"
            type="date"
            value={fakeDate}
            onChange={(e) => setFakeDate(e.target.value)}
            disabled={pending}
          />
        </div>
      </div>

      {shift === 'evening' && (
        <div className="space-y-2">
          <Label>Targets achieved on this fake date</Label>
          {projectTasks.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No pending or missed tasks for this project.
            </p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
              {projectTasks.map((task) => {
                const ref = task.external_ref ?? task.id
                return (
                  <label
                    key={task.id}
                    className="hover:bg-muted/50 flex items-center gap-2 rounded px-1 py-1 text-sm"
                  >
                    <Checkbox
                      checked={achievedRefs.has(ref)}
                      onCheckedChange={() => toggleRef(ref)}
                      disabled={pending || !task.external_ref}
                    />
                    <span className="font-mono text-xs">
                      {task.external_ref ?? '—'}
                    </span>
                    <span>{task.name}</span>
                    <Badge
                      variant={
                        task.status === 'missed' ? 'destructive' : 'outline'
                      }
                      className="ml-auto"
                    >
                      {task.status} · due {task.current_planned_end}
                    </Badge>
                  </label>
                )
              })}
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            Anything left unchecked here that is due on or before the fake date
            is treated exactly like a real unticked evening checkbox — it gets
            flagged missed and cascades, unless its own predecessors aren&apos;t
            done yet (spec §11 item 1d), in which case it is skipped entirely
            for this run.
          </p>
        </div>
      )}

      <Button type="submit" disabled={pending || !projectId}>
        {pending ? 'Submitting…' : 'Submit simulated log'}
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
