# 16 — Produktions-Deploy + Benchmark-Re-Konfirmation

**What to build:** Das Spiel produktiv nehmen und die provisorischen Kapazitätszahlen gegen den echten Build härten. Die öffentliche **Arena-DO** läuft always-on unter fester Adresse (EU `weur`-Hint), der statische Client kommt über Workers Static Assets, die Betriebshaltung ist explizit **best-effort** (keine Uptime-Garantie; der harte Free-Tages-Stopp ist die *gewollte* Abbuchungssicherheit). Der DO-CPU-Benchmark wird gegen den *echten* Sim wiederholt und bestätigt/korrigiert die Populationsgrenze + das Bot-Ziel aus Ticket 02.

**Blocked by:** 15.

**Status:** ready-for-agent

- [ ] Öffentliche Arena = **ein** always-on DO mit fester Adresse; `weur`-Hint; statischer Client über Workers Static Assets ausgeliefert.
- [ ] Finales CD deployt den echten Stack **nur** bei grüner Pipeline (CD-Tor via `needs:`).
- [ ] DO-CPU-Benchmark **gegen den echten Build** → Arena-Populationsgrenze (Ticket 15) + Bot-Ziel (Ticket 12) bestätigt oder angepasst; Ergebnis dokumentiert.
- [ ] Betriebshaltung **best-effort** dokumentiert; bestätigt: Free-Plan, keine Kreditkarte, harter Tages-Stopp = kein Kostenrisiko.
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §7, §8.5, §11; ADR-0001/0004._
