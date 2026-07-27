# 21 — Farbvergabe: zwei Spieler können praktisch identische Farben bekommen

**Beobachtung (Code-Review zu Ticket 08, 2026-07-27):** Die Spielerfarbe ist eine Golden-Ratio-Folge über den Hue-Kreis (`client/src/game/colors.ts`), plus ein **Bump** um +0,18, wenn ein Hue zu nah am reservierten Eigen-Blau liegt. Genau dieser Bump erzeugt eine **vermeidbare** Kollision: ID 1 (gebumpt auf 0,798) und ID 11 (natürlich 0,7984) liegen **0,1° auseinander** — im 3D-Bild sind Plateaus, Köpfe und Trails dieser beiden Spieler nicht unterscheidbar. Weitere Paare (Abstand 21/34/55 in der ID) liegen 3–8° auseinander, also ebenfalls schwer trennbar.

Das Leaderboard aus Ticket 08 fängt das **nur im HUD** ab (Discriminator „‹1›/‹2›" bei Farbgleichheit, spec §2.5 sieht genau das vor). In der **Szene** bleibt die Verwechslung: wessen Trail schneide ich hier gerade?

**Entscheidungsfrage (Triage):**

- Option A — so lassen. Bei bis zu 64 Spielern auf einem Hue-Kreis sind ~5° Abstand ohnehin die theoretische Obergrenze; echte Trennbarkeit bräuchte eine zweite Dimension. Der Discriminator deckt das HUD ab.
- Option B — den Bump durch eine **Kompression** ersetzen: die Folge auf den Kreis *ohne* das reservierte Blau-Band abbilden (`hue = blauEnde + frac(id·φ) · (1 − Bandbreite)`). Injektiv, keine künstliche Doppelung, gleicher Aufwand — beseitigt nur das 1↔11-Paar, nicht die generische Enge bei 64 Spielern.
- Option C — Farbe als **Palette** (feste, handgewählte, gut trennbare Farben mit Variation in Sättigung/Helligkeit) statt reiner Hue-Rotation; passt zur `appearance`-Naht aus ADR-0006 (Skins) und wäre der Ort, an dem Ticket „Skins" später sowieso ansetzt.

**Status:** needs-triage

_Referenz: spec §2.5 (Farb-Swatch/Discriminator), ADR-0006 (`appearance`-Naht); Fund im Review zu [Ticket 08](08-leaderboard.md)._

## Comments
