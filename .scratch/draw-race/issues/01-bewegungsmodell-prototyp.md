# 01 — Bewegungsmodell-Prototyp: Grid vs. kontinuierlich

Type: prototype
Status: resolved
Blocked by: —

## Question

Bewegt sich der Spieler grid-basiert (splix.io: Zellen, 4 Richtungen, knackige Abbiegungen) oder kontinuierlich (Paper.io 2: freie Winkel, weiche Kurven) — und mit welchem Steuerschema fühlt sich das auf Desktop (Maus, WASD, Pfeiltasten) und Touch (Smartphone) jeweils am besten an?

Kontext:

- Die Paper.io-Steuerung wird explizit als **nicht gelungen** empfunden; „smooth" ist die Anforderung. Ob smooth = kontinuierliche Bewegung oder = gut abgestimmte Grid-Steuerung bedeutet, ist genau die offene Frage.
- Die Entscheidung prägt alles Stromabwärtige: Kollisionslogik, Fill-Algorithmus (Zellen vs. Polygone), Netcode-Anspruch (Grid-Prediction ist deutlich einfacher), Balance.

Vorgehen (via /prototype): Wegwerf-Prototyp ohne Netz — nur Bewegung + Trail auf leerem Canvas, beide Bewegungsmodelle umschaltbar, alle Steuerschemata (Maus/Tastatur/Touch) ausprobierbar. Der User spielt beide Varianten auf Desktop und Handy und entscheidet.

Entscheidungs-Ausgang: Bewegungsmodell (grid/kontinuierlich) + primäres und sekundäre Steuerschemata pro Gerät.

## Answer

**Entschieden (2026-07-18, HITL nach Spielen des Prototyps auf Desktop und Handy):**

- **Bewegungsmodell: Kontinuierlich** — freie Winkel, weiche Kurven (Paper.io-2-Klasse). Grid (hart wie weich) verworfen.
- **Steuerung Desktop:** Default **Tastatur** (links/rechts lenken via A/D bzw. Pfeiltasten), umschaltbar auf **Maus-folgen** (Kopf steuert zur Mausposition). Beide als Optionen in die Spec.
- **Steuerung Mobile:** Default **„Finger folgen"** (Kopf läuft zur Fingerposition); zusätzlich als Einstellung wählbar **„Lenken L/R"** und **„Joystick"** — beide vom User als gelungen bewertet, gehören als Optionen in die Spec.
- **Startwerte (bestätigt):** Tempo **9 Zellen/s**, Drehrate **320°/s**.

**Klarstellungen zu zwei Rückfragen (beides Prototyp-Artefakte, keine Spielparameter):**

- *Render-Glättung* hat für Kontinuierlich keine Wirkung — der Slider betraf nur die beiden Grid-Modelle (0 = blockig … 1 = weich); Continuous rendert immer voll glatt. Entfällt in der Spec.
- *Trail-Länge* war nur ein Prototyp-Pufferlimit gegen unbegrenztes Speicherwachstum beim Testen (deshalb „hängt davon ab, wie lange man fährt"). Im echten Spiel ist der Trail nur der Weg seit Verlassen des eigenen Gebiets und wird beim Schliessen der Schleife zurückgesetzt — kein Balance-Parameter.

**Konsequenz (weitergeleitet an Ticket 08):** Kontinuierlich ist der teurere Netcode-Pfad — laut Ticket 05 ca. 2–3× Grid, braucht echte Prediction/Reconciliation/Interpolation/Rewind ohne offene Referenzimplementierung, und die dafür leicht bevorzugte Bibliothek Colyseus läuft **nicht** auf der gewählten Cloudflare-Workers-Basis (Ticket 03). Zudem: Flächeneroberung ist polygonbasiert (Paper.io), nicht der Uint8-Flood-Fill aus splix (Ticket 04) — splix bleibt Referenz für Server-Autorität/20-Hz-Tick/Binärprotokoll, nicht für den Fill. Dieses Spannungsfeld löst Ticket 08.

**Asset:** Wegwerf-Prototyp als primäre Quelle unter [prototype/movement.html](../prototype/movement.html) (selbst-enthaltene Datei, Modelle + Steuerungen live umschaltbar).

## Comments

**2026-07-18, aus den Research-Tickets 03–06 (entscheidungsrelevant für dieses Ticket):**

- Die Netcode-Recherche ([research/netcode.md](../research/netcode.md)) beziffert den Netcode-Aufwand der Continuous-Variante auf **ca. 2–3× Grid** — Grid kommt ohne klassisches Prediction/Rollback aus (splix-Server als MIT-lizenzierte 1:1-Referenz), Continuous braucht Prediction/Reconciliation/Interpolation/Rewind ohne offene Referenzimplementierung.
- Die Hosting-Wahl (Cloudflare Workers + Durable Objects, [research/hosting.md](../research/hosting.md)) verträgt sich gut mit Grid + Eigenbau; die für Continuous leicht bevorzugte Colyseus-Bibliothek läuft dort nicht — Continuous würde also auch die Hosting-/Architekturfrage wieder öffnen.
- Der Look ist davon unabhängig: three.js kann beide Varianten gleich gut 2.5D rendern ([research/rendering-engine.md](../research/rendering-engine.md)); „smooth anfühlen" kann auch eine Grid-Sim mit interpolierter Kamera/Kurvenglättung im Renderer (Paper.io-2-Optik auf Grid-Logik ist machbar — im Prototyp zeigen!).

Das Spielgefühl bleibt die Entscheidungsgrundlage dieses HITL-Tickets — aber der Prototyp sollte fairerweise auch die Variante „Grid-Logik mit weich gerendeter Bewegung" enthalten, nicht nur hartes Grid vs. freies Continuous.
