import * as vscode from "vscode"
import type { SidebarProvider } from "./sidebar-provider"

export function registerCommands(
  context: vscode.ExtensionContext,
  sidebar: SidebarProvider,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.chat.focus", () => {
      vscode.commands.executeCommand("workbench.view.extension.opencode")
    }),

    vscode.commands.registerCommand("opencode.chat.newSession", () => {
      sidebar.postCommand("new-session")
    }),

    vscode.commands.registerCommand("opencode.chat.share", () => {
      sidebar.postCommand("share")
    }),

    vscode.commands.registerCommand("opencode.chat.abort", () => {
      sidebar.postCommand("abort")
    }),

    vscode.commands.registerCommand("opencode.chat.addToContext", () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri)
      sidebar.postDroppedFiles([
        {
          path: editor.document.uri.fsPath,
          relativePath,
          type: "file",
        },
      ])
      vscode.commands.executeCommand("workbench.view.extension.opencode")
    }),
  )
}
