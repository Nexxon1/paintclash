# Netcode-Architektur für ein Browser-Trail-/Territory-Spiel

**Stand: 2026-07-18** · Recherche zu Ticket 05; die Ergebnisse fliessen in Ticket 08 (Architektur-Entscheid) ein. Untersucht wurde die Netcode-Architektur für ein splix.io-artiges Spiel (Trail ziehen, Loop schliessen, Fläche färben) mit autoritativem TypeScript-Server, Browser-Client (Desktop + Mobile), ~10–100 Spielern pro endloser Arena (~600×600 Grid-Blöcke), EU-Hosting, Phase 1 auf Gratis-Hosting. Alle Teilfragen sind jeweils für die **Grid-Variante** (Bewegung Zelle für Zelle) und die **Continuous-Variante** (freie Lenkung à la Paper.io 2) beantwortet.

---

## TL;DR

### Empfehlung Grid-Variante

- **Muster:** Autoritativer Server ([Gambetta I](https://www.gabrielgambetta.com/client-server-game-architecture.html)); Client zieht die eigene Figur per Dead Reckoning sofort weiter (konstante Geschwindigkeit macht Bewegung zwischen Richtungswechseln perfekt vorhersagbar). Richtungswechsel werden mit der Ziel-Zelle gesendet („turn at cell x,y“), der Server darf Spieler dafür bis zu einem Limit zurückversetzen und Ereignisse rückgängig machen — exakt das Modell des offiziellen splix-Servers ([PlayerEventHistory.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/gameplay/PlayerEventHistory.js), [config.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/config.js)). Fill/Flächenübernahme ist strikt server-only.
- **Tick:** 20 Hz Server-Tick (splix: 50 ms; [ApplicationLoop.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/ApplicationLoop.js)), fixer Zeitschritt nach [Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/). Integer-Grid-Simulation ⇒ trivial deterministisch, geteilte TS-Logik unkritisch.
- **Transport:** WebSocket (TCP). Für 20-Hz-Kleinpakete auf EU-Latenzen genügt das; splix.io läuft produktiv so. WebTransport ist seit März 2026 zwar Baseline im Browser ([Safari 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/)), aber serverseitig in Node nicht in Core und auf Gratis-Hostern (HTTP-Proxys, kein UDP) kaum nutzbar. Transport-Schicht abstrahieren, WebTransport später optional.
- **Wire-Format:** Binär über `DataView`/`ArrayBuffer` nach splix-Vorbild (uint8-Pakettyp, uint16-Koordinaten, Fill als Rechteck-Deltas à 12 Byte) oder Colyseus-Schema. JSON nur für Lobby/Meta. Area-of-Interest-Viewport + Karten-Chunks; Bandbreite ist bei 10–100 Spielern kein Engpass (Grössenordnung einstellige KB/s pro Client).
- **Bibliothek:** Beides vertretbar. Colyseus (MIT) nimmt Rooms/Reconnect/Testing ab; ein Eigenbau auf `ws`/uWebSockets.js ist für Grid realistisch, weil mit [jespertheend/splix](https://github.com/jespertheend/splix) (MIT) eine vollständige Referenzimplementierung genau dieses Spiels existiert. In jedem Fall: Simulation als reines, headless testbares TS-Paket vom Transport trennen.

### Empfehlung Continuous-Variante

Gleiches Grundgerüst (autoritativer Server, 20–30 Hz, WebSocket, binär), aber zusätzlich nötig:

- **Echte Client-Prediction + Server-Reconciliation** mit Input-Sequenznummern und Re-Apply ([Gambetta II](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)) für die eigene Lenkung, plus Glättung von Korrekturen (Error-Offsets, die über Zeit abgebaut werden, wie in [State Synchronization](https://gafferongames.com/post/state_synchronization/)).
- **Snapshot-Puffer + Entity-Interpolation** (1–2 Snapshots hinter dem Server, [Gambetta III](https://www.gabrielgambetta.com/entity-interpolation.html)) für Remote-Spieler — Dead Reckoning allein reicht nicht mehr, weil Kurven jederzeit beginnen können.
- **Float-Geometrie:** Trail als Polylinie, Kollision = Segment-Schnitttests, Flächenübernahme = Polygon-Schliessung/Rasterisierung statt Flood-Fill auf Integer-Grid. Für faire Kills braucht es eine Positions-Historie mit Rewind (Valve-artige [Lag Compensation](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)).
- **Determinismus-Pflege:** `Math.sin/cos/atan2` sind laut [MDN implementation-dependent](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math) — für Prediction reicht „gut genug“, aber die geteilte Sim muss diszipliniert geschrieben werden (fixe Integrationsschritte, eigene Trig-Funktionen falls nötig).
- **Mehr Traffic:** Positions-/Heading-Updates pro Tick statt nur bei Richtungswechseln, Trail-Polylinien statt Eckpunkten (~5–10× mehr Downstream, absolut aber immer noch klein).

### Aufwandsunterschied explizit

| Baustein | Grid | Continuous |
|---|---|---|
| Prediction eigener Spieler | Dead Reckoning + „turn at cell“ (kein Rollback nötig) | Input-Sequenzen, Reconciliation, Re-Simulation, Glättung |
| Remote-Spieler | Extrapolation (konstante Geschwindigkeit) + Lerp | Snapshot-Buffer + Interpolationsdelay |
| Kollision/Fairness | Zellvergleich + Undo-Fenster (splix-Modell fertig ablesbar) | Segment-Schnitt + Positions-Historie/Rewind |
| Fill | Flood-Fill auf Integer-Grid, Rechteck-Deltas | Polygon-Schliessung, Rasterisierung, mehr Kantenfälle |
| Determinismus | Trivial (Integer) | Float-Disziplin nötig |
| Bandbreite | Event-basiert, minimal | Pro-Tick-Snapshots, ~5–10× |
| Referenzcode | splix (MIT) = 1:1-Vorlage | keine offene 1:1-Vorlage bekannt |

Grobe Relation: **Netcode + netznahe Sim-Teile der Continuous-Variante ≈ 2–3× Aufwand der Grid-Variante**, mit deutlich höherem Tuning-Risiko (Reconciliation-Glättung, Kill-Fairness). Die Grid-Variante ist zusätzlich de-riskt, weil der offizielle splix-Server (MIT) jede heikle Stelle vorgelöst zeigt. *(Die Faktor-Angabe ist eine Einschätzung aus den belegten Mehr-Bausteinen, keine gemessene Grösse.)*

---

## 1. Grundmuster: Autoritativer Server, Prediction, Reconciliation, Interpolation

### Das Basismodell (genreunabhängig)

Gambettas Serie liefert das Standardmuster: Der Server ist alleinige Autorität, Clients sind „privileged spectators“, die nur Inputs senden — „don't trust the player“ ([Gambetta I](https://www.gabrielgambetta.com/client-server-game-architecture.html)). Das erzeugt das Latenzproblem (Input → sichtbare Wirkung = 1 RTT), das mit Client-Side Prediction kaschiert wird: Inputs werden „sent to the server and *immediately* processed on the client“; Voraussetzung ist ein Spiel, das „deterministic enough“ ist ([Gambetta II](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)). Reconciliation: Inputs tragen Sequenznummern, der Server bestätigt die zuletzt verarbeitete, der Client wendet unbestätigte Inputs auf den neuen autoritativen State erneut an (ebd.). Remote-Spieler werden aus vergangenen, bestätigten Daten interpoliert ([Gambetta III](https://www.gabrielgambetta.com/entity-interpolation.html)).

### Was ist im Trail-Genre anders als im Shooter?

**Was wird predicted? Nur eigene Position/Richtung — und die ist fast perfekt vorhersagbar.** Alle Spieler bewegen sich mit konstanter Geschwindigkeit (splix: `PLAYER_TRAVEL_SPEED = 0.006` Zellen/ms = 6 Zellen/s, Kommentar: „This should be the same value as on the client“ — [config.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/config.js)). Der offizielle splix-Client nutzt darum **Extrapolation (Dead Reckoning) für alle Spieler statt verzögerter Interpolation**: Er führt pro Spieler eine `serverPos` mit, bewegt sie jeden Frame mit `deltaTime * GLOBAL_SPEED` weiter, addiert einmalig die während der Übertragung verstrichene Distanz („add distance traveled during server delay (ping/2)“) und glättet die Darstellung per Lerp auf eine `drawPos` ([client/src/main.js](https://github.com/jespertheend/splix/blob/master/client/src/main.js), u. a. Zeilen ~1635 ff., ~4259 ff., ~4053 ff.). Fehlprognosen entstehen nur an Richtungswechseln anderer Spieler — dort korrigiert die nächste Server-Position, sichtbar als kleiner Lerp-Ruck.

**Fill/Flächenübernahme ist immer server-only.** Im offiziellen splix-Server läuft der Flood-Fill in einem Worker auf einer temporären Maske („we allocate a temporary mask which we perform the flood fill algorithm on … then take those tiles and inform the arena“ — [updateCapturedArea.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/gameplay/arenaWorker/updateCapturedArea.js)); das Ergebnis geht als `FILL_RECT`-Rechtecke an die Clients ([WebSocketConnection.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/WebSocketConnection.js), `sendFillRect`). Der Client entscheidet nie selbst über Übernahmen. Das ist auch fürs eigene Spiel richtig: Die Füllung ist nicht bewegungsblockierend, eine Anzeige-Latenz von RTT + 1 Tick (~100–150 ms) beim Einfärben ist unkritisch — im Zweifel mit einer kurzen Client-Animation kaschierbar. (Optional kann der Client die Füllung *optimistisch* vorzeichnen, da er dieselbe Sim-Logik besitzt; verbindlich bleibt der Server.)

**Braucht es Lag Compensation/Rewind wie bei Hitscan?** Nicht in der Shooter-Form. Valves Lag Compensation hält eine Positions-Historie („keeps a history of all recent player positions for one second“) und verschiebt beim Schuss alle *anderen* Spieler zurück: „Command Execution Time = Current Server Time − Packet Latency − Client View Interpolation“ ([Source Multiplayer Networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)). Im Trail-Genre gibt es keinen Zielvorgang auf fremde Hitboxen — dafür ein anderes Fairness-Problem: **verspätete Richtungswechsel**. splix löst das mit einem Undo-Modell statt Hitscan-Rewind:

> „Clients can specify at which specific tile they want to make a turn, so if the message arrives late, we'll move the player back a few tiles so that it matches this exact tile. However, we also want to undo any events that happened during that time. Such as player deaths or filled tiles.“ — [PlayerEventHistory.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/gameplay/PlayerEventHistory.js)

Konfiguration: `MAX_UNDO_EVENT_TIME = 600` ms („essentially the max ping we allow the player to have before they start having a bad time“) und `MAX_UNDO_TILE_COUNT = 5` Zellen („clients need more than 500 ms ping in order to not be able to control themselves“) — [config.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/config.js). Sogar bereits an Clients gemeldete Tode werden zurückgenommen: Nachricht `UNDO_PLAYER_DIE` („Lets the client know that a player didn't die after all“ — [WebSocketConnection.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/WebSocketConnection.js)).

**Trail-Kollision bei Latenz:** Der Server entscheidet allein (Positionen aller Spieler auf seiner Zeitachse); die Undo-Mechanik verschiebt die Fairness zugunsten des Spielers, dessen Ausweich-Input unterwegs war — das Genre-Analogon zu Valves „favor the shooter“ bzw. Gambettas Feststellung, Lag Compensation sei „somewhat unfair“, aber besser als „to miss an unmissable shot“ ([Gambetta IV](https://www.gabrielgambetta.com/lag-compensation.html)). Details und Abwägung in Abschnitt 6.

### Unterschied Grid vs. Continuous

- **Grid:** Kein klassisches Prediction/Reconciliation-Paar nötig. Der Input ist diskret („ab Zelle (x,y) Richtung d“), splix' Client-Nachricht `UPDATE_MY_POS` ist genau das: `int8 dir (0–3, 4 = paused) + uint16 x + uint16 y`, 6 Byte ([WebSocketConnection.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/WebSocketConnection.js), Handler `UPDATE_MY_POS`; identisch im [Reverse-Engineering-Protokoll](https://github.com/JosefKuchar/Splix.io-Protocol/blob/master/Protocol.md), Client-Packet 1). Client und Server simulieren dieselbe triviale Bewegung; Korrekturen betreffen nur den Turn-Zeitpunkt.
- **Continuous:** Lenk-Inputs sind kontinuierlich (Heading/Winkelrate pro Tick). Hier braucht es das volle Gambetta-II-Programm: Input-Sequenznummern, Server-Ack, Re-Apply der pending Inputs, plus visuelles Glätten der Restfehler über „position and orientation error offsets that we reduce over time“ ([Gaffer, State Synchronization](https://gafferongames.com/post/state_synchronization/)). Für Remote-Spieler ist reine Extrapolation riskant (Kurvenbeginn unvorhersehbar) → Snapshot-Interpolation 1–2 Updates hinter Serverzeit ([Gambetta III](https://www.gabrielgambetta.com/entity-interpolation.html)). Kollisionen sind Segment-Schnitte zwischen Kapsel/Punkt und Polylinien; für Latenz-Fairness braucht der Server eine Positions-/Trail-Historie zum Rückrechnen — strukturell näher an Valves Lag Compensation als am splix-Undo.

---

## 2. Tick-Rate & Simulation

### Vergleichswerte (Primärquellen)

| System | Simulationsrate | Update-/Patch-Rate an Clients | Quelle |
|---|---|---|---|
| splix.io (offizieller Server) | Tick alle **50 ms (20 Hz)** (`APPLICATION_LOOP_INTERVAL = 50`, „Tick rate in milliseconds“) | ereignisbasiert + Positionsmeldungen; Minimap-Viertel alle 250 ms, Leaderboard alle 3 s | [ApplicationLoop.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/ApplicationLoop.js), [config.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/config.js) |
| Colyseus (Defaults) | `setSimulationInterval` Default **16,6 ms (60 fps)** | `patchRate` Default **50 ms (20 fps)** | [docs.colyseus.io/room](https://docs.colyseus.io/room) |
| Valve Source | **66,6 Ticks/s** („By default, the timestep is 15ms“); Source 2: 64 Tick mit Sub-Tick | Default **20 Snapshots/s** (`cl_updaterate 20`) | [Source Multiplayer Networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking) |
| Gambettas Beispielrechnung | — | 10 Updates/s (100-ms-Interpolationsfenster) | [Gambetta III](https://www.gabrielgambetta.com/entity-interpolation.html) |

**Einordnung:** Shooter brauchen hohe Tick-Raten wegen präziser Hit-Detection; ein Trail-Spiel mit 6 Zellen/s Bewegung nicht. splix' 20 Hz sind der belegte Genre-Referenzwert; bei 20 Hz legt ein Spieler 0,3 Zellen pro Tick zurück. **Empfehlung beide Varianten: 20–30 Hz Server-Sim, Rendern mit Display-Rate, Netz-Updates ≤ Tick-Rate.** Für Continuous eher 30 Hz (weichere Snapshots für Interpolation), für Grid reichen 20 Hz sicher.

### Fixe Zeitschritte

[Fix Your Timestep!](https://gafferongames.com/post/fix_your_timestep/) begründet fixe dt: „The behavior of your physics simulation depends on the delta time“; das Zielmuster ist der Akkumulator („The renderer produces time and the simulation consumes it in discrete dt sized steps“) mit Interpolation der Renderposition (alpha = accumulator/dt) und Schutz vor der „spiral of death“. Für die geteilte TS-Sim heisst das: **Sim-Schritt mit konstantem dt als reine Funktion** `step(state, inputs)`, auf Server (Tick-Loop) und Client (Prediction/Replay) identisch aufrufbar. Bemerkenswert: Der splix-Server selbst arbeitet *nicht* mit fixem dt, sondern rechnet Positionen zeitkontinuierlich aus gemessenem `dt` (mit Klemmung über `MAX_LOOP_DURATION_MS`) — für lineare Bewegung mit konstanter Geschwindigkeit ist das äquivalent und robust ([ApplicationLoop.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/ApplicationLoop.js)). Sobald Integration nichtlinear wird (Continuous-Kurven!), ist fixes dt Pflicht, sonst divergieren Client- und Server-Bahnen systematisch.

### Determinismus in TypeScript: Wo lauern die Fallen — und wie relevant sind sie?

- **Basis-Arithmetik (`+ − × ÷`, Vergleiche) auf IEEE-754-Doubles ist in ECMAScript exakt spezifiziert** und liefert engine-übergreifend identische Bits. Die Falle sind die **`Math`-Funktionen**: „Many `Math` functions have a precision that's *implementation-dependent*. This means that different browsers can give a different result. Even the same JavaScript engine on a different OS or architecture can give different results!“ ([MDN: Math](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math)). Betroffen: `sin`, `cos`, `atan2`, `exp`, `pow` … — also genau die Funktionen, die eine Continuous-Lenkung benutzt (V8 auf dem Server vs. JSC in Safari können abweichen).
- **Wie relevant ist das?** Bei autoritativem Server mit State-Sync: wenig. Gaffers [State Synchronization](https://gafferongames.com/post/state_synchronization/) ist bewusst „approximate and lossy“ — der Server schickt regelmässig autoritativen State, kleine Client-Abweichungen werden weggeschliffen; perfekter Determinismus ist nur bei [Deterministic Lockstep](https://gafferongames.com/post/deterministic_lockstep/) nötig („Not close enough. **Exactly the same result**… exact down to the bit level“), den wir nicht brauchen. Gambetta verlangt für Prediction nur „deterministic enough“ ([Gambetta II](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)).
- **Grid-Variante: Integer-Simulation ⇒ trivial deterministisch.** Zellkoordinaten sind uint16, Zeit lässt sich in Ticks zählen, alle Operationen bleiben in exakt darstellbaren Ganzzahlen (Doubles sind bis 2^53 exakt). Kein `Math.*` im Sim-Kern, keine Engine-Differenzen, Replay-Tests bitgenau — ein echter, konkreter Architekturgewinn der Grid-Variante.
- **Continuous-Variante:** Für Prediction reicht „gut genug“, aber Disziplin nötig: fixes dt, kein `Math.random` im Sim-Kern, idealerweise eigene `sin/cos`-Approximation oder Lookup-Table, Quantisierung des States am Netz (uint16-Positionen), damit Korrekturen klein bleiben. Wer später Replays/Verifikation bitgenau will, muss das von Anfang an durchziehen — Vorbild [OpenFront.io](https://github.com/openfrontio/OpenFrontIO): TypeScript-Spiel mit expliziter Trennung `src/client` / `src/server` / `src/core` („deterministic game simulation“; Lizenz beachten: **AGPL-3.0**, nur als Anschauung, kein Code-Import).
- **Geteilter Code:** splix führt Client, Server und `shared/` im Monorepo; die Geschwindigkeitskonstante ist explizit als client-server-identisch dokumentiert ([config.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/config.js)). Empfehlung: Sim als eigenes Paket (`packages/sim`), von Client und Server importiert, ohne DOM-/Node-Abhängigkeiten.

---

## 3. Transport: WebSocket vs. WebTransport vs. WebRTC

### Das Argument gegen TCP

Gaffer on Games: TCP liefert zuverlässig und geordnet; bei Paketverlust wartet alles Neuere auf die Wiederübertragung des Alten — Head-of-Line-Blocking: „The most recent data they want is delayed while waiting for old data to be resent“ ([Why can't I send UDP packets from a browser?](https://gafferongames.com/post/why_cant_i_send_udp_packets_from_a_browser/)). Rohes UDP gibt es im Browser aus Sicherheitsgründen nicht (DDoS, Netz-Sondierung; ebd.).

### Optionen im Browser (Stand Juli 2026, nachgeprüft)

| Transport | Browser-Support | Server (Node/Deno) | Free-Hosting-Tauglichkeit |
|---|---|---|---|
| **WebSocket (TCP)** | universell | `ws`, uWebSockets.js, Deno nativ | ✅ überall (HTTP-Upgrade durch jeden Proxy) |
| **WebTransport (HTTP/3/QUIC, unreliable Datagrams + Streams)** | **Baseline seit März 2026**: Chrome 97+, Edge 98+, Firefox 114+, **Safari/iOS erst 26.4** (Release 24.03.2026), global ~88 % ([caniuse](https://caniuse.com/webtransport), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport), [WebKit-Blog](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/)) | **Node: nicht in Core** (nur QUIC-Primitive, experimentell ⚠️); Polyfill [@fails-components/webtransport](https://github.com/fails-components/webtransport); **Deno 2.2+: experimentell** hinter `--unstable-net` ([Deno-Beispiel](https://docs.deno.com/examples/web_transport/), [PR #27431](https://github.com/denoland/deno/pull/27431)) | ❌ braucht UDP/QUIC bis zum Prozess; typische Free-Tier-Proxys terminieren nur HTTP/TCP. Selbst bei UDP-fähigen Hostern Sonderregeln, z. B. Fly.io: dedizierte IPv4 nötig, Bind an `fly-global-services`, gleicher Port intern/extern ([Fly-Docs](https://fly.io/docs/networking/udp-and-tcp/)) |
| **WebRTC DataChannel (unreliable/unordered möglich)** | ~97 % ([caniuse RTCPeerConnection](https://caniuse.com/rtcpeerconnection), Safari seit 11) | Server braucht ICE/DTLS/SCTP-Stack (node-datachannel/geckos.io ⚠️ nicht geprüft) | ⚠️ UDP-Problematik wie oben; TURN-Fallback = TCP |

Gaffers Urteil zu WebRTC für Client-Server: Der Stack (ICE/STUN/TURN, DTLS, SCTP) ist für dedizierte Server mit öffentlicher IP unnötig komplex; er zitiert den agar.io-Entwickler: „I feel what is needed is a UDP version of WebSockets“ ([ebd.](https://gafferongames.com/post/why_cant_i_send_udp_packets_from_a_browser/)). Genau das ist WebTransport heute — aber die Server- und Hosting-Seite hinkt nach: Colyseus' WebTransport-Transport ist offiziell „Experimental — This WebTransport implementation hasn't been battle tested“ ([Colyseus-Docs](https://docs.colyseus.io/server/transport/webtransport)).

### Was bringt Unreliable-Transport diesem Spiel real?

Wenig. Droppable sind nur **Positions-Snapshots** (neuere ersetzen ältere). **Richtungswechsel, Trail-Events, FILL, Tod/Kill, Chunks** müssen zuverlässig und geordnet ankommen — man baut also auch mit WebTransport einen Reliable-Kanal daneben. Der reale TCP-Nachteil beschränkt sich auf Verlust-Episoden (v. a. Mobilfunk): Ein verlorenes Segment staut Folge-Updates für ~1 RTT; bei 20 Hz und EU-RTTs (siehe Abschnitt 6: 4G ~18–23 ms median) heisst das gelegentlich 2–3 Updates auf einmal — mit Interpolations-/Glättungspuffer kaum sichtbar. Gegenmassnahmen auf TCP: kleine Pakete, Nagle aus, keine Riesen-Backlogs (Backpressure überwachen und Verbindung notfalls resetten).

### Empfehlung

**Beide Varianten: WebSocket für Phase 1.** Begründung: universeller Browser-Support inkl. alter iOS-Geräte (WebTransport erst ab iOS 26.4, März 2026 — ein relevanter Anteil der Mobilgeräte ist im Juli 2026 noch darunter; caniuse: ~88 % global), Serverseite in Node stabil, kompatibel mit jedem Gratis-Hoster (nur HTTP nötig — relevant für Ticket 03). Die Continuous-Variante profitiert *etwas* mehr von unreliable Datagrams (häufigere Snapshots), ändert die Empfehlung aber nicht. **Architektur-Konsequenz:** Transport hinter einem schmalen Interface (`send(bytes)`, `onMessage`) kapseln, damit WebTransport (mit WS-Fallback) später ein Add-on ist, kein Umbau.

---

## 4. Wire-Format

### Referenz: das splix-Binärprotokoll

splix nutzt handgebaute Binärnachrichten über WebSocket: „All messages are send as Uint8Array“, Byte 0 = uint8-Pakettyp, Koordinaten als uint16 (Kartengrösse Default 600) — [Protocol.md (Reverse Engineering)](https://github.com/JosefKuchar/Splix.io-Protocol/blob/master/Protocol.md). Der offizielle Server bestätigt und präzisiert ([WebSocketConnection.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/WebSocketConnection.js)):

- `PLAYER_POS/PLAYER_STATE` (S→C): uint16 x, uint16 y, uint16 playerId (+ Richtung/Trail-Flag) — **7 Byte** für ein Positionsupdate.
- `FILL_RECT` (S→C): uint16 x, y, w, h + uint8 tileType + uint8 patternId + uint8 isEdgeChunk = **12 Byte pro Rechteck** — die gesamte Flächenübernahme kommt als Liste solcher Rechtecke. Der Server hat dafür eine generische Rechteck-Kompression: „instead of sending which tiles have been filled, you can send the rectangles that have been filled“ (`compressTiles`, [util.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/util/util.js)).
- `CHUNK_OF_BLOCKS` (S→C): Kartenausschnitt beim Betreten neuer Bereiche („Each tile is sent individually with no form of compression, so the message could be quite big“ — Code-Kommentar; hier wäre RLE ein einfacher Gewinn).
- `UPDATE_MY_POS` (C→S): **6 Byte** pro Richtungswechsel (Abschnitt 1).
- Area of Interest: Events nur im Viewport-Rechteck um den Spieler (`UPDATES_VIEWPORT_RECT_SIZE = 25`), Karten-Nachladen in 5er-Randchunks, `REMOVE_PLAYER` beim Verlassen des Viewports; Minimap als Viertel alle 250 ms, Leaderboard alle 3 s ([config.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/config.js), [WebSocketConnection.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/WebSocketConnection.js)).

### Format-Optionen im Vergleich

| Format | Grösse | CPU | Schema/Tooling | Eignung |
|---|---|---|---|---|
| **JSON** | ~5–8× Binär (Beispiel: Positionsupdate `{"t":2,"id":17,"x":345,"y":210}` ≈ 30–40 Byte vs. 7 Byte) | Stringify/Parse, GC-Druck | überall, debugbar | Lobby/Meta ok, Hot Path nein |
| **Eigenes Binärformat (DataView)** | minimal (s. o.) | minimal | Handarbeit, Versionierung selbst | ✅ Hot Path; splix-erprobt |
| **MessagePack** | „It's like JSON. but fast and small“; kleine Ints = 1 Byte ([msgpack.org](https://msgpack.org/)) | gut | schemalos, viele JS-Libs | guter Mittelweg, trägt aber Feldnamen mit ⚠️ |
| **CBOR** | vergleichbar msgpack ([RFC 8949](https://www.rfc-editor.org/rfc/rfc8949)) | gut | IETF-Standard | wie msgpack |
| **FlatBuffers** | kompakt, Zero-Copy-Zugriff ([flatbuffers.dev](https://flatbuffers.dev/)) ⚠️ | sehr gut lesend | Schema-Compiler-Toolchain | Overkill für dieses Nachrichtenvolumen |
| **Colyseus-Schema** | binäres Delta-Encoding, nur Änderungen; max. 64 synchronisierte Properties pro Schema-Klasse; `StateView` für Interest Management ([docs](https://docs.colyseus.io/state/schema)) | gut | an Colyseus-SDK gebunden | ✅ wenn Colyseus gesetzt ist |

### Rechenbeispiel Bandbreite (600×600, 10–100 Spieler)

- **Vollstate ist tabu:** 600×600 = 360 000 Zellen; schon 1 Byte/Zelle wären 360 KB pro Sync (als JSON ein Mehrfaches). Darum: initial nur AoI-Chunks (z. B. 40×40 ≈ 1,6 KB roh, mit Rechteck-/RLE-Kompression deutlich weniger), danach ausschliesslich Deltas (`FILL_RECT`, Trail-Punkte, Chunk-Nachladen am Viewport-Rand) — exakt das splix-Modell.
- **Grid, Downstream pro Client:** ~15 sichtbare Spieler × 7 Byte × 20 Hz = **2,1 KB/s (~17 kbit/s)** als obere Schranke, wenn jede Position jeden Tick ginge. Da Bewegung zwischen Turns vorhersagbar ist, reicht ereignisbasiert (Turn-Meldungen + periodische Korrektur): realistisch **wenige hundert Byte/s**, plus Fill-Bursts (eine grosse Übernahme = einige Dutzend Rechtecke à 12 Byte < 1 KB) und Minimap/Leaderboard im Hintergrundtakt.
- **Continuous, Downstream pro Client:** Snapshots pro Tick nötig: 15 × ~9 Byte (id, x, y quantisiert, heading) × 20–30 Hz ≈ **2,7–4 KB/s**, plus Trail-Polylinien (Stützpunkte statt 4-Byte-Eckpunkte). Grössenordnung **5–10× Grid**, absolut immer noch harmlos (< 40 kbit/s) — auch für Mobilfunk.
- **Upstream:** Grid ≈ 6 Byte pro Richtungswechsel (~1–2/s). Continuous: Lenk-Inputs mit Sequenznummer, ~10–20 Hz × ~8 Byte ≈ 100–160 B/s. Beides vernachlässigbar.
- **Fazit:** Bandbreite ist bei 10–100 Spielern **kein** Entscheidungskriterium; Binärformat lohnt sich trotzdem wegen CPU/GC (kein JSON-Parse im 20-Hz-Pfad), kleiner Funkpakete auf Mobile und weil AoI/Delta-Struktur ohnehin gebraucht wird.

**Empfehlung (beide Varianten):** Binäres Nachrichtenformat über `DataView` mit uint8-Typ + uint16-Koordinaten nach splix-Vorbild; Fill als Rechteck-Deltas; AoI-Viewport mit Chunk-Nachladen; JSON nur ausserhalb des Spiel-Loops. Mit Colyseus: Schema für Entity-State + `StateView` fürs Interest Management; grosse Grid-Deltas eher als eigene Binärnachrichten statt als Schema-Arrays (64-Property-Limit, Array-Delta-Overhead) ⚠️ *(Colyseus' Raw-Byte-Messaging im Detail nicht verifiziert)*.

---

## 5. Bibliothek vs. selbst bauen

### Colyseus (geprüft)

- **Lizenz:** MIT ([LICENSE](https://github.com/colyseus/colyseus/blob/master/LICENSE), © Endel Dreyer). Self-Hosting frei; [Colyseus Cloud](https://docs.colyseus.io/deployment) als bezahltes Managed Hosting („Consider using Colyseus Cloud to easily deploy and scale“ — Docs-Hinweis).
- **Modell:** Room-basiert; `onCreate/onJoin/onLeave/onMessage`; State serverseitig als Schema, automatische binäre Delta-Syncs mit `patchRate` (Default 50 ms), Spiel-Loop via `setSimulationInterval` (Default 16,6 ms) ([Room-Docs](https://docs.colyseus.io/room), [Schema-Docs](https://docs.colyseus.io/state/schema)). „Endlose Arena ohne Matchmaking“ passt trotzdem: ein (oder wenige) langlebige Rooms; das Matchmaking degeneriert zu „joinOrCreate“.
- **Testbarkeit:** [@colyseus/testing](https://docs.colyseus.io/tools/unit-testing) bietet headless Room-Tests ohne echtes Netz (`boot`, `createRoom`, `connectTo`, `waitForNextPatch`, `waitForNextSimulationTick`; Mocha/Jest/Vitest) — geprüft, existiert und ist genau für diesen Zweck gebaut.
- **Transports:** WebSocket (`ws`) Default, uWebSockets.js-Option, WebTransport experimentell ([Transport-Docs](https://docs.colyseus.io/server/transport), [WebTransport-Docs](https://docs.colyseus.io/server/transport/webtransport)) — deckt die Empfehlung aus Abschnitt 3 ab.
- **Skalierung:** Mehrprozess braucht Redis (Presence/Driver) und **pro Prozess eine öffentlich erreichbare Adresse** (`publicAddress`; Client verbindet nach Seat-Reservation direkt zum Zielprozess — keine klassischen Sticky Sessions, aber Multi-Port-Exposition) ([Scalability-Docs](https://docs.colyseus.io/scalability)). Auf Free-Tiers mit genau einem exponierten Port ist das mühsam — für Phase 1 (ein Prozess) irrelevant, für später ein echter Constraint. **Hosting selbst ist Ticket 03 und wird hier nicht entschieden**; festzuhalten ist nur: ein einzelner Node-Prozess mit WebSocket läuft auf praktisch jedem Free-Tier, Colyseus-Multiprozess und alles UDP-basierte nicht ohne Weiteres.
- **Lock-in:** Schema-Encoding + Client-SDK sind proprietär (MIT, aber eigenes Format); Wechsel weg von Colyseus heisst State-Sync neu bauen. Wer die Sim sauber trennt (s. u.), begrenzt den Schaden auf die Sync-Schicht.

### Selbst bauen (ws / uWebSockets.js)

- `ws` ist der Standard; **uWebSockets.js** (C++-Addon, Apache-2.0, Install direkt von GitHub statt npm, Performance-Claims „10x that of Socket.IO“ — [Repo](https://github.com/uNetworking/uWebSockets.js)) lohnt erst bei sehr vielen Verbindungen; für 10–100 Spieler reicht `ws` locker.
- Der entscheidende Punkt: **Mit [jespertheend/splix](https://github.com/jespertheend/splix) (MIT, Deno, Monorepo mit `client/`, `gameServer/`, `shared/`) existiert eine produktiv betriebene Referenz genau dieses Spiels** — Tick-Loop, Undo-Fairness, AoI, Rechteck-Deltas, Worker-Flood-Fill sind ablesbar (und dank MIT sogar übernehmbar). Das senkt das Eigenbau-Risiko für die Grid-Variante drastisch. Für Continuous gibt es keine solche 1:1-Vorlage; dort spart Colyseus mehr (Snapshot-Sync ist generischer).
- Eigenbau heisst selbst verantworten: Reconnection-Handling, Rate-Limiting (splix hat `SocketRateLimiter`), Backpressure, Protokoll-Versionierung (splix: `PROTOCOL_VERSION`-Handshake), Monitoring.

### Andere Frameworks

Nakama (Heroic Labs, Go-Server mit TS-Runtime-Modulen) und ähnliche Suiten (Playroom, Hathora …) zielen auf Matchmaking/Accounts/Leaderboards-Komplettpakete; für eine einzelne endlose Arena mit eigener Sim bringen sie v. a. Betriebs-Komplexität. ⚠️ Nicht im Detail geprüft, nur der Vollständigkeit halber erwähnt.

### Empfehlung

**Unabhängig von der Wahl: Simulation als reines TS-Paket ohne Netz-/Framework-Abhängigkeit** (`step(state, inputs) → state` + Events), headless per Vitest testbar; Transport und Sync als dünne Adapter. Dann gilt:

- **Grid-Variante:** Eigenbau auf `ws` + splix-artiges Binärprotokoll ist die schlankeste, lock-in-freie Lösung mit vorhandener Referenz; Colyseus ist die bequeme Alternative, wenn man Rooms/Reconnect/Testing-Gerüst geschenkt haben will. Leichte Präferenz Eigenbau — das Protokoll ist klein (~20 Nachrichtentypen) und die Sim ist der eigentliche Kern.
- **Continuous-Variante:** Leichte Präferenz Colyseus — kontinuierlicher Entity-State passt gut auf Schema-Delta-Sync + `StateView`, und der gesparte Sync-Code ist hier grösser. Eigenbau bleibt vertretbar, addiert aber zum ohnehin höheren Prediction-/Interpolationsaufwand noch die Sync-Schicht.

---

## 6. Latenz-Toleranz

### Grössenordnungen (belegt, Stand 2025/2026)

- **Mobilfunk (UK, crowdsourced von Opensignal für Ofcom, Okt 2024–März 2025):** „Average response times (latency) for the MNOs ranged from 15 to 21 milliseconds (ms) for 5G … from 18ms to 23ms for 4G“; 5G-Median 18,2 ms, 4G-Median 21,1 ms ([Ofcom Mobile Matters 2025](https://www.ofcom.org.uk/siteassets/resources/documents/research-and-data/telecoms-research/mobile-matters/2025/mobile-matters-2025.pdf), Zahlen zitiert nach [ISPreview](https://www.ispreview.co.uk/index.php/2025/07/ofcom-study-examines-uk-speed-and-coverage-of-4g-and-5g-mobile-networks.html), da die Ofcom-Seite Bot-Zugriffe blockt ⚠️). Das sind Mediane zu nahen Messendpunkten — **Jitter und Tail-Latenzen liegen im Mobilfunk deutlich darüber** (Grössenordnung, nicht einzeln belegt ⚠️); zur historischen Einordnung: 2019 erreichten nur 13 von 87 Ländern eine durchschnittliche 4G-„Latency Experience“ unter 40 ms ([Opensignal-Report 2019](https://www.opensignal.com/reports/2019/05/global-state-of-the-mobile-network)).
- **Festnetz innerhalb EU zu EU-Server:** typischerweise ~10–40 ms RTT ⚠️ (Erfahrungswert, keine Primärquelle gefunden; konsistent damit, dass Mobilfunk-Mediane bereits ~20 ms erreichen).
- **Budget-Annahme fürs Design: RTT 20–80 ms normal, Spikes bis einige hundert ms auf Mobilfunk.**

### Was toleriert das Genre?

Sehr viel — der belegte Beweis ist splix selbst: `MAX_UNDO_EVENT_TIME = 600` ms ist laut Code-Kommentar „essentially the max ping we allow the player to have before they start having a bad time“, und `MAX_UNDO_TILE_COUNT = 5` ist so gewählt, dass „clients need more than 500ms ping in order to not be able to control themselves“ ([config.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/config.js)). Ein Spiel, das bis ~500 ms Ping spielbar bleibt, ist mit EU-RTTs von 20–80 ms komfortabel unterwegs.

### Kaschier-Techniken nach Variante

**Grid: Der Zell-Übergang ist ein natürlicher Latenz-Puffer.** Richtungswechsel wirken ohnehin erst an einer Zellgrenze; bei 6 Zellen/s dauert eine Zelle ~167 ms. Der Client sendet „Turn ab Zelle (x,y)“ (splix `UPDATE_MY_POS`, 6 Byte) — solange die Nachricht innerhalb des Undo-Fensters eintrifft, führt der Server den Turn *exakt an der gewünschten Zelle* aus, notfalls durch Zurückversetzen um bis zu 5 Zellen inkl. Ereignis-Undo ([PlayerEventHistory.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/gameplay/PlayerEventHistory.js)). Effekt: Für den Handelnden fühlt sich das Spiel latenzfrei an, ohne klassisches Rollback im Client. Remote-Spieler: Extrapolation + Ping/2-Projektion + Lerp-Glättung nach splix-Client-Vorbild ([main.js](https://github.com/jespertheend/splix/blob/master/client/src/main.js)); alternativ konservativer mit 1 Snapshot Interpolationsdelay (~50 ms bei 20 Hz) nach [Gambetta III](https://www.gabrielgambetta.com/entity-interpolation.html) — Extrapolation zeigt Turns früher, Interpolation zeigt sie weicher und nie falsch. Input-Delay als Technik braucht es nicht; die Zell-Quantisierung *ist* der Puffer.

**Continuous: Prediction statt Puffer.** Eigene Lenkung sofort lokal anwenden (sonst fühlt sich Steuern bei 50+ ms RTT teigig an), Reconciliation per Sequenznummern ([Gambetta II](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)), Restfehler visuell über abklingende Error-Offsets glätten ([Gaffer, State Synchronization](https://gafferongames.com/post/state_synchronization/)). Remote-Spieler zwingend mit Snapshot-Interpolation 1–2 Updates hinter Serverzeit — Valves Default ist ein 100-ms-Lerp bei 20 Snapshots/s („Source defaults to an interpolation period ('lerp') of 100-milliseconds (cl_interp 0.1); this way, even if one snapshot is lost, there are always two valid snapshots to interpolate between“ — [Valve](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)). Ein reines Input-Delay (à la [Deterministic Lockstep](https://gafferongames.com/post/deterministic_lockstep/) mit Playout-Buffer) wäre die einzige prediction-freie Alternative, kostet aber konstant fühlbare Verzögerung — für ein Steer-Spiel die schlechtere Wahl.

### Todes-/Kill-Fairness: Wer stirbt beim Trail-Schnitt?

Grundsatz beide Varianten: **Der Server entscheidet allein**, auf seiner Zeitachse — Clients zeigen Tode erst nach Server-Bestätigung an (splix rendert dafür eine Todesanimation erst auf `PLAYER_DIE` und kann sie mit `UNDO_PLAYER_DIE` zurücknehmen).

- Das splix-Modell ist ein „**favor the mover**“: Wer rechtzeitig (innerhalb 600 ms/5 Zellen) abgebogen *hätte*, dessen Tod bzw. dessen verursachter Kill wird rückgängig gemacht — auch wenn andere Clients den Tod schon gesehen haben ([PlayerEventHistory.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/gameplay/PlayerEventHistory.js), [WebSocketConnection.js](https://github.com/jespertheend/splix/blob/master/gameServer/src/WebSocketConnection.js) `UNDO_PLAYER_DIE`). Das ist das Genre-Gegenstück zu Valves „favor the shooter“ und teilt dessen Grundsatz-Trade-off: Irgendeine Partei sieht immer eine „unfaire“ Revision der Vergangenheit; Gambetta zu Lag Compensation: „It is somewhat unfair“, aber die Alternative wäre schlimmer ([Gambetta IV](https://www.gabrielgambetta.com/lag-compensation.html)). Empfehlung Grid: Modell übernehmen, Fenster eher enger fassen (z. B. 300–400 ms), da EU-only; sichtbare Kill-Reverts sind selten, aber als UI-Fall (Banner zurückziehen) einzuplanen.
- **Angreifer schneidet Trail vs. Verteidiger erreicht sein Gebiet:** Der Server wertet auf seiner Zeitachse aus, ob der Verteidiger die schützende Zelle vor dem Schnitt erreicht hat; das Undo-Fenster gibt beiden Seiten ihre In-Flight-Inputs. Bei echten Gleichständen (gleicher Tick) braucht es eine dokumentierte Hausregel — splix-artige Spiele töten bei Frontalkollision üblicherweise den, der in den Trail *fährt*; Kopf-an-Kopf ist als expliziter Sonderfall zu definieren ⚠️ (Designentscheid, keine Quelle).
- **Continuous:** Gleiche Prinzipien, aber teurer: Der Server braucht eine Positions-/Trail-Historie (Valve: „history of all recent player positions for one second“) und muss verspätete Lenk-Inputs gegen vergangene Segmentlagen prüfen; ein Ereignis-Undo über Float-Geometrie (Teil-Polygone zurücknehmen) ist deutlich fehleranfälliger als das Zurücksetzen von Integer-Zellen — ein wesentlicher Teil des 2–3×-Mehraufwands.

---

## Verifikationsstatus

### Per Primärquelle verifiziert

- **Gambetta I–IV** (alle vier Artikel gelesen): autoritativer Server, Prediction/Reconciliation mit Sequenznummern, Entity-Interpolation (100-ms-Beispiel), Lag Compensation inkl. „somewhat unfair“-Trade-off.
- **Gaffer on Games**: Fix Your Timestep (Akkumulator, Spiral of Death), Deterministic Lockstep (Bit-Exaktheit, Floating-Point-Probleme), State Synchronization („approximate and lossy“, Error-Offset-Glättung), „Why can't I send UDP packets from a browser?“ (Head-of-Line-Blocking, WebRTC-Komplexität, agar.io-Zitat).
- **splix**: [Protocol.md](https://github.com/JosefKuchar/Splix.io-Protocol/blob/master/Protocol.md) (Binärformat, uint16, Default-Map 600) **plus offizieller Quellcode** [jespertheend/splix](https://github.com/jespertheend/splix) (MIT): 50-ms-Tick, `PLAYER_TRAVEL_SPEED` 6 Zellen/s, Undo-System (600 ms / 5 Zellen, `UNDO_PLAYER_DIE`), Worker-Flood-Fill auf Maske, `FILL_RECT` 12 Byte, `UPDATE_MY_POS` 6 Byte, AoI-Viewport 25/Chunks 5, Minimap 4×250 ms, Client-Extrapolation + Ping/2 + Lerp. Wo Protocol.md (Reverse Engineering, teils lückenhaft) und offizieller Code differieren, gilt der Code.
- **WebTransport-Support Juli 2026**: [caniuse](https://caniuse.com/webtransport) (Chrome 97+, Edge 98+, Firefox 114+, Safari/iOS 26.4, ~88 % global), [WebKit-Blog zu Safari 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/) (Release 24.03.2026), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport) (Baseline seit März 2026). WebRTC: [caniuse RTCPeerConnection](https://caniuse.com/rtcpeerconnection) (~97 %, Safari 11+).
- **Colyseus**: patchRate 50 ms / setSimulationInterval 16,6 ms ([Room](https://docs.colyseus.io/room)), Schema/64-Property-Limit/StateView ([Schema](https://docs.colyseus.io/state/schema)), headless Testing ([@colyseus/testing](https://docs.colyseus.io/tools/unit-testing)), Deployment/Scalability (Redis, publicAddress; [Deployment](https://docs.colyseus.io/deployment), [Scalability](https://docs.colyseus.io/scalability)), experimenteller WebTransport-Transport auf @fails-components ([Docs](https://docs.colyseus.io/server/transport/webtransport)), Lizenz MIT ([LICENSE](https://github.com/colyseus/colyseus/blob/master/LICENSE)).
- **Valve Source Networking** (via Wayback-Snapshot der Original-Wiki-Seite): 66,6 Ticks/s (15 ms), Source 2 64-Tick/Sub-Tick, 20 Snapshots/s Default, cl_interp 0.1 = 100 ms, Lag-Compensation-Formel und 1-s-Historie.
- **uWebSockets.js** (Apache-2.0, GitHub-Install, Performance-Claims laut README), **OpenFrontIO** (AGPL-3.0, `src/core` = „deterministic game simulation“), **msgpack.org** (Tagline, 1-Byte-Ints), **MDN Math** (Implementierungsabhängigkeit wörtlich), **Deno WebTransport** (experimentell, `--unstable-net`; Deno-Docs + PR), **Fly.io-UDP-Randbedingungen** (dedizierte IPv4, `fly-global-services`).

### ⚠️ Unsicher / nicht (voll) verifiziert

- **Ofcom-Latenzzahlen**: Ofcom-Website und PDF blockten den Abruf (Bot-Schutz); die Zahlen (4G 18–23 ms, 5G 15–21 ms, Median 21,1/18,2 ms) sind über [ISPreview](https://www.ispreview.co.uk/index.php/2025/07/ofcom-study-examines-uk-speed-and-coverage-of-4g-and-5g-mobile-networks.html) und Presse-Wiedergaben des Reports zitiert; zudem UK-Messwerte, nicht EU-weit, und gemessen zu nahen Endpunkten (reale Spielserver-RTT liegt höher).
- **EU-Festnetz-RTT 10–40 ms** und **Mobilfunk-Jitter/Tail-Latenzen**: Erfahrungswerte/Plausibilität, keine Primärquelle gefunden.
- **Node.js-QUIC/WebTransport-Status**: „nicht in Core, `node:quic` experimentell“ stammt aus Blogposts/Suche (u. a. James Snell), nicht aus offiziellen Node-Docs geprüft.
- **Free-Tier-Fähigkeiten konkreter Hoster** (Render/Railway etc. bzgl. UDP/HTTP/3): nicht geprüft — gehört zu Ticket 03; verifiziert ist nur Fly.io-UDP als Beispiel für die Sonderregeln.
- **Colyseus Raw-Binary-Messaging** (`sendBytes` o. ä.): nicht verifiziert.
- **FlatBuffers/CBOR-Details**: nur offizielle Referenzen benannt, nicht inhaltlich geprüft; ebenso **Nakama**, **geckos.io/node-datachannel**.
- **Aufwandsfaktor 2–3×** (Continuous vs. Grid) und Design-Aussagen zu Kopf-an-Kopf-Kollisionen: begründete Einschätzungen, keine messbaren Quellen.
- **Protocol.md-Lücken**: FILL_AREA/CHUNK_OF_BLOCKS/SET_TRAIL sind dort ohne Feldstruktur dokumentiert; die hier genannten Layouts stammen aus dem offiziellen Servercode (dessen `SendAction`-Nummern mit Protocol.md übereinstimmen, Nachrichten 22–24 sind neuer und dort nicht enthalten).
