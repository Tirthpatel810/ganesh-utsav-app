# Ganesh Utsav — Society Event Management

A ₹0 system for a residential society's Ganesh Mahotsav: food plate counter,
contribution collection, expense tracking, and full accounting.

Two halves:

| | Runs | Owns |
|---|---|---|
| **This app** (PWA) | 24/7 in the cloud, free | The three ledgers during the event |
| **Odoo module** `ganesh_utsav` | Your laptop, whenever you want | Roster, money rules, accounting, reports |

Odoo **pushes** the roster, days and money rules to the app. It **pulls** plates,
contributions and expenses back. One direction per table, so there is nothing to
merge and nothing to lose. **While Odoo is switched off the volunteers keep
working** — everything catches up automatically the next time it starts.

---

## The one design rule that makes this work

The three ledgers — `servings`, `contributions`, `expenses` — are **append-only**.
Rows are never updated and never deleted. An undo writes a *new negative row*.

That single rule buys all of this:

- Two volunteers' phones writing at the same instant **cannot conflict**
- Every total is a `SUM()`, so it **cannot drift**
- Odoo syncs with a plain `id > cursor` walk — it can **never miss or
  double-count** a row, even after days offline
- An offline retry after a dropped connection **cannot inflate a total**,
  because every row carries a unique `client_uid`

If you change one thing in this system, don't change that.

---

# Setup — what only you can do

Roughly 40 minutes end to end. Do the parts in order.

## Part A — Supabase (the 24/7 cloud). Free, no card.

