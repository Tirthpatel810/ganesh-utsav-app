# Sending me the roster

Fill in a spreadsheet with these columns and send it. Excel or CSV, either is fine.
`roster-template.csv` in this folder is a working example — open it in Excel,
delete the sample rows, put yours in.

| Column | Required | What it means |
|---|---|---|
| `house_code` | **yes** | Permanent unique id, e.g. `B-56`. **Never renumber or reuse it** — every plate and receipt ever recorded points at this code. |
| `wing_group` | **yes** | Which tab the button sits under in the app. Use `AB` for wings that share one continuous number series, `C` for a wing that restarts at 1. Add more groups freely; tabs appear by themselves. |
| `number_label` | **yes** | The text printed **on the button**. Keep it short: `56`, `65-66`. |
| `sort_order` | no | Button order inside the tab. Leave blank and I derive it from the number. |
| `family_name` | no | Shown under the number and on receipts. |
| `member_count` | no | Family size. **A hint only** — it entitles nobody to anything. What a house may take on a day is what it *paid for* that day. Defaults to 4. |
| `phone` | no | For the desk to ring someone. |
| `notes` | no | Anything the committee should see. |

## Merged flats

**One row, one button.** `B-65-66` with label `65-66`. Do not make two rows.

## What you do NOT need to send

- Any amount. Ganpati is whatever a family gives; food is priced per day.
- Which days anyone wants food on. That is recorded when they pay.

## After I load it

**Nothing needs updating.** No new APK, no reinstall, no redeploy. Every phone
pulls the roster automatically within about 4 seconds of it landing. Volunteers
already signed in will simply see the new buttons appear.
