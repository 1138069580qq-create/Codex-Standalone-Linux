# Standalone project instructions

- Do not modify or depend on the original ElementsPanel project.
- Do not build the project or run a dev server; the UI is static and production runs through `npm start`.
- Run type checking with `npm run check` (`tsc --noEmit`), regression tests with `npm test`.
- The application is attach-only. Never add automatic Codex process launch or credential scraping.
- Real integration tests are opt-in and must be distinguished from protocol mocks and skipped checks.
- Do not recursively or bulk-delete files or directories. Retain test temporary directories for inspection.
- If an i18n directory is introduced, every new translation key must be added to all language files.

- User testing preference: reduce testing rounds, tool calls, and repetitive output, NOT coverage, test count, acceptance criteria, or quality. Finish a coherent batch of edits, then run all required checks in one script or a few grouped calls. Keep full logs and return only summaries/failures. Fix discovered issues together; rerun failures and affected regressions, with a final combined full run only when needed. Do not repeatedly run the whole suite after tiny edits.
- Do not use subagents for this project unless the user explicitly reverses that restriction. Do not submit real model messages or create real desktop tasks just for testing without a fresh explicit request.
