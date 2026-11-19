/**
 * dsh-web-updater — 服务端半个插件。
 *
 * 只做三件事，全部走本机 127.0.0.1 的同源小接口：
 *   GET  /dsh-updater/status   当前版本 / 可用版本 / 自动更新配置 / 是否正在更新
 *   POST /dsh-updater/check    立刻去 registry 查一次
 *   POST /dsh-updater/apply    后台启动 `dsh-web-update apply`（脱离进程，重启不自杀）
 *
 * 真正的更新逻辑留在 ~/.dsh/bin/dsh-web-update.mjs（命令行同一份），
 * 这里不复制任何 pnpm / 备份 / 回滚逻辑。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = process.env.HOME || homedir()
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
const STATE_DIR = join(DSH_HOME, 'web-update')
const STATUS_PATH = join(STATE_DIR, 'status.json')
const CONFIG_PATH = join(STATE_DIR, 'config.json')
const LOG_PATH = join(STATE_DIR, 'update.log')
const LOCK_PATH = join(STATE_DIR, 'apply.lock')
const PROFILE = 'web'
const UI_PATH = fileURLToPath(new URL('./ui.js', import.meta.url))
const BUNDLED_SCRIPT = fileURLToPath(new URL('../bin/dsh-web-update.mjs', import.meta.url))

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function scriptPath(config = {}) {
  const candidates = [
    config.script,
    process.env.DSH_UPDATER_SCRIPT,
    join(DSH_HOME, 'bin', 'dsh-web-update.mjs'),
    BUNDLED_SCRIPT,
  ].filter(Boolean)
  for (const p of candidates) if (existsSync(p)) return p
  return null
}

function runningVersion() {
  try { return readJson(join(DSH_HOME, 'profiles', PROFILE, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))?.version ?? null }
  catch { return null }
}

function pinnedVersion() {
  try { return readJson(join(DSH_HOME, 'profiles', PROFILE, 'package.json'))?.dependencies?.['@deepseek-ai/dsh'] ?? null }
  catch { return null }
}

/** 更新进程是否还活着：锁文件 + mtime 兜底（硬崩时锁会残留，10 分钟后视为过期）。 */
function applying() {
  if (!existsSync(LOCK_PATH)) return false
  try {
    const age = Date.now() - statSync(LOCK_PATH).mtimeMs
    const pid = Number(readFileSync(LOCK_PATH, 'utf8').trim())
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0); return true } catch { /* 进程已退出 */ }
    }
    return age < 10 * 60 * 1000
  } catch { return false }
}

function logTail(lines = 8) {
  try {
    return readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-lines)
  } catch { return [] }
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body) + '\n', 'utf8')
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(payload)
}

/** 只接受本机回环 Host + 同源 Origin 的请求；跨站一律 403。 */
function refuse(request, response) {
  const host = String(request.headers.host || '')
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const loopback = hostname === 'localhost' || hostname === '::1' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
  if (!loopback) { sendJson(response, 403, { ok: false, error: 'loopback only' }); return true }
  const origin = request.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== host) { sendJson(response, 403, { ok: false, error: 'cross-origin refused' }); return true }
    } catch { sendJson(response, 403, { ok: false, error: 'bad origin' }); return true }
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(response, 403, { ok: false, error: 'cross-site refused' }); return true
  }
  return false
}

function statusPayload() {
  const status = readJson(STATUS_PATH, {}) || {}
  const config = readJson(CONFIG_PATH, {}) || {}
  const installed = runningVersion()
  const latest = status.target ?? null
  return {
    ok: true,
    installed,
    pinned: pinnedVersion(),
    latest,
    channel: status.channel ?? config.channel ?? 'latest',
    updateAvailable: installed && latest ? latest !== installed : Boolean(status.updateAvailable),
    checkedAt: status.at ?? null,
    autoApply: config.autoApply ?? true,
    quietHours: config.quietHours ?? null,
    checkIntervalHours: config.checkIntervalHours ?? 6,
    applying: applying(),
    lastApplied: status.lastApplied ?? null,
    log: logTail(6),
  }
}

