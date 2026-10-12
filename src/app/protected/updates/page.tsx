import Link from 'next/link'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient } from '@/supabase/server'
import { createAdminClient } from '@/supabase/admin'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime, toLocalDateString } from '@/utils/dates'
import type { EditKind } from '@/utils/logs/edit-history'
import {
  BROWSER_RENDERABLE_MIME_TYPES,
  PHOTO_BUCKET,
} from '@/utils/photos/photo-naming'
import { getPhotoReadUrls } from '@/utils/photos/photo-storage'
import {
  arePredecessorsDone,
  deriveTaskStatus,
  type DerivedStatus,
} from '@/utils/scheduler/derive-status'
import { addDaysIso } from '@/utils/scheduler/propagate'
import { cn } from '@/utils/tailwind'
import { LogEditor, type LogView } from './log-editor'
import { MissedLogForm } from './missed-log-form'
import { TaskCorrections, type TaskView } from './task-corrections'

type SearchParams = Promise<{ project?: string; tab?: string }>

type ProjectRow = {
  id: string
  name: string
  public_code: string | null
  timezone: string
  status: string
}

type TaskRow = {
  id: string
  external_ref: string | null
  name: string
  status: 'pending' | 'done' | 'retired'
  original_planned_start: string
  original_planned_end: string
  current_planned_start: string
  current_planned_end: string
  duration_days: number
  actual_start: string | null
  actual_end: string | null
}

type LogRow = {
  id: string
  log_date: string
  shift: 'morning' | 'evening'
  source: string
  headcount_json: unknown
  targets_selected_json: unknown
  targets_achieved_json: unknown
  starts_confirmed_json: unknown
  free_notes: string | null
  escalate_to_volecule: boolean
}

type PhotoRow = {
  id: string
  project_log_id: string
  storage_path: string
  original_filename: string | null
  mime_type: string
  question: string | null
}

const TABS = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'logs', label: 'Logs' },
  { id: 'history', label: 'History' },
] as const
type TabId = (typeof TABS)[number]['id']

const DEFAULT_HEADCOUNT_KEYS = [
  'barbenders',
  'carpenters',
  'masons',
  'helpers',
  'operators',
  'others',
]

const STATUS_LABEL: Record<DerivedStatus, string> = {
  pending: 'pending',
  in_progress: 'in progress',
  delayed_start: 'delayed start',
  delayed_end: 'delayed end',
  done: 'done',
  retired: 'retired',
}

function statusTone(
  status: DerivedStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'done') return 'default'
  if (status === 'delayed_start' || status === 'delayed_end')
    return 'destructive'
  if (status === 'in_progress') return 'secondary'
  return 'outline'
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function headcountOf(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      inner === null || inner === undefined ? null : String(inner),
    ]),
  )
}

export default async function UpdatesPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  noStore()
  await connection()

  const params = await searchParams
  const supabase = await createClient()

  const { data: projectData } = await supabase
    .from('projects')
    .select('id, name, public_code, timezone, status')
    .order('name', { ascending: true })
  const projects = (projectData ?? []) as ProjectRow[]

  const project =
    projects.find((candidate) => candidate.id === params.project) ??
    projects.find((candidate) => candidate.status === 'active') ??
    projects[0]

  const tab: TabId =
    TABS.find((candidate) => candidate.id === params.tab)?.id ?? 'tasks'

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Updates</h1>
        <p className="text-muted-foreground text-sm">
          Fix what a site engineer got wrong: correct the schedule, rename a
          task, edit a log, remove a photo, or enter a log that was never
          submitted. Every change is recorded in History.
        </p>
      </div>

      {!project ? (
        <p className="text-muted-foreground text-sm">No projects yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {projects.map((candidate) => (
              <Link
                key={candidate.id}
                href={`/protected/updates?project=${candidate.id}&tab=${tab}`}
                className={cn(
                  buttonVariants({
                    variant:
                      candidate.id === project.id ? 'default' : 'outline',
                    size: 'sm',
                  }),
                )}
              >
                {candidate.name}
              </Link>
            ))}
          </div>

          <div className="flex gap-1 border-b">
            {TABS.map((candidate) => (
              <Link
                key={candidate.id}
                href={`/protected/updates?project=${project.id}&tab=${candidate.id}`}
                aria-current={candidate.id === tab ? 'page' : undefined}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm',
                  candidate.id === tab
                    ? 'border-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground border-transparent',
                )}
              >
                {candidate.label}
              </Link>
            ))}
          </div>

          {tab === 'tasks' && <TasksTab project={project} />}
          {tab === 'logs' && <LogsTab project={project} />}
          {tab === 'history' && <HistoryTab project={project} />}
        </>
      )}
    </div>
  )
}

