# 15 — Abuse-/Ressourcen-Schutz

**What to build:** Die billigen, server-seitigen Ressourcen-Deckel, die die *eine* Gratis-Arena verfügbar halten (Leitprinzip **Verfügbarkeit zuerst** — Integritäts-Cheating ist durch die Server-Autorität schon strukturell erledigt; die Intent-only-Validierung liegt bereits in Ticket 03). Flood-/Rate-Schutz pro Verbindung, Pro-IP-Deckel, die harte **Arena-Populationsgrenze** und ein Raum-Erstellungs-Rate-Limit.

**Blocked by:** 02, 14.

**Status:** resolved (2026-07-31)

- [x] Flood/Rate pro Verbindung: eine wirksame Eingabe pro Spieler pro Tick (Coalescing der *letzten* Intent), Frame-Größen-Cap **vor** dem Parsen, Trennung bei anhaltendem Flood/Garbage nach kleinem Toleranzfenster.
- [x] Pro-IP-Deckel via `CF-Connecting-IP` am Router-Worker: max. gleichzeitige Verbindungen/IP (~16, großzügig & CGNAT-/Shared-WLAN-tolerant), Join-Rate/IP gegen Reconnect-Spam + Raum-Code-Brute-Force.
- [x] **Arena-Populationsgrenze**: harter Cap gleichzeitiger Spieler (Wert ← Ticket 02); Menschen zuerst, Bots nur freie Slots; bei Erreichen saubere „Arena voll"-Abweisung — **keine** Queue, **kein** Auto-Sharding.
- [x] Raum-Erstellung pro IP raten-begrenzt (falls nicht schon in Ticket 14 vollständig abgedeckt).
- [x] Schwellen als abstimmbare Konstanten (neben `BALANCE`), in der Implementierung kalibriert.
- [x] Szenario-Tests: Flood → Drop/Trennung; „Arena voll" → saubere Abweisung.
- [x] CI grün inkl. Coverage (§9.7).

_Referenz: spec §8.1–8.3, §7.2._

## Answer

Vier Deckel, jeder dort, wo seine Wahrheit liegt — und ein Limiter, der im Zweifel durchlässt.

