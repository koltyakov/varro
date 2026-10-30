# Session cleanup

Run **Varro: Delete Old OpenCode Sessions** from VS Code's Command Palette. The wizard asks:

1. How many calendar months to keep. The default is six months.
2. Whether to preserve trimmed transcripts or only usage statistics.
3. Confirmation of permanent deletion, including the transcript database path when selected.

Cancelling either wizard input or the confirmation changes nothing. Transcript preservation is selected for this run only, not remembered as a global preference.

The command inventories the connected local OpenCode server's sessions across every project, including archived sessions and child sessions. Age uses `time.updated`, not creation time. A session exactly at the retention cutoff stays. Calendar arithmetic uses UTC and clamps month-end dates.

## Deletion and recovery

Cleanup visits candidates from oldest activity to newest. OpenCode's delete API recursively deletes child sessions, so each tree is one deletion unit. The command archives usage for every member before deleting its root. Optional transcripts preserve only parent conversations, never subagent sessions. It keeps a parent if any descendant is inside the retention window, active, or changed during validation. Old children of a retained parent can still be deleted independently.

Each unit follows this order:

1. Recheck session timestamps, directories, child membership, and activity.
2. Commit the tree's usage and artifact journal to SQLite with full synchronous durability. If selected, also commit the parent conversation's trimmed transcript to its separate database. Both archives must succeed before deletion. Child-only trees need no transcript.
3. Recheck timestamps, children, and activity, then ask OpenCode to delete the tree.
4. Confirm that every member is gone, then add its owned artifacts to the final file-cleanup pass.

An archive or server failure stops the run before later candidates. Completed server deletions and their archives remain saved. Cancel interrupts validation reads, archive workers, or file-reference scans, and leaves any unstarted tree live. It never interrupts an already-started server deletion or its confirmation. Unremoved files stay in the durable recovery journal. Run the command again after an interruption to continue.

Progress uses three stable stages: processing sessions, checking shared files, and cleaning unused files. Notifications refresh once a second with completed-work counts and elapsed time, without cycling through session IDs or internal operations. Completion and error notices offer **Show details** to open the **Varro** output channel. Output retains stage transitions, summaries every ten seconds, slow operations, reasons for keeping sessions, and the last operation on failure. No prompts, responses, or attachment contents are logged.

Slow-operation and failure details can include session IDs, local message/part counts, API page counts and bytes, or archive writes. Each read-only validation request has a cancellable 30-second deadline. The usage worker also retains its 30-second deadline; a timeout includes the last reported operation rather than silently increasing the timeout or deleting without an archive.

The command serializes cleanup runs across VS Code windows. Other clients can still change sessions. OpenCode has no conditional recursive-delete API, so do not resume sessions being cleaned from another client during the final validation/deletion interval.

For V2, activity checks use global execution status and shell-status reads only in locations already loaded by the server. Cleanup does not open historical project directories, so sessions from deleted or renamed folders can still be removed. Background services in other loaded locations remain protected. A missing-location 404 never counts as confirmation that a session was deleted.

Cleanup requires a local managed connection and a readable matching OpenCode database. It refuses attach-only connections rather than archiving unrelated local statistics or attempting to remove files on a remote host. It does not delete a different OpenCode installation's database or dormant V1 sessions that a V2 server cannot expose.

## Usage archive

The archive is `opencode-stats.db` beside `opencode.db`. With a custom `OPENCODE_DB`, the archive uses the same directory and database basename with `-stats.db` appended instead of the original extension. Keep this archive when backing up or moving OpenCode data.

The archive retains session identity and last-update time, provider/model routes, recorded model variants for reasoning-setting exports, assistant timestamps, parent-message identities for prompt counting, token breakdowns, and reported costs. Older archives without variants remain readable and export the reasoning setting as `unknown`. It does not retain prompts, responses, tool output bodies, or image bytes. Pending cleanup records also retain the project directory and owned artifact paths until cleanup succeeds.

Usage reports merge live V1, live V2, and archived records by original session identity. They select the newest complete snapshot, prefer V2 on equal update times, and prefer a live snapshot over an identical archive. Imported V1/V2 copies and retries do not double-count usage. Original migration completion times and Varro pause boundaries are applied before archiving, so durations survive deletion of the source messages and annotations.

The statistics archive also supports a separate `usage_original_timing` table for original V1 completion timestamps used by retained live V2 messages. This is scalar provenance, not another usage snapshot: tokens, costs, prompts, and new messages still come from the selected live session. Readers use matching live V1 timing first, preserved originals second, and native V2 timing last, then apply current pause boundaries.

