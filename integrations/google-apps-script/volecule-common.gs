/**
 * Volecule common helpers — add as a file ("volecule-common") in the Apps
 * Script project of every form, next to the main script and volecule-photos.
 *
 * The main scripts read answers by question TITLE. A title that doesn't match
 * the form exactly (a copy-paste from the other form, a renamed question, a
 * stray space) doesn't fail: the answer is just never found, so nothing is
 * sent and nothing says why. These helpers make that visible.
 *
 *   listFormQuestions()      run it once from the editor to see every
 *                            question's exact title and type, then copy the
 *                            titles into the QUESTIONS block of the main script.
 *   warnAboutMissingQuestions_()  called on every submission; logs any
 *                            configured title that isn't on the form.
 */

function listFormQuestions() {
  const form = FormApp.getActiveForm();
  Logger.log('Form: ' + form.getTitle());
  form.getItems().forEach(function (item, index) {
    // JSON.stringify makes leading/trailing spaces in a title visible.
    Logger.log((index + 1) + '. [' + item.getType() + '] ' + JSON.stringify(String(item.getTitle())));
  });
}

/** All the strings in a (possibly nested) QUESTIONS object. */
function flattenTitles_(questions) {
  const titles = [];
  Object.keys(questions).forEach(function (key) {
    const value = questions[key];
    if (typeof value === 'string') {
      titles.push(value);
    } else if (value && typeof value === 'object') {
      flattenTitles_(value).forEach(function (title) {
        titles.push(title);
      });
    }
  });
  return titles;
}

/** { a: 'x', b: 'y' } -> { a: fn('x'), b: fn('y') } */
function mapObject_(object, fn) {
  const result = {};
  Object.keys(object).forEach(function (key) {
    result[key] = fn(object[key], key);
  });
  return result;
}

/** Logs every configured question title that isn't a question on this form.
 * Checks the form itself (not the response), so a question the engineer
 * simply left blank is not reported. Never throws. */
function warnAboutMissingQuestions_(questions) {
  try {
    const onForm = FormApp.getActiveForm()
      .getItems()
      .map(function (item) {
        return normalizeKey(item.getTitle());
      });
    const missing = flattenTitles_(questions).filter(function (title) {
      return onForm.indexOf(normalizeKey(title)) === -1;
    });
    if (missing.length > 0) {
      Logger.log(
        'WARNING: these questions are not on this form, so nothing is read for them: ' +
          JSON.stringify(missing) +
          '. Questions on the form: ' +
          JSON.stringify(onForm) +
          '. Run listFormQuestions() and fix the QUESTIONS block.',
      );
    }
  } catch (err) {
    Logger.log('Question check skipped: ' + err);
  }
}
