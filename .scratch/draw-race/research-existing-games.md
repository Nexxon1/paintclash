# Marktrecherche: Territorial-/Flächenfärbe-Spiele (Arbeitstitel „draw race")

Stand: 2026-07-18. Recherchiert gegen Primärquellen (offizielle Websites, App-Store-Einträge, GitHub-Repos, Engineering-Blogs). Jede Behauptung ist verlinkt; am Ende jedes Abschnitts ist markiert, was **verifiziert** ist und was **unsicher** bleibt.

---

## TL;DR (Kurzfazit)

1. **Die Kernmechanik der Idee („Trail ziehen, Loop ans eigene Gebiet anschließen, Inneres wird gefärbt") existiert seit 2016 als eigenes .io-Subgenre.** Urahn im Web ist [splix.io](https://splix.io/) (Jesper van den Ende, 2016), populärster Vertreter ist [Paper.io / Paper.io 2](https://apps.apple.com/us/app/paper-io-2/id1423046460) (Voodoo, >100 Mio. Downloads). Historischer Ursprung der Mechanik ist [Qix](https://en.wikipedia.org/wiki/Qix) (Taito, Arcade 1981) bzw. dessen Klon-Familie (Xonix, Pac-Xon) — splix.io [nennt diese selbst als Inspiration](https://splix.io/about).
2. **Der originale splix.io-Quellcode ist vollständig offen** ([github.com/jespertheend/splix](https://github.com/jespertheend/splix), MIT-Lizenz, Deno-Server + Vanilla-JS-Client, aktiv gepflegt). Das ist die mit Abstand wertvollste technische Referenz für die eigene Umsetzung — inklusive selbst hostbarem Server.
3. **Paper.io 2 ist mit hoher Wahrscheinlichkeit kein echtes Multiplayer**, sondern Singleplayer gegen Bots mit Multiplayer-Fassade (mehrere unabhängige Analysen; von Voodoo nie offiziell bestätigt). Echtes Server-Multiplayer in diesem Genre bieten splix.io, Superhex.io, Defly.io, Tileman.io.
4. **Territorial.io ist eine andere Mechanik** (prozentuale Truppen-Attacken auf Nachbargebiete, kein Trail) — relevant vor allem wegen des Open-Source-Nachfolgers [OpenFront.io](https://github.com/openfrontio/OpenFrontIO) (TypeScript, AGPLv3, 2,4k Stars).
5. **Lücke:** Ein *persistenter*, *großer gemeinsamer* Canvas mit Loop-Färbe-Mechanik und Fokus auf **Flächenanteil statt Kill/Survival** existiert so nicht 1:1. Alle Genre-Vertreter sind sessionbasiert (Tod = Gebietsverlust, Server-Reset), die persistenten Canvas-Projekte (r/place, pixelplace.io) haben keine Verbindungs-/Loop-Mechanik. Am nächsten dran: Tileman.io mit seinem „No Kills"-Modus.
6. **Namenskollision:** „DrawRace" ist eine etablierte Mobile-Racing-Serie von [RedLynx (Ubisoft)](https://en.wikipedia.org/wiki/DrawRace) — der Arbeitstitel sollte vor Veröffentlichung geändert oder markenrechtlich geprüft werden.
7. **Geld verdienen diese Spiele hauptsächlich mit Werbung:** Am oberen Ende steht Voodoo (Paper.io-Serie, Hypercasual-Ads + „Ad-Free"-IAP; Firma 2020 mit [1,4 Mrd. $ bewertet](https://techcrunch.com/2020/08/17/tencent-takes-minority-stake-in-french-casual-games-maker-voodoo/)) und der Genre-Nachbar slither.io mit [berichteten >100 000 $ Werbeeinnahmen pro Tag (2016)](https://www.digitaltrends.com/gaming/viral-app-slither-pulls-100k-per-day/). Am unteren Ende steht splix.io selbst: heute Open Source + [Patreon mit ~130 Unterstützern](https://www.patreon.com/splix) — Hobby-Größenordnung. Der realistische Weg für neue Browser-Titel ist Portal-Revenue-Share ([Poki: 50/50 bei Poki-Traffic, 100 % bei Eigen-Traffic](https://sdk.poki.com/index.html)); der Hypercasual-Mobile-Markt konsolidiert [seit 2022 stark](https://sensortower.com/blog/state-of-mobile-gaming-2024). Details in Abschnitt 6.

---

## 1. Spieleübersicht

| Spiel | Jahr | Entwickler | Mechanik-Typ | Loop-Färbe-Mechanik? | Echtes Online-MP? | Quelle |
|---|---|---|---|---|---|---|
| Qix | 1981 | Taito (US) | Linien vom Rand ziehen, Fläche einschließen | Ja (Vorläufer, Singleplayer) | Nein (Arcade) | [Wikipedia](https://en.wikipedia.org/wiki/Qix), [arcade-history](https://www.arcade-history.com/?n=qix&page=detail&id=2096) |
| splix.io | 2016 | Jesper van den Ende | Grid, Trail + Loop schließen | **Ja (Referenz)** | Ja | [splix.io/about](https://splix.io/about), [GitHub](https://github.com/jespertheend/splix) |
| Paper.io | 2016 | Voodoo | Grid, Trail + Loop | Ja | Zweifelhaft (Bots) | [App Store](https://apps.apple.com/us/app/paper-io/id1171814682) |
| Hexar.io | ~2016/17 | MochiBits, LLC | Hex-Grid, Einschließen | Ja | Unklar (mobil) | [App Store](https://apps.apple.com/us/app/hexar-io-1-in-io-games/id1175871181) |
| Superhex.io | 2017 | Exodragon Games | Hex-Grid, Trail + Loop | Ja | Ja (Browser) | [exodragon.com](https://exodragon.com/), [Fandom](https://io-games.fandom.com/wiki/Superhex.io) |
| Defly.io | ~2018 | Exodragon Games | Kontinuierlich, Wände bauen + Fläche schließen | Ja (Variante mit Schießen) | Ja (Browser) | [defly.io](https://defly.io/), [exodragon.com](https://exodragon.com/) |
| Paper.io 2 | 2018 | Voodoo | Kontinuierlich, Trail + Loop | Ja | Zweifelhaft (Bots) | [App Store](https://apps.apple.com/us/app/paper-io-2/id1423046460), [Google Play](https://play.google.com/store/apps/details?id=io.voodoo.paper2&hl=en) |
| Tileman.io | 2018 | „tiledev" | Grid, Trail + Rechteck/Loop schließen | Ja | Ja (Browser) | [tileman.io](https://tileman.io/), [CrazyGames](https://www.crazygames.com/game/tileman-io) |
| Territorial.io | 2021 | David Tschacher | Truppen-%-Attacken auf Nachbarfelder | **Nein** | Ja (bis 500 Spieler) | [territorial.io/contact](https://www.territorial.io/contact), [App Store](https://apps.apple.com/us/app/territorial-io/id1581110913) |
| Hexanaut.io | ~2022 | Exodragon Games | Hex-Grid, Einschließen | Ja | Ja (Browser) | [exodragon.com](https://exodragon.com/) |
| OpenFront.io | 2024 | Open-Source-Community | Wie Territorial.io (RTS) | Nein | Ja | [GitHub](https://github.com/openfrontio/OpenFrontIO) |
| Splatoon 1–3 | 2015–2022 | Nintendo | Shooter, Fläche mit Tinte bespritzen | Nein (Schuss statt Loop) | Ja (4v4, 3 min Runden) | [splatoon.nintendo.com](https://splatoon.nintendo.com/en/gameplay/) |
| r/place | 2017/22/23 | Reddit | 1 Pixel pro Cooldown setzen | Nein | Ja (kollaborativ) | [Fastly-Talk mit Reddit-Engineering](https://www.fastly.com/blog/reddit-on-building-scaling-rplace) |
| pixelplace.io | laufend | pixelplace.io-Team | r/place-Klon ohne Cooldown, „Pixel World War" | Nein | Ja (kollaborativ/PvP-Canvas) | [pixelplace.io](https://pixelplace.io/), [Product Hunt](https://www.producthunt.com/products/pixelplace-io) |

---

## 2. Detailanalyse der wichtigsten Titel

### 2.1 splix.io — der Referenz-Titel (und Open Source)

- **Mechanik** (laut [offizieller About-Seite](https://splix.io/about)): Bewegung per Pfeiltasten/WASD auf einem **Grid**. Im eigenen Territorium ist man sicher; verlässt man es, entsteht ein **Trail**. „If anyone hits it, you die." Umschlossene Blöcke gehen in den eigenen Besitz über („Surrounding blocks returns them to your possession"). Ziel: „conquer as much land as possible and become the biggest of them all."
- **Inspiration:** Die About-Seite nennt explizit **Qix, Xonix, Pac-Xon und Marvin the Martian Land Grab** als Singleplayer-Vorbilder — d. h. der Entwickler selbst verortet die Mechanik-Genealogie bei Qix (1981).
- **Historie/Technik:** Server liefen ursprünglich auf **C# (mono + Fleck-Library)**, heute auf **Deno**; Client ist „mostly plain old JavaScript"; Hosting auf DigitalOcean hinter nginx + Let's Encrypt ([About](https://splix.io/about), [README](https://github.com/jespertheend/splix)).
- **Release:** Browser-Version Juli 2016, Mobile-Apps September 2016 (laut [GameFAQs-Release-Daten](https://gamefaqs.gamespot.com/android/196398-splixio/data) und [App Store](https://apps.apple.com/us/app/splix-io/id1150901618); ⚠️ Tagesdatum nicht über Primärquelle verifiziert). „SPLIX.IO" ist eine [eingetragene Marke von Jesper van den Ende](https://trademarks.justia.com/792/11/splix-79211244.html).
- **Netzwerkprotokoll** (aus dem [reverse-engineerten Protokoll-Doc](https://github.com/JosefKuchar/Splix.io-Protocol/blob/master/Protocol.md)): Binäre WebSocket-Nachrichten (`Uint8Array`), 1-Byte-Packet-ID, 21 Server- / 8 Client-Pakettypen. Relevante Pakete: `UPDATE_BLOCKS`, `FILL_AREA` (Server befiehlt Flächenfüllung als Rechteck-/Block-Update — der Fill wird **serverseitig** berechnet), `CHUNK_OF_BLOCKS` (Karte kommt in Chunks), `SET_TRAIL`, `EMPTY_TRAIL_WITH_LAST_POS`. Koordinaten sind `uint16`, Standard-Kartengröße 600×600 Blöcke.
- **Verifiziert:** Mechanik, Open-Source-Status, Stack, Protokollstruktur. **Unsicher:** exakte Spielerzahl pro Instanz (nirgends offiziell dokumentiert), exaktes Release-Datum.

### 2.2 Paper.io / Paper.io 2 (Voodoo)

- **Mechanik** (laut [App Store](https://apps.apple.com/us/app/paper-io-2/id1423046460) und [Steam-Beschreibung](https://store.steampowered.com/app/2751310/Paper_io_2/)): „Move around the arena, draw a trail to grow your territory, and claim the zone before someone cuts you off." Paper.io 1 (2016) grid-basiert, Paper.io 2 (2018) mit **kontinuierlicher, freier Bewegung** und weichen Kurven statt Grid. Trail getroffen = eliminiert. Steam-Version: „glide over white space or opponents' territory and create connection back to your own color to claim that area."
- **Verbreitung:** [Google Play](https://play.google.com/store/apps/details?id=io.voodoo.paper2&hl=en): **100+ Mio. Downloads**, 2,48 Mio. Bewertungen; [App Store](https://apps.apple.com/us/app/paper-io-2/id1423046460): 2,8 Mio. Bewertungen (4,5★). Offizielle Voodoo-Seite: [voodoo.io/paper2](https://voodoo.io/paper2).
- **Multiplayer-Frage:** Der App Store wirbt mit „Online multiplayer you can jump into in seconds". Dem stehen mehrere unabhängige Analysen entgegen: Das Spiel läuft **auch im Flugmodus identisch weiter**, Gegnernamen sind zufällige Alphanumerik-Strings, Bot-Bewegungen sind vorhersagbar — u. a. ein [Gamedev-Blogpost, der die „Fake-Multiplayer-Experience" von Paper.io 2 als Designtechnik nachbaut](https://tinywarriorgames.com/2019/12/20/creating-a-fake-multiplayer-experience-in-paper-io-2/) sowie [weitere](https://expertbeacon.com/are-other-players-in-paper-io-bots/) [Analysen](https://www.youtube.com/watch?v=QjOKVUfWtGw). ⚠️ **Nicht von Voodoo bestätigt** — als „sehr wahrscheinlich Bots" einstufen. Bemerkenswert: Die [Steam-Portierung (Mai 2024, QubicGames/Gamersky)](https://store.steampowered.com/app/2751310/Paper_io_2/) bietet offiziell **nur lokales 4-Spieler-Multiplayer + KI-Gegner** — kein Online-Multiplayer.
- **Verifiziert:** Mechanik, Downloads, Steam-Portierung. **Unsicher:** Bot-These (plausibel, mehrfach unabhängig belegt, aber keine offizielle Aussage).

### 2.3 Qix (Taito, 1981) — historischer Ursprung

- Laut [Wikipedia](https://en.wikipedia.org/wiki/Qix) und [arcade-history.com](https://www.arcade-history.com/?n=qix&page=detail&id=2096): Arcade-Puzzle von Randy & Sandy Pfeiffer (Taito America). Der Spieler steuert einen Marker am Spielfeldrand, löst sich vom Rand und zeichnet „**Stix**" (Linien). **Wird eine Form geschlossen, wird die vom Qix abgewandte Seite gefüllt** und gibt Punkte — das ist exakt die „Fläche durch Linienschluss erobern"-Mechanik. Levelziel: standardmäßig **75 % Flächenanteil** (vom Betreiber 50–90 % einstellbar) — d. h. schon Qix war ein „Flächenanteil-Spiel", nicht ein Kill-Spiel. Langsame Stix (rot) geben doppelte Punkte. Spielbar im [Internet Archive](https://archive.org/details/arcade_qix).
- Die Klon-Linie Qix → Xonix (1984) → Pac-Xon → splix.io ist durch die [splix.io-About-Seite](https://splix.io/about) direkt belegt.
- **Verifiziert:** vollständig (Sekundärquellen konsistent, Original spielbar archiviert).

### 2.4 Tileman.io — Genre-Vertreter mit „No Kills"-Modus

- Laut [CrazyGames-Listing](https://www.crazygames.com/game/tileman-io) (Entwicklerangabe: „tiledev", Release Dez. 2018) und [tileman.io](https://tileman.io/): Grid-Bewegung (WASD/Pfeile), Trail hinterlassen, **geschlossene Fläche konvertiert eingeschlossene Tiles in die eigene Farbe**. Tod bei Trail-Schnitt durch Gegner **oder eigenen Trail**. Taste E/P pausiert die Bewegung (taktisches Element).
- **5 Modi**, darunter **„No Kills"** — man verliert bei Trail-Treffer nur den Trail, stirbt aber nicht, Fokus liegt rein auf Expansion. Das ist der bisher nächste existierende Verwandte der „Flächenanteil statt Survival"-Idee. Außerdem: Classic, Extreme Speed, Rats (kleine Karte, viele Gegner), Arena (Übungsmodus).
- **Verifiziert:** Mechanik + Modi (übereinstimmend auf offizieller Seite und CrazyGames). **Unsicher:** Identität des Entwicklers, Spielerzahl pro Server.

### 2.5 Superhex.io / Hexanaut.io / Defly.io (Exodragon) und Hexar.io (MochiBits)

- [Exodragon Games](https://exodragon.com/) (Paris) betreibt gleich drei Genre-Vertreter: **Superhex.io** („Territory conquest by drawing shapes and connecting back", laut [io-Games-Fandom](https://io-games.fandom.com/wiki/Superhex.io) Release März 2017), **Hexanaut.io** („Capture hexagons by enclosing territory and become the king!") und **Defly.io** — dort fliegt man einen Helikopter, **baut Wände/Türme** und erobert die eingeschlossene Fläche; mit Schuss-Kampf, Level-Upgrades und Modi FFA/Defuse/Team ([defly.io](https://defly.io/)). Superhex/Hexanaut sind die Hex-Grid-Variante der splix-Mechanik.
- **Hexar.io** ([App Store](https://apps.apple.com/us/app/hexar-io-1-in-io-games/id1175871181), Entwickler **MochiBits, LLC**): Mobile-Titel, „capture blocks by enclosing an area" auf Hex-Grid; auch im [Microsoft Store](https://apps.microsoft.com/detail/XP9C9KVDGFT0PS) und [Google Play](https://play.google.com/store/apps/details?id=com.mochibits.hexario.google&hl=en_US).
- **Verifiziert:** Existenz, Entwickler, Grundmechanik. **Unsicher:** ob Hexar.io echtes Online-MP oder Bots nutzt (mobil, nicht analysiert); genaue Release-Daten.

### 2.6 Territorial.io / OpenFront.io — verwandtes Genre, andere Mechanik

- **Territorial.io** von **David Tschacher** (Freiburg, [Kontaktseite](https://www.territorial.io/contact)): Browser-/Mobile-Strategiespiel, laut [App Store](https://apps.apple.com/us/app/territorial-io/id1581110913) Echtzeit-Schlachten mit **bis zu 500 Spielern pro Karte**; Expansion über Ressourcen-/Truppenmanagement und getimte Attacken (Prozent-Slider), **kein Trail-/Loop-Mechanismus**. Rundenbasierte Matches mit Allianzen ([Fandom-Wiki](https://territorial.fandom.com/wiki/Territorial.io)). Für „draw race" nur als Genre-Nachbar relevant (Endziel „Karte kontrollieren" identisch, Weg dorthin völlig anders).
- **OpenFront.io** ([GitHub](https://github.com/openfrontio/OpenFrontIO)): Open-Source-Nachbau/Weiterentwicklung dieser Mechanik (Fork von WarFront.io), **TypeScript (Client + Server), deterministische Simulation in `/src/core`, AGPLv3 (Assets CC BY-SA 4.0), 2,4k Stars / 1,2k Forks / 4 200+ Commits** — als Architekturreferenz für „viele Spieler auf einer großen Karte im Browser" sehr brauchbar, auch wenn die Kernmechanik anders ist.
- **Verifiziert:** vollständig (Primärquellen).

### 2.7 Splatoon (Nintendo) — Flächenfärbung ohne Loop-Mechanik

- Laut [offizieller Nintendo-Seite](https://splatoon.nintendo.com/en/gameplay/): Modus **Turf War** = 4-gegen-4, **3 Minuten**, Ziel ist es, **möglichst viel Bodenfläche mit Teamfarbe zu bedecken**; nach Ablauf wird der bedeckte Flächenanteil pro Team ausgewertet. Färbung erfolgt durch Schießen/Schwimmen in Tinte, nicht durch Einschließen. Relevant als Beleg, dass „Flächenanteil als Siegbedingung" massenmarkttauglich ist — Mechanik und Plattform aber ganz anders.
- **Verifiziert:** vollständig.

### 2.8 Kollaborative Canvas-Projekte: r/place und pixelplace.io

- **r/place (2017):** 1000×1000-Pixel-Canvas, 16 Farben (4 Bit/Pixel), **1 Pixel pro 5 Minuten** pro User, 72 Stunden Laufzeit, 1,1 Mio. Unique Users, 16,5 Mio. gesetzte Tiles. Technik: gesamtes Board als **ein Redis-Key (Bitmap, ~500 KB)**, WebSocket-Updates über RabbitMQ, Fastly-CDN mit 1 s TTL als „first line of defense"; im Loadtest 180 000 Writes/s ([Fastly-Blog mit Reddit-Engineering-Talk](https://www.fastly.com/blog/reddit-on-building-scaling-rplace); Original-Blogpost „How We Built r/Place" via [Reddit-Ankündigung](https://x.com/Reddit/status/852595019231879168), redditinc.com war beim Abruf nicht erreichbar). Architektonisch die beste dokumentierte Referenz für „großer persistenter gemeinsamer Canvas".
- **pixelplace.io:** Selbstbeschreibung „[/r/Place clone with no cooldown & pixel protection](https://pixelplace.io/)"; eigene Canvases, kompetitive „Pixel World War"-Map ([Product Hunt](https://www.producthunt.com/products/pixelplace-io)). Keine Verbindungs-/Loop-Mechanik — Pixel werden einzeln gesetzt.
- **Verifiziert:** r/place-Technik (Engineering-Quellen). pixelplace.io-Features nur über Startseite/Product Hunt (Seite blockt automatisierte Abrufe, ⚠️ Detailtiefe begrenzt).

---

## 3. Open-Source-Implementierungen

### 3.1 Der Original-Code: jespertheend/splix ⭐ wichtigster Fund

| | |
|---|---|
| **Repo** | [github.com/jespertheend/splix](https://github.com/jespertheend/splix) |
| **Was** | **Offizieller** splix.io-Monorepo: Client, Server, Server-Management |
| **Stack** | Server: **Deno** (JS/TS); Client: Vanilla JavaScript; Kommunikation: **binäres WebSocket-Protokoll** |
| **Lizenz** | **MIT** |
| **Aktivität** | 52 Stars, 19 Forks, 22 Releases; **v0.19.0 vom 23.09.2025** — aktiv gepflegt |
| **Self-Hosting** | Fertige Executables in den [Releases](https://github.com/jespertheend/splix/releases); eigener Server per `deno task dev`, verbindbar über `https://splix.io/#ip=ws://localhost:8080` |

Ergänzend: [JosefKuchar/Splix.io-Protocol](https://github.com/JosefKuchar/Splix.io-Protocol/blob/master/Protocol.md) (Reverse-Engineering des Wire-Protokolls, s. Abschnitt 2.1) und [JosefKuchar/Splix.io-DebugClient](https://github.com/JosefKuchar/Splix.io-DebugClient). Wichtige technische Erkenntnis aus dem Protokoll: **Der Server ist autoritativ und berechnet den Fill; der Client bekommt nur `FILL_AREA`-/`UPDATE_BLOCKS`-Deltas und `CHUNK_OF_BLOCKS` beim Betreten neuer Kartenbereiche** — genau das Muster, das man für einen großen gemeinsamen Canvas braucht.

### 3.2 Paper.io-/splix.io-Klone (Community)

| Repo | Stars | Stack | Lizenz | Anmerkungen |
|---|---|---|---|---|
| [theKidOfArcrania/BlocklyIO](https://github.com/theKidOfArcrania/BlocklyIO) | 51 | Node.js, JS, Browserify | MIT | „Clone of paper.io" mit echtem Multiplayer-Anspruch; wenig aktiv; Fill-Algorithmus im README nicht dokumentiert |
| [stevenjoezhang/paper.io](https://github.com/stevenjoezhang/paper.io) | 33 | Node.js + WebSocket, Rollup, Canvas-API | MIT | Fork von BlocklyIO; Bots, konfigurierbar; TODO „optimize victory/defeat determination" deutet auf naive Flächenberechnung |
| [openfrontio/OpenFrontIO](https://github.com/openfrontio/OpenFrontIO) | 2 400 | TypeScript (Client+Server), deterministischer Sim-Core | AGPLv3 / CC BY-SA 4.0 | Andere Mechanik (Territorial-Stil), aber größtes/aktivstes OSS-Projekt im „Territory-Browser-Game"-Umfeld |
| [JungleEngine/Paper.io](https://github.com/JungleEngine/Paper.io) | k. A. | socket.io, cross-platform | k. A. | Online-Multiplayer-Klon |
| [Kacper-Pietkun/splix.io-multiplayer-AI](https://github.com/Kacper-Pietkun/splix.io-multiplayer-AI) | 8 | **Python** (Client+Server), TCP für Handshake + **UDP** für Echtzeit | keine Lizenz | Uni-Projekt; bis 13 Spieler/Server; Bots per Heuristik und **NEAT** (Neuroevolution); interessant für Bot-Befüllung leerer Server |
| [TylerOlson/kux.io](https://github.com/TylerOlson/kux.io) | 10 | JavaScript | k. A. | splix.io-Klon |
| [SamuelScheit/paper.io](https://github.com/SamuelScheit/paper.io) | 4 | **C++/C** | MIT | Nur LAN-Multiplayer; archiviert (Juli 2025) |
| [UnsignedArduino/Paper-io](https://github.com/UnsignedArduino/Paper-io) | 2 | TypeScript / MakeCode Arcade | k. A. | Offline-Klon, Kuriosum |

(Stars: Stand Juli 2026, aus den jeweiligen Repo-Seiten. GitHub-Topics: [paperio](https://github.com/topics/paperio), [splix](https://github.com/topics/splix).)

**Fazit OSS:** Für die Loop-Färbe-Mechanik ist `jespertheend/splix` (MIT!) die einzige produktionserprobte, aktiv gepflegte Codebasis — sie dürfte legal als Ausgangspunkt oder Referenz dienen. Die Klone sind qualitativ deutlich schwächer und dokumentieren ihre Fill-Algorithmen nicht. ⚠️ **Unsicher:** Der konkrete Flood-Fill-Algorithmus ist in keinem README beschrieben; für Details müsste der splix-Servercode (`/gameServer` im Monorepo) gelesen werden — empfohlener nächster Schritt.

---

## 4. Namenskollision: „DrawRace" (RedLynx/Ubisoft)

**Bestätigt.** Es existiert eine bekannte Mobile-Spieleserie **DrawRace**:

- [DrawRace (2009, iOS)](https://en.wikipedia.org/wiki/DrawRace) — Rennspiel von **RedLynx** (den Trials-Machern, heute Ubisoft RedLynx): Man zeichnet mit dem Finger die Ideallinie, das Auto fährt sie ab; Zeichengeschwindigkeit = Fahrgeschwindigkeit ([AppSafari-Review](https://appsafari.com/games/14879/drawrace/)).
- [DrawRace 2: Racing Evolved (2011, iOS)](https://en.wikipedia.org/wiki/DrawRace_2) — Publisher EA/Chillingo, Metacritic 88/100 ([Metacritic](https://www.metacritic.com/game/drawrace-2/)). Später folgte DrawRace 3 (2016, Ubisoft).
- RedLynx ist weiterhin aktiv ([redlynx.com/games](https://www.redlynx.com/games/)).

**Konsequenz:** Der Arbeitstitel „draw race" kollidiert phonetisch/schriftlich 1:1 mit einer Ubisoft-Marke aus dem Spielebereich. Für interne Zwecke unkritisch, aber **vor jeder Veröffentlichung umbenennen oder Markenrecherche (EUIPO/USPTO) durchführen**. Zusätzlich zu beachten: „SPLIX.IO" ist [markenrechtlich geschützt](https://trademarks.justia.com/792/11/splix-79211244.html) — Namensnähe zu splix ebenfalls vermeiden.

---

## 5. Abgrenzung / Lücke für „draw race"

**Was es exakt schon gibt (keine Neuheit):**
- Die Kernschleife „eigene Farbe, Trail ziehen, Loop ans eigene Gebiet anschließen, Inneres wird gefärbt" ist die etablierte splix/paper.io-Mechanik (seit 2016, Ursprung Qix 1981). Hier ist nichts patentier- oder alleinstellungsfähig — das Genre hat dutzende Vertreter.

**Wo sich die Idee des Nutzers tatsächlich unterscheidet (Lücken im Markt):**

1. **Persistenz:** Alle Genre-Vertreter (splix.io, Paper.io 2, Superhex.io, Tileman.io, Defly.io) sind **session-/arenabasiert**: Tod löscht das gesamte eigene Gebiet, Karten sind klein (splix: default 600×600 Blöcke) und resetten faktisch permanent. Einen **großen, dauerhaft bestehenden gemeinsamen Canvas**, auf dem gefärbte Fläche über Sessions hinweg Bestand hat, gibt es in dieser Mechanik-Familie nicht.
2. **Siegmetrik Flächenanteil statt Kill/Survival:** Die .io-Vertreter belohnen primär Überleben und Kills (Trail-Cutting als Kern-PvP). „Flächenanteil als eigentliches Ziel" existiert nur (a) rundenbasiert bei [Splatoon Turf War](https://splatoon.nintendo.com/en/gameplay/) (3-Minuten-Matches, andere Mechanik) und (b) als Nischen-Modus „No Kills" in [Tileman.io](https://www.crazygames.com/game/tileman-io) — Letzterer ist der engste existierende Verwandte der Idee und sollte vor dem Bau angespielt werden.
3. **Kollaborativ-persistente Canvases** (r/place, pixelplace.io) haben Persistenz und Flächen-Wettbewerb (Fraktionen!), aber **keine Bewegungs-/Loop-Mechanik** — sie sind Malwerkzeuge mit Cooldown, keine Skill-Games.

**Die Marktlücke ist also die Kombination:** splix-Mechanik × r/place-Persistenz × Flächenanteil-Leaderboard statt Kill-Feed. Das ist plausibel neu — aber unverändert zu prüfen bleibt, wie man Snowballing (ein Spieler dominiert den persistenten Canvas dauerhaft) und Offline-Verwundbarkeit (was passiert mit meinem Gebiet, wenn ich weg bin?) designt; genau diese Probleme sind der wahrscheinliche Grund, warum das Genre sessionbasiert geblieben ist. ⚠️ Diese Design-Einschätzung ist Interpretation, keine Quellenaussage.

**Technische Referenzen für die Umsetzung:** [splix-Monorepo](https://github.com/jespertheend/splix) (autoritativer Server, Chunk-Streaming, `FILL_AREA`-Deltas) für die Spielmechanik; [r/place-Architektur](https://www.fastly.com/blog/reddit-on-building-scaling-rplace) (Redis-Bitmap, CDN-gecachter Board-Snapshot + WebSocket-Deltas) für den persistenten Groß-Canvas; [OpenFrontIO](https://github.com/openfrontio/OpenFrontIO) (deterministische TS-Simulation) für Many-Players-Architektur.

---

## 6. Monetarisierung: Verdienen diese Spiele Geld?

Kurzantwort: **Ja — aber die Erlöse sind extrem ungleich verteilt.** Das Genre kennt drei Geschäftsmodelle: (a) Mobile-Hypercasual mit Werbung + IAP (Voodoo), (b) Browser-Portal-Revenue-Share mit Ads (Poki/CrazyGames/Coolmath), (c) Community-Finanzierung (Patreon). Wichtige Messgrenze vorab: Marktdaten-Dienste wie Sensor Tower schätzen nur **Store-Umsätze (IAP)** — die bei Hypercasual dominierenden **Werbeerlöse sind darin nicht enthalten** und sind öffentlich fast nie belegt.

### 6.1 Paper.io / Paper.io 2 (Voodoo) — das obere Ende

- **Geschäftsmodell** (aus dem [App-Store-Listing](https://apps.apple.com/us/app/paper-io-2/id1423046460) verifiziert): Free-to-play mit Werbung („Contains ads"), IAP „No Ads" für 9,99 $, Gem-Pakete 0,99–19,99 $, Skin-Bundles, Lootboxen. Das ist das klassische Voodoo-Hypercasual-Modell: maximale Download-Masse, Monetarisierung primär über Interstitial-/Rewarded-Ads.
- **Skala:** [100+ Mio. Downloads auf Google Play](https://play.google.com/store/apps/details?id=io.voodoo.paper2&hl=en) (offizielle Play-Store-Angabe). Sensor-Tower-Schätzungen zeigen, dass der Titel auch 2025/26 noch läuft: zuletzt ~10 Mio. Downloads/Monat und ~50 000 $ Monats-Store-Umsatz allein US-Google-Play bzw. ~90 000 $ US-iOS ([Sensor Tower Overview](https://app.sensortower.com/overview/io.voodoo.paper2?country=US), [iOS](https://sensortower.com/ios/us/voodoo/app/paper-io-2/1423046460/overview)); in Quartalsreports lag Paper.io 2 wiederholt in den [Top-5 der .io-Games nach US-Downloads](https://sensortower.com/blog/2025-q1-unified-top-5-io%20games-units-us-643088c5e1714cfff1a6c7c5). ⚠️ Schätzwerte, ohne Werbeerlöse — der tatsächliche Gesamtumsatz liegt sehr wahrscheinlich deutlich darüber.
- **Kontext Voodoo als Firma:** [Goldman Sachs investierte 2018 200 Mio. $](https://en.wikipedia.org/wiki/Voodoo_(company)); [Tencent stieg 2020 bei einer Bewertung von 1,4 Mrd. $ ein](https://techcrunch.com/2020/08/17/tencent-takes-minority-stake-in-french-casual-games-maker-voodoo/); Voodoo meldet konzernweit ~7 Mrd. Downloads ([Wikipedia](https://en.wikipedia.org/wiki/Voodoo_(company))). Die Paper.io-Serie ist eines der Aushängeschilder ([voodoo.io/paper2](https://voodoo.io/paper2)).
- **Verifiziert:** Modell (Ads+IAP), Downloads, Finanzierungsrunden. **Unsicher:** absolute Umsatzhöhe der Serie (keine offiziellen Zahlen; Ad-Umsätze unbekannt).

### 6.2 splix.io — das untere Ende (Hobby-Ökonomie)

- **Keine öffentlichen Einnahme-Aussagen gefunden.** Jesper van den Ende betreibt einen [Patreon „creating splix.io"](https://www.patreon.com/splix) mit ~130 Mitgliedern (Stand Abruf Juli 2026); ein Suchtreffer wies öffentlich sichtbare Einnahmen von nur ~22 $/Monat aus (⚠️ nicht direkt verifizierbar, Patreon blendet Einnahmen teils aus). Serverkosten trägt laut [README](https://github.com/jespertheend/splix) ein einzelnes DigitalOcean-Droplet.
- Indizien für frühere Kommerzialisierung: eingetragene [Marke SPLIX.IO](https://trademarks.justia.com/792/11/splix-79211244.html) und eine niederländische Firma „Jesper the End B.V." als App-Publisher ([AppAdvice-Listing](https://appadvice.com/app/splix-io/1150901618)); die Browser-Version lief mit Werbung. Dass der Code 2023+ [MIT-lizenziert geöffnet](https://github.com/jespertheend/splix) und auf Patreon-Basis weiterbetrieben wird, spricht dafür, dass splix.io heute kein signifikantes Geschäft mehr ist.
- **Verifiziert:** Patreon-Existenz, Open-Source-Status. **Unsicher:** jegliche konkrete Einnahmezahl (Entwickler hat sich nie öffentlich geäußert, soweit auffindbar).

### 6.3 Territorial.io — Solo-Dev mit Ads + Patreon

- Freemium: Browser-/App-Version mit Werbung; Unterstützung läuft über **Patreon**: Unterstützer erhalten laut [Territorial-Wiki („Accounts")](https://territorial.fandom.com/wiki/Accounts) eine **werbefreie Version**, monatlich Gold (60× Pledge-Betrag, Tiers bis 20 $/Monat) und ein eigenes Leaderboard. Keine öffentlichen Umsatzaussagen von David Tschacher gefunden; die Reichweite ist aber erheblich (bis zu 500 Spieler/Match, [App-Store-Listing](https://apps.apple.com/us/app/territorial-io/id1581110913); Web-Traffic siehe [Similarweb](https://www.similarweb.com/website/territorial.io/)).
- **Verifiziert:** Monetarisierungsmechanik (Ads + Patreon-Perks). **Unsicher:** Einnahmenhöhe (keine Aussagen; Wiki ist Community-Quelle).

### 6.4 Portal-Ökonomie für Browser-.io-Games (der realistische Vertriebsweg)

- **Poki** (dokumentiert in der [offiziellen SDK-Doku](https://sdk.poki.com/index.html), wörtlich): „If a user comes to your game directly … you get **100% of the revenue** for that user. If a user comes to your game through Poki.com, or through a marketing effort from Poki, then Poki **splits the revenue 50/50** with you." Bedingung: Web-Exklusivität („game will only be published on Poki for the open web" — Steam/Mobile bleiben frei). Poki meldet per Pressemitteilung [625 Mio. Spieler/Monat und Profitabilität ohne externes Kapital](https://finance.yahoo.com/sectors/technology/articles/poki-announces-milestone-625-million-050000965.html); laut einem [gesponserten Poki-Artikel](https://www.eu-startups.com/2026/04/how-amsterdam-based-poki-is-becoming-one-of-the-best-launchpads-for-indie-game-developers-in-europe-sponsored/) erreichen Top-Titel „bis zu 1 Mio. € Jahresumsatz" (⚠️ Marketing-Aussage, Ausreißer).
- **CrazyGames** ([Developer-Doku](https://docs.crazygames.com/), [Payouts](https://docs.crazygames.com/payouts/), [Ad-Monetization-Guide](https://docs.crazygames.com/resources/ad-monetization-guide/)): Revenue-Share auf Video-/Banner-Ads über deren SDK, ausgewählte Spiele zusätzlich IAP via Xsolla; Auszahlung monatlich ab 100 € über Tipalti; Kernmetrik ist „Revenue per 1000 plays". Konkrete Prozentsätze werden **nicht öffentlich** genannt.
- **Coolmath Games** ([Developer-Portal](https://developers.coolmathgames.com/)): kuratiertes Einreichen, „earn money", volle IP-Kontrolle, keine Exklusivpflicht — konkrete Konditionen nur auf Anfrage. Exodragon vertreibt z. B. **Hexanaut.io** über Coolmath ([Coolmath-Listing](https://www.coolmathgames.com/0-hexanaut), [exodragon.com](https://exodragon.com/)) und fährt generell ein Portal+Ads-Modell über mehrere .io-Titel.
- Branchenüblich liegt der Entwickleranteil bei Portalen bei **50–80 %**, typische Erträge eines gut laufenden Casual-Browser-Games bei **~200–2 000 $/Monat** ([Branchenübersicht abratabia.com](https://www.abratabia.com/web-game-monetization/licensing-to-portals.php); ⚠️ Sekundärquelle, Schätzung).
- **Verifiziert:** Poki-50/50-Regel und CrazyGames-Auszahlungsmodell (offizielle Doku). **Unsicher:** CrazyGames-/Coolmath-Prozentsätze, typische Erträge.

### 6.5 Benchmark-Datenpunkte aus Nachbar-Genres (⚠️ andere Mechanik, gleiches .io-Ökosystem)

- **slither.io** (Steve Howse, 2016): Auf dem Höhepunkt **„mehr als 100 000 $ Umsatz täglich"** (Ursprungsquelle Wall Street Journal, referiert u. a. von [The Loop](https://www.loopinsight.com/2016/06/20/slither-io-game-goes-viral-brings-developer-100k-a-day/) und [Digital Trends](https://www.digitaltrends.com/gaming/viral-app-slither-pulls-100k-per-day/); s. a. [Wikipedia](https://en.wikipedia.org/wiki/Slither.io)); >130 Mio. Nutzer, ~15 000 $/Monat Serverkosten, Wachstum organisch über PewDiePie-Videos ([Tech.co](https://tech.co/news/gaming-industry-entrepreneurs-can-learn-slither-io-2016-07)). ⚠️ Momentaufnahme des .io-Hypes 2016, heute nicht reproduzierbar.
- **agar.io** (Matheus Valadares, 2015): Wenige Wochen nach dem 4chan-Launch von **Miniclip übernommen** (Kaufpreis nie veröffentlicht); die Mobile-Ports wurden #1 im App Store in 34 Ländern ([Wikipedia](https://en.wikipedia.org/wiki/Agar.io)). Beleg, dass erfolgreiche .io-Titel als Exit an Publisher verkauft wurden.
- **OpenFront.io** zeigt den heutigen Community-Weg: Web + [Steam](https://github.com/openfrontio/OpenFrontIO)-Release, AGPL-Code, Erlöse über Cosmetics/Support (Details im Repo).

### 6.6 Einordnung: Was ist heute realistisch?

- **Der Hypercasual-Goldrausch ist vorbei.** Hypercasual-Downloads sanken 2022 um 10 % (Q4 2022: −24 % YoY), die Zahl neuer Hypercasual-Hits in den US-Top-1000 fiel von 210 (2020) über 97 (2022) auf **54 (2023)**; die Branche migriert zu „Hybrid-Casual" mit tieferer Monetarisierung (+30 % Umsatz 2023) ([Sensor Tower State of Mobile Gaming 2023](https://investgame.net/wp-content/uploads/2023/07/state-of-mobile-gaming-2023-SensorTower.pdf), [2024](https://sensortower.com/blog/state-of-mobile-gaming-2024), [Game World Observer](https://gameworldobserver.com/2024/04/08/state-of-mobile-gaming-2024-sensor-tower-report)). Gleichzeitig sinken die Werbe-eCPMs ([Tenjin-Report](https://hc.games/en/tenjin-report-on-the-hyper-casual-game-market/)). Mobile-Hypercasual à la Voodoo erfordert heute UA-Budgets und Publisher-Maschinerie — kein realistischer Indie-Pfad.
- **Realistischer Indie-Pfad:** Browser-Release über Poki/CrazyGames mit Ad-Revenue-Share (50/50 bzw. undisclosed) + Rewarded Video + optionale Cosmetics-IAP. Erwartungswert für ein solides, nicht-virales Spiel: **niedriger drei- bis vierstelliger Monatsbetrag**; sechs-/siebenstellige Ergebnisse (slither.io, Poki-Top-Titel) sind dokumentierte, aber seltene Ausreißer mit Viralitäts-Voraussetzung. Die beiden Solo-Dev-Vorbilder im engeren Genre-Umfeld zeigen die Spannbreite: Territorial.io trägt sich sichtbar über Ads+Patreon; splix.io ist trotz Genre-Urheberschaft heute ein Patreon-finanziertes Hobbyprojekt.
- ⚠️ Diese Einordnung kombiniert belegte Datenpunkte mit Interpretation; konkrete Umsatzprognosen sind daraus nicht ableitbar.

---

## Anhang: Verifikationsstatus-Legende

- **Verifiziert** = direkt aus Primärquelle (offizielle Site, Store-Listing des Herstellers, Original-Repo, Engineering-Blog) belegt.
- ⚠️ **Unsicher** = nur Sekundärquellen, Marketing-Claims oder nicht abschließend prüfbar: Paper.io-Bot-These (keine Voodoo-Aussage); exakte Release-Daten von splix.io/Hexar.io/Superhex.io; Spielerzahlen pro Instanz bei splix.io/Tileman.io; Fill-Algorithmen der OSS-Klone (Code-Lektüre nötig); pixelplace.io-Details (Seite blockt Crawler); sämtliche absoluten Umsatzzahlen (Sensor Tower = IAP-Schätzungen ohne Ad-Erlöse; slither.io-100k$/Tag = WSJ-Bericht 2016; splix.io-Patreon-Einnahmen nicht direkt einsehbar; CrazyGames-/Coolmath-Revenue-Share-Prozentsätze nicht öffentlich).
