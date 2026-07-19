# 15 — Abuse- & Cheat-Schutz der öffentlichen Arena

Type: grilling
Status: resolved
Blocked by: 08

## Question

Welche Abuse-/Cheat-Schutzmassnahmen bekommt die Grundversion, und welche bleiben Ausbaustufe? Jetzt ticketreif, da die Architektur (Ticket 08) steht: der autoritative Server (Fill/Kills server-only) macht klassisches Cheating schwer, aber offene Flanken bleiben.

Graduiert aus dem Map-Nebel „Abuse-/Cheat-Schutz". Zu klären (via /grilling):

- **Rate-Limiting / Flood-Schutz:** pro Verbindung, verzahnt mit Input-Batching und dem Free-Request-Budget (ADR-0001) — DoS-/Spam-Schutz.
- **Dritt-Clients / Headless-Bots:** jemand baut einen eigenen Client, der sich verbindet. Verbindungslimits pro IP, ggf. Turnstile/Proof-of-Work vor dem Join? Was ist Phase-1-verhältnismässig?
- **Nickname-Moderation:** Blockliste client+server steht (Ticket 02) — reicht das, oder mehr (Meldefunktion später)?
- **Server-Autoritäts-Grenzen:** was kann ein manipuliertes Client-Paket *maximal* erreichen, und deckelt der Server das (Input-Validierung, plausible Bewegungsdeltas)?

Rahmen (entschieden): autoritativer Server + Rewind (ADR-0003), Input-Batching Pflicht (ADR-0001), 1 DO = 1 Arena (ADR-0004).

Entscheidungs-Ausgang: Sicherheits-/Betriebs-Abschnitt der Spec (Ticket 10) — Massnahmen der Grundversion + bewusst verschobene.

## Answer

**Leitprinzip: Verfügbarkeit zuerst.** Die schärfste Flanke der Grundversion ist *nicht* Integritäts-Cheating — die Server-Autorität (Fill/Kills server-only, ADR-0003) neutralisiert die klassischen Cheats strukturell. Fragil ist die **Verfügbarkeit**: *ein* always-on DO, single-threaded, Free-Plan mit **hartem Tages-Stopp ohne Billing-Fallback** (ADR-0001/0013). Realer Schaden eines Angreifers = die Gratis-Arena offline nehmen / das Tagesbudget verbrennen (DoS), nicht unfair gewinnen. Der ganze Abschnitt investiert deshalb in billige, server-seitige Ressourcen-Deckel; Integrität ist zweitrangig (großteils von der Autorität erledigt), Social/Nickname drittrangig.

### A — Server-Autoritäts-Grenze (die Integritäts-Decke)

Der Client sendet **ausschliesslich Steuer-Intent** (Ziel-Heading / Turn-Signal, plus Join-/Respawn-Wunsch), nie Position, Tempo, Fill, Kill oder eine fremde `playerId`. Der Server:

- **re-derived Position** jeden Tick aus dem festen Tempo (`BALANCE` 9 WU/s) + Heading, **geklemmt** auf die legale Drehrate (320°/s). Ein Paket, das 180°-Sprünge oder Über-Tempo behauptet, wird auf die legale Bewegung geklemmt → Teleport / Wall-Clip / Speed-Hack sind schlicht **nicht ausdrückbar**.
- **verwirft malformte Frames** an der Protokollgrenze (falscher Opcode/Länge/Wertebereich) → Nachricht droppen, bei anhaltendem Müll die Socket trennen.
- **bindet jede Eingabe an die Socket-eigene `playerId`** — ein Paket kann nur den *eigenen* Kopf lenken.

Maximum eines voll manipulierten Clients = den eigenen Kopf legal lenken (= spielen). Fill und Tode bleiben server-only, nie client-behauptbar. Einzige legitime client-gemeldete Grösse: die **Input-Sequenznummer** für Reconciliation — erlaubt, aber server-begrenzt (monoton, innerhalb eines Fensters).

### B — In der Grundversion gebaut

Alle server-seitig, deterministisch, ohne Fremddienst; konkrete Schwellen als abstimmbare Konstanten (neben `BALANCE`), in der Implementierung kalibriert.

1. **Intent-only-Validierung** (Abschnitt A) — die Basis, auf der alles andere ruht.
2. **Flood-/Rate-Schutz pro Verbindung:**
   - **Eine wirksame Eingabe pro Spieler pro Tick** — der Tick-Loop fasst jeden Spieler genau einmal an und nimmt nur die *letzte* Intent (coalescing); zusätzliche Nachrichten im selben Tick werden verworfen. → CPU pro Tick konstant, unabhängig vom Sendeverhalten.
   - **Frame-Grössen-Cap** — überlange Frames werden *vor* dem Parsen verworfen (kein Parse-/Speicher-Amplification).
   - **Kill bei anhaltendem Flood/Garbage** — nach kleinem Toleranzfenster Trennung (nicht nur Drosselung); schützt das 20:1-Request-Budget.
