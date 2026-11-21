# AstryxNodes Sales Management System

A private sales operations dashboard for AstryxHosting. It runs on Node.js, Express, and SQLite, with optional Discord notifications and slash commands.

## Included features

- Username and password authentication
- Sales creation, editing, renewal, upgrade, and deletion
- Sales status, plan, customer, and month filters
- Hosting plan templates and auto-fill in the sales form
- Expiry tracking and no-renew status
- Revenue charts and monthly statistics
- Customer records and contact details
- Excel and CSV import, plus Excel export
- SQLite backups and recovery copies
- Optional Discord bot or webhook notifications
- Discord slash commands for sales totals, revenue, expirations, plans, customer lookup, and health status

## Requirements

- Node.js 20 or later
- npm
- A persistent writable directory for the SQLite database and backups

## Local setup

```bash
cp .env.example .env
```

Set `SESSION_SECRET` to a random value. The example leaves this blank so the app will refuse to start until you set it. Generate one with:

```bash
openssl rand -hex 32
```

Install and start the application:

```bash
npm ci
npm start
```

The app listens on `http://localhost:3020` by default. For a direct Node.js start, change `PORT`. For Docker Compose, change `HOST_PORT` to publish a different host port. The example uses `COOKIE_SECURE=false` for local HTTP access. Set it to `true` when serving the app over HTTPS. Public registration is available only until the first account is created. The server then closes sign-up automatically.

## Docker deployment

The Docker image runs the application as an unprivileged `app` user. Its entrypoint fixes ownership of the mounted data directory before dropping privileges. This also addresses existing Docker volumes whose files were created by a different UID.

```bash
cp .env.example .env
# Edit .env and set SESSION_SECRET.
docker compose up -d --build
```

For direct HTTP testing, open `http://SERVER_IP:3020` with `COOKIE_SECURE=false`. For a public deployment, put the app behind an HTTPS reverse proxy and set `COOKIE_SECURE=true` in `.env`.

Useful commands:

```bash
docker compose logs -f sales-app
docker compose ps
docker compose restart sales-app
docker compose down
```

The `sales-db` volume stores both `sales.db` and the `backups/` directory. Do not run `docker compose down -v` unless you intend to delete the database and its stored backups.

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Port for a direct Node.js start. Defaults to `3020`. |
| `HOST_PORT` | Host port published by Docker Compose. Defaults to `3020`. |
| `SESSION_SECRET` | Required in production. Use a random string with at least 32 characters. |
| `DATABASE_PATH` | SQLite file path. Defaults to `./sales.db`. |
| `COOKIE_SECURE` | Set to `true` when served over HTTPS. |
| `SALES_API_KEY` | Optional key for the automated order endpoint. |
| `ALLOW_REGISTRATION` | Defaults to `false`. First account setup is allowed automatically. Temporarily set to `true` only while adding staff accounts, then turn it off. |
| `NODE_ENV` | Set to `production` for deployment. |

## Database and backups

The database directory must be writable by the process running Node.js. The application creates the parent directory when needed. Docker deployment also repairs ownership on the mounted data volume at startup.

Automatic backups are stored under `backups/` beside the configured database. The app keeps the 10 most recent backup files. Create and download additional backups from the Backups page before major updates.

When SQLite reports corruption, the app preserves the original database and its WAL/SHM files using a `.corrupt-<timestamp>` suffix before opening a fresh database. Keep the preserved files until the data has been checked and recovered. The application does not silently delete the damaged database.

To add staff accounts after the first account exists, briefly set `ALLOW_REGISTRATION=true` in the service environment, add the required accounts, then set it back to `false`. Do not leave public registration enabled.

For a systemd installation, create `/etc/astryx-sales.env` with at least `SESSION_SECRET` and set it to mode `600`. Ensure the configured data directory is owned by the service user (`ubuntu`). Then install the service file, reload systemd, and enable the service.

## Discord integration

Open the Discord tab after signing in. Configure either:

- A bot token, server ID, and notification channel ID, or
- A Discord webhook URL

The bot integration registers `/stats`, `/revenue`, `/expiring`, `/plans`, `/customer`, and `/status`. Except for `/plans`, these commands are restricted to members who have the configured **Admin Role ID** in the Discord tab or the **Manage Server** permission. All command replies are ephemeral (visible only to the person who ran them). Give the bot permission to view the target channel and send messages with embeds. Keep bot tokens and webhook URLs private. The app stores these settings in the local SQLite database.

## Security and deployment notes

- Use HTTPS for any public deployment.
- Keep `.env`, database files, and backups outside source control.
- Do not expose the sales dashboard publicly without access controls at the reverse proxy or network layer.
- Use a strong `SESSION_SECRET` and rotate it if the current value is exposed. Existing sessions will be invalidated after rotation.
- SQLite is intended for a single application instance with persistent local storage. Do not scale this app across multiple serverless instances using a local SQLite file.

## Project structure

```text
sales-app/
├── public/
│   ├── app.js
│   ├── index.html
│   ├── sales.html
│   └── styles.css
├── backups/                 # Created at runtime beside the database
├── server.js
├── discord-bot.js
├── docker-entrypoint.sh
├── Dockerfile
├── docker-compose.yml
├── sales-app.service
├── package.json
├── package-lock.json
├── .env.example
└── README.md
```
