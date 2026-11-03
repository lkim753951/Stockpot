# Testing

What has been tested, and how to repeat it.

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

## Real site test, 3 November 2026

These ran through the real Vercel site and Supabase, with the real Meta models and the sample files.

| Feature | Result |
| --- | --- |
| Invoice photo | Number, 2 lines and total of £146.50 all correct, about 6 seconds |
| Voice check | "Fridge two is at nine degrees" saved as 9°C, flagged out of range, about 6 seconds |
| Photo proof | Read 9°C, and flagged that the display said Fridge 2 on the Fridge one check, about 8 seconds |
| Video proof | SAM 3.1 followed the display through 100% of the clip, through a Supabase link |
| Video count | Counted 4 boxes from a 5 MB clip sent straight to Storage, about 12 seconds |
| Live camera frame | 3 boxes in about 1.3 seconds |
| Staff report | Polish voice note became an English task |
| Uploaded call | 9 turns, summary and speakers |
| Live call | First words after about 2 seconds, price card as the price was said, draft order with the agreed price |
| Import | 2 files read, totals matched the printed totals |
| Recipe PDF | Read in about 7 seconds |
| Analyst | Answered from the invoice with the right price and total |
| WhatsApp | Message received, reply delivered, checklist sent |

Not tested yet: a real microphone call, a real camera, the template message, Gmail and phone calls.