3. **Pro-IP-Deckel** (Hebel = `CF-Connecting-IP` am Router-Worker, ADR-0004), **grosszügig & CGNAT-/Shared-WLAN-tolerant**:
   - **Max. gleichzeitige Verbindungen pro IP** — Default ~**16** (nicht 3–5: hinter einer IPv4 sitzen bei CGNAT/Uni-WLAN viele echte Spieler). Stoppt den trivialen Ein-Maschinen-Socket-Flood; im Zweifel durchlassen (false-negative vor false-positive), Ablehnung failt sauber mit klarer Meldung.
   - **Join-Rate pro IP** — Deckel gegen Reconnect-Spam (verbrennt Handshakes/Budget) und drosselt Raum-Code-Brute-Force.
4. **Arena-Populationsgrenze** — *dass* es einen harten Cap gleichzeitiger Spieler gibt, ist hier als Regel gesetzt; **der Wert kommt aus Ticket 14** (DO-CPU-Benchmark). Menschen zuerst, Bots füllen nur freie Slots und weichen echten Spielern (Bot-Logik: `BALANCE`/Ticket 11). Bei Erreichen: saubere „Arena voll"-Abweisung — **keine Queue, kein Auto-Sharding** (Skalierungspfad, out of scope). Das ist der eigentliche Anti-Dominanz-Backstop: selbst 16 Sockets einer IP kosten nur ein paar Bot-Slots.
5. **Nickname-Moderation** — die **statische Server-Blockliste** (Ticket 02) plus Längen-/Zeichenlimits (1–16) reicht für den Launch. Client-Vorprüfung nur für UX, **Server erzwingt**. Namen sind **flüchtig & rein kosmetisch** — nie ein Autorisierungs-Schlüssel (Autorität hängt an der `playerId`), nicht eindeutig, Impersonation folgenlos. Blocklisten sind trivial umgehbar (Leetspeak/Unicode) → **bewusst akzeptiertes Restrisiko** (geringschadhaft, weil kein persistentes Profil).
6. **Private Räume** (Flanke, die der Ticket-Titel streift, aber budget-relevant):
   - **Raum-Code = freundliche Obskurität**, kein Hochsicherheits-Geheimnis: ~**6 Zeichen aus eindeutigem Alphabet** (Verwechsler `0/O`, `1/I/l` raus), case-insensitiv, leicht eintippbar/diktierbar (~10⁹ Kombinationen). Enumerations-Schutz = Zusammenspiel: moderate Entropie + *sehr wenige gleichzeitig lebende* Räume + Join-Rate-Limit (B3) + Wegwerf-Natur (erratener Raum → Gruppe macht neuen auf). Residualrisiko bewusst als geringschadhaft akzeptiert.
   - **Raum-Erstellung pro IP raten-begrenzt** — jeder Raum spawnt ein DO + SQLite-Registry-Write (ADR-0004); Erstellungs-Spam verbrennt Request- & Row-Write-Budget. Leere/Lobby-Räume hibernieren + Timeout-Cleanup (schon ADR-0004, hier als abuse-relevant markiert).

### C — Betriebshaltung

**Verfügbarkeit = ausdrücklich „best effort".** Der harte Tages-Stopp (ADR-0001/0013) ist die *gewollte* Abbuchungssicherheit, kein zu bekämpfender Ausfall. Worst Case eines erfolgreichen DoS = die Arena parkt bis zum Tages-Reset — **kein Kostenrisiko, keine Rechnung**. Bei Phase-1-Grösse (~10–100 Spieler) plus den Deckeln aus B ist Budget-Erschöpfung durch Missbrauch unwahrscheinlich. Die Spec formuliert das explizit, statt Verfügbarkeitsgarantien zu suggerieren, die eine Gratis-Ein-DO-Arena nicht hält.

### D — Bewusst verschoben (mit Auslöser)

- **Turnstile / Proof-of-Work vor dem Join** — gratis & Cloudflare-nativ, aber Reibung vor einem Gast-Spiel, bei ~10–100 Spielern nicht gerechtfertigt. **Auslöser:** die öffentliche Arena wird real geschwärmt (dann als „unsichtbares" Turnstile beim Join).
- **Melde-/Mute-Funktion + Homoglyph-/Unicode-Normalisierung** für Nicknames. **Auslöser:** Community wächst / Beschwerden häufen sich.
- **Verteilte-Schwarm-Abwehr** (viele echte IPs durchbrechen die Pro-IP-Deckel) & mehrere Arenen/Warteschlange. **Auslöser:** Skalierungspfad (mehrere DOs / Matchmaker, ADR-0001) — out of scope Phase 1.

### Konsequenzen

- **Entblockt Ticket 10 (Spec konsolidieren):** war der letzte offene Blocker (07/08/09/11/12/13 alle resolved) → Ticket 10 rückt auf die Frontier.
- Kein neuer Nebel; kein neues Ticket. Ausgang = **Sicherheits- & Betriebs-Kapitel** der Spec, zweigeteilt (gebaut / verschoben-mit-Auslöser).
- Neue Glossar-Begriffe in `CONTEXT.md`: **Steuer-Intent**, **Arena-Populationsgrenze**, **best-effort-Verfügbarkeit**.
