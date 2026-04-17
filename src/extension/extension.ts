import * as vscode from "vscode"
import { OpenCodeServer } from "./server"
import { SidebarProvider } from "./sidebar-provider"
import { ContextProvider } from "./context-provider"
import { registerCommands } from "./commands"
import { logger } from "./logger"

let server: OpenCodeServer
let contextProvider: ContextProvider
let sidebarProvider: SidebarProvider

export async function activate(context: vscode.ExtensionContext) {
  logger.info("Activating OpenCode extension")

  const config = vscode.workspace.getConfiguration("opencode")
  const port = config.get<number>("server.port", 4096)
  const autoStart = config.get<boolean>("server.autoStart", true)

  server = new OpenCodeServer(port)
  contextProvider = new ContextProvider((ctx) => {
    sidebarProvider?.post({ type: "context/update", payload: ctx })
  })

  sidebarProvider = new SidebarProvider(context.extensionUri, contextProvider)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  )

  server.on("connected", () => {
    logger.info(`Setting server URL: ${server.url}, proxy URL: ${server.proxyUrl}`)
    sidebarProvider.serverUrl = server.url
    sidebarProvider.proxyUrl = server.proxyUrl
  })

  registerCommands(context, sidebarProvider)

  vscode.commands.executeCommand("setContext", "opencode:activated", true)
  logger.info("OpenCode extension activated")

  if (autoStart) {
    server.start().then((url) => {
      logger.info(`OpenCode server started at ${url}`)
    }).catch((err) => {
      logger.error("Failed to start OpenCode server:", err)
      vscode.window.showErrorMessage(
        `OpenCode: Failed to start server. ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }
}

export async function deactivate() {
  await server?.dispose()
  contextProvider?.dispose()
  vscode.commands.executeCommand("setContext", "opencode:activated", false)
  logger.info("OpenCode extension deactivated")
}
