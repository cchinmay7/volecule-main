'use client'

import { useActionState, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { initializeProjectWithScheduleAction } from '@/app/protected/scheduler/actions'
import { ImportScheduleForm } from '@/app/protected/scheduler/import-schedule-form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type SiteOption = { id: string; name: string; client_name: string }
type ProjectOption = { id: string; name: string }

const NEW_PROJECT_VALUE = '__new__'

export function StartFlow({
  sites,
  projects,
}: {
  sites: SiteOption[]
  projects: ProjectOption[]
}) {
  const [selection, setSelection] = useState('')

  return (
    <div className="space-y-6">
      <div className="max-w-sm space-y-2">
        <Label htmlFor="start_selection">Project</Label>
        <select
          id="start_selection"
          value={selection}
          onChange={(e) => setSelection(e.target.value)}
          className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">
            Select an existing project, or initialize new
          </option>
          <option value={NEW_PROJECT_VALUE}>+ Initialize new project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground text-xs">
          Pick a project to import an updated Excel into its current scheduler,
          or initialize a new project against an existing site.
        </p>
      </div>

      {selection === NEW_PROJECT_VALUE && (
        <InitializeNewProjectForm sites={sites} />
      )}

      {selection && selection !== NEW_PROJECT_VALUE && (
        <div className="max-w-md space-y-2 rounded-md border p-4">
          <h3 className="text-sm font-semibold">
            Import updated schedule —{' '}
            {projects.find((p) => p.id === selection)?.name}
          </h3>
          <ImportScheduleForm projectId={selection} />
        </div>
      )}
    </div>
  )
}

function InitializeNewProjectForm({ sites }: { sites: SiteOption[] }) {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const [state, formAction, pending] = useActionState(
    async (
      prevState: Awaited<
        ReturnType<typeof initializeProjectWithScheduleAction>
      > | null,
      formData: FormData,
    ) => {
      const result = await initializeProjectWithScheduleAction(
        prevState,
        formData,
      )
      if (result.success) {
        formRef.current?.reset()
        router.push(`/protected/projects/${result.projectId}`)
      }
      return result
    },
    null,
  )

  const hasSites = sites.length > 0

  return (
    <form
      ref={formRef}
      action={formAction}
      className="max-w-xl space-y-4 rounded-md border p-4"
    >
      <h3 className="text-sm font-semibold">Initialize new project</h3>

      <div className="space-y-2">
        <Label htmlFor="site_id">Site</Label>
        <select
          id="site_id"
          name="site_id"
          required
          disabled={!hasSites || pending}
          className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          {hasSites ? (
            <>
              <option value="">Select a site</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name} ({site.client_name})
                </option>
              ))}
            </>
          ) : (
            <option value="">No sites available</option>
          )}
        </select>
        {!hasSites && (
          <p className="text-muted-foreground text-xs">
            Create a site first in the Sites tab — a project is always
            initialized against an existing site. A site can host more than one
            project, so any site can be picked here more than once.
          </p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">Project name</Label>
          <Input
            id="name"
            name="name"
            placeholder="Tower A - Floor 3"
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="public_code">Project code (optional)</Label>
          <Input
            id="public_code"
            name="public_code"
            placeholder="Auto-generated if left blank"
            disabled={pending}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="timezone">Timezone</Label>
        <Input
          id="timezone"
          name="timezone"
          defaultValue="Asia/Kolkata"
          required
          disabled={pending}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="google_form_url_morning">Morning form URL</Label>
          <Input
            id="google_form_url_morning"
            name="google_form_url_morning"
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="google_form_url_evening">Evening form URL</Label>
          <Input
            id="google_form_url_evening"
            name="google_form_url_evening"
            disabled={pending}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="reminder_time_morning">Morning reminder</Label>
          <Input
            id="reminder_time_morning"
            name="reminder_time_morning"
            type="time"
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="reminder_time_evening">Evening reminder</Label>
          <Input
            id="reminder_time_evening"
            name="reminder_time_evening"
            type="time"
            disabled={pending}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="whatsapp_target">WhatsApp target</Label>
        <Input id="whatsapp_target" name="whatsapp_target" disabled={pending} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="file">Schedule Zero (.xlsx)</Label>
        <Input
          id="file"
          name="file"
          type="file"
          accept=".xlsx"
          required
          disabled={pending}
        />
        <p className="text-muted-foreground text-xs">
          Required — a project can&apos;t be initialized without its Schedule
          Zero. Expects WORK / ACTIVITY / PRED. / DUR (d) / START / FINISH
          columns.
        </p>
      </div>

      <Button type="submit" disabled={pending || !hasSites}>
        {pending ? 'Initializing…' : 'Initialize project'}
      </Button>

      {state && !state.success && (
        <pre className="text-destructive text-sm whitespace-pre-wrap">
          {state.error}
        </pre>
      )}
    </form>
  )
}
