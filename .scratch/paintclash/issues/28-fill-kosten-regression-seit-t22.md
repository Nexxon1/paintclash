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

**Status:** resolved (2026-08-02) — zwei Commits, beide erwünscht, kein Rückbau; der Halt
sichert jetzt die Vertex-Zahl statt der Stoppuhr zu. S. Answer.

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

- [x] Den Commit bestimmen, ab dem der 5-Minuten-Bench rot wird (voller Worktree je
      Kandidat, `bench` bei 200 WU, ~40 s je Lauf). → **Zwei** Commits, nicht einer:
      `3e2682b` (T19) und `b167439` (T26), je 3 Läufe.
- [x] Entscheiden, ob das **erwünschtes Verhalten** ist. Ticket 26 hat eine echte Lücke
      geschlossen — mehr gelingende Fills sind Spielinhalt, nicht Fehler. Dann ist nicht
      der Commit das Problem, sondern dass die Kosten dieses Spielinhalts nie gemessen
      wurden, und der Fund gehört als neue Basislinie in Ticket 23 statt als Rückbau.
      → **Ja, beide.** Kein Rückbau.
- [x] Die Akzeptanzzahlen in `bench/fill-budget/README.md` und Ticket 22 auf den dann
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

## Answer

**Es sind zwei Commits, nicht einer, und beide tun genau das, wofür sie gebaut wurden.
Kein Rückbau.** Was fehlte, war nie ein Wächter gegen diese Änderungen — es war ein
Wächter, der die richtige Grösse misst.

### Die Bisektion

Volle Worktrees je Kandidat samt eigenem `pnpm install` (die Falle oben umgangen), **drei
Läufe je Commit**, 200 WU · 8 Bots · 5 min · Seed 20260730:

| Commit | mean | p95 | Ticks > 50 ms | Peak-Vertices | Schlüsse | leer | Tode |
|---|---|---|---|---|---|---|---|
| `b786fb6` (T22) | 1,90 ms | 13,9 ms | 0, 0, 2 | 5 244 | 1 222 | 62 | 6 |
| `3e2682b` (T19) | 3,12 ms | 20,6 ms | 15, 21, 23 | 6 635 | 1 368 | 66 | **1** |
| `b167439` (T26) | 3,68 ms | 24,9 ms | 40, 45, 63 | **7 408** | 1 368 | **35** | 1 |
| `c43ea08` (HEAD) | 3,72 ms | 25,6 ms | 52, 53, 62 | 7 408 | 1 368 | 35 | 1 |

