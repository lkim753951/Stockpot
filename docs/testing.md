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
