# 29 — Gebiets-Deltas statt Vollbild senden

**What to build:** `encodeTerritory` schickt bei **jedem** Fill das **komplette** Gebiet
eines Spielers an **jeden** Client. Stattdessen soll nur die Änderung übertragen werden.
Das ist die billige Antwort auf die einzige Zeile, die der Engine-Tausch aus
[Ticket 23](23-fill-vertexzahl-wachstum.md) nicht angefasst hat — und sie ist unabhängig
von der CPU-Frage und von [Ticket 24](24-raster-gebiet-konzeptwechsel.md).

**Blocked by:** — (23 ist erledigt)

**Status:** needs-triage

## Woher das Ticket kommt

Ticket 24 hat die Bandbreite als eigenständiges Argument aufgemacht und in seiner
„Empfehlung" gleich die Reihenfolge festgelegt:

> Hält der Dauerzustand danach das Budget → dieses Ticket auf **wontfix**, aber die
> **Bandbreiten-Zeile bleibt offen** und wird ein eigenes, kleines Ticket (Gebiets-Deltas).

Der Dauerzustand hält (Ticket 23: 0–2 Ticket-Überläufe von 288 000 über vier Stunden).
Das hier ist dieses Ticket.

## Die Zahlen (aus Ticket 24, Dauerzustand 200 WU / 8 Entities)

| | |
|---|---|
| Vertices je Spieler | ~809 |
| Gebiets-Frame | ~6,3 KB |
| Fills | 4,85/s |
| Egress | **31 KB/s je Client**, 245 KB/s je Arena |
| | ≈ 0,9 GB pro Stunde und Arena |

**Wem das weh tut — und wem nicht.** *Nicht* der Cloudflare-Rechnung: Workers/DO berechnen
keinen Egress (T13-Recherche), und das Duration-Budget läuft über Wanduhr, nicht über
Bytes. Es trifft:

- **das Datenvolumen der Spieler** — ~110 MB pro Stunde und Client, für ein 2D-Browserspiel
  auf Mobilfunk viel;
- **die Client-CPU** — jeder 6,3-KB-Frame ersetzt ein ganzes Gebiet, also Neu-Tesselierung
  des Plateaus plus Carve-Neuberechnung (`carve.ts` drosselt die schon heute), ~5× pro
  Sekunde. Das ist Frame-Zeit im Browser, nicht Serverlast.

Damit ist es ein **Qualitäts-**, kein Kosten- oder Sicherheitsargument.

## Was zu klären ist, bevor gebaut wird

- **Was ist überhaupt ein Delta?** Ein Fill ersetzt das Gebiet durch ein Multipolygon mit
  anderen Ringen — „ein paar Vertices geändert" ist es gerade **nicht**. Kandidaten: die
  gewonnene Region (`gainedRegion` liegt in `fill.ts` bereits vor und ist klein) plus, beim
  Bestohlenen, die verlorene. Der Client müsste dann selbst vereinigen/abziehen — also
  einen Clipper im Renderpfad haben, den er seit Ticket 06 hat.
- **Der Client rechnet dann Wahrheit nach.** Heute ist das Gebiet autoritativ und wird
  ersetzt; mit Deltas akkumuliert der Client. Divergenz zwischen Server- und Client-Polygon
  wäre ein neuer Fehlerfall — es braucht einen periodischen Vollbild-Abgleich oder eine
  Prüfsumme. Das ist der eigentliche Entwurf dieses Tickets, nicht das Sparen der Bytes.
- **Alternative, deutlich billiger:** Gebiete für den **Versand** dezimieren
  (Douglas-Peucker auf Sicht-Toleranz). Das Wire-Format bliebe, der Client bliebe dumm,
  die Sim-Wahrheit unangetastet — nur die gesendete Darstellung wäre gröber. Ticket 23 hat
  gemessen, dass Simplifikation an der **Sim**-Geometrie nichts trägt (die Vertices sind
  nicht redundant), aber dort ging es um Flächen-Ehrlichkeit und Disjunktheit; für die
  reine Darstellung gelten diese Schranken nicht. Diese Variante zuerst abschätzen.
- **Messen, bevor gebaut wird.** Es gibt heute keinen Bandbreiten-Bench. Ohne eine Zahl vor
  und nach ist das ein Umbau auf Verdacht.

_Referenz: spec §4.1/4.2, §6.2; ADR-0007; Zahlen aus Ticket 24. Aufgemacht bei Ticket 23._

## Comments

