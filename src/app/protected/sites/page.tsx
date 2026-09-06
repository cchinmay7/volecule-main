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
  name: string
  client_name: string
  status: string
  created_at: string
}

type ProjectRow = {
  id: string
  site_id: string | null
  name: string
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
    { data: sites, error: sitesError },
    { data: projects, error: projectsError },
  ] = await Promise.all([
    supabase
      .from('sites')
      .select('id, name, client_name, status, created_at')
      .order('created_at', { ascending: false }),
    supabase.from('projects').select('id, site_id, name, status'),
  ])

  const typedSites = (sites ?? []) as SiteRow[]
  const typedProjects = (projects ?? []) as ProjectRow[]
  const projectsBySiteId = typedProjects.reduce<Record<string, ProjectRow[]>>(
    (acc, project) => {
      if (!project.site_id) return acc
      acc[project.site_id] = [...(acc[project.site_id] ?? []), project]
      return acc
    },
    {},
  )

  const hasSchemaError = Boolean(sitesError || projectsError)

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create site</CardTitle>
          <CardDescription>
            A site is created standalone — attach it to a project from the Start
            page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              Run the bootstrap SQL before creating sites.
            </p>
          ) : (
            <CreateSiteForm />
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
              const siteProjects = projectsBySiteId[site.id] ?? []
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
                        Projects:{' '}
                        {siteProjects.length > 0
                          ? siteProjects.map((p) => p.name).join(', ')
                          : '--'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        {siteProjects.length} project
                        {siteProjects.length === 1 ? '' : 's'}
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
