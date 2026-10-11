# Setting up Household Manager

About an hour, done once. You will create five free accounts and paste a few values between them.
Steps 1–4 get the app working on both phones. Steps 5–8 add Google Calendar, email, texts and
forwarded emails; each one works on its own, so you can stop after any of them.

What it costs: Supabase, Netlify, Google Cloud, Brevo and CloudMailin all have free plans that cover a
household. Claude is billed per use through your existing Anthropic API key, typically a few cents a day.

---

## 1. Supabase (the database and server)

1. Sign up at **supabase.com** and click **New project**. Name it `household`, pick the region closest to you
   (East US), and set a database password. **Save that password** — you need it in step 2.
2. When it finishes, open **Project Settings → General** and copy the **Reference ID** (looks like `abcdxyzklmnop`).
3. Open **Project Settings → API** (or **API Keys**) and copy:
   - the **Project URL** (`https://<reference>.supabase.co`)
   - the **publishable** key (older projects call it **anon public**). This one is safe to share.

## 2. Connect GitHub so changes deploy themselves

1. In Supabase, click your avatar → **Account preferences → Access tokens** → **Generate new token**. Copy it.
2. On GitHub, open the `household-manager` repo → **Settings → Secrets and variables → Actions → New repository secret**, and add three:
   - `SUPABASE_ACCESS_TOKEN` — the token you just made
   - `SUPABASE_PROJECT_REF` — the Reference ID
   - `SUPABASE_DB_PASSWORD` — the database password
3. Go to the repo's **Actions** tab → **Test and deploy** → **Run workflow**. When it turns green, your
   tables and server functions exist.

## 3. Sign-ins and your household's data

1. In Supabase → **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up"
   and turn **off** "Confirm email". Nobody can create an account except you, from the dashboard.
2. **Authentication → Users → Add user → Create new user**: add yourself and Jordan with an email and password,
   with **Auto Confirm** ticked. Use the same emails as in the next step.
3. **SQL Editor → New query**: paste and run `setup-household.sql` (the filled-in copy you were sent;
   `supabase/setup/household.sql` is a blank template). It sets who may sign in and your settings.
4. Run `import-data.sql` the same way. It brings over the people, calendar and inbox from the old Sheet.

## 4. Put the app online and on your phones

1. Sign up at **netlify.com** with your GitHub account → **Add new site → Import an existing project → GitHub** →
   pick `household-manager`. Leave the build settings as they are (they come from `netlify.toml`) and click **Deploy**.
2. Edit `web/config.js` in the repo (on GitHub, click the file, then the pencil) and fill in the Project URL and
   publishable key from step 1. Commit. Netlify republishes within a minute.
3. Open the Netlify address on your phone and sign in.
   - **iPhone:** Share → **Add to Home Screen**.
   - **Android:** menu → **Install app**.
4. Optional: in Netlify → **Domain management** you can rename the site to something like `ourhouse.netlify.app`.

At this point the calendar, shelf, inbox approvals and household settings all work.

## 5. The agent, and reading pasted text and photos

Supabase → **Edge Functions → Secrets** (sometimes under **Project Settings → Edge Functions**). Add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic API key (the same one the old app used) |
| `APP_URL` | your Netlify address, e.g. `https://ourhouse.netlify.app` (used for links in emails) |
| `APP_ORIGIN` | the same address, with no slash at the end. Only that site may call the functions from a browser |

Then run `supabase/setup/cron.sql` in the SQL Editor after replacing `YOUR-PROJECT-REF` with your Reference ID.
Its last line shows a value: add it as one more secret, `CRON_SECRET`. That turns on the hourly feed check,
the reminder emails and the instant calendar sync.

Try it: in the app's **Ask** tab, type "add a test event tomorrow at 3pm for" and your name.

## 6. Google Calendar (and reading Google Docs)

The app writes to a calendar of its own, through a "service account" — a robot Google account, so nothing
expires and nobody has to stay signed in.