**1. Frame-Budget pro Verbindung** (`server/flood.ts`, verdrahtet in `arena-do.ts`).
`LIMITS.framesPerWindow` = 40 Frames/s pro Socket; der Überschuss wird verworfen, und wer es
`floodKillWindows` = 3 Fenster lang durchhält, verliert den Socket (1008 „input flood").
Fixes Fenster, dieselbe Form wie das Raum-Budget aus Ticket 14 — ein Datensatz pro Socket,
kein Timer, nachvollziehbarer Worst Case. Der Streak ist nötig, weil ein reines „droppen"
einen Flood gratis machen würde und ein Kill beim ersten Überschuss-Frame jeden Client
abwürgen würde, der nach einem Stall nachspült.

Entscheidend ist der **Ort**: die Prüfung sitzt in `webSocketMessage`, **vor** Dekodieren und
Spieler-Lookup. Genau diese Arbeit ist es, die ein Flood auf einem single-threaded DO kostet;
hinter dem Decoder wäre der Deckel eine Statistik, keine Verteidigung. Nebeneffekt: sie deckt
auch Sockets, die (noch) keine Spieler sind — ein Raum-Lobby-Socket, den `ArenaCore` nie sieht.

Zwei Teile des Häkchens waren schon da und sind nachgeprüft statt neu gebaut: das
**Coalescing** („eine wirksame Eingabe pro Tick") liegt im Tick-Mapping aus Ticket 17 — pro
Tick wird genau der ihm zugeordnete Intent angewandt —, und der **Frame-Größen-Cap vor dem
Parsen** ist `MAX_CLIENT_FRAME_BYTES` in `protocol/messages.ts`, erste Zeile von
`decodeClientMessage`. Die **Müll-Schwelle** (`garbageKillThreshold`) existierte ebenfalls; neu
ist, dass beide Reaktionen jetzt szenario-getestet sind.

**2. Arena-Populationsgrenze = 16** (`LIMITS.maxPlayers`, vorher implizit die CPU-Decke 64).
Der Wert ist der Startwert, den [der DO-CPU-Benchmark](../../../docs/benchmarks/do-cpu-benchmark.md)
aus Ticket 02 empfiehlt: gameplay-motiviert (die 200-WU-Arena ist für ~15 Entities
dimensioniert), nicht CPU-motiviert. `maxConnections` = 64 bleibt als **Decke** stehen, über
die der Wert nie steigen darf — die u8-Spielerzahl im Snapshot ist der nicht verhandelbare
Teil dieser Zahl. „Menschen zuerst" war schon erfüllt (Bots zählen gegen das Ziel, nie gegen
die Verbindungs-Slots); die Abweisung hat jetzt einen eigenen Close-Code (`ARENA_CLOSE.full`),
den der Client in Worte übersetzt.

Dabei fiel ein Loch auf, das die Grenze angreifbar machte: gezählt werden **Verbindungen**,
und ein Socket, der aufgebaut aber nie beigetreten ist, hielt seinen Slot bis zum
10-s-Idle-Sweep — der sich zudem von *jedem* gültigen Frame zurücksetzen lässt, also beliebig
lange erneuern liess. Neu ist deshalb die **Join-Frist** (`joinDeadlineTicks` = 3 s), die ab
dem Verbindungsaufbau läuft und von Verkehr *nicht* zurückgesetzt wird. Ohne sie wäre die
Populationsgrenze ein Werkzeug zum Aussperren gewesen, keine Grenze.

**3. Pro-IP-Deckel** — zwei Grenzen, absichtlich an zwei verschiedenen Orten:

- **Gleichzeitige Sockets pro Adresse** (`maxConnectionsPerIp` = 16) zählt das **Arena-DO**
  selbst, aus seinen lebenden Sockets (`getWebSockets()` + Attachment). Der Spec-Satz „Hebel =
  `CF-Connecting-IP` am Router-Worker" bleibt erfüllt: der Router *liest* die Adresse (nur dort
  ist sie vertrauenswürdig, die Edge überschreibt den Header) und stempelt sie in einen eigenen
  Header (`CLIENT_IP_HEADER`, immer `set`, nie `append` — sonst wäre ein selbst gesendeter
  Header der Weg um jeden Deckel herum). Gezählt wird aber im DO, weil ein Socket dort eine
  *Tatsache* ist: nichts kann leaken, nichts muss freigegeben werden, und keine Eviction kann
  eine Adresse aus ihrer eigenen Arena aussperren. Ein zentraler Zähler mit Auf/Ab-Buchung
  hätte genau diese drei Fehlermodi.
  Bewusste Abweichung, die dazugehört: der Deckel gilt damit **pro Arena**, nicht global —
  eine Adresse kann 16 Sockets in der öffentlichen Arena halten *und* 16 in jedem privaten
  Raum, dessen Code sie kennt. Global zu zählen hiesse Auf-/Abbuchen in einem zentralen
  Objekt, und dessen Fehlermodus (verlorene Freigabe ⇒ dauerhaft ausgesperrte Adresse) ist
  genau der, den eine Verfügbarkeits-Massnahme nicht haben darf. Die Zusatzfläche ist
  ausserdem klein: um Sockets in fremden Räumen zu halten, muss man deren Codes *kennen*,
  und selbst Räume anzulegen ist mit 5/Minute das schärfste Limit im System.
- **Join-Rate pro Adresse** (`joinPerIp` = 120 / Minute) muss dagegen **zentral** sein: ein
  Raum-Code-Brute-Force adressiert bei jedem Versuch ein *anderes* DO, also sieht nur eine
  Instanz vor allen das Muster. Sie liegt daher im Gate-DO aus Ticket 14, das genau dafür
  vorgesehen war. Geladen wird jeder `/ws`-Aufbau, auch einer, den eine Arena danach abweist —
  Reconnect-Spam und Code-Raten sind von hier aus derselbe Verkehr.

**4. Raum-Erstellung pro IP** war in Ticket 14 vollständig gebaut; hier wurde die Regel nur zu
zwei Töpfen verallgemeinert (`chargeIp(bucket, …)`, Schlüssel `create:ip:…` / `join:ip:…`), so
dass beide Budgets dieselbe Mechanik und dieselben Tests teilen.

