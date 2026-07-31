/**
 * Static nickname blocklist (spec §2.8, §8.3, ticket 13) — data only, so the
 * list can be extended without touching the matching rules in `nickname.ts`.
 *
 * ## What this list is for
 *
 * A launch-grade filter against names that are offensive on sight, nothing
 * more. Spec §8.3 states the scope plainly: "statische Server-Blockliste +
 * Längen-/Zeichenlimits reichen für den Launch", with blocklist evasion
 * (leetspeak, homoglyphs) an **accepted residual risk** — reporting, muting
 * and Unicode folding are deferred to §8.4 with a named trigger. A name is
 * cosmetic and never an authorization key, so a miss costs a bad word on a
 * leaderboard row, not an exploit.
 *
 * ## How entries are matched
 *
 * `isBlockedNickname` folds a name to lowercase letters and digits and then
 * looks for each entry as a **substring**. Entries must therefore be written
 * folded already: lowercase, no spaces, no punctuation. The fold is what makes
 * `n.a-z_i` hit the same entry as `nazi` — cost-free separator evasion is the
 * one bypass worth closing here.
 *
 * ## Why the list is short
 *
 * Substring matching over a fold has no word boundaries, so every entry risks
 * the Scunthorpe problem — an innocent name containing an entry gets rejected
 * and falls back to a guest name. Entries are chosen so a hit is almost
 * always deliberate: slurs and explicit terms with no common innocent host
 * word. Deliberately absent for that reason: `rape` (grape, scrape), `coon`
 * (raccoon, tycoon), `spic` (spice, suspicious), `anal` (analysis, banal),
 * `pedo` (torpedo — the longer `pedophil`/`paedophil` forms stand in). `cunt`
 * is kept despite Scunthorpe: as a nickname, a hit is intentional.
 *
 * Growing the list is a one-line change and needs no code review of the
 * matcher — but each addition should pass the same test: could an ordinary
 * player hit this by accident?
 */
export const NICKNAME_BLOCKLIST: readonly string[] = Object.freeze([
  // Racial and ethnic slurs.
  'nigger',
  'nigga',
  'kike',
  'chink',
  'wetback',
  'neger',
  'kanake',
  'zigeuner',
  // Homophobic and transphobic slurs.
  'faggot',
  'fagget',
  'schwuchtel',
  'tranny',
  // Ableist slurs.
  'retard',
  'mongoloid',
  'spast', // covers "Spasti" too
  'missgeburt',
  // Nazi glorification (spec's German audience — illegal, not merely rude).
  'nazi',
  'hitler',
  'heilhitler',
  'siegheil',
  'hakenkreuz',
  'judensau',
  'holocaust',
  '1488',
  // Sexual abuse of children.
  'pedophil',
  'paedophil',
  'pedofil',
  'kinderporno',
  'childporn',
  // Explicit profanity and sexual terms.
  'fuck',
  'cunt',
  'whore',
  'hurensohn',
  'fotze',
  'wichser',
  'arschloch',
  'nutte',
  'schlampe',
  'bastard',
]);
