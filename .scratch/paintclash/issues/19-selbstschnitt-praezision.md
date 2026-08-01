# 19 — Selbstschnitt präzisieren: Kreuzungs-Test statt Karenz-Band

**What to build:** Playtest-Befund (2026-07-24, nach Ticket 05): an der Wand kann man sichtbar **in die eigene Spur fahren, ohne zu sterben**. Ursache ist kein Bug, sondern die pauschale **Selbstschnitt-Karenz** von 4,5 WU Weglänge (`BALANCE.trail.selfCutGraceWU`): sie existiert nur, weil (a) der Trail am Kopf klebt und (b) die sanfte Barriere einen angepinnten Kopf beim Abdrehen über die eigene Wand-Spur zurückschiebt. Abseits der Wand ist Kontakt im Karenz-Band geometrisch ohnehin unmöglich — an der Wand erlaubt es aber ~2–3 WU sichtbares Überfahren der eigenen Linie.

**Präziser Vorschlag:** Selbstschnitt als **echten Kreuzungs-Test** formulieren statt als Nähe-Test mit Karenz: das Bewegungssegment des Ticks (Pose vorher → nachher) stirbt genau dann, wenn es ein **eigenes** Trail-Segment **transversal kreuzt** (proper intersection; gemeinsame Endpunkte am geklebten Schwanz zählen nicht). Damit:

- Wand-Rückgleiten und Wand-Gezappel = kollineares Überlappen, **keine** Kreuzung → überlebt (sanfte Barriere bleibt sanft; löst zugleich Watch-Item (a) aus Ticket 05: Mehrfach-Wandpässe).
- Voller Kreis / Teardrop = transversale Kreuzung → stirbt, unabhängig von der Weglänge.
- `BALANCE.trail.selfCutGraceWU` entfällt (Karenz-Fenster + Grenz-Assertions in `balance.test.ts` mit abbauen).
- **Fremde** Trail-Schnitte bleiben unverändert Nähe-Tests mit 0,5 WU (das gerenderte Band ist die Kill-Zone; Kopf-an-Kopf-Interplay aus Ticket 05 unangetastet).

**Blocked by:** 05.

**Status:** resolved (2026-08-01)

- [x] `sim-core`: Selbstschnitt in `detectDeaths` auf Segment-Kreuzung (Orientierungs-/Straddle-Test) umstellen; geklebten Schwanz über gemeinsame Endpunkte statt Weglängen-Karenz ausnehmen; Kollinear-Sonderfälle (exakte Rückfahrt auf der Wandlinie) explizit überlebbar.
- [x] Tests: Wand-Abdrehen + mehrfaches Wand-Gezappel überlebt; Vollkreis stirbt; Teardrop stirbt; Golden-Replay-Hash bei Semantikänderung bewusst regenerieren.
- [x] `shared`: `selfCutGraceWU` + zugehörige Assertions entfernen; CONTEXT.md-Eintrag „Selbstschnitt-Karenz" durch „Selbstschnitt = Linienkreuzung" ersetzen.
- [x] Rewind-Naht beachten: `detectDeaths` bleibt reine Query über Spieler-Sichten (Ticket 07 braucht dafür zusätzlich die Vorher-Pose — Signatur entsprechend planen).
- [x] CI grün inkl. Coverage (§9.7).

_Referenz: spec §2.1, §2.4, §10.4; Ticket 05 Answer (Karenz-Herleitung + Watch-Items)._

## Answer

Umgesetzt wie vorgeschlagen. Der Selbstschnitt ist jetzt eine **transversale Kreuzung** des Tick-Bewegungssegments mit einem früheren eigenen Trail-Segment; die Karenz ist ersatzlos weg.

**Das Prädikat** — `segmentsProperlyCross` in `sim-core/geometry.ts`: zwei Orientierungs-/Straddle-Tests, beide Seiten **strikt**. Jede entartete Lage antwortet `false`, und jede ist eine Spielregel:

| Lage                       | Spielsituation                                            |
| -------------------------- | --------------------------------------------------------- |
| gemeinsamer Endpunkt       | der am Kopf geklebte Zipfel; jede Trail-Ecke              |
| Berührung (T)              | ein Endpunkt landet exakt _auf_ der Linie                 |
| kollinear (auch überlappt) | der angepinnte Kopf gleitet auf der eigenen Wand-Spur zurück |
| Länge 0                    | in der Ecke festgepinnt, keine Bewegung                   |

Drei der vier hängen daran, dass eine Orientierung **exakt** 0 wird — und das leistet keine Toleranz, sondern die Koordinaten: ein gemeinsamer Endpunkt ist dasselbe Float-Paar, und die sanfte Barriere schreibt die Wandkoordinate selbst (`Math.min(arenaSizeWU, …)`), also tragen alle angepinnten Punkte bit-identische x bzw. y. Deshalb ist das Verhalten an der Wand nicht „meistens richtig", sondern entschieden.

