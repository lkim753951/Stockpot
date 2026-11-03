# Features

What Stockpot does through a working day, how a restaurant sets it up, and how it connects to WhatsApp and phones.

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
- **Menu and recipes:** add dishes one at a time, upload a menu photo or PDF, or use **Add a recipe** to upload a recipe as a PDF, photo or Word file, with a dish photo if you have one. Muse Spark reads it and you check it before anything is saved. It reads portions, ingredients, method, prep time and service time, turns quantities into amounts for one portion in kg, l or each, and flags anything it can't convert. A time or quantity the file doesn't state stays empty. An existing dish can take a file too, and **Read the file again** shows what would change first.
- **Cost and margin:** every dish shows each ingredient's quantity, latest price, cost per portion and share of the total, then the food cost, the margin against your target, the menu price that hits the target, and prep and service time. Type a price to try it, with no saving needed. It uses the Dashboard's costing, so the numbers agree. A new ingredient shows **No price yet**, and the cost is marked incomplete rather than understated. Labour isn't included, because there's no wage data.
- **Import a file:** one place for sales, recipes and supplier price lists, as CSV, Excel, PDF, Word, text or a photo. Column names don't have to match anything. You see a preview with anything unsure flagged, and nothing is saved until you confirm. A price list needs a supplier and a date, and adds to the price history without changing it. An unknown dish is flagged, never created, and loading a file twice doesn't count twice: the preview says what was skipped.
- **Checklists:** every day, chosen days, or rules like the first and third Wednesday of the month. Each list has a deadline and a person. It can chase on WhatsApp, then ring a phone, once, at a time you choose from an hour before the deadline to an hour after. A list always goes out before it's chased. Each check needs a photo or video unless you turn that off.
- **Team:** send an invite link. The worker taps it and presses send, and is added. This also opens WhatsApp's 24-hour window. Adding a number by hand works too.
- **Sales:** import a CSV from your till, or any file through **Import a file**. Till connections are not built.
- **Crisis cards:** the owner can change any card, add photos to steps, make new cards, or go back to the standard card. The cards stay readable with no connection.
- **Recipes for staff:** staff see the dish photo, ingredients, numbered steps, and prep and service time, never prices, costs or margins. The server enforces this, and it takes any line about money out of the method before staff get it. The uploaded recipe file stays with the owner.
- **Deliveries:** every order on one timeline, from the call to the invoice, with its order date and delivery date. A new supplier can be added while adding a delivery. Whoever takes it in, owner or staff, records the day it came, who received it, how much came, where it was put, what went wrong, and any photos or videos. Counting can be done by filming the delivery. A problem becomes an urgent task with a Call button, and **What to say** gives the owner an opening, the facts, the ask and a reply if they push back. Every number comes from the check. The proof for each line shows what was heard on the call, what arrived and what was billed.
- **Price check:** old invoices alone show what was paid above the first price for each item, and anything that may be billed twice. It needs no calls or orders, so a restaurant can see a figure from its first batch of invoices.
- **Language:** 18 languages for UK kitchens: English, Polish, Romanian, Spanish, Portuguese, Italian, French, Turkish, Bengali, Hindi, Urdu, Nepali, Arabic, Chinese, Vietnamese, Tagalog, Korean and Japanese. Arabic and Urdu run right to left. The app follows the browser the first time and remembers your choice. WhatsApp replies use the language each person writes in.

### For whoever runs Stockpot

Owners never see keys. Open `#/developer` directly to add the Meta key, Google client, WhatsApp details and Twilio details. They are saved to `.env`. WhatsApp sign-up for each restaurant would need Meta's Embedded Signup, which isn't built.

**Google:** create a project, turn on the Gmail API, add test users under Google Auth Platform, and create a Web application OAuth client with the redirect URI `http://localhost:8787/api/google/callback`. The owner then just signs in with Google. The token is kept in the database and never reaches a browser. A Mac linked before this keeps working: its old token file is read once, then removed.

**Twilio:** add the account SID, auth token, a number that can call and the phone that should ring, then press **Ring my phone** on `#/developer`. Stockpot reads a short sentence twice, in the person's language if Twilio has a voice for it and in English if not. A trial account can only call verified numbers.

## WhatsApp, phone and alerts

- **Team messages:** checklists go to staff on WhatsApp an hour before they're due, or when the owner presses Send on WhatsApp. Staff answer with a message, a voice note or a thermometer photo, in any language. Muse Spark and Muse Voice Transcribe read the reply, and it comes back with Save and Change buttons, so nothing is logged until a person confirms it. A message that isn't about a check becomes a staff report in English. Urgent ones send the crisis steps straight back.
- **Assign:** a card on Actions can be sent to someone on WhatsApp.
- **Alerts:** a new urgent item sounds a chime, shows a banner, adds to the badge on Actions, and goes to the owner on WhatsApp.
- **Calls:** Stockpot has no phone number of its own. It hears a supplier call on speaker through the device microphone, or the owner uploads a recording. Either way the call becomes a summary, a draft order if there is one, and tasks sorted into urgent, due and not important. It doesn't place calls, because Meta's models don't produce speech.
- **Google Calendar:** a dated item can be added to the owner's own calendar with one tap.
- **Till:** a sales CSV is the integration for now, under Settings, Sales.

### Connect WhatsApp on your own machine

1. Add your Meta key and WhatsApp details to `.env`, which is never committed.
2. Run `npm start`.
3. For replies, open a tunnel to port 8788, for example `npx cloudflared tunnel --url http://127.0.0.1:8788`. That port reaches only the signed webhook, not the owner's screens. In your Meta app, use the tunnel address plus `/whatsapp/webhook` as the callback URL, and `WHATSAPP_VERIFY_TOKEN` as the verify token.

On your own machine, phone numbers stay in `.env`. On Vercel, staff added in the app are kept in the database, because there's no file to write to and instances share no memory. Numbers are never logged or sent to a browser, and only people on the list can reach Stockpot. A message from anyone else is dropped before it costs a model call. Every webhook delivery is checked against your app secret.

WhatsApp only delivers free-form text within 24 hours of a person's last message to the business number. Outside that window, Stockpot uses the approved template named in `WHATSAPP_TEMPLATE`, so it can message someone first. Reply buttons only appear inside the window. With no template set, a list sent outside the window fails, and the Connections screen says why.
