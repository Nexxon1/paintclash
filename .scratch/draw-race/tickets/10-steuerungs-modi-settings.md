# 10 — Vollständige Steuerungs-Modi + Settings

**What to build:** Die volle Eingabe-Matrix der Grundversion. Desktop: Default **Tastatur** (A/D bzw. Pfeile), umschaltbar auf **Maus-folgen** (Kopf steuert zur Mausposition). Mobile: Default **„Finger folgen"**, zusätzlich wählbar **„Lenken L/R"** und **„Joystick"**. Alle Modi per Einstellung wählbar und persistiert; alles erzeugt weiterhin nur legalen **Steuer-Intent** wie im Walking Skeleton (keine neue Trust-Boundary).

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] Desktop: Tastatur + Maus-folgen, zur Laufzeit umschaltbar.
- [ ] Mobile: „Finger folgen", „Joystick", „Lenken L/R" — alle drei verfügbar.
- [ ] Gewählter Modus persistiert (localStorage); jeder Modus mündet nur in Steuer-Intent.
- [ ] Playwright-E2E deckt Maus- **und** Touch-Eingabe ab (Input-Devices — was nur der Browser prüft, §9.1).
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §3._