async function TasksTab({ project }: { project: ProjectRow }) {
  const supabase = await createClient()
  const today = toLocalDateString(new Date(), project.timezone)

  const { data: taskData, error } = await supabase
    .from('schedule_tasks')
    .select(
      'id, external_ref, name, status, original_planned_start, original_planned_end, current_planned_start, current_planned_end, duration_days, actual_start, actual_end',
    )
    .eq('project_id', project.id)
    .neq('status', 'retired')
    .order('current_planned_start', { ascending: true })

  const tasks = (taskData ?? []) as TaskRow[]

  const { data: edgeData } =
    tasks.length > 0
      ? await supabase
          .from('schedule_task_dependencies')
          .select('task_id, depends_on_task_id')
          .in(
            'task_id',
            tasks.map((task) => task.id),
          )
      : { data: [] }

  const statusById = new Map(tasks.map((task) => [task.id, task.status]))
  const predecessorStatuses = new Map<string, string[]>()
  for (const edge of (edgeData ?? []) as {
    task_id: string
    depends_on_task_id: string
  }[]) {
    const status = statusById.get(edge.depends_on_task_id)
    if (status === undefined) continue
    const list = predecessorStatuses.get(edge.task_id) ?? []
    list.push(status)
    predecessorStatuses.set(edge.task_id, list)
  }

  const views: TaskView[] = tasks.map((task) => {
    const derived = deriveTaskStatus(
      {
        status: task.status,
        currentPlannedStart: task.current_planned_start,
        currentPlannedEnd: task.current_planned_end,
        actualStart: task.actual_start,
      },
      arePredecessorsDone(predecessorStatuses.get(task.id) ?? []),
      today,
    )
    const reference = task.actual_end ?? task.current_planned_end
    return {
      id: task.id,
      ref: task.external_ref,
      name: task.name,
      status: task.status,
      derivedLabel: STATUS_LABEL[derived],
      derivedTone: statusTone(derived),
      start: task.current_planned_start,
      end: task.current_planned_end,
      duration: task.duration_days,
      actualStart: task.actual_start,
      actualEnd: task.actual_end,
      baselineStart: task.original_planned_start,
      baselineEnd: task.original_planned_end,
      reopenEnd: addDaysIso(reference > today ? reference : today, 1),
    }
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Schedule corrections — {project.name}
        </CardTitle>
        <p className="text-muted-foreground text-sm">
          Tasks that follow a corrected task move automatically. Today is{' '}
          {today} for this project.
        </p>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-destructive text-sm">
            Could not load the schedule.
          </p>
        ) : tasks.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No schedule imported for this project yet.
          </p>
        ) : (
          <TaskCorrections tasks={views} projectId={project.id} today={today} />
        )}
      </CardContent>
    </Card>
  )
}

async function LogsTab({ project }: { project: ProjectRow }) {
  const supabase = await createClient()
  const today = toLocalDateString(new Date(), project.timezone)

  const { data: logData } = await supabase
    .from('project_logs')
    .select(
      'id, log_date, shift, source, headcount_json, targets_selected_json, targets_achieved_json, starts_confirmed_json, free_notes, escalate_to_volecule',
    )
    .eq('project_id', project.id)
    .order('log_date', { ascending: false })
    .order('shift', { ascending: true })
    .limit(30)
  const logs = (logData ?? []) as LogRow[]

  // Photos come from a table added after the original schema; if it isn't
  // there yet the logs still show, just without them.
  const { data: photoData } =
    logs.length > 0
      ? await supabase
          .from('project_log_photos')
          .select(
            'id, project_log_id, storage_path, original_filename, mime_type, question',
          )
          .eq('storage_bucket', PHOTO_BUCKET)
          .in(
            'project_log_id',
            logs.map((log) => log.id),
          )
          .order('sequence', { ascending: true })
      : { data: [] }
  const photos = (photoData ?? []) as PhotoRow[]
  const urls =
    photos.length > 0
      ? await getPhotoReadUrls(
          createAdminClient(),
          photos.map((photo) => photo.storage_path),
        )
      : new Map<string, string>()

  const logViews: LogView[] = logs.map((log) => ({
    id: log.id,
    logDate: log.log_date,
    shift: log.shift,
    source: log.source,
    headcount: headcountOf(log.headcount_json),
    freeNotes: log.free_notes,
    escalate: log.escalate_to_volecule,
    selected: stringList(log.targets_selected_json),
    achieved: stringList(log.targets_achieved_json),
    started: stringList(log.starts_confirmed_json),
    photos: photos
      .filter((photo) => photo.project_log_id === log.id)
      .map((photo) => ({
        id: photo.id,
        fileName: photo.storage_path.split('/').pop() ?? photo.storage_path,
        originalFilename: photo.original_filename,
        question: photo.question,
        url: urls.get(photo.storage_path) ?? null,
        renderable: BROWSER_RENDERABLE_MIME_TYPES.includes(photo.mime_type),
      })),
  }))

  const { data: taskData } = await supabase
    .from('schedule_tasks')
    .select('external_ref, name, actual_start')
    .eq('project_id', project.id)
    .eq('status', 'pending')
    .not('external_ref', 'is', null)
    .order('current_planned_start', { ascending: true })

  const checklist = (
    (taskData ?? []) as {
      external_ref: string
      name: string
      actual_start: string | null
    }[]
  ).map((task) => ({
    ref: task.external_ref,
    name: task.name,
    started: task.actual_start !== null,
  }))

  const newestHeadcountKeys = Object.keys(
    logViews.find((log) => Object.keys(log.headcount).length > 0)?.headcount ??
      {},
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enter a missed log</CardTitle>
          <p className="text-muted-foreground text-sm">
            For a morning or evening form the engineer never submitted. It runs
            through the same rules as the real form, so the schedule updates for
            that day. If a log already exists for the date, edit it below
            instead.
          </p>
        </CardHeader>
        <CardContent>
          <MissedLogForm
            projectId={project.id}
            today={today}
            headcountKeys={
              newestHeadcountKeys.length > 0
                ? newestHeadcountKeys
                : DEFAULT_HEADCOUNT_KEYS
            }
            tasks={checklist}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Recent logs — {project.name}
          </CardTitle>
          <p className="text-muted-foreground text-sm">
            Editing a log fixes the record (headcount, notes, escalation) and
            never changes the schedule.
          </p>
        </CardHeader>
        <CardContent>
          <LogEditor logs={logViews} projectId={project.id} />
        </CardContent>
      </Card>
    </div>
  )
}

