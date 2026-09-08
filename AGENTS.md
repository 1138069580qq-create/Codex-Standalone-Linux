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

- 排查与信息收集同样减少轮次、工具调用和重复输出：先形成假设，再集中读取关联代码、日志和运行状态；复用已取得的证据，只针对证据缺口追加检查。不得以减少次数为由跳过关键根因或安全验证。
