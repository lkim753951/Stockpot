# How it works

Which Meta model does what, the rules that keep the numbers honest, and how the app fits together.

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
| Recipe files | `muse-spark-1.3` | Reads a PDF, photo, Word or text recipe through a strict schema: portions, ingredients as printed, method, and each time with the words that state it. Code does every conversion | Recipes are typed by hand, and the cost breakdown starts empty |
| Spreadsheets to import | `muse-spark-1.3` | Sees only the header and the first rows of a CSV or Excel file, and says which column holds what. Code reads every row, so no row's numbers pass through a model and a big file costs one call | Column names have to match the template |
| Documents to import | `muse-spark-1.3` | Reads sales reports and price lists in a PDF, photo, Word or text file into typed rows. Code checks them against the printed totals and, for Word and text, against the file's own words | Sales and prices on paper are typed by hand |
| Voice checks | `muse-voice-transcribe-1.0`, `PUSH_TO_TALK`, then `muse-spark-1.3` | Turns a spoken reading into the right checklist item and value | Staff stop with wet hands to type every reading |
| Photo checks | `muse-spark-1.3` | Reads a thermometer from a photo | Readings are typed and easily skipped |
| Spoken reports | `muse-voice-transcribe-1.0` with language detection, then `muse-spark-1.3` | Turns a report in any supported language into an English task | Staff who aren't confident in English go unheard |
| Investigating analyst | `muse-spark-1.3` with function tools | Calls read-only tools until it has traced an unusual number to its cause | The owner gets numbers with no explanation |
| Ask the analyst | `muse-spark-1.3` with function tools | Answers an owner's question and picks a table or chart, drawn with CopilotKit's standard catalog | The owner digs through reports by hand |
| Credit request | `muse-spark-1.3` | Writes the polite wording around numbers it can't change | The template wording is used instead |

Vocabulary improves with use: supplier names, items and past invoice lines are sent as transcription keywords on every call.

## What keeps it honest

- **Maths in code.** Margins, differences and amounts owed are calculated in SQL or TypeScript, never by a model. See the views in `server/core/db.ts`.
- **Nothing logged without a person.** A voice or photo reading is a proposal until staff confirm it. Range checks are plain code.
- **Figures must have a source.** Any amount or percentage in the weekly summary must come from a tool result. If one doesn't, the words are thrown out and the owner gets a plain summary written from the same SQL facts.
- **Models choose the view, not the numbers.** In an answer, Muse Spark names a tool result and a table or chart. Code copies the figures into the view.
- **Read-only tools.** The analyst can read, but it can't change data or contact anyone. Its steps are capped in code, and every argument is checked.
- **Suggestions stay suggestions.** Actions reach the owner's list only when the owner adds them.
- **The owner confirms new work.** Tasks from calls, staff reports and delivery problems wait under **To confirm** on Home and Tasks, with Confirm and Dismiss. They stay out of the lists and the badge until then, and a dismissed one doesn't come back. An urgent one still reaches the owner on WhatsApp.
- **Safety never waits.** A report with a crisis card, an urgent report about safety, and any reading out of range go straight to the list. So does a report that couldn't be read.
- **Evidence required.** Each order line must point to a transcript turn. If the price or quantity isn't in those words, the line goes to the owner to check.
- **Printed sums checked.** Quantity × price, line totals, net plus VAT and duplicate invoice numbers are all checked after reading. An imported file's rows are checked against its printed totals.
- **A file can't invent a number.** In a Word or text file, every figure a model gives must be in the file, or the row is flagged and left out. A time needs the words that state it. In any format, a time with no words behind it is dropped, and a price far from your last one is flagged, because a pack size is the likely mistake. The owner sees all of it first.
- **Originals kept.** A spoken report keeps its original words and audio, even if translation fails.
- **Nothing sent without approval.** Stockpot drafts. The owner approves and sends.
- **No model on crisis cards.** They're fixed text inside the app, so they also open with the wifi down.
- **Documents are treated as data.** Text inside a photo, a call or an invoice can't give the model instructions. In Word, text and spreadsheet files, a line written to steer an AI is removed before the model sees it, and the owner is told. A PDF or photo goes to the model whole, so there the rule in the prompt and the checks above do the work.

## How it works

Every AI call goes through the Node server, so the key never reaches a device. Every feature adds its decisions to one action inbox through `addAction` in `server/operations/actions.ts`.

```
Owner web app ─┐                   ┌→ live call gateway → Meta client → Muse Voice Transcribe
Staff web app ─┴→ routes, sign-in ─┤→ feature modules  → Meta client → Muse Spark
                                   ├→ SQL checks       → SQLite or Postgres
                                   └→ action inbox     → owner's home screen
```

The instant check in `server/ai/spotter.ts` runs on every partial transcript, so a clear price appears before the sentence ends. Muse Spark then settles anything less clear at the end of the turn.
