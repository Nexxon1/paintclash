# ADR-0006 — Erweiterbarkeits-Nähte

Status: Angenommen (2026-07-19)
Kontext-Tickets: [08 Architektur](../../.scratch/draw-race/issues/08-architektur-erweiterbarkeit.md)

## Kontext

Die Grundversion soll spätere Ausbaustufen andocken lassen, ohne sie jetzt zu bauen und ohne `sim-core` zu verkomplizieren. Der User erwartet **1–4 als sichere künftige Erweiterungen** (nicht bloss hypothetisch); #5 bleibt spekulativ/später.

## Entscheidung — fünf Nähte, alle mit Quasi-Null-Kosten heute

1. **Items/Upgrades** → neutrales **Effekt-Feld** je Entity in `sim-core` (Tempo-Multiplikator, Schild …), das `schritt()` liest. Grundversion: immer leer. Schiessen später = neuer Input-Typ + Projektil-Entities.
2. **Spielmodi** → austauschbares **Regelwerk-Interface** (Siegbedingung, Todesregeln, Scoring, Respawn). Grundversion = Strategie „endlose Arena". Deckt auch den geparkten Torus-Modus.
3. **Skins/Kosmetik** → sim-neutraler **`appearance`-Deskriptor** (heute Farbindex, später Skin-ID); Server reicht ihn durch, nur der **Client** rendert; `sim-core` ignoriert ihn.
4. **Accounts/Progression** → **`playerId`-Indirektion**: alle spielerbezogenen Daten hängen an `playerId`, lokale Rekorde liegen in **migrierbarer** Form vor. Ausbau: Auth-Schicht gibt account-gebundene IDs aus, **Rekorde + Progression + Skin-Besitz wandern in server-seitige Pro-Account-Persistenz** (ausdrücklicher User-Wunsch).
5. **Persistenter Canvas** → die **DO-Grenze** ist bereits die Snapshot-Naht (das Arena-DO besitzt allen Zustand); Grundversion schreibt aber nichts. Harte Fragen (Snowballing, Offline-Schutz, Schreib-Budget) = eigenes späteres Vorhaben.

## Konsequenzen

- **1–4** werden als geplante Evolution behandelt (bewusste, dokumentierte Nähte); **5** bleibt spekulativ.
- `sim-core` bleibt schlank und rein; **keine** Erweiterung wird jetzt gebaut — es werden nur Nähte offen gehalten.
