# Native session forms

OpenCode V2 forms retain their original keys, types, conditions, constraints, defaults,
option values, and metadata. V1 questions and provider authentication use their existing paths.

Supported native fields are string, number, integer, boolean, multiselect, and external.
Question-tool forms show single-choice answers as radio cards with descriptions inline after each
option, wrapping as needed. When allowed, a custom-answer input uses the placeholder
"Type your own answer" without a separate visible label. Ordinary form selections keep their themed dropdowns.
Free-text questions have no radio choice. Text fields and custom-value editors start at one line,
grow with wrapped or multiline text, and scroll after four lines using the standard input styles.
Inside answer cards, custom inputs are transparent and borderless, fill the row without top,
right, or bottom insets, and match the single-line height of regular options, including when focused.
Standalone free-text fields retain their input background.
Multiselects show full-width checkbox rows with descriptions. Custom values use matching rows with
an input and a checkbox, disabled until text is entered. Typing creates another blank row below;
only checked values are submitted. Unchecking keeps the text; clearing a non-last input removes
its row and focuses the next one. There are no remove buttons, and the last blank row stays available.
Unchecked text and selections survive reloads. Enter inserts a newline without submitting the form.
Options submit their values, even when labels are identical. An untouched optional field is
absent; an edited empty string, false, zero, and an empty selection remain distinct values.
Ordinary forms use **Clear** beside a field label to remove an optional answer; question prompts
do not show these reset buttons. Empty numeric input means absent,
never zero. Defaults are applied once when a draft is created, matching the native client's
initial-value behavior. The native validator itself does not supply defaults.

Conditions are ANDed in field order. An unanswered reference makes both `eq` and `neq`
false; multiselect comparisons test inclusion. Inactive fields and their cascaded dependents
are omitted from replies. Their draft values are retained for redisplay. The `hidden` flag is
authentication-specific metadata, not permission to submit a session form invisibly.

External actions open only on a user click through VS Code's external-link handler. Only
credential-free HTTP(S) URLs can be opened here. Opening a link does not acknowledge it.
The user must explicitly confirm completion. Unknown types, unknown string formats such as
password, and malformed field definitions remain visible with submission blocked. Use another
compatible OpenCode client or Skip; Varro never guesses an answer for these fields.

Client checks provide field-level feedback and focus the first invalid control. The server
still validates every reply. Failed replies leave the request and draft editable. Submit and
Skip use the existing question acknowledgment, transition, tombstone, and snapshot-race rules.
In-flight native replies remain disabled across inline/standalone remounts, and the host
rejects overlapping responses from multiple views. Form drafts use versioned per-view state,
like composer drafts, so navigation, virtual remounts, and webview reloads retain answers and
unfinished custom selections. They are not shared between editor views. The cache keeps at
most 100 forms, 64 Ki characters per draft and 256 Ki characters total. Oversized drafts are
not checkpointed. Authoritative resolution removes the saved draft. Unsupported password
fields never render as plain-text controls or collect password drafts. Replayed asks and temporary
workspace resets preserve pending checkpoints; unmounting a form is not resolution. Native schemas
with new field properties or formats remain unsupported until Varro can preserve their semantics.

Older webviews see a visible reload/other-client fallback, not flattened native controls.
Their positional replies are rejected by the V2 adapter. Rolling back the UI leaves the
server's pending form intact. Native replies cannot be sent through a V1 connection.

## Verification

`node --test scripts/opencode-compatibility/native-form.integration.test.mjs` executes the actual pure native
validator from `tmp/opencode/packages/core/src/form.ts` against Varro-produced answers.
This validation fixture is separate from the upstream source checkout at `../opencode`.
It prints the source hash, reproduces the inactive-field rejection, and verifies omission,
numeric absence/zero, duplicate labels, required defaults, external acknowledgment, and
cascaded conditions. It does not start a service, read production sessions, or modify the
upstream fixture. A missing checkout fails rather than claiming native acceptance.

Component, adapter, hydration, reply-routing, and Playwright fixtures cover the bridge and
interaction behavior. These checks are not a live-model or real-editor verification result.

Verified on October 16, 2026: 1,196 tests across 16 focused unit/backend suites, 16 Playwright
cases across native forms and existing question suites, and five native-validator fixtures.
`npm run lint`, `npm run fmt`, `npm run typecheck`, `npm run typecheck:suggestions`, and
`npm run build` passed. Mixed-version multi-webview rollout remains unverified.

The reload regression also runs in a real isolated VS Code host through
`scripts/ai-opencode-client.integration.test.mjs`. Build first, set
`VARRO_OPENCODE_TEST_BINARY` to an installed V2 executable and `VARRO_AI_TEST_EDITOR=1`, then run
`node --test scripts/ai-opencode-client.integration.test.mjs`. It uses a local fixture provider and
separate database, verifies restored text, zero, false, and unfinished custom selections, confirms
reload leaves the form pending, and submits the restored typed answer.
