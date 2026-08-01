# 20 — Kreisen an der Gebietskante: Trail flackert sichtbar auf

**Beobachtung (User-Playtest 2026-07-24, präzisiert 2026-08-01):** Dreht man **am Rand des eigenen Gebiets** (A oder D gedrückt halten), sieht man immer wieder kurz einen Trail aufblitzen — **obwohl die Fläche dort längst einem selbst gehört**. Es sieht aus, als nähme man Gebiet auf; genommen wird aber nichts.

**Analyse (kein Sim-Bug, aber ein UX-Thema).** Der Kopf kann nicht stillstehen: bei gehaltener Taste fliegt er den engsten Kreis, Radius ≈ 1,61 WU. Der passt nicht in den eigenen Rand hinein, also tritt er über die eigene Kante — Trail entsteht (korrekt), der Wiedereintritt schliesst den Loop, der Fill räumt den Trail, nächste Runde dasselbe.

Entscheidend ist, dass der Effekt **zwei Phasen** hat (gemessen 2026-08-01, s. Comments):

1. **Einschwingen** — auf einem frischen 6×6-Block reicht der aus der Mitte gehaltene Kreis 3,22 WU weit gegen 3,0 WU Halbbreite, tritt also ~0,22 WU über. Das schliesst **0,2466 WU²** ein und liegt damit **über** dem wirksamen Fill-Boden (`minFillAreaWU2` = 0,01 WU²): diese Runden **nehmen wirklich Land**. Die Ausbuchtungen füllen sich zu, bis die Grenze **genau auf der Kreisbahn** liegt.
2. **Dauerzustand** — danach läuft der Kopf auf seiner eigenen, geheilten Grenze und tritt nur noch haarfein raus und rein. Jetzt liegt das eingeschlossene Segment **unter** dem Boden (das gilt ab Tiefen < 0,026 WU), der Fill wird verworfen, der Trail geräumt — **es wächst nichts mehr**. Das ist der Zustand, den der Spieler die meiste Zeit sieht, und **das** ist die Meldung oben.

Das Flackern bleibt in beiden Phasen **ehrlich**: in diesen Ticks ist man wirklich draussen und schneidbar — ein Gegner könnte genau diesen Mini-Trail schneiden.

**Entscheidungsfrage (Triage):** Ehrlichkeit behalten (Flackern zeigt reale Verwundbarkeit) vs. Politur:

- Option A — so lassen, ggf. mit Ticket 06 (Carve-/Gebiets-Visuals) neu bewerten.
- Option B — reine Render-Politur: sehr kurze eigene Trails (< ~1 WU Gesamtlänge) erst ab Überschreiten einer Mindestlänge einblenden. Verwundbarkeit bliebe sim-seitig unverändert bestehen, würde aber nicht mehr angezeigt — Ehrlichkeits-Tradeoff.
- Option C — Sim-seitige Hysterese (Innen-Toleranz ≈ Kollisionsradius), damit Sub-Radius-Ausflüge als „innen" gelten. Greift in Kollisions-/Fill-Semantik ein; nur mit sorgfältiger Property-Absicherung.

**Status:** needs-triage

_Referenz: spec §2.1/§2.2; Ticket 05 (Trail-Ableitung), Ticket 06 (Gebiets-Visuals)._

## Comments

### 2026-08-01 — Option B gebaut, gemessen, verworfen (Commit `eb637ce`, revertet in `f96bb66`)

Ein Anlauf mit Option B ist gefahren und **zurückgenommen** worden. Drei Befunde, die alle
gegen die Analyse oben stehen — der Code ist weg, die Messungen sind der Ertrag.

**1. Der Effekt hat zwei Phasen, und Option B zielte auf die falsche.**
Die Analyse oben (jetzt korrigiert) galt implizit dem frischen Block: dort tritt der Kreis
0,2229 WU über (= 2·`TURN_RADIUS_WU` − 3) und schliesst **0,2466 WU²** ein. Der wirksame
Boden ist nicht die Spec-Zahl von 1 WU², sondern `BALANCE.trail.minFillAreaWU2` = **0,01
WU²** (in Ticket 04 heruntergesetzt) — diese Runden liegen **24×** darüber und **füllen**.
Erst wenn das Gebiet auf die Kreisbahn geheilt ist, fallen die Ausbuchtungen unter den
Boden (ab Tiefen < 0,026 WU) und der Fill wird verworfen.

