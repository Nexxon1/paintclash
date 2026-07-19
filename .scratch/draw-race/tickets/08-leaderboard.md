# 08 — Leaderboard (Live-%, Top 5 + eigener Rang)

**What to build:** Die globale, für alle sichtbare Rangliste. Live aus dem Speicher berechnet, Metrik **ausschließlich % der Karte**; zeigt Top 5 + die eigene (hervorgehobene) Zeile mit dem eigenen Rang. Neben jedem Namen ein **Farb-Swatch** der Gebietsfarbe; optionaler Discriminator (z. B. „Max ‹2›") bei gleicher Farbe.

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] `server`: Leaderboard **live aus dem Live-Zustand** (nur %), Top 5 + eigener Rang; keine Persistenz.
- [ ] `protocol`: kompakte Leaderboard-Update-Nachricht.
- [ ] `client`: HUD-Leaderboard; eigene Zeile hervorgehoben; Farb-Swatch je Zeile; Discriminator bei Farbgleichheit.
- [ ] Szenario-Test: Ränge folgen den Flächenanteilen; eigener Rang korrekt auch jenseits der Top 5.
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §2.5._