Timing preservation is an explicit internal operation, not an automatic migration or a legacy-history deletion command. It reads matching V1/V2 records, commits and verifies the originals in the statistics sidecar, and never changes the live database or queues artifact cleanup. It currently supports migrations that retain message IDs, including mapped session identities. Remapped-message imports without a verified mapping are not guessed. Preservation alone does not authorize deletion: callers must separately revalidate coverage and session activity before any future legacy cleanup.

Version-zero statistics archives remain readable without modification. Explicit archive writes add schema version 1 and the independent timing table transactionally; ordinary reports and CSV exports never migrate storage. Conflicting or invalid timing and unsupported schema versions stop the operation. Timing records survive replacement of archived usage snapshots. Keep the statistics sidecar with database backups and restore it under the matching basename. Older Varro versions do not read preserved timing, and a completely missing sidecar cannot always be distinguished from history that never needed it.

Each cleanup unit resolves the requested identities once, then reuses a temporary table containing only their related live snapshots. Discovering migrated aliases still reads the global session headers once; later archive queries do not repeatedly rank all projects. Original-message timing is queried once per assistant record, and usage inserts reuse a prepared statement. All temporary tables belong to the worker connection; the live database schema is not changed.

Artifact recovery does not delay new session deletions. After the session pass, previously deleted journal entries and newly confirmed deletions share one remaining-history scan. The worker reads each remaining message/part/inbox row at most once for the batch. A compiled literal-name matcher skips unrelated rows without running a substring check for every filename. Matching rows still check every unresolved name, preserving literal, prefix, suffix, overlapping, and Unicode matches. Found names leave both the pending set and compiled matcher, so a repeatedly mentioned shared name cannot keep triggering slower checks. Missing files need no scan. Shared names stay protected, including references in dormant V1 history.

Reference scans can run for up to ten minutes, but terminate after 60 seconds without an increasing scanned-row count. Repeated phase labels or repeated row counts do not extend that timeout. Cancellation still terminates the worker and waits for teardown; no file is removed from an incomplete scan. Usage reports, pre-delete usage archiving, and journal writes retain their separate 30-second deadlines. Cancelling or failing before file cleanup completes leaves the remaining paths journaled for retry.

`/stats` continues to show today and rolling 7/30-day windows. `/stats all` includes older archived usage. Reports also work from the archive when the live database is absent. The source database remains read-only during statistics collection and archiving; session deletion goes through OpenCode's API.

## Optional transcript archive

Selecting **Yes, preserve transcripts** writes parent conversations to `opencode-transcripts.db` beside `opencode.db`. Sessions with a parent identity are subagent work and are neither read nor stored as transcripts. Their usage is still archived before deletion. With a custom `OPENCODE_DB`, the archive uses its directory and basename with `-transcripts.db` in place of the original extension. For example, `/data/chat.sqlite` uses `/data/chat-transcripts.db` and `/data/chat-stats.db`. The confirmation and output details show the transcript path.

This is a read-only transcript, not a resumable OpenCode session or a full backup. This command does not add an archive viewer or import the copies into live history. Back up both archives when moving OpenCode data. The transcript archive contains private conversation text in plaintext, unlike the statistics-only archive. New transcript files use owner-only permissions where supported by the OS.

The trimmed copy retains:

- Delivered user prompts and final assistant response text, preserving Markdown and code blocks.
- Message identities, timestamps, response model identities, session title, project directory, and original migration identity when present.
- Explicit succeeded, failed, and interrupted turn outcomes when available. Failed/interrupted turns can retain partial response text, clearly marked by their outcome. Prompt-only turns are kept without an invented answer.
- Varro pasted-text and chat-annotation attachment contents. Other user attachments retain only names and MIME types, marked as omitted.

Reasoning, intermediate assistant commentary, tool calls/results, snapshots, native provider replay data, and image/file bytes are not retained. Original external attachments are still protected, but session-owned attachment copies and unshared OpenCode media blobs are removed by cleanup. A pasted image may therefore no longer exist after deletion. User decisions recorded only inside tool/form results are not retained either.

Ordinary V2 sessions use a read-only SQLite snapshot. The worker projects prompt/response text and attachment metadata without transferring tools, reasoning, native replay data, or image bytes to the extension. Separately stored assistant parts override inline content in ordinal order, matching OpenCode history. Only recognized pasted-text and annotation attachments load blob bytes. Session timestamps must match the cleanup inventory; missing or stale sessions stop the run.

