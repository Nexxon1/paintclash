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

**Status:** resolved (2026-08-01) — Option B in ihrer *zweiten* Fassung: Render-Politur, aber am
`grew`-Bit statt an Längen- und Tiefenschwellen. S. Answer.

_Referenz: spec §2.1/§2.2; Ticket 05 (Trail-Ableitung), Ticket 06 (Gebiets-Visuals)._

## Answer

**Die Triage-Entscheidung, mit der Präzisierung des Menschen (2026-08-01):** „Ich fahre an den
Rand meines Gebiets, halte dann A oder D gedrückt um einen Kreis zu schliessen. Das wird mein
neues Gebiet. Alles gut. Aber wenn ich weiter Kreise fahre sehe ich weiterhin Trails obwohl
das Gebiet schon mir gehört." Das ist **Phase 2** und nur Phase 2. Der *erste* Kreis soll
bleiben wie er ist — er holt Land, und der Bericht nennt ihn ausdrücklich in Ordnung.

Damit fällt Option C (Sim-Hysterese) aus: sie kann nicht wissen, welcher Kreis der erste ist,
und hätte im Grenzfall genau den mitbeerdigt, den der Mensch behalten will. Gebaut ist Option
B in der zweiten Fassung — reine Render-Politur, aber am **`grew`-Bit** aufgehängt statt an
Geometrie-Schwellen. Zwei Regeln, in dieser Rangfolge:

1. **Der eigene Trail wird gezeichnet, solange der letzte Loop-Schluss Land eingebracht hat.**
   (`lastCloseEarnedLand` in `session.ts`.) Das ist die Regel. Sie trennt die beiden Phasen an
   genau dem Merkmal, das sie unterscheidet, statt an einem, das mit ihnen bloss korreliert.
   Und sie schaltet sich von selbst ab, sobald wieder Land fliesst — kein Timer, kein
   Pro-Ausflug-Budget, das über ein Leben hochkriechen kann.
2. **…und ausserdem sofort, sobald der Kopf `MIN_TRAIL_STEP_WU` = 0,1 WU frei von eigenem Land
   ist.** (`OWN_TRAIL_REVEAL_CLEARANCE_WU`.) Der Übersteuerer für den kurzen Zug, der echtes
   Land holt, während die Strähne noch kalt ist: über eine **echte Lücke**, und für den ersten
   Kreis der gemeldeten Geste, wenn er von der **Kante** statt der Blockmitte geworfen wird.

