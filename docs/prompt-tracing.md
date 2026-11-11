# Auxiliary inference prompt tracing

Set `varro.chat.promptTrace` to `true` in VS Code user settings to include tracing metadata in Varro's auxiliary inference prompts. The default is `false`; workspace settings cannot enable it. This replaces the experimental `varro.chat.followupTrace` setting. The old setting does not enable the broader feature automatically.

```json
{
  "varro.chat.promptTrace": true
}
```

This is a workaround for proxies that cannot obtain source-session attribution from OpenCode's stateless generation path. It adds metadata to existing requests; it does not enable inference features, change models, change permissions, or create additional conversations. A compatible proxy hook must extract the metadata and remove the line before inference. Otherwise the model receives it as text and may charge tokens for it.

## Route audit and coverage

The following describes the routes in the current Varro implementation, based on source inspection. Live gateway accounting has not been verified.

| Purpose | Route | Attribution added and reason |
| --- | --- | --- |
| `followup` | OpenCode V2 stateless text generation | Source session and verified root. Stateless calls do not invoke the session `model.request` hook. |
| `permission-judge` | Temporary hidden chat helper | Permission owner's session and verified root, permission request ID, and helper session ID. The helper is not the source conversation. V2 compatibility ancestry can live in Varro annotations rather than a native parent relationship visible to plugins. |
| `permission-judge` | OpenCode native stateless decisions endpoint | Source session and verified root when available, plus permission request ID. The marker prefixes the existing text input; questions, probability thresholds, and response gates are unchanged. |
| `commit-message` | Stateless text generation or hidden-helper fallback | Hashed workspace ID and helper ID when applicable. SCM generation is repository-wide and has no trustworthy source conversation, even when an active chat provides the fallback model. |
| `session-title` | Varro's stateless title generation or hidden-helper fallback | Source session and verified root, plus helper ID when applicable. Does not cover OpenCode's own automatic title requests. |
| `side-question` | Existing V2 session `/generate` endpoint | Source session, verified root, and a purpose marker. Session hooks already have identity; the marker distinguishes a side question from other transient generation. |
| `background-process-judge` | Stateless text generation | Shell owner's session and verified root, plus shell ID as `requestID`. This classification request is not an agent turn or a permission approval. |
| `prompt-completion` | Direct provider Chat Completions, Responses, or Messages API | Purpose and hashed workspace ID when available. The completion boundary has a draft and recent text but no source session ID, so Varro does not infer one from active UI state. Model-picker tests may have purpose-only attribution. |

Ordinary chat sends, commands, tools, subagents, compaction, and OpenCode-owned title generation are unchanged. Their session identity belongs to OpenCode's request hooks.

The legacy direct TypeSafe/Jev integration is also unchanged. It sends structured `state` and questions to a fixed TypeSafe endpoint, not a text prompt through the configured OpenCode provider. Adding a prompt marker there would change its state contract without solving this proxy-attribution problem. Native decision models selected through OpenCode are covered separately above.

## Wire format

The designated Varro-owned prompt text starts with the exact ASCII prefix `VARRO_TRACE_V1 `, one compact JSON object, and one LF newline. The remaining text is unchanged.

Examples:

```text
VARRO_TRACE_V1 {"purpose":"followup","sessionID":"ses_child","rootSessionID":"ses_root"}
Suggest optional next tasks after a coding assistant response. You cannot use tools or perform work.
```

```text
VARRO_TRACE_V1 {"purpose":"permission-judge","sessionID":"ses_child","rootSessionID":"ses_root","requestID":"perm_one","helperSessionID":"ses_helper"}
<original judge instructions>
```

```text
VARRO_TRACE_V1 {"purpose":"commit-message","workspaceID":"<64 lowercase hex characters>"}
<original commit-generation instructions>
```

Angle-bracket values above are explanatory placeholders, not literal wire values.

| Field | Meaning |
| --- | --- |
| `purpose` | Required. One of the purpose values in the route table. It is not an agent name. |
| `sessionID` | Optional. The actual source conversation, never the temporary helper. |
| `rootSessionID` | Optional. A verified root of the source conversation. Equal to `sessionID` when the source is itself a root. |
| `workspaceID` | Optional. SHA-256 of the normalized absolute directory, included only when no valid source session ID is available. Raw paths are not included in the marker. |
| `requestID` | Optional. The permission or shell ID associated with the auxiliary request. It is not a unique provider-call ID. |
| `helperSessionID` | Optional. Identifies a temporary helper separately from the source conversation. Never use it as the source's root. |

The prefix identifies version 1; there is no separate version field. JSON property order is not significant. Missing values are omitted, not serialized as `null`. Purpose-only records are valid when neither source nor workspace is known.

Identifier fields other than `workspaceID` use `^[A-Za-z0-9_-]{1,200}$`. `workspaceID` is 64 lowercase hexadecimal characters. Workspace hashes correlate a directory, not necessarily a canonical Git repository across machines, moved checkouts, symlink spellings, or different servers. They are not a substitute for tenant identity and can be guessed by hashing candidate paths.

### Placement depends on the route

- Stateless text generation and side questions put the marker at the beginning of their generated prompt.
- Hidden-helper requests put it at the beginning of Varro's system instructions. V2 combines these instructions and user text into a transient generation prompt, so the marker remains its first line. V1 can carry it in the system message instead.
- Native decisions prefix the existing text input, before its JSON evidence.
- Direct prompt completion prefixes the JSON context in the user message or Responses `input`; system instructions stay unchanged.

