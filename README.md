# Stockpot

Stockpot hears the price on a supplier call, watches the delivery, reads the invoice, and gets a restaurant its money back. It also runs the staff checklists, then gives the owner one list of what needs fixing today, with the numbers behind it.

Built for the Meta Global AI Developer Hackathon 2026, Build for Your World theme.

**For:** independent UK restaurant owners who run the business from their phone.

**Try it:** [stockpot-app.vercel.app](https://stockpot-app.vercel.app). It runs on made-up data with simulated AI, so it needs no key and no sign-in. To use the real Meta models, run it with your own key, as described below.

## Run it

You need Node 22.13 or newer. With [nvm](https://github.com/nvm-sh/nvm), run `nvm use`. On a Mac you can double-click `start-stockpot.command` instead of running the commands below.

```bash
npm ci
npm run build
npm start
```

Open http://localhost:8787. With no key, the app runs in sample mode: a fictional restaurant, scripted clips and no AI running. With a key it starts empty, and Home walks you through adding your suppliers, menu, checklists and sales. Sample mode is labelled on every screen.

### Use the real Meta models

```bash
cp .env.example .env     # then add MODEL_API_KEY
npm run check:meta       # tests each model with the sample files
npm start
```

For a real supplier call, put the phone on speaker near the device and allow the microphone. Browsers only allow the microphone on `localhost` or HTTPS.

## One day in the restaurant

| Time | What happens | Feature |
| --- | --- | --- |
| 07:30 | Staff say "fridge two is at 9 degrees". Stockpot logs it and tells the owner it's out of range | Checklists, voice and photo checks |
| 09:00 | A supplier quotes a higher price, and the last price paid appears during the call | Business phone line, live price help |
| 09:05 | The call becomes a summary, a draft order and a task due Thursday | Business phone line |
| 11:00 | The owner uploads receipts. Each line becomes a row, and unsure lines are flagged | Receipt scanner |
| 15:00 | A worker reports a fridge fault in Polish, and the owner gets an English task | Reports in any language |
| 15:01 | Staff open the fridge card in two taps | Crisis protocols |
| 22:30 | A closing check is overdue, and the owner is told | Checklists |
| 23:00 | The weekly summary traces a food cost rise to one supplier's price, with sources and 3 suggested actions | Owner mode, investigating analyst |

The app opens on a short welcome, then you choose Owner or Staff. Each role has its own tabs, and the switch at the top changes between them.

- **Owner:** Home, Dashboard, Tasks and Features, with Stockpot chat in the centre of the bar. Home shows what needs you, four numbers and every feature with its status. Features lists receipts, deliveries, calls, checklists, crisis cards and the rest.
- **Staff:** Today, Report, Recipes, Deliveries and Crisis, with big buttons for wet hands. Staff never see costs, and the server enforces this when passcodes are set.

Sample mode starts the day at 07:30 and has a **Demo: jump to 22:30** button on Home, so the whole day can be shown in one sitting. WhatsApp is simulated there: open Checklists, send a list, and reply as Maria.

## Set it up for your restaurant

On first sign-in, Stockpot asks five short questions and saves the answers: your name, suppliers, menu, Google sign-in and team. You can run it again from Settings. Everything else is under the gear icon.

- **Suppliers:** name, contact, email and phone. Calls, receipts and Gmail all match against this list.
- **Menu and recipes:** add dishes one at a time, or upload a menu photo or PDF. Muse Spark reads it and you check it before anything is saved.
- **Checklists:** every day, chosen days, or rules like the first and third Wednesday of the month. Each list has a deadline and a person. It can chase on WhatsApp, then ring a phone, once, at a time you choose from an hour before the deadline to an hour after. A list always goes out before it's chased. Each check needs a photo or video unless you turn that off.
- **Team:** send an invite link. The worker taps it and presses send, and is added. This also opens WhatsApp's 24-hour window. Adding a number by hand works too.
- **Sales:** import a CSV from your till. Till connections are not built.
- **Crisis cards:** the owner can change any card, add photos to steps, make new cards, or go back to the standard card. The cards stay readable with no connection.
- **Recipes for staff:** staff see ingredients and method, never prices or margins.
- **Deliveries:** every order on one timeline, from the call to the invoice, with its order date and delivery date. A new supplier can be added while adding a delivery. Whoever takes it in, owner or staff, records the day it came, who received it, how much came, where it was put, what went wrong, and any photos or videos. Counting can be done by filming the delivery. A problem becomes an urgent task with a Call button, and **What to say** gives the owner an opening, the facts, the ask and a reply if they push back. Every number comes from the check. The proof for each line shows what was heard on the call, what arrived and what was billed.
- **Price check:** old invoices alone show what was paid above the first price for each item, and anything that may be billed twice. It needs no calls or orders, so a restaurant can see a figure from its first batch of invoices.
- **Language:** 18 languages for UK kitchens: English, Polish, Romanian, Spanish, Portuguese, Italian, French, Turkish, Bengali, Hindi, Urdu, Nepali, Arabic, Chinese, Vietnamese, Tagalog, Korean and Japanese. Arabic and Urdu run right to left. The app follows the browser the first time and remembers your choice. WhatsApp replies use the language each person writes in.

### For whoever runs Stockpot

Owners never see keys. Open `#/developer` directly to add the Meta key, Google client, WhatsApp details and Twilio details. They are saved to `.env`. WhatsApp sign-up for each restaurant would need Meta's Embedded Signup, which isn't built.

**Google:** create a project, turn on the Gmail API, add test users under Google Auth Platform, and create a Web application OAuth client with the redirect URI `http://localhost:8787/api/google/callback`. The owner then just signs in with Google. The token is kept in the database and never reaches a browser. A Mac linked before this keeps working: its old token file is read once, then removed.

**Twilio:** add the account SID, auth token, a number that can call and the phone that should ring, then press **Ring my phone** on `#/developer`. Stockpot reads a short sentence twice, in the person's language if Twilio has a voice for it and in English if not. A trial account can only call verified numbers.

## How Meta models are used


| Step | Model | What it does | What breaks without it |
| --- | --- | --- | --- |
| Live call | `muse-voice-transcribe-1.0`, `ENDPOINTING` | Streams the call and marks each turn | No live price card, because nothing hears the supplier |
| Live meaning | `muse-spark-1.3` | Separates a new offer, a remembered price and an agreed deal | Stockpot can't tell "six forty last week" from "six forty today" |
| After the call | `muse-voice-transcribe-1.0`, `DIARIZATION` | Labels who said what, with turn timings | No clip of the supplier agreeing the price |
| Draft order and tasks | `muse-spark-1.3` | Turns the call into order lines and tasks, each line tied to the turn that proves it | The owner types it all by hand |
| Receipts and invoices | `muse-spark-1.3` | Reads photos and PDFs into typed lines, including handwritten changes | No cost data to check against |
| Proof photos and videos | `sam-3.1`, then `muse-spark-1.3` | SAM finds the thing a check is about, and follows it through a whole video with a box the worker can see. Spark judges the stills where it was visible and says if the job was done. A worker decides, and a saved doubt goes to the owner | The owner has only a tick to go on |
| Counting a delivery on video | `sam-3.1` | Each object keeps its id through a pan, so a worker films along the pallet and gets a count against the order, with a number on each box. The worker checks it before it's used | An object that leaves shot and comes back can be counted twice. Accuracy on real deliveries hasn't been measured |
| Several receipts in one photo | `sam-3.1` | Finds each receipt, so each gets its own row | A pile has to be photographed one at a time |
| Menus | `muse-spark-1.3` | Reads dishes, prices and printed recipes | Every dish is typed by hand |
| Voice checks | `muse-voice-transcribe-1.0`, `PUSH_TO_TALK`, then `muse-spark-1.3` | Turns a spoken reading into the right checklist item and value | Staff stop with wet hands to type every reading |
| Photo checks | `muse-spark-1.3` | Reads a thermometer from a photo | Readings are typed and easily skipped |
| Spoken reports | `muse-voice-transcribe-1.0` with language detection, then `muse-spark-1.3` | Turns a report in any supported language into an English task | Staff who aren't confident in English go unheard |
| Investigating analyst | `muse-spark-1.3` with function tools | Calls read-only tools until it has traced an unusual number to its cause | The owner gets numbers with no explanation |
| Ask the analyst | `muse-spark-1.3` with function tools | Answers an owner's question and picks a table or chart, drawn with CopilotKit's standard catalog | The owner digs through reports by hand |
| Credit request | `muse-spark-1.3` | Writes the polite wording around numbers it can't change | The template wording is used instead |

Vocabulary improves with use: supplier names, items and past invoice lines are sent as transcription keywords on every call.

## What keeps it honest

- **Maths in code.** Margins, differences and amounts owed are calculated in SQL or TypeScript, never by a model. See the views in `server/db.ts`.
- **Nothing logged without a person.** A voice or photo reading is a proposal until staff confirm it. Range checks are plain code.
- **Figures must have a source.** Any amount or percentage in the weekly summary must come from a tool result. If one doesn't, the words are thrown out and the owner gets a plain summary written from the same SQL facts.
- **Models choose the view, not the numbers.** In an answer, Muse Spark names a tool result and a table or chart. Code copies the figures into the view.
- **Read-only tools.** The analyst can read, but it can't change data or contact anyone. Its steps are capped in code, and every argument is checked.
- **Suggestions stay suggestions.** Actions reach the owner's list only when the owner adds them.
- **The owner confirms new work.** Tasks from calls, staff reports and delivery problems wait under **To confirm** on Home and Tasks, with Confirm and Dismiss. They stay out of the lists and the badge until then, and a dismissed one doesn't come back. An urgent one still reaches the owner on WhatsApp.
- **Safety never waits.** A report with a crisis card, an urgent report about safety, and any reading out of range go straight to the list. So does a report that couldn't be read.
- **Evidence required.** Each order line must point to a transcript turn. If the price or quantity isn't in those words, the line goes to the owner to check.
- **Printed sums checked.** Quantity × price, line totals, net plus VAT and duplicate invoice numbers are all checked after reading.
- **Originals kept.** A spoken report keeps its original words and audio, even if translation fails.
- **Nothing sent without approval.** Stockpot drafts. The owner approves and sends.
- **No model on crisis cards.** They're fixed text inside the app, so they also open with the wifi down.
- **Documents are treated as data.** Text inside a photo, a call or an invoice can't give the model instructions.

## How it works

Every AI call goes through the Node server, so the key never reaches a device. Every feature adds its decisions to one action inbox through `addAction` in `server/actions.ts`.

```
Owner web app ─┐                   ┌→ live call gateway → Meta client → Muse Voice Transcribe
Staff web app ─┴→ routes, sign-in ─┤→ feature modules  → Meta client → Muse Spark
                                   ├→ SQL checks       → SQLite or Postgres
                                   └→ action inbox     → owner's home screen
```

The instant check in `server/spotter.ts` runs on every partial transcript, so a clear price appears before the sentence ends. Muse Spark then settles anything less clear at the end of the turn.

## WhatsApp, phone and alerts

- **Team messages:** checklists go to staff on WhatsApp an hour before they're due, or when the owner presses Send on WhatsApp. Staff answer with a message, a voice note or a thermometer photo, in any language. Muse Spark and Muse Voice Transcribe read the reply, and it comes back with Save and Change buttons, so nothing is logged until a person confirms it. A message that isn't about a check becomes a staff report in English. Urgent ones send the crisis steps straight back.
- **Assign:** a card on Actions can be sent to someone on WhatsApp.
- **Alerts:** a new urgent item sounds a chime, shows a banner, adds to the badge on Actions, and goes to the owner on WhatsApp.
- **Calls:** Stockpot has no phone number of its own. It hears a supplier call on speaker through the device microphone, or the owner uploads a recording. Either way the call becomes a summary, a draft order if there is one, and tasks sorted into urgent, due and not important. It doesn't place calls, because Meta's models don't produce speech.
- **Google Calendar:** a dated item can be added to the owner's own calendar with one tap.
- **Till:** a sales CSV is the integration for now, under Settings, Sales.

### Connect WhatsApp on a Mac

1. Double-click `connect-apis.command` and add your Meta key and WhatsApp details. They stay in `.env`, which is never committed.
2. Double-click `start-stockpot.command`.
3. For replies, double-click `open-whatsapp-replies.command`. It opens a public address that reaches only the signed webhook on port 8788, not the owner's screens, and prints the callback URL and verify token to paste into your Meta app.

On a Mac, phone numbers stay in `.env`. On Vercel, staff added in the app are kept in the database, because there's no file to write to and instances share no memory. Numbers are never logged or sent to a browser, and only people on the list can reach Stockpot. A message from anyone else is dropped before it costs a model call. Every webhook delivery is checked against your app secret.

WhatsApp only delivers free-form text within 24 hours of a person's last message to the business number, so each person sends it a message first. Stockpot uses no message templates yet, so a list sent outside that window fails, and the Connections screen says why.

## Built during the hackathon

Everything in this repository was written during the event. Code was written with Claude. Reused parts are open-source packages listed in `package.json`, the Stockpot brand files, Bricolage Grotesque and Atkinson Hyperlegible fonts, Phosphor icons, and the MIT-licensed [Stageshow](https://benji.org/stageshow) kit in `src/kit` for the welcome page demos only. The demos load separately, so the kit never slows the app itself.

## Tested so far

- `npm test` covers the flows through the real HTTP and WebSocket routes, against a stand-in that follows Meta's documented formats. That includes signed WhatsApp webhooks, voice notes decoded from real Ogg Opus files, and uploaded recordings.
- `npm run test:postgres` runs the same tests on real Postgres, with a new database for each test file. Point it at a server with `TEST_DATABASE_URL`. The default is port 5433 on this machine.
- A second server process stands in for a second instance, so sign-in, the analyst, cron and live calls are tested across two. One test kills a server in the middle of a call and checks the recording against the original, byte for byte.
- Storage is tested against a local stand-in for its REST API, not against Supabase.
- `node scripts/check-await.cjs` uses the TypeScript compiler to find any promise nobody is waiting for. It needs the global `typescript` package.
- Food cost and margins are checked against a hand calculation in `test/features.test.ts`.
- The screens were measured in light and dark mode with the [ux-ui-agent-skills](https://github.com/plugin87/ux-ui-agent-skills) gates: axe, rendered contrast, keyboard, overflow, screen economy, mobile-first and reduced motion.
- The sample site runs on real Vercel, including a sample call over a live WebSocket.
- Muse Spark has run for real from a Mac. **Muse Voice Transcribe, SAM 3.1, WhatsApp, Twilio, Gmail and Supabase have only been tested against stand-ins.** Run `npm run check:meta` with a key. Real speakerphone audio, kitchen noise, handwriting and live delay are unmeasured.

## Known limits

- One restaurant only, with no multi-tenant separation.
- Passcode sign-in with two roles, not individual accounts.
- The recording notice relies on the owner playing it and ticking the box. Recording law and the privacy notice need review before real use.
- There's no labour figure, because there's no rota yet. The staff bar has no Rota or Me tab for the same reason.
- Food cost uses saved recipes and the newest price paid. Waste, labour and other costs aren't included, so this isn't a full P&L.
- Temperature ranges and crisis cards are sample wording and need a qualified check before real use. Translations were machine-written and need a native speaker's review.
- Muse Voice Transcribe isn't documented for 8 kHz phone audio, so Stockpot captures speakerphone sound through the device microphone instead of connecting to the phone line.
- SAM reads MP4 and MOV, not WebM, so a clip it can't read is checked from its stills. Videos sent on WhatsApp aren't read yet, so proof there is a photo.
- Sample voices are synthetic and all names and prices are fictional.
- On Supabase's free plan a file can be 50 MB at most. A recording fills that in about 17 minutes, so a longer call is still written up, but its recording stays in parts in Storage and can't be played in the app. A video over 50 MB won't upload either.
- WebSockets on Vercel are in public beta. A socket is cut off at about 300 seconds with no warning, so the browser moves to a new one every 4 minutes. A word can be cut at the join, on the live screen only: the recording and the write-up have no gap.
- If a call's connection drops and doesn't come back, it's written up after 45 seconds, or by the next cron pass if the instance has gone too.
- Timed work runs every 5 minutes on Vercel, so a reminder can be up to 5 minutes late. With no cron job set up, none of it happens.
- A chase set for an hour before a list is due lands a few minutes after the list itself, because lists also go out an hour before. 30 minutes before is more useful.
- A Supabase signed upload link lasts 2 hours and that can't be changed. Stockpot's own ticket for it runs out in 15 minutes.
- The JSON backups in Storage have every table, but there's no restore button. Restoring is a manual job, and Gmail has to be linked again, because the token is left out.
- The sample data can't be cleared on a site with a Meta key. Delete `data/stockpot.sqlite` on a Mac to start empty.
- The limit on model calls counts per instance on Vercel, so the real limit is higher.

## Where data lives

| | On a Mac | On Vercel |
| --- | --- | --- |
| Database | SQLite in `data/stockpot.sqlite` | Postgres on Supabase |
| Files, photos, videos, recordings | `data/uploads` and `data/calls` | A private Supabase Storage bucket |
| Backups | A copy a day in `data/backups`, a week kept | A JSON file a day under `backups/` in the bucket, a week kept |
| Timers | A timer inside the server, every 5 minutes | `POST /api/cron`, called by Supabase Cron every 5 minutes |
| Temp folder | Not used | A throwaway cache of files, filled again as needed |

With no `DATABASE_URL`, Stockpot uses SQLite. With no `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`, it uses local files. An existing `data` folder keeps working as it is.

Large files don't pass through the server, because Vercel stops a request at 4.5 MB. The browser sends them straight to Storage on a short-lived link.

## Deploy

This runs on Vercel with Supabase, as two projects: the real site and a public sample. Nothing here needs a change to the code.

**The short way.** Create a Supabase project, double-click `put-stockpot-online.command`, and paste the connection address and secret key when it asks. It makes both buckets, deploys both sites from this folder, copies your keys from `.env`, sets up the 5-minute timer and presses Test Meta from Vercel. If Meta refuses a region, it moves to the next. Your keys stay in `.env.hosting` on the Mac and in Vercel, and it prints none of them. Run it again after any change.

Vercel Hobby is for non-commercial personal use only. A site that earns money for anyone needs Vercel Pro.

**The sample only.** Double-click `put-sample-online.command`. It needs no keys or database, because the sample keeps its made-up data on the function's temporary disk. That data resets when the function restarts, instances don't share it, and uploads stop at 4.5 MB.

The rest of this section does the same by hand.

### 1. Supabase

1. Create a project, and choose London (`eu-west-2`) or the nearest region to it.
2. Copy the connection string from **Connect**, under **Transaction pooler**. It uses port 6543. This is `DATABASE_URL`. Don't use the direct connection, because serverless instances would run out of connections.
3. Under **Storage**, create a private bucket called `stockpot`, and a second private one called `stockpot-sample`.
4. Copy the project URL. This is `SUPABASE_URL`. Copy the `service_role` key. This is `SUPABASE_SERVICE_KEY`. Treat it like a password.

The tables build themselves on first use, in a transaction, so two instances starting together can't clash. The real site uses the `public` schema and the sample uses `sample`. Row level security is turned on for every table, so Supabase's public Data API can't read them, and Stockpot is unaffected because it connects as the owner.

### 2. Vercel

Import the repository twice, as two projects. `vercel.json` sets the build, the output folder, the routes and the region, so leave those settings alone.

Every variable below goes under **Settings, Environment Variables**. The real site needs a new deployment after any change.

| Variable | Real site | Sample site |
| --- | --- | --- |
| `DATABASE_URL` | Pooled connection string | The same one |
| `DB_SCHEMA` | Leave empty | `sample` |
| `SUPABASE_URL` | Project URL | The same one |
| `SUPABASE_SERVICE_KEY` | `service_role` key | The same one |
| `SUPABASE_BUCKET` | Leave empty for `stockpot` | `stockpot-sample` |
| `CRON_SECRET` | Long random text | Different long random text |
| `MODEL_API_KEY` | Your Meta key | Leave empty |
| `OWNER_PASSCODE` | Required | Leave empty |
| `STAFF_PASSCODE` | Required | Leave empty |
| `SESSION_SECRET` | Long random text, required | Leave empty |
| `RESTAURANT_TIMEZONE` | Optional, default `Europe/London` | Optional |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For Gmail | Leave empty |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `OWNER_PHONE` | For phone calls | Leave empty |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_OWNER_NUMBER`, `WHATSAPP_BUSINESS_NUMBER`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | For WhatsApp | Leave empty |
| `WHATSAPP_STAFF_NUMBERS` | Optional. Staff added in the app are saved in the database and replace this | Leave empty |

The real site refuses to start without its passcodes, its session secret, its database and its Storage. A site with no Meta key is treated as the sample. If it has a database, it refuses to start unless `DB_SCHEMA` is `sample`, so it can never clear the real tables. A database a real site has used is also marked, and sample mode won't clear it. The Connections screen can't save keys on Vercel, because there's no file to save them to.

### 3. Supabase Cron

Nothing runs on a timer on Vercel by itself. In Supabase, turn on the `pg_cron` and `pg_net` extensions under **Database, Extensions**. Then run this in the SQL editor, with your own address and secret:

```sql
select cron.schedule(
  'stockpot-pass',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR-REAL-SITE.vercel.app/api/cron',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET'),
    timeout_milliseconds := 290000
  );
  $$
);
```

Each pass does the day's checklists, overdue flags, actions, sending, reminders, chasing, Gmail, the weekly summary and the backup. Passes can overlap safely, because each step claims its work first. Nobody gets two reminders or two calls.

The sample doesn't need this, because its screens run the checks themselves.

### 4. Google and WhatsApp

- **Google:** add `https://YOUR-REAL-SITE.vercel.app/api/google/callback` as a redirect URI on the OAuth client.
- **WhatsApp:** in your Meta app, set the callback URL to `https://YOUR-REAL-SITE.vercel.app/whatsapp/webhook`, with your verify token. Every delivery is still checked against your app secret.

### 5. Check it

- `https://YOUR-REAL-SITE.vercel.app/healthz` should say `{"ok":true}`. It doesn't touch the database, so it shows the function is up and nothing more.
- Sign in and open `#/developer`. Press **Test Meta**. This shows that Meta answers from Vercel's region, which `npm run check:meta` on a Mac can't show.

### If Meta refuses the region

Stockpot runs in London, set by `regions` in `vercel.json`. Hobby allows one region. To move it, change that one value and deploy again:

```json
"regions": ["dub1"]
```

Try `dub1` (Dublin), `cdg1` (Paris), `fra1` (Frankfurt), then `iad1` (Washington). Then press **Test Meta** again. Home makes about 100 database queries, so the database should be close to the function. If you end up far from London, move the Supabase project too.

If every region is refused, set `META_BASE_URL` to a relay in a region Meta accepts. A plain HTTP relay doesn't carry the live call's WebSocket.

### Other hosts

Any Node host with HTTPS and a persistent disk also works, with SQLite and files under `DATA_DIR`. The build command is `npm ci --include=dev && npm run build`, and the start command is `npm start`. Set `NODE_ENV=production`, `MODEL_API_KEY`, `OWNER_PASSCODE`, `STAFF_PASSCODE`, `SESSION_SECRET` and `DATA_DIR`. A copy of the database is made once a day under `backups`, and a week is kept.
