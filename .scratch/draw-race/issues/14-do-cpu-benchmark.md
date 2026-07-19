# 14 — DO-CPU-Benchmark: Spieler pro Arena

Type: prototype
Status: open
Blocked by: 10

## Question

Wie viele gleichzeitige Spieler trägt *eine* Durable-Object-Arena beim 20-Hz-Tick mit kontinuierlicher Sim + Polygon-Fill, bevor das CPU-Budget eines (single-threaded) DO nicht mehr reicht? Das Ergebnis bestimmt die **Shard-Grösse** (max. Spieler pro Arena) und bestätigt die Tragfähigkeit der Workers/DO-Wahl (ADR-0001).

Graduiert aus der Architektur-Grillung (Ticket 08, Frage 1/8) als der eine echte technische Vorbehalt der Hosting-Wahl. **Erster Implementierungs-Spike** — braucht eine lauffähige Minimal-Sim + Fill im DO, daher **blockiert durch die fertige Spec (Ticket 10)**; wird *nach* Erreichen der Map-Destination angegangen (Übergang in die Umsetzung).

Vorgehen (via /prototype): minimale Arena im DO (Tick-Loop + Polygon-Fill aus `sim-core`), synthetische Last (viele simulierte Spieler/Bots), messen: CPU-ms pro Tick, ab welcher Spielerzahl das Tick-Budget reisst, Speicher. Gegenmittel prüfen: Fill zum Färben **rastern** statt reine Polygon-Geometrie; Arena-/Spielerzahl deckeln.

Entscheidungs-Ausgang: belastbare Zahl „max. Spieler/Arena" (bestätigt/korrigiert den provisorischen Startwert aus Ticket 11) + Go/No-Go bzw. Mitigationsliste für ADR-0001.
