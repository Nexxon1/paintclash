# 23 — Fill-Kosten im Sättigungs-Gleichgewicht (Rest aus Ticket 22)

**What to build:** Ticket 22 hat den berichteten Freeze beseitigt (max/Tick 189 → 36–43 ms
über 5 min, 0 Ticks über Budget) — aber mit **konstanten Faktoren**, und die 5-Minuten-
Messung endet **vor** dem eigentlichen Dauerzustand. Ziel: der Dauerzustand einer
stundenlang laufenden Arena hält das Budget.

## Korrektur vorab: die Kurve divergiert NICHT, sie sättigt

Ticket 22 notierte „die Kurve steigt weiter, bei 10 min ist die Arena wieder drüber".
Über 30 min gemessen (200 WU, 8 Bots, Seed 20260730) stimmt das **nicht**:

| Fenster | Ø Vertices |
|---|---|
| t = 450–870 s | 6 592 |
| t = 900–1 770 s | 6 473 (**−1,8 %**) |

Nach ~7 min ist die Vertex-Zahl im **Gleichgewicht** und pendelt dort die restlichen
23 Minuten zwischen ~5 100 und ~8 000. Das ist auch geometrisch zu erwarten: die Vertex-
Zahl ist `Randlänge / Vertex-Abstand`, der Abstand ist mit **0,45 WU** fest (Tempo ×
Tickdauer), und die Randlänge ist durch die Karte beschränkt. 6 500 Vertices entsprechen
~2 900 WU Rand — 8 runde Kleckse à 5 000 WU² hätten allein schon 2 005 WU. Die Gebiete
sind also normal geformt, nicht fraktal; da kommt nicht mehr viel dazu.

**Das Problem ist damit ein anderes, als T22 dachte:** nicht unbeschränktes Wachstum,
sondern dass das **Gleichgewicht selbst zu teuer** ist. Im Dauerzustand:

| | 5 min (T22-Akzeptanz) | 30 min (Dauerzustand) |
|---|---|---|
| mean | 1,60 ms | 4,91 ms |
| p95 | 12,0 ms | 31,7 ms |
| p99 | 18,2 ms | **51,9 ms** |
| max | 44 ms | **138 ms** |
| Ticks über 50 ms | 0 | **420 von 36 000 (1,2 %)**, ab t = 355 s |

1,2 % der Ticks reissen das Budget — im Schnitt alle ~4 s ein Hänger von 50–140 ms. Kein
Freeze mehr, aber auch nicht „läuft ewig sauber". Die T22-Akzeptanzmessung über 5 min ist
schlicht zu kurz, um den Dauerzustand zu sehen; sie sollte auf 30 min gehen.

**Mildernd, aber nicht verlässlich:** Tode setzen Gebiete auf 6×6-Blöcke zurück, und Bots
töten einander kaum (31 Tode in 30 min). Die 50-WU-Arena mit 96 Toden in 5 min bleibt bei
~1 200 Vertices. Eine Arena mit echten Menschen liegt also unter diesem Plateau — aber
darauf zu bauen heisst, die Performance von der Sterberate abhängig zu machen.

**Blocked by:** — (unabhängig; T16 misst die Populationsgrenze gegen echte Infrastruktur
und liefert den Härtetest für das hier Entschiedene)

**Status:** needs-triage

## Wo die Zeit im Gleichgewicht hingeht

Bei ~6 500 Vertices ist nichts mehr „unnötig": der Vorfilter aus T22 wirft schon 95 % der
Carve-Ops weg, und die grösste verbleibende Position ist die **eine** unvermeidbare Op pro
Fill — `union(territory, loop)`, ~70 % der Fill-Zeit. Deren Kosten hängen allein an der
Vertex-Zahl des eigenen Gebiets. Es gibt keinen Algorithmus-Trick mehr zu holen; es sind
schlicht zu viele Vertices für `polyclip-ts`.

Dazu: **mit dem 4×-Hardware-Faktor** (Konvention aus T02) liegt schon der 5-min-p95 bei
~50 ms von 50 ms. Lokal grün heisst also nicht grün auf Cloudflare-Metal. Ob der Faktor
für diese Last stimmt, weiss nur T16.

## Was Ticket 22 als Ansatz 3 vorschlug — und was die Messung dazu sagt

T22 nahm an, eine Toleranz-Simplifikation (Douglas-Peucker auf Lattice-Skala) in
`compactRing` würde „das unbegrenzte Wachstum stoppen". **Gemessen an echten, gesättigten
Gebieten (200 WU, 300 s, 4 285 Vertices) trägt das nicht:**

| Toleranz | nur nach innen (disjunkt-sicher) | zweiseitig (bricht Disjunktheit) |
|---|---|---|
| 0,01 WU | 1,03× weniger, −0,00 % Fläche | 1,04× |
| **0,05 WU** | **1,11×**, −0,03 % | 1,23× |
| 0,10 WU | 1,52×, −0,24 % | 2,95×, −0,33 % |
| 0,25 WU | 2,03×, **−1,16 %** | 6,90×, −7,6 % |
| 0,50 WU | 3,35×, **−4,42 %** | 20,5×, −41,5 % |