„Fläche wächst nicht" ist also **richtig für den Dauerzustand** — und der ist die Meldung —
aber **falsch für das Einschwingen**. Eine Regel, die beide gleich behandelt, versteckt
zwangsläufig auch echte Landnahme. Unabhängig gemessen in Ticket 07 (`rewind.test.ts`,
Commit `d743a56`): auf dem blanken Block ist der Kopf **~die Hälfte aller Ticks** ausserhalb,
mit einem Fill alle paar Ticks.

**3. Länge und Tiefe als Kriterium stehen genau invers zum Problem.**
Der Versuch blendete den eigenen Trail ein, sobald er ≥ 0,5 WU frei (Reichweite) **oder**
≥ 2,61 WU draussen gelaufen war (Auffangnetz). Ergebnis im echten Browser, 15 s mit
gehaltener Taste im Startblock:

| | Frames | Trail vorhanden | **gezeichnet** | max. Tiefe | max. Lauf |
| --- | --- | --- | --- | --- | --- |
| Versuch `eb637ce` | 901 | 454 | **70** | 0,771 WU | 7,89 WU |

Erstes Einblenden bei Lauflänge 4,09 WU / Tiefe 0,49 WU — also durch das **Auffangnetz**,
im geheilten Zustand, genau in Phase 2. Kurz: die Regel versteckt Phase 1 (wo ehrlich Land
genommen wird) und zeigt Phase 2 (wo keins genommen wird). Ein Test über **4 s** war grün,
über 15 s fällt er um; aus Spielerperspektive war keine Verbesserung spürbar.

Dazu die Empfindlichkeit gegen den Startpunkt: die Tiefe ist 2r − h (h = Abstand
Startpunkt→Kante), eine 0,5-WU-Schwelle wird also für h < 2,72 WU überschritten. In einem
6-WU-Block bleibt ein Fenster von **0,28 WU** um die Mitte, in dem eine Reichweiten-Regel
überhaupt greift. Beide Tests des Versuchs spawnten in der Blockmitte — deshalb grün.

**Was ein nächster Anlauf mitnehmen muss**

- Das trennende Merkmal ist **nicht** Länge und nicht Tiefe, sondern ob die Schleife
  nennenswert Fläche einschliesst — beim Zeichnen ist das noch nicht bekannt.
- **Aber rückblickend ist es bekannt, und der Client weiss es bereits.** `session.ts`
  unterscheidet beim `fill`-Frame längst, ob das Gebiet gewachsen ist (`grew`, heute nur
  für die Wellen-Animation: „a discarded sliver loop still clears the trail but earns no
  wave"). Genau dieses Bit trennt die beiden Phasen sauber: im Dauerzustand bringt **jeder**
  Loop-Schluss nichts ein, beim Einschwingen und beim Queren einer Lücke bringt er etwas.
  Eine Regel „verstecke den eigenen Trail, solange die letzten Loop-Schlüsse nichts
  eingebracht haben" trifft damit **nur** den gemeldeten Zustand — ohne Längen- oder
  Tiefenschwelle, ohne das Lücken-Queren zu verschlucken, und sie schaltet sich von selbst
  ab, sobald wieder Land fliesst. Das ist die erste Idee, die zu „obwohl man die Fläche ja
  bereits ausgefüllt hat" passt statt an Geometrie-Schwellen zu raten.
- **Zusatz-Anforderung vom Menschen (2026-08-01):** kurze Trails über **echte Lücken** im
  eigenen Gebiet müssen **sofort** sichtbar bleiben — dort wird Land geholt. Jede Regel,
  die nur auf Trail-Länge schaut, verschluckt diesen Fall mit.
- Option C (Sim-Hysterese) rückt damit näher: wenn Sub-Radius-Ausflüge gar nicht erst als
  „draussen" gälten, verschwänden Flackern **und** Splitter-Fill zusammen — die beiden
  hängen zusammen, was Option B nicht sehen konnte.
- Der Dauerzustand ist der Fall, der zählt; jeder Test dafür braucht ein
  **Fortschritts-Budget** (gezählte Loop-Schlüsse), keine Wanduhr-Fenster (README-Regel 3).
