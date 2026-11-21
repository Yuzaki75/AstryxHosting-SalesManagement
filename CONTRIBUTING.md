# Contributing

Thanks for helping improve the AstryxHosting sales management app. This is an internal operations tool, so please treat every change as production-facing.

## Getting set up

```bash
git clone https://github.com/Yuzaki75/AstryxHosting-SalesManagement.git
cd AstryxHosting-SalesManagement
cp .env.example .env
npm ci
```

Set `SESSION_SECRET` in `.env` to a random value of at least 32 characters:

```bash
openssl rand -hex 32
```

Start the app with `npm start`. It listens on `http://localhost:3020` by default. Use `npm run dev` for automatic restarts during development.

## Before you open a pull request

1. Run `npm run check` — this syntax-checks `server.js`, `discord-bot.js`, and `public/app.js`.
2. Exercise the affected feature with a throwaway database: set `DATABASE_PATH` to a temporary file before starting the server.
3. If you change an API route, verify both the authenticated and unauthenticated paths.
4. If you change a Discord command or setting, update the README and the command list in `public/index.html`.
5. Never commit `.env`, `*.db` files, `backups/`, logs, bot tokens, webhook URLs, or customer data.

## Code conventions

- Keep the existing stack: Express, `sqlite3`, vanilla JS/CSS. Do not add a framework.
- Use parameterized SQL for any query that includes user input.
- Add validation on the server even when the frontend already validates — API clients may bypass the UI.
- Keep Discord replies ephemeral and never expose customer information to unauthorized members.
- When changing the database schema, support existing databases (for example with `ALTER TABLE ... ADD COLUMN` guarded by a column check).
- Match the surrounding code style: 2-space indentation in the Node modules, 4-space indentation in `public/app.js`.

## Reporting problems

Use the bug report template in Issues. Include steps to reproduce and sanitized logs. For vulnerabilities, follow `SECURITY.md` instead of opening a public issue.

## Commit messages

Use a short imperative subject, for example:

- `Fix Discord settings save failing with db.run error`
- `Add customer lookup slash command`
- `Guard missing elements on sales.html`
