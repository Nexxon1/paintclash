# 19 — Selbstschnitt präzisieren: Kreuzungs-Test statt Karenz-Band

**What to build:** Playtest-Befund (2026-07-24, nach Ticket 05): an der Wand kann man sichtbar **in die eigene Spur fahren, ohne zu sterben**. Ursache ist kein Bug, sondern die pauschale **Selbstschnitt-Karenz** von 4,5 WU Weglänge (`BALANCE.trail.selfCutGraceWU`): sie existiert nur, weil (a) der Trail am Kopf klebt und (b) die sanfte Barriere einen angepinnten Kopf beim Abdrehen über die eigene Wand-Spur zurückschiebt. Abseits der Wand ist Kontakt im Karenz-Band geometrisch ohnehin unmöglich — an der Wand erlaubt es aber ~2–3 WU sichtbares Überfahren der eigenen Linie.

**Präziser Vorschlag:** Selbstschnitt als **echten Kreuzungs-Test** formulieren statt als Nähe-Test mit Karenz: das Bewegungssegment des Ticks (Pose vorher → nachher) stirbt genau dann, wenn es ein **eigenes** Trail-Segment **transversal kreuzt** (proper intersection; gemeinsame Endpunkte am geklebten Schwanz zählen nicht). Damit:

- Wand-Rückgleiten und Wand-Gezappel = kollineares Überlappen, **keine** Kreuzung → überlebt (sanfte Barriere bleibt sanft; löst zugleich Watch-Item (a) aus Ticket 05: Mehrfach-Wandpässe).
- Voller Kreis / Teardrop = transversale Kreuzung → stirbt, unabhängig von der Weglänge.
- `BALANCE.trail.selfCutGraceWU` entfällt (Karenz-Fenster + Grenz-Assertions in `balance.test.ts` mit abbauen).
- **Fremde** Trail-Schnitte bleiben unverändert Nähe-Tests mit 0,5 WU (das gerenderte Band ist die Kill-Zone; Kopf-an-Kopf-Interplay aus Ticket 05 unangetastet).

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] `sim-core`: Selbstschnitt in `detectDeaths` auf Segment-Kreuzung (Orientierungs-/Straddle-Test) umstellen; geklebten Schwanz über gemeinsame Endpunkte statt Weglängen-Karenz ausnehmen; Kollinear-Sonderfälle (exakte Rückfahrt auf der Wandlinie) explizit überlebbar.
- [ ] Tests: Wand-Abdrehen + mehrfaches Wand-Gezappel überlebt; Vollkreis stirbt; Teardrop stirbt; Golden-Replay-Hash bei Semantikänderung bewusst regenerieren.
- [ ] `shared`: `selfCutGraceWU` + zugehörige Assertions entfernen; CONTEXT.md-Eintrag „Selbstschnitt-Karenz" durch „Selbstschnitt = Linienkreuzung" ersetzen.
- [ ] Rewind-Naht beachten: `detectDeaths` bleibt reine Query über Spieler-Sichten (Ticket 07 braucht dafür zusätzlich die Vorher-Pose — Signatur entsprechend planen).
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §2.1, §2.4, §10.4; Ticket 05 Answer (Karenz-Herleitung + Watch-Items)._

## Comments
