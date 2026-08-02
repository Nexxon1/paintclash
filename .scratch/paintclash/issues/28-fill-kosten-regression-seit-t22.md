# 28 — Fill-Kosten-Regression: der Ticket-22-Akzeptanzbench ist auf `main` rot

**Beobachtung (2026-08-02, beim Bau der 1 800-s-Basislinie für [Ticket 23](23-fill-vertexzahl-wachstum.md)):**
`pnpm --filter @paintclash/bench-fill-budget bench` — der Regressions-Halt, den Ticket 22
grün gestellt und in seiner Akzeptanz festgeschrieben hat — **fällt auf `main`** in der
200-WU-Arena. Der Bench selbst ist unverändert; gemessen wurde mit demselben gepinnten
Seed (20260730) auf derselben Maschine.

| 200 WU · 8 Bots · 5 min | Ticket 22 (Akzeptanz) | `main` 2026-08-02 |
|---|---|---|
| max/Tick | 36–43 ms | **103,20 ms** |
| Ticks über 50 ms | **0** | **57**, ab t = 192,2 s |
| p99 | — | 49,53 ms |
| Vertices bei t = 300 s | 4 285 (T23, Ansatz-3-Tabelle) | **7 342** |
| Fills | — | 1 368 |
| Tode | 6 | **1** |

(Die Vertex-Zeile vergleicht bewusst zwei **Momentaufnahmen** bei t = 300 s, nicht Peaks:
der Peak des heutigen 5-Minuten-Laufs liegt bei 7 408 und hat in T23 keine Entsprechung.)

Die 50-WU-Arena bleibt grün (0 Ticks über Budget) — wie in Ticket 23 ist es der **todarme**
Fall, der ausbricht.

**Blocked by:** —

**Status:** needs-triage

## Warum das mehr ist als „der Bench schwankt"

- **Der Pfad ist identisch, nicht ähnlich.** Der Seed ist gepinnt und die Bots sind reine
  Funktionen des Zustands: die Vertex-Zahl je Sekunde stimmt zwischen dem 5-Minuten- und
  dem 30-Minuten-Lauf an jedem gemeinsamen Zeitpunkt auf die Einheit überein (t = 30 s:
  1 473, t = 150 s: 4 395, t = 270 s: 6 459). Zwei Läufe fliegen denselben Pfad; was sich
  unterscheidet, ist die Geometrie, die dabei entsteht — nicht die Stoppuhr.
- **Die Grösse ist keine Streuung.** Der README des Benches beziffert die Lauf-zu-Lauf-
  Streuung des `max` auf ±10 %. Hier steht 103 ms gegen 36–43 ms.
- **Die Tode gehen in die falsche Richtung.** 1 statt 6 Tode in 5 min (200 WU) und 25 statt
  31 in 30 min. Tode setzen Gebiete auf 6×6-Blöcke zurück und sind laut Ticket 23 der
  einzige Mechanismus, der die Vertex-Zahl deckelt. Weniger Tode ⇒ mehr Rand ⇒ teurere
  Unions — das passt genau zum Bild.
- **Keine funktionale Suite sieht es.** Am selben Stand sind Root-Vitest (733 Tests),
  Szenario (hermetisch + Bots) und Playwright (22) **grün**. Das ist keine Entwarnung,
  sondern der Grund, warum es dieses Ticket braucht: die Regression ist reine
  *Kosten*, und Kosten prüft in diesem Repo ausschliesslich `bench/`. Was hier durchrutscht,
  merkt zuerst der Spieler.

## Verdächtigenkreis

Die letzte Messung ohne den Fund ist vom **2026-07-31** (Ticket 23, gemessen auf dem Stand
nach `b786fb6` = Ticket 22). Seitdem hat `packages/sim-core/src/` fünf Commits gesehen, von
denen drei netto etwas ändern:

