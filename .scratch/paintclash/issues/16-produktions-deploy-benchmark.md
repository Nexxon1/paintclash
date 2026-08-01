# 16 — Produktions-Deploy + Benchmark-Re-Konfirmation

**What to build:** Das Spiel produktiv nehmen und die provisorischen Kapazitätszahlen gegen den echten Build härten. Die öffentliche **Arena-DO** läuft always-on unter fester Adresse (EU `weur`-Hint), der statische Client kommt über Workers Static Assets, die Betriebshaltung ist explizit **best-effort** (keine Uptime-Garantie; der harte Free-Tages-Stopp ist die *gewollte* Abbuchungssicherheit). Der DO-CPU-Benchmark wird gegen den *echten* Sim wiederholt und bestätigt/korrigiert die Populationsgrenze + das Bot-Ziel aus Ticket 02.

**Blocked by:** 15.

**Status:** resolved (2026-08-01)

- [x] Öffentliche Arena = **ein** always-on DO mit fester Adresse; `weur`-Hint; statischer Client über Workers Static Assets ausgeliefert. — `ARENA_LOCATION_HINT` in `router.ts`, an **jedem** `get`. **Zwei Einschränkungen, die der Haken nicht verschweigen soll:** der Hint wirkt nur bei der *Erstellung*, die bereits existierende öffentliche Arena und das Gate bleiben also, wo sie entstanden sind (nachprüfbar ist ihre Platzierung von aussen nicht — Cloudflare legt sie nicht offen); und „always-on" ist als *feste Adresse* umgesetzt, nicht als Dauerlast (s. Answer).
- [x] Finales CD deployt den echten Stack **nur** bei grüner Pipeline (CD-Tor via `needs:`). — plus ein Nachweis-Schritt: `/api/health` muss danach **diesen** Commit ausliefern.
- [x] DO-CPU-Benchmark **gegen den echten Build** → Arena-Populationsgrenze (Ticket 15) + Bot-Ziel (Ticket 12) bestätigt oder angepasst; Ergebnis dokumentiert. — **beide bestätigt**, gegen echte Cloudflare-Hardware; [`docs/benchmarks/do-cpu-benchmark.md`](../../../docs/benchmarks/do-cpu-benchmark.md) Nachtrag 2026-08-01, Harness [`bench/prod-arena`](../../../bench/prod-arena/).
- [x] Betriebshaltung **best-effort** dokumentiert; bestätigt: Free-Plan, keine Kreditkarte, harter Tages-Stopp = kein Kostenrisiko. — [`docs/operations.md`](../../../docs/operations.md).
- [x] CI grün inkl. Coverage (§9.7) — lokal alle Gates grün: typecheck, lint, `format:check`, `build`, 689 Unit/Property, 44 Szenario (hermetisch) + 2 (Bots), 21 E2E, Coverage-Böden gehalten (`server/src` 99,5 % Zeilen, `tick-cost.ts` 100 %).

_Referenz: spec §7, §8.5, §11; ADR-0001/0004._

## Answer

Live auf <https://paintclash.secure-data.workers.dev>, und die Kapazitätszahlen sind
erstmals **gemessen** statt hochgerechnet. Die Kernpunkte:

### Es gibt in einem Produktions-DO keine Stoppuhr — auch keine indirekte

Das war der teuerste Befund und er kam als Fehlschlag. Der erste Ansatz sah aus wie eine
saubere Umgehung von Cloudflares eingefrorener Uhr: der Ticker zielt auf ein festes
50-ms-Raster, also müsste die *Verspätung* eines Ticks den Überhang des vorherigen tragen
(`late(N+1) = cost(N)`). Zwei Zeilen Arithmetik, kein zusätzliches Event pro Tick. Gegen
die deployte Arena gemessen: **6 031 von 6 031 Ticks im untersten Bucket, `observedHz`
exakt 20,00** — bei 8 Entities und 4 979 Gebiets-Vertices, also unter echter Fill-Last.

