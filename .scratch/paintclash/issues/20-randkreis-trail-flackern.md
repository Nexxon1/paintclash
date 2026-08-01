# 20 — Kreisen an der Gebietskante: Trail flackert sichtbar auf

**Beobachtung (User-Playtest 2026-07-24):** Hält man im eigenen Startblock dauerhaft A/D gedrückt (Kreisfahren), blitzt periodisch kurz ein Trail auf und verschwindet wieder — „als würde man kurz neues Gebiet aufnehmen". Fläche wächst korrekt nicht.

**Analyse (kein Sim-Bug, aber ein UX-Thema):** Der Vollkreis hat Radius ≈ 1,61 WU; vom Blockzentrum aus reicht er bis ~3,22 WU — der 6×6-Block nur bis 3,0 an der Kantenmitte. Der Kopf **verlässt das Gebiet also real** um bis zu ~0,2 WU für einige Ticks pro Umdrehung: Trail entsteht (korrekt), Wiedereintritt schließt den Loop, der Splitter-Fill (< Schwelle) räumt den Trail, nächste Runde dasselbe. Das Flackern ist insofern **ehrlich**: in diesen Ticks ist man wirklich draußen und schneidbar/verwundbar — ein Gegner könnte genau diesen Mini-Trail schneiden.

**Entscheidungsfrage (Triage):** Ehrlichkeit behalten (Flackern zeigt reale Verwundbarkeit) vs. Politur:

- Option A — so lassen, ggf. mit Ticket 06 (Carve-/Gebiets-Visuals) neu bewerten.
- Option B — reine Render-Politur: sehr kurze eigene Trails (< ~1 WU Gesamtlänge) erst ab Überschreiten einer Mindestlänge einblenden. Verwundbarkeit bliebe sim-seitig unverändert bestehen, würde aber nicht mehr angezeigt — Ehrlichkeits-Tradeoff.
- Option C — Sim-seitige Hysterese (Innen-Toleranz ≈ Kollisionsradius), damit Sub-Radius-Ausflüge als „innen" gelten. Greift in Kollisions-/Fill-Semantik ein; nur mit sorgfältiger Property-Absicherung.

**Status:** needs-triage

_Referenz: spec §2.1/§2.2; Ticket 05 (Trail-Ableitung), Ticket 06 (Gebiets-Visuals)._

## Comments
