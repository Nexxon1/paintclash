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

## Comments

**2026-07-19 (User-Bedenken, via Agent aus Ticket 03 übertragen):** Sorge zur Kollisionserkennung: Wenn Client-Sichten und Server-Wahrheit nicht synchron sind, stirbt man ggf. an Kollisionen, die auf dem eigenen Bildschirm nie stattfanden — schlechte Spielerfahrung. **Einordnung:** Genau dafür ist die Rewind-Kill-Fairness (ADR-0003, Ticket 07) vorgesehen: der Server beurteilt Schnitte aus der Sicht des *handelnden* Spielers anhand der Positions-Historie. Die in Ticket 03 nachgerüstete Infrastruktur (Ack = angewendete Input-Seq, Render-Uhr mit Server-Offset, Interpolations-Verzögerung von exakt 3 Ticks) liefert die Daten, um beim Rewind die *tatsächliche Client-Sicht* zu rekonstruieren (Gegner-Positionen zum Zeitpunkt „Server-Tick − Interp-Delay"). Bei der Umsetzung von 05/07 unbedingt gegen diese Sicht testen (Szenario-Test: Spieler weicht auf seinem Schirm aus → darf nicht sterben). Restfall bleibt genretypisch (ADR-0003).
