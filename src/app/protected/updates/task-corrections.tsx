'use client'

import { useMemo, useState } from 'react'
import {
  clearTaskStartAction,
  markTaskDoneAction,
  renameTaskAction,
  reopenTaskAction,
  setTaskDatesAction,
  setTaskStartAction,
} from '@/app/protected/updates/actions'
import { CorrectionForm } from '@/app/protected/updates/correction-form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MAX_TASK_NAME_LENGTH } from '@/utils/scheduler/task-id'

export type TaskView = {
  id: string
  ref: string | null
  name: string
  /** Stored status. */
  status: 'pending' | 'done' | 'retired'
  /** What the scheduler page shows (delayed start, in progress, …). */
  derivedLabel: string
  derivedTone: 'default' | 'secondary' | 'destructive' | 'outline'
  start: string
  end: string
  duration: number
  actualStart: string | null
  actualEnd: string | null
  baselineStart: string
  baselineEnd: string
  /** Suggested end when reopening a done task. */
  reopenEnd: string
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  })
}

/** Everything that can be corrected on a task: its dates and status, then
 * its name. */
function Corrections({
  task,
  projectId,
  today,
}: {
  task: TaskView
  projectId: string
  today: string
}) {
  return (
    <>
      <ScheduleCorrections task={task} projectId={projectId} today={today} />
      <CorrectionForm
        title="Rename task"
        help={
          task.ref
            ? `Changes the name only. The code ${task.ref} stays as it is, and nothing in the schedule moves.`
            : 'Changes the name only. Nothing in the schedule moves.'
        }
        action={renameTaskAction}
        hidden={{ project_id: projectId, task_id: task.id }}
        fields={[
          {
            name: 'name',
            label: 'Task name',
            type: 'text',
            defaultValue: task.name,
            maxLength: MAX_TASK_NAME_LENGTH,
            wide: true,
          },
        ]}
        submitLabel="Save name"
      />
    </>
  )
}

function ScheduleCorrections({
  task,
  projectId,
  today,
}: {
  task: TaskView
  projectId: string
  today: string
}) {
  const hidden = { project_id: projectId, task_id: task.id }
  const started = task.actualStart !== null

  if (task.status === 'done') {
    return (
      <>
        <CorrectionForm
          title="Change completion date"
          help="Use when it finished on a different day than recorded. Tasks that follow shift to match."
          action={markTaskDoneAction}
          hidden={hidden}
          fields={[
            {
              name: 'actual_end',
              label: 'Finished on',
              defaultValue: task.actualEnd ?? today,
              max: today,
            },
          ]}
          submitLabel="Save date"
        />
        <CorrectionForm
          title="Reopen"
          help="Use when it was marked done by mistake. Not allowed once a task after it has started."
          action={reopenTaskAction}
          hidden={hidden}
          fields={[
            {
              name: 'new_end',
              label: 'Expected end',
              defaultValue: task.reopenEnd,
            },
          ]}
          submitLabel="Reopen task"
        />
      </>
    )
  }

  return (
    <>
      <CorrectionForm
        title={started ? 'Change start date' : 'Confirm start'}
        help={
          started
            ? 'Use when the recorded start is wrong. The end moves with it, keeping the same duration.'
            : 'Use when work began but the morning form missed it. Backdate as needed.'
        }
        action={setTaskStartAction}
        hidden={hidden}
        fields={[
          {
            name: 'start_date',
            label: 'Started on',
            defaultValue: task.actualStart ?? today,
            max: today,
          },
        ]}
        submitLabel={started ? 'Save start' : 'Confirm start'}
      />

      <CorrectionForm
        title={started ? 'Change expected end' : 'Edit planned dates'}
        help={
          started
            ? 'The start is fixed by when work began; change that above. Tasks that follow move with the end.'
            : 'Moves the planned window. Tasks that follow move with the end.'
        }
        action={setTaskDatesAction}
        hidden={hidden}
        fields={[
          {
            name: 'start',
            label: 'Start',
            defaultValue: task.actualStart ?? task.start,
            readOnly: started,
          },
          { name: 'end', label: 'End', defaultValue: task.end },
        ]}
        submitLabel="Save dates"
      />

      <CorrectionForm
        title="Mark done"
        help={
          started
            ? 'Use when it finished but was never ticked. Tasks that follow shift to match.'
            : 'Use when it finished but was never ticked. Give the day it started too.'
        }
        action={markTaskDoneAction}
        hidden={hidden}
        fields={[
          ...(started
            ? []
            : [
                {
                  name: 'started_on',
                  label: 'Started on',
                  defaultValue: task.start < today ? task.start : today,
                  max: today,
                },
              ]),
          {
            name: 'actual_end',
            label: 'Finished on',
            defaultValue: today,
            max: today,
          },
        ]}
        submitLabel="Mark done"
      />

      {started && (
        <CorrectionForm
          title="Clear start"
          help="Use when it was marked started by mistake. It goes back to not started, at its original length."
          action={clearTaskStartAction}
          hidden={hidden}
          fields={[
            {
              name: 'expected_start',
              label: 'Expected start',
              defaultValue: today,
            },
          ]}
          submitLabel="Clear start"
        />
      )}
    </>
  )
}

export function TaskCorrections({
  tasks,
  projectId,
  today,
}: {
  tasks: TaskView[]
  projectId: string
  today: string
}) {
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return tasks
    return tasks.filter(
      (task) =>
        task.name.toLowerCase().includes(needle) ||
        (task.ref ?? '').toLowerCase().includes(needle),
    )
  }, [tasks, query])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Find a task"
          placeholder="Find a task by ID or name"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="max-w-xs"
        />
        <span className="text-muted-foreground text-xs">
          {visible.length} of {tasks.length} tasks
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tasks match.</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((task) => {
            const open = openId === task.id
            const slipped = task.end !== task.baselineEnd

            return (
              <li key={task.id} className="rounded-md border">
                <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {task.ref ? `${task.ref} — ` : ''}
                      {task.name}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      <span className={slipped ? 'text-destructive' : ''}>
                        {formatDate(task.start)} – {formatDate(task.end)}
                      </span>{' '}
                      · {task.duration}d
                      {task.actualStart && (
                        <> · started {formatDate(task.actualStart)}</>
                      )}
                      {task.actualEnd && (
                        <> · finished {formatDate(task.actualEnd)}</>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={task.derivedTone}>
                      {task.derivedLabel}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant={open ? 'secondary' : 'outline'}
                      aria-expanded={open}
                      onClick={() => setOpenId(open ? null : task.id)}
                    >
                      {open ? 'Close' : 'Correct'}
                    </Button>
                  </div>
                </div>

                {open && (
                  <div className="bg-muted/30 space-y-2 border-t p-3">
                    <Corrections
                      task={task}
                      projectId={projectId}
                      today={today}
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
