# Free-Tier-Konditionen & Billing-Sicherheit: Cloudflare Workers + Durable Objects (Ticket 13)

Stand: **2026-07-19**. Verifikation der zentralen Behauptungen aus [../research/hosting.md](./hosting.md) gegen Primärquellen (offizielle Cloudflare-Docs/-Pricing, Oracle-Docs, Fly.io-Docs; Abruf am Stichtag). Jede zentrale Aussage ist verlinkt; eigene Ableitungen und mehrdeutige Stellen sind mit ⚠️ markiert.

---

## Fazit (verbindlich)

**Ja — gratis und abbuchungssicher, ABER nur solange du auf dem Free-Plan bleibst und keine Kreditkarte hinterlegst.** Der Workers-Free-Plan verlangt keine Karte, und Durable Objects (SQLite-backed) sind auf Free bestätigt verfügbar — die kritischste Behauptung aus Ticket 03 hält. Bei Limit-Überschreitung gibt es einen **harten Stopp mit Fehler, keine Rechnung**. Der **eine wichtigste Vorbehalt**: Sobald du auf **Workers Paid ($5/Monat)** wechselst, gibt es **keinen harten Spend-Cap** — Overage wird automatisch abgebucht, Budget-Alerts sind rein informativ, und die „Threshold Billing" kann sogar mitten im Zyklus abbuchen. Abbuchungssicherheit = Free bleiben + keine Karte hinterlegen. **Kein Dealbreaker gefunden.**

---

## 1. Kreditkarte auf Workers Free — NEIN

- Die Plans-Seite sagt wörtlich **„Start building for free — no credit card required"** ([cloudflare.com/plans](https://www.cloudflare.com/plans/), Abruf 2026-07-19).
- Der Free-Plan enthält 100 000 Requests/Tag, 10 ms CPU/Invocation und Workers KV — „no credit card required, never expires, commercial use allowed".
- Durable Objects (SQLite) sind Teil des Free-Plans und erfordern **keine** separate Karte (siehe Punkt 2).

**Logikschluss zur Abbuchungssicherheit:** Charging setzt bei Cloudflare eine hinterlegte Zahlungsmethode + ein Paid-/Usage-Based-Produkt voraus (siehe Punkt 4). Wer nie eine Karte hinterlegt und auf Free bleibt, **kann strukturell nicht belastet werden**. ⚠️ Cloudflare formuliert das nicht als expliziten Satz „ein Free-Account ohne Karte wird nie belastet"; es folgt aber zwingend aus dem Billing-Modell (Threshold Billing/Usage-Based-Billing greifen nur bei „self-serve accounts using usage-based products" bzw. „Pay-as-you-go accounts").

## 2. Durable Objects auf dem Free-Plan (KRITISCH) — JA, aber nur SQLite-backed

Dies war der historisch heikelste Punkt (früher brauchten DOs Workers Paid). Für 2026 **bestätigt**:

- **DOs sind auf dem Workers Free Plan verfügbar** — Bedingung: **„Only Durable Objects with SQLite storage backend are available"** auf Free. **KV-backed DOs erfordern weiterhin einen Paid-Plan.** ([DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), Abruf 2026-07-19).
- Changelog **2026-07-09**, „New Durable Object namespaces must use the SQLite storage backend": neue Namespaces müssen ohnehin SQLite nutzen; ausdrücklich: **„the Workers Free plan has only ever supported SQLite-backed Durable Objects"** ([Changelog 2026-07-09](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/), Abruf 2026-07-19). SQLite-backed ist also nicht nur erlaubt, sondern der Standard-/Zukunftspfad — für dieses Projekt vorteilhaft (SQLite = gleich die Persistenz für Rekorde/Raum-Codes).
- SQLite-Storage & API (`sql.exec`) sind **General Availability** (nicht mehr Beta) — [Blog: Zero-latency SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/), Abruf 2026-07-19.