### 2026-08-03 — der Bandbreiten-Bench steht: der Vorher-Wert ist 2,5× zu klein angeschrieben, und die billige Alternative trägt (löscht aber Land)

Neuer Bench [`bench/territory-bandwidth`](../../../bench/territory-bandwidth/) — 4 h Arena-Zeit,
200 WU, 8 Entitäten, Seed `20260730`, echter `step` + echte `BotPilot`s + echter
`encodeTerritory`, nur der Transport fehlt. **Der Status bleibt `needs-triage`** und das Gate
bleibt zu: dieses Ticket verlangt messen und abschätzen, und beides steht jetzt da — die
Entscheidung, ob und wie gebaut wird, ist die des Menschen.

**1. Der Vorher-Wert ist 2,5× so hoch wie hier angeschrieben.**

|                            | oben angenommen  | gemessen      |
| -------------------------- | ---------------- | ------------- |
| Gebiets-Frames/s je Client | 4,85 (nur Fills) | **8,14**      |
| **mittlerer** Frame        | ~6,3 KB          | **9,4 KB**    |
| Egress je Client           | 31 KB/s          | **76,4 KB/s** |
| je Client und Stunde       | ~110 MB          | **~268 MB**   |

Die 2,5× zerlegen sich sauber in zwei Faktoren, die sich multiplizieren:

- **Die Frame-Rate war 1,68× höher als gerechnet** (4,85 → 8,14/s), weil die Sync-Frames ganz
  fehlten. `arena.ts` schickt ein Gebiet nicht nur beim Fill, sondern auch bei jedem Tod,
  Spawn und **Steal**. Von 33 059 Sync-Frames über den Lauf gehen nur 125 auf Spawns und Tode
  (8 + 117), ~32 900 auf Gebietsdiebstahl (2,3/s). Das sind **28 % aller Gebiets-Frames**, die
  die Rechnung aus Ticket 24 nicht gesehen hat.
- **Der mittlere Frame war 1,49× grösser als gerechnet** (6,3 → 9,4 KB). Die Spitze erreicht
  27,6 KB (≈ 3 500 Vertices statt der ~809 oben) — aber für einen Mittelwert zählt der
  Mittelwert, die Spitze steht hier nur als Streuungsmass.

1,68 × 1,49 = **2,50×**; 31 KB/s × 2,50 = 77,5 gegen 76,4 gemessen. Die Bandbreiten-Zeile ist
damit **dringender** als aufgeschrieben — der Punkt „Datenvolumen der Spieler" trifft mit
~268 MB/h je Client deutlich härter als mit 110.

**2. Die „deutlich billigere Alternative" trägt — aber sie löscht Land.**

Wie hier verlangt, zuerst abgeschätzt: RDP nur auf der **Versand**-Kopie, Wire-Format und
Sim-Wahrheit unangetastet. Gemessen an `BALANCE.trail.widthWU` = 1 WU:

| Toleranz    | Ersparnis | Fläche (schlimmst./mittel) | Umriss-Wanderung | Löschungen/Frame |
| ----------- | --------- | -------------------------- | ---------------- | ---------------- |
| 0,05 WU     | 1,33×     | 0,16 % / 0,02 %            | 0,0500 WU        | 0,055            |
| **0,10 WU** | **2,38×** | 1,01 % / 0,16 %            | 0,1000 WU        | 0,191            |
| 0,25 WU     | 3,94×     | 2,67 % / 0,43 %            | 0,2500 WU        | 0,510            |
| 0,50 WU     | 6,17×     | 7,01 % / 0,68 %            | 0,5000 WU        | 0,910            |
| 1,00 WU     | 10,22×    | 13,23 % / 1,18 %           | 0,9999 WU        | 1,412            |

Kandidat ist **0,10 WU** — genau die Toleranz, die `carve.ts` für Voll-Recarves schon
ausliefert und dort „unsichtbar bei 1,2 WU Rinnenbreite" nennt: **76,4 → 32,1 KB/s**
(~268 → ~113 MB/h je Client) für 0,16 % mittleren Flächenfehler.

**Zur Einordnung gegen [Ticket 23](23-fill-vertexzahl-wachstum.md) — und zwar gegen die
richtige Spalte.** `simplifyRing` ist gewöhnliches, **zweiseitiges** RDP, zu vergleichen ist
also T23s zweiseitige Spalte (1,23× / 2,95× / 6,90× / 20,5×), nicht die disjunkt-sichere
Nur-nach-innen-Spalte mit ihren 1,11×. So gelesen liegt dieser Bench ab 0,10 WU **unter**
T23, und zunehmend: 2,38× gegen 2,95×, 3,94× gegen 6,90×, 6,17× gegen 20,5×.

