# CONTEXT — draw-race

Ubiquitäre Sprache des Spiels. Begriffe hier sind verbindlich — in Spec, Tickets, ADRs und Code denselben Term verwenden, keine Synonyme. Sprache der Effort-Dokumente: Deutsch (Code-Bezeichner dürfen englisch sein, dann pro Term unten notiert).

Diese Datei entsteht lazy. Erstbefüllung aus [Ticket 02 — Spielregeln](.scratch/draw-race/issues/02-spielregeln-im-detail.md); Architektur-/Netcode-Begriffe seit Ticket 08 ergänzt (Details in den ADRs unter [docs/adr/](docs/adr/)).

## Glossar — Spielregeln

- **Arena** — der Spielraum. In der Grundversion **endlos** (dauerhaft laufend, jederzeit joinen, kein Siegmoment) und **quadratisch mit festen Wänden**. Code: `arena`.
- **Gebiet** (engl. *territory*) — die einem Spieler gehörende gefärbte Fläche. Safespace gegen Trail-Angriffe. Verliert ein Spieler sein *gesamtes* Gebiet, stirbt er (**Totalverlust-Tod**).
- **Welteinheit** (engl. *world unit*, Abk. und Code-Bezeichner **WU**) — Basis-Längeneinheit der kontinuierlichen Welt (Positionen, Distanzen, Grössen). Ersetzt das grid-behaftete „Zelle"; der Render-Zoom (px pro WU) ist davon unabhängig. Konkrete Balance-Startwerte in WU: [Ticket 11](.scratch/draw-race/issues/11-balance-parameter.md).
- **Trail** — der Weg eines Spielers **ausserhalb** seines eigenen Gebiets (seit dem Verlassen). Wird der Trail geschnitten, stirbt der Spieler. Beim Schliessen der Schleife zurückgesetzt. Kein Balance-Parameter der Länge — er endet mit dem Loop.
- **Loop schliessen** — mit dem Trail ins eigene Gebiet zurückkehren; löst das **Fill** aus.
- **Fill** (Flächeneroberung) — Färben der vom Loop **eingeschlossenen Fläche**. **Polygonbasiert** (kontinuierliche Bewegung), nicht der zellbasierte Flood-Fill aus splix. Eingeschlossenes **fremdes Gebiet wird überfärbt/gestohlen**; eingeschlossene Gegner**köpfe überleben**.
- **Kopf** (engl. *head*) — die aktuelle Position/Spitze eines Spielers. Kopf-an-Kopf: wer draussen ist, stirbt.
- **Tod** — ausgelöst durch (1) Trail-Schnitt (fremd oder selbst), (2) Kopf-an-Kopf während man draussen ist, (3) Totalverlust des Gebiets. Folge: gesamtes Gebiet wird neutral.
- **Startblock** — kleines Anfangs-Gebiet bei Spawn/Respawn.
- **Spawn-Mindestabstand** — garantierter Abstand zu Gegnern/Gebiet beim Einsetzen (Schutz vor Spawn-Kill). Es gibt **keinen** Unverwundbarkeits-Timer.
- **Sanfte Barriere** — Randverhalten: der Kopf gleitet an der Wand entlang / dreht ab, kein Rand-Tod (Paper.io-Stil).
- **Leaderboard** — globale, für alle sichtbare Rangliste. Metrik ausschliesslich **% der Karte**; Top 5 + eigener Rang; Farb-Swatch pro Zeile.
- **Score** — persönliche Leistungszahl, beim **Tod** berechnet und **live** auf dem eigenen HUD geschätzt. Faktoren: Peak-Fläche × Überlebenszeit × **Konkurrenz-Multiplikator** (Ø **menschliche** Mitspieler; Bots zählen nicht). Nicht Teil des globalen Leaderboards. Konkrete Formel ([Ticket 11](.scratch/draw-race/issues/11-balance-parameter.md)): `round(peakPct × √überlebenSek × (1 + 0,25 × ØandereMenschen) × 10)`.
- **Rekord** — lokal gespeichert (ohne Account): Max-%, längste Überlebenszeit, Highscore.
- **Bot** — heuristik­gesteuerter Nicht-Menschen-Spieler; füllt die öffentliche Arena, in privaten Räumen per Lobby-Toggle. Zählt **nicht** für den Konkurrenz-Multiplikator.
- **Privater Raum** — nur per **Code/Link** zugänglich, nicht öffentlich gelistet. Mit **Lobby** (Host-Start); Host stellt Kartengrösse, Bots, Spielerlimit (2–16) und Nachjoin ein.
- **Lobby** — Warteraum eines privaten Raums vor dem Host-Start.
- **Nickname** — Gast-Anzeigename (1–16 Zeichen, Unicode gefiltert, Blockliste client+server). **Nicht eindeutig** — Unterscheidung über Farbe/Spieler-ID.
- **Spieler-ID** — stabile ID pro Gerät (localStorage), trägt lokale Rekorde; Platzhalter für spätere Accounts.

