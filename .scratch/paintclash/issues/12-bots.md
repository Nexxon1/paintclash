# 12 — Bots (Heuristik über dieselbe Eingabe-Schnittstelle)

**What to build:** Server-interne **Bots**, die die öffentliche Arena beleben. Sie speisen ihre Befehle über **dieselbe Eingabe-Schnittstelle** wie Netz-Spieler ein (Quelle = lokale KI-Heuristik statt WebSocket), mit **begrenzter Wahrnehmung** („kompetent aber schlagbar"). Zielbelebung 8 Entities, solange ≥ 1 Mensch anwesend ist; `bots = clamp(ziel − menschen, 0, 8)`; 0 Menschen → 0 Bots (Arena hibernert). Bots zählen **nicht** für den Konkurrenz-Multiplikator des Scores (kein Farmen leerer Arenen).

**Blocked by:** 06.

**Status:** resolved (2026-07-30)

- [x] Bots als server-interne Entities über die gemeinsame Intent-Schnittstelle (kein Sonderpfad, ADR-0005), gekapselt im `server`-Paket; per Konstruktion nicht schummelbar. → [`packages/server/src/bot.ts`](../../../packages/server/src/bot.ts); der ganze Output eines Pilots ist **ein `TurnSignal`**, das in dieselbe `TickInputs.turns` läuft wie ein dekodierter Client-Intent.
- [x] Begrenzte Wahrnehmungs-Sicht; Heuristik spielt den vollen Kern-Loop (rausfahren, Loop schließen, Fill, ausweichen). → `senseFor` filtert auf `sightRadiusWU` 40 (≈ Kamera-Distanz des Clients), `reactionTicks` 4 (200 ms) begrenzt die Entscheidungs-Kadenz; Tests fahren echte Sim-Ticks und fordern Fills bzw. Abbruch-nach-Hause.
- [x] `bots = clamp(ziel − menschen, 0, 8)`; 0 Menschen → 0 Bots; Bots füllen nur freie Slots (Menschen zuerst). → `ArenaCore.manageBots`; Bots zählen gegen das **Ziel**, nie gegen `LIMITS.maxConnections` — sie können also keinen Verbindungs-Slot belegen.
- [x] Bots fließen **nicht** in `ØandereMenschen` (Score) ein — verifiziert mit Ticket 09. → die `isBot`-Naht aus T09 trägt; verifiziert am Arena-Seam **und** über die echte Leitung (`avgOtherHumans === 0` bei 1 Mensch + 7 Bots).
- [x] Ziel-Zahl 8 gegen Ticket 02 (DO-CPU-Benchmark) abgeglichen und ggf. angepasst (dokumentiert). → bleibt **8**; Nachtrag in [`docs/benchmarks/do-cpu-benchmark.md`](../../../docs/benchmarks/do-cpu-benchmark.md) inkl. erstmaliger Messung der Heuristik (**0,017 ms/Tick** für alle 8) und eines Funds für T16 (s. Answer).
- [x] Szenario-Test: Belebung folgt der clamp-Regel bei Join/Leave. → [`tests/scenario/bots.test.ts`](../../../tests/scenario/bots.test.ts), beide Richtungen über die echte Leitung.
- [x] CI grün inkl. Coverage (§9.7) — lokal alle Gates grün: typecheck, lint (0 Fehler), format, **477** Unit/Property, **18** Szenario (16 hermetisch + 2 Bots), Coverage-Böden (`server` 96,6 % vs. Boden 75 %; `bot.ts` 100 % Zeilen), **12** E2E.

_Referenz: spec §2.7, §10.4; ADR-0005._

## Answer

**Bots sind gewöhnliche Spieler mit einer anderen Eingabe-Quelle.** Ein `BotPilot` bekommt
pro Tick einen `BotSight` (eigener Zustand + fremde **Köpfe innerhalb 40 WU**, sonst nichts)
und gibt **einen `TurnSignal`** zurück. Mehr Vokabular hat er nicht — „nicht schummelbar" ist
damit keine Zusicherung, sondern der Rückgabetyp. Spawn läuft über `botJoins` (T09-Naht),
Steuerung über `turns`; Leaderboard, Tode, Territory-Syncs und Kollisionen behandeln Bots
ungeprüft wie Menschen. Der Client braucht **keine Zeile** Änderung.

**„Kompetent aber schlagbar" hat zwei Regler**, beide in `BALANCE.bots`: die Sichtweite (40 WU,
an `CAMERA_DISTANCE_WU` bemessen — ein Bot weiß so viel wie der Mensch, gegen den er spielt)
und `reactionTicks` 4 — zwischen zwei Entscheidungen fliegt der Pilot blind weiter. Der
Kern-Loop ist eine Exkursion (Spitze → U-Turn → Rückspur 5 WU daneben, > 2× Wenderadius, sonst
wäre jeder Lauf ein Selbstschnitt); die **Heimkehr ist absichtlich kein Waypoint**, sondern
live aus dem eigenen Gebiet abgeleitet, damit ein Bot, dem das Zuhause weggestohlen wurde,
noch auf Land zielt, das er besitzt. Ausweichen und Expositions-Deckel teilen eine Antwort:
Exkursion abbrechen, kürzester Weg heim — was den Loop schließt, Flucht malt also.

