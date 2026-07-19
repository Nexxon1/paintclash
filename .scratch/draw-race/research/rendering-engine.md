# Rendering-Engine für den 2.5D-Browser-Client (Ticket 06)

Stand: 2026-07-18. Recherchiert gegen Primärquellen (offizielle Docs, GitHub-Repos/-Releases, npm-Registry, Quellcode der Genre-Referenzen). Alle Versions- und Wartungsangaben wurden am **2026-07-18 live abgerufen** (npm-Registry-API, GitHub-REST-API, jsDelivr, bundlephobia-API) — nichts stammt aus Trainingswissen. Jede Behauptung ist verlinkt; ⚠️ markiert Unsicheres. Legende am Ende wie in `research-existing-games.md`.

Kontext: 600×600-Zellen-Grid (splix-Protokoll: `CHUNK_OF_BLOCKS`, `UPDATE_BLOCKS`, `FILL_AREA` — Fläche ändert sich häufig, aber immer als umschriebene Deltas), ~100 bewegte Entities im/nahe Viewport, Ziel 60 fps auf Mittelklasse-Smartphones (WebGL2-Baseline), gewünschter Look à la Paper.io 2 (Blöcke mit Höhe, Schatten, Kamera-Tilt, weiche Färbe-Animationen). Die Sim ist engine-unabhängig und mit dem Server geteilt — **die Engine rendert nur**.

---

## TL;DR

**1. Wahl: three.js** (aktuell r185, MIT) — **Fallback: PixiJS v8** (aktuell 8.19.0, MIT).

