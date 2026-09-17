# OpenCode version bumps

Use this workflow when updating Varro's tested OpenCode versions. V2 is the recommended install; keep v1 support and its verification matrix.

1. Check both package families. For v2, run `npm view @opencode/client version` and `npm view @opencode/cli version`. For v1, run `npm view @opencode-ai/sdk version` and `npm view opencode-ai version`. Versions within each family should normally match; the `opencode-ai` dist-tag does not describe v2.
2. Prepare a current, clean upstream checkout. If `tmp/opencode` does not exist, run `git clone https://github.com/anomalyco/opencode.git tmp/opencode`. If it exists, verify it is clean with `git -C tmp/opencode status --short`, then update it with `git -C tmp/opencode pull --ff-only`. Do not discard unrelated changes from a dirty checkout.
3. Review the complete upstream release diff in `tmp/opencode` before editing Varro. Find the release commits with `git log --all --grep='v<version>'`, then compare the previous and target release commits.
4. Pay particular attention to public HTTP routes, v2 `/api/event` and v1 `/global/event` SSE names and payloads, generated client/SDK/OpenAPI changes, protocol/schema types, configuration behavior, provider/model metadata, permissions/questions, session/message/part shapes, and `serve`/upgrade CLI behavior. Cross-check affected surfaces against `src/shared/opencode-types.ts`, `src/shared/protocol.ts`, `src/extension/open-code-transport.ts`, the v2 adapter modules, and request paths under `src/extension`.
5. Separate required compatibility work from optional parity work. App, desktop, TUI, localization, and styling changes usually do not require Varro changes unless they reveal behavior Varro intentionally mirrors.
6. Update the relevant dependency and lockfile with `npm install @opencode/client@^<version>` for v2 or `npm install @opencode-ai/sdk@^<version>` for v1; do not hand-edit lockfile entries. Retain both dependencies.
7. Keep `MINIMUM_SUPPORTED_OPENCODE_V2_VERSION` and `MINIMUM_SUPPORTED_OPENCODE_VERSION` unchanged unless Varro starts relying on an API introduced after that family's floor. The client and SDK dependencies record tested versions, not runtime support caps or automatic-update limits.
8. Run `npm run test:compatibility:adapters` for either family. For v1 dependency changes, also run `npm run test:compatibility`. The latter requires Docker, probes real published v1 servers across the support range, writes `artifacts/opencode-compatibility.json`, and regenerates the tracked `scripts/opencode-compatibility/verified.json`. Do not hand-edit the verification summary.
9. Let the compatibility run finish before running `npm run test -- src/shared/opencode-compatibility.test.ts`; that test reads the regenerated summary and will race if run in parallel.
10. Update user-facing tested-version references in `README.md`, `docs/usage.md`, and the current implementation notes in `docs/opencode-v2-support.md`. Search the repository for the previous version; preserve explicitly historical observations and lower-bound fixtures.
11. If the upstream diff changes a consumed contract, implement the smallest required adaptation and add targeted tests. Otherwise, do not churn local compatibility types merely to match SDK declarations that Varro does not consume.
12. Finish with `npm run lint:check`, `npm run typecheck`, the focused compatibility test, and `npm run build`. Report compatibility check counts and any advisory caveats separately from required failures.

## V2 releases

V2 publishes `@opencode/cli` and `@opencode/client`. Keep the v1 SDK and support floor when updating the v2 client. Check both package families rather than interpreting the `opencode-ai` dist-tag as the latest v2 release.

Run `npm run test:compatibility:adapters` after changing either adapter or the v2 dependency. It checks the actual published binaries and records observed versions. Use the served OpenAPI document and released package contracts when upstream `dev` or the documentation differs from the release. The v2.0.5 startup endpoint is `/api/status`; the newer documentation's `/api/info` is not available in that release.

The optional real-editor startup check is `VARRO_SANDBOX_V2_COMMAND=/absolute/path/to/opencode node scripts/vscode-sandbox/run.mjs v2-first-run`. Update its expected version when changing the tested v2 release.
