# 13 — Nicknames (Filter + statische Blockliste)

**What to build:** Gast-Anzeigenamen ohne Login. 1–16 **sichtbare** Zeichen, Unicode erlaubt aber **gefiltert** (keine Steuer-/Zero-Width-Zeichen); leerer Name → Auto-Gastname „Gast-####". Eine **statische Blockliste** gegen anstößige Namen wird **client- und serverseitig** geprüft (Client nur UX-Vorprüfung, **Server erzwingt**). Namen sind **nicht eindeutig** und rein kosmetisch — Unterscheidung über Farbe/Spieler-ID; nie ein Autorisierungs-Schlüssel (Autorität hängt an der `playerId`).

**Blocked by:** 03.

**Status:** resolved (2026-07-31)

- [x] Längen-/Zeichen-Validierung (1–16 sichtbare Zeichen, Steuer-/Zero-Width entfernt) client **und** server; Länge nach sichtbaren Zeichen. → `sanitizeNickname` in `shared/src/nickname.ts`; **Abweichung** bei der Zählung, s. „Code-Points statt sichtbare Zeichen" unten.
- [x] Statische Blockliste, mit dem Server ausgeliefert; **Server erzwingt**, Client prüft nur vor (UX). → `shared/src/nickname-blocklist.ts`, `displayName` in `server/src/arena.ts`, `nicknameHint` in `client/src/game/nickname-hint.ts`.
- [x] Leerer/verworfener Name → „Gast-####". → `guestName` in `server/src/arena.ts` (nach Spieler-ID nummeriert).
- [x] Name nie als Autorisierung; Bindung aller Spielerdaten an `playerId`. → strukturell: Input-Frames tragen keinen Namen (`protocol`), der Name lebt nur in `Connection.name`. Tests: „lets two players share one name", „ignores a second join, so a name cannot be swapped mid-game" (`arena.test.ts`) plus das bestehende „an intent only ever steers the socket-own player".
- [x] Unit-Tests für Filter + Blockliste; Server-Integration erzwingt auch bei manipuliertem Client-Namen. → `shared/src/nickname.test.ts` (42 Tests), `arena.test.ts` → `describe('nickname policy')` fährt rohe Join-Frames.
- [x] CI grün inkl. Coverage (§9.7). → typecheck/lint/format, 546 Unit-Tests, 19 Szenario-Tests, 17 E2E; `nickname.ts` + `nickname-hint.ts` je 100 %.

_Referenz: spec §2.8, §8.3 (Punkt 5)._

## Answer

Die Politik lebt in **`shared`**, nicht doppelt: `checkNickname` ist *die* Funktion, die der
Server erzwingt und der Client vorprüft. Zwei Implementierungen einer Regel driften, und
jede Drift ist eine UX-Lüge — die Vorschau im Join-Fenster verspricht sonst einen Namen,
den der Server nie erzeugt. Das erweitert die Charta von `shared` (spec §5.1 nachgezogen).

**Verdikt statt Boolean:** `checkNickname` liefert `{ok:true,name}` oder
`{ok:false,reason:'empty'|'blocked'}`. `empty` ist kein Fehler, sondern der Spec-Pfad
„leerer Name → Gastname" — und der Aufrufer besitzt den Gastnamen, weil nur der Server die
Spieler-ID kennt, nach der er nummeriert wird.

**Der Client entscheidet nichts.** Ein geblockter Name **verhindert den Join nicht**: der
Spieler joint, der Server ersetzt den Namen durch `Gast-####`. Die Vorprüfung *kündigt* das
nur an. (Erste Fassung blockierte den Submit — das machte den Client zur Autorität über
eine Regel, die er laut Ticket nur vorprüft, und hätte jemandem wegen eines kosmetischen
Strings das Spiel gekostet.)

### Code-Points statt sichtbare Zeichen — bewusste Abweichung

Das Ticket verlangt „Länge nach sichtbaren Zeichen"; durchgesetzt werden **≤ 16
Code-Points**. Grund: das Wire begrenzt den Namen auf 16 Code-Points, von *beiden* Decodern
geprüft (`protocol`: `MAX_NAME_CHARS`). Mehr durchzulassen wäre ein brechender
Protokollwechsel (`PROTOCOL_VERSION` — und alte Tabs würden Leaderboard-Frames verwerfen),
also keine Nickname-Entscheidung.

