#!/usr/bin/env node
/**
 * dsh-web-update — 自动检查 / 自动更新 dsh-web（profile 内 pin 的 @deepseek-ai/dsh）。
 *
 * 为什么需要它：dsh-web 没有自更新。它跑的是 ~/.dsh/profiles/<profile>/node_modules
 * 里那份 @deepseek-ai/dsh（base / web-app 等都是它的精确版本依赖），版本由 profile
 * 的 package.json pin 决定；插件市场只更新插件，不更新 harness 本体。
 *
 * 子命令：
 *   check      只检查，打印/通知，不落盘改动
 *   apply      检查 + 更新 + 重启 + 健康校验（失败自动回滚）。需要 --yes
 *   tick       launchd 定时入口：check，满足条件（autoApply / 静默时段 / 不忙）就 apply
 *   status     显示配置、当前版本、上次检查结果
 *   rollback   回滚到最近一次备份并重启
 *   restart    只重启 web 服务（不改版本）
 *   install    把脚本装到 ~/.dsh/bin 并注册 launchd 定时任务
 *   uninstall  移除 launchd 定时任务
 *
 * 常用参数：
 *   --channel latest|next|alpha|<x.y.z-rc.n>   更新通道（默认取配置，缺省 latest）
 *   --port 38080                               web 端口（默认取配置）
 *   --profile web                              profile 名（默认取配置）
 *   --yes                                      apply / rollback 必须显式确认
 *   --dry-run                                  apply 只打印计划
 *   --json                                     机器可读输出
 *   --no-notify                                本次不发系统通知
 *   --allow-young                              放行 pnpm 的 minimumReleaseAge 门槛
 */

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const HOME = process.env.HOME || homedir()
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
const STATE_DIR = join(DSH_HOME, 'web-update')
const CONFIG_PATH = join(STATE_DIR, 'config.json')
const STATUS_PATH = join(STATE_DIR, 'status.json')
const LOG_PATH = join(STATE_DIR, 'update.log')
const LOCK_PATH = join(STATE_DIR, 'apply.lock')
const PKG = '@deepseek-ai/dsh'
const SUB_BUILD_PKG = '@deepseek-ai/dsh-subprocess-local'

const DEFAULTS = {
  profile: 'web',
  port: 38080,
  channel: 'latest',
  checkIntervalHours: 6,
  autoApply: true,
  quietHoursOnly: true,
  quietHours: [3, 6],
  busyGraceMinutes: 15,
  notify: true,
}

// ────────────────────────────── 基础设施 ──────────────────────────────

const started = Date.now()
const logLines = []
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  logLines.push(line)
  if (!process.argv.includes('--json')) process.stdout.write(line + '\n')
}
function flushLog() {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(LOG_PATH, logLines.join('\n') + '\n', { flag: 'a' })
  } catch {}
}
function die(msg) {
  // 抛出而不是 process.exit：apply 的失败回滚依赖 catch 能接住（演练实证）
  throw new Error(msg)
}
function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { opts._.push(a); continue }
    const [k, inline] = a.slice(2).split('=')
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (inline !== undefined) { opts[key] = inline; continue }
    const next = argv[i + 1]
    const takesValue = ['channel', 'port', 'profile', 'registry', 'hours'].includes(key)
    if (takesValue && next !== undefined && !next.startsWith('--')) { opts[key] = next; i++ }
    else opts[key] = true
  }
  return opts
}
const opts = parseArgs(process.argv.slice(2))
const cmd = opts._[0] || 'check'

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
function writeJson(path, value) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
  } catch (err) {
    log(`警告：无法写入 ${path}（${err.message}）；只读模式下可忽略`)
  }
}
function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n')
      return { ...DEFAULTS }
    }
  } catch {
    return { ...DEFAULTS }
  }
  return { ...DEFAULTS, ...(readJson(CONFIG_PATH, {}) || {}) }
}
const cfg = loadConfig()
const profileName = String(opts.profile || cfg.profile)
const profileDir = join(DSH_HOME, 'profiles', profileName)
const port = Number(opts.port || cfg.port)

