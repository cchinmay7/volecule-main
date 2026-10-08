import { describe, expect, it } from 'vitest'
import { createFakeSupabase } from '@/test/fake-supabase'
import {
  getPhotoReadUrls,
  listProjectPhotoPaths,
  removePhotoObjects,
} from './photo-storage'
import { PHOTO_BUCKET } from './photo-naming'

describe('photo-storage helpers', () => {
  it('maps storage paths to short-lived read URLs', async () => {
    const { supabase } = createFakeSupabase()
    const urls = await getPhotoReadUrls(supabase, ['a/1.jpg', 'a/2.jpg'])
    expect([...urls.keys()]).toEqual(['a/1.jpg', 'a/2.jpg'])
    expect(urls.get('a/1.jpg')).toContain('/object/sign/site-photos/a/1.jpg')
  })

  it('returns an empty map without calling storage for no paths', async () => {
    const { supabase, stats } = createFakeSupabase()
    expect((await getPhotoReadUrls(supabase, [])).size).toBe(0)
    expect(stats.requests).toBe(0)
  })

  it('removes objects in batches of 100', async () => {
    const { supabase, removedObjects, stats } = createFakeSupabase()
    const paths = Array.from({ length: 250 }, (_, i) => `p/${i}.jpg`)

    await removePhotoObjects(supabase, paths)

    expect(removedObjects).toHaveLength(250)
    expect(removedObjects[0]).toBe(`${PHOTO_BUCKET}/p/0.jpg`)
    expect(stats.requests).toBe(3)
  })

  it('lists the stored paths of the given projects only', async () => {
    const { supabase } = createFakeSupabase({
      project_log_photos: [
        { project_id: 'p1', storage_bucket: PHOTO_BUCKET, storage_path: 'x/1' },
        { project_id: 'p2', storage_bucket: PHOTO_BUCKET, storage_path: 'y/1' },
        { project_id: 'p1', storage_bucket: PHOTO_BUCKET, storage_path: 'x/2' },
      ],
    })

    expect(await listProjectPhotoPaths(supabase, ['p1'])).toEqual([
      'x/1',
      'x/2',
    ])
    expect(await listProjectPhotoPaths(supabase, [])).toEqual([])
  })
})
