'use client'

import { useActionState } from 'react'
import { updateSiteAction } from '@/app/protected/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type ProjectOption = {
  id: string
  name: string
}

type SiteForEdit = {
  id: string
  name: string
  public_code: string | null
  project_id: string
  timezone: string
  google_form_url_morning: string | null
  google_form_url_evening: string | null
  reminder_time_morning: string | null
  reminder_time_evening: string | null
  whatsapp_target: string | null
  status: string
}

function toTimeInputValue(value: string | null): string {
  if (!value) return ''
  return value.slice(0, 5)
}

export function EditSiteForm({
  site,
  projects,
  projectName,
}: {
  site: SiteForEdit
  projects: ProjectOption[]
  projectName: string
}) {
  const [state, formAction, pending] = useActionState(updateSiteAction, null)
  const projectId = `site-project-${site.id}`
  const nameId = `site-name-${site.id}`
  const codeId = `site-code-${site.id}`
  const timezoneId = `site-timezone-${site.id}`
  const statusId = `site-status-${site.id}`
  const formMorningId = `site-form-morning-${site.id}`
  const formEveningId = `site-form-evening-${site.id}`
  const reminderMorningId = `site-reminder-morning-${site.id}`
  const reminderEveningId = `site-reminder-evening-${site.id}`
  const targetId = `site-target-${site.id}`

  return (
    <details className="rounded-md border px-3 py-3 text-sm">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{site.name}</p>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{projectName}</Badge>
            <Badge variant={site.status === 'active' ? 'default' : 'secondary'}>
              {site.status}
            </Badge>
          </div>
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          Site code: {site.public_code ?? 'auto-generate on save'}
        </p>
      </summary>

      <form action={formAction} className="mt-4 space-y-4">
        <input type="hidden" name="site_id" value={site.id} />

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={projectId}>Project</Label>
            <select
              id={projectId}
              name="project_id"
              defaultValue={site.project_id}
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              required
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={statusId}>Status</Label>
            <select
              id={statusId}
              name="status"
              defaultValue={site.status}
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              required
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={nameId}>Site name</Label>
            <Input id={nameId} name="name" defaultValue={site.name} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor={codeId}>Site code (optional)</Label>
            <Input
              id={codeId}
              name="public_code"
              defaultValue={site.public_code ?? ''}
              placeholder="Auto-generated if left blank"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor={timezoneId}>Timezone</Label>
          <Input
            id={timezoneId}
            name="timezone"
            defaultValue={site.timezone}
            required
          />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={formMorningId}>Morning form URL</Label>
            <Input
              id={formMorningId}
              name="google_form_url_morning"
              defaultValue={site.google_form_url_morning ?? ''}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={formEveningId}>Evening form URL</Label>
            <Input
              id={formEveningId}
              name="google_form_url_evening"
              defaultValue={site.google_form_url_evening ?? ''}
            />
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={reminderMorningId}>Morning reminder</Label>
            <Input
              id={reminderMorningId}
              name="reminder_time_morning"
              type="time"
              defaultValue={toTimeInputValue(site.reminder_time_morning)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={reminderEveningId}>Evening reminder</Label>
            <Input
              id={reminderEveningId}
              name="reminder_time_evening"
              type="time"
              defaultValue={toTimeInputValue(site.reminder_time_evening)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor={targetId}>WhatsApp target</Label>
          <Input
            id={targetId}
            name="whatsapp_target"
            defaultValue={site.whatsapp_target ?? ''}
          />
        </div>

        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>

        {state && !state.success && (
          <p className="text-destructive text-sm">{state.error}</p>
        )}
        {state?.success && (
          <p className="text-sm text-green-600">Site updated.</p>
        )}
      </form>
    </details>
  )
}