## Glossar — Architektur & Netcode

Ergänzt seit [Ticket 08](.scratch/draw-race/issues/08-architektur-erweiterbarkeit.md); Details in den ADRs unter [docs/adr/](docs/adr/).

- **Sim-Core** — reiner, deterministischer Spiel-Kern (Bewegung, Trail, Fill, Kollision, Regeln), geteilt zwischen Server und Client. Kein Netz, kein Rendering, keine Uhr/Zufall von aussen. Code: `sim-core`.
- **Autoritativer Server** — der Server hält die verbindliche Wahrheit; Client-Eingaben werden validiert, Fill und Tode server-seitig entschieden.
- **Prediction** (Vorhersage) — der Client rechnet die *eigene* Bewegung sofort voraus, damit sie sich flüssig anfühlt.
- **Reconciliation** (Abgleich) — der Server korrigiert; der Client spielt seine Eingaben ab der Korrektur neu ab und zieht die Differenz weich.
- **Interpolation** — Gegner werden zwischen Server-Snapshots geglättet dargestellt (kleiner Verzögerungspuffer).
- **Rewind** (Rückspulen) — der Server beurteilt Tode/Schnitte aus der Sicht des handelnden Spielers anhand einer Positions-Historie (Kill-Fairness).
- **Tick** — fester Simulationsschritt; Grundversion **20 Hz** (einstellbar, liegt in `shared`).
- **Arena-DO** — ein Durable Object = eine Arena.
- **Router-Worker** — zustandsloser Einstieg; liefert den Client aus und leitet WebSocket-Verbindungen an das richtige Arena-DO (öffentlich/privat).
- **Raum-Registry** — SQLite-Ablage im DO für Code → Konfiguration privater Räume (fast die einzige server-seitige Persistenz).
- **Input-Batching** — mehrere Eingaben pro WebSocket-Nachricht bündeln (erzwungen durch das Free-Request-Budget).
- **Welcome** — erste Server-Antwort auf den Join-Wunsch: eigene `playerId` + Arena-Grösse. Erst danach ist der Client der Arena zugeordnet. Code: `welcome`-Opcode in `protocol`.
- **Ack** (engl. *acknowledged sequence*, Code `ackSeq`) — die Input-Sequenznummer des zuletzt **angewendeten** Steuer-Intents, vom Server in jedem Snapshot pro Empfänger zurückgemeldet; Anker der Reconciliation (der Client spielt nur Inputs > Ack neu ab). Sequenznummern starten bei 1; Ack 0 = „noch nichts verarbeitet".
- **Input-Queue** — server-seitige Warteschlange frischer Steuer-Intents pro Spieler; pro Tick wird **genau einer** angewendet (rekonstruiert die Client-Zeitachse eines Input-Batches). Backlog über `LIMITS.maxPendingInputs` = Flood, älteste Einträge fallen weg.
- **Garbage-Toleranzfenster** — Zahl aufeinanderfolgender malformer Frames, die ein Socket überlebt, bevor er getrennt wird (`LIMITS.garbageKillThreshold`); ein gültiger Frame setzt den Zähler zurück.
- **`LIMITS`** — eingefrorene Schutz-/Budget-Schwellen neben `BALANCE` in `shared` (Garbage-Kill, Input-Flush-Kadenz, Input-Queue-Deckel).
- **Effekt** — modifizierender Zustand auf einer Entity (Tempo, Schild …); Naht für Items/Upgrades, Grundversion leer.
- **Regelwerk** (Strategie) — austauschbare Spielregeln; Grundversion = Strategie „endlose Arena". Naht für weitere Spielmodi.
- **appearance** (Erscheinungsbild) — sim-neutraler Kosmetik-Deskriptor (heute Farbindex, später Skin-ID); nur der Client rendert ihn.

## Glossar — Test & Qualität

