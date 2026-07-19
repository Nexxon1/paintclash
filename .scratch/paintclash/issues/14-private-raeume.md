# 14 — Private Räume

**What to build:** Abgeschlossene Räume neben der öffentlichen Arena. Zugang per **Code + teilbarem Link**, **nicht** öffentlich gelistet. Ein Raum hat eine **Lobby** mit **Host-Start**; der Host stellt Kartengröße (Default je Spielerzahl, frei), Bots (an/aus + Anzahl, Default aus), Spielerlimit (2–16, Default 8) und Nachträglicher-Beitritt (Toggle, Default an — Drop-in per Link) ein. Räume entstehen pro **Raum-Code** (`idFromName(code)`), **hibernieren** bei Leere/Lobby und schließen nach **90 s** Gnadenfrist; der Router leitet private WS-Verbindungen anhand des Codes.

**Blocked by:** 12, 13.

**Status:** ready-for-agent

- [ ] Raum erstellen → **Code** (~6 Zeichen, Alphabet ohne `0/O`,`1/I/l`, case-insensitiv) + teilbarer Link; nicht gelistet.
- [ ] **Lobby** + Host-Start; Host-Settings: Kartengröße (Default `√(Spieler × 5000)` WU → 2p 100 / 4p 140 / 8p 200 / 16p 280, überschreibbar), Bots (Default aus; bei Aktivierung dieselbe clamp-Regel bis Raumlimit), Spielerlimit 2–16 (Default 8), Nachjoin (Default an).
- [ ] **Raum-Registry** in DO-SQLite (Code → Konfig), selten geschrieben; 1 DO pro Code (`idFromName(code)`).
- [ ] Router-Worker routet privat per Code; öffentliche Arena unverändert.
- [ ] **Hibernation** bei Leere/Lobby; leerer Raum schließt nach 90 s, Code danach frei; nur ticken, wenn ein Spiel mit Spielern läuft.
- [ ] Raum-Erstellung pro IP raten-begrenzt (jeder Raum = DO + SQLite-Write).
- [ ] `server`-Integration: Raum-Lifecycle (erstellen / join / late-join / leave / reconnect / leer → Timeout → Cleanup), Bots-Toggle.
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §2.6, §5.2, §5.3, §8.3 (Punkt 6), §10.4; ADR-0004._
