# BRAC IT Skill Map and Training & Development

HR-only internal tools on Vercel with an Upstash Redis database.

- `/` : Employee Skill Map (`public/index.html`)
- `/training/` : Training & Development, including the BRAC IT Academy (`public/training/index.html`)
- `api/` : server functions (sign-in, employees, settings, shortlists, recycle bin, history, audit, training)
- `public/vendor/exceljs.min.js` : Excel builder used for formatted exports

## Environment variables (Vercel › Settings › Environment Variables)

| Name | Value |
|---|---|
| `KV_REST_API_URL` | Added automatically when a Redis database is connected to the project |
| `KV_REST_API_TOKEN` | Added automatically with the one above |
| `VIEW_PASSCODE` | Passcode for view-only HR users (12+ characters) |
| `EDIT_PASSCODE` | Passcode for HR editors (12+ characters, different from the viewer passcode) |
| `SESSION_SECRET` | Random text, at least 32 characters. Changing it signs everyone out |
| `SESSION_HOURS` | Optional. Default 8 |

Never put these values in this repository.

## Restoring data into a new system

1. Skill Map › Import from Excel › upload `skill-map-backup-YYYY-MM-DD.json`. This restores profiles, settings and shortlists.
   Backups taken from an older version contain profiles only. To bring settings and shortlists across, sign in to the old site, open `/api/settings` and `/api/lists` in the browser, save each page as a `.json` file, and upload both files the same way.
2. Training › Import & export › upload `training-backup-YYYY-MM-DD.json`. This restores sessions, attendance, invitations, courses, programmes, plan, employee list and settings.

The change history, recycle bin and audit log start fresh in a new system.
