# 07 — Kill-Fairness mit Rewind

**What to build:** Faire Tode trotz Netz-Verzug. Der Server hält eine **Positions-Historie** je Entity und beurteilt Schnitte/Kopf-an-Kopf aus der Sicht des *handelnden* Spielers (**Rewind**) — so zählt „ich habe den Trail vor mir geschnitten" auch dann, wenn der Gegner beim Betrachter durch die Interpolation leicht verzögert stand. Baut auf der Todesauflösung aus 05 auf und macht sie lag-fair.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] `server`: rollierende Positions-Historie je Entity; Todes-/Schnitt-Beurteilung gegen den **zurückgespulten** Zustand aus Sicht des Handelnden (Gambetta-Rewind).
- [ ] Determinismus/Replay bleibt intakt (keine Uhr, festes dt; kein Map-Insertion-abhängiges Verhalten).
- [ ] Szenario-Test mit **simulierter Latenz**: ein Schnitt, der ohne Rewind knapp verfehlt würde, zählt mit Rewind korrekt; kein „doppelter Tod", keine Divergenz gegen den Replay-Hash.
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §6.1; ADR-0003._
