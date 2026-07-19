# 09 — Score + lokale Rekorde

**What to build:** Die persönliche Leistungszahl. Der **Score** wird beim **Tod** nach der Formel `round(peakPct × √überlebenSek × (1 + 0,25 × ØandereMenschen) × 10)` berechnet und live (gleiche Formel) aufs eigene HUD geschätzt — neben dem persönlichen Rekord, sodass man merkt, ob man den Highscore knackt. **Lokale Rekorde** (Max-%, längste Überlebenszeit, Highscore) liegen ohne Account im Browser (localStorage), in migrierbarer, an die `playerId` gebundener Form.

**Blocked by:** 04, 05.

**Status:** ready-for-agent

- [ ] `sim-core`/`server`: `peakPct`-Tracking (max. gehaltener Karten-%-Anteil im Leben, kartengrößen-unabhängig); zeitgemittelte Zahl gleichzeitig lebender *anderer* **Menschen** (Bots zählen **nicht**); Score-Berechnung beim Tod.
- [ ] `client`: Live-Score-Schätzung aufs HUD neben persönlichem Rekord; Rekorde (Max-%, Überlebenszeit, Highscore) in localStorage, **migrierbar** (`playerId`-Indirektion, ADR-0006 Naht 4).
- [ ] Unit-Test der Formel gegen die Referenz-Größenordnungen (§10.5: schneller Tod ≈ 116, solider Lauf ≈ 3 290, Top-Lauf ≈ 18 190).
- [ ] „ØandereMenschen zählt Bots nicht" bleibt korrekt, wenn Bots existieren (koordiniert mit Ticket 12).
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §2.5, §10.5; ADR-0006._
