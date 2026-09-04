# Ganesh Utsav 2026 — Shashwat Society

**App:** https://tirthpatel810.github.io/ganesh-utsav-app/
**Logins:** `~/ganesh-credentials.txt` on the Odoo machine (chmod 600)
**Cloud:** Supabase project `jfedobsozembqfhjmubj` (Mumbai) · [dashboard](https://supabase.com/dashboard/project/jfedobsozembqfhjmubj)
**Odoo:** `db_ganesh_shashwat` (live) and `db_ganesh_shashwat_test` (practice)

Everything below is **already set up and working**. This is reference, not a to-do list.

## The menu

| Day | Date | Menu | Plate price |
|---|---|---|---|
| 1 | Mon 14/09 | Live Dhokla with Chutney | ₹60 |
| 2 | Tue 15/09 | Idli Sambar with Chutney | ₹70 |
| 3 | Wed 16/09 | Moong Pulao | ₹50 |
| 4 | Thu 17/09 | Sev Usal with Pav | ₹80 |
| 5 | Fri 18/09 | Chhole Bhature with Chaas | ₹90 |
| 6 | Sat 19/09 | Pav Bhaji with Pulav | ₹100 |
| 7 | Sun 20/09 | Full Dish | ₹150 |
| | | **Menu value per person** | **₹600** |
| | | Standard contribution | ₹500 |
| | | **Subsidy carried per person** | **₹100** |

Each day is priced separately, and that matters: an extra plate is charged at
**the price of the day it was taken**. Two extra Full Dishes cost ₹300, two
extra Moong Pulaos cost ₹100. A single flat rate would have mis-billed every
chargeable plate.

## Two halves

| | Runs | Owns |
|---|---|---|
| **The app** (PWA) | 24/7 on GitHub Pages, free | The three ledgers during the event |
| **Odoo** `ganesh_utsav` | Your laptop, whenever | Roster, money rules, accounting, reports |

Odoo **pushes** the roster, days and prices to the app. It **pulls** plates,
contributions and expenses back. One direction per table, so there is nothing
to merge and nothing to lose. **While Odoo is off the volunteers keep working** —
it all catches up the next time Odoo starts.

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

# What is already done

| | Status |
|---|---|
| Supabase project, schema, views, RLS | ✅ live in Mumbai |
| 7 event days with menus and plate prices | ✅ loaded |
| Roster | ⚠️ **117 placeholder houses — see below** |
| 6 volunteer logins with unique receipt series | ✅ created |
| Public signup | ✅ **disabled** — only these 6 accounts can ever sign in |
| App deployed and reachable | ✅ https://tirthpatel810.github.io/ganesh-utsav-app/ |
| Auto-deploy on push | ✅ GitHub Actions |
| Odoo DBs (live + test), India/INR, Indian CoA | ✅ built |
| Enterprise accounting (`account_accountant`) | ✅ installed |
| Event, journal, analytic account, ledger accounts | ✅ configured |
| Odoo ↔ cloud sync | ✅ tested end to end, 30/30 checks |
| Test data | ✅ cleared — you start from zero |

## The logins

Passwords are in **`~/ganesh-credentials.txt`** on the Odoo machine. Each is
typed **once per phone**; the app then stays signed in.

| Login | Role | Receipt series | For |
|---|---|---|---|
| `admin@ganesh.local` | admin | Z | Odoo sync, roster edits, approvals |
| `counter1@ganesh.local` | volunteer | A | Food counter |
| `counter2@ganesh.local` | volunteer | B | Food counter, 2nd gate |
| `collect1@ganesh.local` | volunteer | C | Door-to-door collection |
| `collect2@ganesh.local` | volunteer | D | Door-to-door collection |
| `kitchen@ganesh.local` | volunteer | E | Live dashboard |

**Never give two people the same receipt series.** Each letter is a separate
receipt book; that is what lets a volunteer issue `GU26/C/0042` at someone's
door with no signal and never clash with another collector.

## The one thing still outstanding: your real roster

The roster is currently **117 placeholder houses** (A 1–10, B 11–60, C 1–57).
Your `A65-66` example does not fit "A is 1 to 10", so I could not guess the
real numbering. Fix it whichever way suits:

- **In the app** — sign in as `admin@ganesh.local` → More → Roster → edit or add
- **In Odoo** — Ganesh Utsav → Houses → edit, then **Sync Now** on the event
- **Send me the list** and I will load it in one go

Per house you need: house code (permanent, e.g. `B-56`), grid group (`AB` or `C`),
button label (`56`, `65-66`), plates/day, and expected contribution (₹500 default).
Merged flats are **one row, one button**.

## Adding a volunteer later

Supabase dashboard → Authentication → Users → **Add user**, with User Metadata:

```json
{"display_name":"Ravi","role":"volunteer","receipt_series":"F"}
```

Use an **unused** series letter. Signup is disabled, so this is the only way in.

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
4. **Test data is already cleared.** If you generate more while practising,
   clear it again from the Supabase SQL Editor:
   ```sql
   truncate servings, contributions, expenses restart identity cascade;
   ```
   then in Odoo set the event's three sync cursors back to 0 and delete the
   pulled rows. Or just practise in `db_ganesh_shashwat_test` instead.

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
