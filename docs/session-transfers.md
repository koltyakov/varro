# Session transfers

An OpenCode session can move to another directory without changing its session or message IDs.
Varro handles `session.next.moved`, including the native v2 `session.moved` projection, before normal
workspace event filtering. Otherwise a move outside the selected folder would disappear without an
explanation.

- Only views with verified originating-workspace access receive the transfer notice. A webview route
  alone cannot grant that access. Foreign session moves do not disclose their destination to unrelated views.
- The host reads the canonical session before following a move. Duplicate notices are coalesced;
  obsolete replay events and superseded lookups cannot move the view back to an earlier directory.
- Session catalog authorization is refreshed for the destination. An active conversation follows
  automatically only when the destination is already authorized by an open folder or history scope.
  Background transfers refresh the catalog without taking over the selected conversation.
- Varro saves a bounded, server-scoped link in the originating workspace's local state. The session
  remains in that project's list after selection changes and editor reloads, with a destination label
  using the same layout as workspace labels. This does not move or copy the OpenCode session.
- Retained links admit only session-scoped history, attachment, diff, and summary reads. They do not
  authorize filesystem access, tools, sends, edits, permission replies, or other session mutations in
  a closed destination. Unknown sessions and other servers do not inherit these read capabilities.
- A transfer refresh preserves the active transcript, message IDs, pagination, expansion state, draft,
  and scroll ownership. It does not clear the chat or force a jump to the latest message.
- A destination outside the authorized workspace keeps the last transcript and composer draft on
  screen, with a persistent "Conversation moved" notice. Sends are blocked rather than dispatched
  through the previous directory. The server execution itself is not cancelled.
- "Open folder" is an explicit user action. The host rechecks the canonical destination and opens
  that folder in a new VS Code window. The originating project can still open the conversation's history.
  This action does not change the server session, permissions, messages, or timestamps.
- A known session read or activation which discovers directory drift reports a transfer rather than
  a missing conversation. Unrelated out-of-workspace sessions still receive the existing not-found
  response, and workspace authorization is not widened.

Focused regressions cover host routing, stale events, workspace boundaries, bridge state, preserved
drafts, disabled sends, and the open-folder action. These tests use fixture servers and stores, not
production session mutations.
