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

## Umfang dieses Tickets: NUR Ansatz 1

Weil die Kurve **sättigt** (s. o.), ist ein ausreichend grosser konstanter Faktor hier
eine *dauerhafte* Lösung und kein Aufschub — gegen ein festes Plateau von ~6 500 Vertices
erschlägt ein 10× die 1,2 % Überläufe für immer. Darum ist der Engine-Tausch der ganze
Auftrag, und alles Weitere ausdrücklich **nicht**.

> **Entscheidungs-Gate — hier wird angehalten.** Nach der Messung aus Ansatz 1 endet die
> Arbeit an diesem Ticket, unabhängig vom Ergebnis. Reicht der Faktor: Ticket auflösen und
> Ticket 24 auf `wontfix`. Reicht er nicht: Ergebnis **berichten und den nächsten Schritt
> mit dem Menschen entscheiden** — nicht selbständig zu Ansatz 2 oder Ticket 24
> weitergehen. Beide berühren Architektur-Entscheidungen (ADR-0007, spec §2.2), und die
> gehören nicht in einen AFK-Lauf.
>
> Deshalb steht oben auch `Status: needs-triage` und nicht `ready-for-agent`: das Ticket
> ist bewusst noch nicht für `/implement` freigegeben.

### Der Auftrag

- [ ] **Schnellere Boolean-Engine.** ~70 % der Fill-Zeit ist `union(territory, loop)`,
      eine einzige Op, deren Kosten allein an der Vertex-Zahl hängen.
      **Der wahrscheinlichste Kandidat liegt schon im Repo:**
      `client/render/carve.ts` hatte dasselbe Problem und löste es mit
      `polygon-clipping` — „same Martinez sweep, float + robust predicates, **~10×
      faster**" als `polyclip-ts`, das arbitrary-precision rechnet. Der Client fährt das
      seit T06 produktiv. Der Grund für polyclip-ts im `sim-core` war **Robustheit**, nicht
      Determinismus (float-Martinez ist im Sinne von ADR-0003 genauso deterministisch), und
      das Snap-Gitter existiert genau dafür, float-Robustheit zu tragen.
      Zu prüfen: die Korruptions-Tests (`fill-corrupt`, `fill-forfeit`) und der
      Bowtie-/Spiral-Fall gegen die andere Engine; `polygon-clipping` ist unmaintained und
      liefert laut carve.ts „mismatched builds". Fallback: Clipper2 als WASM (rechnet auf
      **Ganzzahlen**, was zum 1e-7-Gitter passt wie angegossen — das Gitter *ist* schon
      ein Integer-Raster). **Als Spike messen**, nicht direkt einbauen; rotiert den
      Replay-Hash.
- [ ] `bench/fill-budget` bekommt eine **1 800-s**-Variante — 5 min sehen den Dauerzustand
      nicht, und ohne sie ist das Ergebnis nicht beurteilbar. Vor **und** nach dem Tausch
      messen, beide Zahlen in die Answer.
- [ ] Property-Tests §9.2 bleiben grün (Summe + neutral = 100 %, Disjunktheit, kein Loch);
      Golden-Replay **rotiert** (andere Engine ⇒ andere Vertex-Koordinaten) — bewusst und
      in der Answer benannt.
- [ ] Akzeptanz **dieses** Tickets ist die **Messung plus Entscheidung**, nicht „Budget
      gehalten". Hält der Dauerzustand danach 0 Ticks über 50 ms, ist der Fund geschlossen.
      Hält er nicht, ist das Ticket trotzdem korrekt abgearbeitet — dann entscheidet der
      Mensch über Ansatz 2 / Ticket 24. Dieses Kriterium ist absichtlich so formuliert:
      „so lange weitermachen, bis das Budget hält" würde einen AFK-Agenten genau in die
      Architektur-Änderungen treiben, die hier nicht allein getroffen werden sollen.

## Ausdrücklich NICHT Teil dieses Tickets

Hier nur zum Nachschlagen — jeder dieser Punkte braucht vorher eine menschliche
Entscheidung:

- **Union nur gegen das berührte Stück.** Ein Gebiet ist ein Multipolygon; der Loop
  berührt meist genau ein Stück, die übrigen sind bbox-getrennt und könnten unverändert
  durchgereicht werden (dieselbe Beweisführung wie `skipsCarve`). Kleiner Zusatz-Faktor,
  falls Ansatz 1 knapp reicht. **Haken:** die Loch-Füllung darf keine Pocket verlieren,
  die zwei Stücke *gemeinsam* einschliessen — genau dort wird der Beweis schwierig, und
  das ist der Grund, es nicht nebenbei mitzunehmen.
- **Raster statt Polygon** → eigenes **Ticket 24**, mit ausformulierter Abbruchbedingung.
  Dort steht auch der eine Posten, den kein Engine-Tausch heilt: die **Bandbreite**
  (~31 KB/s je Client, weil jeder Fill das komplette Gebiet an jeden Client schickt) —
  Datenvolumen und Client-CPU, **nicht** Cloudflare-Kosten (Workers/DO berechnen keinen
  Egress, s. T13-Recherche).
- **Gebiets-Deltas statt Vollbild** senden — die billige Antwort auf genau diese
  Bandbreiten-Zeile, unabhängig von CPU und von Ticket 24. Bisher kein eigenes Ticket.
- **Toleranz-Simplifikation** (Ansatz 3 aus T22) — gemessen widerlegt, s. oben. Nicht
  erneut versuchen, ohne die Tabelle zu widerlegen.

_Referenz: spec §2.2, §6.2, §9.2; ADR-0003 (Determinismus), ADR-0007 (Boolean-Engine).
Aufgedeckt bei Ticket 22._
