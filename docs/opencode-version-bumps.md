# OpenCode Version Bumps

Use this workflow when updating Varro's tested OpenCode version.

1. Confirm the latest stable SDK and CLI versions with `npm view @opencode-ai/sdk version` and `npm view opencode-ai version`; they should normally match.
2. Prepare a current, clean upstream checkout. If `tmp/opencode` does not exist, run `git clone https://github.com/anomalyco/opencode.git tmp/opencode`. If it exists, verify it is clean with `git -C tmp/opencode status --short`, then update it with `git -C tmp/opencode pull --ff-only`. Do not discard unrelated changes from a dirty checkout.
3. Review the complete upstream release diff in `tmp/opencode` before editing Varro. Find the release commits with `git log --all --grep='v<version>'`, then compare the previous and target release commits.
4. Pay particular attention to public HTTP routes, `/global/event` SSE names and payloads, generated SDK/OpenAPI changes, protocol/schema types, configuration behavior, provider/model metadata, permissions/questions, session/message/part shapes, and `serve`/upgrade CLI behavior. Cross-check affected surfaces against `src/shared/opencode-types.ts`, `src/shared/protocol.ts`, `src/extension/open-code-transport.ts`, and request paths under `src/extension`.
5. Separate required compatibility work from optional parity work. App, desktop, TUI, localization, and styling changes usually do not require Varro changes unless they reveal behavior Varro intentionally mirrors.
6. Update the dependency and lockfile with `npm install @opencode-ai/sdk@^<version>`; do not hand-edit lockfile entries.
7. Keep `MINIMUM_SUPPORTED_OPENCODE_VERSION` unchanged unless Varro starts relying on an API introduced after the current floor. The SDK dependency version is Varro's maximum tested and automatic-update ceiling, not its minimum runtime version.
8. After changing the manifest, run `npm run test:compatibility`. It requires Docker, probes real published servers across the support range, writes `artifacts/opencode-compatibility.json`, and regenerates the tracked `scripts/opencode-compatibility/verified.json`. Do not hand-edit the verification summary.
9. Let the compatibility run finish before running `npm run test -- src/shared/opencode-compatibility.test.ts`; that test reads the regenerated summary and will race if run in parallel.
10. Update user-facing tested-ceiling references, currently in `docs/usage.md`. Search the repository for the previous version so stale ceilings are not left behind.
11. If the upstream diff changes a consumed contract, implement the smallest required adaptation and add targeted tests. Otherwise, do not churn local compatibility types merely to match SDK declarations that Varro does not consume.
12. Finish with `npm run lint:check`, `npm run typecheck`, the focused compatibility test, and `npm run build`. Report compatibility check counts and any advisory caveats separately from required failures.
