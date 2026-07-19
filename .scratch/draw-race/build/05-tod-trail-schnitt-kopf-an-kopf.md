# 05 — Tod: Trail-Schnitt + Kopf-an-Kopf + Gebiet→neutral

**What to build:** Die Verwundbarkeit, die den Trail riskant macht. Schneidet ein Gegner **oder** man selbst den eigenen **Trail** → **sofortiger Tod**. Bei **Kopf-an-Kopf**: wer sich in fremdem/neutralem Gebiet befindet, stirbt; wer im eigenen Gebiet steht, ist sicher (der andere stirbt); beide exakt draußen im selben Tick → **beide sterben**. Jeder Tod macht das **gesamte Gebiet** des Spielers wieder **neutral**; danach respawnt der Spieler frisch auf einem Startblock. (Der Totalverlust-Tod folgt in 06.)

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] `sim-core`: Trail-Schnitt-Kollision (fremd **und** selbst) mit Kopf-/Kollisionsradius 0,5 WU; Kopf-an-Kopf-Auflösung (draußen stirbt; im eigenen Gebiet sicher; beide draußen → beide tot); Tod → gesamtes Gebiet **neutral**.
- [ ] `protocol`: Tod-Event + Kill-Event.
- [ ] `server`: autoritative Todesauflösung pro Tick; sauberer Respawn (Startblock, Mindestabstand).
- [ ] `client`: Tod bewusst **schlicht** (Gebiet wird neutral); Respawn. Visuelle Aufwertung = spätere Ausbaustufe.
- [ ] Property-Test: Tod ⇒ Gebiet komplett neutral.
- [ ] Szenario-Test: zwei Sim-Clients — einer schneidet den Trail des anderen → korrekter Toter; Kopf-an-Kopf-Fälle inkl. „beide draußen → beide tot".
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §2.1, §10.4; CONTEXT „Tod"._
