# 15 — Abuse-/Ressourcen-Schutz

**What to build:** Die billigen, server-seitigen Ressourcen-Deckel, die die *eine* Gratis-Arena verfügbar halten (Leitprinzip **Verfügbarkeit zuerst** — Integritäts-Cheating ist durch die Server-Autorität schon strukturell erledigt; die Intent-only-Validierung liegt bereits in Ticket 03). Flood-/Rate-Schutz pro Verbindung, Pro-IP-Deckel, die harte **Arena-Populationsgrenze** und ein Raum-Erstellungs-Rate-Limit.

**Blocked by:** 02, 14.

**Status:** ready-for-agent

- [ ] Flood/Rate pro Verbindung: eine wirksame Eingabe pro Spieler pro Tick (Coalescing der *letzten* Intent), Frame-Größen-Cap **vor** dem Parsen, Trennung bei anhaltendem Flood/Garbage nach kleinem Toleranzfenster.
- [ ] Pro-IP-Deckel via `CF-Connecting-IP` am Router-Worker: max. gleichzeitige Verbindungen/IP (~16, großzügig & CGNAT-/Shared-WLAN-tolerant), Join-Rate/IP gegen Reconnect-Spam + Raum-Code-Brute-Force.
- [ ] **Arena-Populationsgrenze**: harter Cap gleichzeitiger Spieler (Wert ← Ticket 02); Menschen zuerst, Bots nur freie Slots; bei Erreichen saubere „Arena voll"-Abweisung — **keine** Queue, **kein** Auto-Sharding.
- [ ] Raum-Erstellung pro IP raten-begrenzt (falls nicht schon in Ticket 14 vollständig abgedeckt).
- [ ] Schwellen als abstimmbare Konstanten (neben `BALANCE`), in der Implementierung kalibriert.
- [ ] Szenario-Tests: Flood → Drop/Trennung; „Arena voll" → saubere Abweisung.
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §8.1–8.3, §7.2._