1. Go to **console.cloud.google.com** → create a project called `household`.
2. **APIs & Services → Library**: enable **Google Calendar API** and **Google Drive API**.
3. **IAM & Admin → Service accounts → Create service account** (any name) → open it → **Keys → Add key →
   JSON**. A file downloads. Copy the service account's email (ends in `iam.gserviceaccount.com`).
4. In **Google Calendar** (calendar.google.com): **Other calendars → + → Create new calendar** named `Household`.
   In its settings:
   - **Share with specific people** → add the service account email → **Make changes to events**.
   - Add Jordan too (**See all event details** or **Make changes**, your choice).
   - Copy the **Calendar ID** from "Integrate calendar".
5. Share the "Upcoming Events" Google Doc with the service account email as **Viewer**.
6. Add two more Edge Function secrets:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — open the downloaded file in a text editor and paste **the whole thing**
   - `GOOGLE_CALENDAR_ID` — the Calendar ID

Within a few minutes your events appear on the Household calendar. A ⚠ in front of a title means a kid's
event has nobody assigned to drive. Edit events in the app, not in Google Calendar: the app is the source of
truth and overwrites changes made there.

## 7. Email and texts

1. Sign up at **brevo.com** (free). Under **Senders, domains & dedicated IPs → Senders**, add the address emails
   should come from (e.g. your Gmail) and confirm it from the email Brevo sends.
2. **SMTP & API → API keys → Generate a new API key**.
3. Add Edge Function secrets: `BREVO_API_KEY`, `MAIL_FROM` (the sender you confirmed), and optionally
   `MAIL_FROM_NAME` (defaults to "Household Manager").
4. In the app: **Household → Email me this week's summary** to test.

**Phone notifications** replace texts: on each phone, open the Home Screen app → **Household → Turn on
notifications**. Nothing to set up here; they arrive at the same times as the emails. (iPhones need iOS 16.4
or later, and the app must be opened from the Home Screen, not Safari.)

**Texts through Twilio** (optional; real text messages to any phone):

1. In Twilio, buy a local number that can send SMS, and register it for texting: **Messaging → Regulatory
   Compliance → A2P 10DLC → Sole Proprietor** (your name as the brand; Twilio texts a code to your own cell).
   US carriers block unregistered numbers, and approval takes a few days. While the account is a trial it can only
   text numbers listed under **Verified Caller IDs**.
2. Add Edge Function secrets: `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` (Twilio console home → Account Info),
   and `TWILIO_MESSAGING_SERVICE_SID` (the MG… service the registration created) or `TWILIO_FROM` (the number).
3. In the SQL Editor, put the numbers on the text list and turn texts on:
   ```sql
   update settings set value = value || jsonb_build_object('enabled', true, 'recipients', jsonb_build_array(
     jsonb_build_object('name', 'Sarah', 'number', '508-555-0101'),
     jsonb_build_object('name', 'Mikey', 'number', '508-555-0102'))) where key = 'sms';
   ```
   `weekly`, `reminders`, `digest` and `morning` in the same setting choose which messages are texted.
4. In the app: **Household → Send a test text**. Anyone can reply STOP to opt out (and START to come back).

Without Twilio, texts fall back to carrier email addresses (`number@vzwpix.com`, set `carrier` per recipient),
which Verizon is shutting down by March 2027.

## 8. Forwarded emails into the Inbox

1. Sign up at **cloudmailin.com** (free) and create an address.
2. Set its **target** to
   `https://<reference>.supabase.co/functions/v1/inbound-email?key=<INBOUND_SECRET>`
   and the format to **JSON (Normalized)**. Make up a long random `INBOUND_SECRET` (or run
   `select encode(extensions.gen_random_bytes(24), 'hex');` in the SQL Editor) and add it as an Edge Function secret.
3. Now you can forward any email to that address and its events appear in the Inbox for approval.
4. To forward automatically, in Gmail: **Settings → Forwarding → Add a forwarding address** → the CloudMailin
   address. Gmail sends a confirmation code; find it in Supabase → **Table Editor → log** (action
   "gmail forwarding confirmation"). Then create a filter for your `household` label → **Forward it to** that address.

