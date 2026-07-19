# 02 — Spielregeln im Detail

Type: grilling
Status: resolved
Blocked by: 01

## Question

Wie lautet das vollständige Regelwerk der endlosen Arena? Zu klären (via /grilling + /domain-modeling, Begriffe ins Glossar):

- **Trail & Tod:** Was passiert, wenn ein Gegner meinen Trail schneidet — sterbe ich (splix-Standard) oder verliere ich nur den Trail (Tileman „No Kills")? Was beim Schnitt des eigenen Trails? Gibt es die „Durchfahrt durch fremdes Gebiet"-Animation aus Paper.io (dem User wichtig)?
- **Färben:** Was genau wird gefärbt, wenn der Loop schliesst (eingeschlossene Fläche inkl. fremdem Gebiet? inkl. eingeschlossener Gegner)? Kann fremdes Gebiet überfärbt/gestohlen werden?
- **Spawn:** Startgebiet-Grösse, Spawn-Position (Abstand zu Gegnern), Spawn-Schutz.
- **Leaderboard:** Metrik (% der Karte vs. absolute Zellen), Anzeige (Top N + eigener Rang), persönlicher Rekord (lokal, ohne Account).
- **Karte:** Grösse und Form der Arena in der Grundversion, Verhalten am Rand.
- **Private Räume:** Erstellen (Code/Link), Beitreten, Raumgrösse-Limit, Bot-Toggle in der Lobby, Lebensdauer eines Raums.
- **Nicknames:** Längen-/Zeichenregeln, Umgang mit anstössigen Namen (Grundversion: Filter ja/nein).

Rahmen (bereits entschieden, s. Map-Notes): endlose Arena, Tod = Gebiet weg, Bots in der öffentlichen Arena, Gast + Nickname.

Blockiert durch 01, weil Grid vs. kontinuierlich die Form vieler Regeln bestimmt (Zellen vs. Flächen, Kollisionsdefinition).

Entscheidungs-Ausgang: Regelwerk-Kapitel der Spec.

## Answer

**Entschieden (2026-07-18, HITL /grilling + /domain-modeling). Grundlage: kontinuierliche Bewegung (Ticket 01), polygonbasierte Flächeneroberung (Paper.io-Klasse), endlose Arena.**

### Tod & Trail
- **Trail** = Weg ausserhalb des eigenen Gebiets. Trail-Schnitt durch Gegner **oder** durch einen selbst → **sofortiger Tod** (A/A1). Eigenes Gebiet = Safespace (kein Trail dort).
- **Kopf-an-Kopf:** Wer sich in fremdem/neutralem Gebiet befindet, stirbt; wer im eigenen Gebiet steht, ist sicher und der andere stirbt. Beide exakt draussen im selben Tick → beide sterben.
- **Totalverlust-Tod:** Wird das *gesamte* Gebiet eines Spielers weggefärbt (auf null), stirbt er — auch wenn sein Kopf gerade „im eigenen Gebiet" war. Territorium = Lebensgrundlage.
- Tod → das gesamte Gebiet des Spielers wird wieder neutral.

### Färben
- Schleife geschlossen → **komplette eingeschlossene Fläche** wird erobert (polygonbasiert).
- **Fremdes** eingeschlossenes Gebiet wird **überfärbt/gestohlen** (2a) — das macht den Totalverlust-Tod überhaupt möglich.
- Eingeschlossene **Gegnerköpfe überleben** (3a) — kein Tod durchs Einschliessen; der Totalverlust-Tod greift erst, wenn die Fläche real auf null fällt.

### Spawn
- Kleiner eigener **Startblock** (kein Start bei null). Spawn an zufälliger freier Stelle mit **Mindestabstand** zu Gegnern und deren Gebiet (2a). **Kein** Unverwundbarkeits-Timer (3a) — der sichere Startblock ist der Schutz; verwundbar erst beim Rausfahren.

### Karte
- **Quadratisch, feste Grenzen** mit **sanfter Barriere** (b, Paper.io-Stil): am Rand entlanggleiten/abdrehen, **kein** Rand-Tod. splix-Rand-Tod verworfen.
- Feste Grösse in der öffentlichen Grundversion (konkreter Wert = Balance-Startwert, Ticket 11). Ecken sind dadurch taktisch wertvolle sichere Basen — vom Mindestabstand-Spawn abgefedert.
- **Wrap-around (Torus)** wurde bewusst **verworfen** für die Grundversion: „innen/aussen" ist auf einem Torus mehrdeutig (ein Trail, der ganz um die Karte läuft, schliesst keine eindeutige Fläche ein), splix' Rand-Flood-Fill nicht nutzbar, Mehraufwand in Fill/Rendering/Minimap/Netcode → zu grosses Risiko für die selbstgebaute Continuous-Fill-Basis. **Vorgemerkt als möglicher künftiger Spielmodus.**

### Leaderboard & Score
- **Globales Live-Leaderboard** (für alle sichtbar): **nur % der Karte**, Top 5 + eigener Rang. Neben jedem Namen ein **Farb-Swatch** (Gebietsfarbe), eigene Zeile hervorgehoben → löst Namens-Doppelungen; optional Discriminator (z. B. „Max ‹2›") bei gleicher Farbe.
- **Eigenes HUD:** der **aktuelle eigene Score** live neben dem persönlichen Rekord, damit man merkt, ob man den Highscore knackt.
- **Score** (beim Tod berechnet, laufend live geschätzt) aus drei Faktoren: **Peak-Fläche × Überlebenszeit × Konkurrenz-Multiplikator**. Konkurrenz-Multiplikator = Ø **menschliche** Mitspieler während des Lebens (Bots zählen **nicht** — sonst farmt man leere Bot-Arenen). Exakte Formel/Gewichte = Balance-Parameter (Ticket 11).
- **Lokale Rekorde** (ohne Account, stabile Spieler-ID/localStorage): **Max-%**, **längste Überlebenszeit**, **Highscore**.

### Private Räume
- Zugang per **Code + teilbarem Link**, **nicht** öffentlich gelistet. **Lobby mit Host-Start** (1a).
- Host-Einstellungen in der Lobby: **Kartengrösse** (Default je Spielerzahl, frei wählbar), **Bots** (an/aus + Anzahl), **Spielerlimit** (Bereich **2–16**, Default ~8), **Nachträglicher Beitritt** (Toggle, Default **an** — drop-in per Link). Weitere Konfig (Items/Skills o. Ä.) ist bewusst Ausbaustufe.
- **Lebensdauer:** leerer Raum schliesst nach kurzer Gnadenfrist (~1–2 Min, gegen kurze Disconnects); Code danach frei.

### Nicknames
- **1–16 Zeichen**, Unicode erlaubt aber **gefiltert** (keine Steuer-/Zero-Width-Zeichen; Länge nach sichtbaren Zeichen). Leerer Name → Auto-Gastname („Gast-####").
- **Einfache Blockliste** gegen anstössige Namen, **client- und serverseitig** geprüft (2b).
- Namen **nicht eindeutig** — Unterscheidung über Farbe/Spieler-ID (s. Leaderboard).

### Weiterleitungen an Ticket 08 (Architektur)
- Polygonbasierter Fill mit „innen/aussen"-Bestimmung gegen **feste Wände** (kein Torus); **Erweiterungspunkte** für: Wrap-around-Fill, dynamisch wachsende Karte, Items/Skills-Lobbykonfig.
- Score braucht laufendes Tracking der **Ø-Menschenzahl pro Leben** (Bots ausgenommen) → Zustandsführung pro Spieler-Leben.
- Private Räume: Lobby-/Raum-Lebenszyklus, Code/Link-Vergabe, Host-Einstellungen (technische Umsetzung folgt aus Hosting/DO, Ticket 03).

### Graduierter Nebel & Scope
- **Balance-Parameter** (Tempo/Drehrate aus 01, Kartengrösse, Startblock, Spawn-Mindestabstand, Bot-Anzahl öffentl. Arena, Score-Gewichte, Raum-Defaults) sind jetzt vollständig benennbar → neues **Ticket 11 — Balance-Parameter & Startwerte** (graduiert aus „Not yet specified").
- **Wrap-around-Arena** → Out of scope (künftiger Spielmodus).
