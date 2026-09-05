import type { ParsedTaskRow, ParseIssue } from './types'

/**
 * DFS with a recursion stack over the Predecessors edges. Returns the
 * cycle path (Task IDs) if one exists, or null if the graph is acyclic.
 */
export function detectCycle(tasks: ParsedTaskRow[]): string[] | null {
  const predecessorsByRef = new Map(
    tasks.map((t) => [t.externalRef, t.predecessorRefs]),
  )

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(
    tasks.map((t) => [t.externalRef, WHITE]),
  )
  const pathStack: string[] = []

  function visit(node: string): string[] | null {
    color.set(node, GRAY)
    pathStack.push(node)

    for (const dep of predecessorsByRef.get(node) ?? []) {
      const depColor = color.get(dep)
      if (depColor === GRAY) {
        const cycleStart = pathStack.indexOf(dep)
        return [...pathStack.slice(cycleStart), dep]
      }
      if (depColor === WHITE) {
        const found = visit(dep)
        if (found) return found
      }
    }

    pathStack.pop()
    color.set(node, BLACK)
    return null
  }

  for (const task of tasks) {
    if (color.get(task.externalRef) === WHITE) {
      const cycle = visit(task.externalRef)
      if (cycle) return cycle
    }
  }

  return null
}

/**
 * Flags (doesn't block) a task whose own planned start falls before a
 * predecessor's planned end — a hand-authoring mistake in the
 * spreadsheet, not a graph error.
 */
export function findDateInconsistencies(tasks: ParsedTaskRow[]): ParseIssue[] {
  const byRef = new Map(tasks.map((t) => [t.externalRef, t]))
  const warnings: ParseIssue[] = []

  for (const task of tasks) {
    for (const predRef of task.predecessorRefs) {
      const predecessor = byRef.get(predRef)
      if (predecessor && task.plannedStart < predecessor.plannedEnd) {
        warnings.push({
          row: task.sourceRow,
          message: `${task.externalRef} starts ${task.plannedStart}, before its predecessor ${predRef} finishes ${predecessor.plannedEnd}.`,
        })
      }
    }
  }

  return warnings
}
