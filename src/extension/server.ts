import { ChildProcess, spawn } from "child_process"
import { delimiter, join } from "path"
import { existsSync } from "fs"
import { logger } from "./logger"
import { EventEmitter } from "events"
import type { ServerStatus } from "../shared/protocol"

export class OpenCodeServer extends EventEmitter {
  private process: ChildProcess | null = null
  private _status: ServerStatus = { state: "stopped" }
  private port: number
  private retries = 0
  private maxRetries = 3
  private autoStart: boolean
  private command: string
  private eventController: AbortController | null = null
  private eventReconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(port: number, autoStart: boolean, command?: string) {
    super()
    this.port = port
    this.autoStart = autoStart
    this.command = command?.trim() || ""
  }

  get status(): ServerStatus {
    return this._status
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private setStatus(s: ServerStatus) {
    this._status = s
    this.emit("status", s)
  }

  async start(): Promise<string> {
    const healthy = await this.checkHealth()
    if (healthy) {
      logger.info(`Found existing OpenCode server at ${this.url}`)
      this.setStatus({ state: "running", url: this.url })
      this.startEventStream()
      return this.url
    }

    if (!this.autoStart) {
      this.setStatus({
        state: "error",
        message: `No server at ${this.url}. Start one with "opencode serve --port ${this.port}" or enable opencode.server.autoStart.`,
      })
      throw new Error(this._status.state === "error" ? (this._status as any).message : "server not running")
    }

    return new Promise((resolve, reject) => {
      this.setStatus({ state: "starting" })

      try {
        const command = this.resolveCommand()
        logger.info(`Starting OpenCode server with command: ${command}`)

        this.process = spawn(command, ["serve", "--port", String(this.port)], {
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
          env: this.buildServerEnv(),
        })

        this.process.stdout?.on("data", (data: Buffer) => {
          logger.info(`[server] ${data.toString().trim()}`)
        })

        this.process.stderr?.on("data", (data: Buffer) => {
          logger.error(`[server] ${data.toString().trim()}`)
        })

        this.process.on("exit", (code) => {
          logger.info(`Server process exited with code ${code}`)
          this.stopEventStream()
          if (this._status.state === "running") {
            this.setStatus({ state: "stopped" })
            if (this.retries < this.maxRetries) {
              this.retries++
              logger.info(`Restarting server (attempt ${this.retries})`)
              this.start().then(resolve).catch(reject)
            }
          }
        })

        this.process.on("error", (err) => {
          logger.error(`Server process error: ${err.message}`)
          if (err.message.includes("ENOENT")) {
            this.setStatus({
              state: "error",
              message: "OpenCode CLI not found. Install it with: npm install -g opencode-ai",
            })
            reject(new Error((this._status as any).message))
            return
          }
        })
      } catch (err) {
        this.setStatus({ state: "error", message: String(err) })
        reject(err)
        return
      }

      this.pollHealth(resolve, reject)
    })
  }

  private pollHealth(
    resolve: (url: string) => void,
    reject: (err: Error) => void,
    attempt = 0,
  ) {
    if (attempt > 50) {
      this.setStatus({ state: "error", message: "Server failed to start within timeout" })
      reject(new Error("Server health check timeout"))
      return
    }

    setTimeout(async () => {
      const healthy = await this.checkHealth()
      if (healthy) {
        this.setStatus({ state: "running", url: this.url })
        this.retries = 0
        this.startEventStream()
        resolve(this.url)
      } else {
        this.pollHealth(resolve, reject, attempt + 1)
      }
    }, 200)
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/global/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!res.ok) return false
      const data = (await res.json()) as { healthy?: boolean }
      return data.healthy === true
    } catch {
      return false
    }
  }

  async request(method: string, path: string, body?: unknown): Promise<any> {
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    }
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      init.body = JSON.stringify(body)
    }
    const res = await fetch(`${this.url}${path}`, init)
    const text = await res.text()
    let data: any = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {}
    if (!res.ok) {
      const msg = typeof data === "object" && data && "message" in data ? data.message : res.statusText
      throw new Error(`${res.status} ${msg}`)
    }
    return data
  }

  private async startEventStream() {
    this.stopEventStream()
    this.eventController = new AbortController()
    const controller = this.eventController
    let shouldReconnect = false

    try {
      const res = await fetch(`${this.url}/event`, {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      })
      if (!res.ok || !res.body) throw new Error(`Failed to open event stream: ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          logger.warn("Event stream closed; reconnecting")
          shouldReconnect = true
          break
        }
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          this.processSseChunk(chunk)
        }
      }
    } catch (err: any) {
      if (controller.signal.aborted) return
      logger.warn(`Event stream error: ${err?.message || err}`)
      shouldReconnect = true
    } finally {
      if (shouldReconnect && !controller.signal.aborted && this._status.state === "running") {
        this.eventReconnectTimer = setTimeout(() => this.startEventStream(), 1000)
      }
    }
  }

  private processSseChunk(chunk: string) {
    let dataLines: string[] = []
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) return
    const data = dataLines.join("\n")
    try {
      const parsed = JSON.parse(data)
      this.emit("event", parsed)
    } catch {
      // ignore
    }
  }

  private stopEventStream() {
    if (this.eventReconnectTimer) {
      clearTimeout(this.eventReconnectTimer)
      this.eventReconnectTimer = null
    }
    if (this.eventController) {
      this.eventController.abort()
      this.eventController = null
    }
  }

  async dispose() {
    this.stopEventStream()
    this.process?.kill("SIGTERM")
    this.process = null
    this.setStatus({ state: "stopped" })
  }

  private resolveCommand(): string {
    if (this.command) return this.command

    const candidates =
      process.platform === "win32"
        ? ["opencode.exe", "opencode.cmd", "opencode.bat"]
        : ["opencode"]

    for (const dir of this.serverPathEntries()) {
      for (const candidate of candidates) {
        const fullPath = join(dir, candidate)
        if (existsSync(fullPath)) return fullPath
      }
    }

    return process.platform === "win32" ? "opencode.cmd" : "opencode"
  }

  private buildServerEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: this.serverPathEntries().join(delimiter),
    }
  }

  private serverPathEntries(): string[] {
    const home = process.env.HOME
    const pathEntries = (process.env.PATH || "")
      .split(delimiter)
      .filter(Boolean)
    const extras =
      process.platform === "win32"
        ? []
        : [
            ...(home ? [join(home, ".opencode", "bin")] : []),
            ...(home ? [join(home, ".npm-global", "bin")] : []),
            ...(home ? [join(home, ".local", "bin")] : []),
            ...(home ? [join(home, ".bun", "bin")] : []),
            ...(home ? [join(home, "Library", "pnpm")] : []),
            "/opt/homebrew/bin",
            "/usr/local/bin",
          ]

    return [...new Set([...pathEntries, ...extras].filter(Boolean))]
  }
}