A parser must inspect only the supported, designated request boundaries for that protocol. For session-scoped generation, inspect the new transient input, not earlier conversation history. Never search arbitrary user text, quoted JSON, or assistant answers for a marker. The marker is not returned by the model and does not need to appear in its answer.

## Ancestry, failure, and cancellation

Source-session tracing uses read-only lookups with identity checks, cycle detection, at most 16 session reads, a shared two-second lookup deadline, and a 64 KiB response limit per read. It has no cross-request ancestry cache, so a stale root from another conversation or server cannot leak into a later request.

When lookup fails, times out, or reaches the depth limit, Varro still sends the known source ID but omits `rootSessionID`. Absence means unresolved, not proof that the source has no parent. Lookup failure does not block inference. Caller cancellation still propagates.

Requests without a source session perform no ancestry lookups. With tracing disabled, prompts remain byte-for-byte unchanged and no tracing-related session reads occur. The setting is read when preparing each inference request. Changing it does not retract an already submitted request or regenerate cached suggestions and verdicts.

## Gateway or proxy hook integration plan

Varro does not install a gateway hook. This convention can be used by any LLM gateway or proxy that supports inspecting and modifying requests before inference and attaching accounting metadata. Implement it through the deployment's supported pre-call hook or equivalent middleware.

1. **Verify request representations.** Capture disposable requests using the installed OpenCode and gateway versions. Confirm where Chat Completions messages, Responses input, Messages content blocks, and native decision text input appear in the pre-call data. Do not assume every request uses `messages[0].content`. Leave unsupported or ambiguous shapes unchanged.
2. **Parse only supported boundaries.** Require the exact marker at offset zero of the designated text. Bound the first line to 1 KiB and require its terminating LF before JSON parsing. Reject duplicate JSON keys, wrong types, unknown fields, unsupported purposes or versions, and invalid identifiers. A root requires a source session. A workspace-only record must not be treated as a session. Reject ambiguous multiple candidate markers. Do not recognize the format by instruction text or model name alone.
3. **Map accounting consistently.** Reuse the deployment's existing conversation-accounting mapping, such as one based on `x-opencode-session-id` from normal OpenCode requests. Prefer verified `rootSessionID`, then a caller-scoped known source-to-root mapping, then provisional source grouping. If there is no source, keep workspace attribution separate from conversation grouping. Purpose-only requests receive a purpose tag, not an invented session ID. Preserve permission, shell, and helper IDs as metadata. A recognized marker may override a detached stateless/helper ID for accounting only; do not overwrite authenticated user, key, team, budget, or permission identity.
4. **Strip exactly one validated line.** After applying attribution, remove only the first line and its LF from the designated text. Preserve all remaining text, message roles, content-block order, model selection, decision questions, and request options. The provider prompt should match the tracing-disabled baseline. Verify callback ordering with caching, guardrails, logging, and other session-mapping callbacks; a later callback must not restore the detached helper ID.
5. **Check stored results.** Confirm the gateway's actual usage records and cost-grouping output. Adding an arbitrary metadata field, or changing a header after the gateway has processed headers, is not proof that accounting uses it. Preserve separate provider call IDs and costs for retries and fallbacks, even when `requestID` and the accounting group are the same.

Malformed or unsupported markers should leave inference and accounting unchanged, with a bounded diagnostic reason if useful. Never log credentials or full prompts while diagnosing parsing. Earlier callbacks may already have captured the original marker; stripping before inference does not remove it from every proxy log.

## Trust and privacy

This is caller-supplied tracing metadata, not a signature or proof of session ownership. Someone who can submit arbitrary prompts can forge the same text. Scope mappings to the authenticated gateway caller and never use the marker for authorization, tenant isolation, or billing transfers between mutually untrusted callers.

The opt-in sends correlation identifiers as prompt text. No paths, session titles, credentials, random trace IDs, or timestamps are added to the marker. Existing prompt content may already contain paths; tracing does not redact it. Historical spend records are not repaired by enabling the setting.

## Proxy acceptance checks

Use disposable sessions and a test proxy. Do not modify production OpenCode sessions or historical spend records.

| Case | Expected result |
| --- | --- |
| Tracing disabled, or only the old setting enabled | Original requests and accounting; no tracing lookups. |
| Root, child, and nested-child session requests | Same root accounting group as normal conversation calls; source remains available separately. |
| Hidden permission/title helper | Source group wins over helper identity; helper remains metadata. |
| Repository commit generation with another chat active | Workspace attribution, no fabricated conversation relationship. |
| Direct prompt completion and model-picker tests | Workspace or purpose-only attribution, no unrelated active-session ID. |
| Native permission decisions | Attribution extracted from supported text input; original JSON evidence and decision questions restored unchanged. |
| Side questions | Same session generation route and accounting, with a distinct purpose. |
| Background-process judgment | Source session grouped correctly; shell ID retained. |
| Concurrent requests, different servers, or changed ancestry | No cross-group contamination or cached root reuse. |
| Root lookup failure, timeout, cycle, or depth limit | Source-only marker, explicitly unresolved root. |
| Forged marker text inside conversation data | Ignored by boundary-aware parsing. |
| Malformed, oversized, duplicate, unknown-version, or ambiguous markers | No request or accounting mutation; inference continues. |
| Tracing enabled and a compatible hook installed | Provider text matches the tracing-disabled baseline. |
| Retries, helper fallback, cached follow-ups, and cached verdicts | Correlation preserved without merging individual call records or triggering extra generation. |

Source and unit tests establish formatting, metadata selection, bounded lookup, cancellation, and route preservation. They do not establish live gateway cost attribution; the proxy-side checks above are still required.