// ────────────────────────────── 版本比较 ──────────────────────────────

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}
function cmpSemver(a, b) {
  const x = parseSemver(a); const y = parseSemver(b)
  if (!x || !y) return String(a) === String(b) ? 0 : String(a).localeCompare(String(b))
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1
  if (!x.pre.length && !y.pre.length) return 0
  if (!x.pre.length) return 1            // 正式版 > 预发布
  if (!y.pre.length) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q)
    if (pn && qn) { if (+p !== +q) return +p > +q ? 1 : -1; continue }
    if (pn) return -1
    if (qn) return 1
    if (p !== q) return p > q ? 1 : -1
  }
  return 0
}

// ────────────────────────────── registry ──────────────────────────────

function registryFromNpmrc() {
  for (const f of [join(HOME, '.npmrc'), join(profileDir, '.npmrc')]) {
    if (!existsSync(f)) continue
    const m = /^registry\s*=\s*(\S+)\s*$/m.exec(readFileSync(f, 'utf8'))
    if (m) return m[1]
  }
  return null
}
function registryBase() {
  return (opts.registry || process.env.DSH_UPDATE_REGISTRY || registryFromNpmrc() || 'https://registry.npmjs.org').replace(/\/+$/, '')
}
const META_CACHE = join(STATE_DIR, 'registry-meta.json')

async function fetchMeta() {
  const reg = registryBase()
  const url = `${reg}/${encodeURIComponent(PKG)}`
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const tags = body['dist-tags'] || {}
    const versions = Object.keys(body.versions || {})
    mkdirSync(STATE_DIR, { recursive: true })
    writeJson(META_CACHE, { at: new Date().toISOString(), registry: reg, tags, versions })
    return { tags, versions, registry: reg, cached: false }
  } catch (err) {
    const cached = readJson(META_CACHE, null)
    if (cached?.tags) {
      log(`registry 不可用（${err.message}），使用 ${cached.at} 的缓存结果`)
      return { tags: cached.tags, versions: cached.versions || [], registry: cached.registry, cached: true }
    }
    throw new Error(`registry 查询失败且无缓存：${err.message}`)
  }
}

function resolveTarget(meta, channel) {
  if (parseSemver(channel)) return { version: channel, source: 'explicit' }
  const v = meta.tags[channel]
  if (!v) throw new Error(`通道 ${channel} 在 registry 上没有对应版本（可用：${Object.keys(meta.tags).join(', ')}）`)
  return { version: v, source: `dist-tag:${channel}` }
}

// ────────────────────────────── 状态读取 ──────────────────────────────

function installedVersion() {
  const p = join(profileDir, 'node_modules', PKG, 'package.json')
  return existsSync(p) ? readJson(p, {})?.version ?? null : null
}
function pinnedVersion() {
  const p = join(profileDir, 'package.json')
  if (!existsSync(p)) die(`找不到 profile：${profileDir}`)
  const deps = readJson(p, {})?.dependencies || {}
  return deps[PKG] ?? null
}
function launchCommand() {
  const bin = join(profileDir, 'node_modules', '.bin', 'dsh')
  if (!existsSync(bin)) die(`找不到 profile 内的 dsh 启动器：${bin}`)
  return bin
}

function notify(title, message) {
  if (!cfg.notify || opts.noNotify) return
  if (process.platform !== 'darwin') return
  const esc = (s) => JSON.stringify(String(s))
  spawnSync('osascript', ['-e', `display notification ${esc(message)} with title ${esc(title)}`], { stdio: 'ignore' })
}

// ────────────────────────────── check ──────────────────────────────

