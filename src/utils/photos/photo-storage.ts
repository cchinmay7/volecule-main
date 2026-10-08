import type { SupabaseClient } from '@supabase/supabase-js'
import { PHOTO_BUCKET } from '@/utils/photos/photo-naming'

const READ_URL_TTL_SECONDS = 60 * 60
const REMOVE_BATCH_SIZE = 100

/** Short-lived read URLs for private photos, keyed by storage path. Minted
 * with the service role on the server only — the bucket has no client-side
 * policies, so these URLs are the only way a browser ever sees a photo.
 * A path that can't be signed is simply absent from the map. */
export async function getPhotoReadUrls(
  admin: SupabaseClient,
  paths: string[],
  expiresInSeconds = READ_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  if (paths.length === 0) return urls

  const { data, error } = await admin.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(paths, expiresInSeconds)

  if (error || !data) {
    console.error('[photos] failed to create read URLs', error)
    return urls
  }

  for (const entry of data) {
    if (entry.path && entry.signedUrl && !entry.error) {
      urls.set(entry.path, entry.signedUrl)
    }
  }
  return urls
}

/** Deletes stored objects, a batch at a time. Never throws: the callers
 * (deleting a project or a photo) have already done the database change
 * that matters, and an object left behind is a log line, not a failure. */
export async function removePhotoObjects(
  admin: SupabaseClient,
  paths: string[],
): Promise<void> {
  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const batch = paths.slice(i, i + REMOVE_BATCH_SIZE)
    const { error } = await admin.storage.from(PHOTO_BUCKET).remove(batch)
    if (error) {
      console.error('[photos] failed to remove stored objects', error)
    }
  }
}

/** Storage paths of every photo filed under the given projects. Tolerant of
 * the photos table not existing yet (db/photos_v1.sql not run): that just
 * means there is nothing to clean up. */
export async function listProjectPhotoPaths(
  supabase: SupabaseClient,
  projectIds: string[],
): Promise<string[]> {
  if (projectIds.length === 0) return []

  const { data, error } = await supabase
    .from('project_log_photos')
    .select('storage_path')
    .eq('storage_bucket', PHOTO_BUCKET)
    .in('project_id', projectIds)

  if (error || !data) return []
  return data.map((row) => row.storage_path as string)
}
