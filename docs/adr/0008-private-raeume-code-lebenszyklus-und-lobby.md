# ADR-0008 — Private Räume: Code als Adresse, Lebenszyklus und hibernations-fester Lobby-Zustand

Status: Angenommen (2026-07-31)
Kontext-Tickets: [14 Private Räume](../../.scratch/paintclash/issues/14-private-raeume.md); baut auf [ADR-0004](0004-arena-prozess-und-persistenzmodell.md) auf

## Kontext

ADR-0004 hat das *Modell* entschieden: 1 DO pro Raum-Code (`idFromName(code)`), Raum-Registry
in DO-SQLite, Hibernation bei Leere/Lobby, Cleanup per Timeout. Beim Bau (Ticket 14) blieben
drei Fragen offen, die das Modell nicht beantwortet und die je eine echte Alternative hatten.

## Entscheidung 1 — Der Registry-Eintrag **ist** der Raum

Es gibt **kein zentrales Verzeichnis** lebender Räume. Ein Code lebt genau dann, wenn das DO
mit dem Namen `code` einen `room`-Eintrag in seinem eigenen Storage hat.

- **Erstellen:** Der Router zieht einen Code und schickt `POST /room` an dessen DO. Existiert
  dort schon ein Eintrag, antwortet das DO **409** und der Router zieht neu (bis
  `ROOM_CODE_ATTEMPTS`). Das ist die Kollisionsprüfung, die ~10⁹ Kombinationen erst als
  *Adressen* benutzbar macht: eine Kollision kostet einen zweiten Zug, niemals einen Spieler
  im Raum von Fremden.
- **Schliessen:** `storage.deleteAll()`. Damit ist der Code in derselben Sekunde frei — ohne
  dass irgendwo ein Eintrag zurückgemeldet werden müsste.

**Alternative (verworfen):** ein Registry-DO, das alle Codes kennt. Es wäre ein
Serialisierungspunkt und ein zweiter Ort, an dem ein Raum „existiert" — und die beiden Orte
könnten auseinanderlaufen (Raum weg, Eintrag da). Der Nachteil der gewählten Lösung ist
bewusst akzeptiert: es gibt **keine Liste** privater Räume, also auch keine Statistik darüber.
Spec §2.6 will ohnehin keine Liste („nicht öffentlich gelistet").

## Entscheidung 2 — Zwei Zustands-Orte, getrennt nach „übersteht Hibernation"

Eine Lobby soll ~0 kosten (spec §2.6), also **wird** ein DO mit offenen Sockets und ohne
laufenden Timer aus dem Speicher geworfen und beim nächsten Event neu belebt — Instanzfelder
inklusive. Der Lobby-Zustand darf das nicht merken, der Spielzustand *muss* es merken:

| Zustand | Ort | Warum dort |
|---|---|---|
| Lobby-Identität (Lobby-ID, Name, Host-Flag, Garbage-Zähler) | **Socket-Attachment** (`serializeAttachment`) | Genau das übersteht Hibernation. Eine Lobby kann eine Stunde stehen, nichts kosten und trotzdem wissen, wer wartet. |
| Mitgliedschaft in der laufenden Arena (`socketIds`) | **Speicher**, stirbt mit der `ArenaCore` | Eine Spieler-ID bedeutet nur *innerhalb einer* Arena-Instanz etwas. Nach einer Verdrängung hält ein alter Socket eine ID, die inzwischen jemand anderem gehören könnte — er wird deshalb mit **1012** zum Neuverbinden geschickt, statt fremde Köpfe zu lenken. |

Das ist die eigentliche Begründung dafür, dass `socketIds` *nicht* ins Attachment gewandert
ist, obwohl das „einheitlicher" gewesen wäre: die Kurzlebigkeit dieser Map **ist** ihre
Sicherheitsfunktion.

## Entscheidung 3 — Ein eigenes DO für das Erstellungs-Budget pro IP

`RoomGateDO`, ein Objekt unter festem Namen. Der Router ist zustandslos (ADR-0004), also
braucht ein Zähler pro IP einen Ort, der zwischen Requests überlebt.

- **Fixes Fenster**, ein Datensatz pro Adresse, Regel in `room-gate.ts` (node-testbar), Shell
  in `room-gate-do.ts` — dieselbe Trennung wie `arena.ts` / `arena-do.ts`.
- **Eine Schreiboperation pro erlaubter Erstellung, null pro Abweisung.** Wer hämmert, kann
  also nicht das Schreib-Budget verbrauchen, für das er gerade abgewiesen wird.
- Ein Alarm pro Fenster räumt abgelaufene Datensätze; er wird nur re-armiert, solange
  Datensätze übrig sind (ein stilles Spiel hält keinen Timer).

**Alternativen (verworfen):** (a) das Rate-Limit-Binding der Plattform — nicht node-testbar
und ausserhalb des „alle Regeln unit-testbar"-Schnitts von spec §9.1; (b) ein DO **pro IP** —
verteilt, aber jede neue Adresse legt ein Objekt an, also genau der Kostenvektor, den das
Limit schützen soll; (c) das Limit in `ArenaDO` unterbringen — eine „Arena", die ein
Rate-Limiter ist.

Dieses Objekt ist zugleich die Naht für die übrigen Pro-IP-Deckel aus spec §8.3 Punkt 3
(Ticket 15).

## Konsequenzen

- **Nachjoin heisst „in ein laufendes Spiel".** Ein gestarteter Raum, dessen Spieler *alle*
  weg sind, läuft nicht — der erste Rückkehrer kommt herein (mit frischer Welt, ADR-0004),
  auch wenn Nachjoin aus ist. Sonst würde jede Verdrängung, oder ein gemeinsames Neuladen,
  zur Aussperrung aus dem eigenen Raum.
- **Der Host ist eine Rolle mit einem Geheimnis.** Das Token (128 bit) gilt beim Verbinden;
  verlässt der Host die Lobby, erbt das längst wartende Mitglied. Ohne Vererbung hinterliesse
  ein geschlossener Tab eine Lobby, die niemand mehr starten kann.
- **Ein hängender Lobby-Socket kann einen Code binden.** Ohne Close-Event (halb-offenes TCP)
  läuft in der Lobby kein Tick-Sweep, der ihn räumt — der Raum gilt als besetzt, bis der
  Transport das Close nachliefert. Preis: ein Code aus ~8,9 × 10⁸ bleibt belegt; bewusst
  nicht mit einem Lobby-Ping bezahlt.
- **Der öffentliche Weg ist unberührt.** `/ws` ohne `?room=` ist genau der Pfad von vorher;
  der Code ist gross geschrieben und `public` klein, weshalb ein Code unverändert als
  DO-Name dienen kann.
