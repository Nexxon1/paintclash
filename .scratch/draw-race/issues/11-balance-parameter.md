# 11 — Balance-Parameter & Startwerte

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

Welche konkreten **Startwerte** bekommen alle Balance-Parameter der Grundversion, und wie werden sie strukturiert, damit sie später (mit spielbarem Build) leicht nachjustierbar sind? Es geht um dokumentierte, begründete Ausgangswerte für die Spec — nicht um final austariertes Balancing (das braucht einen spielbaren Build und geschieht in der Implementierung).

Graduiert aus dem Map-Nebel „Spielbalance-Parameter", jetzt benennbar nach Bewegungsmodell (Ticket 01) und Regelwerk (Ticket 02). Zu klären (via /grilling + /domain-modeling):

- **Bewegung:** Tempo (Startwert aus 01: 9 Zellen/s), Drehrate (320°/s) — bestätigen/anpassen; skaliert Tempo mit Gebietsgrösse (splix-Bremse)?
- **Karte:** feste Kantenlänge der öffentlichen Arena; Zellen-/Weltmasseinheit; Default-Grössen je Spielerzahl für private Räume.
- **Spawn:** Startblock-Grösse, Spawn-Mindestabstand zu Gegnern/Gebiet, Gnadenfrist leerer privater Räume.
- **Bots:** Anzahl/Dichte in der öffentlichen Arena, Ziel-Mindestbelebung (ab wann Bots auffüllen), Verhalten grob (folgt ggf. eigenem Bot-Ticket via 08).
- **Score-Formel:** konkrete Gewichte/Kurven für Peak-Fläche × Überlebenszeit × Konkurrenz-Multiplikator (Ø menschliche Mitspieler); Normalisierung, damit Zahlen „sich gut anfühlen".
- **Trail/Fill:** ggf. Trail-Breite, minimale Flächengrösse zum Färben, Tick-relevante Werte (20 Hz aus 05).

Rahmen (entschieden): kontinuierliche Bewegung (01), Regelwerk (02), 20-Hz-Tick (05), Zielgrösse ~10–100 Spieler/Arena.

Entscheidungs-Ausgang: Balance-Kapitel der Spec mit Startwert-Tabelle und Begründungen; ausdrücklich als „in der Implementierung nachzujustieren" markiert.

## Answer

**Entschieden (2026-07-19, HITL /grilling + /domain-modeling). Alle Werte sind begründete Startwerte für die Spec — ausdrücklich in der Implementierung gegen einen spielbaren Build nachzujustieren, nicht final austariert.**

### Masseinheit

- **Welteinheit** (engl. *world unit*), Abkürzung und Code-Bezeichner **WU** (`WU` / `worldUnit`). Basis-Längeneinheit der kontinuierlichen Welt (Positionen, Distanzen, Grössen); ersetzt das grid-behaftete „Zelle" aus Prototyp/Ticket 01. Der Render-Zoom (26 px/WU im Prototyp) ist davon unabhängig.
- Tick **20 Hz** (ADR-0003) → dt 50 ms → Schritt pro Tick bei 9 WU/s = **0,45 WU**.

### Startwert-Tabelle

**Arena (öffentlich)**
- Kantenlänge **200 × 200 WU**, quadratisch, sanfte Barriere (kein Rand-Tod, Ticket 02).
- Folge: Kreuzungszeit ≈ 22 s; ≈ 52×52 WU Raum pro Entity bei 15 Entities.

**Bewegung**
- Tempo **9 WU/s**, **konstant** — *keine* Skalierung mit Gebietsgrösse (splix-Bremse verworfen: konstantes Tempo ist Genre-Standard und sauberer für die Prediction, da es nicht von der server-autoritativen Gebiets-% abhängt; Comeback-Mechanik später über die Effekt-Naht ADR-0006).
- Drehrate **320°/s** (≈ 5,585 rad/s → Wenderadius ≈ 1,6 WU).

**Spawn**
- Startblock **6 × 6 WU** (≈ 0,09 % der Karte — reales, aber winziges Zuhause, das man sofort verlassen muss).
- Spawn-Mindestabstand **25 WU** zu Gegnerkopf/-gebiet (Zielwert ≈ 2,8 s Reisezeit bis zur nächsten Gefahr; bei Gedränge bestmögliche freie Stelle statt harter Garantie). Kein Unverwundbarkeits-Timer — der Startblock *ist* der Schutz (Ticket 02).

