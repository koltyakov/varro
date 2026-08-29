# Changelog

This changelog summarizes the main user-facing improvements in each Varro minor release line. Patch releases are consolidated into their parent minor version. Dates reflect the development history.

## 0.27.x - August 2026

- Added multi-root workspace support with independent sidebar and editor chat selection, workspace controls, and session routing across activation, sends, summaries, Ralph runs, forks, and reopened chats.
- Added sibling-workspace notifications with quick switching for sessions needing attention, failed sessions, and completed plans.
- Added automatic provider authorization without a browser URL, plus Azure and Amazon provider icons.
- Improved workspace-scoped state, session recovery, provider authentication, long-conversation scrolling, composer isolation, and editor context handling.
- Fixed link punctuation, token totals, hidden-model persistence, transcript overflow, chat action colors, queued-message restoration, local usage reporting, and stale webview events.

## 0.26.x - August 2026

- Added editor-tab chats for working with sessions side by side, with terminal access and synchronized model, reasoning, permission, queue, and session state across Varro views.
- Added quick controls for new chats and inline file changes, plus status-bar indicators for the active OpenCode version and available updates.
- Improved messages with secure Markdown, external and mixed-content images, expandable long content, copyable final responses, code-block truncation, and more reliable editing and rendering.
- Made model catalogs easier to manage with search, selective additions and hiding, persistent session defaults, clearer model and thinking changes, cost warnings, provider usage limits, and expanded thinking during active turns.
- Improved the composer and Ralph workflows with language server output, persistent diff previews, steadier editing, clearer progress, and more reliable slash commands and review prompts.
- Strengthened session, queue, and multi-view handling across editor context, model choices, permissions, attachments, manual steering, reconnects, forks, deletions, and provider or MCP refreshes.
- Stabilized long conversations during history loading, streaming, content reflow, resizing, and queued-message removal, with activity shown in jump-to-latest navigation.
- Refined tool cards and chat presentation with consistent spacing, contrast, configurable typography, and full descriptions for agents and other truncated details.
- Moved About diagnostics and usage reports into readable Markdown documents with richer local usage data.

## 0.25.x - August 2026

- Added an Auto accept edits permission mode that approves file changes while continuing to ask before other tool actions.
- Improved commit message generation with richer working-tree and repository-history context, support for unstaged changes, stronger validation, and safer handling of existing Source Control input.
- Added automatic retries for sessions interrupted by transient connection failures.
- Preserved chat content, loaded history, context, and scroll position more reliably across session activity, updates, and reopened conversations.
- Improved slash-command completion behavior, including direct execution of `/stats` from the completion menu and stable suggestions while editing trigger text.
- Improved composer editing around file and context chips, including atomic deletion, reliable inline image pasting, and preserved active-file context in queued messages.
- Added safer handling and warnings for generated dependency trees and very large changes across prompts, summaries, and changed-file views.
- Improved file and repository references in messages with compact type icons, line-aware links, clickable SSH Git remotes, and more reliable opening of uniquely matched workspace and local files.
- Improved guidance and accessibility across chat controls with consistent tooltips, clearer labels, and keyboard-accessible terminal previews.

## 0.24.x - August 2026

- Streamlined long conversations with compact activity summaries, clearer progress, turn navigation, response forking, and more reliable history and scrolling.
- Added Mermaid diagrams, native PDF attachments, session references, richer context previews, and automatic vision delegation for image prompts.
- Improved model selection and cost control with prioritized and pinned models, custom names, session costs, provider quotas, and helper-model assignments.
- Added in-workbench provider and MCP connection management with API-key and OAuth flows, expired-credential recovery, and refreshes that wait for active work.
- Strengthened permissions with clearer requests, reliable tool matching and child-session inheritance, safer local decisions, and preserved rejected commands.
- Made message edits, queued prompts, session switching, and image attachments more reliable and recoverable.

## 0.23.x - July-August 2026

- Added scalable session history with pagination, archived-session loading, and native search across older work.
- Added `Open in OpenCode`, pausable queued prompts, and improved model and MCP controls.
- Added live terminal output and compact summaries for routine tool activity.
- Added staged-change commit message generation, usage reports, and persistent composer drafts.
- Improved compatibility with VS Code variants, accessibility, and large-conversation reliability.

## 0.22.x - July 2026

- Added inline file-edit previews, full diff views, and changed-file review workflows.
- Added an active-chat header with session details, sharing controls, and clearer navigation.
- Expanded light, dark, flat, and high-contrast theme support.
- Added guided OpenCode installation and upgrade flows, plus provider authentication recovery and logout.
- Improved session loading, MCP controls, context handling, image handling, and interactive questions.

## 0.21.x - July 2026

- Refined the product identity as Varro, the OpenCode workbench for VS Code.
- Made automatic permission handling the default for a faster first-run workflow.
- Added individual message deletion and improved session navigation.
- Improved todo scrolling and long-transcript readability.

## 0.20.x - July 2026

