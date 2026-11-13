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
- A known transferred conversation can also follow a saved Git worktree of the same project, without
  opening another VS Code window or widening history scope. The host verifies the open root's project,
  its Git VCS, the server's saved worktree inventory, and the canonical session's project and destination.
  Missing, unrelated, or unverifiable destinations remain read-only and require the existing explicit
  open-folder action. Verification never loads configuration in an unapproved destination.
- V2 project and worktree inventories are native bare arrays, not session-style `data` envelopes.
  When a fresh session snapshot confirms availability, the webview clears an older read-only marker
  for that same destination. A marker for a different, newer move remains blocked.
- Only moved conversations and worktree chats show a location icon after the title. Ordinary unmoved
  chats have no folder icon. The header uses the Git icon for a
  server-confirmed Git worktree. Hover shows the full path in the custom tooltip. Clicking or
  right-clicking the icon offers "Open folder"; the host rechecks the session before opening a new
  VS Code window. This action does not move the conversation.
- V2 session lists carry presentation-only worktree metadata, read once per project inventory rather
  than once per row. Worktree paths use the same Git icon and just the directory name in the list, without
  `Moved to` or `Worktree:` prefixes. This metadata never grants
  execution or filesystem access.
- Location menus offer "Copy folder path" for both moved folders and worktrees. Writable worktrees
  also offer "Merge changes", which sends a follow-up-style prompt to that conversation without
  consuming the composer draft. The full instructions revalidate the target project's current branch,
  preserve unrelated changes, stop on conflicts, require verified fast-forward integration and checks,
  then move the chat back before safely removing the clean worktree. Clicking the menu does not run
  Git directly or bypass tool permissions.
- "Migrate changes" uses the same prompt delivery but transfers task files into the target working tree,
  leaving tracked changes unstaged and new files untracked. It must not change the target's branch,
  HEAD, or index, integrate commits, or overwrite existing changes. Source-only snapshot commits may
  retain a recovery copy before verified cleanup; target commits are forbidden.
- Varro saves a bounded, server-scoped link in the originating workspace's local state. The session
  remains in that project's list after selection changes and editor reloads, with a destination label
  using the same layout as workspace labels. This does not move or copy the OpenCode session.
- Unapproved retained links admit only session-scoped history, attachment, diff, and summary reads. They do not
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
