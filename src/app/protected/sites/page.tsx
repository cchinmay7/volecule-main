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
import { CreateSiteForm } from './create-site-form'

type ProjectRow = {
  id: string
  name: string
}

type SiteRow = {
  id: string
  name: string
  public_code: string | null
  project_id: string
  timezone: string
  reminder_time_morning: string | null
  reminder_time_evening: string | null
  status: string
}

export default function SitesPage() {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground text-sm">Loading sites...</div>
      }
    >
      <SitesContent />
    </Suspense>
  )
}

async function SitesContent() {
  noStore()
  await connection()

  const supabase = await createClient()
  const [
    { data: projects, error: projectsError },
    { data: sites, error: sitesError },
  ] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name')
      .order('created_at', { ascending: false }),
    supabase
      .from('sites')
      .select(
        'id, name, public_code, project_id, timezone, reminder_time_morning, reminder_time_evening, status',
      )
      .order('created_at', { ascending: false }),
  ])

  const typedProjects = (projects ?? []) as ProjectRow[]
  const typedSites = (sites ?? []) as SiteRow[]
  const projectNameById = Object.fromEntries(
    typedProjects.map((project) => [project.id, project.name]),
  )
  const hasSchemaError = Boolean(projectsError || sitesError)

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create site</CardTitle>
          <CardDescription>
            Configure form links, reminder times, and notification target.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              Run the bootstrap SQL before adding sites.
            </p>
          ) : typedProjects.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Create a project before adding sites.
            </p>
          ) : (
            <CreateSiteForm projects={typedProjects} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sites</CardTitle>
          <CardDescription>
            Open a site to view details, edit configuration, or delete it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              v1 schema tables are not available yet. Run the bootstrap SQL and
              refresh this page.
            </p>
          ) : typedSites.length > 0 ? (
            typedSites.map((site) => (
              <div
                key={site.id}
                className="space-y-3 rounded-md border px-3 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{site.name}</p>
                    <p className="text-muted-foreground text-xs">
                      Project:{' '}
                      {projectNameById[site.project_id] ?? site.project_id}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Code: {site.public_code ?? '--'} • Timezone:{' '}
                      {site.timezone}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">
                      {site.reminder_time_morning ?? '--'} /{' '}
                      {site.reminder_time_evening ?? '--'}
                    </Badge>
                    <Badge
                      variant={
                        site.status === 'active' ? 'default' : 'secondary'
                      }
                    >
                      {site.status}
                    </Badge>
                  </div>
                </div>
                <Link
                  href={`/protected/sites/${site.id}`}
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
              No sites yet. Create a site to start morning/evening capture.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
