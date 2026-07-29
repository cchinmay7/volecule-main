'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  deleteSiteAction,
  sendSiteReminderAction,
  updateSiteAction,
} from '@/app/protected/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type SiteDetails = {
  id: string
  name: string
  project_id: string
  public_code: string | null
  timezone: string
  google_form_url_morning: string | null
  google_form_url_evening: string | null
  reminder_time_morning: string | null
  reminder_time_evening: string | null
  whatsapp_target: string | null
  status: string
  created_at: string
}

type ProjectOption = {
  id: string
  name: string
}

function toTimeInputValue(value: string | null): string {
  if (!value) return ''
  return value.slice(0, 5)
}

export function SiteDetailView({
  site,
  projects,
}: {
  site: SiteDetails
  projects: ProjectOption[]
}) {
  const [isEditing, setIsEditing] = useState(false)
  const router = useRouter()

  const [updateState, updateAction, updatePending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof updateSiteAction>> | null,
      formData: FormData,
    ) => {
      const result = await updateSiteAction(prevState, formData)
      if (result.success) setIsEditing(false)
      return result
    },
    null,
  )

  const [deleteState, deleteAction, deletePending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof deleteSiteAction>> | null,
      formData: FormData,
    ) => {
      const result = await deleteSiteAction(prevState, formData)
      if (result.success) router.push('/protected/sites')
      return result
    },
    null,
  )

  const [
    morningReminderState,
    sendMorningReminderAction,
    sendMorningReminderPending,
  ] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof sendSiteReminderAction>> | null,
      formData: FormData,
    ) => sendSiteReminderAction(prevState, formData),
    null,
  )

  const [
    eveningReminderState,
    sendEveningReminderAction,
    sendEveningReminderPending,
  ] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof sendSiteReminderAction>> | null,
      formData: FormData,
    ) => sendSiteReminderAction(prevState, formData),
    null,
  )
  const projectName = projects.find(
    (project) => project.id === site.project_id,
  )?.name

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{site.name}</h1>
          <p className="text-muted-foreground text-sm">
            {projectName
              ? `Project: ${projectName}`
              : 'Project details unavailable'}
          </p>
        </div>
        <Button
          type="button"
          variant={isEditing ? 'secondary' : 'outline'}
          onClick={() => setIsEditing((prev) => !prev)}
          disabled={updatePending || deletePending}
        >
          {isEditing ? 'Cancel edit' : 'Edit'}
        </Button>
      </div>

      <form action={updateAction} className="space-y-4 rounded-md border p-4">
        <input type="hidden" name="site_id" value={site.id} />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="site_name">Site name</Label>
            <Input
              id="site_name"
              name="name"
              defaultValue={site.name}
              required
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="public_code">Public code</Label>
            <Input
              id="public_code"
              name="public_code"
              defaultValue={site.public_code ?? ''}
              placeholder="Auto-generated if left blank"
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="project_id">Project</Label>
            <select
              id="project_id"
              name="project_id"
              defaultValue={site.project_id}
              disabled={!isEditing || updatePending || deletePending}
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="site_status">Status</Label>
            <select
              id="site_status"
              name="status"
              defaultValue={site.status}
              disabled={!isEditing || updatePending || deletePending}
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="timezone">Timezone</Label>
          <Input
            id="timezone"
            name="timezone"
            defaultValue={site.timezone}
            required
            disabled={!isEditing || updatePending || deletePending}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="morning_form">Morning form URL</Label>
            <Input
              id="morning_form"
              name="google_form_url_morning"
              defaultValue={site.google_form_url_morning ?? ''}
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="evening_form">Evening form URL</Label>
            <Input
              id="evening_form"
              name="google_form_url_evening"
              defaultValue={site.google_form_url_evening ?? ''}
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="morning_reminder">Morning reminder</Label>
            <Input
              id="morning_reminder"
              name="reminder_time_morning"
              type="time"
              defaultValue={toTimeInputValue(site.reminder_time_morning)}
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="evening_reminder">Evening reminder</Label>
            <Input
              id="evening_reminder"
              name="reminder_time_evening"
              type="time"
              defaultValue={toTimeInputValue(site.reminder_time_evening)}
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="whatsapp_target">WhatsApp target</Label>
          <Input
            id="whatsapp_target"
            name="whatsapp_target"
            defaultValue={site.whatsapp_target ?? ''}
            disabled={!isEditing || updatePending || deletePending}
          />
        </div>

        <div className="space-y-2">
          <Label>Created at</Label>
          <p className="text-muted-foreground border-input rounded-md border px-3 py-2 text-sm">
            {new Date(site.created_at).toLocaleString()}
          </p>
        </div>

        {isEditing && (
          <Button type="submit" disabled={updatePending || deletePending}>
            {updatePending ? 'Saving…' : 'Save changes'}
          </Button>
        )}

        {updateState && !updateState.success && (
          <p className="text-destructive text-sm">{updateState.error}</p>
        )}
        {updateState?.success && (
          <p className="text-sm text-green-600">Site updated.</p>
        )}
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">Code: {site.public_code ?? '--'}</Badge>
        <Link href={`/protected/projects/${site.project_id}`}>
          <Button variant="outline" size="sm" type="button">
            View project
          </Button>
        </Link>
      </div>

      <section className="space-y-3 rounded-md border p-4">
        <h2 className="text-base font-semibold">Send reminder now</h2>
        <div className="flex flex-wrap gap-3">
          <form action={sendMorningReminderAction} className="space-y-2">
            <input type="hidden" name="site_id" value={site.id} />
            <input type="hidden" name="shift" value="morning" />
            <Button
              type="submit"
              variant="outline"
              disabled={
                sendMorningReminderPending ||
                updatePending ||
                deletePending ||
                sendEveningReminderPending
              }
            >
              {sendMorningReminderPending ? 'Sending…' : 'Send morning form'}
            </Button>
            {morningReminderState && !morningReminderState.success && (
              <p className="text-destructive text-sm">
                {morningReminderState.error}
              </p>
            )}
            {morningReminderState?.success && (
              <p className="text-sm text-green-600">Morning reminder sent.</p>
            )}
          </form>

          <form action={sendEveningReminderAction} className="space-y-2">
            <input type="hidden" name="site_id" value={site.id} />
            <input type="hidden" name="shift" value="evening" />
            <Button
              type="submit"
              variant="outline"
              disabled={
                sendEveningReminderPending ||
                updatePending ||
                deletePending ||
                sendMorningReminderPending
              }
            >
              {sendEveningReminderPending ? 'Sending…' : 'Send evening form'}
            </Button>
            {eveningReminderState && !eveningReminderState.success && (
              <p className="text-destructive text-sm">
                {eveningReminderState.error}
              </p>
            )}
            {eveningReminderState?.success && (
              <p className="text-sm text-green-600">Evening reminder sent.</p>
            )}
          </form>
        </div>
      </section>

      <form
        action={deleteAction}
        className="space-y-2 border-t pt-6"
        onSubmit={(event) => {
          if (
            !window.confirm(
              'Delete this site and all associated logs permanently?',
            )
          ) {
            event.preventDefault()
          }
        }}
      >
        <input type="hidden" name="site_id" value={site.id} />
        <Button
          type="submit"
          variant="destructive"
          disabled={deletePending || updatePending}
        >
          {deletePending ? 'Deleting…' : 'Delete site'}
        </Button>
        {deleteState && !deleteState.success && (
          <p className="text-destructive text-sm">{deleteState.error}</p>
        )}
      </form>
    </div>
  )
}
