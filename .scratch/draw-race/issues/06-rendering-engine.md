# 06 — Rendering-Engine für den 2.5D-Look

Type: research
Status: resolved
Blocked by: —

## Question

Mit welcher Rendering-Lösung bauen wir den Client — gewünscht ist ein moderner 2.5D-Look (Tiefe/Perspektive, weiche Animationen beim Färben und beim Durchfahren fremder Flächen, à la Paper.io 2), flüssig auf Mittelklasse-Smartphones im Browser?

Kandidaten (Primärquellen: offizielle Docs, Benchmarks, Beispielspiele):

- **PixiJS** (2D-WebGL, sehr schnell, 2.5D via Skew/Projection-Tricks oder pixi-projection)
- **Phaser** (Spiele-Framework mit Physik/Scenes — brauchen wir das oder ist es Ballast neben eigener Sim?)
- **Three.js / Babylon.js** (echtes 3D mit orthografischer/isometrischer Kamera — echter 2.5D-Look, aber mehr Komplexität)
- **Natives Canvas2D/WebGL ohne Framework** (volle Kontrolle, minimale Abhängigkeiten)

Kriterien:

- Performance: eine grosse, sich häufig ändernde gefärbte Fläche (viele Zellen/Polygone) + Trails + ~100 bewegte Entities bei 60 fps auf einem Mittelklasse-Handy — welche Render-Strategie (Chunk-Texturen, Instancing, Dirty-Rects) legt die Engine nahe?
- 2.5D-Eignung: Wie aufwendig ist der gewünschte Look (Blöcke mit Höhe, Schatten, Kamera-Tilt) jeweils wirklich?
- TypeScript-Qualität: Typen, API-Design, Testbarkeit (Rendering von Sim sauber trennbar?).
- Projektgesundheit: Wartung, Community, Bundle-Size, Lizenz.

Rahmen: TypeScript strict ist gesetzt; die Sim ist engine-unabhängig geteilt mit dem Server — die Engine rendert nur.

Entscheidungs-Ausgang: Empfehlung (1. Wahl + Fallback) mit Begründung; Basis für den Look-&-Feel-Prototyp (Ticket 07).

## Answer

**1. Wahl: three.js** (r185, MIT, 182 kB gzip voll/tree-shakeable) — der gewünschte 2.5D-Look (Blockhöhe, Kamera-Tilt, Schatten, Hochwachs-Animation beim Färben) ist nativ 3D statt Fake-Tricks; die grosse Fläche wird als gechunktes `InstancedMesh` gerendert (1 Draw Call pro 64×64-Chunk, `FILL_AREA`-Delta = kleines Buffer-Update, Färbe-Welle als Vertex-Shader-Animation). **Fallback: PixiJS v8** (TS-first, Chunk-RenderTextures), falls der Prototyp einen flacheren Look oder 3D-Probleme zeigt — aber ohne pixi-projection (verifiziert tot, nur Pixi ≤v7). Phaser 4 (Framework-Ballast, junger Renderer-Rewrite, kein 3D) und Roh-WebGL (eigene Engine schreiben) scheiden aus; als Architektur-Muster übernehmen wir OpenFronts Renderer-als-Data-Sink-Fassade. Mobile-60-fps ist abgeleitete Einschätzung ⚠️ — Kernauftrag für Prototyp-Ticket 07. Details: [../research/rendering-engine.md](../research/rendering-engine.md)