Ergänzt seit [Ticket 09](.scratch/draw-race/issues/09-teststrategie-qualitaet.md).

- **Sim-Client** — ein **headless** Client, der `sim-core` fährt und das echte Binär-Protokoll spricht, aber **nicht** rendert. Testwerkzeug: mehrere Sim-Clients treiben in einem Szenario-Test einen echten Server über die Leitung. Code: `sim-client`.
- **Szenario-Test** — stack-durchgreifender Integrationstest: echter Server (via `@cloudflare/vitest-pool-workers`) + zwei/mehr **Sim-Clients** über das echte Protokoll, **ohne Browser/Rendering**. Arbeitsgaul der Kern-Mechanik-Regression („Änderungen zerstören keine Core-Konzepte"). Abgegrenzt gegen **Unit-Test** (`sim-core` allein) und **E2E** (echter Browser via Playwright).
- **Replay-Determinismus** — die getestete Eigenschaft, dass *dieselbe* Input-Sequenz + *derselbe* RNG-Seed nach N Ticks einen **bit-identischen Zustands-Hash** ergibt (fixes `dt`, keine Uhr — ADR-0003). Eigene Test-Gattung; Grundlage, auf der Prediction/Reconciliation überhaupt funktioniert.
- **Golden-Fixture** — eingecheckter Regressions-Anker: für `sim-core` ein aufgezeichnetes **Input-Log + erwarteter End-Hash** (Replay), für `protocol` erwartete **Bytes** (Wire-Format festnageln).

## Glossar — Sound

Ergänzt seit [Ticket 12](.scratch/draw-race/issues/12-sound-design.md). Grundversion = **minimaler SFX-Kern**; die volle Palette (Musik, UI-Sounds, räumlicher Umgebungston) ist Ausbaustufe.

- **SFX-Kern** — der Sound-Umfang der Grundversion: sechs kurze Effekt-Sounds, **keine Musik, keine UI-Sounds**. Events: Fill, Kill, eigener Tod, Respawn/Join, Rang-Aufstieg (One-Shots) und „Fressen" (Loop).
- **„Fress"-Sound** — kontinuierlicher, leiser Loop, der spielt, *solange sich der Trail durch **fremdes** Gebiet frisst* (nicht über neutralem Boden oder eigenem Gebiet); sanft ein-/ausgeblendet.
- **Egozentrischer Ton** — es klingen **ausschliesslich die eigenen** Aktionen des lokalen Spielers, nie fremde Events. Räumlicher Umgebungston fremder Spieler ist Ausbaustufe.

## Glossar — Abuse & Betrieb

Ergänzt seit [Ticket 15](.scratch/draw-race/issues/15-abuse-cheat-schutz.md). Leitprinzip **Verfügbarkeit zuerst**: die Server-Autorität erledigt Integritäts-Cheating strukturell, geschützt wird v. a. die *eine Gratis-Arena*.

- **Steuer-Intent** — der **einzige** Inhalt, den ein Client senden darf: sein Bewegungs-*Wunsch* (Ziel-Heading / Turn-Signal, plus Join-/Respawn-Wunsch), nie Position/Tempo/Fill/Kill/fremde `playerId`. Der Server re-derived daraus die Position (festes Tempo, auf die legale Drehrate geklemmt); alles andere wird verworfen. Trust-Boundary der Grundversion. Code-Bezeichner darf englisch sein (`intent`).
- **Arena-Populationsgrenze** — harte Obergrenze gleichzeitiger Spieler in einer Arena; zugleich CPU-Schutz des single-threaded DO und Anti-Dominanz-Backstop. *Dass* es sie gibt, ist gesetzt; der Wert kommt aus [Ticket 14](.scratch/draw-race/issues/14-do-cpu-benchmark.md). Bei Erreichen: „Arena voll"-Abweisung, keine Queue/kein Sharding (Skalierung = out of scope).
- **best-effort-Verfügbarkeit** — die bewusste Betriebshaltung: keine Uptime-Garantie. Der harte Free-Tages-Stopp (ADR-0001/0013) ist die *gewollte* Abbuchungssicherheit; Worst Case eines DoS = Arena parkt bis zum Reset, **ohne Kosten**.

## Verworfen / Erweiterungspunkte

- **Wrap-around / Torus-Arena** — für die Grundversion verworfen (mehrdeutige „innen/aussen"-Fill-Definition); vorgemerkt als künftiger Spielmodus.