Die Uhr ist nicht bloss während synchroner Arbeit eingefroren, sie ist an den
Timer-**Fahrplan gekoppelt**: `Date.now()` liefert am Tick-Anfang genau den Slot zurück,
auf den gezielt wurde, egal was dazwischen passiert ist. Das erklärt nebenbei Ticket 17/18
(„der Ticker misst exakt 50,00 ms/Tick") — die Uhr *kann* dort nichts anderes messen.

Konsequenz im Code: der Report trägt seither ein **`clockAdvances`**, einmal pro Arena
geprüft. Das Instrument sagt zuerst, ob man ihm glauben darf. Eine strukturelle Null als
„Budget hält" zu lesen wäre der schlimmere Ausgang gewesen als gar nicht zu messen.

### Was misst: das gelieferte Tick-Defizit, von aussen

Ein überlaufender Tick verzögert den nächsten um genau seinen Überhang (der Ticker rechnet
seine Schlafzeit auf einer Uhr aus, die sich nicht bewegt hat, verschläft also immer die
volle Restzeit). **Gelieferte Snapshot-Ticks gegen das nominelle 20-Hz-Raster** sind damit
der aufsummierte Überhang — am fernen Ende der Leitung, wo weder die eingefrorene Uhr noch
einzelnes Paket-Jitter etwas verstecken kann. Zwei Läufe à 5 min gegen Produktion:

| | 8 Entities (1 Mensch + 7 Bots) | 16 Entities (Populationsgrenze) |
| --- | --- | --- |
| Vertices am Ende | 4 979 | 4 570 |
| Fills / Tode | 63\* / 0 | 1 358 / 35 |
| gelieferte Ticks in 300 s | 6 031 | 6 027 |
| Rate | **20,09 Hz** | **20,10 Hz** |
| aufsummierter Überhang | ≤ 0 ms | **−1 461 ms (−0,49 %)** |

\* nur die des einen eigenen Clients; die sieben Bots malten ungezählt mit.

**Doppelte Population, ~2,6-fache Fill-Rate, 0,01 Hz Unterschied.** Und feiner aufgelöst:
der Tick-Zähler des DO stieg im 16er-Lauf in **jedem** 30-s-Fenster um 669–670, während die
Vertices von 179 auf 4 570 wuchsen — gleichförmig auf ±0,15 %. Diese *Flachheit* ist das
eigentliche Argument: ein lastabhängiger Anteil wäre sichtbar geworden.

Das p95-Kriterium selbst ist auf Produktion **nicht direkt messbar** (dafür bräuchte es
Pro-Tick-Zeiten, die die Laufzeit verweigert); der Überhang von ≤ 0 grenzt es aber ein — auf
≈ 10 ms, selbst wenn man dem Timer 1 % Ungenauigkeit zugesteht und den ganzen Spielraum in
die langsamsten 5 % der Ticks steckt.

- **`LIMITS.maxPlayers = 16` bestätigt.** Kein einziger verlorener Tick an der Grenze.
- **Bot-Ziel 8 bestätigt.** Der Produktions-Default lief fünf Minuten sauber durch.
- **Der 4×-Hardware-Faktor ist als Worst Case widerlegt.** Wäre Produktion 4× langsamer als
  die Entwicklermaschine, würde T22s lokaler Mittelwert (1,69 ms/Tick) zu 6,8 ms — über
  6 128 Ticks **42 s** Überhang in einem 300-s-Lauf, also ~18 statt 20,1 Hz. Gemessen wurde
  kein Verlust.

### Was das Ticket *nicht* geändert hat, mit Absicht

- **Die Tick-Pacing-Schleife.** Ein erster Versuch begradigte einen Off-by-one (der erste
  und zweite Tick einer Arena feuern im selben Moment). Das ist ein echter kleiner Fehler —
  und *ein* Tick Phasenverschiebung reicht, um in `rewind.test.ts` zu entscheiden, wer wen
  zuerst erreicht: der Test wurde rot. Zurückgebaut, Messung stattdessen daneben gelegt
  (der erste Tick wird nicht mitgezählt). Ein Benchmark darf das nicht bewegen, was er
  misst; die Kadenz gehört ohnehin Ticket 18.
- **„Always-on" heisst feste Adresse, nicht Dauerlast** — und das ist eine bewusste
  Abweichung vom Wortlaut dieses Tickets, also gehört sie hierhin und nicht in eine Fussnote.
  Die Arena ist immer unter derselben Adresse erreichbar und wacht beim ersten Join auf;
  getickt wird nur, solange Sockets offen sind.

  Spec §7.2 hat für eine 24/7-Arena durchaus Budget eingeplant (~10 800 von ~13 000 GB-s/Tag,
  ~85 %) — die Aussage „sonst wären die Spieler ausgesperrt" wäre also falsch, Duration ist
  Wall-Clock und nicht pro Spieler. Der echte Grund ist ein anderer und kleiner: diese 85 %
  wären für **niemanden** ausgegeben, und was sie verdrängen, sind die privaten Räume, für
  die §7.2 nur „grob eine Handvoll aktiver Raum-Stunden/Tag" übrig lässt. Eine leere Arena
  hat niemanden zu bedienen; sie zu ticken ändert für keinen Spieler etwas ausser, dass der
  erste Ankömmling einen Tick später loslegt. ADR-0004 formuliert die Regel bisher nur für
  private Räume — sie hier mitzunehmen ist die Abweichung, und sie ist reversibel: es ist
  eine Zeile in `startTicker`.

### Datenpunkt für Ticket 18

Die dort beschriebene Anomalie (real ~22,2 Hz, Spieltempo ~11 % über Spec) **trat in diesen
Läufen nicht auf**: 20,09 und 20,10 Hz, also nominelles Tempo. Da die Rate über den ganzen
Lastbereich flach ist, lässt sich der Rest-Versatz nicht als verdeckte Tick-Arbeit
wegerklären — der Uhren-Versatz betrug an diesem Tag ~0,5 %, nicht 11 %. Ein Lauf, ein Tag,
ein Colo: der erste Eintrag der Messreihe, die Ticket 18 verlangt, mehr nicht.

### Nebenbefund: `wrangler dev` taugt nicht für Kapazitätsaussagen

Derselbe Autopilot, dieselben 16 Clients, 300 s gegen lokales `wrangler dev`: **1 892 Tode**
statt 35, 481 Fills statt 1 358, 18,1 Hz statt 20,1. Ursache sind ~3,5-s-Stalls alle ~34 s
(die GC-Stalls, die schon T02 sah) — ein blinder Kopf fährt geradeaus in fremde Trails. Für
Netcode- und Tick-Fragen ist die deployte Referenz die Wahrheit, nicht die lokale.

## Comments
