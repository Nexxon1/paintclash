# 27 — Der Wand-Gezappel-Test erreicht seine Prämisse nicht mehr

**Befund (2026-08-01, beim Abschluss von Ticket 20):** `pnpm test:scenario` ist rot mit **einem**
Test: `tests/scenario/death.test.ts` › „the soft barrier stays soft (ticket 19, spec §2.4)" ›
„jittering along the wall never kills, however often the head re-passes its own line".

**Blocked by:** — (unabhängig)

**Status:** resolved (2026-08-02)

## Was fällt — und was dabei *nicht* geprüft wird

Der Test fällt an seiner **zweiten Prämisse**, nicht an seiner Regel:

```
the head never slid a full leg back over its own line
(runs 0.7/4.6/0.1/0.8/0.1/0.8/4.0/0.1/0.8/0.1/0.8/0.1/0.5/3.8/0.1/0.8/0.1/0.8/0.1/0.8/1.2 WU
 along y=200): expected 1 to be greater than or equal to 2
```

Die erste Prämisse hält (der Kopf klebt ≥ 120 Ticks an der Wand). Verlangt sind **zwei**
monotone Läufe von > `LEG_WU / 2` = 4,5 WU entlang der Wandlinie; es kommt **einer** zustande
(4,6 / 4,0 / 3,8 — der zweite und dritte liegen *knapp* unter der Schwelle). Die eigentliche
Zusicherung, `expect(deaths).toEqual([])` — die sanfte Barriere tötet nicht —, wird damit **nie
erreicht**. Der Test sagt derzeit also nichts über Ticket 19s Regel aus; das ist der Schaden,
nicht das rote Kreuz.

## Was gemessen ist — und was daraus folgt

| Aufruf | Ergebnis |
| --- | --- |
| voller Lauf `pnpm test:scenario` | **1 rot von 2** beobachteten Läufen (grün im Lauf, der Ticket 20s Gates trägt) |
| `death.test.ts` als ganze Datei | **grün 2/2** |
| `death.test.ts -t "jittering along the wall"` | **rot 2/2** |

Zwei Dinge stehen damit fest, und beide widersprechen der ersten Vermutung, es sei ein
deterministischer Bruch:

1. **Der Test ist zeitabhängig, nicht deterministisch.** Die beiden gefilterten Rot-Läufe
   liefern *verschiedene* Lauflängen-Reihen (`0.7/4.6/0.1/0.8/…` gegen `0.1/3.8/0.1/0.8/…`) —
   derselbe gepinnte Seed, ein anderer geflogener Pfad. Der Pilot steuert pro Snapshot über
   einen echten Socket; Timing-Jitter verschiebt, wo an der Wand er landet. Der Seed pinnt die
   Spawns, aber nicht den Pfad. Es ist also ein **Flake** — und nach README-Regel 4 ist das
   genau das Signal „diese Choreografie ist fragil geworden", das behoben statt wiederholt wird.
2. **Isoliert läuft er gar nicht.** Gefiltert fällt er **immer**, als ganze Datei fällt er nie.
   Die drei Tests vor ihm hinterlassen den Arena-Zustand (wer gejoint/gegangen ist, und damit
   die Spawn-Folge), auf dem seine Choreografie aufsetzt. Das ist unabhängig vom Flake ein
   Problem: an einem Test, den man nicht einzeln fahren kann, lässt sich nicht iterieren.

**Nicht die Ursache** (nachgewiesen, nicht vermutet): weder Ticket 20 (Client-Rendering; die
Szenario-Suite fährt den Server und hat keinen `RenderState`) noch Ticket 26 — mit `fill.ts` +
`geometry.ts` auf `61d5079` zurückgesetzt, also ohne **Dichtband** und mit der alten
`< 3`-Schranke, fällt der gefilterte Lauf genauso. Die naheliegende Vermutung „das Dichtband
räumt den Wand-Trail jetzt weg" trifft nicht.