async function doCheck({ silent = false, notifyNew = true } = {}) {
  const pinned = pinnedVersion()
  const installed = installedVersion()
  const meta = await fetchMeta()
  const channel = String(opts.channel || cfg.channel)
  const { version: target, source } = resolveTarget(meta, channel)
  const updateAvailable = installed ? cmpSemver(target, installed) > 0 : true
  const result = {
    at: new Date().toISOString(),
    registry: meta.registry,
    registryCached: meta.cached,
    profile: profileName,
    port,
    channel,
    channelSource: source,
    pinned,
    installed,
    target,
    tagline: Object.entries(meta.tags).map(([k, v]) => `${k}=${v}`).join(' '),
    updateAvailable,
    drift: pinned !== installed,
    bin: existsSync(join(profileDir, 'node_modules', '.bin', 'dsh')) ? join(profileDir, 'node_modules', '.bin', 'dsh') : null,
  }
  const prev = readJson(STATUS_PATH, {}) || {}
  const wantsNotify = notifyNew && updateAvailable && prev.lastNotifiedVersion !== target
  const willSend = wantsNotify && cfg.notify && !opts.noNotify && process.platform === 'darwin'
  result.lastNotifiedVersion = willSend ? target : (prev.lastNotifiedVersion ?? null)
  writeJson(STATUS_PATH, { ...prev, ...result })

  if (silent) return result

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    log(`registry   ${result.registry}${result.registryCached ? '（缓存）' : ''}`)
    log(`通道       ${channel} → 目标 ${target}（${source}）`)
    log(`已安装     ${installed ?? '(无)'}    pin: ${pinned ?? '(无)'}`)
    log(`dist-tags  ${result.tagline}`)
    if (updateAvailable) log(`→ 有更新：${installed ?? '?'} → ${target}`)
    else log('→ 已是最新')
    if (result.drift) log(`注意：pin(${pinned}) 与已安装(${installed}) 不一致，建议 apply 或 pnpm install`)
  }
  if (wantsNotify) notify('DSH Web 有可用更新', `${installed} → ${target}（通道 ${channel}）`)
  return result
}

// ────────────────────────────── apply ──────────────────────────────

function run(cmdName, args, { cwd, allowFail = false, capture = true } = {}) {
  const res = spawnSync(cmdName, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'warn' },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  if (res.error) { if (allowFail) return { code: 127, out: String(res.error) }; die(`执行失败 ${cmdName}：${res.error.message}`) }
  if (res.status !== 0 && !allowFail) die(`${cmdName} ${args.join(' ')} 退出码 ${res.status}\n${out.trim()}`)
  return { code: res.status ?? 1, out }
}

function pnpmBin() {
  const found = spawnSync('/usr/bin/env', ['which', 'pnpm'], { encoding: 'utf8' })
  const p = (found.stdout || '').trim()
  if (p) return p
  const sibling = join(process.execPath, '..', 'pnpm')
  if (existsSync(sibling)) return sibling
  return null
}

function listeners() {
  const res = spawnSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return (res.stdout || '').trim().split(/\s+/).filter(Boolean).map(Number)
}
function processCommand(pid) {
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return (res.stdout || '').trim()
}
function processCwd(pid) {
  const res = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('n'))
  return line ? line.slice(1) : ''
}
function isOurWeb(pid) {
  const cmdline = processCommand(pid)
  if (!cmdline) return false
  if (!/\bweb\b/.test(cmdline) || !cmdline.includes(String(port))) return false
  if (cmdline.includes(profileDir)) return true
  if (/node_modules[\\/]\.bin[\\/]dsh\b/.test(cmdline)) return true
  if (/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/.test(cmdline)) return true
  const cwd = processCwd(pid)
  return Boolean(cwd) && (cwd === profileDir || cwd.startsWith(profileDir + '/'))
}

function recentActivityMinutes() {
  const dirs = [join(DSH_HOME, 'sessions'), join(DSH_HOME, 'storages')].filter((d) => existsSync(d))
  if (!dirs.length) return Infinity
  const res = spawnSync('find', [...dirs, '-type', 'f', '-mmin', `-${cfg.busyGraceMinutes}`], { encoding: 'utf8' })
  const hits = (res.stdout || '').trim()
  if (!hits) return Infinity
  return cfg.busyGraceMinutes
}
function inQuietHours() {
  const [from, to] = (cfg.quietHours || []).map(Number)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true
  const h = new Date().getHours()
  return from <= to ? h >= from && h < to : h >= from || h < to
}

