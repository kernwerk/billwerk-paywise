# Repository Guidelines

## Project Structure & Module Organization

- `src/server.js` is the Node.js/Express entrypoint and main webhook handler.
- `src/` contains all application code; there are no separate modules yet.
- `.env.example` documents required environment variables.
- `README.md` describes setup, endpoints, and data flow.

## Build, Test, and Development Commands

- `npm install` installs runtime dependencies.
- `npm run dev` starts the server with `node --watch` for local development.
- `npm start` runs the production entrypoint (`src/server.js`).

No test script is currently defined; add one if a test runner is introduced.

## Coding Style & Naming Conventions

- Indentation: 2 spaces.
- File naming: use `kebab-case.js` for new modules.
- Functions and variables: `camelCase`; classes: `PascalCase`.
- Formatting/linting: no ESLint/Prettier scripts are configured, so keep style consistent with `src/server.js`.

## Testing Guidelines

- No testing framework is configured yet.
- If tests are added, prefer `tests/` with `*.test.js` naming and wire `npm test` to the chosen runner (Jest or Vitest).
- There are no coverage requirements at this time.

## Commit & Pull Request Guidelines

- Git history is not available in this checkout, so default to Conventional Commits (`feat:`, `fix:`, `chore:`) unless the project specifies otherwise.
- PRs should include: a concise summary, test notes (or “not run”), linked issues when applicable, and screenshots/logs for behavior changes.

## Security & Configuration Tips

- Do not commit secrets; use `.env` based on `.env.example`.
- Required credentials: `BILLWERK_CLIENT_ID`, `BILLWERK_CLIENT_SECRET`, and `PAYWISE_TOKEN`. Optional: `WEBHOOK_SHARED_SECRET` for webhook authentication.
- The server listens on `http://localhost:3000` by default; update configuration if ports or hosts change.
