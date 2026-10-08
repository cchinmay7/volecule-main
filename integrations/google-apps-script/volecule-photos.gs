/**
 * Volecule photo sync — add this as a SECOND file ("volecule-photos") in the
 * Apps Script project of every Google Form that has a file-upload question.
 * The form's main script (morning-form.gs / evening-form.gs) calls
 * syncFormPhotos() after it has posted the form's data.
 *
 * What it does, per submission:
 *   1. Finds every file-upload answer in the response (any number of
 *      upload questions, any question title) -> Drive file ids.
 *   2. Asks Volecule for a storage path + short-lived signed upload URL for
 *      each photo   (POST .../photos/sign).
 *   3. PUTs each photo's bytes straight to Supabase Storage.
 *   4. Tells Volecule which uploads finished   (POST .../photos/attach), so
 *      it can verify the files and file them against the log.
 *
 * It never throws: a photo problem must not make the form submission itself
 * look failed. Every outcome is written to the execution log, and the Drive
 * file ids are also sent with the form data (photos_drive), so any photo
 * that did not make it can be re-synced from Drive later.
 *
 * Uses these globals from the form's main script: INGEST_URL, INGEST_SECRET,
 * SITE_CODE.
 *
 * FIRST-TIME SETUP: this script reads photos from Drive, which is a new
 * permission. Run authorizeVoleculePhotos() once from the editor and accept
 * the prompt; the form-submit trigger keeps working afterwards.
 */

function authorizeVoleculePhotos() {
  // Touching DriveApp is what makes Google ask for the Drive permission.
  DriveApp.getRootFolder()
  Logger.log('Drive access granted.')
}

function photoEndpoint_(name) {
  // INGEST_URL ends in /submit; the photo endpoints live beside it.
  return INGEST_URL.replace(/\/submit$/, '/photos/' + name)
}

function postJson_(url, body) {
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Volecule-Secret': INGEST_SECRET },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  })
  const text = res.getContentText()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (err) {
    // Non-JSON body (e.g. an HTML error page) — callers log `text`.
  }
  return { status: res.getResponseCode(), json: json, text: text }
}

/** Every file in the response's file-upload answers, as
 * [{ drive_file_id, question }]. Empty for forms with no upload question. */
function collectPhotoFiles(e) {
  const files = []
  if (!e || !e.response) return files

  e.response.getItemResponses().forEach(function (itemResponse) {
    const item = itemResponse.getItem()
    if (item.getType() !== FormApp.ItemType.FILE_UPLOAD) return

    const question = String(item.getTitle()).trim().replace(/\s+/g, ' ')
    ;[]
      .concat(itemResponse.getResponse() || [])
      .forEach(function (driveFileId) {
        files.push({ drive_file_id: String(driveFileId), question: question })
      })
  })
  return files
}

/** Same as collectPhotoFiles, but never throws — used while building the
 * main payload, where a failure here must not block the form data. */
function listPhotoFilesSafely(e) {
  try {
    return collectPhotoFiles(e)
  } catch (err) {
    Logger.log('Could not list photo files: ' + err)
    return []
  }
}

function syncFormPhotos(e, externalId) {
  try {
    const entries = collectPhotoFiles(e)
    if (entries.length === 0) return

    // Read name / type / size from Drive for each photo.
    const described = []
    entries.forEach(function (entry) {
      try {
        const file = DriveApp.getFileById(entry.drive_file_id)
        described.push({
          drive_file_id: entry.drive_file_id,
          question: entry.question,
          original_filename: file.getName(),
          mime_type: file.getMimeType(),
          size_bytes: file.getSize(),
          file: file,
        })
      } catch (err) {
        Logger.log(
          'Photo ' + entry.drive_file_id + ': cannot read from Drive: ' + err,
        )
      }
    })
    if (described.length === 0) return

    // 1. Ask for storage paths + signed upload URLs.
    const sign = postJson_(photoEndpoint_('sign'), {
      site_code: SITE_CODE,
      external_submission_id: externalId,
      files: described.map(function (d) {
        return {
          drive_file_id: d.drive_file_id,
          original_filename: d.original_filename,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
          question: d.question,
        }
      }),
    })
    if (sign.status !== 200 || !sign.json || !sign.json.ok) {
      Logger.log('Photo signing failed (' + sign.status + '): ' + sign.text)
      return
    }

    const byDriveId = {}
    described.forEach(function (d) {
      byDriveId[d.drive_file_id] = d
    })

    // 2. Upload each photo straight to Storage.
    const uploaded = []
    sign.json.files.forEach(function (result) {
      const source = byDriveId[result.drive_file_id]
      if (!source) return

      if (result.status === 'already_attached') {
        Logger.log(
          'Photo ' + result.drive_file_id + ' already stored at ' + result.path,
        )
        return
      }
      if (result.status !== 'ready') {
        Logger.log(
          'Photo ' + result.drive_file_id + ' rejected: ' + result.reason,
        )
        return
      }

      const upload = UrlFetchApp.fetch(result.upload_url, {
        method: 'put',
        contentType: result.content_type,
        headers: sign.json.upload_headers,
        payload: source.file.getBlob().getBytes(),
        muteHttpExceptions: true,
      })
      const code = upload.getResponseCode()
      if (code < 200 || code >= 300) {
        Logger.log(
          'Photo ' +
            result.drive_file_id +
            ' upload failed (' +
            code +
            '): ' +
            upload.getContentText(),
        )
        return
      }

      uploaded.push({
        path: result.path,
        drive_file_id: source.drive_file_id,
        original_filename: source.original_filename,
        question: source.question,
      })
    })
    if (uploaded.length === 0) return

    // 3. Confirm the uploads so Volecule verifies and files them.
    const attach = postJson_(photoEndpoint_('attach'), {
      site_code: SITE_CODE,
      external_submission_id: externalId,
      photos: uploaded,
    })
    Logger.log('Photo attach (' + attach.status + '): ' + attach.text)
  } catch (err) {
    Logger.log('Photo sync failed: ' + err)
  }
}
