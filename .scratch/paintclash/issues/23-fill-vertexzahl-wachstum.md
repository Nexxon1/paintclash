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

**Blocked by:** — (28 ist **erledigt** seit 2026-08-02: die Basislinie ist verstanden, s.
Kommentar unten. T16 misst daneben die Populationsgrenze gegen echte Infrastruktur und
liefert den Härtetest für das hier Entschiedene.)

**Status:** resolved (2026-08-02) — s. `## Answer` am Ende

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

## Comments

### 2026-07-31 — Zwei Messungen aus Ticket 25, ohne die Engine anzufassen

Ticket 25 ging einem User-Bericht nach („nach ~2 min Freeze, danach laggier") und
maß dabei zweierlei, das hierher gehört. **Das Gate ist unangetastet: nichts davon
hat den Sim-Clipper geändert.**

**1. Der Dauerzustand ist in Produktion sichtbar — früher als lokal.** Ein
Playwright-Probe-Lauf über 210 s gegen `paintclash.secure-data.workers.dev` (frische
Arena, 8 Bots, ein echter Browser-Spieler) zeigt Snapshot-Lücken von **120–250 ms**,
ab t ≈ 147 s zunehmend dicht — **26 der 36 Lücken liegen in der letzten Minute**.
Gleichzeitige Long-Tasks im Browser gibt es dort **keine**, es ist also der Tick, nicht
der Client. Das ist genau die Kurve dieses Tickets, nur ~2,5× früher als die lokale
Messung (t = 355 s) — passend zum 4×-Hardware-Faktor. Die Vermutung von T22/T23, dass
lokal-grün keine Produktions-Reserve ist, ist damit **belegt statt angenommen**.

Der Freeze im selben Bericht ist **nicht** dieses Ticket (Client-Carve, Ticket 25).
Das Laggen ist es.

**2. Ansatz 1, gemessen — der Spike, den das Ticket verlangt.** 98 echte
`union(territory, loop)` und 57 echte `difference(other, gained)` wurden aus einer
gesättigten Arena (200 WU, 8 Bots, t = 400–420 s, Seed 20260730) abgegriffen und
**identisch** durch beide Engines gespielt:

| Op | polyclip-ts | polygon-clipping | Faktor |
|---|---|---|---|
| `union` (n=98, Ø 764 Subjekt-Vertices) | 9,12 ms/op | **1,05 ms/op** | **8,7×** |
| `difference` (n=57) | 9,63 ms/op | **0,94 ms/op** | **10,2×** |

Null Fehlschläge auf beiden Seiten, **gleiche Vertex-Zahl** im Ergebnis, grösste
Flächenabweichung **3,6e-12 WU²** (Float-Rauschen). Die Schätzung „~10×" aus
`carve.ts` stimmt also für echte Sim-Geometrie.

**Was damit NICHT erledigt ist.** Der Haken bei Auftrag 1 bleibt bewusst offen: gefahren
ist der **Spike** („als Spike messen, nicht direkt einbauen"), nicht der Tausch. Und die
**1 800-s-Variante von `bench/fill-budget` fehlt weiterhin** — das Ticket nennt sie
ausdrücklich als Bedingung („ohne sie ist das Ergebnis nicht beurteilbar"), sie ist Teil
desselben Auftrags und gehört zum Öffnen des Gates dazu. Die 8,7×/10,2× oben sind also ein
**halbes** Entscheidungspaket: die Faktoren ohne die Dauerzustands-Basislinie, gegen die
sie zu rechnen wären.

**Der Haken, den Ticket 25 dazu geliefert hat — und der vor der Entscheidung gehört:**
genau diese Engine hat im Client sekundenlang gemahlen und dann geworfen, an
drei-Vertex-Geometrie, weil ihre Eingaben **nicht** gerastert waren. Im `sim-core`
liegen sie auf dem 1e-7-Gitter, und in den 155 Ops oben ist nichts passiert — aber
„0 von 155" ist kein Beweis, und im autoritativen Tick wäre der Preis eines solchen
Falls eine für alle stehende Arena plus ein still verwirkter Fill. Bemerkenswert dazu
aus derselben Messreihe: von allen probierten Gittern war ausgerechnet **1e-7 das
langsamste** (ein Fall 11 ms statt 1 ms) — falls getauscht wird, ist die Gitterweite
mit zu messen und nicht aus ADR-0007 zu übernehmen.

**Entscheidung am Gate (2026-07-31, Mensch): vorerst liegen lassen.** Zuerst soll sich
Produktion **ohne** den Freeze aus Ticket 25 zeigen — gut möglich, dass das Restlaggen
weniger stört, als es neben einem 4-Sekunden-Standbild aussah. `Status` bleibt darum
`needs-triage`, und die nächste Runde beginnt mit der fehlenden 1 800-s-Basislinie.

### 2026-08-02 — die 1 800-s-Basislinie liegt vor, und sie widerlegt die Prämisse dieses Tickets

Der zweite Auftragspunkt ist gebaut: `bench/fill-budget` hat eine 30-Minuten-Variante
(`pnpm --filter @paintclash/bench-fill-budget bench:steady`, `src/steady.test.ts`).
**Der Sim-Clipper ist unangetastet** — die Änderung liegt vollständig in `bench/`, das
Gate ist zu. Gemessen auf derselben Maschine und mit demselben Seed (20260730) wie die
Zahlen oben:

| 200 WU · 8 Bots · 30 min | 2026-07-31 | **2026-08-02** |
|---|---|---|
| mean | 4,91 ms | **7,84 ms** |
| p95 | 31,7 ms | **50,80 ms** |
| p99 | 51,9 ms | **90,57 ms** |
| max | 138 ms | **230,14 ms** |
| Ticks über 50 ms | 420 (1,2 %), ab t = 355 s | **1 860 (5,17 %), ab t = 221 s** |
| Tode | 31 | 25 |
| Peak-Vertices | ~8 000 | **10 502** |

Die 50-WU-Arena bleibt dagegen unauffällig: mean 1,51–1,66 ms, p95 7,51–8,23 ms,
p99 12,19–14,03 ms und **0–3 Ticks über Budget** über volle 30 Minuten (zwei Läufe,
540 Tode). Die Spanne ist Stoppuhr, nicht Geometrie — Fills, Tode und Vertex-Zahl stimmen
zwischen den Läufen auf die Einheit überein, bei Ticks von ~1,5 ms ist der `max` GC-Rauschen.
Der todgetriebene Sägezahn funktioniert also weiterhin; auseinander läuft ausschliesslich
der todarme 200-WU-Fall — 3 Ausreisser-Ticks gegen 1 860.

**Die Korrektur ganz oben in diesem Ticket gilt nicht mehr.** „Die Kurve divergiert
NICHT, sie sättigt" war am 31.07. richtig gemessen (6 592 → 6 473, **−1,8 %**). Heute:

| Fenster | Ø Vertices |
|---|---|
| t = 450–1 125 s | 6 375 |
| t = 1 125–1 800 s | 8 501 (**+33,3 %**) |

Das ist kein Artefakt des Fenster-Schnitts. In den **exakt gleichen** Fenstern wie damals
(t = 450–870 gegen t = 900–1 770) liegen die Werte bei 6 060 → 8 074, ebenfalls **+33 %**.
Die Vertex-Zahl steigt bis t = 1 350 s auf 10 311 und steht am Ende des Laufs bei 8 842 —
sie pendelt nicht mehr um ein Plateau, sie wandert nach oben.

Die neue Prämissen-Zusicherung im Bench hat genau das gemeldet, statt die Zahlen still als
Basislinie auszugeben:

> vertices still moved 33.3 % between the two halves of the tail (6375 → 8501) — this run
> never reached a plateau, so its tick costs are not a steady-state baseline

**Warum das den Umfang dieses Tickets trifft.** Der Abschnitt „Umfang: NUR Ansatz 1"
begründet sich wörtlich mit der Sättigung: „Weil die Kurve **sättigt**, ist ein ausreichend
grosser konstanter Faktor hier eine *dauerhafte* Lösung und kein Aufschub — gegen ein festes
Plateau von ~6 500 Vertices erschlägt ein 10× die 1,2 % Überläufe für immer." Gegen ein
Plateau, das es in dieser Form nicht mehr gibt, ist ein 10× ein **Aufschub**: bei 5,17 %
Überläufen und p99 90,57 ms kauft derselbe Faktor deutlich weniger Luft, und er kauft sie
gegen eine steigende statt eine flache Kurve. Die Entscheidung am Gate ist damit eine
andere als die, die hier vorbereitet wurde — deshalb wird sie hier auch nicht getroffen.

**Der wahrscheinliche Grund ist keine Messschwankung, sondern eine Regression** zwischen
dem 31.07. und heute — der 5-Minuten-Akzeptanzbench aus Ticket 22 ist auf `main`
**rot** (57 Ticks über Budget statt 0). Das ist ein eigener Fund und steht in
[Ticket 28](28-fill-kosten-regression-seit-t22.md).

**Status bleibt `needs-triage`, das Gate bleibt zu.** Nächster Schritt ist nicht der
Engine-Tausch, sondern Ticket 28: solange die Kosten aus einer unverstandenen Regression
stammen, misst jeder Vorher/Nachher-Vergleich der Engine gegen eine Basislinie, die selbst
kaputt ist.

### Kommentar 2026-08-02 (nach [Ticket 28](28-fill-kosten-regression-seit-t22.md)) — entblockt, aber die Prämisse ist weg

Die Regression ist bisectiert und **erwünscht**: Ticket 19 (Bots sterben nicht mehr am
eigenen Trail, 6 → 1 Tode, Vertices +26,5 %) und Ticket 26 (31 von 66 leer ausgehenden
Loop-Schlüssen greifen jetzt, Vertices +11,7 %). Kein Rückbau, und damit ist die Basislinie
**gültig**: `main` malt 7 408 Peak-Vertices bei 200 WU, und das ist ab jetzt im Bench
festgenagelt (`ARENAS` in `budget.test.ts`).

**Was das Gate hier angeht:** die Sättigungs-Annahme, auf der der Umfang „NUR Ansatz 1"
steht, ist damit nicht gerettet, sondern **erklärt** — und dadurch erst recht widerlegt.
Die Kurve sättigte am 31.07., weil Bots einander und sich selbst töteten; seit Ticket 19
töten sie sich fast nicht mehr (1 Tod in 5 min, 25 in 30 min). Genau der Mechanismus, den
dieses Ticket als „mildernd, aber nicht verlässlich" notiert hat, ist weggefallen — und das
Plateau mit ihm. Die 6 500 Vertices, gegen die ein 10× „für immer" reichen sollte, sind
kein Fixpunkt der Geometrie, sondern waren ein Fixpunkt der Sterberate.

Zwei Konsequenzen für den nächsten Schritt, beide vor dem Engine-Tausch zu entscheiden:

1. Der Engine-Tausch bleibt messbar und lohnend (Union ist ~70 % der Fill-Zeit), aber
   er ist gegen eine **steigende** Kurve ein Aufschub, kein Abschluss. Das war das
   Argument, mit dem [Ticket 24](24-raster-gebiet-konzeptwechsel.md) ursprünglich
   geöffnet und dann zurückgestellt wurde; es ist wieder offen.
2. Die Bot-Sterberate ist jetzt ein **Kosten-Parameter**, nicht nur ein Balance-Thema.
   Ob eine Arena mit Menschen die Vertex-Zahl deckelt, ist eine Frage, die dieser Bench
   per Konstruktion nicht beantworten kann (er kennt nur Bots).

**Status bleibt `needs-triage`, das Gate bleibt zu** — jetzt aber aus dem Grund, aus dem
das Ticket es aufgestellt hat (die Entscheidung gehört einem Menschen), nicht mehr wegen
einer unverstandenen Messung.

## Answer

**Das Gate wurde am 2026-08-02 vom Menschen geöffnet** („Ticket 23 jetzt"), mit einer
Ergänzung zum Akzeptanzkriterium, die das Ticket so nicht hatte: das Spiel soll **dauerhaft
flüssig** laufen, nicht mit der Zeit immer laggier werden. Der Auslöser war eine
Beobachtung an der deployten Version — „ab ca. 3 min wirkt es laggy, und die Bewegung
entspricht nicht immer dem Input". Das ist genau die Kurve dieses Tickets: ein Tick, der
120–250 ms braucht, liefert keinen Snapshot; der Client rechnet weiter und wird beim
verspäteten Snapshot zurückkorrigiert. Kein Input-Bug, sondern die Rückkorrektur danach.

### 1. Ansatz 1 ist gebaut: `polyclip-ts` → `polygon-clipping`

Der Aufruf liegt jetzt hinter einer Naht (`sim-core/src/clipper.ts`) statt in einer
Import-Zeile in `fill.ts` — die Engine ist eine Entscheidung, und die Fehler-Injektions-
Tests (`fill-forfeit`, `fill-corrupt`) mocken ab jetzt die Naht statt eines
Herstellernamens. ADR-0007 hat einen Nachtrag mit der vollen Begründung.

Der Auftrag verlangte, drei Dinge zu prüfen. **Korruptions-Tests und der
Bowtie-/Spiral-Fall:** grün ohne eine einzige Anpassung (173 sim-core-Tests, 740 im
Root-Lauf, 48 Szenario-Tests in workerd, 22 E2E). **Die „mismatched builds":** real, und
mit demselben Interop-Shim erschlagen, den `carve.ts` seit Ticket 06 trägt — er hat jetzt
eigene Tests (`clipper.test.ts`), weil ein Testlauf immer nur *eine* der beiden Bundle-
Formen sieht und der Zweig, der in Produktion zählt, sonst ungetestet bliebe. **Dass das
Paket unmaintained ist:** getragen von drei Dingen, nicht von Optimismus — die Version ist
gepinnt, die Naht macht einen weiteren Tausch zu einer Änderung an einer Stelle, und
`polyclip-ts` bleibt als Dev-Abhängigkeit installiert und prüft in `fill.test.ts` gegen.
**Clipper2-WASM** war damit nicht nötig und bleibt der dokumentierte Ausweg.

**Die Gitterweite bleibt 1e-7** — gemessen im Sinne von ADR-0007s Auflage, aber
entschieden aus einem Grund, der nichts mit Geschwindigkeit zu tun hat: das **Dichtband**
aus Ticket 26 muss eine Grössenordnung über dem Gitter liegen, um das Snapping zu
überleben, und weit unter dem Fill-Boden bleiben. Bei 1e-7 ist das breiteste Band
4e-4 WU² gegen einen Boden von 0,01 WU²; bei 1e-6 wären es 40 % des Bodens — eine
Regeländerung, kein Tuning. Der Client darf 1e-4 fahren, weil er kein Band hat.

### 2. Die Messung: Vorher/Nachher, beide auf derselben Maschine

| 200 WU · 8 Bots · 30 min | vorher        | nachher  | Faktor |
| ------------------------ | ------------- | -------- | ------ |
| mean                     | 9,00 ms       | 1,13 ms  | 8,0×   |
| p95                      | 59,36 ms      | 6,52 ms  | 9,1×   |
| p99                      | 98,98 ms      | 11,45 ms | 8,6×   |
| max                      | 569,72 ms     | 33,36 ms | 17×    |
| Ticks über 50 ms         | 2 389 (6,6 %) | **0**    | —      |

Die 8,7×/10,2× aus dem Op-Spike vom 31.07. bestätigen sich damit an der ganzen Sim.

### 3. Die Prämisse dieses Tickets war ein Messartefakt — die Kurve sättigt doch

Das ist der eigentliche Fund, und er kippt die Begründung, mit der dieses Ticket zuletzt
auf `needs-triage` stand („die Kurve steigt, ein Faktor ist nur Aufschub").

Über **vier Stunden** Arena-Zeit gemessen (200 WU, 8 Bots, Seed 20260730, 288 000 Ticks):

- **Kein Aufwärtstrend.** Dieselbe `saturationOf`-Rechnung, die über 30 Minuten +33,3 %
  bzw. +19,1 % las, liest über 4 h **−3,2 %**. Die Vertex-Zahl pendelt trendfrei zwischen
  ~5 000 und ~10 500.
- **Warum die 30-Minuten-Messung log:** die Vertex-Zahl ist ein **Sägezahn** mit einer
  Periode von Dutzenden von Minuten. Ein 30-Minuten-Lauf halbiert seinen Schwanz in zwei
  **11-Minuten**-Fenster — weniger als eine Periode. Verglichen wurde ein Tal gegen einen
  Berg. Das erklärt auch, warum am 31.07. −1,8 % und am 02.08. +33,3 % herauskam: beide
  Male dasselbe zu schmale Fenster, nur eine andere Phase.
- **Die Kosten werden über die Zeit nicht schlechter.** Letzte der vier Stunden:
  p95 6,78 ms, p99 11,39 ms, **0** Überläufe — eher besser als der Gesamtlauf.
- Über drei Vier-Stunden-Läufe: **0, 1 bzw. 2** Ticks über 50 ms von 288 000.

Die Konsequenz für den Umfang „NUR Ansatz 1" ist damit die ursprünglich gedachte, nicht
die zuletzt befürchtete: gegen ein beschränktes Plateau ist der Faktor eine **dauerhafte**
Lösung. Ehrliche Einschränkung: **ein** Seed, **eine** Population, **Bots** statt Menschen.
Der Sägezahn hängt an der Sterberate, und Bots sterben selten (124 Tode in 4 h) — eine
Arena mit Menschen liegt unter diesem Plateau, nicht darüber.

Nicht nachgemessen: dass die alte Engine über 4 h dieselbe Kurve gezeigt hätte (das wären
~53 min Wanduhr). Belegt ist es indirekt und stark genug: über 5 min ist die Geometrie
zwischen beiden Engines **bit-identisch**, über 30 min fast (10 499 vs. 10 502 Vertices).
Die Vertex-Kurve ist eine Eigenschaft der Regeln, nicht der Engine.

### 4. Was anders kam, als das Ticket ankündigte

- **Der Golden-Replay-Hash rotiert NICHT.** Das Gitter rastet die Ausgaben beider Engines
  auf dieselben Punkte.
- **Die `ARENAS`-Basislinie in `budget.test.ts` rotiert NICHT** — 7 408 / 1 368 / 1 und
  1 750 / 2 527 / 79 kommen auf die Einheit gleich heraus. Es war also nichts
  neu aufzunehmen.
- **Property-Tests §9.2 sind nicht nur grün, sie sind schärfer geworden:** `polyclip-ts`
  bleibt als _dev_-Abhängigkeit liegen und rechnet in `fill.test.ts` die Definitionen nach.
  Aus der Engine ist ein **unabhängiges Orakel mit anderer Arithmetik** geworden.

### 5. Zwei Änderungen am Bench, die dazugehören

- **`bench:steady` misst 4 h statt 30 min** (`STEADY_SEC`, `SETTLE_SEC = 1800`). Das ist
  eine **bewusste Abweichung** vom Auftrag oben, der wörtlich eine „1 800-s-Variante"
  verlangt: die gibt es im Baum nicht mehr. Der Grund ist der Fund aus Punkt 3 — ein Lauf,
  dessen Vergleichsfenster schmaler ist als die Sägezahn-Periode, beantwortet die Frage
  nicht, die er stellt, und der Auftrag wollte eine belastbare Dauerzustands-Messung, nicht
  die Zahl 1 800. Die 30-Minuten-Zahlen für Vorher **und** Nachher, die der Auftrag
  ebenfalls verlangt, stehen trotzdem hier und im Bench-README; reproduzierbar sind sie
  über `STEADY_SEC`. Läuft ~8 min, beide Arenen grün.
- **`runArena` gibt den Event-Loop je simulierter Sekunde zurück.** Der lange Lauf
  blockierte ihn am Stück, Vitests Reporter-RPC lief aus, und der Befehl endete mit
  Exit-Code 1, obwohl beide Tests grün waren. Bei 30 min war das die im README notierte
  „bekannte Kosmetik"; bei 4 h wäre es ein Bench, dessen Exit-Code nichts mehr bedeutet.

### 6. Was offen bleibt

- **Die Bandbreite** — ~31 KB/s je Client, weil jeder Fill das komplette Gebiet an jeden
  Client schickt. Kein Engine-Tausch berührt das. Ticket 24s „Empfehlung" sieht für genau
  diesen Fall vor, dass daraus „ein eigenes, kleines Ticket (Gebiets-Deltas)" wird — das ist
  jetzt [Ticket 29](29-gebiets-deltas-statt-vollbild.md).
- **Die Bestätigung gegen Produktion.** Lokal 0 Überläufe heisst mit dem 4×-Faktor:
  p95 ~29 ms von 50 (passt), p99 ~53 ms (auf der Linie), einzelne `max` darüber. Vorher
  waren dieselben Zahlen 237 ms und 396 ms. Ob der Faktor stimmt, sagt nur eine Messung
  gegen `paintclash.secure-data.workers.dev` — `bench/prod-arena` liegt dafür bereit, und
  der nächste Deploy ist der Anlass.
- **[Ticket 24](24-raster-gebiet-konzeptwechsel.md) steht auf `needs-triage`, obwohl das
  Gate oben „Ticket 24 auf `wontfix`" vorschreibt.** Zweite bewusste Abweichung, und die
  einzige, die eine Entscheidung offen lässt. Die Bedingung ist erfüllt (der Faktor reicht),
  das CPU-Argument von Ticket 24 ist damit erledigt — aber zwei Dinge sprechen gegen ein
  automatisches Zuklappen: die **Bandbreiten-Zeile** überlebt den Engine-Tausch und ist der
  eine Posten, den Ticket 24 allein für sich beanspruchen konnte; und der Mensch hat heute,
  beim Öffnen dieses Gates, ausdrücklich Interesse an dem Raster-Ansatz geäussert
  („vielleicht die nachhaltigste Lösung"). Ein Ticket auf `wontfix` zu setzen, während der
  Mensch am selben Tag danach fragt, wäre eine Entscheidung, die diesem Lauf nicht gehört.
  Sie steht als offener Punkt in Ticket 24s Kommentar.
