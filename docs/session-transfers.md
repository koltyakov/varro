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
- A known transferred conversation can also follow a closed folder, including a non-Git folder or a
  saved worktree, without opening another VS Code window or widening history scope. Its retained,
  server-scoped link must belong to an open origin. Through that origin the host verifies the canonical
  session ID, project and exact destination. The resulting grant applies only to that conversation
  and its subagent sessions in that exact destination, not other sessions, the destination's catalog,
  or general filesystem access. A missing link or failed canonical verification leaves the
  conversation read-only. Verification never loads destination config.
- OpenCode starts a subagent in its parent's location, so a child inherits its nearest verified
  ancestor's grant only while its own recorded location is that same directory and the
  conversation's catalog root is still open. A child with an unknown location inherits nothing. The
  grant is derived on each read, so revoking the conversation revokes its children. Its transcript,
  prompts, pending snapshots, and replies follow the conversation's origin view. A view that owns a
  session through its catalog root, by its own grant or an inherited one, may read that session's
  metadata without a directory, so a prompt that arrives before the session is loaded can join its
  conversation tree. The webview accepts a new session whose parent it already lists in the same
  directory, even outside an open folder. To place a prompt from an unloaded subagent, it reads the
  whole missing parent chain until it reaches a loaded session, even past a session whose
  permission mode is already saved, and adds that chain ancestor-first in one update, so a cold
  grandchild is not rejected before its parent arrives and still inherits the saved mode. Store
  writes are committed before and after each chain, so concurrent lookups for sibling prompts do
  not overwrite each other. The catalog lists a moved conversation through its link but never its
  subagents, so a complete session-list reload keeps loaded subagents of the active conversation,
  and the whole chain from the conversation to any session with a pending question or permission,
  while every hop still shares the conversation's current directory. Dropping a pending
  permission's owner would let the prompt read as unknown and appear in whichever conversation is
  open. Other subagents are pruned and loaded again on demand.
- When the host has not seen a child's ancestry, as after a reload, it reads canonical sessions by ID
  through the open origin, only for a directory an existing grant or visible retained link already
  owns. A record for a different session ID is never recorded. Responses that arrive after a catalog
  invalidation or after the origin folder closes are discarded. A malformed response, a cycle, or the
  read bound leaves the ancestry unresolved, which rejects a pending snapshot instead of omitting the
  child's requests. Live recovery re-verifies the nearest ancestor whose own move left a visible link
  to the child's directory, which need not be the top-level conversation; the walk stops there, so the
  chain above that ancestor need not load. An ask whose verification
  identifies an internal helper or recycled session is dropped before routing.
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
  and safely remove the clean worktree after success. Both worktree prompts require moving the chat
  back immediately after minimal read-only source/target checks, before planning, commits, rebasing,
  migration, or tests. Commands then use explicit source and target paths. A failed move stops the
  workflow without changing or deleting either checkout. Clicking the menu does not run
  Git directly or bypass tool permissions.
- "Migrate changes" uses the same prompt delivery but transfers task files into the target working tree,
  leaving tracked changes unstaged and new files untracked. It must not change the target's branch,
  HEAD, or index, integrate commits, or overwrite existing changes. Source-only snapshot commits may
  retain a recovery copy before verified cleanup; target commits are forbidden.
- Varro saves a bounded, server-scoped link in the originating workspace's local state. The session
  remains in that project's list after selection changes and editor reloads, with a destination label
  using the same layout as workspace labels. This does not move or copy the OpenCode session.
- Retained links without a verified execution grant admit only session-scoped history, attachment,
  diff, and summary reads. Successful canonical verification allows that known conversation to continue
  in its destination without opening the folder. Unknown sessions, unrelated destinations and other
  servers do not inherit the grant. Catalog invalidation and directory drift require fresh verification.
- A transfer refresh preserves the active transcript, message IDs, pagination, expansion state, draft,
  and scroll ownership. It does not clear the chat or force a jump to the latest message.
- Changing a conversation's directory clears its old presentation-only worktree flag before refreshing
  history, so the old Git icon does not linger when the chat returns to its original folder.
- A destination that cannot be verified keeps the last transcript and composer draft on screen, with
  a persistent "Conversation moved" notice. Sends are blocked rather than dispatched through the previous
  directory. The server execution itself is not cancelled.
- "Open folder" is an explicit user action. The host rechecks the canonical destination and opens
  that folder in a new VS Code window. The originating project can still open the conversation's history.
  This action does not change the server session, permissions, messages, or timestamps.
- A known session read or activation which discovers directory drift reports a transfer rather than
  a missing conversation. Unrelated out-of-workspace sessions still receive the existing not-found
  response, and workspace authorization is not widened.

Focused regressions cover host routing, stale events, workspace boundaries, bridge state, preserved
drafts, disabled sends, and the open-folder action. These tests use fixture servers and stores, not
production session mutations.