- Added session pinning, renaming, search, history navigation, and previous/next commands.
- Added editing, reordering, and stronger recovery controls for queued prompts.
- Added commands to open and initialize global and project `AGENTS.md` instructions.
- Improved model discovery with filtering, release information, and clearer server diagnostics.
- Improved todo progress, permission prompts, and Windows and provider recovery.

## 0.19.x - June-July 2026

- Added watchdog and event-stream recovery so stalled or disconnected sessions can recover automatically.
- Added sub-agent navigation and visibility into child-session activity.
- Added session forking and more reliable history and streaming reconciliation.
- Expanded token, usage, file-change, and MCP visibility.
- Added OpenCode compatibility checks and more reliable workspace and session resolution.

## 0.18.x - June 2026

- Migrated to OpenCode's v2 event stream for continued platform compatibility.
- Updated permission, question, and steering workflows for the v2 API.
- Added a changed-files panel with session-level change summaries.
- Added direct file opening at relevant lines and a Varro About command.

## 0.17.x - May-June 2026

- Added safer OpenCode CLI upgrades, explicit session error notifications, and provider authentication recovery.
- Introduced configurable Default, Auto approve, and Full access permission modes.
- Improved incremental streaming and recovery for sessions and sub-agents.
- Added composer undo and redo, prompt history, and message editing.
- Improved cost, timing, clipboard, path, and error presentation throughout the workbench.

## 0.16.x - May 2026

- Introduced a richer composer with inline file mentions and ordered paste and drop attachments.
- Added a dedicated model and provider management experience with persistent reasoning variants.
- Added background OpenCode CLI updates and stronger Windows and multi-workspace support.
- Remembered the last-opened view and improved long-conversation auto-scrolling.
- Improved session compaction and recovery from pending permission requests.

## 0.15.x - May 2026

- Integrated permission and question requests directly into tool activity cards.
- Improved streaming and scrolling performance for long conversations.
- Made provider-limit indicators, popups, and skill commands more responsive.
- Reduced disruption from workspace file-index refreshes.

## 0.14.x - May 2026

- Expanded provider quota reporting with multiple provider adapters and configurable limit displays.
- Added the ability to resume incomplete Ralph automation runs.
- Preserved queued attachments in the intended order and synchronized todos from plans.
- Improved permanent deletion, empty-session cleanup, and Windows workspace behavior.

> Varro did not use a `0.13.x` version line.

## 0.12.x - May 2026

- Introduced Ralph, an iterative plan-execution workflow with a setup form and progress dashboard.
- Added iteration controls and persisted automation state for longer-running work.
- Improved session and todo synchronization across reloads.
- Expanded syntax highlighting and file-change presentation.

## 0.11.x - April 2026

- Added virtualized rendering so long conversations remain responsive.
- Improved streaming and partial-message handling for more reliable live output.
- Strengthened session synchronization and persistence.
- Expanded code-language highlighting and external-link handling.

## 0.10.x - April 2026

- Added OpenCode configuration management inside the workbench.
- Improved nested-session and recycle-bin management.
- Added navigable image previews and syntax-highlighted code blocks.
- Accelerated workspace file search with caching and change tracking.
- Added automatic session compaction to keep long-running conversations productive.

## 0.9.x - April 2026

- Added status-bar access to sessions that need attention.
- Added reliable replay of pending permission and question requests.
- Introduced a recycle bin with restore and permanent-delete workflows.
- Added session export and improved support for sub-agent questions and permissions.
- Added structured tool cards for clearer task activity.

## 0.8.x - April 2026

- Added MCP server management from the Varro interface.
- Strengthened event-stream processing and extension message validation.
- Improved clipboard handling and OpenCode server startup reliability.
- Made terminal commands, tool output, and provider notifications easier to understand.

## 0.7.x - April 2026

- Added configurable thinking visibility and desktop session-pane placement.
- Added retry support for failed assistant responses.
- Improved session preferences and background server maintenance.

## 0.6.x - April 2026

- Made timed OpenCode server restarts safer and more predictable.
- Improved hierarchical session indexing for more reliable session lists.

## 0.5.x - April 2026

- Improved OpenCode server connection and status management.
- Made session grouping and selection clearer and faster.
- Added pre-send session checks to avoid acting on stale session state.

## 0.4.x - April 2026

- Added recognition of provider usage-limit failures.
- Improved error reporting with clearer, more actionable feedback.

## 0.3.x - April 2026

- Improved context-file selection, merging, and per-session project context.
- Added plan handling with actionable assistant summaries.
- Improved assistant failure reporting and message presentation.

## 0.2.x - April 2026

- Added provider quota and usage-limit visibility.
- Improved model capability awareness and clipboard-image handling.

## 0.1.x - April 2026

- Launched the Varro VS Code workbench with project-aware OpenCode chat and streaming tool activity.
- Added model, provider, reasoning, and permission controls.
- Added editor, terminal, file, folder, image, and selection context.
- Added parallel session management, queued messages, compaction, questions, and approval workflows.
- Established Varro as the product identity for the integrated OpenCode experience.
