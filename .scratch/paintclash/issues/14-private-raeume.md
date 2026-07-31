# 14 — Private Räume

**What to build:** Abgeschlossene Räume neben der öffentlichen Arena. Zugang per **Code + teilbarem Link**, **nicht** öffentlich gelistet. Ein Raum hat eine **Lobby** mit **Host-Start**; der Host stellt Kartengröße (Default je Spielerzahl, frei), Bots (an/aus + Anzahl, Default aus), Spielerlimit (2–16, Default 8) und Nachträglicher-Beitritt (Toggle, Default an — Drop-in per Link) ein. Räume entstehen pro **Raum-Code** (`idFromName(code)`), **hibernieren** bei Leere/Lobby und schließen nach **90 s** Gnadenfrist; der Router leitet private WS-Verbindungen anhand des Codes.

**Blocked by:** 12, 13.

**Status:** resolved (2026-07-31)

- [x] Raum erstellen → **Code** (~6 Zeichen, Alphabet ohne `0/O`,`1/I/l`, case-insensitiv) + teilbarer Link; nicht gelistet. — `POST /api/rooms` → `{ code, hostToken, url }`; 31-Symbol-Alphabet × 6 ⇒ ~8,9 × 10⁸ (spec §8.3), verzerrungsfreie Ableitung aus CSPRNG-Bytes, **eine** Normalisierung für Client-Vorprüfung und Routing (`shared/room.ts`).
- [x] **Lobby** + Host-Start; Host-Settings: Kartengröße (Default `√(Spieler × 5000)` WU → 2p 100 / 4p 140 / 8p 200 / 16p 280, überschreibbar), Bots (Default aus; bei Aktivierung dieselbe clamp-Regel bis Raumlimit), Spielerlimit 2–16 (Default 8), Nachjoin (Default an). — `lobby`/`roomSettings`/`roomStart`-Opcodes; `sanitizeRoomConfig` ist idempotent, die Lobby-Vorschau **ist** damit die Server-Antwort. Host-Rolle per 128-bit-Token, mit Vererbung an das längst wartende Mitglied.
- [x] **Raum-Registry** in DO-SQLite (Code → Konfig), selten geschrieben; 1 DO pro Code (`idFromName(code)`). — Ein Eintrag im Storage des Raums selbst; seine Anwesenheit **ist** der Raum, `409` auf einen zweiten `POST /room` ist die Kollisionsprüfung (ADR-0008).
- [x] Router-Worker routet privat per Code; öffentliche Arena unverändert. — `/ws?room=CODE` → `idFromName(code)`; `/ws` ohne Parameter ist Zeile für Zeile der alte Pfad (Szenario-Test hält das fest).
- [x] **Hibernation** bei Leere/Lobby; leerer Raum schließt nach 90 s, Code danach frei; nur ticken, wenn ein Spiel mit Spielern läuft. — Lobby-Zustand im **Socket-Attachment** (übersteht die Verdrängung), Arena-Mitgliedschaft im Speicher (stirbt bewusst mit der Arena); Alarm-getriebener Cleanup per `deleteAll()`.
- [x] Raum-Erstellung pro IP raten-begrenzt (jeder Raum = DO + SQLite-Write). — `RoomGateDO`, fixes Fenster (`LIMITS.roomCreatePerIp` / `roomCreateWindowMs`), **ein** Write pro erlaubter Erstellung und **keiner** pro Abweisung.
- [x] `server`-Integration: Raum-Lifecycle (erstellen / join / late-join / leave / reconnect / leer → Timeout → Cleanup), Bots-Toggle. — 18 Szenario-Tests über den echten Stack, 4 Playwright-Tests über die Karte.
- [x] CI grün inkl. Coverage (§9.7) — lokal alle Gates grün: typecheck, lint, `format:check`, `build`, 631 Unit/Property (40 Dateien), 35 Szenario (hermetisch) + 2 (Bots), 21 E2E, Coverage-Böden gehalten (`server/src` 100 % Zeilen / 93,2 % Branches; `shared/src` 100 %).

_Referenz: spec §2.6, §5.2, §5.3, §8.3 (Punkt 6), §10.4; ADR-0004, ADR-0008._

## Comments

