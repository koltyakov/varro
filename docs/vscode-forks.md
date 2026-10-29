# VS Code Fork Compatibility

VS Code and VSCodium are the target containers for Varro.

Other VS Code forks are technically compatible when they preserve the VS Code extension APIs and user-interface behavior that Varro relies on. Compatibility with forks is limited and may change as those products evolve.

## Cursor, Windsurf, Devin, and Trae

Cursor, Windsurf, Devin, Trae, and Trae CN have limited support. These AI-focused forks may reserve chat surfaces for their own agents or hide third-party chat-agent extensions. On a new installation, Varro attempts a one-time move to their Primary Side Bar. Existing working placements are preserved. If the saved view cannot be revealed, Varro's navigation commands attempt to recover it in the Primary Side Bar, even after an earlier migration. Full integration is not guaranteed.

VS Code and VSCodium register Varro directly in the Secondary Side Bar. Opening or focusing Varro follows its saved location rather than moving it back to the default.

### Registration and Explorer fallback repair

The manifest declares the `varro` container in `secondarySidebar` first, then declares
the same container ID in `activitybar` as a fallback. Keep this property order. The
editor's `ViewsExtensionHandler.registerCustomViewContainer` reuses an already
registered container, so the first accepted declaration determines its location.
VS Code accepts Secondary; Cursor rejects Secondary and accepts the Primary fallback.
The separate `varro-primary` container remains available for existing saved placements
and navigation recovery. Cursor can still log its Secondary rejection, but should no
longer report that `varro` is missing or that its views will be added to Explorer.

This also repairs upgrades from a rejected Secondary registration without forcing a
view move. The editor previously registered the chat in Explorer because `varro` did
not exist. That automatic default has no saved view-location override. Once `varro`
exists, registration restores its default, while the editor retains explicit saved
placements in Explorer, the panel, another container, or a relocated Varro container.
Visibility and Varro's old migration markers cannot distinguish these cases and must
not be used to force an Explorer repair. No layout storage is read or rewritten by Varro.

Editor containers and the chat view use `assets/workbench-icon.svg`, a square monochrome
glyph with small gaps between its nodes and connectors for 16px and 24px masks.
An SVG media query selects a compact 16px-grid drawing with full-pixel gaps at the
smallest size, while retaining the regular drawing at 24px.
The editor colors the mask, so separate theme-colored SVGs are unnecessary.
Cursor's horizontal activity bar uses 16px; its vertical bar uses 24px.
Keep the larger color `assets/icon.png`
for marketplace and in-chat branding, not editor chrome.

If the host does not expose the required view-moving command or the migration fails:

1. Open the Command Palette with `Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows and Linux, enter `Varro: New Session`, and press `Enter`.
2. Once Varro is visible, move it to the Primary Side Bar so it remains accessible.
