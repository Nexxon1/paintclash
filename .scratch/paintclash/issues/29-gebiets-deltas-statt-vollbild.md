# 29 — Gebiets-Deltas statt Vollbild senden

**What to build:** `encodeTerritory` schickt bei **jedem** Fill das **komplette** Gebiet
eines Spielers an **jeden** Client. Stattdessen soll nur die Änderung übertragen werden.
Das ist die billige Antwort auf die einzige Zeile, die der Engine-Tausch aus
[Ticket 23](23-fill-vertexzahl-wachstum.md) nicht angefasst hat — und sie ist unabhängig
von der CPU-Frage und von [Ticket 24](24-raster-gebiet-konzeptwechsel.md).

**Blocked by:** — (23 ist erledigt)

**Status:** needs-triage

## Woher das Ticket kommt

Ticket 24 hat die Bandbreite als eigenständiges Argument aufgemacht und in seiner
„Empfehlung" gleich die Reihenfolge festgelegt:

> Hält der Dauerzustand danach das Budget → dieses Ticket auf **wontfix**, aber die
> **Bandbreiten-Zeile bleibt offen** und wird ein eigenes, kleines Ticket (Gebiets-Deltas).

Der Dauerzustand hält (Ticket 23: 0–2 Ticket-Überläufe von 288 000 über vier Stunden).
Das hier ist dieses Ticket.

## Die Zahlen (aus Ticket 24, Dauerzustand 200 WU / 8 Entities)

| | |
|---|---|
| Vertices je Spieler | ~809 |
| Gebiets-Frame | ~6,3 KB |
| Fills | 4,85/s |
| Egress | **31 KB/s je Client**, 245 KB/s je Arena |
| | ≈ 0,9 GB pro Stunde und Arena |

**Wem das weh tut — und wem nicht.** *Nicht* der Cloudflare-Rechnung: Workers/DO berechnen
keinen Egress (T13-Recherche), und das Duration-Budget läuft über Wanduhr, nicht über
Bytes. Es trifft:

- **das Datenvolumen der Spieler** — ~110 MB pro Stunde und Client, für ein 2D-Browserspiel
  auf Mobilfunk viel;
- **die Client-CPU** — jeder 6,3-KB-Frame ersetzt ein ganzes Gebiet, also Neu-Tesselierung
  des Plateaus plus Carve-Neuberechnung (`carve.ts` drosselt die schon heute), ~5× pro
  Sekunde. Das ist Frame-Zeit im Browser, nicht Serverlast.

Damit ist es ein **Qualitäts-**, kein Kosten- oder Sicherheitsargument.

## Was zu klären ist, bevor gebaut wird

- **Was ist überhaupt ein Delta?** Ein Fill ersetzt das Gebiet durch ein Multipolygon mit
  anderen Ringen — „ein paar Vertices geändert" ist es gerade **nicht**. Kandidaten: die
  gewonnene Region (`gainedRegion` liegt in `fill.ts` bereits vor und ist klein) plus, beim
  Bestohlenen, die verlorene. Der Client müsste dann selbst vereinigen/abziehen — also
  einen Clipper im Renderpfad haben, den er seit Ticket 06 hat.
- **Der Client rechnet dann Wahrheit nach.** Heute ist das Gebiet autoritativ und wird
  ersetzt; mit Deltas akkumuliert der Client. Divergenz zwischen Server- und Client-Polygon
  wäre ein neuer Fehlerfall — es braucht einen periodischen Vollbild-Abgleich oder eine
  Prüfsumme. Das ist der eigentliche Entwurf dieses Tickets, nicht das Sparen der Bytes.
- **Alternative, deutlich billiger:** Gebiete für den **Versand** dezimieren
  (Douglas-Peucker auf Sicht-Toleranz). Das Wire-Format bliebe, der Client bliebe dumm,
  die Sim-Wahrheit unangetastet — nur die gesendete Darstellung wäre gröber. Ticket 23 hat
  gemessen, dass Simplifikation an der **Sim**-Geometrie nichts trägt (die Vertices sind
  nicht redundant), aber dort ging es um Flächen-Ehrlichkeit und Disjunktheit; für die
  reine Darstellung gelten diese Schranken nicht. Diese Variante zuerst abschätzen.
- **Messen, bevor gebaut wird.** Es gibt heute keinen Bandbreiten-Bench. Ohne eine Zahl vor
  und nach ist das ein Umbau auf Verdacht.

_Referenz: spec §4.1/4.2, §6.2; ADR-0007; Zahlen aus Ticket 24. Aufgemacht bei Ticket 23._
