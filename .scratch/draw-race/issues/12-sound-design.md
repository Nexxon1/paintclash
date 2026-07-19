# 12 — Sound-Design: Grundversion ja/nein

Type: grilling
Status: resolved
Blocked by: 07

## Question

Bekommt die Grundversion Sound — ja/nein, und wenn ja in welchem Umfang? Kandidaten: Effekte für Fill/Loop-Schluss, Kill/Tod, eigenes Sterben, Bewegungs-/UI-Feedback; optional dezente Musik. Der Look-&-Feel ist mit Ticket 07 entschieden (D „Paper.io Modern"), damit ist die Tonfrage ticketreif.

Zu klären: Scope (welche Sounds), Asset-Quelle (frei/CC0 vs. lizenziert vs. selbst), technische Randbedingungen (Browser/Mobile-Autoplay-Policy → Sound erst nach erster Interaktion, Mute-Default, Lautstärke-Toggle), Performance/Bundle-Budget.

Entscheidungs-Ausgang: Sound-Kapitel für die Spec (Ticket 10) — ja/nein + Scope + Umsetzungsrandbedingungen.

## Answer

**Grundsatz: Ja — aber bewusst ein *minimaler SFX-Kern*.** Keine Hintergrundmusik, keine UI-/Menü-Sounds in der Grundversion. Die volle Palette ist eine Ausbaustufe (s. unten → auf der Map als out of scope geführt).

### Scope — sechs Events, strikt egozentrisch

Sound löst **ausschliesslich bei den eigenen Aktionen** des lokalen Spielers aus — nie bei fremden Spielern. Das hält jeden Ton eindeutig („*dir* ist etwas passiert"), vermeidet akustisches Chaos bei ~10–100 Spielern und spart die Voice-Limitierung/Distanzdämpfung, die Umgebungston bräuchte.

| # | Event | Typ | Notiz |
|---|---|---|---|
| 1 | **Fill** (Loop geschlossen) | One-Shot | die Belohnung, das Herz; im Kern *ein* fixer Sound (Skalierung nach Fläche = Ausbau) |
| 2 | **Kill** (Gegner-Trail geschnitten / Kopf-an-Kopf gewonnen) | One-Shot | |
| 3 | **Eigener Tod** (geschnitten / Totalverlust) | One-Shot | |
| 4 | **Respawn / Join** | One-Shot | |
| 5 | **Rang-Aufstieg** (Leaderboard-Überholen) | One-Shot | |
| 6 | **„Fressen"** — Trail frisst sich durch *fremdes* Gebiet | **Loop** | nur über **fremdem** Gebiet (nicht neutral/eigen), leise unter die One-Shots gemischt, **sanft ein-/ausgeblendet** (kein hartes An/Aus), fixer Loop im Kern. Knüpft an den Look aus Ticket 07 (2D-Trail frisst sich sichtbar durch fremdes 3D-Gebiet). |

Bewusst **nicht** im Kern: Trail-Start/Gebiet-verlassen (bei kontinuierlicher Bewegung fast dauernd an → Dauerbeschallung), Near-Miss-Warnung, UI-Sounds, Musik, Umgebungston.

### Asset-Quelle — prozedural-first, CC0-Fallback

- **Primär A) prozedural via Web Audio API** — One-Shots als Oszillator + Gain-Hüllkurve, rausch-basierte Events (Kill/Tod/Fressen) als gefiltertes Rauschen. **0 Asset-Bytes, keine Lizenz, voll im TS-Code versioniert und tweakbar** (passt zu „starten wir so, justieren später").
- **Fallback B) CC0/free-to-use-Sample**, wo prozedural nicht reicht oder altbacken/chiptunig klingt — **voraussichtlich der „Fress"-Loop** (körnig/organisch schwer synthetisierbar).
- **Lizenz:** alles **frei & free-to-use**. **CC0 bevorzugt** (keine Attribution); ist ein gebrauchtes Sample nur CC-BY, wird eine **Credits-/Attribution-Liste** im Repo geführt. Kein kostenpflichtiges Material.
- Wechsel A↔B erfolgt **pro Event unsichtbar** hinter einer schlanken Ausgabe-Schnittstelle (`play('fill')` o.ä.).

### Default-Zustand & Steuerung

- **Ton AN per Default.** Begründung: dezente SFX (keine Musik), und Ton spielt ohnehin erst, *nachdem* der Spieler aktiv „Play" geklickt hat — keine passive Seiten-Beschallung überrumpelt ihn.
- **Autoplay-Policy (Fakt, keine Entscheidung):** Browser (v.a. Mobile) blockieren Audio bis zur ersten Nutzer-Geste → der `AudioContext` wird **implizit beim Play/Join-Klick** entsperrt. **Kein separater „Ton aktivieren"-Prompt.**
- **HUD-Mute-Toggle**, im Kern **binär** (an/aus, ein Lautsprecher-Icon). Lautstärke-Slider = Ausbaustufe.
- **Mute-Wahl in `localStorage` persistiert** (an die Spieler-ID-/localStorage-Mechanik angelehnt), überlebt Reload.
- *User-/account-gebundene Sound-Präferenzen inkl. Default-Stumm → Ausbaustufe mit den User-Accounts.*

### Budget, Performance & Architektur-Randbedingungen

- **Asset-Bytes:** prozedural = 0. Sample-Rückfälle mit **weichem Cap ≤ 50 KB gesamt**, kurze Mono-Clips in breit unterstütztem, komprimiertem Format (mobil-kompatibel).
- **Ladeverhalten:** jegliche Sample-Dateien **lazy/asynchron nach dem Join** — blockieren **nie** First-Paint oder WebSocket-Connect. Prozedural lädt nichts.
- **Laufzeit:** **ein** geteilter `AudioContext` + **Master-Gain** (den schaltet der Mute-Toggle). Der „Fress"-Loop = **eine** persistente Loop-Quelle, per Gain-Hüllkurve ein-/ausgeblendet (nicht pro Tick erzeugt/zerstört). One-Shots = kurze Wegwerf-Nodes. **Keine Allokation pro Tick** → mobil CPU-vernachlässigbar.
- **Entkopplung vom `sim-core`:** Sound hängt **rein am Client-Rendering/Feedback**, ist vom deterministischen `sim-core` **entkoppelt** (konform ADR-0002/0003). Audio darf die Simulation **nie** beeinflussen → kein Determinismus-/Replay-Risiko, kein Golden-Fixture-Thema.
- **Accessibility:** Sound ist rein **additiv** zum vorhandenen visuellen Feedback (Fill/Tod/etc. sind ohnehin sichtbar) — **kein alleiniger Feedback-Kanal**, daher keine A11y-Blockade.

### Konsequenz für die Spec (Ticket 10)

Ein **Sound-Kapitel** mit: Grundsatz (minimaler SFX-Kern), Event-Tabelle oben (egozentrisch), Asset-Strategie (prozedural-first + CC0-Fallback, Lizenzregel), Default/Steuerung (AN, Play-Klick-Entsperrung, HUD-Mute-Toggle, localStorage), Budget-/Laufzeit-Leitplanken und der `sim-core`-Entkopplung. Keine neuen Tickets, kein neuer Nebel; Ticket 10 verliert einen Blocker.

### Ausbaustufe — „Volle Palette" (out of scope, Skizze wie gewünscht)

- **Dezente Ambient-Musik** — ruhiger Loop, **eigener Musik-Kanal** getrennt vom SFX-Kanal.
- **UI-Sounds** — Hover/Klick, Nickname-Eingabe, Lobby-/Menü-Töne.
- **Erweiterte SFX** — Trail-Start (Gefahr), Near-Miss-Warnung, Lobby-Countdown (private Räume).
- **Umgebungston (räumlich)** — fremde Kills/Tode/Fills im Nahfeld mit Distanzdämpfung + Stereo-Panning (kippt „egozentrisch").
- **Dynamik** — Fill-Sound skaliert nach eroberter Fläche; Fress-Intensität/Tonhöhe nach Tempo/Fläche; Kill-Streak-Variationen; Milestone-/Rang-1-Stinger.
- **Feinere Steuerung** — getrennte Lautstärke-Slider (Master/SFX/Musik); account-gebundene Sound-Präferenzen (Default-Stumm).