**Die Naht:** `detectDeaths` bleibt reine Query. `DeathContext` bekommt `movedFrom(p): Point` — die Vorher-Pose, die nur `step` noch kennt (dort aus der Bewegungsschleife). `viewedBy` war das Vorbild für die Form. Einen **zurückgespulten** Selbstschnitt gibt es nicht: den eigenen Kopf sieht ein Pilot live (ADR-0003), der Rewind-Pass überspringt `owner === actor` weiter. Fremde Schnitte bleiben unverändert Nähe-Tests über `collisionRadiusWU` (`headCutsTrail`, jetzt ohne `graceWU`-Parameter).

**Bewusst in Kauf genommen:** für den _eigenen_ Trail ist die **Mittellinie** die Kill-Linie, nicht das gerenderte Band — 0,2 WU neben der eigenen Linie herzufahren überlebt jetzt (Test: „running alongside the own trail inside the collision band survives"). Für fremde Trails bleibt das Band die Kill-Zone; das war der Punkt der Aufteilung.

**Die eine Blindstelle, benannt und gepinnt:** ein Treffer, der exakt auf einem Trail-**Vertex** landet, ist für ein Proper-Crossing-Prädikat keine Kreuzung (beide angrenzenden Segmente antworten `false`). Abseits der Wand ist das die Float-Koinzidenz, die es ist. **An** der Wand ist es systematisch — und dort auch richtig: über `y = 200` kommt nichts hinaus, ein Bein, das die Wand berührt, hat keine ferne Seite, zu der gekreuzt werden könnte. Der Kopf verschmilzt mit seiner eigenen Linie und löst sich wieder — dieselbe kollineare Überlappung, die das Gleiten schon überlebt. Zwei Tests halten das fest, damit es niemand als Bug „repariert" (`geometry.test.ts` „passes exactly through the other's endpoint", `death.test.ts` „the wall has no far side").

**Gemessen / belegt:**

- Golden-Replay-Hash bewusst neu: `a1106a61` → `1b0bf266`. Die gehaltenen Turns im Skript schliessen ihren Kreis ein bis zwei Ticks später, weil jetzt die Mittellinie gequert werden muss; der Replay läuft weiter provably durch den Tod-Pfad.
- Der Vollkreis stirbt bei Tick 23 statt 22 (Kontakt bei ~2πr statt 2πr − 0,5).
- Alle drei neuen sim-core-Tests **und** der neue Szenario-Test sind gegen den alten Code rot verifiziert, nicht nur gegen den neuen grün (per `git stash` der beiden Quelldateien) — sie sind echte Regressionstests, keine Beschreibungen des Status quo.
- Watch-Item (a) aus Ticket 05 (Mehrfach-Wandpässe) ist damit erledigt: `death.test.ts` fährt 12 Zyklen angepinnt an der Wand hin und her (~7 WU Weg je Halbzyklus, also weit jenseits der alten 4,5-WU-Karenz) und prüft in jedem Tick, dass der Kopf die Wand nie verlassen hat.

**DoD 5 (Kern-Mechanik ⇒ Szenario-Abdeckung):** die sanfte Barriere hatte end-to-end **gar** keine Abdeckung. Neu in `tests/scenario/death.test.ts`: „the soft barrier stays soft" — ein Client schiebt sich über den echten Draht an die nähere Wand und rutscht dort in 9-WU-Beinen hin und her (Waypoints liegen 10 WU _hinter_ der Wand, damit der Clamp greift und der Kurs nie wandparallel wird), 120 angepinnte Ticks, kein Tod. Prämissen benennen sich selbst (README Regel 2), Fortschritts-Budget statt Wanduhr-Wette (Regel 3), eigene Adresse (Regel 6). Der Trail selbst ist nach dem Join-Sync nicht auf dem Draht, deshalb wird der Re-Pass aus den Kopf-Posen gemessen (`monotonicRuns`).

**Gates:** typecheck · lint (0 errors) · format · 702 Unit-Tests · Coverage `sim-core` 96,7 % Branch (Boden 95) · Szenario 45 + 2 · Playwright 21 — alle grün.

**Nicht angefasst:** `spec.md` (gelockt) sagt in §10.4 weiter „Kollisionsradius 0,5 WU für Trail-Schnitt". Das gilt jetzt nur noch für _fremde_ Trails. Wie bei der Neu-Tarierung von `minFillAreaWU2` in Ticket 04 steht die Abweichung begründet im Code (`balance.ts`) und in `CONTEXT.md`, nicht als Edit in der gelockten Spec.

## Comments
