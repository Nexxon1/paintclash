# 20 — Kreisen an der Gebietskante: Trail flackert sichtbar auf

**Beobachtung (User-Playtest 2026-07-24):** Hält man im eigenen Startblock dauerhaft A/D gedrückt (Kreisfahren), blitzt periodisch kurz ein Trail auf und verschwindet wieder — „als würde man kurz neues Gebiet aufnehmen". Fläche wächst korrekt nicht.

**Analyse (kein Sim-Bug, aber ein UX-Thema):** Der Vollkreis hat Radius ≈ 1,61 WU; vom Blockzentrum aus reicht er bis ~3,22 WU — der 6×6-Block nur bis 3,0 an der Kantenmitte. Der Kopf **verlässt das Gebiet also real** um bis zu ~0,2 WU für einige Ticks pro Umdrehung: Trail entsteht (korrekt), Wiedereintritt schließt den Loop, der Splitter-Fill (< Schwelle) räumt den Trail, nächste Runde dasselbe. Das Flackern ist insofern **ehrlich**: in diesen Ticks ist man wirklich draußen und schneidbar/verwundbar — ein Gegner könnte genau diesen Mini-Trail schneiden.

**Entscheidungsfrage (Triage):** Ehrlichkeit behalten (Flackern zeigt reale Verwundbarkeit) vs. Politur:

- Option A — so lassen, ggf. mit Ticket 06 (Carve-/Gebiets-Visuals) neu bewerten.
- Option B — reine Render-Politur: sehr kurze eigene Trails (< ~1 WU Gesamtlänge) erst ab Überschreiten einer Mindestlänge einblenden. Verwundbarkeit bliebe sim-seitig unverändert bestehen, würde aber nicht mehr angezeigt — Ehrlichkeits-Tradeoff.
- Option C — Sim-seitige Hysterese (Innen-Toleranz ≈ Kollisionsradius), damit Sub-Radius-Ausflüge als „innen" gelten. Greift in Kollisions-/Fill-Semantik ein; nur mit sorgfältiger Property-Absicherung.

**Status:** resolved (2026-08-01)

_Referenz: spec §2.1/§2.2; Ticket 05 (Trail-Ableitung), Ticket 06 (Gebiets-Visuals)._

## Answer

**Entscheidung (Mensch, 2026-08-01): Option B** — reine Render-Politur, Sim unangetastet. Umgesetzt, aber **anders parametrisiert als die Option formuliert war**, und mit einer zweiten Regel, die im Gespräch zur Entscheidung dazukam.

### Die „~1 WU" der Option deckt den gemeldeten Fall nicht

Die Zahl in Option B ist eine Schätzung, und sie unterbietet die **eigene Analyse des Tickets**. Der Streifer ist herleitbar, nicht messbar-zufällig: Wenderadius `TURN_RADIUS_WU` = 9 ÷ (320 · π/180) = 1,611 WU, ein aus der Blockmitte gehaltener Vollkreis reicht also 2 · 1,611 = 3,222 WU gegen die 3,0 WU Halbbreite des 6×6-Blocks ⇒ Übertritt **0,223 WU**. Der Bogen, den der Kreis dabei ausserhalb verbringt:

> arc = 2 · r · acos(1 − d/r) = 2 · 1,611 · acos(1 − 0,223/1,611) = **1,711 WU**

