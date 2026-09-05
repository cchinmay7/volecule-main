'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  deleteProjectAction,
  sendProjectReminderAction,
  updateProjectAction,
} from '@/app/protected/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ImportScheduleForm } from '@/app/protected/scheduler/import-schedule-form'

type ProjectDetails = {
  id: string
  name: string
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

type AssociatedSite = {
  id: string
  name: string
  client_name: string
  status: string
}

function toTimeInputValue(value: string | null): string {
  if (!value) return ''
  return value.slice(0, 5)
}

export function ProjectDetailView({
  project,
  sites,
}: {
  project: ProjectDetails
  sites: AssociatedSite[]
}) {
  const [isEditing, setIsEditing] = useState(false)
  const router = useRouter()

  const [updateState, updateAction, updatePending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof updateProjectAction>> | null,
      formData: FormData,
    ) => {
      const result = await updateProjectAction(prevState, formData)
      if (result.success) setIsEditing(false)
      return result
    },
    null,
  )

  const [deleteState, deleteAction, deletePending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof deleteProjectAction>> | null,
      formData: FormData,
    ) => {
      const result = await deleteProjectAction(prevState, formData)
      if (result.success) router.push('/protected/projects')
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
      prevState: Awaited<ReturnType<typeof sendProjectReminderAction>> | null,
      formData: FormData,
    ) => sendProjectReminderAction(prevState, formData),
    null,
  )

  const [
    eveningReminderState,
    sendEveningReminderAction,
    sendEveningReminderPending,
  ] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof sendProjectReminderAction>> | null,
      formData: FormData,
    ) => sendProjectReminderAction(prevState, formData),
    null,
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <p className="text-muted-foreground text-sm">
            Project details and associated sites.
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
        <input type="hidden" name="project_id" value={project.id} />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="project_name">Project name</Label>
            <Input
              id="project_name"
              name="name"
              defaultValue={project.name}
              required
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="public_code">Project code</Label>
            <Input
              id="public_code"
              name="public_code"
              defaultValue={project.public_code ?? ''}
              placeholder="Auto-generated if left blank"
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="project_status">Project status</Label>
            <select
              id="project_status"
              name="status"
              defaultValue={project.status}
              disabled={!isEditing || updatePending || deletePending}
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Input
              id="timezone"
              name="timezone"
              defaultValue={project.timezone}
              required
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="morning_form">Morning form URL</Label>
            <Input
              id="morning_form"
              name="google_form_url_morning"
              defaultValue={project.google_form_url_morning ?? ''}
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="evening_form">Evening form URL</Label>
            <Input
              id="evening_form"
              name="google_form_url_evening"
              defaultValue={project.google_form_url_evening ?? ''}
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
              defaultValue={toTimeInputValue(project.reminder_time_morning)}
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="evening_reminder">Evening reminder</Label>
            <Input
              id="evening_reminder"
              name="reminder_time_evening"
              type="time"
              defaultValue={toTimeInputValue(project.reminder_time_evening)}
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="whatsapp_target">WhatsApp target</Label>
          <Input
            id="whatsapp_target"
            name="whatsapp_target"
            defaultValue={project.whatsapp_target ?? ''}
            disabled={!isEditing || updatePending || deletePending}
          />
        </div>

        <div className="space-y-2">
          <Label>Created at</Label>
          <p className="text-muted-foreground border-input rounded-md border px-3 py-2 text-sm">
            {new Date(project.created_at).toLocaleString()}
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
          <p className="text-sm text-green-600">Project updated.</p>
        )}
      </form>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Associated sites</h2>
          <Badge variant="outline">{sites.length} sites</Badge>
        </div>
        {sites.length > 0 ? (
          <div className="space-y-3">
            {sites.map((site) => (
              <div
                key={site.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{site.name}</p>
                  <p className="text-muted-foreground text-xs">
                    Client: {site.client_name}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={site.status === 'active' ? 'default' : 'secondary'}
                  >
                    {site.status}
                  </Badge>
                  <Link href={`/protected/sites/${site.id}`}>
                    <Button type="button" variant="outline" size="sm">
                      View details
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No sites are associated with this project yet.
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Schedule</h2>
          <Link href={`/protected/projects/${project.id}/scheduler`}>
            <Button type="button" variant="outline" size="sm">
              View scheduler
            </Button>
          </Link>
        </div>
        <ImportScheduleForm projectId={project.id} />
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <h2 className="text-base font-semibold">Send reminder now</h2>
        <div className="flex flex-wrap gap-3">
          <form action={sendMorningReminderAction} className="space-y-2">
            <input type="hidden" name="project_id" value={project.id} />
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
            <input type="hidden" name="project_id" value={project.id} />
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
              'Delete this project and all associated logs permanently?',
            )
          ) {
            event.preventDefault()
          }
        }}
      >
        <input type="hidden" name="project_id" value={project.id} />
        <Button
          type="submit"
          variant="destructive"
          disabled={deletePending || updatePending}
        >
          {deletePending ? 'Deleting…' : 'Delete project'}
        </Button>
        {deleteState && !deleteState.success && (
          <p className="text-destructive text-sm">{deleteState.error}</p>
        )}
      </form>
    </div>
  )
}
