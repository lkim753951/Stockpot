# Deploy

Where data lives, and how to run Stockpot on Vercel and Supabase.

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

## Deploy to Vercel and Supabase

This runs on Vercel with Supabase, as two projects: the real site and a public sample. Nothing here needs a change to the code.

The sample stays on made-up data with no key and no database, so it never holds the real site's secrets. It keeps that data on the function's temporary disk. The data resets when the function restarts, instances don't share it, and uploads stop at 4.5 MB.

Vercel Hobby is for non-commercial personal use only. A site that earns money for anyone needs Vercel Pro.

### 1. Supabase

1. Create a project in a region near your restaurant. The live site uses Frankfurt (`eu-central-1`).
2. Copy the connection string from **Connect**, under **Transaction pooler**. It uses port 6543. This is `DATABASE_URL`. Don't use the direct connection, because serverless instances would run out of connections.
3. Under **Storage**, create a private bucket called `stockpot`.
4. Copy the project URL. This is `SUPABASE_URL`. Copy the secret key that starts with `sb_secret_`. This is `SUPABASE_SERVICE_KEY`. Treat it like a password.

The tables build themselves on first use, in a transaction, so two instances starting together can't clash. The real site uses the `public` schema. Row level security is turned on for every table, so Supabase's public Data API can't read them, and Stockpot is unaffected because it connects as the owner.

### 2. Vercel

Import the repository twice, as two projects. `vercel.json` sets the build, the output folder, the routes and the region, so leave those settings alone.

Every variable below goes under **Settings, Environment Variables**. The real site needs a new deployment after any change.

| Variable | Real site | Sample site |
| --- | --- | --- |
| `DATABASE_URL` | Pooled connection string | Leave empty |
| `DB_SCHEMA` | Leave empty | Leave empty |
| `SUPABASE_URL` | Project URL | Leave empty |
| `SUPABASE_SERVICE_KEY` | `sb_secret_` key | Leave empty |
| `SUPABASE_BUCKET` | Leave empty for `stockpot` | Leave empty |
| `CRON_SECRET` | Long random text | Leave empty |
| `MODEL_API_KEY` | Your Meta key | Leave empty |
| `OWNER_PASSCODE` | Required | Leave empty |
| `STAFF_PASSCODE` | Required | Leave empty |
| `SESSION_SECRET` | Long random text, required | Leave empty |
| `RESTAURANT_TIMEZONE` | Optional, default `Europe/London` | Optional |
| `OTHER_SITE_URL` | The sample's address | The real site's address |
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

Stockpot runs in Frankfurt, set by `regions` in `vercel.json`. Hobby allows one region. To move it, change that one value and deploy again:

```json
"regions": ["cdg1"]
```

Try `cdg1` (Paris), `dub1` (Dublin), `lhr1` (London), then `iad1` (Washington). Then press **Test Meta** again. Home makes about 100 database queries, so the database should be close to the function. If you end up far from Frankfurt, move the Supabase project too.

If every region is refused, set `META_BASE_URL` to a relay in a region Meta accepts. A plain HTTP relay doesn't carry the live call's WebSocket.

### Other hosts

Any Node host with HTTPS and a persistent disk also works, with SQLite and files under `DATA_DIR`. The build command is `npm ci --include=dev && npm run build`, and the start command is `npm start`. Set `NODE_ENV=production`, `MODEL_API_KEY`, `OWNER_PASSCODE`, `STAFF_PASSCODE`, `SESSION_SECRET` and `DATA_DIR`. A copy of the database is made once a day under `backups`, and a week is kept.
