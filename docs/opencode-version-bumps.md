# OpenCode Version Bumps

Use this workflow when updating Varro's tested OpenCode version.

1. Confirm the latest stable SDK and CLI versions with `npm view @opencode-ai/sdk version` and `npm view opencode-ai version`; they should normally match.
2. Review the complete upstream release diff in `tmp/opencode` before editing Varro. Find the release commits with `git log --all --grep='v<version>'`, then compare the previous and target release commits. Keep the upstream checkout clean.
3. Pay particular attention to public HTTP routes, `/global/event` SSE names and payloads, generated SDK/OpenAPI changes, protocol/schema types, configuration behavior, provider/model metadata, permissions/questions, session/message/part shapes, and `serve`/upgrade CLI behavior. Cross-check affected surfaces against `src/shared/opencode-types.ts`, `src/shared/protocol.ts`, `src/extension/open-code-transport.ts`, and request paths under `src/extension`.
4. Separate required compatibility work from optional parity work. App, desktop, TUI, localization, and styling changes usually do not require Varro changes unless they reveal behavior Varro intentionally mirrors.
5. Update the dependency and lockfile with `npm install @opencode-ai/sdk@^<version>`; do not hand-edit lockfile entries.
6. Keep `MINIMUM_SUPPORTED_OPENCODE_VERSION` unchanged unless Varro starts relying on an API introduced after the current floor. The SDK dependency version is Varro's maximum tested and automatic-update ceiling, not its minimum runtime version.
7. After changing the manifest, run `npm run test:compatibility`. It requires Docker, probes real published servers across the support range, writes `artifacts/opencode-compatibility.json`, and regenerates the tracked `scripts/opencode-compatibility/verified.json`. Do not hand-edit the verification summary.
8. Let the compatibility run finish before running `npm run test -- src/shared/opencode-compatibility.test.ts`; that test reads the regenerated summary and will race if run in parallel.
9. Update user-facing tested-ceiling references, currently in `docs/usage.md`. Search the repository for the previous version so stale ceilings are not left behind.
10. If the upstream diff changes a consumed contract, implement the smallest required adaptation and add targeted tests. Otherwise, do not churn local compatibility types merely to match SDK declarations that Varro does not consume.
11. Finish with `npm run lint:check`, `npm run typecheck`, the focused compatibility test, and `npm run build`. Report compatibility check counts and any advisory caveats separately from required failures.
