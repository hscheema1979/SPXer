// FR-003 backtest-lab service — node stdlib HTTP over the engines in this dir.
//
// Deploy (PM2, same shape as the other ecosystem entries):
//   pm2 start scripts/backtest-lab/server.ts --name backtest-lab \
//     --interpreter npx --interpreter-arg tsx
//   (add to ecosystem.config.js: same shape as other entries)
// PORT: env LAB_PORT (default 3702). Binds 127.0.0.1 — the studio proxies
// /spxer/backtest-lab/api/* to it, so no CORS surface is needed.
//
// Routes (all JSON):
//   GET  /api/health
//   GET  /api/capabilities
//   GET  /api/coverage?profileId=
//   GET  /api/jobs?limit=50
//   GET  /api/jobs/:id          (includes the log tail)
//   POST /api/jobs/:id/cancel
//   POST /api/run               {spec}  → validates, upserts the spec, queues
//   POST /api/specs             {spec}
//   GET  /api/specs
//   DEL  /api/specs/:id
//   GET  /api/results/:jobId
import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { URL } from "node:url"
import {
  validateSpec,
  type BacktestSpec,
  type EngineCapabilities,
  type ProfileCoverage,
} from "./contract.ts"
import { SPXER_ROOT, buildCapabilities, coverageFor, optionSourceFor } from "./capabilities.ts"
import { initJobs, enqueueJob, listJobs, getJob, cancelJob, jobResultPayload } from "./jobs.ts"
import { listSpecs, upsertSpec, deleteSpec } from "./specs.ts"

const PORT = Number.parseInt(process.env.LAB_PORT ?? "3702", 10)
const HOST = "127.0.0.1"
const BODY_CAP_BYTES = 1024 * 1024
const BOOTED_AT = Date.now()

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    let overflow = false
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => {
      size += c.length
      if (size > BODY_CAP_BYTES) {
        // Keep draining (dropping bytes) so the client can still read the 413
        // instead of getting a reset socket.
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      if (overflow) {
        reject(Object.assign(new Error("request body exceeds 1MB"), { status: 413 }))
        return
      }
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", reject)
  })
}

function parseJsonBody(raw: string): { ok: true; value: any } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: false, error: "empty JSON body" }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (err) {
    return { ok: false, error: `invalid JSON body: ${(err as Error).message}` }
  }
}

// ── Route handlers ──────────────────────────────────────────────────────────

let capsCache: EngineCapabilities | undefined

/** Capabilities are disk-derived; cache briefly so a UI refresh storm is cheap. */
function capabilities(): EngineCapabilities {
  if (!capsCache) capsCache = buildCapabilities()
  return capsCache
}