**Messung (200-WU-Arena, 8 Bots, 60 s):** 202 Fills, **0 Tode**, ~12,8 % der Karte. In einer
gedrängten 60-WU-Arena: 308 Fills, 9 Tode — sie sterben, wenn es eng wird, nicht an sich selbst.

### Zwei Funde

1. **Ein Bot kann sich lautlos festsetzen.** Im Probe-Lauf stand einer 40 s an der Wand,
   Fläche konstant: sein Kopf lag **exakt** auf der eigenen Gebietskante, die zugleich die
   Arena-Kante war. „Ziele auf den nächsten eigenen Randpunkt" heißt dort „ziele auf dich
   selbst" → Intent 0, sanfte Barriere hält ihn. Und es ist **unsichtbar**: ein angepinnter
   Kopf legt keine neue Spur, also greift auch der Trail-Deckel nie. Behoben zweifach —
   Waypoints werden geclampt geflogen (aber **ungeclampt bewertet**, damit die *Wahl* die
   Wand noch sieht) und die Heimkehr fällt auf die Gebietsmitte zurück. Beide Wege sind
   einzeln getestet: der Aggregat-Test („jeder Bot schließt in den letzten 20 s einen Loop")
   und ein exakter Reproduktions-Test, der die Float-Koinzidenz herstellt — ohne die
   Rückfall-Logik parkt er in allen fünf Varianten für immer.
2. **Die synthetische Last aus T02 unterschätzt den echten Fill um ~100×.** Die Bot-Heuristik
   selbst ist mit 0,017 ms/Tick (alle 8) vernachlässigbar — der echte Tick kostet aber
   **2,74 ms** statt der synthetisch geschätzten 0,02 ms, weil die polyclip-Boolean-Ops auf
   gewachsenen Ringen dominieren. Mit 4×-Faktor: ~11 ms von 50 ms. Kriterium gehalten, aber
   **ohne** die zwei Größenordnungen Reserve, die T02 annimmt → explizit notiert als Aufgabe
   für **Ticket 16** (Re-Konfirmation gegen den echten Build).

### Entscheidungen, die über das Ticket hinausgehen

- **`ArenaCore` populiert nur auf Anforderung** (`botTarget` default 0); die DO-Schale übergibt
  das Produktions-Ziel, genau wie sie schon Seed und Arena-Größe entscheidet. Das passt
  zugleich zum Spec-Default für private Räume (§10.4: Bots **aus**) und hält jeden Test bei
  „die Arena enthält nur, wen der Test hineingesetzt hat".
- **Suiten laufen bot-frei** (`ARENA_BOTS`, s. Regel 5 in [`../README.md`](../README.md)): die
  Szenario-Choreografien und Playwright fliegen exakte Zustände; sieben zusätzliche Entities
  machten daraus Manöver, die *meistens* klappen. Belegt: mit voller Arena fällt die zweite
  Browser-Zeile aus den Top 5 und der E2E-Leaderboard-Test wird **zu Recht** rot. Die
  Population selbst wird in `bots.test.ts` gegen die Produktions-Konfiguration geprüft.
- **Bots tragen keinen Bot-Namen.** Ohne Verbindung greift der bestehende `guestName`-Fallback,
  sie erscheinen also als „Gast-####" wie ein Mensch ohne Namen — die Naht, die der Kommentar
  in `broadcastLeaderboard` seit T08 vorgesehen hat. Namens-Politik ist Ticket 13.
