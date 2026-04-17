import { ChildProcess, spawn } from "child_process"
import { createServer, IncomingMessage, ServerResponse } from "http"
import { logger } from "./logger"
import { EventEmitter } from "events"
import type { ServerStatus } from "../shared/protocol"

export class OpenCodeServer extends EventEmitter {
  private process: ChildProcess | null = null
  private _status: ServerStatus = { state: "stopped" }
  private port: number
  private proxyPort: number
  private proxyServer: ReturnType<typeof createServer> | null = null
  private retries = 0
  private maxRetries = 3

  constructor(port: number) {
    super()
    this.port = port
    this.proxyPort = port + 1
  }

  get status(): ServerStatus {
    return this._status
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get proxyUrl(): string {
    return `http://127.0.0.1:${this.proxyPort}`
  }

  async start(): Promise<string> {
    const healthy = await this.checkHealth()
    if (healthy) {
      logger.info(`Found existing OpenCode server at ${this.url}`)
      this._status = { state: "running", url: this.url }
      await this.startProxy()
      this.emit("connected")
      return this.url
    }

    return new Promise((resolve, reject) => {
      this._status = { state: "starting" }
      this.emit("status", this._status)

      try {
        this.process = spawn("opencode", ["serve", "--port", String(this.port)], {
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        })

        this.process.stdout?.on("data", (data: Buffer) => {
          logger.info(`[server] ${data.toString().trim()}`)
        })

        this.process.stderr?.on("data", (data: Buffer) => {
          logger.error(`[server] ${data.toString().trim()}`)
        })

        this.process.on("exit", (code) => {
          logger.info(`Server process exited with code ${code}`)
          if (this._status.state === "running") {
            this._status = { state: "stopped" }
            this.emit("status", this._status)
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
            this._status = {
              state: "error",
              message: "OpenCode CLI not found. Install it with: npm install -g opencode-ai",
            }
            this.emit("status", this._status)
            reject(new Error(this._status.message))
            return
          }
        })
      } catch (err) {
        this._status = { state: "error", message: String(err) }
        this.emit("status", this._status)
        reject(err)
        return
      }

      this.pollHealth(resolve, reject)
    })
  }

  private async startProxy(): Promise<void> {
    if (this.proxyServer) return

    const targetPort = this.port
    const targetHost = "127.0.0.1"

    this.proxyServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "Content-Type")
      res.setHeader("Access-Control-Max-Age", "86400")

      if (req.method === "OPTIONS") {
        res.writeHead(204)
        res.end()
        return
      }

      const proxyReq = `http://${targetHost}:${targetPort}${req.url}`
      const init: RequestInit = {
        method: req.method,
        headers: Object.entries(req.headers)
          .filter(([k]) => k !== "host" && k !== "origin" && k !== "referer")
          .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}),
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => {
          init.body = Buffer.concat(chunks)
          forwardRequest(proxyReq, init, res)
        })
      } else {
        forwardRequest(proxyReq, init, res)
      }
    })

    return new Promise((resolve) => {
      this.proxyServer!.listen(this.proxyPort, () => {
        logger.info(`CORS proxy started on port ${this.proxyPort}`)
        resolve()
      })
    })
  }

  private pollHealth(
    resolve: (url: string) => void,
    reject: (err: Error) => void,
    attempt = 0,
  ) {
    if (attempt > 50) {
      this._status = { state: "error", message: "Server failed to start within timeout" }
      this.emit("status", this._status)
      reject(new Error("Server health check timeout"))
      return
    }

    setTimeout(async () => {
      const healthy = await this.checkHealth()
      if (healthy) {
        this._status = { state: "running", url: this.url }
        this.retries = 0
        await this.startProxy()
        this.emit("connected")
        resolve(this.url)
      } else {
        this.pollHealth(resolve, reject, attempt + 1)
      }
    }, 200)
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/global/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!res.ok) return false
      const data = (await res.json()) as { healthy?: boolean }
      return data.healthy === true
    } catch {
      return false
    }
  }

  async dispose() {
    this.proxyServer?.close()
    this.proxyServer = null
    this.process?.kill("SIGTERM")
    this.process = null
    this._status = { state: "stopped" }
    this.emit("status", this._status)
  }
}

async function forwardRequest(url: string, init: RequestInit, res: ServerResponse) {
  try {
    const upstream = await fetch(url, init)
    const body = await upstream.arrayBuffer()
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()))
    res.end(Buffer.from(body))
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
}