function coverageOr404(profileId: string): ProfileCoverage | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(profileId)) return undefined
  const cov = coverageFor(profileId)
  if (!cov) return undefined
  // Directory names alone cannot name the instrument — take symbol/dte from the
  // registry row or the BASES 0DTE fast path.
  const source = optionSourceFor(profileId)
  return source ? { ...cov, symbol: source.symbol, dte: source.dte } : cov
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  const p = url.pathname
  const method = (req.method ?? "GET").toUpperCase()

  // ── health ────────────────────────────────────────────────────────────────
  if (p === "/api/health" && method === "GET") {
    return sendJson(res, 200, { ok: true, uptimeSec: Math.floor((Date.now() - BOOTED_AT) / 1000) })
  }

  // ── capabilities / coverage ─────────────── (disk reads, no auth surface)
  if (p === "/api/capabilities" && method === "GET") {
    return sendJson(res, 200, capabilities())
  }
  if (p === "/api/coverage" && method === "GET") {
    const profileId = url.searchParams.get("profileId") ?? ""
    const cov = coverageOr404(profileId)
    if (!cov) return sendJson(res, 404, { error: `no coverage for profileId: ${profileId}` })
    return sendJson(res, 200, cov)
  }

  // ── jobs ─────────────────────────────────────────────────────────────────
  if (p === "/api/jobs" && method === "GET") {
    const limitRaw = url.searchParams.get("limit")
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50
    const jobs = listJobs(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50)
    return sendJson(res, 200, { jobs })
  }

  // GET /api/jobs/:id (includes the log tail) — covers /api/jobs/:id/cancel for POST only.
  const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(p)
  if (jobMatch && method === "GET") {
    const job = getJob(decodeURIComponent(jobMatch[1]))
    if (!job) return sendJson(res, 404, { error: `unknown job: ${jobMatch[1]}` })
    return sendJson(res, 200, job)
  }

  const cancelMatch = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(p)
  if (cancelMatch && method === "POST") {
    const job = cancelJob(decodeURIComponent(cancelMatch[1]))
    if (!job) return sendJson(res, 404, { error: `unknown job: ${cancelMatch[1]}` })
    return sendJson(res, 200, { jobId: job.jobId, status: job.status })
  }

  // ── run (validate → upsert spec → queue) ────────────────────────────────
  if (p === "/api/run" && method === "POST") {
    const body = parseJsonBody(await readBody(req))
    if (!body.ok) return sendJson(res, (body as any).status ?? 400, { error: body.error })
    // Accept both the UI's `{ spec }` wrapper and a bare spec — the FR-003
    // spec's frozen CHECK posts the fixture file directly.
    const v = body.value as { spec?: BacktestSpec; type?: string; underlying?: unknown }
    const spec = v.spec ?? (("type" in v && "underlying" in v ? (v as BacktestSpec) : undefined))
    if (!spec) return sendJson(res, 400, { error: "body must be { spec: BacktestSpec } or a bare spec" })
    const verdict = validateSpec(spec, capabilities())
    if (!verdict.ok) return sendJson(res, 422, { errors: verdict.errors })
    upsertSpec(spec) // the library always holds what was run
    const { jobId } = enqueueJob(spec)
    return sendJson(res, 200, { jobId })
  }

  // ── specs library ─────────────────────────────────────────────────────────
  if (p === "/api/specs" && method === "GET") {
    return sendJson(res, 200, { specs: listSpecs() })
  }
  if (p === "/api/specs" && method === "POST") {
    const body = parseJsonBody(await readBody(req))
    if (!body.ok) return sendJson(res, (body as any).status ?? 400, { error: body.error })
    const spec = (body.value as { spec?: BacktestSpec }).spec
    if (!spec) return sendJson(res, 400, { error: "body must be { spec: BacktestSpec }" })
    const verdict = validateSpec(spec, capabilities())
    if (!verdict.ok) return sendJson(res, 422, { errors: verdict.errors })
    return sendJson(res, 200, { spec: upsertSpec(spec) })
  }
  const specDel = /^\/api\/specs\/([^/]+)$/.exec(p)
  if (specDel && method === "DELETE") {
    const ok = deleteSpec(decodeURIComponent(specDel[1]))
    if (!ok) return sendJson(res, 404, { error: `unknown spec: ${specDel[1]}` })
    return sendJson(res, 200, { ok: true })
  }

  // ── results ───────────────────────────────────────────────────────────────
  const resultMatch = /^\/api\/results\/([^/]+)$/.exec(p)
  if (resultMatch && method === "GET") {
    const payload = jobResultPayload(decodeURIComponent(resultMatch[1]))
    if (!payload) return sendJson(res, 404, { error: `unknown job: ${resultMatch[1]}` })
    return sendJson(res, 200, payload)
  }

  return sendJson(res, 404, { error: `no such endpoint: ${method} ${p}` })
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handle(req, res).catch((err: any) => {
    const status = Number.isFinite(err?.status) ? err.status : 500
    console.error("[backtest-lab]", req.method, req.url, "->", status, err?.message)
    if (!res.headersSent) sendJson(res, status, { error: err?.message ?? "internal error" })
    else res.end()
  })
})

initJobs()

server.listen(PORT, HOST, () => {
  console.log(`[backtest-lab] listening on http://${HOST}:${PORT} (root=${SPXER_ROOT})`)
})

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[backtest-lab] ${sig} — closing`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
