# Security policy

## Supported versions

Only the latest commit on the `main` branch receives fixes.

## Reporting a vulnerability

Please report security issues privately using GitHub's private vulnerability reporting:

**https://github.com/Yuzaki75/AstryxHosting-SalesManagement/security/advisories/new**

Do not open a public issue for a vulnerability, and do not include real customer data, tokens, or credentials in a report.

Include as much of the following as you can:

- The affected component (dashboard API, authentication, backups, Discord integration, deployment)
- Steps to reproduce or a proof of concept
- Impact (what an attacker could do)
- Suggested fix, if you have one
- Version or commit hash

You should receive an acknowledgement within a few days. Fixes are prioritized by impact, and you will be credited in the release notes if you would like.

## Handling secrets in this project

The following must never be committed:

- `.env` and `SESSION_SECRET`
- Discord bot tokens and webhook URLs
- `SALES_API_KEY`
- `*.db`, `*.db-shm`, `*.db-wal`, and `backups/`
- Exported sales files or customer personal information

If a secret is exposed, rotate it immediately (Discord tokens can be regenerated in the Developer Portal) and then report it through the private channel above so the repository history can be checked.

## Deployment reminders

- Serve the app over HTTPS and set `COOKIE_SECURE=true`.
- Leave `ALLOW_REGISTRATION=false` except while creating staff accounts.
- Restrict access at the reverse proxy or network layer; the dashboard is not intended to be public.
- Keep the database and backup directory outside the web root and on persistent, writable storage.
