import * as vscode from "vscode"
import { readFileSync } from "fs"
import { resolve, join } from "path"
import type { ExtensionMessage, WebviewMessage } from "../shared/protocol"
import { ContextProvider } from "./context-provider"
import { logger } from "./logger"

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencode.chat"
  private view?: vscode.WebviewView
  private contextProvider: ContextProvider
  private _serverUrl = ""
  private _proxyUrl = ""
  private _theme: "dark" | "light" =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? "dark" : "light"

  constructor(
    private readonly extensionUri: vscode.Uri,
    contextProvider: ContextProvider,
  ) {
    this.contextProvider = contextProvider
  }

  set serverUrl(url: string) {
    if (this._serverUrl === url) return
    this._serverUrl = url
    this.refreshHtml()
  }

  set proxyUrl(url: string) {
    this._proxyUrl = url
  }

  private refreshHtml() {
    if (this.view) {
      this.view.webview.html = this.getHtml()
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
      enableCommandUris: true,
    }

    webviewView.webview.html = this.getHtml()

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.handleMessage(msg)
    })

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postContext()
      }
    })
  }

  handleMessage(msg: WebviewMessage) {
    switch (msg.type) {
      case "ready":
        this.postContext()
        break
      case "context/request":
        this.postContext()
        break
      case "file/read":
        this.contextProvider.readFile(msg.payload.path).then(() => {
          this.postContext()
        })
        break
      case "vscode/open":
        this.contextProvider.openFile(msg.payload.path, msg.payload.line)
        break
      case "vscode/diff":
        vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.parse(`opencode-diff://${msg.payload.path}/before`),
          vscode.Uri.parse(`opencode-diff://${msg.payload.path}/after`),
          `OpenCode: ${msg.payload.path}`,
        )
        break
      case "api/request":
        this.handleApiRequest(msg.payload)
        break
      case "log":
        logger.info(`[webview-debug] ${msg.payload.msg} ${msg.payload.data || ""} ${msg.payload.error || ""}`)
        break
    }
  }

  private async handleApiRequest(payload: { id: number; method: string; path: string; body?: unknown }) {
    const baseUrl = this._serverUrl || this._proxyUrl
    if (!baseUrl) {
      this.post({ type: "api/response", payload: { id: payload.id, error: "Server not connected" } })
      return
    }
    try {
      const url = `${baseUrl}${payload.path}`
      const init: RequestInit = {
        method: payload.method,
        headers: { "Content-Type": "application/json" },
      }
      if (payload.body && payload.method !== "GET" && payload.method !== "HEAD") {
        init.body = JSON.stringify(payload.body)
      }
      const res = await fetch(url, init)
      if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`)
      }
      const data = await res.json()
      this.post({ type: "api/response", payload: { id: payload.id, data } })
    } catch (err) {
      this.post({
        type: "api/response",
        payload: { id: payload.id, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  post(msg: ExtensionMessage) {
    this.view?.webview.postMessage(msg)
  }

  private postContext() {
    this.post({ type: "context/update", payload: this.contextProvider.context })
  }

  postDroppedFiles(
    files: Array<{ path: string; relativePath: string; type: "file" | "directory" }>,
  ) {
    this.post({ type: "files/dropped", payload: files })
  }

  postServerStatus(status: ExtensionMessage) {
    this.post(status)
  }

  private getHtml(): string {
    const distDir = resolve(this.extensionUri.fsPath, "dist", "webview")
    let scriptContent = ""
    let cssContent = ""

    try {
      scriptContent = readFileSync(join(distDir, "webview.js"), "utf-8")
    } catch {
      logger.warn("webview.js not found - run `npm run build:webview` first")
    }
    try {
      cssContent = readFileSync(join(distDir, "webview.css"), "utf-8")
    } catch {}

    this._theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? "dark"
        : "light"

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src http://127.0.0.1:* http://localhost:*;" />
  <title>OpenCode</title>
  <style>${cssContent}</style>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__initData = ${JSON.stringify({
      serverUrl: this._serverUrl,
      eventStreamUrl: this._proxyUrl,
      theme: this._theme,
    })};
  </script>
  <script>
    const vscode = acquireVsCodeApi();
    window.__sendToExtension = function(msg) { vscode.postMessage(msg); };
  </script>
  <script>${scriptContent}</script>
</body>
</html>`
  }
}
