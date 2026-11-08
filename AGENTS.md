# Project guidance

- Keep the user interface and comments in Russian unless a change specifically requires otherwise.
- Keep Electron main-process logic out of renderer code; expose renderer capabilities through the preload API.
- Persist settings through `src/settings.ts`; do not write settings into the packaged application directory directly.
- Keep settings parsing defensive because the JSON file can be edited or partially corrupted.
- Add focused unit coverage for pure settings and time helpers. Add Playwright coverage for user-visible Electron behavior.
- Use `npm run typecheck`, `npm run test:unit`, and `npm run test:e2e` for the corresponding checks.
