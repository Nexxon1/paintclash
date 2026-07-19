# 06 — Gebiet stehlen (Überfärben) + Totalverlust-Tod

**What to build:** Der Konflikt-Motor. Schließt ein Spieler einen Loop, der fremdes **Gebiet** einschließt, wird dieses **überfärbt/gestohlen**; der Trail „frisst" sich sichtbar durch erhöhtes fremdes Gebiet (Carve-through — überfahrene Fläche sinkt auf Bodenhöhe, die Linie läuft in der Rinne). Fällt das Gebiet eines Spielers dadurch auf **null**, stirbt er (**Totalverlust-Tod**) — auch wenn sein Kopf gerade „im eigenen Gebiet" war. Eingeschlossene **Gegnerköpfe überleben** das Einschließen selbst; der Totalverlust-Tod greift erst, wenn die Fläche real auf null fällt.

**Blocked by:** 04, 05.

**Status:** ready-for-agent

- [ ] `sim-core`: Fill über fremdes Gebiet überfärbt/stiehlt es; **Totalverlust-Tod**, wenn ein Gebiet real auf 0 fällt; eingeschlossene Köpfe sterben **nicht** durchs Einschließen.
- [ ] `client`: sichtbare Übernahme fremden Gebiets; **Trail-Carve** durch erhöhtes 3D-Gebiet (Rinne auf Bodenhöhe).
- [ ] Property-Test: keine negative Fläche / > Karte; Summe aller Anteile + neutral bleibt 100 %.
- [ ] Szenario-Test: Spieler A färbt B komplett weg → B stirbt (Totalverlust), auch mit Kopf im Rest-Gebiet; ein eingeschlossener Kopf überlebt, bis seine Fläche 0 erreicht.
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §2.1–2.2, §4.1–4.2._