Folge: `e` + ◌́ (dekomponiert) kostet zwei Code-Points, also bekommt so ein Name **8**
statt 16 sichtbare Zeichen; präkomponiertes `é` bekommt die volle 16. Die Grenze ist damit
immer **strenger** als die Spec-Regel, nie großzügiger. Festgenagelt in
`nickname.test.ts` („spends a code point per mark…"), damit die Abweichung getestet ist und
nicht zufällig. `NICKNAME.maxVisible` bleibt als *ausgesprochene* Regel stehen und greift,
sobald das Wire je breiter wird. Spec §2.8 und CONTEXT.md sind nachgezogen.

**Kein NFC/NFKC** vor dem Zählen, obwohl es das Budget entspannen würde: §8.4 verschiebt
Unicode-Normalisierung ausdrücklich, und ICU-Versionen unterscheiden sich zwischen Browser
und workerd — Vorschau und Urteil würden auseinanderlaufen.

### Gefiltert wird kategoriebasiert, aber nur über *stabile* Kategorien

`Cc`/`Cf`/`Cs`/`Co` explizit aufgezählt statt `\p{C}`: `\p{C}` zöge **`Cn` (unassigned)**
mit hinein, und `Cn` ist der eine Teil, der sich mit jedem Unicode-Release **verschiebt**.
Ein Browser eine Version vor workerd würde ein Zeichen entfernen, das der Server behält —
genau die Engine-Drift, wegen der dieses Modul `Intl.Segmenter` ablehnt (dessen
Grapheme-Regeln an der ICU-Version hängen; „sichtbares Zeichen" ist stattdessen
ausgeschrieben: Code-Point, der keine Kombinationsmarke ist).

Zusätzlich fällt eine kurze Liste **leer rendernder** Zeichen außerhalb Kategorie C —
U+3164 und die Hangul-Füller sind `\p{L}`, also *Buchstaben*, und rutschen durch jeden
naiven Filter, während sie als nichts erscheinen (der klassische „unsichtbare Name").
U+FE0F bleibt dagegen: es ist eine Marke, und ohne sie ist ❤️ kein ❤️.

### Blockliste: kurz, gefaltet, mit benannten Falschtreffern

Gefaltet auf Kleinbuchstaben + Ziffern, dann Substring — `n.a-z_i` trifft denselben
Eintrag wie `nazi`. Leetspeak (`n4z1`) bleibt laut §8.3 akzeptiertes Restrisiko und ist als
*durchgelassen* festgenagelt, damit eine spätere Verschärfung eine Entscheidung ist und
kein Zufall. Die Liste ist kurz gehalten, weil Substring ohne Wortgrenzen das
Scunthorpe-Problem hat; bewusst **nicht** drin: `rape`, `coon`, `spic`, `anal`, `pedo`
(dafür `pedophil`) — Begründung je Eintrag in `nickname-blocklist.ts`.

### Coverage: die `shared`-Ausnahme wurde verengt, nicht gedehnt

`vitest.config.ts` nahm `packages/shared/**` komplett aus (§9.3: „nur Sanity"). Die
Nickname-Politik ist echte Verzweigungslogik, von der beide Wire-Enden abhängen — sie darf
die Ausnahme nicht erben. Jetzt sind die vier Konstanten-Dateien einzeln ausgenommen und
`packages/shared/src/**` liegt bei ≥ 95 % Branch. §9.3 ist nachgezogen; „Boden, der nur
steigt" bleibt gewahrt.

Zwei toten Zweige fielen dabei auf und sind entfernt statt weggeschaltet: die Byte- und die
Sichtbar-Prüfung in `truncate` waren **unerreichbar** (16 Code-Points sind höchstens 64
UTF-8-Bytes und höchstens 16 sichtbare Zeichen). Beide Implikationen sind jetzt als Test
festgehalten, damit ein späteres Anheben *einer* Grenze laut auffällt.
