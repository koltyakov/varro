# Changelog

This changelog summarizes the main user-facing improvements in each Varro minor release line. Patch releases are consolidated into their parent minor version. Dates reflect the development history.

## 0.24.x - August 2026

- Made compact tool activity the only view, removed its obsolete setting, and added clearer live progress and responsive expandable summaries.
- Made thinking blocks start collapsed and removed the obsolete default-expansion setting.
- Made active-file and editor-selection context automatic and removed their obsolete settings.
- Made provider-limit polling and display unconditional and removed their obsolete settings.
- Added reported session cost to context details and identified fast models as more expensive.
- Made provider and authentication changes non-disruptive by applying queued refreshes after active work finishes and showing pending status.
- Improved long-conversation scrolling, history loading, sticky prompt navigation, read mode, and session switching.
- Improved active-session deletion, first-run sidebar reveal, model-management discovery, markdown readability, and rejected image-paste feedback.

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
