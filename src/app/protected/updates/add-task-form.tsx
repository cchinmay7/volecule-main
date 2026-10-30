'use client'

import { useActionState, useId, useMemo, useRef, useState } from 'react'
import {
  addTaskAction,
  type UpdateActionState,
} from '@/app/protected/updates/actions'
import type { TaskView } from '@/app/protected/updates/task-corrections'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  MAX_TASK_DURATION_DAYS,
  MAX_TASK_NAME_LENGTH,
} from '@/utils/scheduler/task-id'

function taskLabel(task: TaskView): string {
  return `${task.ref ? `${task.ref} — ` : ''}${task.name}`
}

/** A searchable checklist of tasks. Ticked ones are posted as `name`. */
function TaskPicker({
  name,
  label,
  help,
  tasks,
  selected,
  blocked,
  onToggle,
  disabled,
}: {
  name: string
  label: string
  help: string
  tasks: TaskView[]
  selected: Set<string>
  /** Ticked in the other list, so not pickable here. */
  blocked: Set<string>
  onToggle: (id: string) => void
  disabled: boolean
}) {
  const [query, setQuery] = useState('')
  const id = useId()

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return tasks
    return tasks.filter((task) =>
      taskLabel(task).toLowerCase().includes(needle),
    )
  }, [tasks, query])

  return (
    <fieldset className="min-w-[240px] flex-1 space-y-1">
      <legend className="text-xs font-medium">
        {label} ({selected.size} selected)
      </legend>
      <p className="text-muted-foreground text-xs">{help}</p>
      <Input
        aria-label={`Find ${label.toLowerCase()}`}
        placeholder="Filter by ID or name"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="h-8 text-xs"
        disabled={disabled}
      />
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
        {tasks.length === 0 ? (
          <p className="text-muted-foreground text-xs">No tasks to pick.</p>
        ) : visible.length === 0 ? (
          <p className="text-muted-foreground text-xs">No tasks match.</p>
        ) : (
          visible.map((task) => {
            const inputId = `${id}-${task.id}`
            const isBlocked = blocked.has(task.id)
            return (
              <div key={task.id} className="flex items-center gap-2">
                <input
                  id={inputId}
                  type="checkbox"
                  name={name}
                  value={task.id}
                  checked={selected.has(task.id)}
                  onChange={() => onToggle(task.id)}
                  disabled={disabled || isBlocked}
                />
                <label
                  htmlFor={inputId}
                  className={
                    isBlocked ? 'text-muted-foreground text-xs' : 'text-xs'
                  }
                >
                  {taskLabel(task)}
                  {isBlocked && ' (picked in the other list)'}
                </label>
              </div>
            )
          })
        )}
      </div>
    </fieldset>
  )
}

/**
 * Adds a task by hand, wired in after any number of parents and before any
 * number of children. Only tasks that haven't started can be children.
 */
export function AddTaskForm({
  tasks,
  projectId,
}: {
  tasks: TaskView[]
  projectId: string
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const [parents, setParents] = useState<Set<string>>(new Set())
  const [children, setChildren] = useState<Set<string>>(new Set())
  const id = useId()

  const [state, formAction, pending] = useActionState(
    async (prev: UpdateActionState | null, formData: FormData) => {
      const result = await addTaskAction(prev, formData)
      if (result.success) {
        formRef.current?.reset()
        setParents(new Set())
        setChildren(new Set())
      }
      return result
    },
    null,
  )

  const childOptions = useMemo(
    () =>
      tasks.filter(
        (task) => task.status === 'pending' && task.actualStart === null,
      ),
    [tasks],
  )

  const toggle =
    (setter: typeof setParents) =>
    (taskId: string): void =>
      setter((current) => {
        const next = new Set(current)
        if (next.has(taskId)) next.delete(taskId)
        else next.add(taskId)
        return next
      })

  return (
    <form
      ref={formRef}
      action={formAction}
      className="bg-background space-y-3 rounded-md border p-3"
    >
      <input type="hidden" name="project_id" value={projectId} />

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-code`} className="text-xs">
            Code
          </Label>
          <Input
            id={`${id}-code`}
            name="code"
            placeholder="W99"
            required
            disabled={pending}
            className="h-8 w-[100px] text-xs"
          />
        </div>
        <div className="min-w-[240px] flex-[2] space-y-1">
          <Label htmlFor={`${id}-name`} className="text-xs">
            Task name
          </Label>
          <Input
            id={`${id}-name`}
            name="name"
            required
            maxLength={MAX_TASK_NAME_LENGTH}
            disabled={pending}
            className="h-8 w-full text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-start`} className="text-xs">
            Start (optional)
          </Label>
          <Input
            id={`${id}-start`}
            name="start"
            type="date"
            disabled={pending}
            className="h-8 w-[150px] text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-duration`} className="text-xs">
            Days
          </Label>
          <Input
            id={`${id}-duration`}
            name="duration_days"
            type="number"
            min={1}
            max={MAX_TASK_DURATION_DAYS}
            step={1}
            defaultValue={1}
            required
            disabled={pending}
            className="h-8 w-[80px] text-xs"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <TaskPicker
          name="parent_id"
          label="Parents"
          help="Must finish before the new task starts."
          tasks={tasks}
          selected={parents}
          blocked={children}
          onToggle={toggle(setParents)}
          disabled={pending}
        />
        <TaskPicker
          name="child_id"
          label="Children"
          help="Start after the new task ends. Only tasks not yet started."
          tasks={childOptions}
          selected={children}
          blocked={parents}
          onToggle={toggle(setChildren)}
          disabled={pending}
        />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[180px] flex-1 space-y-1">
          <Label htmlFor={`${id}-note`} className="text-xs">
            Note (why)
          </Label>
          <Input
            id={`${id}-note`}
            name="note"
            placeholder="Optional"
            disabled={pending}
            className="h-8 text-xs"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? 'Adding…' : 'Add task'}
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">
        Leave the start empty to begin when the last parent ends (or today, with
        no parents). Children that would start too early move later, along with
        everything after them.
      </p>

      {state && !state.success && (
        <p className="text-destructive text-xs">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-xs text-green-600">{state.message}</p>
      )}
    </form>
  )
}
