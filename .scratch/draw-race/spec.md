# Spec — paintclash (Grundversion / Phase 1)

Status: **Abgenommen / gelockt (2026-07-19)** — konsolidiert aus der Wayfinder-Map
Projektname: **`paintclash`** (ein Name für Code + Repo + Marke; `paintclash.io` frei & register-sauber — siehe Kap. 1.3)
Sprache: Deutsch (Code-Bezeichner englisch, je Term im Glossar notiert)

Diese Spec ist die **implementierungsreife** Zusammenführung aller Entscheidungen der
Wayfinder-Map [`map.md`](map.md). Sie ist die maßgebliche Referenz für den
Implementierungs-Start; Detailbegründungen liegen in den verlinkten Tickets und ADRs.

- Domänen-Vokabular (verbindlich): [`CONTEXT.md`](../../CONTEXT.md)
- Architektur-Entscheidungen: [`docs/adr/`](../../docs/adr/) (ADR-0001 … 0006)
- Entscheidungs-Tickets: [`issues/`](issues/) (01 … 15)

> **Alle Balance-Zahlen sind begründete _Startwerte_**, ausdrücklich gegen einen
> spielbaren Build nachzujustieren (Kapitel 10) — nicht final austariertes Balancing.

---

## Inhalt

1. [Vision & Abgrenzung](#1-vision--abgrenzung)
2. [Spielregeln](#2-spielregeln)
3. [Steuerung & Bewegungsmodell](#3-steuerung--bewegungsmodell)
4. [Look, Animationen & Sound](#4-look-animationen--sound)
5. [Architektur & Modulschnitt](#5-architektur--modulschnitt)
6. [Netcode & Protokoll](#6-netcode--protokoll)
7. [Hosting & Betrieb Phase 1](#7-hosting--betrieb-phase-1)
8. [Sicherheit & Abuse-Schutz](#8-sicherheit--abuse-schutz)
9. [Teststrategie & Qualitätsstandards](#9-teststrategie--qualitätsstandards)
10. [Balance-Parameter & Startwerte](#10-balance-parameter--startwerte)
11. [Offene Punkte für den Implementierungs-Start](#11-offene-punkte-für-den-implementierungs-start)

---

## 1. Vision & Abgrenzung

### 1.1 Was es ist

Ein **Browser-Multiplayer-Flächenfärbe-Spiel** (Genre: Trail-/Territory, splix.io /
Paper.io 2 verwandt) als kostenlos gehostete Grundversion. Kern-Loop: mit dem **Trail**
aus dem eigenen **Gebiet** herausfahren, eine Schleife ziehen, **Loop schließen** → die
eingeschlossene Fläche **färben** (Fill); fremdes Gebiet wird dabei überfärbt/gestohlen.
Wer den Trail eines anderen (oder seinen eigenen) schneidet, stirbt.

- **Spielmodell:** **endlose Arena** — dauerhaft laufend, jederzeit joinen, kein
  Matchmaking, kein definierter Siegmoment; Tod = eigenes Gebiet weg; Live-Leaderboard
  nach aktuellem Flächenanteil.
- **Plattform:** **Browser-only** — ein responsiver Web-Client für Desktop (Maus /
  Tastatur) und Mobile-Browser (Touch). PWA optional, native Apps out of scope.
- **Identität:** **Gast + Nickname**, kein Login. Stabile **Spieler-ID** (localStorage)
  als Platzhalter für spätere Accounts/Skins; trägt lokale Rekorde.
- **Zielgröße Phase 1:** öffentlich, klein — ausgelegt auf **~10–100 gleichzeitige
  Spieler in einer Arena**, kostenloses Hosting; Skalierungspfad (mehrere Arenen) bleibt
  offen, wird nicht gebaut.

### 1.2 Ausbaustufen-Ausblick (Nähte vorhanden, nicht gebaut)

ADR-0006 hält fünf Erweiterungs-Nähte offen (Quasi-Null-Kosten heute): Items/Upgrades
(Effekt-Feld), weitere Spielmodi (Regelwerk-Strategie), Skins (`appearance`-Deskriptor),
Accounts/Progression (`playerId`-Indirektion), persistenter Canvas (DO-Snapshot-Naht).
**1–4 gelten als geplante Evolution, 5 bleibt spekulativ.**

### 1.3 Out of scope (bewusst ausgeschlossen für Phase 1)

- **Monetarisierung** (Skins, Ads, Portal-Deals) — Ausbaustufe (Naht via ADR-0006).
- **Items/Upgrades/Schießen** (defly.io-Konzepte) — Ausbaustufe (Effekt-Naht).
- **Weitere Spielmodi** (zeitbasierte Runden, Teams, No-Kills) — Ausbaustufe
  (Regelwerk-Naht).
- **Wrap-around-Arena (Torus)** — für die Grundversion verworfen (mehrdeutige
  „innen/außen"-Fill-Definition ohne Rand); vorgemerkt als künftiger Spielmodus (Ticket 02).
- **Persistenter Canvas** (Gebiet bleibt offline bestehen) — eigenes späteres Vorhaben.
- **Native Apps** (App Stores, Capacitor) — widerspricht dem Kostenlos-Ziel.
- **Accounts/Progression** (Login, geräteübergreifende Rekorde) — Gast-only.
- **Name (gewählt): `paintclash`** — ersetzt den ursprünglichen Arbeitstitel „draw race"
  (Kollision mit Ubisofts *DrawRace*). **Ein Name für Code + Repo + Marke** (User-Wunsch:
  gleicher Name im Code). `paintclash.io` frei (Standard-.io ~$28 im 1. Jahr / ~$52/Jahr
  Verlängerung). **Registerprüfung (2026-07-19, TMview): null Treffer weltweit** in allen
  Klassen → sauberste Ausgangslage für eine eigene Marke; „paint" + „clash" je ein
  Grundschulwort (keine Schreibfalle), sofort als kompetitives Multiplayer lesbar.
  **Verworfen:** `sprawlr` (identische EU-Wortmarke Klasse 9, 4CF sp. z o.o.), `inkzone`
  (Klasse-9-Marke registriert). **Vor Launch verbleibend (kein Repo-Gate):** Social-Handles
  sichern (Konvention `@paintclashgame` / `@playpaintclash`, falls `@paintclash` belegt),
  Domain-Kauf, finale anwaltliche Marken-Clearance.
- **Volle Sound-Palette** (Musik, UI-Sounds, räumlicher Umgebungston, Slider) —
  Ausbaustufe über den minimalen SFX-Kern hinaus (Ticket 12).
- **Erweiterter Abuse-Schutz** (Turnstile/PoW vor Join, Melde-/Mute-Funktion,
  Homoglyph-Filter, verteilte-Schwarm-Abwehr) — Ausbaustufe mit benannten Auslösern
  (Kapitel 8.4, Ticket 15).

---

## 2. Spielregeln

Grundlage: [Ticket 02](issues/02-spielregeln-im-detail.md); Vokabular in
[`CONTEXT.md`](../../CONTEXT.md). Basis: kontinuierliche Bewegung, polygonbasierter Fill,
endlose quadratische Arena mit festen Wänden.

### 2.1 Trail & Tod

- **Trail** = der Weg eines Spielers **außerhalb** seines eigenen Gebiets (seit dem
  Verlassen). Im eigenen Gebiet gibt es keinen Trail — es ist **Safespace**.
- **Trail-Schnitt** durch einen Gegner **oder** durch einen selbst → **sofortiger Tod**.
- **Kopf-an-Kopf:** Wer sich in fremdem/neutralem Gebiet befindet, stirbt; wer im eigenen
  Gebiet steht, ist sicher (der andere stirbt). Beide exakt draußen im selben Tick →
  **beide sterben**.
- **Totalverlust-Tod:** Wird das *gesamte* Gebiet eines Spielers weggefärbt (auf null),
  stirbt er — auch wenn sein Kopf gerade „im eigenen Gebiet" war. Territorium ist die
  Lebensgrundlage.
- **Folge jedes Todes:** das gesamte Gebiet des Spielers wird wieder **neutral**.

### 2.2 Färben (Fill)

- **Loop schließen** (mit dem Trail ins eigene Gebiet zurückkehren) → die **komplette
  eingeschlossene Fläche** wird erobert. **Polygonbasiert** (kontinuierliche Bewegung),
  nicht der zellbasierte Flood-Fill aus splix.
- **Fremdes** eingeschlossenes Gebiet wird **überfärbt/gestohlen** — das macht den
  Totalverlust-Tod überhaupt möglich.
- Eingeschlossene **Gegnerköpfe überleben** — kein Tod durchs Einschließen; der
  Totalverlust-Tod greift erst, wenn die Fläche real auf null fällt.
- Minimale Fill-Fläche = **1 WU²** (nur zum Verwerfen numerischer Splitter; jeder bewusste
  Loop färbt).

### 2.3 Spawn

- Kleiner eigener **Startblock** (kein Start bei null), **6 × 6 WU**.
- Spawn an zufälliger freier Stelle mit **Mindestabstand 25 WU** zu Gegnerkopf/-gebiet;
  bei Gedränge die bestmögliche freie Stelle statt harter Garantie.
- **Kein** Unverwundbarkeits-Timer — der sichere Startblock *ist* der Schutz; verwundbar
  erst beim Rausfahren.

### 2.4 Karte & Barriere

- **Quadratisch, feste Grenzen** mit **sanfter Barriere** (Paper.io-Stil): am Rand
  entlanggleiten/abdrehen, **kein** Rand-Tod. (splix' Rand-Tod verworfen.)
- Öffentliche Arena: **200 × 200 WU** (Startwert, Kapitel 10). Ecken sind dadurch
  taktisch wertvolle Basen — vom Mindestabstand-Spawn abgefedert.
- **Wrap-around (Torus) verworfen** für die Grundversion (out of scope, s. 1.3).

### 2.5 Leaderboard, Score & Rekorde

- **Globales Live-Leaderboard** (für alle sichtbar): **ausschließlich % der Karte**,
  **Top 5 + eigener Rang**. Neben jedem Namen ein **Farb-Swatch** (Gebietsfarbe), eigene
  Zeile hervorgehoben; optional Discriminator (z. B. „Max ‹2›") bei gleicher Farbe.
- **Score** (persönlich, nicht Teil des Leaderboards): beim **Tod** berechnet, **live**
  aufs eigene HUD geschätzt. Formel und Faktoren in Kapitel 10.5.
- **Eigenes HUD:** aktueller eigener Score live neben dem persönlichen Rekord (man merkt,
  ob man den Highscore knackt).
- **Lokale Rekorde** (ohne Account, an der Spieler-ID/localStorage): **Max-%**, **längste
  Überlebenszeit**, **Highscore**.

### 2.6 Private Räume

- Zugang per **Code + teilbarem Link**, **nicht** öffentlich gelistet.
- **Lobby mit Host-Start.** Host-Einstellungen: **Kartengröße** (Default je Spielerzahl,
  frei wählbar), **Bots** (an/aus + Anzahl, Default aus), **Spielerlimit** (Bereich
  **2–16**, Default 8), **Nachträglicher Beitritt** (Toggle, Default **an** — Drop-in
  per Link).
- **Lebensdauer:** leerer Raum schließt nach **90 s** Gnadenfrist (deckt kurze
  Disconnects); Code danach frei. Leere/Lobby-Räume hibernieren (≈ 0 Kosten).

### 2.7 Bots

- **Heuristik-Bots** beleben die öffentliche Arena; server-interne Entities über dieselbe
  Eingabe-Schnittstelle wie Netz-Spieler (ADR-0005), mit **begrenzter Wahrnehmung**
  („kompetent aber schlagbar").
- Öffentliche Arena: Ziel-Mindestbelebung **8** Entities, solange ≥ 1 Mensch anwesend;
  `bots = clamp(ziel − menschen, 0, 8)`. 0 Menschen → 0 Bots (Arena hibernert).
- Bots zählen **nicht** für den Konkurrenz-Multiplikator des Scores (kein Farmen leerer
  Arenen).
- ⚠ Die Zielzahl 8 ist CPU-abhängig und gegen [Ticket 14](issues/14-do-cpu-benchmark.md)
  (DO-CPU-Benchmark) zu bestätigen.

### 2.8 Nicknames

- **1–16 Zeichen**, Unicode erlaubt aber **gefiltert** (keine Steuer-/Zero-Width-Zeichen;
  Länge nach sichtbaren Zeichen). Leerer Name → Auto-Gastname („Gast-####").
- **Statische Blockliste** gegen anstößige Namen, **client- und serverseitig** geprüft
  (Server erzwingt; Client-Vorprüfung nur UX).
- Namen sind **nicht eindeutig** und **rein kosmetisch** — Unterscheidung über
  Farbe/Spieler-ID; nie ein Autorisierungs-Schlüssel (Autorität hängt an der `playerId`).

---

## 3. Steuerung & Bewegungsmodell

Grundlage: [Ticket 01](issues/01-bewegungsmodell-prototyp.md) (Prototyp:
[`prototype/movement.html`](prototype/movement.html)).

- **Bewegungsmodell: kontinuierlich** — freie Winkel, weiche Kurven (Paper.io-2-Klasse).
  Grid (hart wie weich) verworfen. Konstantes Tempo (**keine** Skalierung mit
  Gebietsgröße, Kapitel 10).
- **Steuerung Desktop:** Default **Tastatur** (links/rechts lenken via A/D bzw.
  Pfeiltasten), umschaltbar auf **Maus-folgen** (Kopf steuert zur Mausposition). Beide
  Optionen in der Grundversion.
- **Steuerung Mobile:** Default **„Finger folgen"** (Kopf läuft zur Fingerposition);
  zusätzlich als Einstellung wählbar **„Lenken L/R"** und **„Joystick"**. Alle drei in
  der Grundversion.
- Startwerte: Tempo **9 WU/s**, Drehrate **320°/s** (Kapitel 10).

> Prototyp-Artefakte, die **nicht** in die Spec gehören: Render-Glättungs-Slider (betraf
> nur die verworfenen Grid-Modelle) und das Trail-Längen-Pufferlimit (Trail endet ohnehin
> mit dem Loop, kein Balance-Parameter).

---

## 4. Look, Animationen & Sound

### 4.1 Visuelle Richtung — „Paper.io Modern"

Grundlage: [Ticket 07](issues/07-look-and-feel-prototyp.md) (Prototyp:
[`prototype/look-and-feel.html`](prototype/look-and-feel.html), Variante D bestätigt).

- **Kamera:** perspektivischer Tilt (~52° Elevation), dezente 2.5D-Tiefe. Kein Top-down,
  kein steiler Iso-Winkel. Für die Spec: **etwas mehr 3D-Tiefe** als der Prototyp (mehr
  Tilt und/oder höheres, glattes Plateau).
- **Gebiet (Territory):** flache, **zusammenhängende Farbfläche** mit leichter Höhe/Kante
  — **keine hohen Blöcke, kein Würfel-Raster**, keine Fugen zwischen Zellen. Für die Spec:
  **polygonbasiert** rendern (glatte, fließende Kanten); der Prototyp nutzt eckigen
  Zell-Flood-Fill nur als Shortcut.
- **Trail:** durchgezogene, glatte **2D-Linie** auf Bodenhöhe, nicht zellig. **„Frisst"
  sich durch fremdes 3D-Gebiet** (Paper.io-Stil): überfahrene Fläche sinkt auf Bodenhöhe,
  die Linie läuft in der Rinne durch (Carve-through).
- **Farbe/Licht:** moderne, leicht entsättigte Palette; weiche Beleuchtung + dezenter Fog.
  Tiefe über Tilt + Kantenschattierung, nicht über Klötzchen.

### 4.2 Animationen der Grundversion

- **Fill** (Loop-Schluss): eingeschlossene Fläche „wächst" als zusammenhängendes Plateau
  (Höhen-/Farb-Welle).
- **Überfärben:** eingeschlossenes fremdes Gebiet wird sichtbar übernommen.
- **Trail-Carve:** 2D-Trail schneidet sichtbar durch erhöhtes fremdes Gebiet.
- **Tod:** bewusst **schlicht** (Gebiet wird neutral). Visuelle Aufwertung = spätere
  Ausbaustufe.
- **Sanfte Barriere:** Kopf **gleitet** am Rand entlang, **kein** Rand-Tod.

### 4.3 Rendering-Engine

Grundlage: [Ticket 06](issues/06-rendering-engine.md).

- **1. Wahl: three.js** (MIT). 2.5D-Look nativ 3D (Blockhöhe/Plateau, Kamera-Tilt,
  Schatten, Färbe-Welle als Vertex-Shader-Animation). Große Fläche als gechunktes
  **`InstancedMesh`** (1 Draw Call pro 64×64-Chunk; Fill-Delta = kleines Buffer-Update).
- **Mobile-60fps bestätigt** (Ticket 07): chunked `InstancedMesh` läuft auf dem
  User-Handy flüssig bei 192² und 256² (65 536 Instanzen).
- **Fallback: PixiJS v8** (falls der Look flacher wird / 3D-Probleme) — **ohne**
  pixi-projection (verifiziert tot). Phaser 4 und Roh-WebGL scheiden aus.
- Architektur-Muster: **Renderer als Data-Sink-Fassade** (Sim strikt vom Rendering
  getrennt); **Render-Interpolation** zwischen Sim-Ticks im Client ist Pflicht (sonst
  ruckelt die kontinuierliche Bewegung).

### 4.4 Sound — minimaler SFX-Kern

Grundlage: [Ticket 12](issues/12-sound-design.md). **Ja zu Sound, aber bewusst minimal:**
keine Musik, keine UI-/Menü-Sounds (volle Palette = Ausbaustufe).

**Sechs Events, strikt egozentrisch** (Ton löst *ausschließlich* bei eigenen Aktionen des
lokalen Spielers aus, nie bei fremden Spielern):

| # | Event | Typ | Notiz |
|---|---|---|---|
| 1 | **Fill** (Loop geschlossen) | One-Shot | die Belohnung, das Herz |
| 2 | **Kill** (Gegner-Trail geschnitten / Kopf-an-Kopf gewonnen) | One-Shot | |
| 3 | **Eigener Tod** (geschnitten / Totalverlust) | One-Shot | |
| 4 | **Respawn / Join** | One-Shot | |
| 5 | **Rang-Aufstieg** (Leaderboard-Überholen) | One-Shot | |
| 6 | **„Fressen"** — Trail frisst durch *fremdes* Gebiet | **Loop** | nur über fremdem Gebiet, leise, sanft ein-/ausgeblendet |

Bewusst **nicht** im Kern: Trail-Start, Near-Miss-Warnung, UI-Sounds, Musik, Umgebungston.

- **Asset-Quelle:** **prozedural-first (Web Audio API)** — One-Shots als
  Oszillator + Gain-Hüllkurve, rausch-basierte Events als gefiltertes Rauschen (0
  Asset-Bytes, keine Lizenz, im TS-Code versioniert). **Fallback: CC0/free-Sample**, wo
  prozedural nicht reicht (voraussichtlich der „Fress"-Loop). Alles **frei, CC0 bevorzugt**;
  nur-CC-BY → Credits-Liste im Repo; kein kostenpflichtiges Material. Wechsel A↔B
  unsichtbar hinter `play('fill')`-Schnittstelle.
- **Default & Steuerung:** **Ton AN.** `AudioContext` wird **implizit beim Play/Join-Klick**
  entsperrt (deckt die Autoplay-Policy, **kein** separater Aktivieren-Prompt).
  **HUD-Mute-Toggle** binär (an/aus), in **localStorage** persistiert.
- **Budget/Laufzeit:** prozedural = 0 Bytes; Sample-Rückfälle ≤ **50 KB** gesamt, lazy
  nach dem Join (blockieren nie First-Paint/WS-Connect). **Ein** geteilter `AudioContext`
  + Master-Gain (Mute); der „Fress"-Loop = **eine** persistente Loop-Quelle per
  Gain-Hüllkurve; One-Shots = kurze Wegwerf-Nodes. **Keine Allokation pro Tick.**
- **Entkopplung:** Sound hängt rein am Client-Feedback, **entkoppelt vom `sim-core`**
  (ADR-0002/0003) — nie Determinismus-/Replay-Einfluss. Rein additiv zum visuellen
  Feedback (kein alleiniger A11y-Kanal).

---

## 5. Architektur & Modulschnitt

Grundlage: [Ticket 08](issues/08-architektur-erweiterbarkeit.md); Detail in
[ADR-0001 … 0006](../../docs/adr/). Dieses Kapitel fasst zusammen — die ADRs sind die
begründende Referenz.

### 5.1 Monorepo & Pakete (ADR-0002)

Ein Repo, mehrere Pakete; dieselbe Spiellogik läuft autoritativ auf dem Server **und** als
Vorhersage im Client — geteilter Code kann nicht driften.

| Paket | Inhalt |
|---|---|
| **`sim-core`** | reine, **deterministische** Spiel-Logik: Bewegung, Trail, Loop-Schluss, Fill, Kollision, Regeln. **Kein** Netz, **kein** Rendering, **keine** Uhr/Zufall von außen. Headless testbar. |
| **`protocol`** | Binär-Wire-Format (encode/decode) + Nachrichtentypen; Client und Server teilen es exakt. |
| **`shared`** | Balance-Parameter (`BALANCE`, Kapitel 10) + gemeinsame Konstanten/Typen inkl. Tickrate. Eine Quelle der Wahrheit. |
| **`server`** | Workers/DO-Schale: Arenen, Verbindungen, 20-Hz-Tick, Input, Bots; fährt `sim-core` autoritativ; Transport hinter Interface. |
| **`client`** | Browser: three.js-Rendering, Input, Prediction (fährt `sim-core` lokal), Reconciliation, Interpolation, HUD, Sound. |

Ergänzend (Test): **`sim-client`** — headless Client, der `sim-core` fährt und das echte
Protokoll spricht, aber nicht rendert (Kapitel 9).

### 5.2 Runtime & Prozessmodell (ADR-0001, ADR-0004)

- **Runtime: Cloudflare Workers + Durable Objects** (Free-Plan). Netcode selbst gebaut
  (nicht Colyseus — läuft dort nicht). **Transport-Schicht abstrahiert** → Runtime bleibt
  **reversibel** (späterer Umzug auf eine VM ohne Neubau der Spiellogik).
- **1 DO = 1 Arena.** Öffentliche Arena = *ein* always-on DO mit fester Adresse (Phase 1:
  genau eine). Private Räume = *ein* DO pro **Raum-Code** (`idFromName(code)`),
  hibernieren bei Leere/Lobby, Cleanup per Timeout.
- **Router-Worker** davor: zustandslos, liefert den statischen Client aus, leitet
  WS-Verbindungen ans richtige Arena-DO (öffentlich → feste Adresse, privat → Code). Naht
  für den späteren Matchmaker.

### 5.3 Zustand & Persistenz (ADR-0004)

- **Live-Spielzustand (Positionen/Trails/Gebiet): flüchtig im Speicher**, nicht
  persistiert. Neustart = Arena-Reset, Spieler spawnen frisch (persistenter Live-Zustand =
  „persistenter Canvas" = out of scope).
- **SQLite (im DO):** nur die **Raum-Registry** privater Räume (Code → Konfig), selten
  geschrieben. Auf Free sind DOs nur **SQLite-backed** — passt.
- **Persönliche Rekorde: lokal im Browser (localStorage)**, kein Server-Speicher.
- **Leaderboard:** live aus dem Speicher berechnet (nur %). **Nickname-Blockliste:**
  statisch mit dem Server ausgeliefert.

### 5.4 Bots (ADR-0005)

Server-interne Entities, die ihre Befehle über **dieselbe Eingabe-Schnittstelle** wie
Netz-Spieler einspeisen (Quelle = lokale KI-Heuristik statt WebSocket), mit begrenzter
Wahrnehmung. Kein Netz-/Budget-Overhead, kein Sonder-Pfad → die Sim bleibt ehrlich, Bots
können per Konstruktion nicht schummeln. Bot-Code gekapselt im `server`-Paket.

### 5.5 Erweiterbarkeits-Nähte (ADR-0006)

Fünf Nähte mit Quasi-Null-Kosten heute — **keine** wird jetzt gebaut:

1. **Items/Upgrades** → neutrales **Effekt-Feld** je Entity in `sim-core` (Grundversion
   immer leer); Schießen später = neuer Input-Typ + Projektil-Entities.
2. **Spielmodi** → austauschbares **Regelwerk-Interface** (Grundversion = Strategie
   „endlose Arena"); deckt auch den geparkten Torus-Modus.
3. **Skins/Kosmetik** → sim-neutraler **`appearance`-Deskriptor** (heute Farbindex, später
   Skin-ID); nur der Client rendert ihn.
4. **Accounts/Progression** → **`playerId`-Indirektion**; lokale Rekorde in **migrierbarer**
   Form → wandern später in server-seitige Pro-Account-Persistenz.
5. **Persistenter Canvas** → die **DO-Grenze** ist bereits die Snapshot-Naht; Grundversion
   schreibt nichts (spekulativ, eigenes späteres Vorhaben).

---

## 6. Netcode & Protokoll

Grundlage: [Ticket 05](issues/05-netcode-patterns.md) (Findings:
[`research/netcode.md`](research/netcode.md)), [Ticket 04](issues/04-splix-codebasis-analyse.md)
(Findings: [`research/splix-analyse.md`](research/splix-analyse.md)),
[ADR-0003](../../docs/adr/0003-netcode-und-determinismus.md).

### 6.1 Grundmodell

- **Autoritativer Server + Client-Prediction + Server-Reconciliation + Interpolation** der
  Gegner (Gambetta-Modell). Der Server hat immer recht; der Client sagt nur die *eigene*
  Bewegung voraus und zieht kleine Korrekturen weich glatt. Gegner werden zwischen
  Server-Snapshots geglättet (kleiner Verzögerungspuffer).
- **Fill strikt server-only** — nie client-behauptbar.
- **Kill-Fairness = server-autoritativ mit Rewind:** der Server hält eine
  Positions-Historie und beurteilt Tode/Schnitte aus der Sicht des *handelnden* Spielers.

### 6.2 Tick & Determinismus

- **Tickrate 20 Hz** (dt = 50 ms), einstellbar in `shared` (splix-erprobter Sweet Spot;
  höher = flüssiger, aber mehr DO-CPU).
- `sim-core` = reine Funktion **`schritt(zustand, inputs, dt)`** mit festem `dt`, **ohne**
  echte Uhr, mit **eingespeistem, gesätem RNG**.
- **Float mit _internem_ Determinismus, KEIN Festkomma-Lockstep.** Bit-genaue
  Cross-Machine-Gleichheit ist nicht nötig, weil der Server reconciled. **Notausgang:**
  einzelne heikle Stellen können punktuell auf Festkomma gehoben werden, falls konkrete
  Divergenz auftritt.
- Disziplin gegen Determinismus-Lecks: keine `Date.now`/`Math.random`, stabile
  Iterationsreihenfolge (kein von Map-Insertion abhängiges Verhalten). Gesichert durch
  **Replay-Determinismus-Tests** (Kapitel 9).

### 6.3 Transport & Wire-Format

- **WebSocket + eigenes Binärprotokoll** (`protocol`-Paket). WebTransport erst seit
  Safari 26.4 Baseline und auf Gratis-Hostern ohne UDP kaum nutzbar → **Transport-Schicht
  abstrahiert** (Umzugs-Klappe).
- **Input-Batching Pflicht** (Free-Budget zählt eingehende WS-Messages 20:1, ADR-0001) —
  mehrere Eingaben pro Nachricht bündeln. Prägt das Protokoll-Design.
- **Area-of-Interest / Delta-Updates:** splix als Referenz (Karten-Updates als kleine
  Rechtecke, Viewport beim Join + Randstreifen). **Achtung:** unser Fill ist
  **polygonbasiert**, nicht splix' Uint8-Flood-Fill — splix bleibt Referenz nur für
  **Server-Autorität, 20-Hz-Tick und Binärprotokoll-Aufbau**, nicht für den Fill.
- Latenz-Toleranz des Genres ist hoch (~500 ms); Bandbreite bei 10–100 Spielern ist kein
  Kriterium.

### 6.4 Legitime client-gemeldete Größen

Der Client sendet **ausschließlich Steuer-Intent** (Kapitel 8) plus die **Input-Sequenz­nummer**
für die Reconciliation (monoton, server-begrenzt). Alles andere (Position, Tempo, Fill,
Kill, fremde `playerId`) ist nicht ausdrückbar.

---

## 7. Hosting & Betrieb Phase 1

Grundlage: [Ticket 03](issues/03-hosting-recherche.md) (Findings:
[`research/hosting.md`](research/hosting.md)), [Ticket 13](issues/13-free-tier-billing-sicherheit.md)
(Findings: [`research/free-tier-billing-sicherheit.md`](research/free-tier-billing-sicherheit.md)),
[ADR-0001](../../docs/adr/0001-runtime-und-hosting-cloudflare-workers-durable-objects.md).

### 7.1 Plattform

**Cloudflare Workers + Durable Objects (Free-Plan)**, statischer Client über Workers
Static Assets, EU via `weur`-Hint. Einzige dauerhaft gratis + kartenlose + hart-gestoppte
Option, die den Workload trägt. **Fallback:** Oracle Always-Free A1-VM (Frankfurt) — aber
Kreditkarten-Pflicht, Kapazitätslotterie, Idle-Reclaim-Risiko. „Fast gratis"-Referenz:
Hetzner CX22 (3,79 €/Mt.).

### 7.2 Free-Grenzen (bestätigt, 2026)

- **100 000 Requests/Tag**; eingehende WS-Messages zählen **20:1** (≈ 2 Mio./Tag) →
  **Input-Batching Pflicht**.
- **Duration ~13 000 GB-s/Tag ≈ genau eine** 24/7-Arena (ein aktives DO ≈ 128 MB ×
  Wall-Clock ≈ 10 800 GB-s/Tag, ~85 %).
- Pro DO: 1 GB SQLite, 30 s CPU/Invocation (Reset je Nachricht), 5 Mio. Row-Reads /
  100k Row-Writes pro Tag; **Anzahl DOs unbegrenzt**.
- **DO single-threaded** (kein Web-Worker wie splix) → **CPU pro Arena-Tick ist der
  Engpass** → [Ticket 14](issues/14-do-cpu-benchmark.md) bestimmt die Shard-Größe
  (max. Spieler/Arena).
- Private Räume: leere/Lobby-Räume hibernieren → ≈ 0 Kosten; das Rest-Budget trägt grob
  eine Handvoll aktiver Raum-Stunden/Tag. Regel: **nur ticken, wenn ein Spiel mit Spielern
  läuft; leere Räume sofort schlafen legen.**

### 7.3 Billing-Sicherheit (harte Anforderung des Users)

- **Gratis + abbuchungssicher, solange auf Free UND keine Kreditkarte hinterlegt.** Free
  verlangt keine Karte; Limit-Überschreitung = **harter Stopp mit Fehler, keine Rechnung**.
  Ohne hinterlegte Karte ist eine Belastung strukturell unmöglich.
- **Vorbehalt:** Workers **Paid ($5/Mt.) hat KEINEN harten Spend-Cap** — Overage wird
  automatisch abgebucht, Budget-Alerts sind rein informativ. → **Abbuchungssicherheit =
  auf Free bleiben, keine Karte.** Ein Upgrade ist eine bewusste Kosten-Entscheidung.

### 7.4 Upgrade-Pfad

Workers Paid $5/Mt. deckt eine Dauer-Arena; weitere Arenen = weitere DOs (unbegrenzt),
horizontal + automatisch (kein Load-Balancer, keine Kapazitätsplanung). Skalierung
(mehrere Arenen/Matchmaker) ist **out of scope Phase 1**, aber vom Router-Worker-Schnitt
her offen gehalten.

---

## 8. Sicherheit & Abuse-Schutz

Grundlage: [Ticket 15](issues/15-abuse-cheat-schutz.md).

### 8.1 Leitprinzip: Verfügbarkeit zuerst

Die schärfste Flanke ist **nicht** Integritäts-Cheating — die Server-Autorität (Fill/Kills
server-only, ADR-0003) neutralisiert klassische Cheats strukturell. Fragil ist die
**Verfügbarkeit** der *einen* Gratis-Arena (single-threaded DO, harter Tages-Stopp).
Realer Schaden = die Arena offline nehmen / das Tagesbudget verbrennen (DoS), nicht unfair
gewinnen. Der Abschnitt investiert daher in billige, server-seitige Ressourcen-Deckel.

### 8.2 Autoritäts-Decke (Integrität)

Der Client sendet **ausschließlich Steuer-Intent** (Ziel-Heading / Turn-Signal, plus
Join-/Respawn-Wunsch), nie Position/Tempo/Fill/Kill/fremde `playerId`. Der Server:

- **re-derived Position** jeden Tick aus festem Tempo (9 WU/s) + Heading, **geklemmt** auf
  die legale Drehrate (320°/s) → Teleport / Wall-Clip / Speed-Hack sind **nicht
  ausdrückbar**.
- **verwirft malforme Frames** an der Protokollgrenze (Opcode/Länge/Wertebereich) → droppen,
  bei anhaltendem Müll Socket trennen.
- **bindet jede Eingabe an die Socket-eigene `playerId`** — ein Paket lenkt nur den
  *eigenen* Kopf.

Maximum eines voll manipulierten Clients = den eigenen Kopf legal lenken (= spielen).

### 8.3 In der Grundversion gebaut

Alle server-seitig, deterministisch, ohne Fremddienst; Schwellen als abstimmbare Konstanten
(neben `BALANCE`), in der Implementierung kalibriert.

1. **Intent-only-Validierung** (8.2) — die Basis.
2. **Flood-/Rate-Schutz pro Verbindung:** eine wirksame Eingabe pro Spieler pro Tick
   (Coalescing, nur die *letzte* Intent); **Frame-Größen-Cap** vor dem Parsen; **Kill bei
   anhaltendem Flood/Garbage** (Trennung nach kleinem Toleranzfenster).
3. **Pro-IP-Deckel** (Hebel = `CF-Connecting-IP` am Router-Worker), **großzügig &
   CGNAT-/Shared-WLAN-tolerant:** max. gleichzeitige Verbindungen pro IP Default ~**16**
   (im Zweifel durchlassen); **Join-Rate pro IP** gegen Reconnect-Spam und
   Raum-Code-Brute-Force.
4. **Arena-Populationsgrenze** — harter Cap gleichzeitiger Spieler (**Wert ←
   [Ticket 14](issues/14-do-cpu-benchmark.md)**). Menschen zuerst, Bots füllen nur freie
   Slots. Bei Erreichen: saubere **„Arena voll"-Abweisung** — **keine Queue, kein
   Auto-Sharding** (Skalierung out of scope). Der eigentliche Anti-Dominanz-Backstop.
5. **Nickname-Moderation** — statische Server-Blockliste + Längen-/Zeichenlimits (1–16)
   reichen für den Launch; Server erzwingt. Namen flüchtig & kosmetisch → Impersonation
   folgenlos. Blocklisten-Umgehung (Leetspeak/Unicode) = bewusst akzeptiertes Restrisiko.
6. **Private Räume:** Raum-Code = **freundliche Obskurität** (~**6 Zeichen** aus eindeutigem
   Alphabet ohne `0/O`,`1/I/l`, case-insensitiv, ~10⁹ Kombinationen); Enumerations-Schutz =
   moderate Entropie + sehr wenige lebende Räume + Join-Rate-Limit + Wegwerf-Natur.
   **Raum-Erstellung pro IP raten-begrenzt** (jeder Raum = DO + SQLite-Write). Leere/Lobby-
   Räume hibernieren + Timeout-Cleanup.

### 8.4 Bewusst verschoben (mit Auslöser)

- **Turnstile / Proof-of-Work vor dem Join** — Auslöser: die öffentliche Arena wird real
  geschwärmt (dann als „unsichtbares" Turnstile beim Join).
- **Melde-/Mute-Funktion + Homoglyph-/Unicode-Normalisierung** für Nicknames — Auslöser:
  Community wächst / Beschwerden häufen sich.
- **Verteilte-Schwarm-Abwehr** & mehrere Arenen/Warteschlange — Auslöser: Skalierungspfad
  (mehrere DOs / Matchmaker), out of scope Phase 1.

### 8.5 Betriebshaltung

**Verfügbarkeit = ausdrücklich „best effort"** (keine Uptime-Garantie). Der harte
Tages-Stopp ist die *gewollte* Abbuchungssicherheit. Worst Case eines erfolgreichen DoS =
die Arena parkt bis zum Tages-Reset — **kein Kostenrisiko, keine Rechnung**. Die Spec
formuliert das explizit, statt Garantien zu suggerieren, die eine Gratis-Ein-DO-Arena nicht
hält.

---

## 9. Teststrategie & Qualitätsstandards

Grundlage: [Ticket 09](issues/09-teststrategie-qualitaet.md). Grundprinzip: **hohe
Abdeckung kritischer Pfade, keine Shortcuts — mechanisch erzwungen statt guter Vorsatz.**
Operative Kurzfassung → `CLAUDE.md`; Vokabular → `CONTEXT.md`.

### 9.1 Testpyramide (entlang der Pakete)

| Paket | Testarten | Gewicht |
|---|---|---|
| **`sim-core`** (rein, deterministisch) | Unit + **Property-based** + **Replay-Determinismus/Golden-Fixtures** — Fill, Trail-Schnitt, Kollision, Tod-Bedingungen, Loop-Schluss, Kopf-an-Kopf, Barriere | **tragend** |
| **`protocol`** | Round-trip-Property (`decode(encode(x))==x`) + Golden-Byte-Tests | mittel, billig |
| **`shared`** | nur Sanity (Wertebereiche/Balance gültig) | minimal |
| **`server`** (Workers/DO) | Integration via `@cloudflare/vitest-pool-workers` gegen echtes DO — Raum-Lifecycle, Tick treibt Sim, Input-Validierung, Bot-Injektion, Join/Leave, Reconnect | mittel |
| **`client`** | Rendering (three.js) **ausgenommen**; Prediction/Reconciliation-**Logik** headless getestet | dünn |

Darüber zwei **stack-durchgreifende** Schichten (Kern-Mechanik als Regressions-Wächter):

- **Szenario-Tests (headless, Arbeitsgaul):** echter Server (Workers-Pool) + zwei/mehr
  **Sim-Clients** über das echte Binärprotokoll, ohne Browser/Rendering. Trägt die
  „Core-Konzepte dürfen nicht kaputtgehen"-Garantie.
- **Playwright-E2E (kuratiert obendrauf):** eine Handvoll essentieller Mechaniken im echten
  Browser + was nur der Browser prüft (Input-Devices Maus/Touch/Tastatur, Render-Wiring,
  Reconnect, zwei reale Clients in einer Arena). Nicht als breite flaky Suite.

### 9.2 `sim-core`-Tiefe (Pflicht-Gattungen)

- **Property-based (`fast-check`)** auf Invarianten: Flächenanteile aller Spieler + neutral
  = 100 % (nie negativ / > Karte); Fill erzeugt nie Loch/Überlappung; geschlossener Loop
  vergrößert eigenes Gebiet ≥ eingeschlossene Fläche; Tod ⇒ Gebiet komplett neutral.
- **Replay-Determinismus als First-Class-Test:** gleiche Input-Sequenz + gleicher Seed ⇒
  **bit-identischer Zustands-Hash** nach N Ticks (fixes `dt`, keine Uhr). Basis für
  Prediction/Reconciliation.
- **Golden-Replay-Fixtures:** eingecheckte Input-Logs + erwarteter End-Hash.

### 9.3 Coverage (CI-Gate, harte Untergrenze — Boden, der nur steigt)

| Paket | Schwelle (Boden) | Anspruch |
|---|---|---|
| `sim-core` | ≥ 95 % Branch | Vollabdeckung; sonst `c8 ignore` + Begründung |
| `protocol` | ≥ 90 % | — |
| `shared` | ausgenommen | — |
| `server` | ≥ 75 % Zeilen | Vollabdeckung; Hibernation/Reconnect begründet ausnehmbar |
| `client`-Logik | ≥ 80 % (Render ausgenommen) | — |
| Szenario/E2E | zählen **nicht** in %; getrackt als Szenario-Checkliste | — |

**Mutation-Testing (Stryker):** nur auf `sim-core`, separater **nächtlicher/manueller**
Job (`pnpm mutation`), **nicht** PR-Pflicht-Check, Ziel-**Mutation-Score ≥ 80 %**.

### 9.4 Toolchain

pnpm-Workspaces · **Vitest** (v8-Coverage) · **`fast-check`** ·
**`@cloudflare/vitest-pool-workers`** · **ESLint** Flat Config + `typescript-eslint`
**strict-type-checked** · **Prettier** + `eslint-config-prettier` · **Playwright**.

**tsconfig:** `strict` **plus** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
`verbatimModuleSyntax`, `isolatedModules`.

### 9.5 CI/CD — GitHub Actions

Pipeline bei **jedem PR** und **Push auf `main`**:

1. `typecheck` (`tsc --noEmit`, alle Pakete)
2. `lint` (ESLint strict-type-checked) + `format:check` (Prettier)
3. **Tests** Unit/Property/Replay (`sim-core`) + Protocol-Round-trip + Server-Integration
   + headless **Szenario-Tests** **+ Coverage-Gate** (pro Paket)
4. **Playwright-E2E** (kuratierte Kern-Mechanik, headless) — **Pflicht-Check**
5. `build` (alle Pakete)

**CD-Tor:** Der Deploy-Job (Cloudflare Workers/DO + statischer Client) hängt via `needs:`
an **allen** vorherigen grünen Jobs → ein roter Push auf `main` rollt **nichts** aus.
Mutation-Job läuft separat (nächtlich), nicht blockierend.

### 9.6 Enforcement („keine Shortcuts" mechanisch)

- **Lint = Fehler** (bricht den Build), nicht Warnung.
- **Escape-Hatches nur mit Begründung:** `no-explicit-any` = error; `@ts-expect-error`
  statt `@ts-ignore` **mit Pflicht-Begründung** (`ban-ts-comment`); `eslint-disable` nur
  zeilenweise mit Begründung (`eslint-comments/require-description`); kein `.only`
  (`forbidOnly` in CI); `.skip` nur mit Kommentar-Verweis auf ein offenes Ticket.
- **Pre-commit-Hooks** (husky + lint-staged): Format + Lint + Typecheck auf staged Dateien;
  **commit-msg-Hook** (commitlint) für Conventional Commits.
- **CI ist die Autorität** — Hooks sind lokaler Komfort (`--no-verify`-umgehbar), CI läuft
  dieselben Gates unumgehbar.

### 9.7 Konventionen & Definition of Done

- **Branching:** Solo → **Direkt-Push auf `main` erlaubt**; Schutz = Gates + CD-Tor.
  **Upgrade-Pfad** (nicht mehr solo): kurzlebige Feature-Branches + PR auf geschütztem
  `main` (Required Checks), Squash-Merge.
- **Commits:** Conventional Commits (via commitlint).
- **Definition of Done** (Pflicht-Checkliste pro Änderung):
  1. Code **und** Tests zusammen; kritische Pfade abgedeckt, pro-Paket-Coverage erfüllt.
  2. Alle CI-Gates grün (typecheck, lint, format, tests, coverage, E2E, build).
  3. Neue/geänderte Domänenbegriffe → `CONTEXT.md`; architektonische Entscheidungen → ADR.
  4. Keine unbegründeten Escape-Hatches.
  5. Änderung an Kern-Mechanik ⇒ Szenario-/E2E-Abdeckung mitgezogen.
  6. Kein toter Code; öffentliche Modul-APIs knapp dokumentiert.
- **Test-Datei-Konventionen:** colocated `*.test.ts` (Unit/Property/Replay);
  **Szenario-Tests** unter `tests/scenario/`; **Playwright** unter `tests/e2e/`.

---

## 10. Balance-Parameter & Startwerte

Grundlage: [Ticket 11](issues/11-balance-parameter.md). **Alle Werte sind begründete
Startwerte — in der Implementierung gegen einen spielbaren Build nachzujustieren.**

### 10.1 Maßeinheit

- **Welteinheit (WU)** (`WU` / `worldUnit`) — Basis-Längeneinheit der kontinuierlichen
  Welt (Positionen, Distanzen, Größen). Ersetzt die grid-behaftete „Zelle". Der Render-Zoom
  (26 px/WU im Prototyp) ist davon unabhängig.
- Tick **20 Hz** → dt 50 ms → Schritt pro Tick bei 9 WU/s = **0,45 WU**.

### 10.2 Arena (öffentlich)

- Kantenlänge **200 × 200 WU**, quadratisch, sanfte Barriere (kein Rand-Tod).
- Folge: Kreuzungszeit ≈ 22 s; ≈ 52 × 52 WU Raum pro Entity bei 15 Entities.

### 10.3 Bewegung

- Tempo **9 WU/s**, **konstant** — *keine* Skalierung mit Gebietsgröße (splix-Bremse
  verworfen: konstantes Tempo ist Genre-Standard und sauberer für die Prediction; eine
  Comeback-Mechanik käme später über die Effekt-Naht ADR-0006).
- Drehrate **320°/s** (≈ 5,585 rad/s → Wenderadius ≈ 1,6 WU).

### 10.4 Spawn · Trail/Fill · Bots · Private Räume

**Spawn**
- Startblock **6 × 6 WU** (≈ 0,09 % der Karte).
- Spawn-Mindestabstand **25 WU** zu Gegnerkopf/-gebiet (≈ 2,8 s Reisezeit bis zur Gefahr;
  bei Gedränge bestmögliche freie Stelle). Kein Unverwundbarkeits-Timer.

**Trail / Fill**
- Trail-Breite **1,0 WU** (kontinuierliches Analog zum 1-Kachel-Trail von splix).
- Kopf-/Kollisionsradius **0,5 WU** (halbe Trail-Breite; für Trail-Schnitt/Kopf-an-Kopf).
- Minimale Fill-Fläche **1 WU²** (nur numerische Splitter verwerfen).

**Bots (öffentliche Arena)**
- Ziel-Mindestbelebung **8** Entities, solange ≥ 1 Mensch anwesend; max. Bots **8**;
  `bots = clamp(ziel − menschen, 0, 8)`. 0 Menschen → 0 Bots (Arena hibernert).
- Verhalten: Heuristik (ADR-0005), „kompetent aber schlagbar"; KI-Feintuning =
  Implementierung.
- ⚠ Ziel 8 ist CPU-abhängig → gegen [Ticket 14](issues/14-do-cpu-benchmark.md) bestätigen.

**Private Räume**
- Default-Kartengröße je Spielerzahl: `Kante = √(Spieler × 5000)` WU → 2p **100**,
  4p **140**, 8p **200**, 16p **280** WU; Host frei überschreibbar.
- Default-Spielerlimit **8** (Bereich 2–16); Nachjoin default **an**.
- Gnadenfrist leerer Raum **90 s**. Bots default **aus** (Host-Toggle; bei Aktivierung
  füllt dieselbe clamp-Regel bis zum Raumlimit).

### 10.5 Score

**Formel:** `score = round(peakPct × √überlebenSek × (1 + 0,25 × ØandereMenschen) × 10)`

- `peakPct` = maximal gehaltener Karten-%-Anteil im Leben (0–100; kartengrößen-unabhängig
  → gilt auch für private Räume).
- `ØandereMenschen` = zeitgemittelte Zahl gleichzeitig lebender *anderer* Menschen (Bots
  zählen nicht → kein Farmen leerer/Bot-Arenen).
- `√überlebenSek` (sublinear) → bremst reines Campen, belohnt aktive Flächenkontrolle.
- Berechnung beim **Tod**; identische Formel schätzt den Live-Score aufs HUD.
- **Referenz-Größenordnung:** schneller Tod (3 %/15 s/solo) ≈ **116**; solider Lauf
  (15 %/120 s/4 Menschen) ≈ **3 290**; Top-Lauf (35 %/300 s/8 Menschen) ≈ **18 190**.

### 10.6 Struktur & Nachjustierbarkeit

- Alle Werte in **einem** typisierten, dokumentierten Modul **`shared/src/balance.ts`** als
  eingefrorenes `BALANCE`-Objekt, gruppiert (`arena` / `movement` / `spawn` / `trail` /
  `bots` / `room` / `score`), konsumiert von `sim-core`/`server`/`client`. Der 20-Hz-Tick
  lebt dort neben den übrigen Konstanten.
- **Keine Runtime-I/O** — zur Build-Zeit gebacken, hält `sim-core` rein/deterministisch,
  ein Ort zum Tunen, typgeprüft, kein Client/Server-Drift.
- Runtime-Overrides (Live-A/B, DO-seitig) bewusst zurückgestellt — später ergänzbar ohne
  Strukturänderung.

---

## 11. Offene Punkte für den Implementierungs-Start

Nach Abnahme dieser Spec beginnt die Umsetzung als eigenes Vorhaben. Nicht mehr Teil des
Wayfindings, hier als Übergabe festgehalten:

- **[Ticket 14 — DO-CPU-Benchmark](issues/14-do-cpu-benchmark.md)** (erster
  Implementierungs-Spike, blockiert durch diese Spec): belastbare Zahl „max. Spieler/Arena"
  → bestätigt/korrigiert die provisorischen Werte (Bot-Ziel 8, Arena-Populationsgrenze) und
  gibt Go/No-Go bzw. eine Mitigationsliste für ADR-0001. Gegenmittel prüfen: Fill zum Färben
  **rastern** statt reiner Polygon-Geometrie; Arena-/Spielerzahl deckeln.
- **GitHub-Remote + Actions einrichten** — das Verzeichnis ist bereits ein Git-Repo, aber
  **ohne Remote**. Remote + CI-Pipeline (Kapitel 9.5) sind der erste Umsetzungsschritt.
- **Namensfindung / Markenprüfung** vor Veröffentlichung (DrawRace-Kollision, s. 1.3).

---

## Anhang — Referenzen

- **Glossar (verbindlich):** [`CONTEXT.md`](../../CONTEXT.md)
- **ADRs:** [0001 Runtime/Hosting](../../docs/adr/0001-runtime-und-hosting-cloudflare-workers-durable-objects.md)
  · [0002 Monorepo/Sim-Core](../../docs/adr/0002-monorepo-mit-geteiltem-deterministischem-sim-core.md)
  · [0003 Netcode/Determinismus](../../docs/adr/0003-netcode-und-determinismus.md)
  · [0004 Arena/Prozess/Persistenz](../../docs/adr/0004-arena-prozess-und-persistenzmodell.md)
  · [0005 Bot-Architektur](../../docs/adr/0005-bot-architektur.md)
  · [0006 Erweiterbarkeits-Nähte](../../docs/adr/0006-erweiterbarkeits-naehte.md)
- **Marktrecherche:** [`research-existing-games.md`](research-existing-games.md)
- **Research-Findings:** [`research/`](research/) (splix-Analyse, Netcode, Hosting,
  Rendering-Engine, Free-Tier/Billing)
- **Prototypen:** [`prototype/movement.html`](prototype/movement.html) ·
  [`prototype/look-and-feel.html`](prototype/look-and-feel.html)
- **Map:** [`map.md`](map.md)