**Betriebsentscheidung: der Limiter fällt offen.** Kann das Gate-DO nicht antworten (Neustart,
Deploy, Lastabwurf), wird durchgelassen statt abgewiesen. Spec §8.1 stellt Verfügbarkeit an
erste Stelle, und ein Rate-Limiter, der seine eigene schlechte Minute in „niemand darf
spielen" verwandelt, ist der grössere Ausfall — zumal die Deckel, die die Arena *selbst*
schützen (Population, Sockets pro Adresse, Frame-Budget), an keinem Fremd-DO hängen. Das ist
keine Theorie: es fiel in der Szenario-Suite auf, wo jeder Datei-Wechsel das Gate-DO
invalidiert und der erste Aufbau danach mit „bitte erneut versuchen" scheiterte. Aus demselben
Befund kommt der zweite Punkt — der Router **wiederholt einen Arena-Aufbau genau einmal**,
wenn das DO gerade durch neuen Code ersetzt wurde. Das passiert bei jedem Deploy, und ohne die
Wiederholung bekäme der erste Spieler danach eine kaputte Verbindung.

**Was der Pro-IP-Deckel heute (noch) nicht leistet.** `maxConnectionsPerIp` (16) fällt mit
`maxPlayers` (16) zusammen — eine Adresse kann die öffentliche Arena also allein füllen. Das
ist kein Versehen, sondern die Folge zweier Spec-Zahlen, die beide „~16" sagen: §8.3 Punkt 3
will ausdrücklich CGNAT-/WLAN-tolerant sein („im Zweifel durchlassen"), und Punkt 4 startet
bei 16, weil die Karte dafür dimensioniert ist. Der Deckel beisst damit erst, wenn die
Populationsgrenze über ihn steigt — was Ticket 02 nach Playtests ausdrücklich vorsieht. Der
Szenario-Test hält beides fest, indem er die zwei Abweisungen an ihren *verschiedenen*
Close-Codes unterscheidet und nachweist, dass die Nachbar-Adresse den freigewordenen Slot
bekommt. Notiert auch als Entscheidungspunkt für Ticket 16.

**Tests.** `flood.test.ts` und `room-gate.test.ts` (beide Töpfe über `describe.each`) prüfen die
Regeln in Node; `router.test.ts` das Stempeln der Adresse, das Laden beider Töpfe, fail-open und
die Deploy-Wiederholung; `arena.test.ts` Populationsgrenze, Decke und Join-Frist;
`close.test.ts` die eine Eigenschaft, die die Close-Code-Tabellen gemeinsam halten müssen
(disjunkt, im 4000er-Bereich). Die Choreografien liegen in
[`tests/scenario/abuse.test.ts`](../../../tests/scenario/abuse.test.ts): Flood → Drop, Flood →
Trennung, Müll → Trennung, „Arena voll" → sauberer Close-Code ohne Queue, Pro-IP-Socket-Deckel
mit unberührter Nachbar-Adresse, Join-Rate → Abweisung im Router ohne ein einziges geöffnetes
DO. Volle Suite grün: 665 Unit-Tests, 43 Szenario-Tests, 21 E2E-Tests.

**Nebenwirkung auf die Suite** (README-Regel 6 erweitert): jeder Szenario-Socket setzt jetzt
seine eigene `CF-Connecting-IP`. Ohne das hätte die ganze Suite eine Adresse geteilt und wäre
irgendwann an der Join-Rate hängengeblieben — an einem Ort, der nichts mit dem geprüften Verhalten
zu tun hat.

## Comments

**2026-07-31 — bewusst *nicht* gebaut.** Spec §8.4 verschiebt Turnstile/Proof-of-Work,
Melde-/Mute-Funktion und Schwarm-Abwehr mit ausdrücklichen Auslösern; nichts davon ist hier
angefasst. Ebenso unangetastet: die Lobby eines privaten Raums kennt keine Join-Frist (ein
Wartender ohne Namen hält einen Raum-Slot). Das ist tragbar, weil ein privater Raum ein
eigenes DO mit eigener Gnadenfrist ist — die Kosten sind ein hibernierendes DO, nicht die
öffentliche Arena.

**2026-07-31 — Namen, die stehen bleiben.** Das Gate-DO heisst weiter `RoomGateDO` mit Binding
`ROOM_GATE`, obwohl es jetzt beide Töpfe hält: eine DO-Klasse umzubenennen kostet eine
Migration auf einem laufenden Deployment, und der Gewinn wäre kosmetisch. Die Klassen-Doku sagt
das ausdrücklich.
