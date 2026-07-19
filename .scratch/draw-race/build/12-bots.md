# 12 — Bots (Heuristik über dieselbe Eingabe-Schnittstelle)

**What to build:** Server-interne **Bots**, die die öffentliche Arena beleben. Sie speisen ihre Befehle über **dieselbe Eingabe-Schnittstelle** wie Netz-Spieler ein (Quelle = lokale KI-Heuristik statt WebSocket), mit **begrenzter Wahrnehmung** („kompetent aber schlagbar"). Zielbelebung 8 Entities, solange ≥ 1 Mensch anwesend ist; `bots = clamp(ziel − menschen, 0, 8)`; 0 Menschen → 0 Bots (Arena hibernert). Bots zählen **nicht** für den Konkurrenz-Multiplikator des Scores (kein Farmen leerer Arenen).

**Blocked by:** 06.

**Status:** ready-for-agent

- [ ] Bots als server-interne Entities über die gemeinsame Intent-Schnittstelle (kein Sonderpfad, ADR-0005), gekapselt im `server`-Paket; per Konstruktion nicht schummelbar.
- [ ] Begrenzte Wahrnehmungs-Sicht; Heuristik spielt den vollen Kern-Loop (rausfahren, Loop schließen, Fill, ausweichen).
- [ ] `bots = clamp(ziel − menschen, 0, 8)`; 0 Menschen → 0 Bots; Bots füllen nur freie Slots (Menschen zuerst).
- [ ] Bots fließen **nicht** in `ØandereMenschen` (Score) ein — verifiziert mit Ticket 09.
- [ ] Ziel-Zahl 8 gegen Ticket 02 (DO-CPU-Benchmark) abgeglichen und ggf. angepasst (dokumentiert).
- [ ] Szenario-Test: Belebung folgt der clamp-Regel bei Join/Leave.
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §2.7, §10.4; ADR-0005._
