import { createClient } from '@/supabase/server'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/utils/tailwind'
import { Suspense } from 'react'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { CreateSiteForm } from './create-site-form'

type SiteRow = {
  id: string
  project_id: string | null
  name: string
  client_name: string
  status: string
  created_at: string
}

type ProjectRow = {
  id: string
  name: string
  status: string
}

export default function ProjectsPage() {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground text-sm">Loading sites...</div>
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
    supabase
      .from('sites')
      .select('id, project_id, name, client_name, status, created_at')
      .order('created_at', { ascending: false }),
    supabase.from('projects').select('id, name, status'),
  ])

  const typedSites = (sites ?? []) as SiteRow[]
  const typedProjects = (projects ?? []) as ProjectRow[]
  const projectById = Object.fromEntries(
    typedProjects.map((project) => [project.id, project]),
  )

  const hasSchemaError = Boolean(sitesError || projectsError)

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create site</CardTitle>
          <CardDescription>
            Add a site and associate it with a project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              Run the bootstrap SQL before creating sites.
            </p>
          ) : (
            <CreateSiteForm
              sites={typedProjects.map((project) => ({
                id: project.id,
                name: project.name,
              }))}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sites</CardTitle>
          <CardDescription>Browse sites and open full details.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              v1 schema tables are not available yet. Run the bootstrap SQL and
              refresh this page.
            </p>
          ) : typedSites.length > 0 ? (
            typedSites.map((site) => {
              const project = site.project_id
                ? projectById[site.project_id]
                : null
              return (
                <div
                  key={site.id}
                  className="space-y-3 rounded-md border px-3 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{site.name}</p>
                      <p className="text-muted-foreground text-xs">
                        Client: {site.client_name}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Project: {project?.name ?? site.project_id ?? '--'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {project && (
                        <Badge
                          variant={
                            project.status === 'active'
                              ? 'default'
                              : 'secondary'
                          }
                        >
                          Project {project.status}
                        </Badge>
                      )}
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
                    href={`/protected/projects/${site.id}`}
                    className={cn(
                      buttonVariants({ variant: 'outline', size: 'sm' }),
                    )}
                  >
                    View details
                  </Link>
                </div>
              )
            })
          ) : (
            <p className="text-muted-foreground text-sm">
              No sites yet. Create the first site from the form.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
