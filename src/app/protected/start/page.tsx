import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { createClient } from '@/supabase/server'
import { Suspense } from 'react'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { StartFlow } from './start-flow'

type SiteOption = {
  id: string
  name: string
  client_name: string
}

type ProjectOption = {
  id: string
  name: string
}

export default function StartPage() {
  return (
    <Suspense
      fallback={<div className="text-muted-foreground text-sm">Loading...</div>}
    >
      <StartContent />
    </Suspense>
  )
}

async function StartContent() {
  noStore()
  await connection()

  const supabase = await createClient()
  const [
    { data: sites, error: sitesError },
    { data: projects, error: projectsError },
  ] = await Promise.all([
    supabase
      .from('sites')
      .select('id, name, client_name')
      .is('project_id', null)
      .order('name'),
    supabase.from('projects').select('id, name').order('name'),
  ])

  const hasSchemaError = Boolean(sitesError || projectsError)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Start</CardTitle>
        <CardDescription>
          Initialize a new project with its Schedule Zero, or import an updated
          Excel into an existing project&apos;s scheduler.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasSchemaError ? (
          <p className="text-muted-foreground text-sm">
            Run the bootstrap SQL before using this page.
          </p>
        ) : (
          <StartFlow
            sites={(sites ?? []) as SiteOption[]}
            projects={(projects ?? []) as ProjectOption[]}
          />
        )}
      </CardContent>
    </Card>
  )
}