Kein Widerspruch, zwei verschiedene Grössen: T23 zählt **Vertices**, hier stehen **Bytes**,
und der Frame-Überhang schrumpft nicht mit (5 Byte Kopf + 1 je Stück + 2 je Ring bleiben
stehen), sodass das Byte-Verhältnis dem Vertex-Verhältnis notwendig nachläuft. Dazu mass T23
**einen** Schnappschuss mit 4 285 Vertices, dieser Bench 4 h Frames jeder Grösse.

Was für den Versandweg trotzdem gilt und in T23 nicht galt: die Schranken dort
(Flächen-Ehrlichkeit, Disjunktheit) greifen hier nicht — der Score wird serverseitig aus der
Sim-Wahrheit gerechnet, eine gröber _gezeichnete_ Grenze verschiebt keinen Punkt.

**3. Vier Dinge, die diese Schätzung nicht zusagt — und die in die Entscheidung gehören.**

- **Die Client-CPU-Hälfte wird nur halb geheilt.** Die Frame-**Rate** bleibt 8,14/s; jeder
  Frame ersetzt weiter ein ganzes Gebiet, also tesseliert der Client weiter ~8×/s ein
  Plateau neu und rechnet den Carve nach. Billiger wird jeder Rebuild, die Häufigkeit nicht.
  **Nur die Deltas senken die Rate** — das ist das eine Argument, das dieses Ticket auch nach
  einer Dezimierung noch offen hätte.
- **Gelöschte Splitter sind eine Divergenz, keine Rundung.** Bei 0,10 WU geht etwa jeder
  **fünfte** Frame mit einem fehlenden Stück raus, während der Server es besitzt und für den
  Score zählt (spec §10.5). Das schlimmste ist 0,085 WU dick, also Sub-Pixel — aber es ist
  derselbe Fehler-Typ, den dieses Ticket den Deltas vorhält, nur kleiner und ohne
  Reconciliation-Bedarf. Zwei Einschränkungen der Zahl: sie zählt **Frame×Stück-Ereignisse**,
  keine unterscheidbaren Stücke (ein Splitter, der hundert Frames liegen bleibt, zählt
  hundertmal — Stück-Identität über Frames gibt es heute nicht), und dass die gelöschten
  Stücke **keine** Nadeln aus [Ticket 31](31-nadel-artefakte-auf-der-karte.md) sind, ist
  **keine Messung, sondern Konstruktion**: `isLandRing` in `fill.ts` speichert keinen Ring
  unter 1e-4 WU, T31 schloss mit „davon Nadeln: 0". Es gibt keine Nadeln mehr zu löschen. Die
  Spalte im Bench ist entsprechend ein Wächter auf diese Invariante, kein Fund.
- **Zwei Risiken sind ungemessen:** RDP kann einen Ring bei grober Toleranz **selbst
  schneiden**, und die Vereinfachung schiebt Grenzen auch nach **aussen**, sodass zwei
  Nachbar-Plateaus sichtbar überlappen können. Beides wäre Aufgabe eines Bau-Tickets.
- **Für die Deltas selbst gibt es kein „nachher".** Gemessen sind der Vorher-Wert und die
  _Alternative_; was die Deltas sparen würden, steht hier nicht. Der Kandidat dafür ist
  `gainedRegion`, das oben als „liegt in `fill.ts` bereits vor" geführt wird — es ist dort
  aber lokal und nicht Teil von `TickEvents`, also nicht ohne Eingriff in die Sim messbar.
  Der Satz „nur die Deltas senken die Rate" ist deshalb ein Struktur-Argument, keine Zahl.

**Nebenbefund, der über dieses Ticket hinausreicht.** RDP direkt über ein Ring-Array kann
`ring[0]` und `ring[n-1]` **nie** entfernen — ein Ring ist implizit geschlossen
(`shared/types.ts`), RDP hat aber Endpunkte und pinnt beide, sodass die zwei Vertices an der
Schlusskante bei jeder Toleranz immun sind. `simplifyRing` schneidet den Ring darum an zwei
Hüllen-Ankern auf. Wer `simplifyPolyline` künftig auf Ringe anwendet, erbt den Fehler; der
Unit-Test dazu ist gegen die naive Fassung rot verifiziert.