Forks, staged reverts, and unrecognized storage layouts fall back to native V2 message pagination so the server resolves their history. The reader follows the cursor after the last nonempty page and accepts OpenCode's empty terminal page with `next: null`, as well as an omitted next cursor. Invalid or repeated cursors still stop cleanup. Both paths preserve idle boundaries. Older/imported history without a boundary uses a completed non-tool response followed by another prompt as an inferred boundary; its outcome remains `unknown`, not `succeeded`. Steering within a tool sequence retains each delivered prompt. Background responses can have no user prompt. V2 sessions with undelivered inbox work are kept rather than dropping queued inputs.

The SQLite format has `PRAGMA user_version = 1`:

- `transcript_session` stores one header per physical session ID, plus its original identity for association with the independently deduplicated usage archive.
- `transcript_turn` stores ordered turns as JSON in `data`, with `prompts`, optional `response`, `outcome`, and `boundary` fields. Text entries include IDs and timestamps. Attachment entries distinguish preserved text from omitted bytes.

Each tree is committed in one transcript transaction with full synchronous durability. Retries replace the same session snapshot without duplicating turns and refuse to overwrite a newer snapshot. A failure in either archive prevents deletion of that tree; a transcript can remain alongside a still-live session after cancellation, a source change, or a deletion failure. Statistics are collected from all assistant steps, never recalculated from the trimmed text.

History reads are bounded to 100,000 messages per session. API history is limited to 64 MB per session; local projected history and trimmed data are each limited to 64 MB per deletion tree, with at most 500,000 stored parts per session. Reading a tree has a 60-second overall deadline, including API fallback; writing retains a separate 30-second deadline. Cancellation terminates workers and waits for teardown before cleanup returns. A cancelled write may have committed a complete archive, but cannot authorize deletion of that tree. Oversized, malformed, incomplete, or unsupported parent history stops cleanup instead of silently saving a partial transcript. An unavailable pasted-text or annotation attachment also stops deletion.

## History age and disk space

About shows **History age** from the oldest remaining stored session's creation timestamp, not the database file's creation date. Retained V1 history is included even when the connected V2 server cannot list it. Deleting visible V2 sessions can therefore leave the history age unchanged. Cleanup does not delete dormant V1 history.

Deleting rows usually frees SQLite pages for reuse without shrinking `opencode.db`. About shows these pages as **Reusable space**. Its total database size includes the SQLite WAL. Usage and transcript archives are separate.

To return unused space to disk, run **Varro: Compact OpenCode Database**, or select **Compact database...** in About. This is a separate, confirmed operation, never an automatic follow-up to cleanup. Back up your data and close other OpenCode clients first.

Compaction requires a verified local managed server, no active work or pending decisions, and free disk space of at least twice the larger of the current database-plus-WAL size or allocated SQLite pages, plus 64 MiB. It reserves restart ownership, stops OpenCode, obtains an exclusive SQLite lock, checkpoints the WAL, runs `VACUUM`, checks integrity, and restarts OpenCode. Session content and archive databases are unchanged. WAL-only space can also trigger maintenance; its full size is not a guaranteed saving.

Cancellation terminates the SQLite subprocess and waits for it to exit before attempting to restart OpenCode. Maintenance failures also attempt restoration before reporting the error. A restart failure remains an error; check the connection status before retrying. Compaction has a one-hour limit and can take several minutes on a large database.

## Files removed and protected

OpenCode deletes the session's database rows and releases its owned media blobs. Blobs still referenced by another session remain under OpenCode's reference counting.

Varro additionally removes these recorded artifacts after confirmed deletion:

- The session's `.opencode/attachments/<session-id>/` transfer directory. These are chat-owned copies, not original files.
- Its legacy `storage/session_diff/<session-id>.json` cache, if present.
- Structured file references and truncated tool-output paths inside OpenCode's managed `tool-output` directory, limited to generated `tool_*` filenames.
- Referenced Varro temporary dropped/pasted files with the generated filename format and a valid `.varro-owner.json` marker.

Files referenced by remaining messages or queued inputs stay in the journal for a later retry. Cleanup refuses symlinked artifact paths and never follows arbitrary attachment URLs or paths found in prose. External attachments, source-code attachments, project files, repositories, and worktrees are not deletion targets. A file cleanup failure leaves the usage archive and journal intact.
