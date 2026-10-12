import { vi } from 'vitest'
import { render, screen, userEvent, within } from '@/test/test-utils'
import { TaskCorrections, type TaskView } from './task-corrections'

const actions = vi.hoisted(() => {
  const ok = () =>
    vi.fn(async () => ({ success: true as const, message: 'ok' }))
  return {
    renameTaskAction: ok(),
    markTaskDoneAction: ok(),
    reopenTaskAction: ok(),
    setTaskDatesAction: ok(),
    setTaskStartAction: ok(),
    clearTaskStartAction: ok(),
  }
})
vi.mock('@/app/protected/updates/actions', () => actions)

function view(overrides: Partial<TaskView>): TaskView {
  return {
    id: 'task-41',
    ref: 'W41',
    name: 'Column Shuttering',
    status: 'pending',
    derivedLabel: 'Delayed start',
    derivedTone: 'destructive',
    start: '2026-10-13',
    end: '2026-10-17',
    duration: 4,
    actualStart: null,
    actualEnd: null,
    baselineStart: '2026-10-12',
    baselineEnd: '2026-10-16',
    reopenEnd: '2026-10-17',
    ...overrides,
  }
}

async function openCorrections(task: TaskView) {
  render(
    <TaskCorrections tasks={[task]} projectId="project-1" today="2026-10-12" />,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Correct' }))
}

describe('Rename task on the Tasks tab', () => {
  it('offers the current name, and says the code stays', async () => {
    await openCorrections(view({}))

    expect(screen.getByText('Rename task')).toBeInTheDocument()
    expect(screen.getByText(/The code W41 stays as it is/)).toBeInTheDocument()
    const name = screen.getByLabelText('Task name')
    expect(name).toHaveValue('Column Shuttering')
    expect(name).toHaveAttribute('maxlength', '200')
    // The code is not something the form can edit at all.
    expect(screen.queryByLabelText(/code/i)).not.toBeInTheDocument()
  })

  it('is there for a finished task as well', async () => {
    await openCorrections(
      view({
        status: 'done',
        actualStart: '2026-10-08',
        actualEnd: '2026-10-12',
      }),
    )

    expect(screen.getByLabelText('Task name')).toBeInTheDocument()
  })

  it('sends the new name, the task and the project, and shows the result', async () => {
    actions.renameTaskAction.mockResolvedValueOnce({
      success: true,
      message: 'Renamed. The code W41 is unchanged.',
    })
    await openCorrections(view({}))

    const form = screen
      .getByLabelText('Task name')
      .closest('form') as HTMLElement
    const name = within(form).getByLabelText('Task name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Column Shuttering - Level 3')
    await userEvent.click(
      within(form).getByRole('button', { name: 'Save name' }),
    )

    expect(actions.renameTaskAction).toHaveBeenCalledTimes(1)
    const sent = actions.renameTaskAction.mock.calls[0] as unknown as [
      unknown,
      FormData,
    ]
    expect(sent[1].get('name')).toBe('Column Shuttering - Level 3')
    expect(sent[1].get('task_id')).toBe('task-41')
    expect(sent[1].get('project_id')).toBe('project-1')
    expect(
      await within(form).findByText('Renamed. The code W41 is unchanged.'),
    ).toBeInTheDocument()
  })

  it('finds a task by its new name in the search box', async () => {
    render(
      <TaskCorrections
        tasks={[view({ name: 'Column Shuttering - Level 3' })]}
        projectId="project-1"
        today="2026-10-12"
      />,
    )

    await userEvent.type(screen.getByLabelText('Find a task'), 'level 3')

    expect(screen.getByText(/Column Shuttering - Level 3/)).toBeInTheDocument()
  })
})
