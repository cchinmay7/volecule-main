import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient } from '@/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TestConsoleForm } from './test-console-form'

type ProjectRow = { id: string; name: string }

type TaskRow = {
  id: string
  project_id: string
  external_ref: string | null
  name: string
  status: string
  current_planned_start: string
  current_planned_end: string
  actual_start: string | null
}

export default async function SchedulerTestConsolePage() {
  noStore()
  await connection()

  const supabase = await createClient()

  const [{ data: projectsData }, { data: tasksData }] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name')
      .eq('status', 'active')
      .order('name', { ascending: true }),
    supabase
      .from('schedule_tasks')
      .select(
        'id, project_id, external_ref, name, status, current_planned_start, current_planned_end, actual_start',
      )
      .eq('status', 'pending')
      .order('current_planned_end', { ascending: true }),
  ])

  const projects = (projectsData ?? []) as ProjectRow[]
  const tasks = (tasksData ?? []) as TaskRow[]

  return (
    <div className="space-y-4">
      <Card className="border-amber-500/50">
        <CardHeader>
          <CardTitle className="text-base">
            Scheduler test console{' '}
            <span className="text-muted-foreground text-xs font-normal tracking-wide uppercase">
              testing tool — not the normal operator workflow
            </span>
          </CardTitle>
          <p className="text-muted-foreground text-sm">
            Simulates a morning or evening Google Forms submission for a fake
            date, through the exact same ingestion and propagation code the real
            webhook uses (spec §11 item 2 / §12) — nothing here is a separate,
            test-only code path. Morning simulates the dedicated start checklist
            (confirms a start, or pushes it +1 day if left unticked); evening
            simulates the deadline checklist (achieved, or delayed-end). Use it
            to check how the schedule reacts N refreshes from now without
            waiting for real time to pass.
          </p>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No active projects found.
            </p>
          ) : (
            <TestConsoleForm projects={projects} tasks={tasks} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
