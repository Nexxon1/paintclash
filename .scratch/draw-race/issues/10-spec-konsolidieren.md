# 10 — Spec konsolidieren

Type: task
Status: open
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
