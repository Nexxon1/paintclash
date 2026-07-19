# 11 — Balance-Parameter & Startwerte

Type: grilling
Status: open
Blocked by: 01, 02

## Question

Welche konkreten **Startwerte** bekommen alle Balance-Parameter der Grundversion, und wie werden sie strukturiert, damit sie später (mit spielbarem Build) leicht nachjustierbar sind? Es geht um dokumentierte, begründete Ausgangswerte für die Spec — nicht um final austariertes Balancing (das braucht einen spielbaren Build und geschieht in der Implementierung).

Graduiert aus dem Map-Nebel „Spielbalance-Parameter", jetzt benennbar nach Bewegungsmodell (Ticket 01) und Regelwerk (Ticket 02). Zu klären (via /grilling + /domain-modeling):

- **Bewegung:** Tempo (Startwert aus 01: 9 Zellen/s), Drehrate (320°/s) — bestätigen/anpassen; skaliert Tempo mit Gebietsgrösse (splix-Bremse)?
- **Karte:** feste Kantenlänge der öffentlichen Arena; Zellen-/Weltmasseinheit; Default-Grössen je Spielerzahl für private Räume.
- **Spawn:** Startblock-Grösse, Spawn-Mindestabstand zu Gegnern/Gebiet, Gnadenfrist leerer privater Räume.
- **Bots:** Anzahl/Dichte in der öffentlichen Arena, Ziel-Mindestbelebung (ab wann Bots auffüllen), Verhalten grob (folgt ggf. eigenem Bot-Ticket via 08).
- **Score-Formel:** konkrete Gewichte/Kurven für Peak-Fläche × Überlebenszeit × Konkurrenz-Multiplikator (Ø menschliche Mitspieler); Normalisierung, damit Zahlen „sich gut anfühlen".
- **Trail/Fill:** ggf. Trail-Breite, minimale Flächengrösse zum Färben, Tick-relevante Werte (20 Hz aus 05).

Rahmen (entschieden): kontinuierliche Bewegung (01), Regelwerk (02), 20-Hz-Tick (05), Zielgrösse ~10–100 Spieler/Arena.

Entscheidungs-Ausgang: Balance-Kapitel der Spec mit Startwert-Tabelle und Begründungen; ausdrücklich als „in der Implementierung nachzujustieren" markiert.
