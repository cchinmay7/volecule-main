import { vi } from 'vitest'
import { render, screen, userEvent } from '@/test/test-utils'
import { AddTaskForm } from './add-task-form'
import type { TaskView } from './task-corrections'

const actions = vi.hoisted(() => ({
  addTaskAction: vi.fn(async () => ({
    success: true as const,
    message: 'Added W99.',
  })),
}))
vi.mock('@/app/protected/updates/actions', () => actions)

function view(id: string, overrides: Partial<TaskView> = {}): TaskView {
  return {
    id,
    ref: id,
    name: `Task ${id}`,
    status: 'pending',
    derivedLabel: 'pending',
    derivedTone: 'outline',
    start: '2026-10-13',
    end: '2026-10-17',
    duration: 4,
    actualStart: null,
    actualEnd: null,
    baselineStart: '2026-10-13',
    baselineEnd: '2026-10-17',
    reopenEnd: '2026-10-18',
    ...overrides,
  }
}

const TASKS = [
  view('W1', { status: 'done', actualStart: '2026-10-01' }),
  view('W2'),
  view('W3'),
]

describe('Add a task', () => {
  it('only offers tasks not yet started as children', () => {
    render(<AddTaskForm tasks={TASKS} projectId="project-1" />)

    const parents = screen.getByRole('group', { name: /Parents/ })
    const children = screen.getByRole('group', { name: /Children/ })
    expect(parents).toHaveTextContent('W1 — Task W1')
    expect(children).not.toHaveTextContent('W1 — Task W1')
    expect(children).toHaveTextContent('W2 — Task W2')
  })

  it("can't pick the same task on both sides", async () => {
    render(<AddTaskForm tasks={TASKS} projectId="project-1" />)

    const parents = screen.getByRole('group', { name: /Parents/ })
    const children = screen.getByRole('group', { name: /Children/ })
    await userEvent.click(
      parents.querySelector('input[value="W2"]') as HTMLElement,
    )

    expect(children.querySelector('input[value="W2"]')).toBeDisabled()
  })

  it('sends several parents and children', async () => {
    render(<AddTaskForm tasks={TASKS} projectId="project-1" />)

    await userEvent.type(screen.getByLabelText('Code'), 'W99')
    await userEvent.type(screen.getByLabelText('Task name'), 'Waterproofing')
    const parents = screen.getByRole('group', { name: /Parents/ })
    const children = screen.getByRole('group', { name: /Children/ })
    await userEvent.click(
      parents.querySelector('input[value="W1"]') as HTMLElement,
    )
    await userEvent.click(
      children.querySelector('input[value="W2"]') as HTMLElement,
    )
    await userEvent.click(
      children.querySelector('input[value="W3"]') as HTMLElement,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))

    expect(actions.addTaskAction).toHaveBeenCalledTimes(1)
    const sent = actions.addTaskAction.mock.calls[0] as unknown as [
      unknown,
      FormData,
    ]
    expect(sent[1].get('code')).toBe('W99')
    expect(sent[1].getAll('parent_id')).toEqual(['W1'])
    expect(sent[1].getAll('child_id')).toEqual(['W2', 'W3'])
    expect(await screen.findByText('Added W99.')).toBeInTheDocument()
  })
})
