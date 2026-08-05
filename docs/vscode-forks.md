# VS Code Fork Compatibility

VS Code and VSCodium are the target containers for Varro.

Other VS Code forks are technically compatible when they preserve the VS Code extension APIs and user-interface behavior that Varro relies on. Compatibility with forks is limited and may change as those products evolve.

## Cursor, Windsurf, And Devin

Cursor, Windsurf, and Devin have limited support. These AI-focused forks may reserve chat surfaces for their own agents or hide third-party chat-agent extensions. Varro attempts a one-time automatic move to their Primary Side Bar, but full integration is not guaranteed.

If the host does not expose the required view-moving command or the migration fails:

1. Open the Command Palette with `Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows and Linux, enter `Varro: New Session`, and press `Enter`.
2. Once Varro is visible, move it to the Primary Side Bar so it remains accessible.
