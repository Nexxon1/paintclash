# 25 — Der gemeldete Freeze: der Client-Carve mahlt sekundenlang und scheitert dann

**What to build:** Der Client friert nach ~2 min Spielzeit für Sekunden ein — reproduziert
gegen die **deployte** Arena. Ursache ist **nicht** der Server-Tick (Ticket 22/23), sondern
der Plateau-Carve im Browser: `polygon-clipping` mahlt an winziger Geometrie sekundenlang
und wirft danach. Ziel: kein Frame verbringt mehr Zeit im Carve als das Frame lang ist.

**Blocked by:** — (unabhängig; berührt Ticket 23 nicht, s. „Abgrenzung")

**Status:** resolved (2026-07-31)

## Befund (Messung 2026-07-31, gegen `paintclash.secure-data.workers.dev`)

Anlass: Der User berichtete „nach ~2 min 10 s der erste kurze Full-Freeze, danach fühlte
sich das Spiel laggier an und es kamen weitere Freezes" — auf der **deployten** Version,
und mit der Frage, ob das Ticket 23 sei.

Gemessen wurde mit einem Wegwerf-Probe-Skript (Playwright gegen die Produktions-URL, 2 ×
210 s echtes Spiel): `PerformanceObserver('longtask')` für Main-Thread-Blockaden, rAF-Gaps
für sichtbare Freezes, ein gepatchtes `WebSocket` für die Ankunftszeiten der Snapshots
(= der Tick-Puls des Servers) und ein CDP-Sampling-Profiler.

**Es sind zwei verschiedene Dinge, und der Freeze ist das erste:**

| | Beobachtung | Ursache |
|---|---|---|
| **Full-Freeze** | Ein Long-Task von **4 334 ms** bei t = 127 s (Lauf 1) bzw. **4 295 ms** bei t = 75 s (Lauf 2). Der rAF-Gap daneben ist exakt gleich lang: das Bild steht. | **Client**, dieses Ticket |
| **„danach laggier"** | Snapshot-Lücken von 120–250 ms, ab t ≈ 147 s immer dichter (26 der 36 Lücken liegen in der letzten Minute) — **ohne** gleichzeitigen Long-Task, also nicht vom Browser verursacht. | **Server-Tick**, Ticket 23 |

Der Profiler nennt die Blockade beim Namen: die teuersten JS-Funktionen des Laufs sind
`compare`, `isAnEndpoint`, `comparePoint`, `comparePoints`, `getIntersection`, `vector` —
der Martinez-Sweep von `polygon-clipping`. Diese Bibliothek läuft im Client an **genau
einer** Stelle: `client/render/carve.ts` (§4.1 Carve-Through).

### Headless reproduziert — und es ist kein Skalierungsproblem

`bench/carve-budget` fährt dieselbe Geometrie (echter `sim-core`, echte Bots, echter
`PlateauCarver`, Drosselung und Band-Auswahl wie `ArenaScene.updateTerritories`) und trifft
die Produktionszahl auf die Millisekunde: **max 4 407 ms** pro Frame bei t = 251 s, erster
Überlauf bei t = 107 s, **6 Freezes > 200 ms in 5 min**.

Die teuren Aufrufe haben **winzige** Eingaben: 430–844 Plateau-Vertices, 1–3 Bänder mit
9–74 Punkten, und `rev=false` — also der inkrementelle Pfad, kein voller Recarve. Ein
`difference` dieser Größe gehört unter eine Millisekunde.

Der Instrumentierungs-Versuch, der es entschied: eine Stoppuhr **um** den `difference`-
Aufruf fing zuerst *null* Fälle. Weil sie im `try` lag — **jeder** teure Aufruf **wirft**.
Die 4,4 s sind eine Bibliothek, die sich an Float-Fast-Koinzidenzen festfrisst und dann
`unable to complete output ring` meldet. Der Catch daneben ist korrekt (Kosmetik darf das
Frame nicht mitnehmen), er verschluckt nur die Diagnose — und **die Nut erscheint nie**.

Minimiert (greedy, bis die Pathologie kippt) bleibt davon übrig: **drei** Plateau-Vertices
und **ein** Trail mit drei Punkten. **3,1 s, dann ein Throw.** Ein gemeinsamer Vertex liegt
exakt aufeinander, die Nachbarn verfehlen sich um ~1e-12 WU.

## Die Lösung: dasselbe Snap-Gitter, das der Sim seit ADR-0007 fährt

Alle Clipper-Eingaben in `carve.ts` werden auf ein **1e-4-WU-Gitter** gerastet
(`CARVE_LATTICE_INV_WU`, ein einziger Punkt im Modul: `snappedDifference`). Fast-Koinzidenz
kollabiert zu exakter Koinzidenz, und die behandelt ein Martinez-Sweep robust.

Gemessen an den sechs eingefangenen Original-Fällen:

| Variante | Gesamt | Fehlschläge |
|---|---|---|
| `polygon-clipping` roh | **12 109 ms** | **6/6** |
| `polygon-clipping` + Gitter 1e-2 | 11 ms | 0/6 |
| **`polygon-clipping` + Gitter 1e-4** | **6 ms** | **0/6** |
| `polygon-clipping` + Gitter 1e-7 | 16 ms | 0/6 |
| `polyclip-ts` (die Sim-Engine) roh | 69 ms | 0/6 |

1e-4 WU ist gewählt, weil es **gröber** als das Sim-Gitter ist: hier ist Kosmetik, und ein
gröberes Gitter kollabiert *mehr* Fast-Koinzidenzen. Es bewegt Geometrie um ≤ 5e-5 WU —
vier Grössenordnungen unter einem Bildschirm-Pixel bei jedem spielbaren Zoom.

Bemerkenswert: `polyclip-ts` (arbitrary precision) hätte alle sechs Fälle gelöst, aber
~10× langsamer als das gerasterte `polygon-clipping` — die Engine-Wahl von Ticket 06 war
richtig, ihr fehlte nur das Gitter.

## Auftrag

- [x] Snap-Gitter für alle Clipper-Eingaben in `carve.ts`, an **einer** Stelle, sodass kein
      Pfad daran vorbeikommt.
- [x] `bench/carve-budget` als dauerhafte Regressionsmessung (Prämissen-Smoke + 5-min-
      Akzeptanz), Muster wie `bench/fill-budget`: der Akzeptanzlauf manuell (spec §9.3),
      der Smoke **in CI** — wie bei den Schwester-Benches, damit ein kaputter Harness
      nicht monatelang eine leere Arena misst. Der Smoke prüft `carves` (Updates, deren
      Ergebnis nicht mehr das rohe Plateau ist) und **nicht** Zeit oder Rebuild-Zahl:
      die beiden bleiben auch dann positiv, wenn nie ein Trail fremdes Land quert.
- [x] Regressionstest aus dem **minimierten echten** Fall in `carve.test.ts` — ohne
      Zeitmessung: vor dem Gitter kam das Gebiet **unverändert** zurück (der Throw wurde
      gefangen), also ist „die Nut ist wirklich geschnitten" die ehrliche Zusage. Verifiziert,
      dass er ohne das Gitter rot ist (2,5 s, gleiche Fläche).
- [x] Diagnose-Instrumentierung restlos entfernt (`grep -rn "DEBUG-c33f"` → 0 Treffer).

## Ergebnis

| 200 WU · 8 Bots · 5 min | vorher | nachher |
|---|---|---|
| Carve pro Frame, mean | 4,30 ms | **0,9–1,0 ms** |
| Carve pro Frame, max | **4 407 ms** | **10–14 ms** (3 Läufe) |
| Frames über 16,7 ms | 8 | **0** |
| Frames über 200 ms (Freeze) | 6 | **0** |
| Peak-Vertices (Gegenprobe: gleicher Pfad) | 5 244 | 5 244 |

## Offen, bewusst notiert

1. **Der `max` wächst weiter mit der Vertex-Zahl** — er fällt in jedem Lauf in die letzten
   30-s-Fenster und landet bei 10–14 ms von 16,7 ms. Das ist jetzt echte Arbeit statt eines
   Ausreissers, aber es ist kein Sicherheitsabstand — auf einem langsamen Telefon ist es
   keiner mehr. Der Bench misst es; ein eigenes Ticket dafür gibt es noch nicht.
2. **Der Mesh-Rebuild ist gemessen und unauffällig** (Wegwerf-Spike `[DEBUG-9a71]`, nach
   dem Deploy, weil ein Rest-Freeze gemeldet blieb). `THREE.ExtrudeGeometry` über echte
   gesättigte Plateaus, 8 116 Rebuilds in 5 min: **Ø 1,11 ms**, schlimmster **einzelner**
   11,47 ms (761 Vertices), pro Frame max 14,64 ms, **0 Frames über 16,7 ms**. Kein
   Sekundenblock — der Bench darf three.js weiterhin weglassen, das ist jetzt belegt statt
   angenommen.

   Mitgeprüft, weil es die unangenehme Möglichkeit war: **macht das Carve-Gitter earcut
   langsamer?** Es erzeugt exakt berührende Vertices, und die sind earcuts klassischer
   schlechter Fall. 40 späte Plateaus, einmal auf dem Gitter und einmal um 1e-9 WU davon
   weggestupst: **52,7 ms vs. 52,3 ms — Faktor 1,01**. Das Gitter kostet die Triangulierung
   nichts.
3. **Nicht deployt.** Die Messung oben ist lokal; die Produktions-Bestätigung braucht einen
   Deploy, und der ist eine menschliche Entscheidung.

## Abgrenzung zu Ticket 23

Ticket 23 bleibt offen und unverändert: die Snapshot-Lücken in der zweiten Hälfte des
Probe-Laufs sind der Server-Tick, nicht der Browser — genau das Restwachstum, das T23
beschreibt, nur früher sichtbar als lokal, weil DO-Hardware langsamer ist als die
Messmaschine. Dieses Ticket heilt den **Freeze**, nicht das **Laggen**.

_Referenz: spec §4.1 (Carve-Through), §9.3 (Test-Ebenen); ADR-0007 (Snap-Gitter — hier auf
den Client-Clipper übertragen). Aufgedeckt aus einem User-Bericht gegen die deployte
Version._