## 9. "Hey Siri, Ask Household" (optional)

An iPhone Shortcut that sends what you say straight to the agent and reads the answer back. It also
appears when you search on your phone.

1. In the app: **Household → Ask Household from Siri → Make my Siri key.** Keep that screen open.
2. Open the **Shortcuts** app → **+** (new shortcut). Tap the name at the top and call it `Ask Household`.
3. Add these actions in order (use the search bar at the bottom to find each one):
   1. **Ask for Input**: Input type *Text*, Prompt `What should I do?`
   2. **Get Contents of URL**: tap the URL and paste the **Address** from the app. Tap the arrow to show more:
      - Method: **POST**
      - Headers: add one. Key `x-household-key`, Text: paste the **Key** from the app.
      - Request Body: **JSON**. Add two fields:
        - `action` (Text): `ask`
        - `message` (Text): tap it and choose the **Provided Input** variable
   3. **Get Dictionary Value**: Get *Value* for key `reply` in *Contents of URL*
   4. **Show Result** (or **Speak Text**, if you'd rather hear it): *Dictionary Value*
4. Tap **Done**. Try it: say "Hey Siri, Ask Household", then "add a dentist appointment for Ozzie on December 2 at 2pm".

Deleting or changing an existing event still needs your tap: Siri tells you, and a **Yes, do it** card
waits in the app's **Ask** tab (the tab shows a number) for 12 hours. Each person makes their own key on
their own phone. **Make a new key** or **Turn off** in the app stops the old one immediately.

---

## Day to day

- **Ask tab:** "add a dentist appointment for Leo on December 2 at 2pm", "Jordan is taking Ivy Thursday",
  "when did Mia last see the orthodontist?" Tap the microphone to talk. Deleting and changing existing
  events always waits for you to tap **Yes, do it**.
- **Inbox:** paste an email or calendar file, or snap a flyer. Nothing reaches the calendar until you approve it.
  Deadlines it finds (forms due, sign-ups, payments) are marked **To do** and go on the to-do list instead.
- **To do:** the list at the top of the Week tab. Tap the circle when it's done (Undo if you slip). Add one with
  **+ Add → To do**, or tell the agent "remind me to pay the camp deposit by Friday". Anything overdue or due in
  the next three days is in the morning notification; the evening reminder and weekly summary list them too.
- **Custody days** from the co-parent calendar show as a dashed line under the date ("Aaron & Ozzie at Eli's").
  Events on those days note it ("Reid at Jenn's") and never ask who is driving the kids who are away.
- **Morning notification:** 7am by default, set in Household (or Off). Today's events with their notes, where the
  kids are, and to-dos due soon. Notification only; set `morning` → `email` to true in settings to also email it.
- **Household:** people, who gets emails, reminder times, theme, notifications on this phone, "check the school calendar now".
- **Around town this week:** the weekly summary email ends with a few local events found by Claude with web search
  (with links). Change the area, distance and interests in `local_events` in the settings table, or set `enabled` to
  false. Web search has to be allowed for your organization in the Claude Console; it costs about a cent a search.
- Which messages also come as notifications: `push` in the settings table (`weekly`, `reminders`, `digest`).
- Feeds, documents and text recipients are edited in Supabase → **Table Editor → settings**.
- A shared calendar you trust (for example a co-parenting calendar) can sync straight onto the
  calendar instead of going to the Inbox: give its feed `"mode": "sync"`. See the notes at the top of
  `supabase/functions/_shared/feedsync.ts` for the options (who it is for, custody days).

## If something isn't working

- **Sign-in says "not on the list":** add that email to the `allowed_users` table.
- **Ask tab says a secret is missing:** add it under Edge Functions → Secrets (no redeploy needed).
- **Nothing on Google Calendar:** check the service account has "Make changes to events" on the calendar,
  and look in the `log` table for "calendarSync error".
- **No emails:** confirm the Brevo sender, and check `notify` in the settings table.
- **Free Supabase projects pause after a week with no use.** Opening the app wakes it; daily use keeps it awake.

Every change to the repo re-runs the tests and redeploys automatically.
