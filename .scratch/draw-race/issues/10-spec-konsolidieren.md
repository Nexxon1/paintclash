# 10 — Spec konsolidieren

Type: task
Status: resolved
Blocked by: 07, 08, 09, 11, 12, 13, 15

## Question

Alle Entscheidungen der Map zu einer implementierungsreifen `spec.md` unter `.scratch/draw-race/` zusammenführen — damit ist die Destination der Map erreicht.

Struktur (Vorschlag):

1. Vision & Abgrenzung (inkl. Ausbaustufen-Ausblick und Out-of-Scope-Liste der Map)
2. Spielregeln (aus Ticket 02) inkl. private Räume und Bots
3. Steuerung & Bewegungsmodell (aus Ticket 01)
4. Look & Animationen (aus Ticket 07) inkl. Sound (aus Ticket 12)
5. Architektur & Modulschnitt (aus Ticket 08, verweist auf ADRs)
6. Netcode & Protokoll (aus Tickets 04/05)
7. Hosting & Betrieb Phase 1 (aus Ticket 03)
8. Teststrategie & Qualitätsstandards (aus Ticket 09)
9. Balance-Parameter mit Startwerten (aus Ticket 11)

Arbeit: Ticket-Antworten und Research-Findings einsammeln, Widersprüche auflösen (falls welche auftauchen: zurück als neues Ticket), Spec schreiben, Review durch den User (HITL).

Ausgang: `spec.md` liegt vor und der User hat sie abgenommen; Map wird geschlossen.

## Answer

**Resolved (2026-07-19, HITL — User: „good to lock").** Die implementierungsreife
[`spec.md`](../spec.md) ist geschrieben und abgenommen → **Destination der Map erreicht.**

- **Umfang:** 11 Kapitel, konsolidiert aus 13 resolved Tickets (01–09, 11, 12, 13, 15),
  6 ADRs und dem Glossar (`CONTEXT.md`). Struktur folgt dem Ticket-Vorschlag; einzige
  Abweichung: **Sicherheit & Abuse-Schutz** (Ticket 15) als eigenes Kapitel 8 statt in
  Hosting gefaltet. ADRs werden **referenziert**, nicht dupliziert; jeder provisorische
  Wert ist als solcher markiert.
- **Widerspruchs-Scan (Ticket-Auftrag):** keine echten Widersprüche — vier scheinbare
  Nähte sind bewusste Supersessions, je zugunsten der späteren Autorität aufgelöst:
  `Zellen/s` → **WU/s** (T11 ersetzt „Zelle"); private-Raum-Gnadenfrist `~1–2 Min` →
  **90 s** (T11); Bot-Zahl/Populationsgrenze → **provisorisch, Wert ← Ticket 14**;
  „Kein Git-Repo"-Notiz → **Git ohne Remote** (aktueller Stand). **Kein neues Ticket.**
- **Kein neuer Nebel, nichts neu out of scope.**
- **Übergang in die Umsetzung:** [Ticket 14 (DO-CPU-Benchmark)](14-do-cpu-benchmark.md) ist
  durch die fertige Spec **entblockt** und rückt als **erster Implementierungs-Spike** auf
  die Frontier — bereits jenseits der Map-Destination (Umsetzung als eigenes Vorhaben).
  Weitere Handoffs (GitHub-Remote+Actions, Namensfindung) in Spec-Kapitel 11.
