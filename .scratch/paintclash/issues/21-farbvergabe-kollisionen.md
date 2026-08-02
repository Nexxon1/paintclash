# 21 — Farbvergabe: zwei Spieler können praktisch identische Farben bekommen

**Beobachtung (Code-Review zu Ticket 08, 2026-07-27):** Die Spielerfarbe ist eine Golden-Ratio-Folge über den Hue-Kreis (`client/src/game/colors.ts`), plus ein **Bump** um +0,18, wenn ein Hue zu nah am reservierten Eigen-Blau liegt. Genau dieser Bump erzeugt eine **vermeidbare** Kollision: ID 1 (gebumpt auf 0,798) und ID 11 (natürlich 0,7984) liegen **0,1° auseinander** — im 3D-Bild sind Plateaus, Köpfe und Trails dieser beiden Spieler nicht unterscheidbar. Weitere Paare (Abstand 21/34/55 in der ID) liegen 3–8° auseinander, also ebenfalls schwer trennbar.

Das Leaderboard aus Ticket 08 fängt das **nur im HUD** ab (Discriminator „‹1›/‹2›" bei Farbgleichheit, spec §2.5 sieht genau das vor). In der **Szene** bleibt die Verwechslung: wessen Trail schneide ich hier gerade?

**Entscheidungsfrage (Triage):**

- Option A — so lassen. Bei bis zu 64 Spielern auf einem Hue-Kreis sind ~5° Abstand ohnehin die theoretische Obergrenze; echte Trennbarkeit bräuchte eine zweite Dimension. Der Discriminator deckt das HUD ab.
- Option B — den Bump durch eine **Kompression** ersetzen: die Folge auf den Kreis *ohne* das reservierte Blau-Band abbilden (`hue = blauEnde + frac(id·φ) · (1 − Bandbreite)`). Injektiv, keine künstliche Doppelung, gleicher Aufwand — beseitigt nur das 1↔11-Paar, nicht die generische Enge bei 64 Spielern.
- Option C — Farbe als **Palette** (feste, handgewählte, gut trennbare Farben mit Variation in Sättigung/Helligkeit) statt reiner Hue-Rotation; passt zur `appearance`-Naht aus ADR-0006 (Skins) und wäre der Ort, an dem Ticket „Skins" später sowieso ansetzt.

**Status:** resolved (2026-08-02) — Option C als **berechnete** Palette

- [x] `client/game/colors.ts`: Hue-Folge durch feste Palette ersetzen (24 Slots, Stride 13).
- [x] Zweite Achse: Helligkeit alterniert zwischen Wheel-Nachbarn; Sättigung trennt Umlauf-IDs.
- [x] `sameShownColor` wiegt alle drei Komponenten, nicht nur den Hue.
- [x] `render/scene.ts` zieht dieselbe Farbe wie das HUD (`playerColor`), nicht mehr nur den Hue.
- [x] Tests: Kollisionsfreiheit über **alle** `maxConnections` IDs, Lesbarkeit, Bijektivität.

_Referenz: spec §2.5 (Farb-Swatch/Discriminator), ADR-0006 (`appearance`-Naht); Fund im Review zu [Ticket 08](08-leaderboard.md)._

## Answer

**Option C, aber berechnet statt handgewählt.** Das Ticket hatte C als den teuren Ausweg
notiert („feste, handgewählte Farben"); gemessen ist der Aufwand derselbe wie bei B — eine
Formel in `playerHue` — und die Trennschärfe deutlich besser. Handgewählt bleibt der Ort,
an dem später Skins ansetzen (ADR-0006); dafür ändert sich nichts an der Naht.

### Der Befund, der die Optionen umsortiert hat

Die Optionen A–C oben rechnen alle mit „bis zu 64 Spielern auf einem Hue-Kreis". Das ist
nicht die Lage: `allocatePlayerId` (`server/arena.ts:300`) vergibt die **kleinste freie** ID
und **recycelt** sie, wenn ein Spieler geht. Gleichzeitig leben können `maxPlayers` (16) +
`maxBots` (8) = **24** Entitäten, im privaten Raum nicht mehr (`playerLimitMax` = 16). Die
lebenden IDs sind also immer ein dichter Bereich ab 1, nie 64 verstreute Nummern.

Damit ist die Golden-Ratio-Folge nicht „so gut wie es geht", sondern schlicht das falsche
Werkzeug: sie löst den Fall *unbekannt viele, unbeschränkt wachsende* IDs — jedes Präfix
bleibt gut verteilt. Wer N kennt und klein hat, verschenkt damit Trennschärfe. Die 0,1°
zwischen ID 1 und 11 waren nicht die theoretische Grenze, sondern der Preis dieser
Fehlanpassung. Auf 24 IDs ist der Kreis **nicht** eng: 12,3° pro Farbe sind da, wenn man
sie gleichmässig verteilt statt eine Folge draufzulegen.

### Gemessen (Worst-Case-Abstand / Paare unter der ~11°-Schwelle)

| Spieler | heute (Bump) | Option B | **Option C** |
|---|---|---|---|
| 8 | 20,18° · 0 | 26,62° · 0 | 24,60° · 0 |
| 16 | **0,12°** · 2 | 10,17° · 3 | **12,30° · 0** |
| 24 (voller Pool) | **0,12°** · 9 | 6,28° · **14** | **12,30° · 0** |

Der Grund, warum B trotz behobener Zwillinge nicht gewinnt: es presst dieselbe Folge in
82 % des Kreises, also werden **alle** Abstände enger — nach der Schwelle des Codes selbst
(`SAME_COLOR_HUE_GAP`) steigt die Zahl verwechselbarer Paare von 9 auf 14, der Discriminator
im HUD feuert also **häufiger** als heute. C bringt sie auf 0.

### Wie die Palette gebaut ist

- **24 Slots**, gleichmässig auf dem Kreis **ausserhalb** des reservierten Blau-Bands
  (`SELF_HUE_GUARD` unverändert). 12,3° ist damit das geometrische Optimum für 24 Farben.
- **Stride 13** — die Primzahl nahe `24/φ` (14,8). Teilerfremd zu 24, also ist ID → Slot
  **bijektiv**: zwei gleichzeitig lebende IDs können gar keinen Hue teilen. Und
  aufeinanderfolgende Joiner landen ~160° auseinander, die eine Eigenschaft, für die die
  Golden-Ratio-Folge ursprünglich da war.
- **Helligkeit alterniert** zwischen Nachbar-Slots (0,49 / 0,61). 12,3° liegen nur knapp
  über der Verwechslungsschwelle (10,8°) — genau die beiden Farben, die am ehesten
  verwechselt werden, unterscheiden sich damit auch in der Helligkeit.
- **Sättigung staffelt den Umlauf.** IDs jenseits von 24 sind erreichbar: eine Trennung
  blockiert ihre ID bis zum nächsten Tick in `pendingLeaves`, während der freigewordene
  Platz schon einen neuen Socket zulässt — ein Massen-Reconnect schiebt IDs also über den
  Pool. So eine ID landet auf einem belegten Slot, und nur eine zweite Achse verhindert,
  dass die Palette genau die Kollision zurückbringt, die sie beseitigt.

**Ein Fehler auf dem Weg, als Notiz:** erst lagen Staffel *und* Alternation beide auf der
Helligkeit — Tier 2 rechnete sich damit auf 0,83–0,95, also nahezu Weiss auf hellem Boden.
Die Tests waren grün, weil sie auf **Verschiedenheit** prüften, nicht auf **Lesbarkeit**.
Der Test „keeps every id readable on the light floor" ist die Konsequenz daraus; die beiden
Achsen sind jetzt unabhängig.

### Was sonst noch fiel

- `render/scene.ts` nahm bisher nur den Hue und dazu die **Konstanten** `PLAYER_SATURATION`
  / `PLAYER_LIGHTNESS`. Mit einer id-abhängigen Helligkeit wäre damit genau die Invariante
  gebrochen, für die es dieses Modul gibt (Swatch = Plateau). Die Szene zieht jetzt
  `playerColor(id)`.
- Der Discriminator-Test in `leaderboard.test.ts` hatte IDs 1 und 11 als Prämisse — also den
  Defekt selbst. Er ist nicht gelöscht, sondern auf den einzigen verbliebenen echten
  Kollisionsfall gestellt: die erste ID **nach** `PALETTE_SLOTS × PALETTE_TIERS`, die ID 1
  exakt wiederholt. Damit bleibt die Discriminator-Logik (spec §2.5) abgedeckt.
- `SELF_SATURATION` / `SELF_LIGHTNESS` sind neu, weil `sameShownColor` das Eigen-Blau jetzt
  komponentenweise vergleicht. Ein Test rechnet sie gegen den authoritativen Hex nach, damit
  die beiden nicht auseinanderlaufen.
- `LIMITS.maxConnections` behält seine Rolle „sizes the client's color palette", aber sie
  stimmt jetzt anders: sie bemisst die **Staffeln**, nicht die Hues. Kommentar nachgezogen.

### Aus dem Code-Review — ein echter Fund auf einem Live-Pfad

**Die Palette hatte ihre eigene Invariante gebrochen, und zwar dort, wo sie gerendert wird.**
`scene.ts:435` spawnt den lokalen Kopf, bevor der Server eine ID vergeben hat, und übergibt
dafür `selfId ?? -2`. Diese `-2` lief bis in `playerColor` — und kam als **bit-identische
Farbe von Spieler 1** zurück (`{hue: 0.70108…, saturation: 0.65, lightness: 0.49}` für
beide, `sameShownColor(-2, 1) === true`). Also genau die Verwechslung, gegen die dieses
Ticket angetreten ist, auf einem Pfad, den jeder Spieler beim Beitreten durchläuft.

Vorher war es nicht besser, nur anders falsch: die Golden-Ratio-Folge gab `-2` einen
**negativen** Hue (`-0,236`), den THREE stillschweigend umbog. Der Fund gehört damit nicht
zur neuen Palette, aber er wäre mit ihr stehen geblieben.

Behoben, wo die Invariante wohnt (nicht in `scene.ts`): IDs unter 1 sind keine Spieler und
bekommen ein **neutrales Grau** — Sättigung 0, die kein echter Slot je annimmt. Test
`gives an id it does not know a color no player can hold` prüft alle Sentinels gegen alle
IDs. Nebenbei rendert der eigene Kopf vor dem Join jetzt neutral statt in einer zufälligen
Gegnerfarbe.

**Zwei Aussagen waren zu stark formuliert** und sind zurückgenommen: `maxConnections`
begrenzt gleichzeitige **Verbindungen**, nicht den ID-Bereich — Churn innerhalb eines Ticks
blockiert IDs schneller, als das Tick-Ende sie freigibt, also ist
`PALETTE_SLOTS × PALETTE_TIERS` eine praktische Deckung und kein Beweis. Jenseits davon
wiederholt sich die Palette exakt, und **dafür** ist der Discriminator da. Kommentare in
`colors.ts`, `limits.ts` und im Test entsprechend ehrlich gemacht.

**Aufgeräumt:** `displayHue` (nach dem Umbau ohne Produktiv-Aufrufer) gelöscht,
`playerHue` / `PLAYER_SATURATION` / `PLAYER_LIGHTNESS` sind jetzt modul-privat — die
öffentliche Fläche ist `playerColor` / `displayColor` / `playerCssColor` /
`sameShownColor`. Eine tautologische Assertion (`PALETTE_SLOTS` gegen seine eigene
Definition) ist raus; die Teilerfremdheits-Prüfung ist die, die etwas fangen kann.

**Nicht gemacht** (kein Teil dieses Tickets): die handgewählte Palette für den Look aus
spec §3 und der `appearance`-Deskriptor aus ADR-0006. Beide setzen an derselben Stelle an,
wenn Skins drankommen.

## Comments