Zwei Befunde:

- **Die Vertices sind nicht redundant.** `appendTrailPoint` faltet gerade Strecken längst
  zusammen; was übrig bleibt, ist echtes Kurvenfahren. Bei einer Toleranz, die Geometrie
  ehrlich lässt (≤ 0,05 WU = 5 % der Trailbreite), holt die Simplifikation **11 %**.
- **Der Ausweg „zweiseitig" ist keiner.** Nur zweiseitige Vereinfachung bringt ~3×, und
  sie schiebt Grenzen **nach aussen** — direkt gegen die paarweise Disjunktheit (spec
  §9.2), die derselbe Ticket-Punkt grün halten wollte. Ausserdem ist der Kartenanteil der
  **Score** (§10.5): 1,2 % Fläche still abzuschneiden ist ein Scoring-Bug, kein Rundungsfehler.

Ansatz 3 ist damit **nicht** der Hebel, für den T22 ihn hielt. Wer die Kurve flach will,
braucht etwas anderes.

## Ansätze, in empfohlener Reihenfolge

- [ ] **1. Schnellere Boolean-Engine — zuerst, weil billig und folgenlos.** ~70 % der
      Fill-Zeit ist `union(territory, loop)`, eine einzige Op, deren Kosten allein an der
      Vertex-Zahl hängen. `polyclip-ts` (ADR-0007) ist reines JS-Martinez; ~5 ms für ~500
      Vertices ist für diese Grösse viel. Clipper2 als WASM ist typischerweise 10–50×
      schneller — und rechnet **auf Ganzzahlen**, was zum vorhandenen 1e-7-Snap-Gitter
      passt wie angegossen (das Gitter *ist* schon ein Integer-Raster). Reiner Faktor:
      gleiche Semantik, gleiche Geometrie, gleiche Sichtbarkeit, gleiches Wire-Format;
      nur ADR-0007 ändert sich. Reicht ein 10×, ist das Thema für die Polygon-Bauart
      erledigt. **Zuerst als Spike messen**, nicht direkt einbauen.
- [ ] **2. Raster statt Polygon — der strukturelle Ausweg, falls 1 nicht reicht.** Das ist
      das, was paper.io/splix tun, und der Grund, warum die ewig laufen: Gebiet = festes
      Zellgitter (`ownerId` je Zelle), Fill = Scanline-Flood-Fill der eingeschlossenen
      Region. Kosten hängen an der **bemalten Fläche**, nie an der Historie — konstant,
      egal ob die Arena 5 Minuten oder 5 Tage läuft. Nebengewinne, die leicht übersehen
      werden: Disjunktheit wird **strukturell unmöglich** zu verletzen (eine Zelle hat
      genau einen Besitzer — eine ganze Klasse Invarianten und Clipper-Wächter entfällt),
      `pointInTerritory` wird von O(Vertices)-Raycast zu **O(1)**-Array-Zugriff (das läuft
      pro Spieler pro Tick!), und die Fläche fürs Scoring wird ein Integer-Zähler.
      200 WU bei 0,5 WU/Zelle = 400×400 = 160 kB `Uint8Array` im DO.
      **Wichtig:** paper.io hat *gitterbasierte Bewegung*; das ist hier nicht nötig. Kopf,
      Trail und Kollision bleiben kontinuierlich (der Rewind aus T07 und die Kill-Fairness
      hängen daran) — **nur das Gebiet** wird gerastert. Kosten: gequantelte Ränder
      (Rendering via Marching Squares oder direkt Zellen), Wire-Format wird Zell-Deltas
      statt Polygone, rotiert den Replay-Hash, berührt spec §2.2 + ADR-0007. Braucht eine
      eigene ADR.
- [ ] **3. Union nur gegen das berührte Stück** (kleiner Zusatz-Faktor, falls 1 knapp
      reicht). Ein Gebiet ist ein Multipolygon; der Loop berührt meist genau ein Stück.
      Die übrigen sind bbox-getrennt und könnten unverändert durchgereicht werden
      (dieselbe Beweisführung wie `skipsCarve`). Achtung: die Loch-Füllung darf keine
      Pocket verlieren, die zwei Stücke *gemeinsam* einschliessen — dort wird der Beweis
      schwierig, und das ist der Grund, das nicht als Erstes zu versuchen.
- [ ] **Nicht** Ansatz 3 aus T22 (Toleranz-Simplifikation) — gemessen widerlegt, s. oben.
- [ ] Akzeptanz: `bench/fill-budget` auf **1 800 s** verlängert (5 min sehen den
      Dauerzustand nicht) hält beide Arenen unter Budget — d. h. **0** Ticks über 50 ms,
      nicht 420.
- [ ] Property-Tests §9.2 bleiben grün (Summe + neutral = 100 %, Disjunktheit, kein Loch).

_Referenz: spec §2.2, §6.2, §9.2; ADR-0003 (Determinismus), ADR-0007 (Boolean-Engine).
Aufgedeckt bei Ticket 22._