Das deckt sich mit der Formulierung des Tickets selbst („einige Ticks": 1,711 ÷ 0,45 WU/Tick = 3,8 Ticks). Ein 1-WU-Gate hätte also die Mechanik gebaut und das gemeldete Flackern stehen lassen.

### Länge allein ist das falsche Kriterium

Beim Abstimmen des Schwellwerts kam der Fall dazu, der Option B in ihrer reinen Form widerlegt: **kleinere Lücken im eigenen Gebiet, über die man fährt und die dabei zu eigenem Land werden.** Dort *wird* Land genommen, der Trail gehört sofort auf den Schirm — und er ist genauso kurz wie der Streifer. Nach Länge sind die beiden nicht zu trennen:

| | Kopf max. draussen | Lauflänge draussen |
| --- | --- | --- |
| Streifer an der eigenen Kante | **0,223 WU** | 1,71 WU |
| Queren einer 2-WU-Lücke | **1,0 WU** | evtl. nur 2 WU |

Unterschieden werden sie durch die **Tiefe**. Der eigene Trail wird darum gezeichnet, sobald er **eins von zweien** ist:

- **Reichweite** — `TRAIL_REVEAL_REACH_WU` = `collisionRadiusWU` = 0,5 WU. Genau die Tiefe, ab der das 1 WU breite Band sein Herkunfts-Plateau nicht mehr überlappt; beim Streifer liegen im tiefsten Punkt noch 0,28 WU seiner Breite darauf. Das ist die **Hauptregel** und der Grund, dass die Lücke ihren Trail sofort zeigt (bei 2 WU Lückenbreite ~0,06 s nach dem Verlassen).
- **Lauflänge** — `TRAIL_REVEAL_RUN_WU` = 2 · r · acos(1 − 0,5/r) = **2,613 WU** ≙ 0,29 s Fahrt, der Bogen eines Vollkreises, der eine Kante einen Kollisionsradius tief schneidet. **Auffangnetz**, keine Hauptregel: flach an der eigenen Kante entlangzuschrammen bleibt für immer unter der Reichweite, ist aber real draussen und real schneidbar — ein unsichtbares Band wäre dort ein Spieler, der die Linie nicht sieht, an der er gleich stirbt.

Einmal eingeblendet, bleibt der Trail für die Exkursion sichtbar (sticky) — ein Wieder-Verstecken wäre genau das Flackern, das hier weg soll. Beides wird mit dem Trail zurückgesetzt (Fill / eigener Tod, `clearOwnTrail`).

### Was bewusst so bleibt

- **Die Sim weiss nichts davon.** Verwundbarkeit, Schnitt, Fill, Rewind: unverändert. Der Ehrlichkeits-Preis aus der Option steht — mit einer Einschränkung, die im Review herausfiel und den grösseren Teil davon wegnimmt: **einen Selbstschnitt kann diese Regel nicht kosten.** Selbstschnitt ist seit Ticket 19 eine Kreuzung der *eigenen* Linie, und der kürzeste Weg zurück auf sie ist der engste geschlossene Kreis, 2πr = **10,12 WU**. Beide Regeln feuern weit darunter (≤ 2,61 WU), eine kreuzbare Linie ist also seit mindestens 7,5 WU Fahrt gezeichnet. Übrig bleibt der **fremde** Schnitt: ein Gegner kann ein Band schneiden, das dessen Besitzer nicht sieht — bis zu 0,29 s lang. Das ist der Preis, bewusst und benannt.
- **Nur der eigene Trail.** Fremde Trails werden nie verborgen — das würde die Verwundbarkeit *des Gegners* vor dem verstecken, der sie schneiden könnte, und wäre eine Regeländerung statt Politur. Die Asymmetrie ist real und gewollt: der eigene Streifer ist beim Gegner auf dem Schirm, beim Verursacher nicht.
- **`visible` ist ein Zeichen-Urteil, kein Existenz-Urteil.** Der Trail steht weiter in `RenderState.trails`; nur `scene.ts` überspringt Band **und** Carve-Rinne (eine Rinne ohne Band darin läse sich als Bug). Der **„Fress"-Sound** liest bewusst die Existenz, nicht die Sichtbarkeit: quert man direkt von eigenem in fremdes Land, frisst der Trail ab dem ersten Tick — der Ton darf nicht auf die Zeichen-Entscheidung warten. Ein eigener Test pinnt das (`sfx-cues.test.ts`), damit es niemand als Inkonsistenz „aufräumt".

### Gemessen / belegt

- Drei neue Tests an der bestehenden Naht `renderSample().trails` (`session.test.ts`), jeder mit benannten Prämissen (README-Regel 2), sodass grün nie „es war nichts da zu verstecken" heissen kann: der Streifer-Test prüft, dass der Kopf **wirklich** austrat (`grazedFrames > 0`), ein Band **wirklich** entstand (`ribbonFrames > 0`) und die Tiefe zwischen 0,15 und 0,5 WU blieb.
- Alle drei **gegen den alten Code rot verifiziert**, nicht nur gegen den neuen grün — der Auffangnetz-Test zusätzlich gegen eine reichweiten-only-Variante, sonst wäre er eine Beschreibung des Status quo statt eines Regressionstests.
- Der Streifer-Test fährt genau **eine** Umdrehung (20 Ticks): in Produktion räumt das Fill-Frame des Loop-Schlusses den Trail je Umdrehung weg, ohne Server tut das im Test niemand.
- **End-to-end im echten Browser** (`walking-skeleton.spec.ts`, „circling in the own start block never flashes a trail"): 4 s mit gehaltener Pfeiltaste im Startblock, Abtastung je Frame. Das deckt, was der Unit-Test nicht kann — echte Tastatur, echte Frames und vor allem der **Server**, der jede Umdrehung den Loop schliesst: das Reveal-Budget gilt pro Exkursion und wird auf dem Fill-Frame zurückgesetzt; ob dieser Reset in Produktion wirklich greift (statt über ein Leben hochzukriechen und den Streifer verspätet zu zeigen), sieht man nur an einer echten Arena über viele Umdrehungen. Auch dieser Test ist **rot verifiziert**. Nebenbefund: seine Prämisse (`ribbonFrames > 0`) belegt die Analyse des Tickets erstmals **gemessen statt hergeleitet** — der Streifer entsteht im echten Spiel.
- **Gates:** typecheck · lint (0 errors) · format · 706 Unit-Tests (+4) · Coverage `client/src/game` 95,3 % Branch · Playwright 22 (+1).
- Nicht angefasst: `spec.md` (gelockt). §4.1 beschreibt den Trail als Bodenlinie; *wann* er eingeblendet wird, sagt sie nicht — die Regel steht im Code und in `CONTEXT.md` (**Streifer**), wie bei den anderen nachtarierten Werten.

## Comments
