# splix-Codebasis-Analyse (jespertheend/splix)

Ticket: [04-splix-codebasis-analyse](../issues/04-splix-codebasis-analyse.md) · Datum: 2026-07-18
Quelle: Shallow-Clone von https://github.com/jespertheend/splix (Stand Juli 2026, MIT-Lizenz, Copyright 2023 Jesper van den Ende). Alle Pfadangaben beziehen sich auf das splix-Repo. Ergänzend: [JosefKuchar/Splix.io-Protocol](https://github.com/JosefKuchar/Splix.io-Protocol/blob/master/Protocol.md) (Reverse-Engineering des Legacy-Protokolls).

Kennzeichnung: Aussagen ohne Markierung sind **belegter Fakt aus dem Code** (Datei/Funktion genannt). Eigene Wertungen sind mit *[Interpretation]* markiert.

---

## TL;DR — was übernehmen wir, was nicht

**Als Referenz übernehmen (Konzepte, nicht Code 1:1):**

1. **Fill-Algorithmus:** Inverser BFS-Flood-Fill auf einer temporären Maske über der Bounding-Box des Spielers, mit „Unfillable-Seeds" an Gegnerpositionen — elegant, O(Bounding-Box) statt O(Karte), löst „eingeschlossene Gegner" nebenbei mit (`gameServer/src/gameplay/arenaWorker/updateCapturedArea.js`).
2. **Rechteck-Kompression als universelles Delta-Format:** `compressTiles()` verwandelt beliebige Tile-Mengen in wenige Rechtecke; dasselbe Format dient für Fill-Ergebnis, Chunk-Streaming und Netzwerk-Updates (`gameServer/src/util/util.js`).
3. **Viewport-/Edge-Chunk-Streaming:** Initial 50×50-Viewport, danach nur 5 Tiles breite Randstreifen bei Bewegung; Events nur an Spieler mit überlappendem Viewport (`gameServer/src/gameplay/Player.js#sendRequiredEdgeChunks`, `Game.js#getOverlappingViewportPlayersForRect`).
4. **Lag-Kompensation per Movement-Queue + Event-Undo:** Client sendet Richtung + Ziel-Tile, Server validiert, puffert Zukunfts-Positionen und kann Ereignisse (Kills) bis 600 ms rückwirkend aufheben (`Player.js#drainMovementQueue`, `PlayerEventHistory.js`).
5. **Tick-Modell:** 20 Hz Server-Tick, dt-basierte Bewegung mit identischer Speed-Konstante auf Client und Server.

**Nicht übernehmen:**

- Das handgeschriebene Binärprotokoll (DataView-Cursor-Code, gewachsene Legacy-Opcodes, Off-by-one bei Color-IDs) — wir bauen ein schema-getriebenes Protokoll in TypeScript.
- Die Doppelhaltung des Tile-Arrays (Main-Thread + Worker synchron per Messages).
- Den Client (5 300-Zeilen-`main.js`, globale Variablen, Legacy-Pfade).
- **Bots gibt es nicht** — dafür liefert splix nichts; unsere Heuristik-Bots sind Eigenentwicklung.
- Testkultur: das Repo enthält **keine Tests** — hier setzen wir uns bewusst ab (Ticket 09).

---

## 1. Fill-Algorithmus

### Datenstruktur der Karte

- Die Arena ist ein simples 2D-Array `number[][]` (`arenaTiles`), Bedeutung pro Tile: `-1` = Rand/Wand, `0` = leer, `≥1` = Player-ID des Besitzers (`gameServer/src/gameplay/arenaWorker/mod.js`, Kopfkommentar; erzeugt in `util/util.js#createArenaTiles` — Rand wird als `-1`-Rahmen angelegt). Standard-Arenagröße im offiziellen Betrieb 600×600 (`Game.js`-Konstruktor-Defaults), das CLI-Binary defaultet auf 100×100 (`mainInstance.js`).
- Das Array existiert **zweimal**: einmal im `arenaWorker` (Web Worker, autoritativ für Fills) und einmal gespiegelt im Main-Thread (`Arena.js#tiles`). Der Worker meldet jede Änderung als Rechteck-Nachricht `notifyAreasFilled` zurück; der Main-Thread wendet sie auf seine Kopie an und triggert die Netzwerk-Broadcasts (`Arena.js`-Konstruktor). *[Interpretation: Zweck ist, den teuren Flood-Fill aus dem Tick-Thread zu halten; der Preis ist doppelte Zustandshaltung.]*
- Der Trail eines Spielers ist **kein** Tile-Zustand, sondern eine Vertex-Liste (`Player.js#trailVertices`, nur achsenparallele Segmente, Assertion gegen Diagonalen). Kollision Spieler↔Trail läuft segmentbasiert über `util.js#checkTrailSegment`, nicht über Tiles.

