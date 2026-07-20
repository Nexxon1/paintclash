# 03 — Ein Spieler bewegt sich end-to-end (Walking Skeleton)

**What to build:** Der erste vollständige vertikale Durchstich. Man öffnet den Browser, gibt einen Namen ein, joint die öffentliche Arena und steuert einen **Kopf** per Tastatur durch die quadratische 200×200-**Arena**; am Rand gleitet der Kopf an der **sanften Barriere** entlang (kein Rand-Tod); man startet auf einem 6×6-**Startblock**. Die Bewegung ist server-autoritativ — der Client sendet **nur Steuer-Intent**, der Server re-derived die Position bei festem Tempo und geklemmter Drehrate — fühlt sich dank Prediction/Reconciliation/Interpolation aber flüssig an. Kein Trail, kein Fill: nur die komplette Pipeline steht.

**Blocked by:** 01.

**Status:** done (2026-07-19)

- [x] `shared`: eingefrorenes `BALANCE` (arena/movement/spawn-Startwerte) + Tickrate **20 Hz** als einzige Quelle der Wahrheit (§10.6), von `sim-core`/`server`/`client` identisch gelesen.
- [x] `sim-core`: reine `schritt(zustand, inputs, dt)` mit **festem dt**, ohne echte Uhr, mit **eingespeistem gesätem RNG**; kontinuierliche Bewegung (Tempo 9 WU/s, Drehrate 320°/s), sanfte Barriere, Spawn mit Startblock + Mindestabstand 25 WU.
- [x] `protocol`: Binär-Nachrichten join / **Steuer-Intent** (mit Input-Sequenznummer) / Snapshot; Input-Batching-fähig (Free-Budget, WS 20:1).
- [x] `server`: Arena-DO mit 20-Hz-Tick fährt `sim-core` autoritativ; WS-Annahme; **Intent-only-Validierung** an der Protokollgrenze (Opcode/Länge/Wertebereich verwerfen; Intent an Socket-`playerId` gebunden — §8.2); minimaler **Router-Worker** liefert den Client aus und leitet WS ans eine öffentliche Arena-DO.
- [x] `client`: Tastatur-Steuerung (A/D bzw. Pfeile); Prediction (fährt `sim-core` lokal); Reconciliation (weiches Nachziehen); Interpolation der Gegner; three.js-Szene (Arena-Boden, perspektivischer Tilt); Render-Interpolation zwischen Ticks ist Pflicht.
- [x] `sim-client`: erstes **headless**-Werkzeug, spricht das echte Binär-Protokoll.
- [x] Tests: **Replay-Determinismus** (gleiche Inputs+Seed → bit-identischer Zustands-Hash nach N Ticks), **Protocol-Round-trip + Golden-Bytes**, **Szenario-Test** (Server + Sim-Client bewegt Kopf), eine kuratierte **Playwright-E2E** (echte Tastatur-Eingabe im Browser).
- [x] CI grün inkl. Coverage-Gates der berührten Pakete (§9.7 DoD) — lokal alle Gates grün (typecheck, lint, format, Coverage, Szenario, Build, E2E); CI-Lauf steht aus, bis das GitHub-Remote verdrahtet ist (offener Punkt aus Ticket 01).

_Referenz: spec §2.3–2.4, §3, §5, §6, §8.2, §10; ADR-0002/0003/0004._

## Comments

**2026-07-19 (Agent, Umsetzung):** Vertikaler Durchstich steht end-to-end.

- **Pakete:** `shared` (BALANCE + 20-Hz-Tick + `TurnSignal`), `sim-core` (`step(state, inputs, dt)`, mulberry32-RNG im State, `advancePlayer` als geteilte Bewegungs-Mathematik für Server & Prediction, `hashSimState` FNV-1a), `protocol` (binär, little-endian: join/input-batch/welcome/snapshot; Decoder = all-or-null), `server` (`ArenaCore` node-testbar + dünne `ArenaDO`-Schale + Router), `client` (Predictor/Interpolator/KeyTracker/ClientSession headless-getestet; three.js-Szene + `main.ts` als ungetestete Schale; vite-Build → `client/dist`, von Worker-Assets ausgeliefert), `sim-client` (transport-agnostisch, echtes Protokoll).
- **Tests:** 115 Unit/Property/Replay (inkl. Golden-Replay-Hash `845f6194`, Golden-Bytes), 5 Szenario-Tests (echtes DO via `tests/scenario`, eigenes hermetisches wrangler.jsonc ohne Assets), 2 Playwright-E2E (echte Tastatur, zwei Browser in einer Arena). Coverage-Gates: sim-core/protocol/sim-client 100 %, server/client über Schwellen (DO-/Render-/DOM-Schalen begründet ausgenommen, s. vitest.config.ts).
- **Zwei über die Leitung gefundene Bugs:** (1) Seq-Konvention — erster Intent mit seq 0 wurde vom ack=0-Server verworfen; Konvention jetzt „seq startet bei 1". (2) Neuere compat-Dates liefern Binär-Frames im DO als **Blob** statt ArrayBuffer — Handler kann beides (Szenario-Tests sahen nur ArrayBuffer, erst `wrangler dev` zeigte den Blob-Pfad).
- **Offen/Notizen:** Namen werden im Join übertragen und serverseitig gespeichert, aber noch nicht gebroadcastet (Anzeige = Ticket 08/13). CI-Pipeline um Szenario-Schritt erweitert; echter CI-Lauf hängt an der offenen Account-Verdrahtung aus Ticket 01.

