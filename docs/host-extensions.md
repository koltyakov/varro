# Host extensions

Varro's webview can run in another editor without rewriting its sources. The host registers one
adapter with `registerHostExtension` from `src/webview/host/extensions.ts`, then dynamically imports
`src/webview/index.tsx`. The adapter can contain any number of context providers and menu actions.
It must register before importing modules that initialize application state or the message bridge.

```ts
registerHostExtension({
  apiVersion: 1,
  id: 'example.host',
  requires: ['context-providers'],
  metadata: {
    name: 'Example', version: '1.0.0', repository: 'https://example.com/project', ideName: 'Example IDE',
  },
  capabilities: { detachedEditors: false },
  services: { send, projectStorage, viewState },
  contexts: [issueProvider],
  actions: [{
    id: 'example.inspect', slot: 'session.actions', label: 'Inspect issue',
    run: ({ sessionId, directory }) => inspectIssue(sessionId, directory),
  }],
});
await import('./webview/index');
```

## Compatibility and ownership

- `apiVersion` is the host API major version, independent of the Varro release. Incompatible
  versions fail registration before mount. Additive optional fields retain their defaults.
- `requires` checks feature IDs. Version 1 advertises `context-providers`, `menu-actions`,
  `project-storage`, and `file-paths`. Unknown requirements fail explicitly.
- IDs use lowercase dot-separated namespaces. Duplicate contribution IDs are rejected.
- Registration order is display order. Registration is fixed while the app is mounted; callbacks
  and configuration are copied at registration. State inside supplied services remains host-owned.
- With no adapter, Varro uses its existing VS Code transport, browser storage, per-view state,
  product metadata, and detached-window actions. A missing capability retains this default.
- `send` and `subscribe` replace the transport while retaining the core's message validation and
  ordering. The subscription returns a disposer. Core cleanup calls it before dropping handlers.
- `projectStorage` implements `Storage` without replacing `window.localStorage`. `viewState` is the
  synchronous per-view store. A host may implement persistence asynchronously behind these services.
- `filePath` resolves native dropped files without modifying `File`. `setDragImage` returns true
  when the host handles a drag preview; otherwise Varro calls the browser's implementation.
- The disposer returned by registration releases the adapter and calls its optional `dispose`.
  Call the cleanup returned by `startWebview` before disposing registration. Dispose is idempotent.
  Host-owned page listeners and resources belong in the adapter's disposal callback.

Menu slots are `chat.new` and `session.actions`. Core renders text-only buttons, captures the current
session target on invocation, prevents duplicate clicks, and reports callback failures through the
normal error UI. Extensions do not receive component instances or mutate internal stores.

## Context providers

Hosts send `editorContext.extensionContexts` through the existing initial-state and `context/update`
channels. Send `[]` to clear previous context. Each entry has this shape:

```ts
{
  provider: 'example.issue',
  version: 1,
  label: 'BUG-42',
  placement: 'alongside-document',
  data: { summary: 'Incorrect total' },
}
```

`data` is bounded JSON, owned by the provider. Its version is independent of the host API version.
Providers implement `validate(data)` and `capture(data)`. Capture returns plain prompt `text`,
optional tooltip `detail`, and an optional `file`, `table`, or `terminal` icon. Failures block the
send with an error; they do not silently omit context.

`alongside-document` supplements file or unsaved-editor context. `replace-document` suppresses that
automatic document context. Multiple providers can contribute; all follow the existing current-context
toggle. Their chips use core components. `presentation.attachmentDetails: 'tooltip'` keeps detail
text in tooltips instead of inline chips.

Queue admission deep-copies data and captures prompt text synchronously. Reordering, pausing, text
editing, and later provider upgrades do not regenerate that captured text. Hosts may also supply
already captured snapshots, as OpenJet does at its native context boundary. Queued edits retain their
original extension snapshots unless the current-context toggle excludes them.

Snapshots use a core-owned `[Extension context]` fenced JSON transcript format. Core renders a
fallback chip and opens captured text without requiring the provider. Inline editing retains the
snapshot; prompt-history navigation hides generated context. Unknown providers and versions survive
storage. An uncaptured snapshot requires its matching provider before sending.

Provider callbacks receive detached data. Context limits are 32 entries, 512,000 serialized characters
per entry, 1,024,000 total, and 32 levels of JSON nesting. Cycles and non-JSON data are rejected.
Validation does not interpret unknown provider data or rewrite existing sessions.

`readLegacyBlock` is an optional, read-only compatibility parser for a provider's old transcript
format. Core invokes it outside code fences. It must return a valid captured envelope and the ending
line index, or null. Malformed blocks remain visible as ordinary text. New formats should use the
core envelope rather than inventing another transcript marker.

## OpenJet

OpenJet implements the adapter in `webview/src/host-bridge.ts` and its database provider in
`webview/src/database-extension.ts`. Native database wire data and historical queued snapshots are
translated at that boundary; the vendored protocol and UI never import OpenJet modules.

Run sync against a compatible Varro revision, then `npm run sync:check` in OpenJet's `webview` folder.
The committed `vendor/UPSTREAM.json` records the revision, local-change status, and content hash.
Normal builds use this snapshot. Source adaptations belong in the adapter, not in sync or Vite
transforms. Until the host API lands upstream, use `VARRO_SOURCE=/path/to/varro npm run sync`.

Contract tests live in `src/webview/host/extensions.test.ts`, the composer and send-factory suites,
and `src/webview/components/HostActions.test.tsx`. OpenJet's host tests exercise its native database
translation, historical formats, and the unmodified send builder.
