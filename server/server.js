#!/usr/bin/env node
/* heatmap-api —— 行情中转服务
 *
 * 干什么：常驻拉取四家行情源 → 内存里维护"一份全市场快照" → 对外只提供
 *         GET /api/snapshot（gzip + ETag/304）。
 * 为什么：前端原来是"每个访客的浏览器各打 4~31 个请求"；现在是"服务器拉一次、
 *         全站共享一份"，上游压力与访客数无关。这份快照同时是将来
 *         「盘中留档 / 时间轴回放」的数据源。
 *
 * 环境变量（都有默认值，见 deploy/heatmap-api.service）：
 *   PORT=8787  HOST=127.0.0.1  DATA_DIR=/srv/heatmap/data
 *   TRADING_INTERVAL_MS=10000  IDLE_INTERVAL_MS=300000  UPSTREAM_TIMEOUT_MS=8000
 * 运维：journalctl -u heatmap-api -f 看日志；/health 看各源状态。详见 README.md */

import http from 'node:http';
import zlib from 'node:zlib';
import { loadUniverse, treeSignature, universeCounts } from './lib/universe.js';
import { fetchJrj, fetchTencent, fetchIndices, fetchTurnover, fetchFlow } from './lib/sources.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';          // 只监听回环，对外交给 nginx / SSH 隧道
const DATA_DIR = process.env.DATA_DIR || '/srv/heatmap/data';
const TRADING_INTERVAL_MS = Number(process.env.TRADING_INTERVAL_MS || 10_000);
const IDLE_INTERVAL_MS = Number(process.env.IDLE_INTERVAL_MS || 300_000);

/* 指数（对应前端 MARKETS 的 idx，一个腾讯批量请求拿全） */
const INDEX_CODES = ['sh000985', 'sh000001', 'sz399106', 'sh000300', 'sh000510', 'sz399006', 'sh000688', 'bj899050', 'r_hkHSI'];

/* ---- 缓存：每个源各存一份，失败时保留上一份（服务不中断） ---- */
const cache = { jrj: {}, bj: {}, etf: {}, hk: {}, indices: {}, turnover: null, flow: null };
const status = {};                                      // 每源最近一轮 {ok,ms,count,error}
const stats = { startedAt: Date.now(), cycles: 0, fails: 0, lastCycleMs: 0 };
const egress = { total: 0, dayBytes: 0, day: '' };       // 出网流量计数（只算响应体；上游请求约 51KB/轮另计）

const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function countEgress(n) {
  const day = localDay();
  if (egress.day !== day) { egress.day = day; egress.dayBytes = 0; }
  egress.dayBytes += n; egress.total += n;
}

let universe = null, universeSig = '';
let seq = 0, coreKey = '', rawBody = null, gzBody = null, etag = '', ts = 0;

function ensureUniverse() {
  const sig = treeSignature(DATA_DIR);
  if (sig === universeSig) return;
  universe = loadUniverse(DATA_DIR);
  universeSig = sig;
  const c = universeCounts(universe);
  console.log(`[universe] 名单加载: 全A ${c.all} / ETF ${c.etf} / 港股 ${c.hk}`);
}

function inTradingHours(d = new Date()) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= 9 * 60 && m <= 16 * 60 + 15;   // 9:00–16:15 覆盖 A股(9:15–15:00) + 港股(到 16:00)
}

function buildCore(session) {
  return {
    session,
    markets: { all: { ...cache.jrj, ...cache.bj }, etf: cache.etf, hk: cache.hk },
    indices: cache.indices,
    turnover: cache.turnover,
    flow: cache.flow,
  };
}

/* 只有"内容真变了"才换 seq/ETag —— 客户端轮询时绝大多数请求以 304 结束（几百字节） */
function publish(session) {
  const core = buildCore(session);
  const key = JSON.stringify(core);
  if (key === coreKey) return false;
  coreKey = key;
  seq++;
  ts = Date.now();
  rawBody = Buffer.from(JSON.stringify({ ts, seq, ...core, sources: status }));
  gzBody = zlib.gzipSync(rawBody, { level: 6 });
  etag = '"v' + seq + '"';
  return true;
}

/* 每源独立节奏：东财原前端就是 60s 一次——10s 一次会被它限流封 IP（2026-11-12 实测被封）。
 * 失败则指数退避（30s → 最多 10 分钟），成功清零。 */
const SOURCE_MIN_INTERVAL_MS = { flow: 60_000 };
const nextAt = {}, failStreak = {};
const SKIP = Symbol('skip');