| Commit | Ticket | Umfang in `sim-core` |
|---|---|---|
| `3e2682b` | 19 — a self-cut is a line crossing | `collision.ts`, `step.ts`, `geometry.ts`, Golden-Replay |
| `eb637ce` | 20 — erster Anlauf | **hebt sich auf** — von `f96bb66` vollständig revertiert |
| `f96bb66` | 20 — Revert von `eb637ce` | s. o. |
| `b167439` | 26 — a straight crossing is a loop too | `fill.ts`, `geometry.ts` |
| `e11ab96` | 20 — graze on own ground | `geometry.ts` (4 Zeilen), `index.ts` (Re-Export) |

Nicht in der Liste, weil ohne Produktionscode: `01657cb` (2026-07-31,
`test(sim-core)` — hält einen Property-Test im CI-Timeout).

**Die naheliegende Hypothese ist Ticket 26**, und zwar aus seiner eigenen Beschreibung:
es lässt Loops gelingen, die vorher nichts beitrugen (Dichtband für entartete Ringe).
Mehr gelungene Fills heisst mehr Gebiet je Zeiteinheit — und ein Bot, der seinen Loop
schliesst und heimkehrt, stirbt nicht auf dem Rückweg, was die gefallene Todeszahl
erklären würde. Ticket 19 ist der zweite Kandidat: es hat die Selbstschnitt-Erkennung
angefasst, also genau den Mechanismus, der Tode erzeugt.

**Das ist eine Hypothese, keine Messung.** Beide Tickets sind je für sich mit
Regressionstests belegt worden; keiner davon misst Kosten.

## Falle beim Nachmessen (einmal reingetreten, damit es niemand wiederholt)

`git checkout <alt> -- packages/sim-core/src/` und dann den Bench laufen lassen **misst
nichts Gültiges**. Der Harness fährt `BotPilot` aus `packages/server` auf HEAD-Stand; gegen
ein altes `sim-core` ergibt das eine Kombination, die es nie gab — konkret **0 Fills und
5 843 Tode** in 5 Minuten, also eine Arena, in der sofort alles stirbt. Wer bisecten will,
braucht einen vollständigen Worktree auf dem alten Commit samt eigenem `pnpm install`.

## Auftrag

- [ ] Den Commit bestimmen, ab dem der 5-Minuten-Bench rot wird (voller Worktree je
      Kandidat, `bench` bei 200 WU, ~40 s je Lauf).
- [ ] Entscheiden, ob das **erwünschtes Verhalten** ist. Ticket 26 hat eine echte Lücke
      geschlossen — mehr gelingende Fills sind Spielinhalt, nicht Fehler. Dann ist nicht
      der Commit das Problem, sondern dass die Kosten dieses Spielinhalts nie gemessen
      wurden, und der Fund gehört als neue Basislinie in Ticket 23 statt als Rückbau.
- [ ] Die Akzeptanzzahlen in `bench/fill-budget/README.md` und Ticket 22 auf den dann
      gültigen Stand bringen — im Moment beschreiben sie einen Zustand, den `main` nicht
      mehr hat.

## Warum das Ticket 23 blockiert

Ticket 23 wollte die Boolean-Engine gegen eine Dauerzustands-Basislinie tauschen. Solange
die Basislinie aus einer unverstandenen Regression stammt, misst jeder Vorher/Nachher-
Vergleich gegen einen kaputten Bezugspunkt — und die Sättigungs-Annahme, auf der Ticket 23
seinen Umfang begründet („NUR Ansatz 1"), hält gegen `main` nicht mehr (+33,3 % Vertex-
Drift über die zweite Hälfte des Laufs statt −1,8 %).

_Referenz: spec §2.2, §6.2, §9.2; ADR-0007; [Ticket 22](22-fill-kosten-tickbudget.md)
(Akzeptanz), [Ticket 23](23-fill-vertexzahl-wachstum.md) (Kommentar 2026-08-02),
[Ticket 26](26-gerade-gap-kreuzung-fuellt-nie.md), [Ticket 19](19-selbstschnitt-praezision.md)._

## Comments
