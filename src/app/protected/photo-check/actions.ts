'use server'

import { createAdminClient } from '@/supabase/admin'
import { getAuthenticatedUserId } from '@/app/protected/actions'
import {
  runPhotoStorageCheck,
  type StorageCheckResult,
} from '@/utils/photos/storage-check'

export type PhotoCheckState = StorageCheckResult | { error: string }

/** Runs the live photo-storage round trip with the server's own keys, so an
 * operator can check it from the app without copying any key anywhere. */
export async function runPhotoStorageCheckAction(
  _prev: PhotoCheckState | null,
): Promise<PhotoCheckState> {
  const auth = await getAuthenticatedUserId()
  if ('error' in auth) return { error: auth.error }

  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!publishableKey) {
    return { error: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set.' }
  }

  try {
    return await runPhotoStorageCheck({
      admin: createAdminClient(),
      publishableKey,
    })
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'The check crashed.',
    }
  }
}
