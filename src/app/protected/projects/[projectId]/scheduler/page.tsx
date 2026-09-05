import Link from 'next/link'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient } from '@/supabase/server'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type ProjectRow = {
  id: string
  name: string
  timezone: string
}

type ScheduleTaskRow = {
  id: string
  external_ref: string | null
  name: string
  vendor_team: string | null
  status: string
  original_planned_start: string
  original_planned_end: string
  current_planned_start: string
  current_planned_end: string
  duration_days: number
}

type SchedulerPageProps = {
  params: Promise<{ projectId: string }>
}

function toLocalDateString(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)

    const year = parts.find((p) => p.type === 'year')?.value
    const month = parts.find((p) => p.type === 'month')?.value
    const day = parts.find((p) => p.type === 'day')?.value

    if (year && month && day) return `${year}-${month}-${day}`
  } catch {
    // Fall back to UTC date string if timezone is invalid.
  }
  return date.toISOString().slice(0, 10)
}

// Derived, never stored — a stored task can only be pending/done/missed/
// retired. "In progress" is purely a display label for a pending task
// whose window is currently open.
function displayStatus(task: ScheduleTaskRow, today: string): string {
  if (
    task.status === 'pending' &&
    task.current_planned_start <= today &&
    today <= task.current_planned_end
  ) {
    return 'in_progress'
  }
  return task.status
}

function statusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'done':
      return 'default'
    case 'missed':
      return 'destructive'
    case 'in_progress':
      return 'secondary'
    case 'retired':
      return 'outline'
    default:
      return 'outline'
  }
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  })
}

export default async function ProjectSchedulerPage({
  params,
}: SchedulerPageProps) {
  noStore()
  await connection()

  const { projectId } = await params
  const supabase = await createClient()

  const [
    { data: project, error: projectError },
    { data: tasksData, error: tasksError },
  ] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name, timezone')
      .eq('id', projectId)
      .single(),
    supabase
      .from('schedule_tasks')
      .select(
        'id, external_ref, name, vendor_team, status, original_planned_start, original_planned_end, current_planned_start, current_planned_end, duration_days',
      )
      .eq('project_id', projectId)
      .order('current_planned_start', { ascending: true }),
  ])

  if (projectError || !project) {
    notFound()
  }

  const typedProject = project as ProjectRow
  const today = toLocalDateString(new Date(), typedProject.timezone)
  const tasks = (tasksData ?? []) as ScheduleTaskRow[]

  const counts = tasks.reduce(
    (acc, task) => {
      const status = displayStatus(task, today)
      acc[status] = (acc[status] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  return (
    <div className="space-y-4">
      <Link href={`/protected/projects/${projectId}`}>
        <Button variant="outline" size="sm">
          Back to project
        </Button>
      </Link>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">
                Scheduler — {typedProject.name}
              </CardTitle>
              <p className="text-muted-foreground text-sm">
                Current schedule state. Past versions aren&apos;t shown here
                yet.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{tasks.length} tasks</Badge>
              {Object.entries(counts).map(([status, count]) => (
                <Badge key={status} variant={statusVariant(status)}>
                  {status.replace('_', ' ')}: {count}
                </Badge>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {tasksError ? (
            <p className="text-destructive text-sm">
              Could not load the schedule.
            </p>
          ) : tasks.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No schedule imported yet. Import a Schedule Zero Excel from the
              project page.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left text-xs uppercase">
                    <th className="py-2 pr-3 font-medium">Task</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Baseline</th>
                    <th className="py-2 pr-3 font-medium">Current</th>
                    <th className="py-2 pr-3 font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => {
                    const status = displayStatus(task, today)
                    const slipped =
                      task.current_planned_end !== task.original_planned_end

                    return (
                      <tr key={task.id} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          <p className="font-medium">
                            {task.external_ref ? `${task.external_ref} — ` : ''}
                            {task.name}
                          </p>
                          {task.vendor_team && (
                            <p className="text-muted-foreground text-xs">
                              {task.vendor_team}
                            </p>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant={statusVariant(status)}>
                            {status.replace('_', ' ')}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {formatDate(task.original_planned_start)} –{' '}
                          {formatDate(task.original_planned_end)}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <span
                            className={
                              slipped ? 'text-destructive font-medium' : ''
                            }
                          >
                            {formatDate(task.current_planned_start)} –{' '}
                            {formatDate(task.current_planned_end)}
                          </span>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {task.duration_days}d
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