function backupProfile() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(STATE_DIR, 'backups', stamp)
  mkdirSync(dir, { recursive: true })
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
    const src = join(profileDir, f)
    if (existsSync(src)) copyFileSync(src, join(dir, f))
  }
  const keep = 5
  const backups = join(STATE_DIR, 'backups')
  const all = existsSync(backups) ? readdirSync(backups).sort() : []
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(backups, old), { recursive: true, force: true })
  return dir
}

function restoreBackup(dir) {
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
    const src = join(dir, f)
    if (existsSync(src)) copyFileSync(src, join(profileDir, f))
  }
}

/**
 * allowBuilds 的键是 name@version 精确匹配的：新版本要放进来，旧键必须保留。
 * 只替换（而不是追加）会让旧版本残留的待构建项变成「被忽略的构建脚本」，
 * pnpm 11 会因此整条命令以 ERR_PNPM_IGNORED_BUILDS 失败（演练实测）。
 */
function allowBuildsPath() { return join(profileDir, 'pnpm-workspace.yaml') }

function appendAllowBuilds(entries) {
  const p = allowBuildsPath()
  if (!existsSync(p)) return []
  const text = readFileSync(p, 'utf8')
  const lines = text.split('\n')
  const head = lines.findIndex((l) => /^allowBuilds:\s*$/.test(l))
  if (head === -1) return []
  let end = head
  for (let i = head + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s+\S/.test(l) || /^\s*$/.test(l)) end = i
    else break
  }
  const present = new Set()
  for (let i = head + 1; i <= end; i++) {
    const m = /^\s+['"]?([^'":\s]+(?:@[^'":\s]+)?)['"]?\s*:/.exec(lines[i])
    if (m) present.add(m[1])
  }
  const added = []
  for (const raw of entries) {
    const entry = raw.trim().replace(/^['"]|['"]$/g, '')
    if (!entry || present.has(entry)) continue
    present.add(entry)
    added.push(entry)
  }
  if (!added.length) return []
  const snippet = added.map((e) => `  '${e}': true`)
  if (!/^\s*$/.test(lines[end])) end = end
  lines.splice(end + 1, 0, ...snippet)
  writeFileSync(p, lines.join('\n'))
  return added
}

function parseIgnoredBuilds(output) {
  const m = /Ignored build scripts:\s*(.+)/i.exec(output || '')
  if (!m) return []
  return m[1].split(',').map((x) => x.trim()).filter(Boolean)
}


function stopWeb() {
  const pids = listeners()
  if (!pids.length) return { stopped: false, reason: '端口无人监听' }
  const notOurs = pids.filter((pid) => !isOurWeb(pid))
  if (notOurs.length) die(`端口 ${port} 被非本 profile 的进程占用（pid ${notOurs.join(',')}），拒绝操作`)
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (!listeners().length) return { stopped: true, pids }
    spawnSync('sleep', ['0.4'])
  }
  for (const pid of listeners()) { try { process.kill(pid, 'SIGKILL') } catch {} }
  const hard = Date.now() + 8000
  while (Date.now() < hard) { if (!listeners().length) return { stopped: true, pids }; spawnSync('sleep', ['0.3']) }
  die(`端口 ${port} 无法释放`)
}

function childEnv() {
  const nodeDir = dirname(process.execPath)
  const standard = [nodeDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const current = String(process.env.PATH || '').split(':').filter(Boolean)
  const path = [...new Set([...standard, ...current])].join(':')
  return { ...process.env, PATH: path, HOME: process.env.HOME || HOME }
}

async function startWebAndWait() {
  const bin = launchCommand()
  const child = spawn(process.execPath, [bin, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: HOME,
    detached: true,
    stdio: 'ignore',
    env: childEnv(),
  })
  child.unref()
  const deadline = Date.now() + 120000
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(4000) })
      // 404 表示端口已监听但路由还没挂完（演练出现过），继续等到真正就绪
      if (res.status === 200 || res.status === 401 || res.status === 403) return { pid: child.pid, status: res.status }
      lastErr = `HTTP ${res.status}`
    } catch (err) { lastErr = err.message }
    spawnSync('sleep', ['0.7'])
  }
  throw new Error(`新进程未在 120s 内就绪（${lastErr}）`)
}

