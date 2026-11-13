// Classic gamertags are up to 15 chars (letters, digits, spaces); modern ones may add a #1234 suffix.
const GAMERTAG_RE = /^[A-Za-z0-9][A-Za-z0-9 ]{0,14}(#\d{1,4})?$/;

export function looksLikeGamertag(gt) {
  return GAMERTAG_RE.test(gt);
}
