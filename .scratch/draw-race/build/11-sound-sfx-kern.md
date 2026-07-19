# 11 — Sound: prozeduraler SFX-Kern

**What to build:** Der minimale, bewusst **egozentrische** SFX-Kern — Ton löst **ausschließlich** bei eigenen Aktionen des lokalen Spielers aus, nie bei fremden Spielern. Sechs Events: **Fill**, **Kill**, **eigener Tod**, **Respawn/Join**, **Rang-Aufstieg** (One-Shots) und der **„Fress"-Loop** (spielt, solange sich der eigene Trail durch *fremdes* Gebiet frisst; leise, sanft ein-/ausgeblendet). Ton ist AN; ein HUD-Mute-Toggle wird in localStorage persistiert.

**Blocked by:** 06, 08.

**Status:** ready-for-agent

- [ ] Web Audio **prozedural-first** (Oszillator + Gain-Hüllkurve; rausch-basiert wo nötig), 0 Asset-Bytes; optionaler CC0-Sample-Fallback ≤ 50 KB gesamt, lazy nach Join (blockiert nie First-Paint/WS-Connect).
- [ ] `AudioContext` implizit beim Play/Join-Klick entsperrt (kein separater Aktivieren-Prompt); **ein** geteilter Context + Master-Gain (Mute); „Fress"-Loop = **eine** persistente Loop-Quelle per Gain-Hüllkurve; One-Shots = kurze Wegwerf-Nodes; **keine Allokation pro Tick**.
- [ ] Sechs Events hinter einer `play('...')`-Schnittstelle (A↔B-Wechsel prozedural/Sample unsichtbar); strikt egozentrisch.
- [ ] Vollständig **entkoppelt vom `sim-core`** (kein Determinismus-/Replay-Einfluss); rein additiv (kein alleiniger A11y-Kanal).
- [ ] HUD-Mute-Toggle (binär an/aus) in localStorage persistiert.
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §4.4; CONTEXT „SFX-Kern"._