function takeLock() {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(LOCK_PATH, String(process.pid) + '\n') } catch {}
}
function releaseLock() {
  try { rmSync(LOCK_PATH, { force: true }) } catch {}
}

async function doApply({ confirmed = false } = {}) {
  takeLock()
  try {
    return await runApply({ confirmed })
  } finally {
    releaseLock()
  }
}

async function runApply({ confirmed = false } = {}) {
  const status = await doCheck({ silent: true, notifyNew: false })
  if (!status.updateAvailable && !status.drift) {
    log(`已是最新（${status.installed}），无需更新`)
    return { changed: false }
  }
  const target = status.target
  log(`计划：${status.installed} → ${target}（通道 ${status.channel}），profile=${profileName}，端口 ${port}`)
  if (opts.dryRun) { log('dry-run：不做任何改动'); return { changed: false, plan: status } }
  if (!opts.yes && !confirmed) die('apply 需要 --yes 确认（或用 --dry-run 先看计划）')

  const busy = recentActivityMinutes()
  if (busy !== Infinity && !opts.force) {
    die(`检测到 ${cfg.busyGraceMinutes} 分钟内有会话写入，疑似正在使用；确认要更新请加 --force`)
  }
  if (cfg.quietHoursOnly && !inQuietHours() && !opts.force) {
    die(`不在静默时段 ${cfg.quietHours.join(':00-')}:00 内，未自动更新；立即更新请加 --force`)
  }
  const pnpm = pnpmBin()
  if (!pnpm) die('找不到 pnpm')

  const backupDir = backupProfile()
  log(`已备份 profile 清单与 lock：${backupDir}`)
  const from = status.installed || status.pinned
  const added = appendAllowBuilds([`${SUB_BUILD_PKG}@${target}`])
  if (added.length) log(`已在 pnpm-workspace.yaml 追加 allowBuilds 键：${added.join(', ')}`)

  const addArgs = ['add', `${PKG}@${target}`, '--save-exact']
  let res = null
  try {
    log(`pnpm add ${PKG}@${target} --save-exact（在 ${profileDir}）`)
    res = run(pnpm, addArgs, { cwd: profileDir, allowFail: true })

    // pnpm 认为「被忽略的构建脚本」-> 把它点名的 name@version 补进 allowBuilds 再试一次
    if (res.code !== 0) {
      const ignored = parseIgnoredBuilds(res.out)
      if (ignored.length) {
        const added2 = appendAllowBuilds(ignored)
        log(`pnpm 报告被忽略的构建脚本，已补齐 allowBuilds：${added2.join(', ') || '(无新增)'}，重试…`)
        res = run(pnpm, addArgs, { cwd: profileDir, allowFail: true })
      }
    }

    // pnpm 的「最小发布时长」门槛
    if (res.code !== 0 && /minimumReleaseAge|Minimum release age|ERR_PNPM_MINIMUM/i.test(res.out || '')) {
      log('pnpm 拒绝了该版本（发布时长门槛），加 --config.minimumReleaseAge=0 重试…')
      res = run(pnpm, [...addArgs, '--config.minimumReleaseAge=0'], { cwd: profileDir, allowFail: true })
    }

    if (res.code !== 0) {
      // 兜底：装成功了但尾部只报 ignored builds 时不该整体失败
      if (installedVersion() === target && /ERR_PNPM_IGNORED_BUILDS/i.test(res.out || '')) {
        log('pnpm 以 ERR_PNPM_IGNORED_BUILDS 结束，但包已按目标版本安装；继续校验')
      } else {
        throw new Error(`pnpm add 失败：\n${res.out.slice(-3000)}`)
      }
    }
    if (/Ignored build scripts/i.test(res.out || '')) log('提示：pnpm 仍有被忽略的构建脚本，见本次输出（通常需把新 name@version 加进 allowBuilds）')

    const nowInstalled = installedVersion()
    if (nowInstalled !== target) throw new Error(`安装后版本仍为 ${nowInstalled}，期望 ${target}`)
    log(`已安装 ${nowInstalled}`)

    const bin = launchCommand()
    const ver = run(process.execPath, [bin, '--version'], { cwd: HOME })
    if ((ver.out || '').trim() !== target) throw new Error(`dsh --version = ${(ver.out || '').trim()}，期望 ${target}`)
    log('启动器版本一致')

    const dump = run(process.execPath, [bin, '--profile', profileName, '--dump-config'], { cwd: HOME, allowFail: true })
    if (dump.code !== 0) throw new Error(`--dump-config 组合失败（退出码 ${dump.code}）：\n${dump.out.slice(-3000)}`)
    const skipped = (dump.out.match(/skipping profile bundle/g) || []).length
    log(`配置组合通过${skipped ? `（${skipped} 个插件因不兼容被跳过，见 dsh 启动日志）` : ''}`)

    stopWeb()
    const health = await startWebAndWait()
    log(`新进程已监听 http://127.0.0.1:${port}/（HTTP ${health.status}）`)

    writeJson(STATUS_PATH, {
      ...readJson(STATUS_PATH, {}),
      at: new Date().toISOString(),
      installed: target,
      pinned: target,
      target,
      updateAvailable: false,
      lastApplied: { at: new Date().toISOString(), from, to: target, backupDir, ok: true },
    })
    notify('DSH Web 已更新', `${from} → ${target}，服务已重启`)
    return { changed: true, from, to: target }
  } catch (err) {
    log(`更新失败：${err.message}`)
    log('开始回滚…')
    try {
      restoreBackup(backupDir)
      const pnpm2 = pnpmBin()
      if (pnpm2) run(pnpm2, ['install', '--frozen-lockfile'], { cwd: profileDir, allowFail: true })
      stopWeb()
      await startWebAndWait()
      log(`已回滚到 ${installedVersion() ?? from}，服务已恢复`)
    } catch (rollbackErr) {
      log(`回滚也失败：${rollbackErr.message}`)
    }
    writeJson(STATUS_PATH, { ...readJson(STATUS_PATH, {}), lastApplied: { at: new Date().toISOString(), from, to: target, backupDir, ok: false, error: String(err.message) } })
    notify('DSH Web 更新失败', '已尝试回滚，请检查日志')
    flushLog()
    process.exit(1)
  }
}