async function refreshOnce() {
  const t0 = Date.now();
  const session = inTradingHours() ? 'trading' : 'closed';
  ensureUniverse();

  const defs = [
    ['jrj',    () => fetchJrj()],                        // 沪深全市场（一次 POST）
    ['qt_bj',  () => fetchTencent(universe.all.BJ, 's')],
    ['qt_etf', () => fetchTencent(universe.etf, 's')],
    ['qt_hk',  () => fetchTencent(universe.hk, 'hk')],
    ['ths',    () => fetchTurnover()],
    ['flow',   () => fetchFlow()],
    ['idx',    () => fetchIndices(INDEX_CODES)],
  ];
  const settled = await Promise.allSettled(defs.map(([name, fn]) => {
    if (nextAt[name] > Date.now()) return SKIP;
    return fn();
  }));

  const marks = [];
  settled.forEach((r, i) => {
    const [name] = defs[i];
    const ms = Date.now() - t0;
    if (r.status === 'fulfilled' && r.value === SKIP) { marks.push(name + '·'); return; }
    if (r.status === 'fulfilled') {
      const v = r.value;
      if (name === 'jrj') cache.jrj = v;
      else if (name === 'qt_bj') cache.bj = v;
      else if (name === 'qt_etf') cache.etf = v;
      else if (name === 'qt_hk') cache.hk = v;
      else if (name === 'idx') cache.indices = v;
      else if (name === 'ths') cache.turnover = v;
      else if (name === 'flow') cache.flow = v;
      const count = name === 'ths' ? 1
        : name === 'flow' ? (v.in?.length ?? 0) + (v.out?.length ?? 0)
        : Object.keys(v).length;
      status[name] = { ok: true, ms, count };
      failStreak[name] = 0;
      nextAt[name] = SOURCE_MIN_INTERVAL_MS[name] ? Date.now() + SOURCE_MIN_INTERVAL_MS[name] : 0;
      marks.push(`${name}✓`);
    } else {
      stats.fails++;
      failStreak[name] = (failStreak[name] ?? 0) + 1;
      const wait = Math.min(30_000 * 2 ** (failStreak[name] - 1), 600_000);
      nextAt[name] = Date.now() + wait;                  // 退避：别继续硬撞
      status[name] = { ok: false, ms, error: String(r.reason?.message ?? r.reason), retryInSec: Math.round(wait / 1000) };
      marks.push(`${name}✗`);
    }
  });

  const changed = publish(session);
  stats.cycles++;
  stats.lastCycleMs = Date.now() - t0;
  const c = universeCounts(universe);
  const got = Object.keys(cache.jrj).length + Object.keys(cache.bj).length
    + Object.keys(cache.etf).length + Object.keys(cache.hk).length;
  console.log(`[cycle ${stats.cycles}] ${stats.lastCycleMs}ms · ${session} · seq=${seq}${changed ? '(+)' : ''}`
    + ` · ${marks.join(' ')} · 覆盖 ${got}/${c.all + c.etf + c.hk}`);
}

/* ---- 调度：交易时段 10s 一轮，其余 5 分钟一轮；上一轮没跑完则跳过本轮 ---- */
let timer = null, running = false;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(tick, inTradingHours() ? TRADING_INTERVAL_MS : IDLE_INTERVAL_MS);
}
async function tick() {
  if (running) return;
  running = true;
  try { await refreshOnce(); }
  catch (e) { console.error('[refresh] 整轮异常:', e.message); }
  finally { running = false; schedule(); }
}

/* ---- HTTP ---- */
const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (path === '/api/snapshot') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Vary', 'Accept-Encoding');
    if (!rawBody) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"error":"首次抓取还没完成，请稍后重试"}');
      return;
    }
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      res.setHeader('Content-Encoding', 'gzip');
      countEgress(gzBody.length);
      res.end(gzBody);
    } else {
      countEgress(rawBody.length);
      res.end(rawBody);
    }
    return;
  }

  if (path === '/health') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: stats.cycles > 0,
      uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
      cycles: stats.cycles, fails: stats.fails, lastCycleMs: stats.lastCycleMs,
      seq, ts, session: inTradingHours() ? 'trading' : 'closed',
      egress: {
        totalMB: +(egress.total / 1048576).toFixed(2),
        todayMB: +(egress.dayBytes / 1048576).toFixed(3),
        day: egress.day,
        note: '只计对外响应体；上游抓取约 51KB/轮（全量）另算',
      },
      universe: universe ? universeCounts(universe) : null,
      data: {
        all: Object.keys(cache.jrj).length + Object.keys(cache.bj).length,
        etf: Object.keys(cache.etf).length,
        hk: Object.keys(cache.hk).length,
        indices: Object.keys(cache.indices).length,
        flow: cache.flow ? cache.flow.in.length + cache.flow.out.length : 0,
      },
      sources: status,
    }, null, 2));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('heatmap-api · 行情中转服务\n\n'
    + '  GET /api/snapshot   全市场快照（gzip + ETag；轮询请带 If-None-Match 换 304）\n'
    + '  GET /health         服务与各数据源状态\n');
});

/* ---- 生存策略：收到 SIGTERM 干净退出；致命异常让 systemd 拉起 ---- */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[server] 收到 ${sig}，退出`);
    clearTimeout(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
process.on('uncaughtException', e => { console.error('[fatal]', e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('[fatal:rejection]', e); process.exit(1); });

server.listen(PORT, HOST, () => {
  console.log(`[server] heatmap-api 启动 → http://${HOST}:${PORT} · 数据目录 ${DATA_DIR}`
    + ` · 交易时段每 ${TRADING_INTERVAL_MS / 1000}s / 其余每 ${IDLE_INTERVAL_MS / 1000}s`);
  tick();   // 启动即抓一轮，不等第一个定时
});
