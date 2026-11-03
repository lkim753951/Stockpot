# Testing and limits

What has been tested, how to repeat it, and what Stockpot can't do yet.

## Tested so far

- `npm test` covers the flows through the real HTTP and WebSocket routes, against a stand-in that follows Meta's documented formats. That includes signed WhatsApp webhooks, voice notes decoded from real Ogg Opus files, and uploaded recordings.
- `npm run test:postgres` runs the same tests on real Postgres, with a new database for each test file. Point it at a server with `TEST_DATABASE_URL`. The default is port 5433 on this machine.
- A second server process stands in for a second instance, so sign-in, the analyst, cron and live calls are tested across two. One test kills a server in the middle of a call and checks the recording against the original, byte for byte.
- In `npm test`, Storage runs against a local stand-in for its REST API. The real site's deploy also wrote a test file to real Supabase Storage and read it back.
- Food cost and margins are checked against a hand calculation in `test/features.test.ts`. The cost calculator is checked against the Dashboard and a hand calculation in `test/ingest.test.ts`.
- `test/ingest.test.ts` runs all 22 dataset files through the real routes, covering sales, recipes and price lists in CSV, Excel, PDF, Word, text and image, and compares each with the ground truth. It also covers wrong columns, missing prices, totals that don't match, units that can't be converted, duplicate imports, files that are too large, injected instructions, and staff never receiving money. The stand-in can't read a PDF or a photo, so it answers those from the ground truth. That tests everything after the read, not the reading.
- All 22 dataset files passed through real Muse Spark on 3 November 2026, with rows and totals matching the ground truth. To repeat it, add a key to `.env` and run `npx tsx scripts/test-ai-ingest.ts`. It uses a throwaway database and writes `ingest-report.md`.
- The screens were measured in light and dark mode with the [ux-ui-agent-skills](https://github.com/plugin87/ux-ui-agent-skills) gates: axe, rendered contrast, keyboard, overflow, screen economy, mobile-first and reduced motion.
- The sample site runs on real Vercel, including a sample call over a live WebSocket.
- The real site runs on Vercel with Supabase. Its deploy check on 3 November 2026 reached Muse Spark, SAM 3.1, Muse Voice Transcribe and the live call connection from `fra1`, and one 5-minute timer pass ran cleanly.
- All 13 real Meta checks passed from a Mac on 3 November 2026, covering Muse Spark, Muse Voice Transcribe and SAM 3.1 on the sample files. To repeat them, run `npm run check:meta`. **WhatsApp, Twilio and Gmail have only been tested against stand-ins.** Real speakerphone audio, kitchen noise, handwriting and live delay are unmeasured.

## Known limits

- One restaurant only, with no multi-tenant separation.
- Passcode sign-in with two roles, not individual accounts.
- The recording notice relies on the owner playing it and ticking the box. Recording law and the privacy notice need review before real use.
- There's no labour figure, because there's no rota yet. The staff bar has no Rota or Me tab for the same reason.
- Food cost uses saved recipes and the newest price paid. Labour and other costs aren't included, so this isn't a full P&L. Prep and service time are shown but never turned into a cost, because there's no wage data.
- The calculator's margin uses the menu price as typed, and the Dashboard uses net sales. If your menu prices include VAT, the calculator looks better than the Dashboard until you take VAT off.
- A price list counts as a price paid from its date, so it feeds costs and the last-paid figure on calls, even if nothing was bought at that price.
- File import takes `.xlsx`, not the older `.xls`. A workbook has only its biggest sheet read, and the preview says so. A file can be 15 MB and 5,000 rows, and a Word or text file 60,000 characters. The sample site with no Storage stops at 4.5 MB.
- Import doesn't keep the file, so a recipe imported that way can't be read again. **Add a recipe** keeps it.
- Injected instructions in a PDF or a photo can't be removed by code. A fooled model could still give a figure that's printed in the file, so the owner's check matters most there.
- Temperature ranges and crisis cards are sample wording and need a qualified check before real use. Translations were machine-written and need a native speaker's review.
- Muse Voice Transcribe isn't documented for 8 kHz phone audio, so Stockpot captures speakerphone sound through the device microphone instead of connecting to the phone line.
- SAM reads MP4 and MOV, not WebM, so a clip it can't read is checked from its stills. Videos sent on WhatsApp aren't read yet, so proof there is a photo.
- Sample voices are synthetic and all names and prices are fictional. The three months in `public/samples/datasets` are fictional too. `npm run datasets` builds them again, along with their ground truth.
- On Supabase's free plan a file can be 50 MB at most. A recording fills that in about 17 minutes, so a longer call is still written up, but its recording stays in parts in Storage and can't be played in the app. A video over 50 MB won't upload either.
- WebSockets on Vercel are in public beta. A socket is cut off at about 300 seconds with no warning, so the browser moves to a new one every 4 minutes. A word can be cut at the join, on the live screen only: the recording and the write-up have no gap.
- If a call's connection drops and doesn't come back, it's written up after 45 seconds, or by the next cron pass if the instance has gone too.
- Timed work runs every 5 minutes on Vercel, so a reminder can be up to 5 minutes late. With no cron job set up, none of it happens.
- A chase set for an hour before a list is due lands a few minutes after the list itself, because lists also go out an hour before. 30 minutes before is more useful.
- A Supabase signed upload link lasts 2 hours and that can't be changed. Stockpot's own ticket for it runs out in 15 minutes.
- The JSON backups in Storage have every table, but there's no restore button. Restoring is a manual job, and Gmail has to be linked again, because the token is left out.
- The sample data can't be cleared on a site with a Meta key. Delete `data/stockpot.sqlite` to start empty.
- The limit on model calls counts per instance on Vercel, so the real limit is higher.