Bleibt: die Choreografie kommt an die Wand, aber nur noch *knapp* nicht weit genug an ihr
entlang — 4,0 und 3,8 WU gegen eine 4,5-WU-Schwelle (`LEG_WU / 2`). Ein einziger langer Lauf
kommt zustande, verlangt sind zwei. Die Schwelle liegt damit ungefähr dort, wo das Manöver
liefert, und Timing entscheidet die Seite.

## Zu prüfen (Reihenfolge = Aufwand)

- [x] **Zuerst reproduzierbar machen, dann suchen.** Ein `git bisect` ist hier wertlos, solange
      ein Lauf würfelt — der gefilterte Aufruf ist der einzige verlässlich rote, und *der* ist
      zugleich der, dessen Arena-Vorgeschichte fehlt. Also erst die Choreografie so aufsetzen,
      dass sie **einzeln** fährt (eigene Arena / eigener Raum, wie `room.test.ts` es macht);
      danach ist sowohl das Bisect als auch jede Messung daran erst aussagekräftig.
- [x] Reicht ein längeres Bein (`LEG_WU`), damit der Kopf zwei volle Läufe schafft — und bleibt
      es dabei ein Wand-Test (die Beine dürfen nicht ins eigene Gebiet zurückführen, sonst
      schliesst ein Fill den Trail und der Test prüft etwas anderes)?
- [x] Oder ist „zwei Läufe von je einem halben Bein" die falsche Formulierung der Prämisse? Was
      gemessen werden soll, ist **eine echte Rückpassage über die eigene Linie**, nicht eine
      Weglänge. Ein direkter Nachweis (der Kopf war auf beiden Seiten desselben
      Wandlinien-Abschnitts) wäre stabiler als eine Längenschwelle.

## Akzeptanz

- [x] Die Prämisse hält reproduzierbar, und die Regel dahinter (`deaths` leer) wird tatsächlich
      geprüft — nachgewiesen durch einen Lauf, der die Prämissen-Zeilen passiert.
- [x] Rot verifiziert: gegen die alte Karenz-Semantik (vor Ticket 19) müsste der Test fallen,
      sonst wacht er über nichts.
- [x] Fünf Läufe hintereinander grün (README-Regel 4: kein Retry).

_Referenz: Ticket 19 (Selbstschnitt = Linienkreuzung), spec §2.4 (sanfte Barriere);
`tests/scenario/death.test.ts` ab „the soft barrier stays soft". Aufgefallen beim Abschluss von
[Ticket 20](20-randkreis-trail-flackern.md)._

## Answer

Beides behoben: die Choreografie fährt jetzt **einzeln**, und die Prämisse misst die
**Rückpassage** statt einer Weglänge. Die Regel dahinter (`deaths` leer) wird wieder erreicht.

**Die Ursache war die Messung, nicht das Manöver.** Die gemeldete Lauflängen-Reihe
`0.1/3.8/0.1/0.8/0.1/0.8/0.1/0.8/4.0/…` liest sich als „der Kopf kommt nicht weit genug" —
tatsächlich sind die `0.1/0.8`-Paare **Netto-Vortrieb in derselben Richtung** (0,7 WU je Zyklus).
Ein an die Wand gepresster Kopf sägt beim Gleiten um Bruchteile eines Schritts hin und her;
`monotonicRuns` schnitt an *jedem* Vorzeichenwechsel und zerlegte damit ein echtes ~6-WU-Bein in
`3.8` plus sieben Krümel. Das Manöver lief die ganze Zeit — nur die Messung sah es nicht. Das
erklärt auch, warum Timing die Seite entschied: die Krümel fielen mal vor, mal hinter die
4,5-WU-Schwelle.

**Die neue Messung** (`tests/scenario/lib/wall-slide.ts`, 13 Unit-Tests):

- `wallSlides(xs, deadbandWU)` schneidet Beine mit einem **Totband** — eine Umkehr zählt erst,
  wenn der Kopf sich vom Wendepunkt des Beins wirklich zurückgezogen hat. Das Bein wird bis zum
  Wendepunkt protokolliert, das Totband verzögert also das Urteil, ohne das Bein zu kürzen.
  Gewählt: `4 × STEP_WU` = 1,8 WU — weit über den beobachteten Rückzügen (≤ 0,8 WU ≈ 2 Ticks),
  weit unter einem Bein (~14 WU ≈ 31 Ticks).