**2026-07-31 — umgesetzt.** Drei Entscheidungen, die die Spec offen liess, sind in
[ADR-0008](../../../docs/adr/0008-private-raeume-code-lebenszyklus-und-lobby.md) begründet:
der Registry-Eintrag *ist* der Raum (kein zentrales Verzeichnis), der Lobby-Zustand liegt im
Socket-Attachment und die Arena-Mitgliedschaft absichtlich nicht, und das Erstellungs-Budget
pro IP bekommt ein eigenes DO (zugleich die Naht für Ticket 15).

Fünf Dinge, die beim Bau entschieden werden mussten und im Ticket nicht standen:

1. **Nachjoin heisst „in ein laufendes Spiel".** Ein gestarteter Raum, dessen Spieler alle weg
   sind, läuft nicht — der erste Rückkehrer kommt herein, auch bei Nachjoin *aus*. Sonst wäre
   jede DO-Verdrängung (Deploy, Speicherdruck) oder ein gemeinsames Neuladen eine Aussperrung
   aus dem eigenen Raum.
2. **Host-Vererbung.** Die Spec nennt nur „Host-Start". Ohne Vererbung hinterlässt ein
   geschlossener Host-Tab eine Lobby, die niemand mehr starten kann und die erst 90 s nach dem
   Gehen des Letzten verschwindet. Das längst wartende Mitglied erbt; das Token holt die Rolle
   zurück.
3. **Bot-Deckel.** Das Host-Ziel wird auf das Raumlimit geklemmt (spec §10.4), der harte
   Deckel bleibt `BALANCE.bots.maxBots` = 8 — der ist ein CPU-Schutz (Ticket 22/23), keine
   Host-Einstellung. Ein 16er-Raum mit Ziel 16 und einem Menschen bekommt also 8 Bots, nicht 15.
4. **Kartengrösse: abgeleitet vs. geklemmt.** Fehlt sie, gilt die §10.4-Leiter; ist sie
   gesetzt, wird sie nur geklemmt. Sonst hätte jede Änderung am Spielerlimit die frei
   gewählte Grösse hinter dem Host zurückgesetzt. Die **Bandbreite** (60…400 WU,
   `BALANCE.room.mapSizeMin/MaxWU`) ist eine Zutat, die die Spec nicht nennt: „frei wählbar"
   (§2.6) kann keine 5-WU- und keine 100 000-WU-Arena meinen; der Boden ist, was 16
   Startblöcke plus Spawn-Abstand brauchen, die Decke doppelt so viel Fläche wie das höchste
   Limit verlangt.
5. **Das Spielerlimit sinkt nie unter die schon Wartenden.** Ohne diesen Boden hätte ein Host,
   der von 4 auf 2 stellt, das dritte und vierte Mitglied beim *Start* mit „Raum voll"
   geschlossen — dafür, dass sie zuerst da waren. Gefunden im Code-Review, mit Szenario-Test
   festgenagelt.

**Nicht in diesem Ticket (Abgrenzung zu [15](15-abuse-ressourcen-schutz.md)):** spec §8.3
Punkt 6 nennt neben der Erstellungs-Rate auch ein **Join-Rate-Limit** als Säule des
Enumerations-Schutzes. Das steht als eigene Checkbox in Ticket 15 („Join-Rate/IP gegen
Reconnect-Spam + **Raum-Code-Brute-Force**") und ist hier bewusst nicht gebaut; die Checkbox
dieses Tickets deckt nur die Erstellung. `RoomGateDO` ist die Naht dafür — der Pro-IP-Zähler
liegt schon, Ticket 15 hängt seinen zweiten Deckel daran. Bis dahin ist `/ws?room=CODE`
unbegrenzt probierbar (die verbleibenden Säulen: ~8,9 × 10⁸ Kombinationen, sehr wenige
lebende Räume, Wegwerf-Natur).

**Offen (bewusst):** ein hängender Lobby-Socket ohne Close-Event bindet seinen Code, bis der
Transport das Close nachliefert — in der Lobby läuft kein Tick-Sweep. Preis: ein Code aus
~8,9 × 10⁸; nicht mit einem Lobby-Ping bezahlt (s. ADR-0008 „Konsequenzen").
