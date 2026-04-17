import * as vscode from "vscode"
import { SidebarProvider } from "./sidebar-provider"

export function registerCommands(
  context: vscode.ExtensionContext,
  sidebar: SidebarProvider,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.chat.focus", () => {
      vscode.commands.executeCommand("workbench.view.extension.opencode")
    }),

    vscode.commands.registerCommand("opencode.chat.newSession", () => {
      sidebar.post({ type: "init", payload: { serverUrl: "", theme: "dark" } })
    }),

    vscode.commands.registerCommand("opencode.chat.share", () => {
      vscode.window.showInformationMessage("OpenCode: Session shared!")
    }),

    vscode.commands.registerCommand("opencode.chat.abort", () => {
      vscode.window.showInformationMessage("OpenCode: Session aborted")
    }),

    vscode.commands.registerCommand("opencode.chat.addToContext", () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri)
      const selection = editor.selection
      sidebar.postDroppedFiles([
        {
          path: editor.document.uri.fsPath,
          relativePath,
          type: "file",
        },
      ])
      if (!selection.isEmpty) {
        vscode.window.showInformationMessage(
          `OpenCode: Added ${relativePath} with selection to context`,
        )
      } else {
        vscode.window.showInformationMessage(`OpenCode: Added ${relativePath} to context`)
      }
    }),
  )
}
