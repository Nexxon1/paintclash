# 04 — splix.io-Codebasis-Analyse

Type: research
Status: resolved
Blocked by: —

## Question

Wie implementiert das MIT-lizenzierte splix-Monorepo (https://github.com/jespertheend/splix) die Kernprobleme unseres Genres — und was übernehmen wir als Referenz für die eigene TypeScript-Implementierung?

Konkret zu beantworten (durch Lesen des Server-Codes, v. a. `/gameServer`):

- **Fill-Algorithmus:** Wie wird beim Loop-Schluss die eingeschlossene Fläche bestimmt (Flood-Fill von aussen? Scanline? Datenstruktur der Karte)? Wie wird „eingeschlossenes fremdes Gebiet"/eingeschlossene Gegner behandelt?
- **Server-Autorität & Tick:** Tick-Rate, was der Server pro Tick rechnet, wie Client-Eingaben validiert werden.
- **Protokoll:** Aufbau der binären WebSocket-Nachrichten (ergänzend: https://github.com/JosefKuchar/Splix.io-Protocol/blob/master/Protocol.md) — v. a. `FILL_AREA`, `UPDATE_BLOCKS`, `CHUNK_OF_BLOCKS`; wie Karten-Chunks gestreamt werden, wie gross Updates typisch sind.
- **Client-Prediction:** Wie kaschiert der Client Latenz (Bewegung vorausberechnet? Trail lokal gezeichnet?), wie werden Korrekturen angewandt.
- **Bots:** Enthält der Server Bot-Logik? Falls ja, welche Heuristik?
- **Struktur & Qualität:** Modulschnitt des Servers, was ist übernehmenswert, was würde man heute anders bauen (der Code ist gewachsenes Vanilla-JS/Deno).
- **Lizenz:** Was verlangt die MIT-Lizenz konkret, falls wir Code-Teile oder Algorithmen übernehmen (Attribution wo?).

Entscheidungs-Ausgang: Findings-Dokument mit Antworten + konkrete Übernahme-Empfehlungen; fliesst in Tickets 05 (Netcode) und 08 (Architektur) ein.

## Answer

Analyse aus dem geklonten Quellcode: [../research/splix-analyse.md](../research/splix-analyse.md). Gist: Der Fill ist ein **inverser BFS-Flood-Fill auf einer temporären Uint8-Maske** über der Bounding-Box des Spielers — Seed aussen plus „Unfillable-Seeds" an allen Gegnerpositionen; nicht erreichte Tiles gehören dem Spieler, eingeschlossene lebende Gegner werden ausgespart, fremdes Gebiet wird erobert (`gameServer/src/gameplay/arenaWorker/updateCapturedArea.js`, läuft im Web Worker). Server ist voll autoritativ bei 20 Hz Tick; Clients senden nur Richtung+Ziel-Tile, mit 5-Tile-Rückwärts-Toleranz und 600-ms-Event-Undo (zweiphasiger Tod). Kartendaten fliessen ausschliesslich als 12-Byte-`FILL_RECT`-Rechtecke (compressTiles) — `CHUNK_OF_BLOCKS`/`UPDATE_BLOCKS` sind Legacy; Viewport 50×50 beim Join, danach 5-Tile-Randstreifen. **Bots gibt es im Server nicht.** MIT verlangt nur Mitführen von Copyright+Lizenztext bei Code-Übernahme (Datei-Header + THIRD_PARTY_LICENSES); Algorithmen-Nachbau ist frei. Übernahme-Empfehlungen für Tickets 05/08 am Ende des Dokuments.
