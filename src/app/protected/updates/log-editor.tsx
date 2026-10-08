'use client'

import Link from 'next/link'
import { useActionState, useId, useState } from 'react'
import {
  deleteLogPhotoAction,
  updateLogAction,
} from '@/app/protected/updates/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type PhotoView = {
  id: string
  fileName: string
  originalFilename: string | null
  question: string | null
  url: string | null
  renderable: boolean
}

export type LogView = {
  id: string
  logDate: string
  shift: 'morning' | 'evening'
  source: string
  headcount: Record<string, string | null>
  freeNotes: string | null
  escalate: boolean
  selected: string[]
  achieved: string[]
  started: string[]
  photos: PhotoView[]
}

function PhotoTile({
  photo,
  projectId,
}: {
  photo: PhotoView
  projectId: string
}) {
  const [state, action, pending] = useActionState(deleteLogPhotoAction, null)
  const [confirming, setConfirming] = useState(false)

  return (
    <figure className="space-y-1">
      {photo.url && photo.renderable ? (
        <a href={photo.url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.url}
            alt={photo.originalFilename ?? photo.fileName}
            loading="lazy"
            className="bg-muted aspect-square w-full rounded-md border object-cover"
          />
        </a>
      ) : (
        <div className="bg-muted text-muted-foreground flex aspect-square w-full items-center justify-center rounded-md border p-2 text-center text-xs">
          {photo.url ? (
            <a
              href={photo.url}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Open file
            </a>
          ) : (
            'Preview unavailable'
          )}
        </div>
      )}
      <figcaption className="text-muted-foreground text-xs">
        <span className="text-foreground font-mono">{photo.fileName}</span>
        {photo.question && <> · {photo.question}</>}
      </figcaption>

      <form action={action} className="space-y-1">
        <input type="hidden" name="project_id" value={projectId} />
        <input type="hidden" name="photo_id" value={photo.id} />
        {confirming ? (
          <div className="flex items-center gap-1.5">
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              disabled={pending}
              className="h-7 px-2 text-xs"
            >
              {pending ? 'Deleting…' : 'Confirm delete'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className="h-7 px-2 text-xs"
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setConfirming(true)}
            className="h-7 px-2 text-xs"
          >
            Delete photo
          </Button>
        )}
        {state && !state.success && (
          <p className="text-destructive text-xs">{state.error}</p>
        )}
        {state?.success && (
          <p className="text-xs text-green-600">{state.message}</p>
        )}
      </form>
    </figure>
  )
}

function EditRecordForm({
  log,
  projectId,
}: {
  log: LogView
  projectId: string
}) {
  const [state, action, pending] = useActionState(updateLogAction, null)
  const id = useId()
  const keys = Object.keys(log.headcount)

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="log_id" value={log.id} />

      {keys.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium">Headcount</p>
          <div className="flex flex-wrap gap-2">
            {keys.map((key) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`${id}-${key}`} className="text-xs capitalize">
                  {key}
                </Label>
                <Input
                  id={`${id}-${key}`}
                  name={`hc__${key}`}
                  defaultValue={log.headcount[key] ?? ''}
                  disabled={pending}
                  className="h-8 w-24 text-xs"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-1">
        <Label htmlFor={`${id}-notes`} className="text-xs">
          Notes
        </Label>
        <textarea
          id={`${id}-notes`}
          name="free_notes"
          defaultValue={log.freeNotes ?? ''}
          disabled={pending}
          rows={3}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="escalate"
          defaultChecked={log.escalate}
          disabled={pending}
        />
        Escalated to Volecule
      </label>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[200px] flex-1 space-y-1">
          <Label htmlFor={`${id}-note`} className="text-xs">
            Note (why)
          </Label>
          <Input
            id={`${id}-note`}
            name="note"
            placeholder="Optional"
            disabled={pending}
            className="h-8 text-xs"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      {state && !state.success && (
        <p className="text-destructive text-xs">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-xs text-green-600">{state.message}</p>
      )}
    </form>
  )
}

function TickList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <p className="text-xs">
      <span className="font-medium">{label}:</span>{' '}
      <span className="text-muted-foreground">{items.join(' · ')}</span>
    </p>
  )
}

export function LogEditor({
  logs,
  projectId,
}: {
  logs: LogView[]
  projectId: string
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  if (logs.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No logs for this project yet.
      </p>
    )
  }

  return (
    <ul className="space-y-2">
      {logs.map((log) => {
        const open = openId === log.id
        return (
          <li key={log.id} className="rounded-md border">
            <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
              <div>
                <p className="text-sm font-medium">
                  {log.logDate} · {log.shift}
                </p>
                <p className="text-muted-foreground line-clamp-1 text-xs">
                  {log.freeNotes ?? 'No notes'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {log.escalate && <Badge variant="destructive">Escalated</Badge>}
                {log.photos.length > 0 && (
                  <Badge variant="secondary">
                    {log.photos.length} photo
                    {log.photos.length === 1 ? '' : 's'}
                  </Badge>
                )}
                <Badge variant="outline">{log.source}</Badge>
                <Button
                  type="button"
                  size="sm"
                  variant={open ? 'secondary' : 'outline'}
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : log.id)}
                >
                  {open ? 'Close' : 'Edit'}
                </Button>
              </div>
            </div>

            {open && (
              <div className="bg-muted/30 space-y-4 border-t p-3">
                <div className="bg-background space-y-1 rounded-md border p-3">
                  <p className="text-xs font-medium">As submitted</p>
                  <TickList label="Planned to finish" items={log.selected} />
                  <TickList label="Achieved" items={log.achieved} />
                  <TickList label="Started" items={log.started} />
                  <p className="text-muted-foreground text-xs">
                    Editing a log changes the record only. If a task was ticked
                    wrongly, correct the schedule on the{' '}
                    <Link
                      href={`/protected/updates?project=${projectId}&tab=tasks`}
                      className="underline"
                    >
                      Tasks tab
                    </Link>
                    .
                  </p>
                </div>

                <EditRecordForm log={log} projectId={projectId} />

                {log.photos.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium">Photos</p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {log.photos.map((photo) => (
                        <PhotoTile
                          key={photo.id}
                          photo={photo}
                          projectId={projectId}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