1. **Create the project.** Go to [supabase.com](https://supabase.com) → sign up →
   **New project**.
   - Name: `ganesh-utsav`
   - Database password: pick one and save it somewhere
   - Region: **Mumbai** or **Singapore** (closest to India = fastest for the phones)
   - Plan: **Free**

2. **Create the tables.** Left sidebar → **SQL Editor** → **New query**.
   Paste the whole of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   You should see `Success. No rows returned`. It is safe to re-run at any time.

3. **Load your roster and the 7 days.**
   **Open [`supabase/seed.sql`](supabase/seed.sql) and edit the roster section first** —
   it ships with wing A 1–10, wing B 11–60, wing C 1–57 as a starting point.
   Then paste it into a new SQL Editor query → **Run**.

   You can also skip this and enter the roster in Odoo instead, then press
   **Push Full Roster** there. Do one or the other, not both.

4. **Get your keys.** Settings (gear) → **API**. You need three values:

   | Value | Goes into | Safe to make public? |
   |---|---|---|
   | Project URL | `config.js` **and** Odoo | yes |
   | `anon` / `public` key | `config.js` | **yes** — Row Level Security requires a login for every read |
   | `service_role` key | **Odoo only** | **NO. NEVER commit this.** It bypasses all security. |

5. **Turn off email confirmation** (otherwise you cannot create volunteer logins
   without real mailboxes). Authentication → **Sign In / Providers** → Email →
   switch **Confirm email** OFF → Save.

6. **Create one login per volunteer.** Authentication → **Users** → **Add user** →
   *Create new user*. Use fake-but-consistent emails; nobody has to receive mail.

   | Email | Password | User Metadata (paste as JSON) |
   |---|---|---|
   | `admin@ganesh.local` | *yours* | `{"display_name":"Committee","role":"admin","receipt_series":"Z"}` |
   | `counter1@ganesh.local` | *simple* | `{"display_name":"Rohan","role":"volunteer","receipt_series":"A"}` |
   | `counter2@ganesh.local` | *simple* | `{"display_name":"Priya","role":"volunteer","receipt_series":"B"}` |

   **`receipt_series` matters.** Each collector gets their own letter, exactly like
   a physical receipt book. Receipt numbers are issued *on the phone* as
   `GU26/A/0001`, `GU26/A/0002`, … which is what lets a volunteer collect
   door-to-door with **no signal at all** and still never clash with another
   volunteer's numbering. **Never give two people the same letter.**

   Tick `can_expense` for whoever records spends — set it in the SQL Editor:
   ```sql
   update profiles set can_expense = true where display_name = 'Priya';
   ```

## Part B — GitHub Pages (hosting the app). Free.

1. **Fill in `config.js`** with the Project URL and the `anon` key from A4.
   The deploy refuses to run while the placeholders are still there.

2. **Create the repo.** On GitHub (account `TirthPatel810`) → **New repository** →
   name `ganesh-utsav-app` → **Public** → *do not* add a README → Create.

   Public is required for free GitHub Pages. That is fine: the repo contains no
   secrets. The `anon` key in `config.js` grants nothing without a login.

3. **Push.** The folder is already a git repo with a commit ready:
   ```bash
   cd /home/tirth/workspace/ganesh-utsav-app
   git remote add origin https://github.com/TirthPatel810/ganesh-utsav-app.git
   git push -u origin main
   ```

4. **Turn on Pages.** Repo → Settings → **Pages** → Source: **GitHub Actions**.

5. Watch the **Actions** tab. When it goes green your URL is:
   `https://tirthpatel810.github.io/ganesh-utsav-app/`

6. **Give the volunteers the link.** On each phone: open it in Chrome →
   menu → **Add to Home screen**. It then opens full-screen like an app and
   works offline.

Every later `git push` redeploys automatically, and the workflow bumps the
service-worker cache so phones pick up the new version on next open.

## Part C — Odoo (the back office)

1. The module is already at
   `/home/tirth/workspace/19_ent/custom_addons/ganesh_utsav`.
   Make sure that folder is on your `addons_path`, then restart Odoo.

2. Apps → **Update Apps List** → search **Ganesh** → **Activate**.

3. Settings → Users → your user → set **Ganesh Utsav = Committee / Manager**.
   Log out and back in.

4. **Ganesh Utsav → Events → New**
   - Name, year, start `2026-09-14`, end `2026-09-20`
   - Standard Contribution `500`, Extra Plate Rate `30`, Receipt Prefix `GU26`
   - **Generate Days** → fills in the 7 days → type the menu into each

5. **Roster.** Either the Houses tab on the event, or Ganesh Utsav → Houses.
   For each house:

   | Field | Meaning |
   |---|---|
   | House code | Permanent id, e.g. `B-56`. **Never renumber or reuse it.** |
   | Grid Group | Which tab in the app: `AB`, `C` |
   | Button Label | What is printed on the button. Short: `56`, `65-66` |
   | Sort order | Button order inside the tab |
   | Plates / Day | Registered plates. Beyond this becomes a chargeable extra. |
   | Expected Contribution | ₹500 default; override for the exceptions |

   Merged flats are **one row, one button**: code `A-65-66`, label `65-66`.
   Irregular numbering needs no code changes — it is all just data.

6. **Sync tab** → paste the Project URL and the **`service_role`** key →
   Save → **Push Full Roster**. Within seconds every phone has it.

7. **Accounting tab** (needed only before you post to the books):
   - Journal: make a Miscellaneous journal called *Ganesh Utsav*
   - Analytic Account: create one for the event — this is what gives you a
     true event P&L in Odoo's standard reports
   - Contribution Income / Cash / Bank / Default Expense accounts

8. **Optional: automatic sync.** Settings → Technical → Scheduled Actions →
   *Ganesh Utsav: sync with cloud app* → set **Active**. It then syncs every
   2 minutes **while Odoo is running**, and catches up on its own after downtime.
   The **Sync Now** button always works regardless.

---

# Using it

### The counter (Serve tab)
Tap the group (**A/B** or **C**) → tap the house number, 5 per row → the family
name appears → tap `+1 … +5`, or type any number. Colour tells you the state at a
glance: grey not come, amber partial, green full, purple took extras.

Going past the registered plates does **not** block. It shows a confirmation
naming the house, how many it has already taken, and what the extra will cost —
then records the covered part and the chargeable part as two separate rows.

`+ Guest` counts visitors with no house, so the kitchen number stays honest.

### Collection (Collect tab)
Same grid, coloured by payment. Tap a house → expected, paid, extra-plate charge
and balance → amount is pre-filled with the balance → pick the mode → **Collect**.
The receipt number is shown before you save. Underpayment and overpayment are
both accepted without argument; the statement shows the difference.

`+ Outside donor` records sponsors who are not houses.

### Spend tab
Category, amount, what for, who paid, and optionally a photo of the bill. A
volunteer's entry is saved as **Awaiting Approval**; a committee member approves
it in the app or in Odoo. Only approved expenses reach the books.

### Live tab
Plates today, plates in the last 15 minutes with a trend arrow (this is the real
kitchen signal, not the running total), houses not yet come, money in vs out,
balance in hand, and who still owes.

### Offline
Everything above works with **no network**. The bar under the header turns red and
shows how many entries are waiting. They upload by themselves when signal
returns. Nothing is lost, and nothing is double-counted.

### Undo
Every entry stays undoable for 15 minutes from the log. Undo writes a reversal
row rather than deleting anything, so the audit trail stays intact.

---

# Reports (Odoo)

- **House Statement** (PDF, per house): expected + extra plates − paid = balance
- **Contribution Receipt** (PDF, serial numbered)
- **Houses list**: filter *Balance due*, *Nothing paid*, *Never came*, *Took extra plates*
- **Plate Ledger**: pivot by day × wing, or group by *Hour served* for peak-rush analysis
- **Expenses**: pivot by category
- **Post to Accounting**: one journal entry per day for contributions and one for
  approved expenses, analytic-tagged. Safe to re-run — anything already posted is
  skipped.

---

# Before the 14th — please actually do this

1. **Rehearse on the real phones, at the real gate, in the dark**, with 20 test
   houses. It catches more than any amount of code review.
2. **Turn on aeroplane mode mid-rehearsal.** Serve a few plates, collect a few
   contributions, turn it back on, watch the queue drain. Then confirm in Odoo
   that the totals match.
3. **Check every volunteer has a different `receipt_series`.**
4. **Delete the test data before day 1:**
   ```sql
   truncate servings, contributions, expenses restart identity cascade;
   ```
   In Odoo, delete the test event (the ledgers cascade with it).

---

# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Not configured" on the login screen | `config.js` still has `PASTE-YOUR-…` |
| Sign-in says *Invalid login credentials* | User not created, or **Confirm email** still on (Part A5) |
| "This volunteer has no receipt series" | Set `receipt_series` in that user's metadata, then sign out and in |
| Roster is empty in the app | Press **Push Full Roster** in Odoo, then **Full refresh** in the app's More tab |
| Odoo *Cloud read failed (401)* | Wrong key on the Sync tab — it must be `service_role`, not `anon` |
| Odoo *Cloud write failed (404)* | `schema.sql` was never run, or the URL has a trailing slash |
| App shows stale numbers | More → **Full refresh**. If it persists, close and reopen — the service worker updates on open. |
| Volunteer can't edit the roster | By design: roster edits are admin-only. Change their `role` to `admin`. |
| Free Supabase project "paused" | Only after ~7 days of no activity. Un-pause from the dashboard. Irrelevant during the event. |

---

# Cost

| | |
|---|---|
| Supabase free tier | ₹0 |
| GitHub Pages (public repo) | ₹0 |
| GitHub Actions | ₹0 |
| Odoo on your machine | ₹0 |
| **Total** | **₹0** |

The app has **no dependencies** — no CDN, no framework, no build step. Nothing
external can break at 8pm on day two.

---

# Layout

```
ganesh-utsav-app/                  the PWA (this repo, goes on GitHub Pages)
├── index.html                     five screens: Serve, Collect, Spend, Live, More
├── app.css
├── app.js                         offline queue, cursor sync, all logic
├── config.js                      >>> THE ONLY FILE YOU EDIT <<<
├── sw.js                          service worker: instant open, works offline
├── manifest.webmanifest
├── icons/
├── supabase/
│   ├── schema.sql                 run once
│   └── seed.sql                   edit the roster, then run
└── .github/workflows/deploy.yml   auto-deploy on push

19_ent/custom_addons/ganesh_utsav/ the Odoo 19 module
├── models/                        event + sync engine, houses, the 3 ledgers
├── views/  security/  data/
└── report/                        receipt + house statement PDFs
```