function runScript(script, args, { detached = false } = {}) {
  if (detached) {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: HOME,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()
    return { detached: true }
  }
  return { detached: false }
}

export const name = 'dsh-web-updater'

export function apply(ctx, config = {}) {
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.get('webServer')
    const port = Number(server?.port ?? config.port ?? 38080)

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-updater/status',
      handler: (request, response) => {
        if (refuse(request, response)) return
        if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'GET only' })
        sendJson(response, 200, statusPayload())
      },
    }), 'dsh-web-updater: status')

    // 页面 UI 的源码级入口：no-store，改样式/交互后刷新页面即可生效
    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-updater/ui.js',
      handler: (request, response) => {
        if (refuse(request, response)) return
        if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { ok: false, error: 'GET only' })
        let bytes
        try { bytes = readFileSync(UI_PATH) } catch { response.writeHead(404).end(); return }
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Length': bytes.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(request.method === 'HEAD' ? undefined : bytes)
      },
    }), 'dsh-web-updater: ui')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-updater/check',
      handler: async (request, response) => {
        if (refuse(request, response)) return
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'POST only' })
        const script = scriptPath(config)
        if (!script) return sendJson(response, 503, { ok: false, error: '找不到 dsh-web-update.mjs（~/.dsh/bin/）' })
        const started = runScript(script, ['check', '--json', '--no-notify'], { detached: true })
        sendJson(response, 202, { ok: true, started })
      },
    }), 'dsh-web-updater: check')

    // 设置页写配置（自动更新开关 / 通道），落盘到 ~/.dsh/web-update/config.json
    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-updater/config',
      handler: (request, response) => {
        if (refuse(request, response)) return
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'POST only' })
        let raw = ''
        request.on('data', (chunk) => {
          raw += chunk
          if (raw.length > 64 * 1024) request.destroy()
        })
        request.on('end', () => {
          let patch
          try { patch = JSON.parse(raw || '{}') } catch { return sendJson(response, 400, { ok: false, error: 'invalid JSON' }) }
          if (!patch || typeof patch !== 'object') return sendJson(response, 400, { ok: false, error: 'invalid body' })
          const next = { ...(readJson(CONFIG_PATH, {}) || {}) }
          if (typeof patch.autoApply === 'boolean') next.autoApply = patch.autoApply
          if (typeof patch.channel === 'string' && /^[a-z][a-z0-9.-]*$/i.test(patch.channel)) next.channel = patch.channel
          if (Array.isArray(patch.quietHours) && patch.quietHours.length === 2) {
            const from = Number(patch.quietHours[0])
            const to = Number(patch.quietHours[1])
            const hour = (n) => Number.isInteger(n) && n >= 0 && n <= 23
            if (!hour(from) || !hour(to) || from === to) {
              return sendJson(response, 400, { ok: false, error: 'quietHours 需要两个 0-23 且不同的整数' })
            }
            next.quietHours = [from, to]
          }
          if (Number.isInteger(patch.checkIntervalHours) && patch.checkIntervalHours >= 1 && patch.checkIntervalHours <= 168) {
            next.checkIntervalHours = patch.checkIntervalHours
          }
          try {
            mkdirSync(STATE_DIR, { recursive: true })
            writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n')
          } catch (error) {
            return sendJson(response, 500, { ok: false, error: String(error?.message || error) })
          }
          sendJson(response, 200, { ok: true, config: next })
        })
      },
    }), 'dsh-web-updater: config')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-updater/apply',
      handler: (request, response) => {
        if (refuse(request, response)) return
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'POST only' })
        if (applying()) return sendJson(response, 409, { ok: false, error: '已有更新在进行中' })
        const script = scriptPath(config)
        if (!script) return sendJson(response, 503, { ok: false, error: '找不到 dsh-web-update.mjs（~/.dsh/bin/）' })
        runScript(script, ['apply', '--yes', '--force', '--port', String(port), '--no-notify'], { detached: true })
        sendJson(response, 202, { ok: true, applying: true })
      },
    }), 'dsh-web-updater: apply')
  })
}
