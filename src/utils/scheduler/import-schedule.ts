import type { SupabaseClient } from '@supabase/supabase-js'
import type { ParsedTaskRow } from './types'
import { diffDaysIso } from './propagate'

export type ImportOutcome =
  | {
      success: true
      versionNumber: number
      created: number
      updated: number
      retired: number
    }
  | { success: false; error: string }

type ExistingTaskRow = {
  id: string
  external_ref: string | null
  current_planned_start: string
  current_planned_end: string
  status: string
}

/**
 * Writes a parsed Schedule Zero (or re-import) into the database.
 *
 * First import: every task is new.
 * Re-import: reconciled by external_ref (spec §04 step 6 / §09 decision 5) —
 * matched tasks keep their id/status/history and only get date/name updates;
 * genuinely new Task IDs insert fresh; existing tasks missing from the new
 * sheet are retired, never deleted.
 *
 * Note: this runs as a sequence of Supabase client calls, not a single
 * database transaction (the JS client has no cross-table transaction
 * primitive short of a Postgres RPC function). A failure partway through
 * leaves earlier writes committed — acceptable for a manually-triggered,
 * low-frequency, single-operator operation, but worth knowing before
 * relying on this for anything higher-stakes.
 */
export async function importSchedule({
  supabase,
  projectId,
  tasks,
  createdBy,
}: {
  supabase: SupabaseClient
  projectId: string
  tasks: ParsedTaskRow[]
  createdBy: string
}): Promise<ImportOutcome> {
  const { data: latestVersion, error: versionQueryError } = await supabase
    .from('schedule_versions')
    .select('version_number')
    .eq('project_id', projectId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (versionQueryError) {
    return { success: false, error: versionQueryError.message }
  }

  const isFirstImport = !latestVersion
  const versionNumber = isFirstImport
    ? 0
    : (latestVersion.version_number as number) + 1

  const { data: existingTasksData, error: existingTasksError } = await supabase
    .from('schedule_tasks')
    .select(
      'id, external_ref, current_planned_start, current_planned_end, status',
    )
    .eq('project_id', projectId)

  if (existingTasksError) {
    return { success: false, error: existingTasksError.message }
  }

  const existingTasks = (existingTasksData ?? []) as ExistingTaskRow[]
  const existingByRef = new Map(
    existingTasks
      .filter((t) => t.external_ref)
      .map((t) => [t.external_ref as string, t]),
  )

  const { data: newVersion, error: versionInsertError } = await supabase
    .from('schedule_versions')
    .insert({
      project_id: projectId,
      version_number: versionNumber,
      source: 'excel_import',
      label: isFirstImport ? 'Schedule Zero' : `Re-import (v${versionNumber})`,
      created_by: createdBy,
    })
    .select('id')
    .single()

  if (versionInsertError || !newVersion) {
    return {
      success: false,
      error:
        versionInsertError?.message ?? 'Failed to create schedule version.',
    }
  }

  const taskIdByRef = new Map<string, string>()
  let created = 0
  let updated = 0

  for (const task of tasks) {
    const existing = existingByRef.get(task.externalRef)

    if (existing) {
      const datesChanged =
        existing.current_planned_start !== task.plannedStart ||
        existing.current_planned_end !== task.plannedEnd

      const { error: updateError } = await supabase
        .from('schedule_tasks')
        .update({
          name: task.name,
          vendor_team: task.vendorTeam,
          current_planned_start: task.plannedStart,
          current_planned_end: task.plannedEnd,
          duration_days: task.durationDays,
        })
        .eq('id', existing.id)

      if (updateError) {
        return { success: false, error: updateError.message }
      }

      if (datesChanged) {
        const { error: revisionError } = await supabase
          .from('schedule_task_revisions')
          .insert({
            task_id: existing.id,
            schedule_version_id: newVersion.id,
            previous_start: existing.current_planned_start,
            previous_end: existing.current_planned_end,
            new_start: task.plannedStart,
            new_end: task.plannedEnd,
            change_reason: 'excel_reimport',
          })
        if (revisionError) {
          return { success: false, error: revisionError.message }
        }
      }

      taskIdByRef.set(task.externalRef, existing.id)
      updated += 1
    } else {
      // Ongoing-project onboarding (open flag B): a row carrying a real
      // actual_end (STATUS @ ENTRY = "Completed") imports already done.
      // A row carrying actual_start but no actual_end ("In Progress")
      // imports as started but not finished — no separate confirm-start
      // action needed; a task already reported in progress in the
      // source sheet is assumed to have begun exactly on schedule, on
      // its own planned start, since the sheet carries no independent
      // actual-start column (same "safer assumption" the propagation
      // engine already makes elsewhere, §06 step 2). Anything else
      // ("Not Started", blank, or no STATUS column at all) imports
      // exactly as before — a fresh, unconfirmed pending task.
      //
      // duration_days is only recomputed (from the true start/end span,
      // not the sheet's own DUR column) for a done task, keeping
      // duration_days = current_end - current_start from the moment the
      // row is created (§12, "duration is dynamic"). An in-progress task
      // has no actual end yet, so there's nothing to recompute from —
      // duration_days stays whatever the sheet said, exactly like a
      // normal pending import.
      const isDone = task.actualEnd !== null
      const durationDays = isDone
        ? Math.max(1, diffDaysIso(task.plannedStart, task.actualEnd as string))
        : task.durationDays

      const { data: inserted, error: insertError } = await supabase
        .from('schedule_tasks')
        .insert({
          project_id: projectId,
          external_ref: task.externalRef,
          name: task.name,
          vendor_team: task.vendorTeam,
          original_planned_start: task.plannedStart,
          original_planned_end: task.plannedEnd,
          current_planned_start: task.plannedStart,
          current_planned_end: isDone ? task.actualEnd : task.plannedEnd,
          duration_days: durationDays,
          actual_start: task.actualStart,
          actual_end: task.actualEnd,
          status: isDone ? 'done' : 'pending',
          created_in_version_id: newVersion.id,
        })
        .select('id')
        .single()

      if (insertError || !inserted) {
        return {
          success: false,
          error:
            insertError?.message ??
            `Failed to insert task ${task.externalRef}.`,
        }
      }

      taskIdByRef.set(task.externalRef, inserted.id as string)
      created += 1
    }
  }

  const newRefs = new Set(tasks.map((t) => t.externalRef))
  const droppedIds = existingTasks
    .filter(
      (t) =>
        t.external_ref &&
        !newRefs.has(t.external_ref) &&
        t.status !== 'retired',
    )
    .map((t) => t.id)

  let retired = 0
  if (droppedIds.length > 0) {
    const { error: retireError } = await supabase
      .from('schedule_tasks')
      .update({ status: 'retired' })
      .in('id', droppedIds)

    if (retireError) {
      return { success: false, error: retireError.message }
    }
    retired = droppedIds.length
  }

  // Dependency edges are replaced wholesale for every matched-or-new task —
  // the new sheet is the complete definition of the graph, not a merge.
  const affectedTaskIds = Array.from(taskIdByRef.values())
  const { error: deleteDepsError } = await supabase
    .from('schedule_task_dependencies')
    .delete()
    .in('task_id', affectedTaskIds)

  if (deleteDepsError) {
    return { success: false, error: deleteDepsError.message }
  }

  const dependencyRows = tasks.flatMap((task) =>
    task.predecessorRefs.map((predRef) => ({
      task_id: taskIdByRef.get(task.externalRef) as string,
      depends_on_task_id: taskIdByRef.get(predRef) as string,
      lag_days: 0,
    })),
  )

  if (dependencyRows.length > 0) {
    const { error: insertDepsError } = await supabase
      .from('schedule_task_dependencies')
      .insert(dependencyRows)

    if (insertDepsError) {
      return { success: false, error: insertDepsError.message }
    }
  }

  const { data: allCurrentTasks, error: allTasksError } = await supabase
    .from('schedule_tasks')
    .select(
      'id, name, vendor_team, current_planned_start, current_planned_end, status',
    )
    .eq('project_id', projectId)

  if (allTasksError) {
    return { success: false, error: allTasksError.message }
  }

  const snapshotRows = (allCurrentTasks ?? []).map((t) => ({
    schedule_version_id: newVersion.id as string,
    task_id: t.id as string,
    name: t.name as string,
    vendor_team: t.vendor_team as string | null,
    planned_start: t.current_planned_start as string,
    planned_end: t.current_planned_end as string,
    status: t.status as string,
  }))

  if (snapshotRows.length > 0) {
    const { error: snapshotError } = await supabase
      .from('schedule_version_tasks')
      .insert(snapshotRows)
    if (snapshotError) {
      return { success: false, error: snapshotError.message }
    }
  }

  return { success: true, versionNumber, created, updated, retired }
}
