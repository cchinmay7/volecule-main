import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { createClient } from '@/supabase/server'
import { cn } from '@/utils/tailwind'
import { Suspense } from 'react'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'

type SiteRow = {
  id: string
  project_id: string | null
}

type ProjectRow = {
  id: string
  name: string
  public_code: string | null
  timezone: string
  reminder_time_morning: string | null
  reminder_time_evening: string | null
  status: string
}

export default function ProjectsPage() {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground text-sm">Loading projects...</div>
      }
    >
      <ProjectsContent />
    </Suspense>
  )
}

async function ProjectsContent() {
  noStore()
  await connection()

  const supabase = await createClient()
  const [
    { data: sites, error: sitesError },
    { data: projects, error: projectsError },
  ] = await Promise.all([
    supabase.from('sites').select('id, project_id'),
    supabase
      .from('projects')
      .select(
        'id, name, public_code, timezone, reminder_time_morning, reminder_time_evening, status',
      )
      .order('created_at', { ascending: false }),
  ])

  const typedSites = (sites ?? []) as SiteRow[]
  const typedProjects = (projects ?? []) as ProjectRow[]
  const siteCountByProject = typedSites.reduce<Record<string, number>>(
    (acc, site) => {
      if (site.project_id) {
        acc[site.project_id] = (acc[site.project_id] ?? 0) + 1
      }
      return acc
    },
    {},
  )
  const hasSchemaError = Boolean(sitesError || projectsError)

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Projects</CardTitle>
            <CardDescription>
              Open a project to view details, edit configuration, or delete it.
              New projects are created from the Start page, alongside their
              Schedule Zero import.
            </CardDescription>
          </div>
          <Link
            href="/protected/start"
            className={cn(buttonVariants({ size: 'sm' }))}
          >
            Start a new project
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasSchemaError ? (
          <p className="text-muted-foreground text-sm">
            v1 schema tables are not available yet. Run the bootstrap SQL and
            refresh this page.
          </p>
        ) : typedProjects.length > 0 ? (
          typedProjects.map((project) => (
            <div
              key={project.id}
              className="space-y-3 rounded-md border px-3 py-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{project.name}</p>
                  <p className="text-muted-foreground text-xs">
                    Sites: {siteCountByProject[project.id] ?? 0}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Code: {project.public_code ?? '--'} • Timezone:{' '}
                    {project.timezone}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    {project.reminder_time_morning ?? '--'} /{' '}
                    {project.reminder_time_evening ?? '--'}
                  </Badge>
                  <Badge
                    variant={
                      project.status === 'active' ? 'default' : 'secondary'
                    }
                  >
                    {project.status}
                  </Badge>
                </div>
              </div>
              <Link
                href={`/protected/projects/${project.id}`}
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                )}
              >
                View details
              </Link>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground text-sm">
            No projects yet.{' '}
            <Link href="/protected/start" className="underline">
              Start one
            </Link>{' '}
            to create the first project and import its schedule.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
