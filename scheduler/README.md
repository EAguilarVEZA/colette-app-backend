# Colette French Pastries — Crew Scheduler

Mobile-first scheduling app for the Colette crew.

- **Schedule** — build/publish weekly schedules, auto-scheduler learns from past weeks
- **Texts** — per-person schedule texts with YES-to-confirm (1 or 2 weeks ahead)
- **Payroll** — hours × rate, labor %, CSV export; pays clocked hours when punches exist
- **GPS time clock** — clock in/out only within 150 m of 2225 Old Milton Pkwy, Suite 100, Alpharetta GA, and only when scheduled

## Publishing the live schedule
The app auto-loads `data.json` from this folder when hosted. To update the live
schedule: open the app, tap 💾 Save, and commit the downloaded file here as `data.json`.

Single file, no build step — deploys as-is on Vercel or GitHub Pages.
