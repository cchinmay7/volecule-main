'use client'

import { useActionState } from 'react'
import { createProjectAction, createSiteAction } from '@/app/protected/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type ProjectOption = { id: string; name: string }

export function CreateProjectForm() {
  const [state, formAction, pending] = useActionState(createProjectAction, null)

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.success && (
        <p className="text-destructive text-sm">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-sm text-green-600">Project created successfully.</p>
      )}
      <div className="space-y-2">
        <Label htmlFor="name">Project name</Label>
        <Input id="name" name="name" placeholder="Shivalik Floors" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="client_name">Client name</Label>
        <Input
          id="client_name"
          name="client_name"
          placeholder="Manish Sabani"
          required
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Creating…' : 'Create project'}
      </Button>
    </form>
  )
}

export function QuickAddSiteForm({ projects }: { projects: ProjectOption[] }) {
  const [state, formAction, pending] = useActionState(createSiteAction, null)

  return (
    <form
      action={formAction}
      className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"
    >
      {state && !state.success && (
        <p className="text-destructive col-span-full text-sm">{state.error}</p>
      )}
      {state?.success && (
        <p className="col-span-full text-sm text-green-600">
          Site created successfully.
        </p>
      )}
      <div className="space-y-2">
        <Label htmlFor="project_id">Project</Label>
        <select
          id="project_id"
          name="project_id"
          required
          className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="site_name">Site name</Label>
        <Input id="site_name" name="name" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="timezone">Timezone</Label>
        <Input
          id="timezone"
          name="timezone"
          defaultValue="Asia/Kolkata"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="google_form_url_morning">Morning form URL</Label>
        <Input id="google_form_url_morning" name="google_form_url_morning" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="google_form_url_evening">Evening form URL</Label>
        <Input id="google_form_url_evening" name="google_form_url_evening" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="whatsapp_target">WhatsApp target</Label>
        <Input id="whatsapp_target" name="whatsapp_target" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="reminder_time_morning">Morning reminder (HH:mm)</Label>
        <Input
          id="reminder_time_morning"
          name="reminder_time_morning"
          type="time"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="reminder_time_evening">Evening reminder (HH:mm)</Label>
        <Input
          id="reminder_time_evening"
          name="reminder_time_evening"
          type="time"
        />
      </div>
      <div className="flex items-end">
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Creating…' : 'Create site'}
        </Button>
      </div>
    </form>
  )
}