**2026-07-19 (Agent, Review):** Zwei-Achsen-Review (/code-review, Standards + Spec) durchgeführt; Befunde behoben:

- **Spec-Bug (wesentlich):** Server kollabierte einen 3-Tick-Input-Batch zu *einem* Turn für *einen* Tick — ein kurzer Tastendruck ging autoritativ verloren. Jetzt: **Input-Queue** pro Spieler, genau ein Intent pro Tick angewendet (rekonstruiert die Client-Zeitachse), Ack = zuletzt *angewendete* Seq, Flood-Deckel `LIMITS.maxPendingInputs` (älteste fallen weg).
- Einzige-Quelle-der-Wahrheit-Verstöße: hartkodiertes `DT_SEC` (session.ts) → `TICK_DT_SEC`; `BLOCK_SIZE` (scene.ts) → `BALANCE.spawn.startBlockWU`.
- Schwellen gem. §8.3 "neben BALANCE": neues eingefrorenes `LIMITS` in `shared` (Garbage-Kill, Flush-Kadenz, Queue-Deckel).
- `Predictor.sample` interpoliert jetzt auch das Heading (Render-Interpolation ist Pflicht, §4.3); Kommentar zur Fehler-Abkling-Halbwertszeit korrigiert (~80 ms).
- Eigener Startblock wird jetzt gerendert (`selfBlock` im RenderState statt NaN-Sentinel im Renderer).
- CONTEXT.md um neue Begriffe ergänzt (Welcome, Ack, Input-Queue, Garbage-Toleranzfenster, `LIMITS`).
- Bewusst nicht umgesetzt: Spawn bleibt 16-Kandidaten-best-effort (§2.3-konform); Seq-Obergrenze („server-begrenzt" nach oben) = Selbstschaden, → Ticket 15; SimClient/ClientSession-Ähnlichkeit bleibt (Testwerkzeug bewusst entkoppelt); Blob-Zweig im DO ist nachweislich der Live-Pfad unter aktuellem compat-Date (kein toter Code).

Endstand aller Gates: typecheck ✓ lint ✓ format ✓ 119 Unit/Property/Replay ✓ (Coverage-Gates erfüllt, sim-core/protocol/sim-client 100 %) 5 Szenario ✓ Build ✓ 2 E2E ✓.

**2026-07-19 (Agent, Nachbesserung Ruckeln):** User-Report: Ruckler ~alle 0,5 s, gelegentliche Teleports, fremde Spieler deutlich schlimmer. Mit einer Headless-Browser-Sonde reproduziert und quantifiziert (Soll: konstant 9 WU/s gerenderte Geschwindigkeit):

| Messung | vorher | nachher |
|---|---|---|
| Eigener Kopf | 0,45–0,9-WU-Doppelschritte (sd 0,15) | **8,94 ± 0,03 WU/s** |
| Fremder Spieler | **komplett eingefroren** (Geist) | **8,96 ± 0,05 WU/s** |

Vier Ursachen, vier Fixes:
1. **Geister-Spieler:** Close-Events des klassischen `accept()`-WebSocket kommen unter `wrangler dev` nicht zuverlässig an → tote Spieler blieben ewig in der Arena (bei (0,0) in der Ecke geparkt bzw. ewig kreisend). Fix: **WebSocket-Hibernation-API** (`webSocketClose`/`webSocketError`) + Backstop bei `send`-Fehler + **Idle-Timeout-Sweep** (`LIMITS.idleTimeoutTicks`, 10 s — deckt halb-offene TCP-Verbindungen, die gar kein Event liefern).
2. **Fremde ruckeln/stehen:** Die Interpolations-Zeitachse hing an Snapshot-*Ankunftszeiten* → Netz-Jitter wurde 1:1 zu Zeitsprüngen. Fix: **Render-Uhr** = lokale Tick-Uhr + EMA-geglätteter Server-Offset − 3 Ticks Verzögerungspuffer.
3. **Eigene Doppelschritte:** Input-Batches (alle 3 Ticks) liefen der 1-Intent-pro-Tick-Queue phasenweise leer → Input-Zeitachse verschob sich um einen Tick → Reconciliation-Sprung. Fix: **Jitter-Puffer** (`LIMITS.inputBufferTicks`, 2 Ticks Vorhaltung).
4. **Teleports/Popps:** Jede Server-Korrektur sprang mitten im Tick um `(1−α)·Δ`. Fix: Reconciliation verschiebt das Interpolations-Segment mit (Kontinuität am Tauschzeitpunkt); Korrekturen fließen nur noch über den abklingenden Fehler-Offset ein. Diagnose-Endstand: Reconciliation-Fehler dauerhaft 0,000 bei stabiler pending-Queue.

Absicherung: neuer kuratierter **E2E-Smoothness-Test** (misst die tatsächlich gerenderte Geschwindigkeit beider Spieler über 3 s, schlägt bei Geistern/Doppelschritten/Stalls aus), Unit-Tests für Jitter-Puffer, Flood-Deckel und Idle-Sweep. Neue Begriffe in CONTEXT.md (Jitter-Puffer, Idle-Timeout, Render-Uhr).

**2026-07-19 (Agent, Nachbesserung 2 — Dreh-Umlenker):** User-Report: nach Drehungen wird die Richtung kurz „umgelenkt". Mit Stress-Sonde (künstlicher Main-Thread-Jank, 150–300 ms) reproduziert: Client-Bursts nach Browser-Stalls ließen die Input-Queue über das 8er-Limit laufen → **Dreh-Inputs wurden verworfen** → Server drehte nie → Korrektur bog den Pfad zurück (Fehler-Peak 1,8–2 WU). Fixes:

1. **Catch-up-Drain statt Verwerfen:** Queue-Cap 8→20 (~1 s); Backlog > 6 wird mit 2 Inputs/Tick abgearbeitet (spiegelt das Burst-Nachholen des Clients — Rekonstruktion bleibt exakt). Drain-Schwelle bewusst über der normalen Queue-Oszillation (Batch 3 + Puffer 2), sonst erzeugt der Drain selbst die Leerläufe (gemessen: Clean-Fehler 0,01→0,29 bei Schwelle 4, zurück auf 0,01 bei 6).
2. **Sofort-Flush bei Richtungswechsel:** Dreh-Onsets warten nicht mehr bis zu 150 ms auf den Batch (selten genug fürs 20:1-Budget) — spürbar direktere Lenkung, kleineres Übergangsfenster.

Endstand Sonden: Clean-Fehler-Peak **0,01 WU** (keine Umlenker), unter Kunst-Jank 1,8 WU *echte* Stall-Bewegung (Welt läuft während des eigenen Stalls weiter — Spielregel), die weich über den Fehler-Abbau gleitet; **kein Input geht mehr verloren**. Neue Unit-Tests: Burst-Drain ohne Drop, Catch-up-Doppelschritt, Flood-Cap nur noch als harte Grenze, Sofort-Flush.

**Architektur-Frage des Users** („Müssen wir Tools/Libraries umdecken?"): Nein — begründet in der Antwort; Kurzfassung: Das Gambetta-Modell ist der Industriestandard, die Nacharbeit ist der übliche Netcode-Feinschliff (den Engines sonst fertig mitbringen), Colyseus & Co. laufen nicht auf Workers (ADR-0001), und die Transport-Abstraktion hält den Umzugspfad offen. Messwerte sind jetzt auf Zielniveau.

**2026-07-19 (User-Feedback, offen für nächste Session):** Deutlich stabiler, aber zwei Restsymptome:
1. **Andere Spieler sichtbar rucklige** als der eigene.
2. **Gelegentliche harte Resets beim eigenen Spieler** — Neuausrichtung, plötzlich „ein paar cm daneben" oder anderer Blickwinkel.
3. **Wunsch:** die bisherigen Fixes durch Tests (ideal E2E) absichern, damit nichts zurückrutscht. (Teilweise da: E2E-Smoothness-Test wacht über Doppelschritte/Geister/Stalls.)

**Schnell-Repro-Befund (Sonde `repro.mjs`, Repo-Root, untracked):** Unter mildem Jank (80–200 ms Stalls) + Dreh-Taps: eigener Spieler sauber (Tempo-sd 0,44, **null** Reset-Events bei Schwelle >3× Frame-Budget). ⇒ Resets brauchen härtere Trigger.

**Arbeits-Hypothesen für morgen:**
- *Resets selbst:* Lange rAF-Freezes (Tab-Wechsel/Fenster-Drag, >500 ms) → Divergenz > `MAX_GLIDE_WU` (8) → harter Snap; **Heading hat keinerlei Fehler-Glättung** (nur Positions-Offset) → „Blickrichtung springt". Ansatz: Heading-Glide analog Position; Glide-Grenze/Stall-Sonderpfad (nach erkannt langem Freeze bewusst hart neu ankern, aber Kamera weich nachziehen).
- *Andere rucklige:* (a) Catch-up-Drain erzeugt echte 0,9-WU-Doppelschritte des Gegners in einem Server-Tick → Interpolation zeigt Tempo-Spikes; ggf. Drain sanfter (nur jeden 2. Tick doppelt). (b) Gegner-Turn-Onsets tragen Batch+Queue-Latenz. (c) Offset-EMA-Atmung prüfen.
- *Mess-Falle:* Für Fremd-Spieler-Sonden zwei getrennte Browser-**Kontexte** nutzen (zweite Seite im selben Kontext wird headless gethrottlet — deshalb war die Fremd-Messung im Schnell-Repro leer).
- *Test-Ausbau (User-Wunsch):* E2E-Reset-Detektor (max. Frame-zu-Frame-Sprung/-Drehung des Selbst), Fremd-vs-Selbst-Glätte-Verhältnis, optional Jank-injizierter E2E; Sonden-Logik aus `repro.mjs` wiederverwenden.

**2026-07-20 (Agent, Nachbesserung 3 — Resets & Gegner-Ruckeln, quantifiziert):** Beide User-Reports mit Stall-Matrix-Sonde (300/800/1500 ms Main-Thread-Freezes bei gehaltener Taste, getrennte Browser-Kontexte) hart reproduziert und behoben:

| Messung | vorher | nachher |
|---|---|---|
| Resume-Sprung nach Stall | 2,5–3,1 WU | **0–0,3 WU** |
| Blickrichtungs-Reset nach Stall | 100–155° | **0–11°** |
| Einzelframe-Drehung nach Resume | bis 163° | ≤ 20° |
| Gegner-Tempo-Spitzen | bis 231 WU/s (Teleports) | **≤ 19,8 WU/s** (2,2×-Limit) |

Fünf Ursachen/Fixes:
1. **Eigener Aufhol-Burst rendrte sofort** (10 Ticks + 160° in einem Frame): `Predictor.runGlided` faltet den ganzen Burst in die Gleit-Offsets (`session.advance(turn, ticks)`).
2. **Decay-Reihenfolge:** Fehler-Abbau lief im selben renderSample wie die frischen Folds (100-ms-Kappe = 58 % sofort sichtbar). Jetzt expliziter Frame-Start-Schritt `session.frame(dt)` VOR advance/receive.
3. **Heading hatte keine Glättung:** eigener `errorH`-Offset (shortest-arc-gewrappt ⇒ nie > 180° Glide, Kappe entfernt — sie brach am Winkel-Wrap).
4. **Snapshot-Puffer rutschte unter der Render-Uhr weg** (32 Einträge = 1,6 s): auf 128 erhöht; Render-Uhr snapt erst > 20 Ticks Rückstand (Hidden-Tab-Comeback), darunter 2×-Aufholen.
5. **Gegner-Anzeige-Limit:** `smoothEnemies` begrenzt gerenderte Gegner-Bewegung auf 2,2× Nominal (Drehung ebenso); > 8 WU (Respawn-Klasse) snapt. Deckt Drain-Doppelschritte des Gegners und alle Zeitachsen-Artefakte ab.

**Test-Absicherung (User-Wunsch):** Neuer E2E `recovers from a main-thread stall…` (injizierter 800-ms-Freeze bei gehaltener Taste; max. Einzelframe-Sprung < 1 WU, Drehung < 30°) + Gegner-max-Tempo-Assertion (< 25 WU/s) im Smoothness-E2E; Unit-Tests für Burst-Glide, Heading-Glide, Glide-Kappe (Sprung nur über 8 WU), frame-zeitbasierten Decay, Rate-Limit der Gegner-Uhr. Restnotiz: `mean` der Gegner sinkt in Stress-Läufen unter 9, weil Anzeige-Limit + Warp legitime Aufholphasen strecken — bewusster Trade-off (glatt > exakt-synchron), Kill-Fairness regelt später der Rewind (T07).

**2026-07-20 (Agent, Nachbesserung 4 — „Vorspulen" & konstantes Gegner-Laggen):** User-Report nach Test auf realer Maschine: (a) eigener Kopf „spult" gelegentlich nach vorn, (b) andere Spieler konstant leicht laggy. Beides erklärt & behoben:

- **(a) Vorspulen = der Gleit-Mechanismus selbst.** Exponentieller Fehler-Abbau startet bei großen Offsets mit ~30 WU/s — genau das Spul-Gefühl nach Mini-Hängern; zudem renderten 2-Tick-Frames (100-ms-Hänger) roh (+0,9 WU Sprung). Fix: Gleiten hart auf **+5 WU/s / +240°/s über Normaltempo** gedeckelt (linear statt exponentiell schnell); jeder Multi-Tick-Burst gleitet (`advance`-Schwelle 2→1). Unit-Test pinnt das Tempolimit pro Frame fest.
- **(b) Konstantes Gegner-Laggen = Zustell-Jitter, den Headless-Messungen nie sahen.** Auf realen Links (v. a. WSL2-Port-Forwarding) kommen Snapshots stoßweise; die Render-Uhr lief mit fixen 3 Ticks Puffer regelmäßig gegen den neuesten Snapshot → Frame einfrieren, aufholen, einfrieren = Dauer-Mikroruckeln. Fix: **adaptiver Interpolations-Puffer** (+1 Tick je Unterdeckung bis +6, −1 nach 30 s ohne; Basis 3). Verifiziert mit **Jitter-Proxy** (TCP-Proxy mit 0–120-ms-Burst-Zustellung vor dem Server): Gegner-Tempo 9,08/8,90 WU/s bei sd 0,31–0,35 und **0 eingefrorenen Frames** — selbst kalt.
- **Beifang:** Join-Race auf langsamen Verbindungen — Klick vor Modul-Ladeende feuerte ein natives Form-Submit (Seiten-Reload). Play-Button startet jetzt `disabled` und wird vom Modul aktiviert.

Trade-off dokumentiert: adaptiver Puffer erhöht die Gegner-Anzeige-Latenz auf realen Links um bis zu 300 ms zusätzlich (Genre-Toleranz ~500 ms, Spec §6.3); Kill-Fairness rechnet der Rewind (T07) ohnehin aus Sicht des Handelnden.

**2026-07-20 (Agent, Nachbesserung 5 — Soak-Test findet die Teleport-Wurzel):** User forderte zu Recht ein realistisches Testsetup, das die Probleme selbst findet. Neuer **60-s-Soak-Test** (`pnpm soak [url]`, tests/soak/): kombinierte Widrigkeit (Jank auf dem Beobachter, Gegner-Fenster mit komplett eingefrorenem rAF, Tap-Lenken), harte Schwellen (0 Resets, <3 % eingefrorene Gegner-Frames, Tempo-Limits). Er **fand den Teleport sofort** (18-WU-Sprung in einem Frame) und die Instrumentierung zeigte die Wurzel: **57 Snapshots in einem Burst** — `wrangler dev`/workerd (WSL2) stallt sekundenweise, und der DO-Ticker holte danach alle verpassten Ticks im Schnellfeuer nach = „Welt spult vor". Fixes dieser Runde:

1. **Sim vom Render-Takt entkoppelt** (main.ts): Fixed-Timestep + Input-Fluss laufen auf Timer, rAF rendert nur noch. Behebt strukturell: Vorspulen/Teleports bei GPU-Drosselung (zwei Fenster!), Rauswurf nach 10 s (verstecktes/verdecktes Fenster sendet weiter ~1/s). Verifiziert: Client mit 15 s komplett eingefrorenem rAF bleibt verbunden, lenkbar, divergenzfrei.
2. **Server-Ticker re-ankert nach Runtime-Stalls** statt Tick-Schulden nachzuholen (> 2 Ticks Rückstand = Fahrplan neu) — kein Snapshot-Schnellfeuer mehr; die Welt pausiert für alle gleich.
3. **Startblock-Optik**: Der „riesige blaue Fleck" war das 6×6-Spawn-Territorium — rendert jetzt als flache, entsättigte Bodenplatte.
4. **Deployed**: https://paintclash.secure-data.workers.dev (Free-Plan, DO + Assets; wrangler-Login des Users). Soak gegen Produktion: **PASS** (0 Resets, 0 Frozen-Frames, Tempi gedeckelt) — Referenzumgebung ohne WSL2-Artefakte.

Soak-Endstand lokal & Produktion: selfResets 0, otherFrozen 0 %, max-Tempi ≤ 17,8 WU/s (Limit 25).