// ────────────────────────────── rollback ──────────────────────────────

async function doRollback() {
  if (!opts.yes) die('rollback 需要 --yes 确认')
  const backups = join(STATE_DIR, 'backups')
  const all = existsSync(backups) ? readdirSync(backups).sort() : []
  if (!all.length) die('没有可用备份')
  const dir = join(backups, all[all.length - 1])
  const pnpm = pnpmBin()
  log(`回滚到备份 ${dir}`)
  restoreBackup(dir)
  if (pnpm) run(pnpm, ['install', '--frozen-lockfile'], { cwd: profileDir })
  stopWeb()
  await startWebAndWait()
  log(`已回滚，当前 ${installedVersion()}，服务在 ${port}`)
}

async function doRestart() {
  if (!opts.yes && !opts.force) die('restart 需要 --yes 确认')
  launchCommand() // 先确认新启动器存在，避免杀掉服务后才发现起不来
  log(`重启 ${profileName} 的 web 服务（端口 ${port}）`)
  stopWeb()
  const health = await startWebAndWait()
  log(`已重启，http://127.0.0.1:${port}/（HTTP ${health.status}）`)
  return health
}

// ────────────────────────────── launchd ──────────────────────────────

function plistPath() { return join(HOME, 'Library', 'LaunchAgents', 'com.dsh.web-update.plist') }
function installedScriptPath() { return join(DSH_HOME, 'bin', 'dsh-web-update.mjs') }
function xml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

