import type { SupabaseClient } from '@supabase/supabase-js'

export type Row = Record<string, unknown>

type StoredObject = { size: number; contentType: string }

type FakeResult = { data: unknown; error: { message: string } | null }

/**
 * Minimal in-memory stand-in for the slice of the Supabase client the
 * scheduler and photo code use — tables with select/insert/upsert/update/
 * delete, and a storage bucket with signed upload URLs, object info and
 * removal. Every request takes a small simulated latency and in-flight
 * requests are counted, so a test can also see whether writes are issued
 * concurrently rather than one at a time.
 *
 * Not a general Postgres emulator: filters are limited to eq / in / not-null,
 * and a query only does what the production code under test needs.
 */
export function createFakeSupabase(
  initial: Record<string, Row[]> = {},
  options: { latencyMs?: number; failInserts?: string[] } = {},
) {
  const latencyMs = options.latencyMs ?? 5
  const failInserts = new Set(options.failInserts ?? [])
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(initial)) {
    tables[name] = rows.map((row) => ({ ...row }))
  }
  const objects = new Map<string, StoredObject>()
  const removedObjects: string[] = []
  const stats = { requests: 0, inFlight: 0, maxInFlight: 0 }
  let nextId = 0
  let nextToken = 0

  async function simulate<T>(work: () => T): Promise<T> {
    stats.requests += 1
    stats.inFlight += 1
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
    await new Promise((resolve) => setTimeout(resolve, latencyMs))
    try {
      return work()
    } finally {
      stats.inFlight -= 1
    }
  }

  class Query implements PromiseLike<FakeResult> {
    private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select'
    private payload: unknown
    private conflictColumns: string[] = []
    private filters: ((row: Row) => boolean)[] = []
    private wantSingle = false
    private limitN: number | null = null
    private orderCol: string | null = null
    private orderAsc = true

    constructor(private table: string) {}

    select() {
      return this
    }
    insert(payload: unknown) {
      this.op = 'insert'
      this.payload = payload
      return this
    }
    upsert(payload: unknown, opts?: { onConflict?: string }) {
      this.op = 'upsert'
      this.payload = payload
      this.conflictColumns = (opts?.onConflict ?? 'id')
        .split(',')
        .map((c) => c.trim())
      return this
    }
    update(payload: unknown) {
      this.op = 'update'
      this.payload = payload
      return this
    }
    delete() {
      this.op = 'delete'
      return this
    }
    eq(col: string, val: unknown) {
      this.filters.push((row) => row[col] === val)
      return this
    }
    neq(col: string, val: unknown) {
      this.filters.push((row) => row[col] !== val)
      return this
    }
    in(col: string, vals: unknown[]) {
      this.filters.push((row) => vals.includes(row[col]))
      return this
    }
    not(col: string, _op: string, _val: unknown) {
      this.filters.push((row) => row[col] !== null && row[col] !== undefined)
      return this
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderCol = col
      this.orderAsc = opts?.ascending ?? true
      return this
    }
    limit(n: number) {
      this.limitN = n
      return this
    }
    maybeSingle() {
      this.wantSingle = true
      return this
    }
    single() {
      this.wantSingle = true
      return this
    }

    private execute(): FakeResult {
      const rows = (tables[this.table] ??= [])

      if (this.op === 'insert' || this.op === 'upsert') {
        if (failInserts.has(this.table)) {
          return {
            data: null,
            error: { message: `relation "${this.table}" does not exist` },
          }
        }
        const incoming = (
          Array.isArray(this.payload) ? this.payload : [this.payload]
        ) as Row[]
        const written: Row[] = []
        for (const row of incoming) {
          if (this.op === 'upsert') {
            const existing = rows.find((candidate) =>
              this.conflictColumns.every((c) => candidate[c] === row[c]),
            )
            if (existing) {
              Object.assign(existing, row)
              written.push(existing)
              continue
            }
          }
          const inserted = { id: `gen-${nextId++}`, ...row }
          rows.push(inserted)
          written.push(inserted)
        }
        return {
          data: this.wantSingle ? (written[0] ?? null) : written,
          error: null,
        }
      }

      const matching = rows.filter((row) => this.filters.every((f) => f(row)))

      if (this.op === 'update') {
        for (const row of matching) Object.assign(row, this.payload)
        return { data: null, error: null }
      }

      if (this.op === 'delete') {
        tables[this.table] = rows.filter((row) => !matching.includes(row))
        return {
          data: this.wantSingle ? (matching[0] ?? null) : matching,
          error: null,
        }
      }

      let result = [...matching]
      if (this.orderCol) {
        const col = this.orderCol
        result.sort((a, b) =>
          (a[col] as number) < (b[col] as number) ? -1 : 1,
        )
        if (!this.orderAsc) result.reverse()
      }
      if (this.limitN !== null) result = result.slice(0, this.limitN)
      return {
        data: this.wantSingle ? (result[0] ?? null) : result,
        error: null,
      }
    }

    then<R1, R2>(
      onfulfilled?: (value: FakeResult) => R1 | PromiseLike<R1>,
      onrejected?: (reason: unknown) => R2 | PromiseLike<R2>,
    ): PromiseLike<R1 | R2> {
      return simulate(() => this.execute()).then(onfulfilled, onrejected)
    }
  }

  const storageBucket = (bucket: string) => ({
    createSignedUploadUrl: (path: string) =>
      simulate(() => {
        const token = `tok-${nextToken++}`
        return {
          data: {
            signedUrl: `https://fake.supabase.co/storage/v1/object/upload/sign/${bucket}/${path}?token=${token}`,
            path,
            token,
          },
          error: null,
        }
      }),
    info: (path: string) =>
      simulate(() => {
        const object = objects.get(`${bucket}/${path}`)
        return object
          ? { data: { ...object, name: path }, error: null }
          : { data: null, error: { message: 'Object not found' } }
      }),
    remove: (paths: string[]) =>
      simulate(() => {
        for (const path of paths) {
          objects.delete(`${bucket}/${path}`)
          removedObjects.push(`${bucket}/${path}`)
        }
        return { data: paths.map((name) => ({ name })), error: null }
      }),
    createSignedUrls: (paths: string[], _expiresIn: number) =>
      simulate(() => ({
        data: paths.map((path) => ({
          path,
          signedUrl: `https://fake.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=read`,
          error: null,
        })),
        error: null,
      })),
  })

  const client = {
    from: (table: string) => new Query(table),
    storage: { from: storageBucket },
  }

  return {
    supabase: client as unknown as SupabaseClient,
    tables,
    stats,
    /** Pretend a client already PUT this object to the bucket. */
    putObject: (bucket: string, path: string, object: StoredObject) => {
      objects.set(`${bucket}/${path}`, object)
    },
    hasObject: (bucket: string, path: string) =>
      objects.has(`${bucket}/${path}`),
    removedObjects,
  }
}