**Trail / Fill**
- Trail-Breite **1,0 WU** (kontinuierliches Analog zum 1-Kachel-Trail von splix).
- Kopf-/Kollisionsradius **0,5 WU** (halbe Trail-Breite; für Trail-Schnitt und Kopf-an-Kopf).
- Minimale Fill-Fläche **1 WU²** — nur zum Verwerfen numerischer Splitter; jeder bewusste Loop färbt.

**Bots (öffentliche Arena)**
- Ziel-Mindestbelebung **8** Entities gesamt, solange ≥ 1 Mensch anwesend.
- Max. Bots **8**; Regel `bots = clamp(ziel − menschen, 0, 8)` — Bots weichen mit steigender Menschenzahl (sie zählen ohnehin nicht für den Score-Multiplikator), 0 Menschen → 0 Bots (Arena hiberniert, ADR-0004).
- Verhalten: Heuristik nach ADR-0005 (begrenzte Wahrnehmung, „kompetent aber schlagbar"); KI-Feintuning = Implementierung.
- ⚠ **Vorbehalt:** Ziel 8 ist CPU-abhängig und gegen den DO-CPU-Benchmark (**Ticket 14**) zu bestätigen.

**Private Räume**
- Default-Kartengrösse je Spielerzahl: `Kante = √(Spieler × 5000)` WU (dichte-gleich zur öffentlichen Arena) → 2p **100**, 4p **140**, 8p **200**, 16p **280** WU; Host frei überschreibbar.
- Default-Spielerlimit **8** (Bereich 2–16); Nachjoin default **an**.
- Gnadenfrist leerer Raum **90 s** (deckt kurze Disconnects, gibt den Code zügig frei).
- Bots default **aus** (Host-Toggle; bei Aktivierung füllt dieselbe clamp-Regel bis zum Raumlimit).

**Score**
- Formel: **`score = round(peakPct × √überlebenSek × (1 + 0,25 × ØandereMenschen) × 10)`**
  - `peakPct` = maximal gehaltener Karten-%-Anteil im Leben (0–100; kartengrössen-unabhängig → gilt auch für private Räume).
  - `ØandereMenschen` = zeitgemittelte Zahl gleichzeitig lebender *anderer* Menschen (Bots zählen nicht → kein Farmen leerer/Bot-Arenen; Ticket 02).
  - `√überlebenSek` (sublinear statt linearer Zeit) → bremst reines Campen und belohnt aktive Flächenkontrolle, da der Peak einer defensiven Basis bereits verbucht ist.
  - Berechnung beim **Tod**; identische Formel schätzt den Live-Score aufs HUD (aktueller %-Wert, verstrichene Zeit, laufender Menschen-Schnitt).
- Referenz-Grössenordnung: schneller Tod (3 %/15 s/solo) ≈ **116**, solider Lauf (15 %/120 s/4 Menschen) ≈ **3 290**, Top-Lauf (35 %/300 s/8 Menschen) ≈ **18 190**.

### Struktur (Nachjustierbarkeit — zweite Ticket-Hälfte)

- Alle Werte in **einem** typisierten, dokumentierten Modul `shared/src/balance.ts` als eingefrorenes `BALANCE`-Objekt, gruppiert (`arena` / `movement` / `spawn` / `trail` / `bots` / `room` / `score`), konsumiert von sim-core/server/client.
- **Keine Runtime-I/O** — zur Build-Zeit gebacken, hält `sim-core` rein/deterministisch (ADR-0003); ein Ort zum Tunen, typgeprüft, kein Client/Server-Drift (ADR-0002). Der 20-Hz-Tick lebt weiterhin dort neben den übrigen Konstanten.
- Runtime-Overrides (Live-A/B, DO-seitig) bewusst zurückgestellt — später ergänzbar, ohne die Grundstruktur zu ändern.

### Domänenmodell, Nebel & Scope

- Glossar (`CONTEXT.md`): neuer Begriff **Welteinheit (WU)** ergänzt; **Score**-Eintrag um die konkrete Formel aktualisiert.
- Kein neuer Nebel, keine neuen Tickets, nichts neu out of scope. Einziger offener Faden — der CPU-Vorbehalt der Bot-Zahl — ist bereits durch **Ticket 14** (DO-CPU-Benchmark) abgedeckt. Entblockt keinen weiteren Blocker vollständig: Ticket 10 (Spec-Konsolidierung) bleibt durch 12 und 15 blockiert.