**Warum die Schwelle 0,1 WU ist und nicht 0,5 WU.** Der erste Entwurf nahm die halbe
Trail-Breite („das Band hat das Plateau ganz verlassen"). Das **verschluckte genau den Fall, für
den der Übersteuerer da ist**: in einer Lücke der Breite W kommt der Kopf nie über W/2 frei,
also deckten 0,5 WU nur Lücken ≥ 1 WU. Im Code-Review nachgemessen (zwei 6×6-Stücke, gerade
durch, kalte Strähne):

| Lücke | Frames mit Trail | gezeichnet bei 0,5 WU | gezeichnet bei 0,1 WU |
| --- | --- | --- | --- |
| 0,6 WU | 5 | **0** | 5 |
| 0,8 WU | 5 | **0** | 5 |
| 1,0 WU | 6 | **0** | 6 |
| 1,2 / 2,0 WU | 6 / 8 | 5 / 7 | 6 / 8 |

Diese Überfahrten **holen** Land (Taschenfläche ≫ `minFillAreaWU2` = 0,01 WU²) — der Fill räumt
danach den Trail, das Band war also nie zu sehen. Genau die Zusatz-Anforderung des Menschen,
verletzt. Mit 0,1 WU zeichnen alle drei ab dem **ersten Frame, in dem der Trail existiert**.

`MIN_TRAIL_STEP_WU` ist dabei kein neuer Regler, sondern der Maßstab, den diese Datei schon
hat: „der Kopf hat sich wirklich bewegt statt gewackelt". Nach unten ist die Schwelle durch die
Messung gedeckt — der Streifer kommt nie über **0,0157 WU** frei, also 6,4× Reserve:

| Kreis gestartet | max. Freiraum, während es **holt** | während es **nichts holt** | Schlüsse |
| --- | --- | --- | --- |
| Blockmitte | 0,2137 WU | **0,0157 WU** | 1 holend / 17 leer |
| Blockkante (die gemeldete Geste) | 1,2907 WU | **0,0000 WU** | 2 holend / 40 leer |
| knapp aussen | 1,8907 WU | **0,0157 WU** | 2 holend / 48 leer |

(Deterministisch gegen `step()`, 20 s gehaltene Taste, Freiraum = `distanceToTerritory`. Die
0,771 WU des Reverts sind ein Maximum über eine *ganze* Browser-Sitzung und mischen beide
Phasen — daraus liess sich keine Schwelle ableiten.)

Das **Auffangnetz** des alten Versuchs (2,61 WU Lauflänge) ist damit weg. Was es abdecken
sollte — flaches Schrammen an der eigenen Kante bleibt unsichtbar, ist aber schneidbar —, deckt
Regel 1: unsichtbar ist es genau dann, wenn es auch nichts holt, und der erste holende Schluss
gibt das Band zurück.

**Was ausdrücklich nicht passiert ist.** Die Sim ist unangetastet: Verwundbarkeit, Schnitte,
Fills, Rewind, Golden-Replay — alles bit-identisch (die einzige Änderung in `sim-core` ist eine
Export-Zeile). `visible` ist ein **Zeichen**-Urteil, kein Existenz-Urteil: der Streifer steht
weiter in `RenderState.trails`, weil er weiter existiert und sein Besitzer weiter darauf
schneidbar ist. Die Szene überspringt Band **und Rinne** (eine Rinne ohne Band darin liest sich
als Bug, nicht als Politur); der Fress-Loop liest die Liste selbst weiter (Test in
`sfx-cues.test.ts`). **Fremde** Trails sind nie versteckt — das wäre eine Regeländerung.

**Die bewusst akzeptierten Preise**, beide benannt:

- Ein **fremder** Schnitt kann auf einem Band landen, das sein Besitzer nicht sieht. Ein
  **Selbst**schnitt kann es nicht — der ist seit Ticket 19 eine Linienkreuzung, und der
  kürzeste Weg zurück auf die eigene Linie ist der geschlossene Kreis, 2πr = 10,12 WU; beide
  Regeln feuern weit innerhalb davon.
- Der Freiraum wird nur gegen **eigenes** Land gemessen. Schrammt man mit kalter Strähne
  innerhalb 0,1 WU an der eigenen Grenze *durch fremdes* Plateau, bleiben Band **und Rinne**
  aus, während der Fress-Loop hörbar spielt. Bei 0,1 WU ist das ein Streifen von einem Zehntel
  Trail-Breite (bei 0,5 WU wäre es die halbe gewesen) — schmal genug, um es hier zu notieren
  statt eine zweite Gebiets-Abfrage pro Frame dafür zu fahren.

**Rot verifiziert, und zwar jede Klausel für sich** (44 Tests an der Session-Naht, davon 7 neu):

| gegen | rot | was das beweist |
| --- | --- | --- |
| alter Code (immer gezeichnet) | 2 | die Versteck-Hälfte |
| nur Regel 1 (ohne Übersteuerer) | 4 | die Holen-Hälfte, inkl. aller drei Lückenbreiten |
| nur der Übersteuerer (ohne Regel 1) | 1 | dass ein holender Schluss das Band zurückgibt |
| beide Regeln | 0 | |

Nur `never hides an enemy ribbon` besteht gegen alle Varianten: eine **Fixierung**, kein
Regressionswächter. Die Prämisse des Streifer-Tests ist dabei **physikalisch** — ein Skim
entlang einer geraden Kante schliesst keine Fläche ein, sein Schluss holt also wirklich nichts.
Der erste Entwurf hatte dort einen Kreis aus der Blockmitte mit *fingiertem* leeren Schluss:
0,2137 WU Freiraum, die real 0,2466 WU² einbringen — eine Prämisse, die es nicht geben kann.

**Der Browser-Test wartet die Einschwing-Phase mit einem Fortschritts-Budget aus, nicht mit der
Wanduhr** (README-Regel 3; der Revert hatte genau das als Auflage notiert). Der Dauerzustand
beginnt nach **2 Schlüssen in Folge ohne Flächengewinn** und wird in **400 Frames** gemessen,
nicht in Sekunden — ein langsamer Runner macht den Test langsamer, nicht rot; die Wanduhr steht
nur als 40-s-Decke daneben. Gezählt werden die Schlüsse an der **Revision** des eigenen
Gebiets, und „hat geholt" wird per Shoelace neu ausgerechnet statt aus `RenderState.fills`
gelesen: diese Liste wird pro gerendertem Frame geleert, eine Sonde auf ihrem eigenen
rAF könnte ein Ereignis verpassen. Ergebnis: **400 Frames Dauerzustand, davon 88 mit Trail,
0 gezeichnet** — gegen den alten Code **88 von 88 gezeichnet**. Danach, in derselben Sitzung,
die Gegenprobe: Taste loslassen, geradeaus rausfahren, Band ist sofort da. Ohne diese zweite
Hälfte könnte der Test mit „nie zeichnen" bestehen.

**Szenario-Abdeckung (DoD 5): bewusst keine.** An der Kern-Mechanik ändert sich nichts, was ein
Szenario-Test über den echten Draht sehen könnte — die Suite fährt den Server und hat keinen
`RenderState`. Der Draht-Anteil (der Server schliesst die Runde und entscheidet, ob sie etwas
einbrachte) steckt im Playwright-Test.

**Gates:** typecheck · lint (0 errors; 3 vorbestehende Warnungen aus generierten
Coverage-Reports) · format · **720** Unit-Tests · Playwright **22** · Szenario **46 + 2** —
alle grün. Ein Wand-Test der Szenario-Suite fiel dabei in einem früheren Lauf dieser Sitzung;
er ist ein **vorbestehender Flake und nicht von hier**, s. Kommentar unten und
[Ticket 27](27-wandgezappel-praemisse.md).

**Review-Nachzug (beide Achsen).** Der Code-Review fand **zwei echte Fehler**, beide oben
eingearbeitet: die 0,5-WU-Schwelle verschluckte Lücken unter 1 WU (die Spec-Achse hat es
nachgemessen), und der Browser-Test trennte die Phasen per Wanduhr statt per
Fortschritts-Budget (beide Achsen, und die eigene Auflage des Tickets). Dazu: `TrailView` als
benannter Typ neben `TerritoryView` statt einer Inline-Form, `lastCloseEarnedLand` positiv
gedreht (vorher nur als doppelte Negation lesbar), Prämissen-Meldungen an allen neuen Tests
(README-Regel 2), der Doc-Kommentar von `distanceToTerritory` um seinen zweiten Aufrufer
ergänzt, und der zweite Preis oben benannt (fremdes Plateau).

**Nicht angefasst:** `spec.md` (gelockt) — §2.1/§2.2 gelten unverändert, das Urteil ist
Rendering. Neuer Begriff **Streifer** in `CONTEXT.md`.

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

### 2026-08-01 — vorbestehender Flake im Wand-Gezappel-Test, nicht von diesem Ticket

`death.test.ts` › „the soft barrier stays soft (ticket 19)" › „jittering along the wall never
kills" fiel in einem der beiden vollen Szenario-Läufe dieser Sitzung, an seiner **Prämisse**
(„the head never slid a full leg back over its own line", 1 statt 2 Läufen) — die Regel dahinter
(`deaths` leer) wird dabei nie erreicht.

Erste Lesart war „deterministisch, byte-identische Zahlenreihe"; **das war falsch**, und die
Korrektur ist die eigentliche Erkenntnis: die identischen Reihen kamen aus *gefilterten*
(`-t`) Läufen, und über mehrere Läufe hinweg unterscheiden sich auch die. Der gepinnte Seed
pinnt die Spawns, nicht den über einen echten Socket geflogenen Pfad. Gemessen: voller Lauf
1 rot / 2, ganze Datei grün 2/2, gefiltert rot 2/2 (mit verschiedenen Reihen).

Nicht von hier: Ticket 20 ist Client-Rendering, die Szenario-Suite hat keinen `RenderState`.
Auch nicht von Ticket 26 — ohne dessen Dichtband (`fill.ts` + `geometry.ts` auf `61d5079`)
fällt der gefilterte Lauf genauso. Aufgenommen als
[Ticket 27](27-wandgezappel-praemisse.md) statt hier mitgenommen.
