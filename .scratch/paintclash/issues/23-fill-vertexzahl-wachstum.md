# 23 — Fill-Kosten wachsen weiter mit der Vertex-Zahl (Rest aus Ticket 22)

**What to build:** Ticket 22 hat den berichteten Freeze beseitigt (max/Tick 189 → 36–43 ms
über 5 min, 0 Ticks über Budget) — aber mit **konstanten Faktoren**. Die Kosten wachsen
weiter mit der **Vertex-Zahl der Gebiete**, und die wächst in einer Arena ohne Tode
monoton. Ziel: die Kurve **flach** bekommen, nicht nur flacher.

**Blocked by:** — (unabhängig; T16 misst die Populationsgrenze gegen echte Infrastruktur
und liefert den Härtetest für das hier Entschiedene)

**Status:** needs-triage

## Der Rest, gemessen

`bench/fill-budget`, 8 Bots, Seed `20260730`, 5 min, nach T22:

| Arena | mean | p95 | max | Ticks > 50 ms | Vertices am Ende |
|---|---|---|---|---|---|
| 200 WU | 1,69 ms | 12,4 ms | **36–43 ms** | 0 | **5 244**, steigend |
| 50 WU | 1,25 ms | 6,4 ms | 23–25 ms | 0 | 1 671, pendelnd |

Zwei Dinge stehen dahinter:

1. **Die 200-WU-Kurve steigt noch.** Im letzten 30-s-Fenster liegt der Max bei ~85 % des
   Budgets, und die Vertex-Zahl wächst linear weiter. Bei 10 min ist die Arena wieder
   drüber. Grund ist keine Regression, sondern die Prämisse des Harness: **Bots töten
   einander kaum** (6 Tode in 5 min bei 200 WU), und nur Tode setzen Gebiete zurück. Die
   50-WU-Arena mit 96 Toden zeigt den erwarteten Sägezahn und pendelt stabil. Eine
   Produktions-Arena hat Menschen, also mehr Tode — aber „hängt davon ab, dass jemand
   stirbt" ist keine Schranke.
2. **Mit dem 4×-Hardware-Faktor** (Konvention aus T02) liegt p95 bei ~50 ms von 50 ms.
   Lokal grün heisst hier also **nicht** grün auf Cloudflare-Metal. Ob der Faktor für
   diese Last stimmt, weiss nur T16.

## Was Ticket 22 als Ansatz 3 vorschlug — und was die Messung dazu sagt

T22 nahm an, eine Toleranz-Simplifikation (Douglas-Peucker auf Lattice-Skala) in
`compactRing` würde „das unbegrenzte Wachstum stoppen". **Gemessen an echten, gesättigten
Gebieten (200 WU, 300 s, 4 285 Vertices) trägt das nicht:**

| Toleranz | nur nach innen (disjunkt-sicher) | zweiseitig (bricht Disjunktheit) |
|---|---|---|
| 0,01 WU | 1,03× weniger, −0,00 % Fläche | 1,04× |
| **0,05 WU** | **1,11×**, −0,03 % | 1,23× |
| 0,10 WU | 1,52×, −0,24 % | 2,95×, −0,33 % |
| 0,25 WU | 2,03×, **−1,16 %** | 6,90×, −7,6 % |
| 0,50 WU | 3,35×, **−4,42 %** | 20,5×, −41,5 % |

Zwei Befunde:

- **Die Vertices sind nicht redundant.** `appendTrailPoint` faltet gerade Strecken längst
  zusammen; was übrig bleibt, ist echtes Kurvenfahren. Bei einer Toleranz, die Geometrie
  ehrlich lässt (≤ 0,05 WU = 5 % der Trailbreite), holt die Simplifikation **11 %**.
- **Der Ausweg „zweiseitig" ist keiner.** Nur zweiseitige Vereinfachung bringt ~3×, und
  sie schiebt Grenzen **nach aussen** — direkt gegen die paarweise Disjunktheit (spec
  §9.2), die derselbe Ticket-Punkt grün halten wollte. Ausserdem ist der Kartenanteil der
  **Score** (§10.5): 1,2 % Fläche still abzuschneiden ist ein Scoring-Bug, kein Rundungsfehler.

Ansatz 3 ist damit **nicht** der Hebel, für den T22 ihn hielt. Wer die Kurve flach will,
braucht etwas anderes.

## Ansätze, die noch offen sind

- [ ] **Schnellere Boolean-Engine.** Nach T22 sind ~70 % der Fill-Zeit `union(territory,
      loop)` — eine einzige Op, deren Kosten allein an der Vertex-Zahl hängen. `polyclip-ts`
      (ADR-0007) ist eine reine JS-Martinez-Implementierung; ~5 ms für ~500 Vertices sind
      viel. Ein Clipper2-WASM-Port o. ä. wäre ein reiner Faktor ohne Semantik-Änderung.
      **Zuerst messen**, ob der Faktor gross genug ist, um ADR-0007 anzufassen.
- [ ] **Union nur gegen das berührte Stück.** Ein Gebiet ist ein Multipolygon; der Loop
      berührt meist genau ein Stück. Die übrigen Stücke sind vom Loop bbox-getrennt und
      könnten unverändert durchgereicht werden (dieselbe Beweisführung wie `skipsCarve`).
      Achtung: die Loch-Füllung darf dabei keine Pocket verlieren, die zwei Stücke
      gemeinsam einschliessen — das ist die Stelle, an der der Beweis schwierig wird.
- [ ] **Raster statt Polygon** — von T22 wieder geöffnet (s. Nachtrag in
      [`docs/benchmarks/do-cpu-benchmark.md`](../../../docs/benchmarks/do-cpu-benchmark.md)).
      Grösster Eingriff, grösste Wirkung: Kosten hingen dann an der Zellzahl, nicht an der
      Historie. Berührt ADR-0007 und §2.2 und rotiert alles.
- [ ] Akzeptanz: `pnpm --filter @paintclash/bench-fill-budget bench` mit **900 s** (nicht
      300 s) hält beide Arenen unter Budget, und die Vertex-Spalte zeigt im letzten
      Fenster **keinen Aufwärtstrend** mehr.
- [ ] Property-Tests §9.2 bleiben grün (Summe + neutral = 100 %, Disjunktheit, kein Loch).

_Referenz: spec §2.2, §6.2, §9.2; ADR-0003 (Determinismus), ADR-0007 (Boolean-Engine).
Aufgedeckt bei Ticket 22._