- **Der gewünschte Look ist nativ 3D.** Blockhöhe, Kamera-Tilt, Schatten und „Blöcke wachsen beim Färben hoch" sind mit einer echten (orthografischen/leicht gekippten) Kamera + [`InstancedMesh`](https://threejs.org/docs/#api/en/objects/InstancedMesh) trivial und GPU-billig; in jeder 2D-Engine wird jedes einzelne dieser Features ein eigener Fake-Trick. Per-Instanz-Farbe/-Höhe (`setColorAt`, eigene Instanz-Attribute) ist genau der Mechanismus für „Zelle wechselt Besitzer + weiche Animation" ([Quellcode-Beleg](https://github.com/mrdoob/three.js/blob/dev/src/objects/InstancedMesh.js)).
- **Performance-Rechnung ist harmlos:** Nur der Viewport-Ausschnitt (~2–6k Zellen) muss als Instanzen existieren, gechunkt zu je einem Draw Call; Deltas ändern nur Instanz-Buffer eines Chunks. 100 Entities sind vernachlässigbar. Das ist Standard-Instancing, kein Neuland.
- **PixiJS als Fallback**, falls der Prototyp (Ticket 07) zeigt, dass ein flacherer Look reicht oder das 3D-Setup zu teuer wird: TS-first-Codebase, exzellente 2D-Performance, Chunk-`RenderTexture`s passen perfekt auf das Delta-Protokoll. Aber: **pixi-projection ist tot** (letzter npm-Publish 2023, nur Pixi v7 — verifiziert), der 2.5D-Look müsste komplett selbst gefakt werden.
- **Phaser 4 scheidet aus:** Framework-Ballast (Physik/Scenes/Loader) neben unserer eigenen Sim, Renderer erst seit 2026-04 komplett neu (jung), reine JS-Codebase, kein 3D. **Babylon.js** ist die TS-first-Alternative *innerhalb* der 3D-Schiene (Thin Instances, `NullEngine` für Headless-Tests), aber schwergewichtiger und für unseren Scope Overkill. **Natives Canvas2D/WebGL** ist als Start zu teuer (eigene Engine schreiben), liefert aber das Architektur-Muster: splix.io rendert mit purem Canvas2D, OpenFront.io mit einem selbstgebauten WebGL2-Pass-Renderer als „pure data sink" über der Sim — genau diese Renderer-als-austauschbare-Schicht-Architektur übernehmen wir, nur mit three.js statt Roh-WebGL.

---

## Vergleichstabelle

Alle Zahlen abgerufen 2026-07-18 (npm / GitHub-API / bundlephobia-API / jsDelivr).

| Kriterium | **PixiJS** | **Phaser** | **three.js** | **Babylon.js** | **Canvas2D/WebGL nativ** |
|---|---|---|---|---|---|
| **Version / Release** | [8.19.0](https://www.npmjs.com/package/pixi.js) (npm-Publish 2026-06-04) | [4.2.1](https://www.npmjs.com/package/phaser) (2026-07-09); v4.0.0 am [2026-04-10](https://github.com/phaserjs/phaser/releases/tag/v4.0.0) | [0.185.1 / r185](https://github.com/mrdoob/three.js/releases/tag/r185) (2026-07-01) | [@babylonjs/core 9.17.0](https://www.npmjs.com/package/@babylonjs/core) (2026-07-16) | — (Web-Standard) |
| **Perf-Strategie für unsere Map** | Chunk-[`RenderTexture`](https://pixijs.download/release/docs/rendering.RenderTexture.html)s (nur Dirty-Chunk neu zeichnen) oder [@pixi/tilemap v5](https://github.com/pixijs/tilemap) | [`TilemapGPULayer`](https://docs.phaser.io/api-documentation/class/tilemaps-tilemapgpulayer): ganze Layer als 1 Quad, „up to 4096×4096 tiles" ([Release-Notes](https://github.com/phaserjs/phaser/releases/tag/v4.0.0)) | [`InstancedMesh`](https://threejs.org/docs/#api/en/objects/InstancedMesh) pro Chunk, Per-Instanz-Farbe/-Höhe, Delta = partielles Buffer-Update | [Thin Instances](https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances) pro Chunk (`thinInstanceSetBuffer` matrix+color) | Offscreen-Canvas pro Chunk + Blit (splix-Muster) bzw. eigene Textur-/Pass-Pipeline (OpenFront-Muster) |
| **2.5D-Eignung** | Fake: Extrusion in Chunk-Textur baken, Skew; echter Tilt nur via Tricks ([`PerspectiveMesh`](https://pixijs.download/release/docs/scene.PerspectiveMesh.html) = nur 2D-Quad-Projektion); pixi-projection **tot** | Fake über vorgerenderte Assets; kein 3D-Kamera-Modell; Filter/Lighting seit v4 vorhanden, aber 2D | **Nativ**: Ortho-/Perspektiv-Kamera mit Tilt, echte Boxen, Licht/Schatten, Höhen-Animation im Instanz-Attribut | **Nativ**: wie three (echtes 3D, PBR, Schatten) | Alles selbst schreiben (Projektionsmatrix, Extrusion, Beleuchtung) |
| **TypeScript** | **TS-first** (Codebase ~97 % TS, [GitHub-Sprachstatistik](https://api.github.com/repos/pixijs/pixijs/languages)), first-party `.d.ts` | JS-Codebase (16,6 MB JS vs. 58 kB TS), generierte first-party Types (`types/phaser.d.ts`); [`Phaser.HEADLESS`](https://github.com/phaserjs/phaser/blob/master/src/const.js) für Unit-Tests | JS-Codebase; **keine** first-party Types, Community-Types [@types/three 0.185.1](https://www.npmjs.com/package/@types/three) (Versionsparität zu r185) | **TS-first** (37 MB TS), first-party Types; [`NullEngine`](https://doc.babylonjs.com/typedoc/classes/BABYLON.NullEngine) für Headless/CI | TS-Qualität = eigene Codequalität; maximal testbar |
| **Bundle (gzip)** | ~251 kB (voller Import, [bundlephobia](https://bundlephobia.com/package/pixi.js)) | ~348 kB ([dist/phaser.min.js](https://cdn.jsdelivr.net/npm/phaser@4.2.1/dist/phaser.min.js) = 1,38 MB min, gzip via CDN gemessen) | ~182 kB voller Import ([bundlephobia](https://bundlephobia.com/package/three)); tree-shakeable, real deutlich weniger | UMD-Komplettbuild ~1,77 MB gzip (jsDelivr gemessen); ESM [tree-shakeable](https://doc.babylonjs.com/setup/frameworkPackages/es6Support) ⚠️ getrimmte Grösse ungetestet | ~0 |
| **Gesundheit (2026-07-18)** | 47,8k ★, Push 2026-07-13, MIT | 40,0k ★, Push 2026-07-09, MIT, Phaser Studio | 113,8k ★, Push 2026-07-18, MIT; Kadenz 2026: ~alle 2–3 Monate (r183 Feb, r184 Apr, r185 Jul) | 25,8k ★, Push 2026-07-17, Apache-2.0 | — |
| **WebGPU** | First-party [WebGPURenderer](https://pixijs.com/8.x/guides/components/renderers), offiziell „still maturing", WebGL für Produktion empfohlen | Kein WebGPU (v4 = WebGL-Rewrite; [Canvas deprecated](https://github.com/phaserjs/phaser/blob/master/changelog/v4/4.0/MIGRATION-GUIDE.md)) | [`WebGPURenderer`](https://github.com/mrdoob/three.js/tree/dev/src/renderers/webgpu) im Core (`three/webgpu`) | [„implementation … complete"](https://doc.babylonjs.com/setup/support/webGPU/webGPUStatus), WebGL & WebGPU featuregleich | selbst implementieren |

---

## Detail pro Kandidat

### 1. PixiJS v8 — Fallback-Empfehlung

**Fakten (abgerufen 2026-07-18):**

- npm [`pixi.js` 8.19.0](https://www.npmjs.com/package/pixi.js), publiziert 2026-06-04; Repo [pixijs/pixijs](https://github.com/pixijs/pixijs): 47 815 Stars, letzter Push 2026-07-13, MIT.
- **In TypeScript geschrieben** (GitHub-Sprachstatistik: ~5,78 MB TS vs. 0,16 MB JS) — first-party Typen, kein `@types`-Paket nötig.
- Bundle: 881 kB min / **251 kB gzip** bei vollem Import (bundlephobia-API, 2026-07-18); v8 ist ESM/tree-shakeable.
- Renderer: WebGL (default, „Well supported and stable") + WebGPU (first-party, aber offiziell: WebGPU „still maturing … we advise using the WebGL renderer for production" — [Renderer-Guide](https://pixijs.com/8.x/guides/components/renderers)). `autoDetectRenderer()` wählt automatisch.

**Render-Strategie für unser Spiel:**

- **Gefärbte Fläche:** Ein [`RenderTexture`](https://pixijs.download/release/docs/rendering.RenderTexture.html) pro Karten-Chunk (z. B. 64×64 Zellen → 512×512-px-Textur bei 8 px/Zelle), angezeigt als normale Sprites im Welt-Container. `UPDATE_BLOCKS`/`FILL_AREA`-Deltas zeichnen nur die betroffenen Zellen in die betroffene Chunk-Textur nach (`renderer.render({ target: rt, clear: false })`) — pro Frame null Kosten für unveränderte Fläche. Das passt 1:1 auf das splix-Chunk-Protokoll. Alternative: [@pixi/tilemap v5](https://github.com/pixijs/tilemap) (offizielle Kompatibilitätstabelle: Tilemap v5.x ↔ PixiJS v8.x; peerDependency `pixi.js >= 8.5.0` [laut npm](https://www.npmjs.com/package/@pixi/tilemap)).
- **Entities/Trails:** ~100 Sprites + Graphics/Mesh-Strips — für Pixi trivial (Batch-Renderer).
- **2.5D-Look:** Hier liegt das Problem. Optionen sind alle Fakes:
  - Blockhöhe/Schatten in die Chunk-Textur **baken** (Top-Face + dunklere „Seitenwand" nach unten versetzt zeichnen) — statisch okay, aber die *Färbe-Animation mit hochwachsenden Blöcken* muss dann als separate Overlay-Sprite-Animation über der Textur laufen, bevor sie eingebrannt wird.
  - Kamera-Tilt: global nur affiner Skew (kein Fluchtpunkt) oder Welt → RenderTexture → [`PerspectiveMesh`](https://pixijs.download/release/docs/scene.PerspectiveMesh.html) (offiziell: „a 2d plane with perspective … **This is not a full 3D mesh**") — kostet eine zusätzliche Fullscreen-Pass-Indirektion.
  - **pixi-projection ist keine Option:** npm-Latest [1.0.0 vom 2023-04-24](https://www.npmjs.com/package/pixi-projection), peerDependencies `@pixi/* ^7.2.0` („Projections … for pixi v^7"), README nennt sogar nur [„Works with PixiJS v6"](https://github.com/pixijs/pixi-projection); Repo: 199 Stars, letzter Push 2025-02-11, keine v8-Unterstützung. **Verifiziert veraltet.**

**Risiken:** Jedes Look-Feature (Höhe, Tilt, Schatten, Wachs-Animation) ist ein eigener handgebauter Trick ohne Engine-Unterstützung; die Summe der Fakes kann teurer (Entwicklungszeit) und optisch schlechter werden als echtes 3D. Headless-/Node-Betrieb für Tests ist in v8 kein offiziell gepflegter Pfad ⚠️ (nicht verifiziert; Testbarkeit der Sim ist davon unabhängig, da Sim engine-frei).

### 2. Phaser 4 — ausgeschieden

**Fakten (abgerufen 2026-07-18):**

- **Phaser 4 ist released:** v4.0.0 am [2026-04-10](https://github.com/phaserjs/phaser/releases/tag/v4.0.0) („ground-up rebuild of the WebGL renderer with a completely new architecture"), aktuell [4.2.1](https://www.npmjs.com/package/phaser) (2026-07-09). Repo: 39 979 Stars, MIT, Phaser Studio.
- Renderer-Rewrite: Render-Node-Architektur; [Migration-Guide](https://github.com/phaserjs/phaser/blob/master/changelog/v4/4.0/MIGRATION-GUIDE.md): „**Canvas Renderer Deprecated** … we recommend WebGL for all new projects". Kein WebGPU.
- Neue GPU-Layer sind beachtlich: **`SpriteGPULayer`** („Render a million sprites in a single draw call") und **`TilemapGPULayer`** („Render an entire tilemap layer as a single quad. Per-pixel shader cost means up to 4096 x 4096 tiles with no performance penalty") — [Release-Notes v4.0.0](https://github.com/phaserjs/phaser/releases/tag/v4.0.0), [API-Doku](https://docs.phaser.io/api-documentation/class/tilemaps-tilemapgpulayer).
- TypeScript: Codebase bleibt **JavaScript** (GitHub-Sprachstatistik: 16,6 MB JS vs. 0,06 MB TS); Typen werden als generierte `types/phaser.d.ts` mitgeliefert (npm-`types`-Feld). [`Phaser.HEADLESS`](https://github.com/phaserjs/phaser/blob/master/src/const.js)-Modus existiert, laut JSDoc „meant for unit testing".
- Bundle: `dist/phaser.min.js` = 1 375 976 Bytes; ~348 kB gzip (jsDelivr, komprimierter Transfer gemessen; bundlephobia-API lieferte für phaser keinen Wert ⚠️).

**Render-Strategie für unser Spiel:** `TilemapGPULayer` würde das 600×600-Grid als *einen* Quad rendern (Besitzfarbe = Tile-Index, `putTileAt` pro Delta) — technisch die eleganteste Flat-Map-Lösung aller Kandidaten. Entities über Sprites oder `SpriteGPULayer`.

**Warum trotzdem ausgeschieden:** (a) Wir brauchen von Phaser genau das Subsystem *Rendering* — Physik, Scene-Manager, Input, Loader, Sound sind Ballast neben unserer eigenen, engine-unabhängigen Sim; (b) kein 3D-Kamera-Modell → der 2.5D-Look ist genauso Fake-Arbeit wie bei Pixi, nur in einem größeren Framework; (c) der komplett neue Renderer ist erst ~3 Monate alt (Reifegrad ⚠️); (d) JS-Codebase mit generierten Typen ist die schwächste TS-Story im Feld.

### 3. three.js — 1. Wahl

**Fakten (abgerufen 2026-07-18):**

- npm [`three` 0.185.1](https://www.npmjs.com/package/three) = [r185](https://github.com/mrdoob/three.js/releases/tag/r185) (2026-07-01). Repo [mrdoob/three.js](https://github.com/mrdoob/three.js): **113 821 Stars**, letzter Push 2026-07-18 (heute), MIT.
- Release-Kadenz: ⚠️ **nicht mehr streng monatlich** — live verifiziert über die [Releases-Seite](https://github.com/mrdoob/three.js/releases): r181 2025-11-19, r182 2025-12-10, r183 2026-02-20, r184 2026-04-16, r185 2026-07-01 → 2026 eher alle 2–3 Monate. Aktivität im Repo ist ungebrochen hoch (Push heute).
- Bundle: 726 kB min / **182 kB gzip** bei vollem Import (bundlephobia-API); ESM, tree-shakeable (0 Dependencies) — reale App-Bundles deutlich kleiner.
- TypeScript: Codebase ist JavaScript; **keine first-party Types** (npm-`types`-Feld leer). Community-Typen [@types/three](https://www.npmjs.com/package/@types/three) sind aktuell **0.185.1** — exakte Versionsparität zu r185, d. h. die Typen werden im Gleichschritt gepflegt.
- WebGPU: [`WebGPURenderer`](https://github.com/mrdoob/three.js/tree/dev/src/renderers/webgpu) liegt im Core-Quellbaum (`three/webgpu`-Entry). Für uns nice-to-know; Baseline bleibt der WebGL-Renderer.

**Render-Strategie für unser Spiel:**

- **Gefärbte Fläche = Chunked Instancing.** [`InstancedMesh`](https://threejs.org/docs/#api/en/objects/InstancedMesh)-JSDoc (Quellcode, verifiziert): „Use this class if you have to render a large number of objects with the same geometry and material(s) but with different world transformations … reduce the number of draw calls". Konkret: pro 64×64-Chunk ein `InstancedMesh` aus einer Box-Geometrie (4096 Instanzen = 1 Draw Call); Besitzfarbe über [`setColorAt`/`instanceColor`](https://github.com/mrdoob/three.js/blob/dev/src/objects/InstancedMesh.js) (im Quellcode verifiziert), Blockhöhe/Färbe-Fortschritt als zusätzliches `InstancedBufferAttribute`. Ein `FILL_AREA`-Delta wird zu einem partiellen Buffer-Update genau eines Chunks (`needsUpdate` + Update-Range). Nur Chunks im/nahe dem Viewport werden überhaupt instanziert (600×600 gesamt, aber sichtbar sind ~2–6k Zellen); Frustum-Culling pro Chunk ist eingebaut. Unbesetzte Zellen sind eine einzige flache Boden-Plane.
- **Färbe-Animation:** Beim `FILL_AREA` bekommt jede betroffene Instanz eine Startzeit ins Attribut; ein kleiner Vertex-Shader-Zusatz (via `onBeforeCompile` oder `ShaderMaterial`) lässt die Blöcke zeitversetzt „hochwachsen" — **null CPU-Kosten pro Frame**, die Welle läuft komplett auf der GPU. Das ist exakt der Paper.io-2-Effekt.
- **Entities/Trails:** ~100 normale Meshes (vernachlässigbar); Trails sind im Grid-Spiel selbst Zellen → gleiche Instancing-Pipeline mit halber Höhe/Transparenz.
- **2.5D-Look:** `OrthographicCamera` (oder Perspektive mit langer Brennweite) mit ~50–60° Tilt, eine `DirectionalLight`; Schatten auf Mobile nicht per Shadow-Map über die ganze Karte, sondern gebakte Kantenabdunklung + Blob-Schatten unter Spielfiguren (Shadow-Maps sind der einzige echte Mobile-Kostenpunkt und hier verzichtbar).
- **Trennbarkeit/Testbarkeit:** Szenengraph ist DOM-frei instanziierbar (nur der `WebGLRenderer` braucht einen Canvas/Kontext) — der Adapter „Sim-State → Instanz-Buffer" ist ohne Browser unit-testbar; der Renderer bleibt eine dünne, austauschbare Schicht (gleiches Muster wie OpenFronts `MapRenderer`-Fassade, s. u.).

**Risiken:** (a) 3D-Grundwissen nötig (Kamera, Materialien, Buffer) — höhere Einstiegsschwelle als „Sprites platzieren"; (b) keine first-party Types (Mitigation: @types/three ist nachweislich versionsgleich gepflegt); (c) `0.x`-Versionierung = keine SemVer-Garantien, Breaking Changes zwischen r-Releases möglich (Mitigation: Version pinnen, Migrations-Guide pro Release); (d) Release-Kadenz hat sich 2026 verlangsamt ⚠️ (2–3 Monate statt monatlich — bei 113k Stars und täglicher Commit-Aktivität kein Alarmsignal, aber beobachten).

### 4. Babylon.js — starke Alternative in der 3D-Schiene, aber Overkill

**Fakten (abgerufen 2026-07-18):**

- npm [`@babylonjs/core` 9.17.0](https://www.npmjs.com/package/@babylonjs/core), publiziert 2026-07-16 (vor 2 Tagen). Repo [BabylonJS/Babylon.js](https://github.com/BabylonJS/Babylon.js): 25 825 Stars, Push 2026-07-17, **Apache-2.0**.
- **TS-first**: Codebase ~37 MB TypeScript (GitHub-Sprachstatistik), first-party Typen.
- Bundle: UMD-Komplettbuild `babylon.js` ≈ 7,9 MB min / **~1,77 MB gzip** (jsDelivr gemessen); die ESM-Pakete sind offiziell [tree-shakeable](https://doc.babylonjs.com/setup/frameworkPackages/es6Support) („Babylon.js ES6 support with Tree Shaking") — ⚠️ wie klein ein getrimmter Build für unseren Scope real wird, ist ungetestet (bundlephobia-API lieferte für @babylonjs/core keinen Wert).
- WebGPU: offizieller Status „The implementation in WebGPU is complete and, besides a few exceptions, all features are available both in WebGPU and WebGL" ([WebGPU-Status-Doku](https://doc.babylonjs.com/setup/support/webGPU/webGPUStatus)) — die reifste WebGPU-Story im Feld.

**Render-Strategie für unser Spiel:**

- **Gefärbte Fläche = [Thin Instances](https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances)** pro Chunk: „Thin instances don't create new objects so you don't incur any penalty on the javascript side by having thousands of them" (offizielle Doku). Matrizen + Farben als Buffer: `thinInstanceSetBuffer("matrix", …, 16, false)` / `thinInstanceSetBuffer("color", …, 4, false)`, Delta-Updates via `thinInstanceBufferUpdated` (alles in der Doku belegt). Caveat aus der Doku: Thin Instances werden „all or nothing" gezeichnet — deshalb chunken wir (Culling pro Chunk-Mesh), genau wie bei three.
- **2.5D/Look/Testbarkeit:** wie three (echtes 3D); Plus: [`NullEngine`](https://doc.babylonjs.com/typedoc/classes/BABYLON.NullEngine) rendert ohne Canvas/DOM — offizieller Headless-Pfad für CI-Tests des Render-Adapters (Klasse existiert im aktuellen Quellbaum: [`Engines/nullEngine.ts`](https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/core/src/Engines/nullEngine.ts)).

**Risiken:** Deutlich größere API-Oberfläche und Bundle-Grundlast als three; die Engine zielt auf vollwertige 3D-Anwendungen (PBR, Physik, XR) — für „gefärbte Boxen auf einem Grid" tragen wir viel ungenutztes Gewicht. Wählen, wenn TS-first + `NullEngine`-Testbarkeit im Team höher gewichtet werden als Schlankheit/Community-Grösse.

### 5. Natives Canvas2D/WebGL ohne Framework — Referenz-Architektur, kein Startpunkt

**Genre-Evidenz (beide Repos am 2026-07-18 geprüft):**

- **splix.io rendert mit purem Canvas 2D:** Der offene Client ([jespertheend/splix](https://github.com/jespertheend/splix), MIT, Push 2026-05-07) nutzt in [`client/src/main.js`](https://github.com/jespertheend/splix/blob/main/client/src/main.js) ausschliesslich `getContext("2d")` (Haupt-Canvas, Minimap, Lines-, Temp-, Transition-Canvas — Zeilen ~1296–1306), kein WebGL. Beweist: der *flache* splix-Look läuft auch ohne GPU-Framework. Für unseren 2.5D-Anspruch reicht Canvas2D aber nicht (keine 100k-Zellen-Extrusion mit Beleuchtung bei 60 fps auf Mobile).
- **OpenFront.io hat einen kompletten Eigenbau-WebGL2-Renderer:** [package.json](https://github.com/openfrontio/OpenFrontIO/blob/main/package.json) enthält **kein** Rendering-Framework (kein pixi/three/babylon); stattdessen [`src/client/render/`](https://github.com/openfrontio/OpenFrontIO/tree/main/src/client/render) mit eigener Pass-Pipeline (`BorderComputePass`, `LightmapPass`, `NightCompositePass`, …). Deren Render-Architektur-Doku beschreibt exakt unser Zielmuster: „The simulation runs at ~10Hz on a worker thread. The renderer draws at 60fps", Sim-State → `FrameData` → `MapRenderer` als „public facade" und „pure data sink" mit WebGL-Context-Loss-Recovery ([render/CLAUDE.md](https://github.com/openfrontio/OpenFrontIO/blob/main/src/client/render/CLAUDE.md), [MapRenderer.ts](https://github.com/openfrontio/OpenFrontIO/blob/main/src/client/render/gl/MapRenderer.ts)).

**Einschätzung:** Volle Kontrolle und null Abhängigkeiten, aber man schreibt de facto eine eigene Engine (OpenFronts `render/gl/` umfasst dutzende Dateien inkl. Kamera, Buffer-Management, 25+ Passes). Das ist ein valider *Endzustand* für ein ausgereiftes Spiel, aber der falsche *Startpunkt* für einen Look-&-Feel-Prototyp. **Was wir übernehmen:** die Architektur (Renderer als Fassade/Data-Sink über der Sim, Sim-Tick ↔ Render-Frame entkoppelt, Context-Loss-Handling) — umgesetzt mit three.js statt Roh-WebGL.

### Ökosystem-Bausteine (Kurzprüfung, 2026-07-18)

| Baustein | Status | Beleg |
|---|---|---|
| **pixi-projection** | **Tot für Pixi v8.** Letzter npm-Publish 1.0.0 am 2023-04-24, peerDeps `@pixi/* ^7.2.0`; README: „Works with PixiJS v6". Repo-Push 2025-02-11, 199 ★ | [npm](https://www.npmjs.com/package/pixi-projection), [README](https://github.com/pixijs/pixi-projection) |
| **@pixi/tilemap** | Gepflegt für Pixi v8 (v5.x ↔ v8.x lt. offizieller Tabelle), v5.0.2 vom 2025-07-14; seither ruhig (Push = Release-Datum) ⚠️ Wartung „funktional, nicht lebhaft" | [npm](https://www.npmjs.com/package/@pixi/tilemap), [README](https://github.com/pixijs/tilemap) |
| **Phaser 4** | Released (4.0.0 am 2026-04-10, aktuell 4.2.1); kompletter WebGL-Renderer-Rewrite, Canvas deprecated | [Releases](https://github.com/phaserjs/phaser/releases), [Migration-Guide](https://github.com/phaserjs/phaser/blob/master/changelog/v4/4.0/MIGRATION-GUIDE.md) |
| **three.js-Kadenz** | r181→r185 zwischen 2025-11 und 2026-07 → ~alle 2–3 Monate (nicht mehr monatlich), Repo-Aktivität täglich | [Releases](https://github.com/mrdoob/three.js/releases) |
| **Babylon-Major** | v9-Linie, 9.17.0 vom 2026-07-16 (Release-Frequenz: wöchentlich+) | [Releases](https://github.com/BabylonJS/Babylon.js/releases) |
| **WebGPU** | Pixi: first-party, „still maturing", WebGL für Prod empfohlen · three: `WebGPURenderer` im Core · Babylon: „complete" · Phaser: nein. Für uns irrelevant fürs Zielbild — Mittelklasse-Handys = WebGL2-Baseline | s. Links in Tabelle oben |

---

## Empfehlung im Detail

**1. Wahl: three.js (r185, MIT), Renderer als dünne Schicht nach OpenFront-Muster.**

Begründung entlang der Kriterien:

1. **Performance:** Die Anforderung „grosse, sich per Delta ändernde gefärbte Fläche" mappt auf das billigste GPU-Muster überhaupt: statische Instanz-Geometrie, Delta = kleines Buffer-Update, 1 Draw Call pro Chunk. ~5k sichtbare Boxen + 100 Entities sind für WebGL2 auf Mittelklasse-Handys eine sehr kleine Last (Grössenordnung: einstellige Draw-Call-Zahl, <100k Vertices). ⚠️ Es gibt keine offiziellen Mobile-Benchmarks für genau dieses Szenario — das ist eine aus der Render-Strategie abgeleitete Einschätzung und der Kernauftrag des Prototyps (Ticket 07).
2. **2.5D:** Der einzige Kandidat neben Babylon, bei dem der gewünschte Look (Höhe, Tilt, Schatten, Wachs-Animation) *keine* Fakes braucht. Die Färbe-Welle läuft als Vertex-Shader-Animation komplett auf der GPU.
3. **TypeScript:** Schwächster Punkt (Community-Types statt first-party), aber @types/three ist nachweislich versionsgleich (0.185.1 ↔ r185). Die Sim bleibt ohnehin engine-frei; nur der schmale Render-Adapter berührt three-Typen.
4. **Gesundheit:** Grösstes Projekt im Feld (113,8k ★), MIT, tägliche Aktivität, 182 kB gzip voll / weniger getrimmt.

**Fallback: PixiJS v8.** Ausweichen, wenn der Prototyp eines von beidem zeigt: (a) der 2.5D-Anspruch wird zugunsten eines flachen/stilisierten Looks reduziert (dann ist Pixi die einfachere, TS-first Lösung mit Chunk-RenderTextures), oder (b) das three-Setup verfehlt das 60-fps-Ziel auf den Referenzgeräten bzw. die 3D-Komplexität bremst das Team messbar. Wichtig: Wegen des toten pixi-projection darf der Pixi-Pfad **nicht** mit „Projection-Plugin" geplant werden — nur Bake-/Skew-/PerspectiveMesh-Tricks.

**Babylon.js** bleibt dokumentierte Alternative, falls im Verlauf first-party TS + `NullEngine`-Headless-CI wichtiger werden als Schlankheit — der Wechsel three↔Babylon ist dank identischer Render-Strategie (Instancing pro Chunk) und dünnem Adapter bewusst billig gehalten. **Phaser** und **Roh-WebGL** sind begründet ausgeschieden (s. o.).

**Was der Look-&-Feel-Prototyp (Ticket 07) konkret validieren soll:**

1. **Mobile-Framerate:** 600×600-Karte (Dummy-Daten im splix-Format), Kamera über einem dicht gefärbten Gebiet, 100 animierte Entities, kontinuierliche `FILL_AREA`-Deltas (z. B. 5/s à 200–2000 Zellen) → stabile 60 fps auf einem echten Mittelklasse-Android (z. B. 2–3 Jahre alte Geräteklasse), gemessen mit devtools/`requestAnimationFrame`-Timing.
2. **Der Look selbst:** Ortho-Kamera-Tilt + Blockhöhe + Kantenabdunklung/Blob-Schatten + Hochwachs-Animation beim Färben und Abtauch-/Farbwechsel beim Durchfahren fremder Flächen — fühlt es sich nach Paper.io 2 an? (Ästhetik-Entscheid, nicht messbar.)
3. **Delta-Update-Kosten:** Worst-Case-`FILL_AREA` (grosses Gebiet über mehrere Chunks) → Frame-Spike messen; Budget: Buffer-Updates < 2 ms.
4. **Adapter-Schnitt:** Render-Adapter konsumiert ausschliesslich Sim-State/Deltas (kein Rückkanal), Sim-Tickrate ≠ Framerate (Interpolation der Entity-Positionen), Context-Loss-Recovery — Muster wie OpenFronts `MapRenderer`.
5. **Bundle-Realität:** getrimmter three-Import gemessen (Ziel: deutlich unter den 182 kB gzip des Vollimports).
6. **Fallback-Absicherung (klein):** dieselbe Szene einmal flach in Pixi (Chunk-RenderTexture) anreissen, um den Aufwandsvergleich nicht theoretisch zu führen.

---

## Verifikationsstatus

**Verifiziert (Primärquelle am 2026-07-18 abgerufen):**

- Versionen + Publish-Daten via npm-Registry-API: pixi.js 8.19.0 (2026-06-04), phaser 4.2.1 (2026-07-09), three 0.185.1 (2026-07-01), @babylonjs/core 9.17.0 (2026-07-16), @pixi/tilemap 5.0.2 (2025-07-14), pixi-projection 1.0.0 (2023-04-24), @types/three 0.185.1.
- Stars/letzter Push/Lizenz via GitHub-REST-API (Zahlen s. Tabelle); Release-Daten via GitHub-Releases-API (inkl. Phaser v4.0.0 = 2026-04-10; three r181–r185-Daten).
- Sprachstatistiken (TS vs. JS) via GitHub-Languages-API für alle vier Engines.
- pixi-projection-Inkompatibilität mit Pixi v8 (npm-peerDeps ^7.2.0 + README) — **bestätigt veraltet**.
- @pixi/tilemap↔Pixi-v8-Kompatibilität (README-Tabelle + npm-peerDep `>=8.5.0`).
- Phaser-4-Renderer-Rewrite, `TilemapGPULayer`/`SpriteGPULayer`, Canvas-Deprecation (Release-Notes + Migration-Guide im Repo).
- three `InstancedMesh`-JSDoc, `setColorAt`/`instanceColor` (Quellcode dev-Branch); Existenz `src/renderers/webgpu/WebGPURenderer.js`.
- Babylon Thin-Instances-API inkl. Farb-Buffer und Update-Semantik (Doku-Markdown im Documentation-Repo); WebGPU-Status-Zitat (ebd.); ES6-Tree-Shaking-Doku; `nullEngine.ts` existiert im Quellbaum.
- Pixi-Renderer-Guide-Aussagen zu WebGL/WebGPU (pixijs.com); `RenderTexture`- und `PerspectiveMesh`-API-Doku (pixijs.download).
- splix.io-Client = Canvas2D (`getContext("2d")` in `client/src/main.js`); OpenFront = eigener WebGL2-Pass-Renderer ohne Framework-Dependency (package.json + `src/client/render/` + render/CLAUDE.md).
- Bundle-Messungen: bundlephobia-API (pixi.js, three); jsDelivr-Dateigrössen/komprimierter Transfer (phaser, babylon UMD).

**⚠️ Unsicher / nicht abschliessend verifiziert:**

- **Mobile-60-fps-Aussagen:** abgeleitete Einschätzung aus Render-Strategien; keine offiziellen Benchmarks für unser Szenario — Prototyp-Auftrag.
- **Babylon getrimmte Bundle-Grösse:** nur UMD-Komplettbuild gemessen (~1,77 MB gzip); tree-geshakter Wert unbekannt. bundlephobia-API lieferte für phaser und @babylonjs/core keine Werte (Timeouts) — Ersatzmessung via jsDelivr, Methodik genannt.
- **Pixi-v8-Headless/Node-Betrieb:** nicht geprüft, kein offizieller Pfad gefunden.
- **@pixi/tilemap-Wartungstiefe:** kompatibel mit v8, aber seit 2025-07 keine Aktivität — funktional gepflegt, nicht lebhaft.
- **Phaser-4-Renderer-Reife:** Rewrite erst seit 2026-04 in Stable; Praxis-Reifegrad nicht bewertbar.
- **Paper.io 2 (Look-Referenz):** native Mobile-App; womit Voodoo rendert, ist nirgends offiziell dokumentiert (mutmasslich Unity — reine Vermutung, keine Quelle).
- **three-WebGPU-Produktionsreife:** Existenz im Core verifiziert, Reifegrad nicht tiefer geprüft (für uns nicht entscheidungsrelevant, WebGL2-Baseline).