- `longestRePassWU(slides)` ist die **Überlappung** zweier aufeinanderfolgender Beine in
  Gegenrichtung: der Streifen Wand, den der Kopf zweimal befahren hat. Das ist die dritte Option
  der Checkliste — direkt gesagt statt aus zwei Einzellängen erschlossen.
- Gemessen wird nur innerhalb eines **ununterbrochenen** Wandaufenthalts. Zwei x-Werte von
  beidseits eines Ausflugs sagen nichts über „zurück über die eigene Linie".

**Die Isolation:** eigener privater Raum = eigenes Arena-DO (ADR-0004), Karte 140 WU
(4-Spieler-Sprosse der §10.4-Leiter), `botTarget: 0`, nur der Host drin. Vorher hing die
Choreografie an der Spawn-Folge, die die drei Tests davor hinterliessen — gefiltert fiel sie
**immer**. Jetzt spawnt der Kopf gleich, ob die Datei ganz oder gefiltert läuft.

**Die Reihenfolge der Zusicherungen ist Absicht:** `expect(deaths).toEqual([])` steht **vor** den
Prämissen. Ein Tod ist eine positive Beobachtung und braucht keine Prämisse; die Prämissen sind
nur da, damit eine *leere* Liste etwas heisst. Andersherum kippt die alte Karenz-Semantik den
Test mit „der Kopf ist nie zurückgefahren" — wahr, aber nur weil er unterwegs immer wieder starb,
und das ist der Befund, nicht das zu meldende Symptom. Genau diese Verwechslung war Ticket 27.

**Gemessen / belegt:**

| Nachweis | Ergebnis |
| --- | --- |
| Rückpassage (gefilterter Lauf, Schwelle testweise auf 999 gesetzt) | **11,2 WU** gegen 4,5 WU verlangt — Faktor 2,5 statt der alten Kante 4,6-gegen-4,5 (Beine `36.9→39.0 39.0→26.3 26.3→37.5` an `y=140`) |
| Rot gegen die alte Karenz (`collision.ts`/`step.ts`/`balance.ts` aus `3e2682b^`) | fällt auf **`expected [ …2 deaths… ] to deeply equal []`** — also auf der **Regel**, nicht auf einer Prämisse |
| `death.test.ts -t "jittering along the wall"` (gefiltert, vorher 2/2 rot) | **5/5 grün** |
| `pnpm test:scenario` (voller Lauf, vorher 1 rot von 2) | **5/5 grün**, Wand-Test 14,9–17,0 s — dieselbe Spanne, also derselbe geflogene Pfad |

**Nebenbefund, nicht Teil dieses Tickets:** in einem der Läufe *vor* dem Umbau fiel ein Test in
`bots.test.ts` (eigener Lauf, eigener Prozess, von dieser Änderung unberührt). Die Meldung wurde
nicht mitgeschnitten, und 6 gezielte Bots-Läufe plus 8 volle Suite-Läufe danach haben es nicht
reproduziert — auf `main` ohne diese Änderung ebenso wenig. Festgehalten, weil README-Regel 4
einen Flake als Signal behandelt: taucht er wieder auf, ist dies der erste Datenpunkt.

**Aufräumen dabei:** die reinen Messfunktionen liegen unter `tests/scenario/lib/` und laufen im
**Root-Vitest-Lauf**, nicht in der Szenario-Suite — ein Szenario-Test ist laut CONTEXT.md
„stack-durchgreifend … abgegrenzt gegen Unit-Test", und für Arithmetik workerd zu starten passt
nicht dazu. Szenario-Suite bleibt damit 46 + 2, Root-Suite 733.

**Gates:** typecheck · lint (0 errors) · format · 733 Unit-Tests · Szenario 46 + 2 (5×) ·
Playwright 22 — alle grün.