„Schlüsse" sind Loop-**Schlüsse**, nicht Fänge: `step` zählt jeden heimgekehrten Trail,
auch den, der nichts holt. Genau diese Verwechslung liess die Kosten von T26 unsichtbar
bleiben — die Zahl stand bei 1 368 still, während sich darunter etwas bewegte. Die Spalte
„leer" (Schlüsse, die nichts malten) ist eigens dafür nachgemessen worden, über die
Identität von `p.territory`: ein verfallener Fang lässt die Referenz stehen. Der Begriff
steht jetzt in CONTEXT.md („Loop-Schluss ≠ Fang"), und der Bench nennt das Feld
`ArenaRun.closures` — es hiess `fills`, was genau die Lesart nahelegte, die den Fund
verzögert hat.

**Zwei Beiträge, sauber getrennt:**

1. **Ticket 19** (`3e2682b`) — Bots hören auf, am eigenen Trail zu sterben: **6 → 1 Tode**
   in 5 min. Das ist kein Nebeneffekt, sondern der ausgeschriebene Preis des Tickets
   (CONTEXT.md: „0,2 WU neben der eigenen Linie herzufahren überlebt"). Sie überleben,
   malen weiter — **29,5 % → 39,4 %** der Karte —, und Tode sind laut Ticket 23 der
   **einzige** Mechanismus, der die Vertex-Zahl deckelt. Folge: Vertices **+26,5 %**,
   mean **+64 %**. Der grössere der beiden Beiträge.
2. **Ticket 26** (`b167439`) — von 1 368 Schlüssen gehen **31 weniger** leer aus (66 → 35)
   bei unveränderter Schluss-Zahl. Das ist das Dichtband, das tut, wofür es gebaut wurde:
   Fänge, die vorher verfielen, greifen. Folge: Vertices **+11,7 %**, mean **+18 %**.
   Die bemalte Fläche *sinkt* dabei (39,4 % → 37,7 %), was zunächst wie ein Widerspruch
   aussieht und keiner ist: ab dem ersten geretteten Fang fliegen die Bots einen anderen
   Pfad, und danach sind die beiden Läufe nicht mehr punktweise vergleichbar. Der
   Mechanismus ist es — gleiche Schluss-Zahl, 31 Schlüsse weniger leer.
3. **`e11ab96` (T20) und `c43ea08`** sind zusammen die letzte Zeile: der erste fasst
   `geometry.ts` mit vier Zeilen an, der zweite nur Tests. Beide sind **gemessen**
   folgenlos, nicht bloss als harmlos eingeschätzt — die Geometrie ist gegen `b167439`
   bit-identisch. Der Verdächtigenkreis des Tickets ist damit vollständig abgearbeitet.

Die Hypothese des Tickets („die naheliegende Hypothese ist Ticket 26") war damit **halb**
richtig: T26 trägt bei, aber T19 trägt mehr, und die dort vermutete Kausalkette („ein Bot,
der seinen Loop schliesst, stirbt nicht auf dem Rückweg") war die falsche — die Tode fielen
schon vor T26 weg, an der Selbstschnitt-Regel selbst.

**Eine Einschränkung, die niemand übersehen soll:** die Ticket-22-Zahlen reproduzieren auf
dieser Maschine **auch bei `b786fb6` nicht** (max 47–56 ms statt 36–43 ms, 0–2 Überläufe
statt 0). Ein Teil des berichteten Abstands ist Umgebung, nicht Code. Die im Ticket oben
notierten 103,20 ms / 57 Ticks sind aus demselben Grund nicht wiederholbar; wiederholbar
sind mean, p95 — und die Geometrie.

### Warum die alte Zusicherung nicht zu retten war

`max < 50 ms` bei 200 WU zurückzuerobern hiesse, eines der beiden Tickets zurückzubauen.
Sie stattdessen auf einen höheren Wert zu heben hiesse zu behaupten, das Budget halte —
es hält nicht: `bench:steady` mass am selben Stand **1 860** Überläufe über 30 min. Und
sie war schon vorher keine Eigenschaft, sondern ein **Fensterzufall**: die „0 Ticks über
Budget" galten, weil der Lauf bei t = 300 s endet und der erste Überlauf bei t = 355 s
lag. T19 und T26 haben den Bruch auf t ≈ 172 s vorgezogen — der Halt wurde rot an einem
bekannten Fund, der in sein Fenster wanderte, nicht an einem neuen.

Dazu kommt, dass `max` an dieser Stelle gar nicht messbar ist: bei 50 WU landete er in
vier Läufen auf **vier verschiedenen Ticks** (t = 60,2 / 30,0 / 141,3 / 126,8 s) und
streute 27,7–49,5 ms gegen die 50-ms-Grenze — auf bit-identischer Geometrie. Ein
Ausreisser, der wandert, während die Arbeit feststeht, ist die Laufzeit. Der Halt war also
auch bei 50 WU ein Münzwurf, nur einer, der bisher gewonnen hat.

### Was gebaut wurde

`bench` sichert die **Vertex-Zahl** gegen eine aufgezeichnete Basislinie zu (±5 %,
`driftFrom` in `harness.ts`, reine Funktion mit Unit-Tests neben `saturationOf` — Regel 8)
und dazu **Schlüsse und Tode exakt** — die sind Zählwerte, da ist jede Abweichung schon ein
anderer geflogener Pfad. Die Zeiten druckt er weiter, ohne sie zu beurteilen. Das ist **schärfer** als vorher: die
Vertex-Zahl ist deterministisch (ein passender Build liest exakt 0,0 %), sie *ist* der
Kostentreiber der Union, und die beiden bisectierten Effekte liegen bei +26,5 % und
+11,7 % — beide hätten den Halt am Tag ihres Landens gerissen, in 20 Sekunden, mit einer
Meldung, die Schlüsse und Tode gleich mitnennt. Gegengeprüft: der neue Halt läuft gegen
`b786fb6` (−29,2 %) und `3e2682b` (−10,4 %) **rot**, gegen HEAD grün.

Was er bewusst **nicht** tut: die Budget-Frage bei 200 WU beantworten. Die gehört Ticket
23 und ist dort menschlich begatet; sie hier als dauerhaft roten Bench zu führen, würde
dasselbe Signal zerstören, das dieses Ticket wiederherstellt (dieselbe Begründung, die der
README schon für `bench:steady` notiert).

### Folgen

- Ticket 22: Zahlen-Tabelle und Akzeptanz-Haken als überholt markiert, mit dem Grund.
- `bench/fill-budget/README.md`: neuer Abschnitt „Stand auf `main`" mit der Basislinie,
  der Bisektions-Tabelle und der Trennung deterministisch / gestreut; die alte Tabelle
  bleibt als *historisch* stehen.
- **Ticket 23 ist entblockt.** Die Basislinie ist verstanden: der +33,3 %-Drift, der dessen
  Umfangs-Argument („NUR Ansatz 1", weil die Kurve sättigt) untergrub, ist kein Rätsel mehr,
  sondern die Folge der auf 1 gefallenen Todeszahl. Das Argument selbst hält damit aber
  **nicht** mehr — s. Kommentar dort.

## Comments
