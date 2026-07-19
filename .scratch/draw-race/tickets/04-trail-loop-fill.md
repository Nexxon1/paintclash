# 04 — Trail + Loop-Schluss → Fill (eigenes Gebiet wächst)

**What to build:** Der Kern-Loop des Genres. Fährt man aus dem eigenen **Gebiet** heraus, zieht der Kopf einen **Trail** (außerhalb = kein Safespace); kehrt man mit dem Trail ins eigene Gebiet zurück (**Loop schließen**), wird die vom Loop eingeschlossene Fläche **polygonbasiert gefärbt** und dem eigenen Gebiet zugeschlagen — das Gebiet wächst sichtbar. Im eigenen Gebiet gibt es keinen Trail. Noch ohne Tod und ohne fremdes Gebiet: nur der eigene Färbe-Loop.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] `sim-core`: Trail-Tracking ab Verlassen des Gebiets; Loop-Schluss-Erkennung; **polygonbasierter** Fill der eingeschlossenen Fläche (nicht der zellbasierte Flood-Fill aus splix); Flächenberechnung; minimale Fill-Fläche **1 WU²** (nur numerische Splitter verwerfen).
- [ ] Fill ist **strikt server-only** — nie client-behauptbar (§6.1).
- [ ] `protocol`: Trail-Delta + Gebiets-/Fill-Delta-Nachrichten (kleine Rechtecke/Polygone, Area-of-Interest-tauglich).
- [ ] `client`: Trail als durchgezogene, glatte **2D-Linie** auf Bodenhöhe; Gebiet als flaches, zusammenhängendes Plateau mit leichter Kante; Fill-Animation (Höhen-/Farbwelle).
- [ ] Property-Tests (§9.2): Flächenanteile aller Spieler + neutral = 100 % (nie negativ / > Karte); Fill erzeugt nie Loch/Überlappung; geschlossener Loop vergrößert eigenes Gebiet ≥ eingeschlossene Fläche.
- [ ] Szenario-Test: Sim-Client fährt einen Loop → Gebiet wächst um die erwartete Fläche.
- [ ] CI grün inkl. Coverage (§9.7).

_Referenz: spec §2.1–2.2, §4.1–4.2, §6.3, §9.2._
