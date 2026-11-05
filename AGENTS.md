# Motro Development Notes

- Motro has three modules: `apps/server`, `apps/mobile`, `apps/extension`. The extension defaults to `https://motro.rafa.love`; local development uses an explicit `serverUrlOverride`.
- Use Node.js 22+ and npm. Keep `package-lock.json` committed with dependency changes.
- Every delivered update must increment the unified version with `npm run version:bump`. Keep root/workspace packages, extension manifest and lockfile aligned; `npm run check` enforces this. Bump once per release, not once per edited file.
- Persist visit numbers in `DATA_DIR`; do not delete, reset or commit runtime counters when updating or deploying.
- Keep extension and mobile UIs state-based and minimal. Configure the fixed server in `apps/extension/background.js`; do not reintroduce a server URL input in the popup.
- Keep the browser extension loadable directly from `apps/extension`; do not introduce a mandatory build without updating installation docs.
- Run `npm run verify` after changes. Run `npm run test:e2e` when changing pairing, gestures, extension messaging, or zoom behavior.
- Update `docs/protocol.md` when changing WebSocket messages and extend the server tests for authorization changes.
- Treat pairing codes as short-lived discovery identifiers, never as long-term authentication. Never forward control before computer approval.
- Current deployment accepts different computers without an extension-ID whitelist. Do not require users to provide extension IDs or enable `EXTENSION_IDS` by default; retain computer approval and browser Origin checks.
- Do not log pairing tokens, expose tokens to content scripts, or commit `.env` or browser profiles.
- Cloud deployment and server updates are handled separately by the server agent. Do not deploy, publish, or expose ports publicly without an explicit request.
- Keep user-facing copy and development docs in Chinese; identifiers and code comments in English.
- Preserve the warm paper / green accent visual direction. Do not introduce remote fonts or CDN scripts; local operation must work without internet.
