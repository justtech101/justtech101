# Windows desktop shortcut

Creates a "JUSTTECH Application Manager" icon on your Desktop that starts
the app (via `docker compose`) and opens the dashboard in your browser —
built for the Surface Pro / Windows ARM client described in the project
architecture.

## One-time setup

1. Install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)
   (WSL2 backend) and make sure it's running at least once so it's fully
   initialized.
2. From the repo root, copy `.env.example` to `.env` and fill in
   `JUSTTECH_ENCRYPTION_KEY` and `N8N_WEBHOOK_SHARED_SECRET` — see the
   comments in `.env.example` and `README.md` section 4.2. This only needs
   to be done once.
3. In File Explorer, navigate into this `windows\` folder, right-click
   `Create-Desktop-Shortcut.ps1` → **Run with PowerShell**.
   - If Windows blocks it as an untrusted script ("this app has been
     blocked for your protection" / SmartScreen), right-click the file →
     **Properties** → check **Unblock** → **OK**, then run it again.
4. A **"JUSTTECH Application Manager"** icon now appears on your Desktop.

## Everyday use

- **Start**: double-click the desktop icon. It runs `docker compose up -d`,
  waits for the backend health check, then opens
  `http://localhost:5173` in your default browser.
- **Stop**: run `Stop-JustTech.ps1` (double-click it, or right-click →
  Run with PowerShell) to shut the containers down and free up RAM —
  recommended on an 8 GB machine when you're not actively using it.

## Files

| File | Purpose |
|---|---|
| `justtech.ico` | The icon used by the desktop shortcut |
| `Create-Desktop-Shortcut.ps1` | One-time: creates the Desktop `.lnk` |
| `Start-JustTech.ps1` | What the shortcut actually runs |
| `Stop-JustTech.ps1` | Optional: `docker compose down` |

## Troubleshooting

- **"Docker Desktop does not appear to be running"** — open Docker Desktop
  from the Start menu and wait for it to say "Engine running", then
  double-click the shortcut again.
- **Browser opens to an error page** — the backend can take a few extra
  seconds on first run while Postgres initializes; re-run the shortcut, or
  check `docker compose logs backend`.
- **Shortcut points at the wrong folder after moving the repo** — re-run
  `Create-Desktop-Shortcut.ps1` from the new location to regenerate it.