function doInstall() {
  const target = installedScriptPath()
  mkdirSync(join(DSH_HOME, 'bin'), { recursive: true })
  if (resolve(SELF) !== resolve(target)) copyFileSync(SELF, target)
  chmodSync(target, 0o755)

  const nodeDir = join(process.execPath, '..')
  const interval = Math.max(60, Number(cfg.checkIntervalHours || 6) * 3600)
  mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true })
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.web-update</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(target)}</string>
    <string>tick</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(`${nodeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
    <key>HOME</key><string>${xml(HOME)}</string>
  </dict>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(STATE_DIR, 'launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(STATE_DIR, 'launchd.log'))}</string>
</dict>
</plist>
`
  writeFileSync(plistPath(), body)
  const uid = process.getuid?.() ?? 501
  spawnSync('launchctl', ['bootout', `gui/${uid}/com.dsh.web-update`], { stdio: 'ignore' })
  const res = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath()], { encoding: 'utf8' })
  if (res.status !== 0) {
    log(`launchctl bootstrap 失败（${(res.stderr || '').trim()}）；plist 已写入 ${plistPath()}，可手动：launchctl bootstrap gui/${uid} ${plistPath()}`)
  } else {
    log(`已注册定时任务：每 ${cfg.checkIntervalHours} 小时检查一次`)
  }
  log(`脚本：${target}`)
  log(`配置：${CONFIG_PATH}`)
  log(`日志：${LOG_PATH} / ${join(STATE_DIR, 'launchd.log')}`)
  return { plist: plistPath(), script: target }
}

function doUninstall() {
  const uid = process.getuid?.() ?? 501
  spawnSync('launchctl', ['bootout', `gui/${uid}/com.dsh.web-update`], { stdio: 'ignore' })
  if (existsSync(plistPath())) rmSync(plistPath())
  log('已移除定时任务')
}

// ────────────────────────────── tick ──────────────────────────────

async function doTick() {
  const status = await doCheck({ silent: true })
  if (!status.updateAvailable && !status.drift) { log(`无更新（${status.installed}）`); return }
  if (!cfg.autoApply) {
    log(`有新版 ${status.target}，autoApply=false，仅通知`)
    return
  }
  if (cfg.quietHoursOnly && !inQuietHours()) { log(`有新版 ${status.target}，不在静默时段，跳过`); return }
  if (recentActivityMinutes() !== Infinity) { log(`有新版 ${status.target}，但最近有会话写入，跳过`); return }
  log(`有新版 ${status.target}，开始自动更新`)
  await doApply({ confirmed: true })
}

// ────────────────────────────── main ──────────────────────────────

try {
  switch (cmd) {
    case 'check': await doCheck(); break
    case 'apply': await doApply(); break
    case 'tick': await doTick(); break
    case 'rollback': await doRollback(); break
    case 'restart': await doRestart(); break
    case 'install': doInstall(); break
    case 'uninstall': doUninstall(); break
    case 'env': {
      const env = childEnv()
      process.stdout.write(JSON.stringify({ path: env.PATH, node: process.execPath }, null, 2) + '\n')
      break
    }
    case 'status': {
      const st = readJson(STATUS_PATH, null)
      const out = {
        config: cfg,
        configPath: CONFIG_PATH,
        registry: registryBase(),
        profileDir,
        pinned: pinnedVersion(),
        installed: installedVersion(),
        lastCheck: st?.at ?? null,
        lastTarget: st?.target ?? null,
        lastNotifiedVersion: st?.lastNotifiedVersion ?? null,
        lastApplied: st?.lastApplied ?? null,
      }
      process.stdout.write(JSON.stringify(out, null, 2) + '\n')
      break
    }
    default:
      process.stdout.write(`用法: dsh-web-update <check|apply|tick|status|rollback|restart|env|install|uninstall> [--channel latest|next|alpha|<version>] [--port 38080] [--yes] [--dry-run] [--json]\n`)
      process.exitCode = 1
  }
} catch (err) {
  log(`ERROR ${err?.stack || err?.message || err}`)
  process.exitCode = 1
} finally {
  flushLog()
  if (process.argv.includes('--json') && cmd === 'apply') {
    process.stdout.write(JSON.stringify({ ok: !process.exitCode, ms: Date.now() - started }) + '\n')
  }
}
