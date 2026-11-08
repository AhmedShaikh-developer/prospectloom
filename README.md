# Localhost Labs — Client Acquisition Pipeline

A local dashboard that runs the whole acquisition pipeline, B2B and B2C, using only free tools:

find leads → research their website → one personal email per lead (Groq AI) → send daily from Hostinger → handle replies.

HubSpot, Apollo and Clay are optional.

## Run it

```bash
npm install
cp .env.example .env     # then put GROQ_API_KEY=... in .env (never in .env.example)
npm start                # http://127.0.0.1:4317
```

Requires Node 22.13+ (uses the built-in `node:sqlite`). Data lives in `data/pipeline.db`. To keep a Mac awake during the sending window, run `caffeinate -i npm start`.

## Setup (all free; the in-app **Setup guide** has the same steps)

1. **Settings → Sender & compliance**: name, sender email, postal address and an opt-out line.
2. **Settings → Integrations → Hostinger mailbox**: enter the mailbox email and its password (the webmail password, not your hPanel login). The servers are already filled in: SMTP `smtp.hostinger.com:465` (SSL/TLS, or 587 STARTTLS) and IMAP `imap.hostinger.com:993`. One login is used for both. Click *Save & test connection*, then *Send a test email to myself*. The first successful test reads your Sent folder, so nobody you already emailed gets a second intro.
   - If the mailbox fails (wrong password, network, Hostinger rate limit), the email stays approved, sending pauses for 30 minutes and the dashboard says why. The approved queue is never used up by failed attempts.
3. **AI writing**: get a free key at console.groq.com/keys and put it in `.env` as `GROQ_API_KEY`. Click *Test AI*. The default model is `openai/gpt-oss-120b`.
4. **Settings → Autopilot & schedule**:
   - Set the recipients' timezone and a daily limit. Start at 10 and raise it slowly.
   - Turn autopilot on from the dashboard.

## How leads come in (hands-free)

- **Lead engine** (sidebar → Lead engine) runs 24/7:
  - It searches every business type × city you choose on OpenStreetMap. Presets cover the 50 or 100 largest US cities, plus UK, Canada, Australia, Germany and the UAE.
  - It adds every business that has its own website, and searches Apollo keywords × cities too if an Apollo key is enabled.
  - It runs one search at a time (default 20 per hour) with a daily cap, and re-checks each city every 30 days for new businesses.
- **Leads folder**: drop CSV files into `leads csv/` and new or changed files are imported every 10 minutes. Columns are detected automatically, including Clay research exports (decision-maker email, opener, evidence URL, lead score).
- **Find & import**: local-business search for one city, pasted websites, CSV files (several at once) and the Clay webhook.
- **Already contacted**: paste emails or domains you emailed with other tools. Your Hostinger Sent folder is read over IMAP. Either way, those people never get a second intro.
- **Background jobs**: searches, imports, research and autopilot run on the server. Their progress shows in the sidebar on every page, so leaving a page never loses work.

## Daily workflow

1. **Research** runs automatically every 5 minutes while the engine is on:
   - It scans each website, finds the published email (retrying DNS and network hiccups) and checks MX, SPF and DMARC.
   - It runs dedup and suppression, picks the offer (A, B or C), and picks an opener from a real fact on the site, with its source URL.
2. **Autopilot** (once a day plus an hourly top-up) writes one email per READY lead with Groq, using only verified facts.
   - A quality gate rejects placeholders, links, hype and invented numbers, and falls back to your template.
   - It approves the emails and sends them spaced out, inside the window and the daily limit.
   - Each email is re-checked right before sending.
   - **Bounce guard**: automatic sending pauses if more than 5% of the last 7 days' emails bounced (once at least 20 were sent).
3. **Replies & pipeline**: the mailbox syncs every 10 minutes. Opt-outs and bounces are suppressed permanently.

**Emails from Clay, Apollo or your CSVs** (Settings → Autopilot & schedule) are only used if you allow them. The address must be on the company's own domain, it's labeled "mailbox not validated", and the bounce guard watches it. With the setting off, research uses the address published on the company's website instead.

**Research rules** (Settings → Autopilot & schedule):
- *Simple* (default) needs name, domain, a sourced description, a sourced opener and an offer. A decision-maker is optional; without one, emails start "Hi there".
- *Strict* is the original 12-fact checklist, which includes a human-confirmed decision-maker.

Email safety checks apply in both modes.

## Guarantees enforced in code

| Rule | Where |
|---|---|
| READY only when the research facts for the chosen mode (with source URLs) and all contact/dedup/compliance checks pass | `src/lib/qualification.js` |
| Decision-makers from imports must be human-confirmed | `dm_verified` checkbox |
| No guessed emails; support/privacy/billing/etc. inboxes rejected; email must be found on its source page (or attested by you) | `src/lib/emailRules.js`, `src/services/verification.js` |
| Apollo/Clay/HubSpot emails are never treated as public-source confirmed | `src/services/companies.js` |
| One intro per company, ever; Sent-folder history, HubSpot stage and existing conversations all block new intros | `src/services/suppression.js` |
| Opt-outs and complaints are permanent | `src/lib/constants.js` |
| Research never sends email or writes to HubSpot | `src/services/research.js` |
| Only approved messages are sent (by you or by autopilot after the quality gate), within the daily limit and the send window in the recipients' timezone | `src/services/outreach.js` |
| No HubSpot deals or contacts are created; company writes need approval and are confirmed by re-reading | `src/services/hubspotSync.js` |
| Apollo API search is off by default and never reveals emails | `src/integrations/apollo.js` |

## Integration notes

- **Groq** (free tier) is called with only the verified facts about a lead. The key lives in `.env` or Settings and is masked in the UI.
- **OpenStreetMap** comes from the public Nominatim and Overpass servers: free, no key, about 20–40 s per search. Data © OpenStreetMap contributors (ODbL).
- **HubSpot** is optional. Newer accounts use a *service key* (Development → Keys) instead of a private app token; both go in the same field.

- **Clay** has no read API. Export the table as CSV, or add an HTTP API column that POSTs rows to `/hooks/clay` with the `x-clay-secret` header. The webhook needs the app to be reachable, for example through a tunnel with `PUBLIC_BASE_URL` set.
- **Apollo**: CSV export import is the default. The people-search API is behind a setting because it only stays credit-free on plans where Apollo documents it as such.
- **Hostinger** SMTP doesn't store sent mail, so the app appends a copy of every sent message to your IMAP Sent folder. That keeps the mailbox the source of truth for dedup.

## Tests

```bash
npm run test:unit   # decision engine, email rules, normalization, reply classification
npm run test:e2e    # Playwright: 78 browser tests across all 12 phases
npx playwright show-report tests/.tmp/report
```

The E2E suite starts a mock HubSpot/Apollo API and five fake company websites (`tests/mocks/mock-server.js`). Email goes to a capture transport. No real website, CRM or mailbox is touched.
