# 13 — Nicknames (Filter + statische Blockliste)

**What to build:** Gast-Anzeigenamen ohne Login. 1–16 **sichtbare** Zeichen, Unicode erlaubt aber **gefiltert** (keine Steuer-/Zero-Width-Zeichen); leerer Name → Auto-Gastname „Gast-####". Eine **statische Blockliste** gegen anstößige Namen wird **client- und serverseitig** geprüft (Client nur UX-Vorprüfung, **Server erzwingt**). Namen sind **nicht eindeutig** und rein kosmetisch — Unterscheidung über Farbe/Spieler-ID; nie ein Autorisierungs-Schlüssel (Autorität hängt an der `playerId`).

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] Längen-/Zeichen-Validierung (1–16 sichtbare Zeichen, Steuer-/Zero-Width entfernt) client **und** server; Länge nach sichtbaren Zeichen.
- [ ] Statische Blockliste, mit dem Server ausgeliefert; **Server erzwingt**, Client prüft nur vor (UX).
- [ ] Leerer/verworfener Name → „Gast-####".
- [ ] Name nie als Autorisierung; Bindung aller Spielerdaten an `playerId`.
- [ ] Unit-Tests für Filter + Blockliste; Server-Integration erzwingt auch bei manipuliertem Client-Namen.
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §2.8, §8.3 (Punkt 5)._
