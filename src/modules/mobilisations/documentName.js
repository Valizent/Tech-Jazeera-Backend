/**
 * What an uploaded mobilisation document is called (2026-10-13, the user's own
 * ask): `<mobilisation number>_<worker name>_<document name><.ext>`, e.g.
 * `MOB-0013_Ahmed Ali_Passport copy.pdf`. The document name is what the
 * uploader typed for an "Other" file, otherwise the category's own name.
 * Only the display / download name changes; the stored file keeps its own key.
 */

const CATEGORY_NAMES = { Contract: 'Contract', IDCopy: 'ID Copy' };

// Characters Windows and macOS refuse in a file name, plus control characters.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

const clean = (value) => String(value ?? '').replace(FORBIDDEN, '').replace(/\s+/g, ' ').trim();

/**
 * @param {{ serialNumber: string, workerName: string }} mobilisation
 * @param {string} category   Contract | IDCopy | Other
 * @param {string} documentName   what an "Other" file is (ignored otherwise)
 * @param {string} originalName   the uploaded file's own name (only its extension is kept)
 * @param {Set<string>} taken   lower-cased names already on the record, updated here
 */
export function mobilisationDocumentName(mobilisation, category, documentName, originalName, taken) {
  const what = clean(category === 'Other' ? documentName : CATEGORY_NAMES[category]) || 'Document';
  const ext = (/\.[A-Za-z0-9]{1,8}$/.exec(originalName ?? '') ?? [''])[0];
  const base = [mobilisation.serialNumber, mobilisation.workerName, what].map(clean).filter(Boolean).join('_');

  let name = `${base}${ext}`;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} (${n})${ext}`;
  taken.add(name.toLowerCase());
  return name;
}