### Ablauf beim Loop-Schluss

Trigger: Der Spieler betritt wieder ein eigenes Tile, während er einen Trail zieht (`Player.js#updateCurrentTile`: `tileValue == this.#id && isGeneratingTrail`). Dann:

1. `Arena.fillPlayerTrail()` — die Trail-Segmente werden als Rechtecke auf die Player-ID gesetzt (`arenaWorker/mod.js#fillPlayerTrail`).
2. `Arena.updateCapturedArea(playerId, unfillableLocations)` — der eigentliche Fill (`arenaWorker/updateCapturedArea.js`):
   - **Maske statt Karte:** Es wird nicht auf `arenaTiles` geflutet (das würde die Besitz-Information anderer Spieler zerstören — so explizit im Kopfkommentar der Datei), sondern auf einer einmalig allozierten `Uint8Array`-Maske in Arenagröße. Zustände: `FILLABLE_BLOCK(0)`, `FILLED_BLOCK(1)`, `PLAYER_BLOCK(2)`.
   - **Nur Bounding-Box:** Geflutet wird nur die Bounding-Box des Spieler-Territoriums (+1 Tile Padding an allen Rändern, damit der Fill außen herumfließen kann). Die Bounds pflegt der Worker selbst pro Spieler (`arenaWorker/PlayerBoundsTracker.js`; bewusst im Worker gehalten, um Race-Conditions mit dem Main-Thread zu vermeiden — Kommentar ebd.).
   - **Inverser Flood-Fill:** BFS-Seed ist die Ecke oben links der (gepaddeten) Bounds, also garantiert *außerhalb* des Spielergebiets. Queue ist eine vorallozierte `CircularQueue` auf `Uint16Array`-Basis (`util/CircularQueue.js`). Alles, was der Fill erreicht, ist „außen". Danach gilt: **jedes Tile in den Bounds, das *nicht* erreicht wurde, gehört dem Spieler** (Invertierung, Zeilen 154–169).
   - **Kein Scanline-Verfahren**, sondern klassischer 4-Nachbarn-BFS (im Code als „dino flood fill" kommentiert, Zeile 124).
3. Die verbleibenden „unfilled" Tiles werden per `compressTiles()` zu Rechtecken gepackt und via `fillTilesRect` auf die Player-ID gesetzt; jedes Rechteck geht als `notifyAreasFilled` an den Main-Thread und von dort als `FILL_RECT` an alle Clients mit überlappendem Viewport (`Game.js`-Konstruktor → `onRectFilled`).
4. Rückgabewert `totalFilledTileCount` zählt alle Tiles, die dem Spieler nach dem Fill gehören (Territorium inkl. Neueroberung) — das wird direkt als Score übernommen (`Player.js#setCapturedTileCount`).

### Eingeschlossene Gegner / fremdes Gebiet

- **Eingeschlossenes fremdes Territorium wird erobert:** In der Maske gilt nur `arenaTiles[x][y] == playerId` als `PLAYER_BLOCK`; Tiles anderer Spieler sind `FILLABLE`. Wird ein fremdes Gebiet umschlossen (und vom Außen-Fill nicht erreicht), wird es beim Invertieren einfach mit überschrieben.
- **Lebende Gegner im Loop verhindern den Fill lokal:** Vor dem BFS werden zusätzliche Seeds an allen `unfillableLocations` gesetzt — das sind die Positionen aller anderen lebenden, nicht-spectator Spieler plus jeweils der *erste* Vertex ihres aktiven Trails (`Game.js#getUnfillableLocations`). Von dort flutet der Fill die eingeschlossene Tasche, sodass sie als „außen" gilt und **nicht** erobert wird (`updateCapturedArea.js`, Zeilen 98–123). Es gibt also keine Kill-Logik beim Einschließen — der Gegner wird schlicht ausgespart. *[Interpretation: bewusste Design-Entscheidung; ein Gegner stirbt bei splix nur durch Trail-Berührung, nie durch Umzingelung.]*
- Im „arena"-Gamemode werden zusätzlich zwei Eckpunkte der Grube (Pit) als unfillable geseedet, damit die Wand nicht überschrieben wird (ebd.).

### Performance-Eigenschaften *[Interpretation, aus dem Code abgeleitet]*

Kosten pro Loop-Schluss ≈ O(Fläche der Spieler-Bounding-Box), nicht O(Arenafläche); Maske und Queue sind vorallokiert (kein GC-Druck); Ausführung im Worker blockiert den 20-Hz-Tick nicht (Aufruf ist `async`, `Player.js#updateCapturedArea` awaitet die Worker-Antwort). Für unsere Zielgröße (10–100 Spieler) ist dieses Design mehr als ausreichend dimensioniert.

---

## 2. Server-Autorität & Tick

- **Tick:** `setInterval` mit 50 ms → **20 Ticks/s** (`gameServer/src/ApplicationLoop.js`, `APPLICATION_LOOP_INTERVAL = 50`). Bewegung ist dt-basiert: `PLAYER_TRAVEL_SPEED = 0.006` Tiles/ms = **6 Tiles/s** (`config.js`) — identisch zur Client-Konstante `GLOBAL_SPEED = 0.006` (`client/src/constants.js`).
- **Pro Tick** (`Game.js#loop` → `Player.js#loop`): Spieler in Blickrichtung weiterbewegen (Tile für Tile via `nextTileProgress`-Akkumulator); pro betretenem Tile: Trail-Start/Trail-Schluss prüfen (`#updateCurrentTile`), Viewport-Mitgliedschaften aktualisieren, Kollision mit Rand (`-1`-Tiles) und fremden/eigenen Trails prüfen (`#currentPositionChanged`); dazu getaktete Broadcasts: Minimap-Viertel alle 250 ms, Leaderboard alle 3 s (`config.js`).
- **Der Server ist voll autoritativ.** Clients senden ausschließlich Richtungswechsel-Wünsche: `UPDATE_MY_POS` = Richtung (uint8) + gewünschte Tile-Koordinate (2× uint16). Diese landen in einer `#movementQueue` (`Player.js#clientPosUpdateRequested`).
- **Input-Validierung** (`Player.js#checkNextMoveValidity`, dreiwertig `valid | invalid | valid-direction`):
  - Nur 90°-Wendungen (gleiche/entgegengesetzte Richtung → `invalid`); im Pausenzustand kein Rückwärts in den eigenen Trail.
  - Die gewünschte Position muss auf der aktuellen Bewegungsachse liegen, sonst wird nur die Richtung übernommen (`valid-direction`), die Position ignoriert.
  - Rückwärtskorrektur erlaubt, aber begrenzt: nicht hinter die `lastCertainClientPosition` (letzte bestätigte Wendeposition) und maximal `MAX_UNDO_TILE_COUNT = 5` Tiles (≈ 500 ms Ping-Toleranz, Kommentar in `config.js`).
  - Positionen *vor* dem Spieler werden nicht sofort angewandt, sondern bleiben in der Queue, bis der Spieler die Stelle erreicht — verhindert Teleport/Speed-Cheats (`#drainMovementQueue`, `#isFuturePosition`).
  - Nach einem verworfenen Move wird dem Client der Server-Zustand zurückgesendet, damit er sich korrigiert (`#drainMovementQueue`, Ende).
- **Lag-Kompensation per Undo:** Weil Clients rückwirkend „ich bin bei Tile X abgebogen" melden dürfen, führt der Server eine `PlayerEventHistory` (`gameplay/PlayerEventHistory.js`): Events (`kill-player`, `start-trail`) werden mit Position+Zeitstempel gespeichert und beim Rücksprung des Spielers rückgängig gemacht, sofern jünger als `MAX_UNDO_EVENT_TIME = 600` ms. Der Tod ist deshalb zweiphasig: `#die` (provisorisch, broadcastet `PLAYER_DIE`) → nach 600 ms `#permanentlyDie` (Tiles löschen, `GAME_OVER` senden); dazwischen kann `UNDO_PLAYER_DIE` kommen (`Player.js`, `Game.js#broadcastUndoPlayerDeath`).
- **Überlastschutz:** Dauert ein Tick länger als 500 ms (`MAX_LOOP_DURATION_MS = 3 / PLAYER_TRAVEL_SPEED`), wird dt gekappt, aufgestaute Client-Inputs werden verworfen (`currentTickIsSlow()`-Check in `clientPosUpdateRequested`) und der Zustand aller Spieler re-broadcastet (`Game.js`, `onSlowTickEnded`).
- **Abuse-Schutz auf Verbindungsebene:** max. 20 Nachrichten/100 ms pro Socket (`WebSocketManager.js` → `util/SocketRateLimiter.js`), Verbindungs-Rate-Limit pro IP (`shared/RateLimitManager.js`), Ping-Timeout 5 min (`WebSocketConnection.js#loop`). Exploit-Fixes werden über eine vom Client gemeldete `PROTOCOL_VERSION` gegated (`Player.js`, Kommentare „first/second way of flying") — *[Interpretation: Altlast zur Abwärtskompatibilität mit alten Mobile-Clients; für einen Neubau irrelevant, Fixes immer aktiv lassen.]*

---

## 3. Protokoll & Chunk-Streaming

### Wire-Format

Binäre WebSocket-Messages: **1 Byte Opcode, danach feldweise DataView-Writes; Koordinaten als Big-Endian `uint16`** (alle `send*`/`create*`-Methoden in `gameServer/src/WebSocketConnection.js`). Die Opcode-Tabellen stehen in `SendAction` (24 Server→Client-Typen) und `ReceiveAction` (15 Client→Server-Typen) mit JSDoc pro Eintrag — die beste „Protokoll-Doku" ist der Servercode selbst; das reverse-engineerte Protocol.md von JosefKuchar deckt nur den Legacy-Stand ab und ist lückenhaft (FILL_AREA/CHUNK_OF_BLOCKS dort ohne Layout).

Wichtigste Nachrichten (Größen aus den Buffer-Allokationen):

| Nachricht | Opcode | Größe | Layout |
|---|---|---|---|
| `FILL_RECT` (im Ticket „FILL_AREA") | 3 | **12 B** | x, y, w, h (je uint16 BE) + colorId, patternId, isEdgeChunk (je uint8) — `sendFillRect()` |
| `PLAYER_STATE` (im Ticket „PLAYER_POS") | 2 | 9 B | x, y, playerId (uint16) + dir (uint8, 0–4 inkl. „paused") + Legacy-Trail-Flag — `sendPlayerState()` |
| `SET_PLAYER_TRAIL` | 4 | 3 + 4·n B | playerId + n Vertices (je 2× uint16) — `createTrailMessage()` |
| `EMPTY_TRAIL_WITH_LAST_POS` | 16 | 7 B | Trail-Ende beim Loop-Schluss — `createEmptyTrailMessage()` |
| `MINIMAP` | 14 | 202 B | 1 Bit/Zelle, 20×80-Viertel der auf 80×80 skalierten Karte — `arenaWorker/getMinimapPart.js` |
| `PLAYER_DIE` / `UNDO_PLAYER_DIE` | 5 / 22 | 3–7 B | playerId (+ optionale Todesposition) |
| `LEADERBOARD` | 11 | variabel | Top 10 (uint32-Score + Längen-präfixierter Name) + Gesamtspielerzahl, alle 3 s an alle |
| `UPDATE_BLOCKS` | 1 | — | **„Legacy, unused"** (JSDoc in `SendAction`) — der Server sendet das nie mehr |
| `CHUNK_OF_BLOCKS` | 6 | — | Nur noch als leerer Dummy beim Join für alte Mobile-Clients (`#sendLegacyReady()`) |

Client→Server ist minimal: im Spiel praktisch nur `UPDATE_MY_POS` (6 B), `PING`, `REQUEST_MY_TRAIL`, `HONK`; vor dem Join `SET_USERNAME`/`SKIN`/`READY`/`PROTOCOL_VERSION` (`onMessage()` in `WebSocketConnection.js`).

**Zentrale Erkenntnis:** Der heutige Server streamt Kartendaten **nicht** als rohe Tile-Chunks (`CHUNK_OF_BLOCKS`), sondern ausschließlich als Serien von 12-Byte-`FILL_RECT`-Nachrichten — vorher per `compressTiles()` in möglichst wenige Rechtecke gleichen Typs zerlegt (`Arena.js#getChunk`, gruppiert nach colorId+patternId). Ein Karten-Chunk, ein Loop-Fill und ein einzelnes Tile-Update sind wire-technisch dasselbe. *[Interpretation: Diese Vereinheitlichung ist der übernehmenswerteste Protokoll-Aspekt — ein einziges Delta-Primitiv für alles.]*

### Chunk-Streaming / Interest Management

- Konstanten (`config.js`): garantierter Viewport `MIN_TILES_VIEWPORT_RECT_SIZE = 20` um den Spieler, `VIEWPORT_EDGE_CHUNK_SIZE = 5`, Event-Viewport `UPDATES_VIEWPORT_RECT_SIZE = 25`.
- Beim `READY` erhält der Client seinen kompletten Viewport (50×50 Tiles, als komprimierte Rects), Kartengröße, Minimap und Leaderboard (`WebSocketConnection.js#onMessage`, `Player.js#sendCurrentViewportChunk`).
- Danach **Randstreifen-Streaming**: erst wenn sich der Spieler ≥ 5 Tiles von der letzten Sendeposition entfernt hat, geht ein 5 Tiles breiter, 50 Tiles langer Streifen in Bewegungsrichtung raus (`Player.js#sendRequiredEdgeChunks`, markiert mit `isEdgeChunk = 1`, damit der Client ihn beim Zurücklaufen nicht als frisches Update animiert).
- Alle Ereignis-Broadcasts (Fill-Rects, Trails, Player-State, Death) gehen nur an Spieler, deren 51×51-Update-Viewport das betroffene Rect überlappt (`Game.js#getOverlappingViewportPlayersForRect`). Spieler pflegen gegenseitige Sichtbarkeits-Sets (`#playersInViewport` / `#inOtherPlayerViewports`); beim Viewport-Eintritt werden Name/Skin/Trail nachgereicht, beim Austritt kommt `REMOVE_PLAYER` (`Player.js#playerAddedToViewport` / `#playerRemovedFromViewport`).
- **Typische Update-Größen** *[Interpretation, aus den Buffer-Größen gerechnet]*: laufendes Spiel ≈ 9 B pro Richtungswechsel eines sichtbaren Spielers, 12 B pro Fill-Rechteck (ein Loop-Schluss = meist < 20 Rects ≈ < 250 B), 202 B Minimap alle 250 ms, Leaderboard alle 3 s. Bandbreite ist trivial; die Kartengröße geht nur beim Join und an Viewport-Rändern ins Gewicht.

---

## 4. Client-Prediction

Der Client (`client/src/main.js`, Vanilla JS) kaschiert Latenz vollständig — mit derselben Speed-Konstante wie der Server:

- **Lokale Simulation:** Der eigene Spieler wird jeden Frame mit `GLOBAL_SPEED` weiterbewegt (`client/src/main.js`, Render-Loop ~Zeile 4259). Der Trail wird lokal sofort gezeichnet (`trailPush`), Richtungswechsel sofort angewandt.
- **Input-Ausrichtung am Grid:** Bei Tastendruck wird die Zielkoordinate auf das Tile gerundet; liegt der Spieler schon > 45 % über der Tile-Mitte hinaus, wird der Wechsel für das *nächste* Tile vorgemerkt (`sendDir()`, ~Zeile 1058: `blockPos < 0.45` / `> 0.55`). Gesendet wird immer `UPDATE_DIR` mit Richtung + Ziel-Tile — das Gegenstück zur serverseitigen Rückwärts-Toleranz. Bis zu 3 Inputs werden in `sendDirQueue` gepuffert (schnelle Hakenschläge).
- **Reconciliation:** Jeder lokale Wechsel landet in `lastClientsideMoves`. Kommt ein `PLAYER_STATE`-Echo vom Server (`onMessage`, ~Zeile 1622): Serverposition wird um `ping/2 × speed` extrapoliert; stimmen Richtung und Position auf < 1 Tile mit der Prediction überein *oder* matcht das Echo den Kopf von `lastClientsideMoves`, passiert nichts. Sonst **hartes Snap** auf den Serverzustand + `REQUEST_MY_TRAIL` zum Trail-Resync + Leeren der Input-Queue (~Zeile 1689–1697).
- **Rubber-Banding statt Teleport:** Läuft die Prediction dem Server voraus, wird die lokale Geschwindigkeit graduell auf bis zu 50 % gedrosselt (`offset *= lerp(0.5, 1, iLerp(5, 0, clientServerDist))`, ~Zeile 4293) — der Spieler „wartet" unmerklich auf den Server.
- **Gegner:** reines Dead Reckoning — `serverPos` + `serverDir` extrapoliert mit Ping-Offset; Tode werden lokal vorhergesagt (`playerShouldBeDead`, Trail-Berührungstest im Render-Loop), aber erst mit Server-Bestätigung final (`deathWasCertain`); dazu passt das serverseitige `UNDO_PLAYER_DIE`.

*[Interpretation: Das Muster „geteilte Bewegungs-Konstante + Ziel-Tile im Input + Rückwärts-Toleranz auf dem Server + sanftes Client-Slowdown" ist der Kern dessen, was wir für Ticket 05 nachbauen wollen — in TypeScript mit tatsächlich geteiltem Simulations-Modul statt zweier händisch synchron gehaltener Konstanten (`config.js` vs. `constants.js`, im splix-Code nur per Kommentar „should be the same value as on the client" gekoppelt).]*

---

## 5. Bots

**Der Server enthält keinerlei Bot-Logik.** Spieler entstehen ausschließlich aus WebSocket-Verbindungen (`Game.js#createPlayer`, aufgerufen nur aus `WebSocketConnection.js` beim `READY`-Opcode); eine Suche über `gameServer/` und `serverManager/` nach Bot-/AI-Code ist ergebnislos. Die Gegner auf splix.io sind echte Spieler.

Konsequenz für uns *[Interpretation]*: Für die in der Map beschlossenen Heuristik-Bots gibt es hier nichts zu übernehmen. Gangbare Architektur: Bots serverseitig als „headless clients" gegen dieselbe Player-/Input-API laufen lassen, die auch echte Verbindungen nutzen — dann bleiben Validierung und Spielregeln für Bots und Menschen identisch. (In der OSS-Recherche, Abschnitt 3.2, war `Kacper-Pietkun/splix.io-multiplayer-AI` als Bot-Heuristik-Referenz notiert.)

---

## 6. Code-Struktur & Qualität

**Monorepo-Layout:** `gameServer/` (Deno-Spielserver), `client/` (Vanilla-JS-Browser-Client), `serverManager/` (Orchestrierung mehrerer Gameserver, globale Leaderboards, `/gameservers`-Endpoint; verbindet sich per Control-Socket in den Gameserver — `serverManager/src/GameServer.js`, `gameServer/src/ControlSocketConnection.js`), `adminPanel/`, `shared/` (Rate-Limiter, PersistentWebSocket, Build-Helfer).

**Modulschnitt des Servers** (gut, übernehmenswert als Schnittvorlage):

```
Main.js                 – Komposition/Bootstrapping (CLI: mainInstance.js)
ApplicationLoop.js      – 20-Hz-Tick, Slow-Tick-Erkennung
WebSocketManager.js     – Accept, IP-/Message-Rate-Limits, Connection-Lifecycle
WebSocketConnection.js  – Protokoll-Encoding/Decoding, Opcode-Tabellen (einzige Stelle mit Byte-Layout)
gameplay/Game.js        – Weltregeln, Broadcasts, Interest Management, Leaderboard
gameplay/Player.js      – Bewegung, Input-Validierung, Trail, Viewport, Tod/Undo
gameplay/Arena.js       – Fassade über dem Worker, Tile-Spiegel, Chunk-Kompression
gameplay/arenaWorker/   – Flood-Fill, Bounds-Tracking, Minimap (eigener Thread, TypedMessenger aus „renda")
```

**Qualitätsbefund (belegt):** Kein TypeScript, aber durchgängige JSDoc-Typen, geprüft mit `tsc --noEmit` (`deno task check` in `deno.json`); **keine Tests im gesamten Repo** (kein `*test*`-File); Formatierung via `deno fmt`. Viele erklärende Kommentare auf Entscheidungsebene (z. B. warum Bounds im Worker leben, warum die Maske nötig ist) — überdurchschnittlich für ein Hobby-Projekt. Gewachsene Altlasten: Legacy-Opcodes (`UPDATE_BLOCKS`, `CHUNK_OF_BLOCKS`-Dummy), `serverToClientColorId()`-Off-by-one („mistakes have been made", Kommentar in `WebSocketConnection.js`), Exploit-Fixes hinter Protokoll-Versions-Flags, Monetarisierungs-Sonderpfade (Paid Skins, `PELI_AUTH_CODE`).

**Was man heute anders bauen würde** *[Interpretation]*: (a) geteiltes TS-Simulationsmodul für Client-Prediction und Server statt duplizierter Konstanten und doppelt implementierter Bewegungs-/KollisionRegeln; (b) ein deklarativ definiertes Protokoll (Schema → Encoder/Decoder generieren) statt handgeschriebener DataView-Cursor; (c) `Uint8Array`/Typed-Array statt `number[][]` für die Arena plus klare Single-Ownership der Tiles (nur ein Besitzer des Zustands, z. B. alles im Worker oder alles im Tick-Thread); (d) Tests mindestens für Fill, Input-Validierung und Protokoll-Roundtrips.

---

## 7. MIT-Lizenz: Pflichten bei Übernahme

Die `LICENSE` im Repo-Root ist Standard-MIT, „Copyright (c) 2023 Jesper van den Ende". Daraus folgt (belegt durch den Lizenztext):

- **Erlaubt:** Nutzung, Kopie, Modifikation, Merge, Verbreitung, Sublizenzierung, Verkauf — auch in Closed-Source- und kommerziellen Projekten. Keine Copyleft-Wirkung: unser Projekt kann eine beliebige eigene Lizenz tragen.
- **Einzige Pflicht:** Der Copyright-Hinweis und der Permission-Text müssen „in all copies or substantial portions of the Software" enthalten sein. Konkret für uns: Sobald wir **Code-Teile** übernehmen (auch übersetzt nach TypeScript, solange es eine erkennbare Kopie/Bearbeitung ist), führen wir den MIT-Text mit — praktikabel als (1) Header-Kommentar in der betroffenen Datei („Contains portions derived from splix, © 2023 Jesper van den Ende, MIT License") **und** (2) Eintrag in einer `THIRD_PARTY_LICENSES`-Datei im Repo/Bundle. Bei ausgelieferten Web-Bundles gehört der Hinweis mit ins Artefakt (z. B. License-Banner oder mitgelieferte Datei), nicht nur ins Quell-Repo.
- **Keine Gewährleistung/Haftung** seitens des Autors (AS-IS-Klausel).
- *[Interpretation, kein Rechtsrat]*: Reine **Algorithmen und Protokoll-Ideen** (inverser Flood-Fill, Rect-Deltas, Viewport-Streaming) sind urheberrechtlich nicht geschützt — eine unabhängige Neuimplementierung nach diesem Findings-Dokument löst die Attributionspflicht formal nicht aus. Da die Grenze „Idee vs. Bearbeitung" fließend ist und es nichts kostet: Attribution trotzdem immer setzen.
- **Unabhängig von der Lizenz:** „SPLIX.IO" ist eine eingetragene Marke (s. Marktrecherche, Abschnitt 2.1/4) — Code-Übernahme gibt keinerlei Namensrechte; Namensnähe vermeiden.

---

## Konkrete Übernahme-Empfehlungen (für Tickets 05 und 08)

1. **Fill:** Inversen Masken-Flood-Fill mit Bounding-Box-Begrenzung und Unfillable-Seeds nachbauen (TypeScript, Typed Arrays, vorallokierte Queue); Verhalten „eingeschlossene lebende Gegner werden ausgespart, fremdes Gebiet wird erobert" als Spielregel-Frage in Ticket 02 explizit entscheiden.
2. **Delta-Primitiv:** Ein einziges `FillRect`-Update (x, y, w, h, owner) für Chunk-Streaming, Loop-Fills und Einzeländerungen; `compressTiles`-Äquivalent serverseitig.
3. **Netcode:** Input = Richtung + Ziel-Tile; Server-Queue + `valid/invalid/valid-direction`-Validierung; 600-ms-Event-Undo mit zweiphasigem Tod; 20 Hz Tick; Rubber-Band-Korrektur im Client.
4. **Nicht kopieren:** Byte-Handcode, Tile-Doppelhaltung, Client-Monolith; Bots und Tests von Grund auf selbst.