**SQLite-backed vs. KV-backed — Entscheidung für uns:** SQLite-backed nehmen (auf Free die einzige Option, bietet „feature parity with the key-value backend" plus relationale Queries und Point-in-time-Recovery). KV-backed ist für uns weder nötig noch auf Free verfügbar.

## 3. Limits für den Workload (20-Hz-Tick-DO, WS-Hibernation, ~10–100 Spieler)

Alle Zahlen aus [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) und [DO Limits](https://developers.cloudflare.com/durable-objects/platform/limits/), Abruf 2026-07-19.

| Ressource (Free) | Limit | Verhalten bei Überschreitung |
|---|---|---|
| Requests | **100 000/Tag** (Reset 00:00 UTC) | „further operations of that type will fail with an error" |
| Duration | **13 000 GB-s/Tag** | dito (harter Stopp) |
| WebSocket incoming messages | zählen **20:1** zu Requests: „100 WebSocket incoming messages would be charged as 5 requests" | über Request-Budget gedeckelt |
| SQLite Rows read | 5 Mio./Tag | Fehler |
| SQLite Rows written | 100 000/Tag | Fehler |
| SQLite Storage | 5 GB gesamt (Account); ⚠️ pro einzelnem DO max. **1 GB** auf Free (10 GB auf Paid) | Schreibvorgänge (INSERT/UPDATE) schlagen fehl |
| CPU/Invocation (DO) | **30 s** (default), Reset bei **jeder** eingehenden HTTP-Request/WS-Message; per `limits.cpu_ms` bis 5 min konfigurierbar | — |
| WS-Verbindungen / Durchsatz pro DO | Soft-Limit **1 000 Requests/s pro DO** | für 10–100 Spieler trivial |
| Anzahl DOs | **Unlimited** | — |
| DO-Klassen | **100** (Free) / 500 (Paid) | — |

**Trägt Free eine always-on-Arena? JA — genau eine.** Eigene Rechnung (⚠️ auf Docs-Basis, kein Docs-Zitat): eine 24/7 mit Spielern aktiv tickende Arena hält den DO wach und kostet 86 400 s × 0,128 GB ≈ **11 059 GB-s/Tag ≈ 85 % des 13 000-GB-s-Budgets**. → **Eine Dauer-Arena passt, zwei nicht.** Bestätigt hosting.md.

**Der eigentliche Engpass = das Request-Budget** (nicht Duration, nicht CPU). 100 000 Requests/Tag bei WS-incoming-Zählung 20:1 ≈ **2 Mio. eingehende WS-Messages/Tag**. Eigene Rechnung (⚠️): 100 Spieler × 10 Inputs/s ≈ 86 Mio. Messages/Tag → Budget nach ~33 min weg. 20 Spieler × 3 Inputs/s über 8 h ≈ 1,7 Mio. Messages ≈ 86 000 Request-Äquivalente → passt knapp. **Konsequenz: clientseitiges Input-Batching ist Pflicht**, und das obere Zielende (~100 Gleichzeitige, hohe Input-Rate) läuft erst auf Paid sauber.

**CPU ist NICHT der Engpass.** Klärung einer scheinbaren Widersprüchlichkeit in den Docs: Der Workers-Free-Plan nennt „10 ms CPU/Invocation" (das gilt für klassische Worker-Invocations); **Durable Objects haben ein eigenes CPU-Modell von 30 s/Invocation mit Reset pro eingehender Message** ([DO Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). Ein einzelner 20-Hz-Tick ist Sub-Millisekunden-Arbeit → in beiden Lesarten unkritisch. ⚠️ Die Limits-Seite kennzeichnet die 30 s nicht ausdrücklich als „Free"; Cloudflare-Quellen behandeln sie als plan-übergreifenden Default. Praktischer Vorbehalt: Eine leer weitertickende Arena bekommt keine Message-Resets — „If you consume more than 30 seconds of compute between incoming network requests, there is a heightened chance that the individual Durable Object is evicted and reset". → **Interval bei leerer Arena stoppen** (WS-Hibernation, Duration ≈ 0). Bei aktiven Spielern resettet jede Input-Message den Timer; die 30 s werden nie erreicht.

**Storage-Billing-Sicherheit:** Ab 07.01.2026 wird SQLite-Storage abgerechnet, aber **„developers on the Workers Free plan will not be charged"** ([Changelog 2025-12-12](https://developers.cloudflare.com/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/), Abruf 2026-07-19).

## 4. Billing-Sicherheit — „kein Überraschungs-Abbuchen"

**Auf Free (kein Zahlungsmittel):** Bei Erreichen eines Limits **„further operations of that type will fail with an error"** ([Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/) + [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), Abruf 2026-07-19). **Harter Stopp, keine Rechnung.** Das ist der abbuchungssichere Zustand.

**Auf Paid — Achtung, KEIN harter Spend-Cap:**
- **Budget-Alerts** existieren (E-Mail, wenn account-weiter Usage-Spend eine selbst gesetzte Dollar-Schwelle überschreitet), aber: **„Budget alerts are available to Pay-as-you-go accounts only"** und **„Budget alerts are informational only. They do not pause or cap usage."** ([Budget Alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/), Abruf 2026-07-19; eingeführt [Changelog 2026-04-13](https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/)). Es gibt **keine** Funktion, die Nutzung bei einem Betrag hart stoppt.
- **Threshold Billing:** „an automatic payment collection mechanism for Cloudflare's usage-based products" — erreicht der kumulierte Usage-Spend eine Schwelle, wird **mitten im Abrechnungszyklus** automatisch abgebucht. **„The threshold is automatically set by Cloudflare and cannot be modified."** Gilt für „self-serve accounts using any Cloudflare product with usage-based pricing" ([Threshold Billing](https://developers.cloudflare.com/billing/threshold-billing/), Abruf 2026-07-19). → Auf Paid ist Overage **automatisch und nicht deckelbar**.

**Fazit Billing:** Der einzige garantiert abbuchungssichere Modus ist **Free ohne hinterlegte Karte**. Paid bedeutet zwingend eine Karte, mind. $5/Monat und automatische, nicht gedeckelte Overage.

### Checkliste für Anfänger (Abbuchungen verhindern)

1. **Account anlegen ohne Kreditkarte.** Workers Free + DO (SQLite) brauchen keine Karte — keine hinterlegen.
2. **Auf dem Free-Plan bleiben.** Nicht auf „Workers Paid" upgraden, solange nicht bewusst gewünscht. Ohne Upgrade + ohne Karte ist keine Belastung möglich (harter Stopp bei Limits).
3. **Nur SQLite-backed DOs verwenden** (auf Free ohnehin die einzige Option) — kein versehentliches Paid-Feature.
4. **Interval bei leerer Arena stoppen** → Hibernation → Duration bleibt weit unter dem Tagesbudget (schützt vor unnötigem Verbrauch, nicht vor Kosten — aber gute Hygiene).
5. **Input-Batching im Client** einbauen (Richtungswechsel statt Dauer-Input) → hält den Request-Verbrauch im 100k/Tag-Rahmen.
6. **Billable-Usage-Dashboard** (Manage Account → Billing → Billable Usage) gelegentlich prüfen, um Verbrauch relativ zum Free-Kontingent zu sehen.
7. **Erst wenn du bewusst Paid nimmst:** Karte hinterlegen, dann sofort einen **Budget-Alert** setzen (E-Mail-Warnung) — im Wissen, dass er **nicht** stoppt, nur warnt. Es gibt keinen echten Cap; die Verantwortung liegt beim Monitoring.

## 5. Upgrade-Schwelle & Workers-Paid-Kosten

**Wann reicht Free nicht mehr für eine always-on-Arena?**
- **Zweite Dauer-Arena:** Sobald zwei Arenen gleichzeitig 24/7 ticken (Duration-Budget 13 000 GB-s/Tag ist von einer Arena zu ~85 % belegt).
- **Request-Budget:** Sobald aktives Spiel > ~2 Mio. eingehende WS-Messages/Tag erzeugt (grob: viele Gleichzeitige und/oder hohe Input-Rate trotz Batching).

**Workers Paid — $5/Monat** ([Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/) + [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), Abruf 2026-07-19):
- Mindestcharge **$5 USD/Monat/Account**; enthält Workers, DO, KV, Pages Functions, Hyperdrive; **keine** Egress-/Bandbreitenkosten.
- Workers: **10 Mio. Requests/Monat** + **30 Mio. CPU-ms/Monat** inklusive; Overage **$0,30/Mio. Requests**, **$0,02/Mio. CPU-ms**.
- Durable Objects: **1 Mio. Requests/Monat** + **400 000 GB-s Duration/Monat** inklusive; Overage **$0,15/Mio. Requests**, **$12,50/Mio. GB-s**. Storage: 25 Mrd. Rows read, 50 Mio. Rows written, 5 GB-Monat inkl.; Overage $0,001/Mio. read, $1,00/Mio. written, $0,20/GB-Monat.
- **Wie viele Arenen trägt der $5-Grundpreis?** Eine 24/7-Arena ≈ 324 000–332 000 GB-s/Monat (⚠️ eigene Rechnung 86 400 × 30 × 0,125–0,128) → **innerhalb der 400 000 GB-s inklusive**, also im Grundpreis komplett gedeckt. Weitere Arenen = weitere DOs (Anzahl „Unlimited") → Duration-Overage $12,50/Mio. GB-s linear. Grobkalkulation Volllast (100 Spieler, hohe Message-Rate): Request-Overage grössenordnungsmässig ~$20/Monat (⚠️ eigene Rechnung).

## 6. Fallbacks (Billing-Sicherheit, je kurz)

**Oracle Cloud Always Free** — Karte **nur zur Identitätsprüfung**, Always-Free wird nie belastet: Beim Signup wird die Karte für **$1 autorisiert (Hold, binnen 3–5 Tagen zurückgebucht, keine echte Belastung)**; **„Your credit card won't be charged unless you elect to upgrade your cloud account."** Und selbst nach Upgrade: **„Oracle doesn't charge for Always Free resources after you upgrade, and will only charge you for resource usage above the Always Free limits."** ([Oracle Free Tier FAQ](https://www.oracle.com/cloud/free/faq/) + [Always Free Resources Doc](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), Abruf 2026-07-19). → Karte Pflicht (Debit/Prepaid ausgeschlossen), aber für Always-Free-Ressourcen abbuchungssicher, solange man **nicht** auf Pay-As-You-Go upgradet. ⚠️ Die FAQ-Seite war am Stichtag teils per WebFetch blockiert (HTTP 403); die zitierten Passagen stammen aus Suchtreffern der offiziellen FAQ + der Oracle-Docs-Seite.

**Fly.io** — **reales Abbuchungsrisiko:** **„All organizations (except for Linked Organizations) require a credit card on file"**, kein klassischer Free-Tier für Neukunden (nur Free-Trial-Credit), **nutzungsbasiertes Billing** („we just charge based on usage … pro-rated for the time they are provisioned"). Die Docs nennen **keine** Spend-Caps/Hard-Limits als Finanzschutz ([Fly.io Pricing](https://fly.io/docs/about/pricing/), Abruf 2026-07-19). → Weiches, automatisches Billing = für einen Anfänger, der „keine Überraschungen" will, riskanter als Cloudflare Free.

---

## Verifikationsstatus

**Verifiziert gegen Primärquellen (Abruf 2026-07-19):** Kein-Kreditkarten-Zwang auf Workers Free; DOs auf Free verfügbar (nur SQLite-backed, KV-backed = Paid); SQLite-backed ist GA und der verpflichtende Standard für neue Namespaces (Changelog 2026-07-09); Free-Limits (100k Req./Tag, 13 000 GB-s/Tag, WS 20:1, SQLite-Row-/Storage-Limits); harter Stopp mit Fehler bei Überschreitung; Free wird für SQLite-Storage nicht belastet (Changelog 2025-12-12); DO-CPU 30 s/Invocation mit Reset; Paid $5/Monat inkl. Kontingente + Overage-Raten; Budget-Alerts nur PAYG & rein informativ; Threshold Billing automatisch & nicht modifizierbar; Oracle Always-Free-Billing; Fly.io Karten-/Usage-Billing.

⚠️ **Unsicher / eigene Ableitung:**
- Alle **Durchrechnungen** (Duration einer 24/7-Arena, Request-/Message-Budget, Paid-Volllast-Overage, Arenen pro $5) sind eigene Kalkulationen auf Docs-Zahlenbasis, keine Docs-Zitate.
- Cloudflare formuliert nicht als einzelnen Satz, dass „ein Free-Account ohne Karte nie belastet wird" — es folgt aus dem Billing-Modell (Charging nur bei Zahlungsmethode + Usage-Based-/Paid-Produkt).
- DO-CPU 30 s ist auf der Limits-Seite nicht explizit als „Free" gekennzeichnet (plan-übergreifender Default laut Quellen). Für einen leichten 20-Hz-Tick nicht bindend.
- Pro-DO-Storage-Limit auf Free (1 GB) stammt aus der Limits-Seite via Suchzusammenfassung; Account-Gesamt 5 GB ist aus der Pricing-Seite bestätigt.
- Oracle-FAQ am Stichtag per WebFetch 403 — Zitate aus offiziellen Suchtreffern + Oracle-Docs verifiziert, nicht per Direktabruf der FAQ-HTML.

## Quellen

- Cloudflare Plans (kein Kreditkarten-Zwang): https://www.cloudflare.com/plans/ — 2026-07-19
- Workers Pricing (Free-Limits, harter Stopp, Paid $5, Overage): https://developers.cloudflare.com/workers/platform/pricing/ — 2026-07-19
- Durable Objects Pricing (Free: SQLite only, 100k Req./Tag, 13 000 GB-s/Tag, WS 20:1, Storage; Paid-Kontingente): https://developers.cloudflare.com/durable-objects/platform/pricing/ — 2026-07-19
- Durable Objects Limits (CPU 30 s/Reset, 1 000 Req./s/DO, DOs unlimited, Klassen 100/500, Per-DO-Storage): https://developers.cloudflare.com/durable-objects/platform/limits/ — 2026-07-19
- Changelog 2026-07-09 (neue DO-Namespaces müssen SQLite sein; Free unterstützte immer nur SQLite): https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/ — 2026-07-19
- Changelog 2025-12-12 (SQLite-Storage-Billing ab 07.01.2026; Free wird nicht belastet): https://developers.cloudflare.com/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/ — 2026-07-19
- Blog: SQLite in Durable Objects (GA): https://blog.cloudflare.com/sqlite-in-durable-objects/ — 2026-07-19
- Budget Alerts (PAYG only, informational only, kein Cap): https://developers.cloudflare.com/billing/manage/budget-alerts/ — 2026-07-19
- Changelog 2026-04-13 (Billable-Usage-Dashboard + Budget-Alerts): https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/ — 2026-07-19
- Threshold Billing (automatisch, nicht modifizierbar): https://developers.cloudflare.com/billing/threshold-billing/ — 2026-07-19
- Billing FAQ (Downgrade auf Free = Verlust Paid-Features): https://developers.cloudflare.com/billing/understand/faq/ — 2026-07-19
- Oracle Cloud Free Tier FAQ (Karte zur Verifikation, $1-Hold, keine Belastung ohne Upgrade): https://www.oracle.com/cloud/free/faq/ — 2026-07-19
- Oracle Always Free Resources (Always Free auch nach Upgrade nicht belastet): https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm — 2026-07-19
- Fly.io Pricing (Karte Pflicht, usage-based, keine Caps): https://fly.io/docs/about/pricing/ — 2026-07-19
