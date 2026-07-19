# 07 — Look-&-Feel-Prototyp: der 2.5D-Stil

Type: prototype
Status: resolved
Blocked by: 01, 06

## Question

Wie sieht das Spiel konkret aus — Kamera (Top-down mit Tilt? isometrisch?), Farbwelt, Tiefen-/Höheneffekte der gefärbten Fläche, Animationen (Loop-Schluss-Füllung, Durchfahren fremder Flächen, Tod) — und fühlt sich dieser Look auf Desktop **und** Handy modern und flüssig an?

Vorgehen (via /prototype): Wegwerf-Prototyp mit der in Ticket 06 gewählten Engine und dem in Ticket 01 entschiedenen Bewegungsmodell; 2–3 Stilvarianten nebeneinander (z. B. flach-clean vs. Block-Höhe mit Schatten vs. stärkerer Kamera-Tilt). Der User schaut/spielt auf Desktop und Smartphone und wählt.

Entscheidungs-Ausgang: Visuelle Richtung + Liste der Grundversion-Animationen; fliesst als Look-Kapitel in die Spec (Ticket 10) ein.

## Answer

**Visuelle Richtung: Variante D — „Paper.io Modern"** (Prototyp [`../prototype/look-and-feel.html`](../prototype/look-and-feel.html), Varianten A–D via untere Leiste / Tasten 1–4). Vom User im Live-Test (Desktop + eigenes Handy) bestätigt: „als Richtung stimmt es". Verworfen: A (flach/Top-down, zu splix-flach), B (Blöcke+Schatten — „in Ordnung", aber zu blockartig), C (starker Tilt + echte Shadow-Maps — hohe Blöcke verdecken das Feld, teuerster Pfad).

**Kern des Looks:**
- **Kamera:** perspektivischer Tilt (~52° Elevation), dezente 2.5D-Tiefe. Kein Top-down, kein steiler Iso-Winkel.
- **Gebiet (Territory):** flache, zusammenhängende **Farbfläche** mit nur leichter Höhe/erhöhter Kante — **keine hohen Blöcke, kein Würfel-Raster**; zusammenhängende Zellen lesen sich als eine Fläche (keine Fugen).
- **Trail:** durchgezogene, glatte **2D-Linie** aus der kontinuierlichen Bewegung (Ticket 01), nicht zellig. **„Frisst" sich durch fremdes 3D-Gebiet** (Paper.io-Stil): überfahrene Zellen sinken auf Bodenhöhe, die Linie läuft in der Rinne durch. Vom User ausdrücklich so gewünscht.
- **Farbe/Licht:** moderne, leicht entsättigte Palette; weiche Beleuchtung + dezenter Fog. 2.5D-Tiefe über Tilt + Kantenschattierung, nicht über Klötzchen.

**⚠️ Offene Frage aus Ticket 06 (Mobile-60fps) — BEANTWORTET (positiv):** three.js chunked `InstancedMesh` läuft auf dem Handy des Users **flüssig bei 192² UND 256²** (65 536 Instanzen, 16 Draw-Calls). Der in Ticket 06 gewählte Render-Pfad ist mobil bestätigt.

**Animationen/Verhalten Grundversion (für Look-Kapitel der Spec):**
- **Fill** (Loop-Schluss): eingeschlossene Fläche erscheint/„wächst" als zusammenhängendes Plateau (Höhen-/Farb-Welle).
- **Überfärben**: eingeschlossenes fremdes Gebiet wird übernommen.
- **Trail-Carve**: 2D-Trail schneidet sichtbar durch erhöhtes fremdes Gebiet.
- **Tod**: bewusst **schlicht** (Gebiet wird neutral). Logik bestätigt gut; visuelle Aufwertung („spannender") = spätere **Ausbaustufe**, nicht Grundversion.
- **Sanfte Barriere**: Kopf **gleitet** am Rand entlang, **kein Rand-Tod** (bestätigt Ticket 02).

**Konsequenzen für Impl/Spec (Ticket 10) — hier NICHT final gebaut, als Anforderungen festgehalten (User: „als fertige Implementierung wäre ich noch nicht zufrieden"):**
1. **Gebiet/Fill polygonbasiert** rendern → glatte, fließende Kanten (deckt sich mit [CONTEXT.md](../../../CONTEXT.md)); der Prototyp nutzt Zell-Flood-Fill (eckig) nur als Shortcut.
2. **Feld/Map nicht als Würfel-/Kachel-Raster** darstellen (flacher, glatter Untergrund).
3. **Trail** immer 2D auf Bodenhöhe, carve-through durch 3D-Gebiet.
4. **Render-Interpolation** zwischen Sim-Ticks im Client nötig (sonst ruckelt die kontinuierliche Bewegung) — Hinweis für Client-Architektur (Ticket 08).
5. **Etwas mehr 3D-Tiefe** als im Prototyp gewünscht: mehr Kamera-Neigung und/oder höheres Territorium-**Plateau** — aber Gebiet bleibt eine **glatte, zusammenhängende Fläche** (kein Würfel-Raster). Kein Widerspruch zu Punkt 1/2: „weniger blockartig" = keine einzelnen Würfel mit Fugen; „mehr 3D" = mehr Tilt + höheres glattes Plateau.

Prototyp bleibt als primäre Quelle unter `../prototype/look-and-feel.html` (Effort-Konvention: Dateien statt Branches). Fog „Sound-Design" ist durch dieses Ticket ticketreif geworden → graduiert zu Ticket 12.