type RevisionRow = {
  id: string
  task_id: string
  previous_start: string
  previous_end: string
  new_start: string
  new_end: string
  miss_reason: string | null
  created_at: string
}

type EditRow = {
  id: string
  kind: EditKind
  note: string | null
  created_at: string
  project_log_id: string | null
  details: Record<string, unknown> | null
}

const EDIT_LABEL: Record<EditKind, string> = {
  log_edited: 'Log edited',
  log_created: 'Missed log entered',
  photo_deleted: 'Photo deleted',
  task_renamed: 'Task renamed',
}

/** "W41 — Old name → New name" for a rename; nothing for the other kinds,
 * whose details are shown on the log itself. */
function renameSummary(edit: EditRow): string | null {
  if (edit.kind !== 'task_renamed' || !edit.details) return null
  const { code, previous, next } = edit.details
  if (typeof previous !== 'string' || typeof next !== 'string') return null
  return `${typeof code === 'string' && code ? `${code} — ` : ''}${previous} → ${next}`
}

async function HistoryTab({ project }: { project: ProjectRow }) {
  const supabase = await createClient()

  const { data: taskData } = await supabase
    .from('schedule_tasks')
    .select('id, external_ref, name')
    .eq('project_id', project.id)
  const taskById = new Map(
    (
      (taskData ?? []) as {
        id: string
        external_ref: string | null
        name: string
      }[]
    ).map((task) => [task.id, task]),
  )

  const { data: revisionData } =
    taskById.size > 0
      ? await supabase
          .from('schedule_task_revisions')
          .select(
            'id, task_id, previous_start, previous_end, new_start, new_end, miss_reason, created_at',
          )
          .eq('change_reason', 'manual_override')
          .in('task_id', Array.from(taskById.keys()))
          .order('created_at', { ascending: false })
          .limit(25)
      : { data: [] }
  const revisions = (revisionData ?? []) as RevisionRow[]

  // Added after the original schema (db/updates_v1.sql); tolerate its absence.
  const { data: editData } = await supabase
    .from('project_log_edits')
    .select('id, kind, note, created_at, project_log_id, details')
    .eq('project_id', project.id)
    .order('created_at', { ascending: false })
    .limit(25)
  const edits = (editData ?? []) as EditRow[]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schedule corrections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {revisions.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No manual schedule corrections yet.
            </p>
          ) : (
            revisions.map((revision) => {
              const task = taskById.get(revision.task_id)
              return (
                <div
                  key={revision.id}
                  className="rounded-md border px-3 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {task?.external_ref ? `${task.external_ref} — ` : ''}
                      {task?.name ?? revision.task_id}
                    </p>
                    <span className="text-muted-foreground text-xs">
                      {formatDateTime(revision.created_at)}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {revision.previous_start} – {revision.previous_end} →{' '}
                    {revision.new_start} – {revision.new_end}
                  </p>
                  {revision.miss_reason && (
                    <p className="text-xs">{revision.miss_reason}</p>
                  )}
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Log, photo and task name changes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {edits.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No log, photo or task name changes yet.
            </p>
          ) : (
            edits.map((edit) => (
              <div
                key={edit.id}
                className="rounded-md border px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{EDIT_LABEL[edit.kind]}</Badge>
                    {edit.project_log_id && (
                      <Link
                        href={`/protected/logs/${edit.project_log_id}`}
                        className="text-xs underline"
                      >
                        View log
                      </Link>
                    )}
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {formatDateTime(edit.created_at)}
                  </span>
                </div>
                {renameSummary(edit) && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {renameSummary(edit)}
                  </p>
                )}
                {edit.note && <p className="mt-1 text-xs">{edit.note}</p>}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
