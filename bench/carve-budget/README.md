# bench/carve-budget — Frame-Budget unter Carve-Last (Bau-Ticket 25)

Misst, ob der **client-seitige** Plateau-Carve (§4.1 Carve-Through) im 60-Hz-Frame bleibt,
während acht Bots die Karte über Minuten voll malen. Fährt den **echten** `sim-core`-`step`
und die **echten** `BotPilot`s für die Geometrie und den **echten** `PlateauCarver` des
Clients für den Carve — inklusive der Drosselung und der Band-Auswahl aus
`ArenaScene.updateTerritories`.

```sh
pnpm --filter @paintclash/bench-carve-budget test    # Prämisse: carven die Bots überhaupt? (~2 s)
pnpm --filter @paintclash/bench-carve-budget bench   # Akzeptanz: 5 min Arena-Zeit (~17 s)
```

Läuft bewusst **nicht** im Root-Test/Coverage-Gate (spec §9.3). Seed gepinnt (`20260730`) —
zwei Läufe fliegen denselben Pfad, nur die Stoppuhr unterscheidet sich.

Was fehlt: three.js und der GL-Upload. Das ist Absicht — der Frame, der in Produktion
einfror, hing im **Polygon-Clipper**, und dessen Arithmetik ist in Node dieselbe
(CPU-Profil des deployten Builds, Ticket 25). Der Mesh-Rebuild wird nur **gezählt**
(`rebuilds`), nicht gemessen.

## Stand nach Ticket 25

Der Befund war kein Skalierungsproblem: `polygon-clipping` **mahlte 0,7–2,6 s** an einem
~500-Vertex-Plateau minus zwei Nut-Quads und warf danach `unable to complete output ring`
— ein eingefrorener Tab _und_ eine Nut, die nie erschien. Auf ein Snap-Gitter gelegt
(dieselbe Medizin wie ADR-0007 für den Sim-Clipper) kostet dieselbe Operation **~1 ms**.

| 200 WU · 8 Bots · 5 min       | vorher       | nachher      |
| ----------------------------- | ------------ | ------------ |
| Carve pro Frame, mean         | 4,30 ms      | **0,96 ms**  |
| Carve pro Frame, max          | **4 407 ms** | **10–14 ms** |
| Frames über 16,7 ms           | 8            | **0**        |
| Frames über 200 ms («Freeze») | 6            | **0**        |

Der `max` **wächst weiter mit der Vertex-Zahl** (er fällt stets in die letzten
30-s-Fenster) und streut über Läufe spürbar — drei Läufe derselben Choreografie zeigten
10,1 / 12,1 / 14,3 ms. Das ist echte Arbeit, kein Ausreisser mehr; wird dieser Bench rot, ist das
darum kein Flake, sondern genau dieses Restwachstum. Die minimierte Form des alten
Fehlers steht als Regressionstest in `packages/client/src/render/carve.test.ts`
(«carves geometry that makes the raw clipper grind and throw»): drei Plateau-Vertices,
ein Trail — vor dem Gitter 3,1 s und ein Throw, danach Mikrosekunden.
