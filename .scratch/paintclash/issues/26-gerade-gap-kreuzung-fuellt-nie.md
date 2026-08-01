# 26 — Eine schnurgerade Kreuzung füllt nie: kollineare Trails haben 2 Punkte

**Beobachtung (User-Playtest 2026-08-01):** „Wenn ich nur über kleine Gaps fahre, um ein
Gebiet zu schliessen, funktioniert es oft nicht. Wird nichts ausgefüllt."

**Blocked by:** — (unabhängig)

**Status:** ready-for-agent

## Befund: zwei Regeln greifen unglücklich ineinander

`appendTrailPoint` (`sim-core/geometry.ts`) faltet **vorwärts-kollineare** Bewegung in ein
Segment zusammen — bewusst so, damit gerade Fahrten O(1) Punkte kosten statt einen Vertex
je Tick. `closeLoop` (`sim-core/fill.ts:88`) verwirft aber jeden Trail mit weniger als drei
Punkten:

```ts
if (trail.length < 3) return null;
```

Fährt man **geradeaus** über eine Lücke, ist der komplette Trail kollinear und kollabiert
auf **zwei** Punkte (Startpose innen + verschmolzene Spitze). Damit greift die Schranke und
der Fang wird verworfen — nicht wegen der Fläche, sondern wegen der Punktzahl.

Und über ein kleines Gap fährt man geradeaus. Jedes kleine Lenken erzeugt einen dritten
Punkt und alles funktioniert — daher „oft nicht" statt „nie".

## Reproduktion (gemessen, `sim-core`, rein deterministisch)

Dieselbe Kerbe (12×6-Block mit 4 breiter, 3 tiefer Einbuchtung), einmal gerade gequert,
einmal mit 0,05 WU Versatz:

| Kreuzung | Trail nach `appendTrailPoint` | `closeLoop` |
| --- | --- | --- |
| schnurgerade | `[[97.9,103],[102.4,103]]` — **2 Punkte** | **`null`** |
| 0,05 WU gekurvt | 3 Punkte | **12,10 WU²** gefüllt |

Ebenso auf zwei getrennten Stücken (6×6-Blöcke, 2 WU Lücke): die gerade Überfahrt liefert
`[[99.8,100],[102.5,100]]` und damit `null`.

## Warum die Schranke da steht — und was stattdessen gelten müsste

Die `< 3` ist ein Schutz vor entarteten Ringen: aus zwei Punkten lässt sich kein Polygon
bauen, `union(territory, loop)` bekäme eine Fläche von exakt 0 und die Loch-Füllung fände
nichts. Der Fehler ist nicht die Schranke, sondern dass die **Kompaktierung dem Ring seine
Stützpunkte wegnimmt**: geometrisch ist die gerade Überfahrt eine völlig normale Schleife,
die zusammen mit der Gebietsgrenze eine echte Fläche einschliesst.

Zu prüfen (Reihenfolge = Aufwand):

- [ ] **Die Trail-Enden von der Kollinear-Faltung ausnehmen.** Der jüngste Punkt darf
      verschmelzen, solange er nicht der letzte vor dem Loop-Schluss ist. Billigste
      Variante, aber sie verschiebt nur, wo das Problem auftritt (zwei Punkte bleiben zwei
      Punkte, wenn die Fahrt exakt gerade war).
- [ ] **Beim Schliessen den Ring aus dem Trail *plus* dem Wiedereintrittspunkt bauen** —
      also nicht die gespeicherten Punkte als Ring nehmen, sondern die Sehne bewusst
      schliessen. Klärt zugleich, ob `< 3` danach überhaupt noch nötig ist.
- [ ] **Fläche statt Punktzahl entscheiden lassen.** `minFillAreaWU2` = 0,01 WU² ist bereits
      der Sliver-Boden; eine echte Null-Fläche fällt ohnehin durch. Dann kann `< 3` auf
      `< 2` sinken.

## Akzeptanz

- [ ] Eine schnurgerade Überfahrt über eine Lücke/Kerbe füllt dieselbe Fläche wie die um
      0,05 WU gekurvte (Test mit beiden Varianten, gegen den alten Code rot verifiziert).
- [ ] Property-Tests §9.2 bleiben grün (Summe + neutral = 100 %, Disjunktheit, kein Loch).
- [ ] Golden-Replay-Hash **rotiert bewusst** (Fill-Semantik ändert sich) und wird in der
      Answer benannt.
- [ ] Szenario-Abdeckung: eine Lücke über den echten Draht schliessen (DoD 5 — es ist
      Kern-Mechanik).

_Referenz: spec §2.2 (Fill), §10.4 (`minFillAreaWU2`); `appendTrailPoint` stammt aus
Ticket 04, die `< 3`-Schranke aus derselben Runde. Aufgedeckt beim Playtest zu Ticket 20._

## Comments
