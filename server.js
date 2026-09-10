const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig } = require('./src/config');
const { inspect } = require('./src/inspector');
const { syncObjectStorage, discoverServers, countLocalServers } = require('./src/objectStorage');
const history = require('./src/history');
const { logger, accessLog, installGlobalHandlers } = require('./src/logger');
const dingtalk = require('./src/dingtalk');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// 安装全局未捕获异常 / Promise rejection 捕获，写入运行日志
installGlobalHandlers();

/* ---------- 对象存储定时同步 ---------- */
let autoSyncTimer = null;       // 间隔模式 setInterval 句柄
let autoSyncCheckTimer = null;  // 固定时间模式 setInterval 句柄（每分钟检查一次是否到点）
let autoSyncRunning = false;
let autoSyncLastRunTime = null;
let autoSyncLastRunMode = null; // 'interval' | 'fixed' | null

/** 执行一次对象存储拉取（内部公共函数） */
async function runSyncOnce(modeTag) {
  try {
    autoSyncLastRunTime = new Date().toLocaleString('zh-CN', { hour12: false });
    autoSyncLastRunMode = modeTag;
    const curCfg = loadConfig();
    const curOs = curCfg.objectStorage || {};
    if (!curOs.enabled || !curOs.accessKey || !curOs.secretKey) return;
    const r = await syncObjectStorage(curCfg);
    if (r.ok) {
      logger.info('定时同步', `${modeTag} ${autoSyncLastRunTime} 完成：下载 ${r.downloaded}，跳过 ${r.skipped}${r.failed ? '，失败 ' + r.failed : ''}`);
    } else {
      logger.warn('定时同步', `${modeTag} ${autoSyncLastRunTime} 失败: ${r.detail}`);
    }
  } catch (e) {
    logger.error('定时同步', `${modeTag} 执行异常:`, e.message);
  }
}

/** 把 "11:00,14:30" 这样的字符串解析成去重排序后的时间点数组 ["11:00","14:30"] */
function parseFixedTimes(s) {
  const list = String(s || '')
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter((t) => /^\d{1,2}:\d{2}$/.test(t));
  const unique = Array.from(new Set(list));
  unique.sort();
  return unique;
}

/** 计算当前时间在固定时间点列表中命中了哪个（分钟级精度） */
function matchedFixedTime(fixedTimes, now) {
  if (!fixedTimes.length) return null;
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const cur = `${hh}:${mm}`;
  return fixedTimes.includes(cur) ? cur : null;
}

/** 判断某个固定时间点是否应该执行（同一分钟内只触发一次） */
let _lastFixedTriggeredMinute = '';
function shouldTriggerFixed(fixedTimes, now) {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const curMinute = `${hh}:${mm}`;
  if (!fixedTimes.includes(curMinute)) return false;
  if (_lastFixedTriggeredMinute === curMinute) return false;
  _lastFixedTriggeredMinute = curMinute;
  return true;
}

function startAutoSync() {
  stopAutoSync();
  const cfg = loadConfig();
  const os = cfg.objectStorage || {};
  if (!os.autoSync || !os.enabled) { autoSyncRunning = false; return; }

  const mode = os.syncMode || 'interval'; // 'interval' | 'fixed' | 'both'
  autoSyncRunning = true;

  // ---- 间隔模式：每 N 分钟 ----
  if (mode === 'interval' || mode === 'both') {
    const intervalMs = Math.max(1, os.syncIntervalMinutes || 5) * 60 * 1000;
    logger.info('定时同步', `间隔模式启动：每 ${os.syncIntervalMinutes || 5} 分钟拉取一次`);
    autoSyncTimer = setInterval(() => runSyncOnce('interval'), intervalMs);
    // 启动后立即执行一次
    runSyncOnce('interval');
  }

  // ---- 固定时间点模式：每天 HH:mm 执行 ----
  if (mode === 'fixed' || mode === 'both') {
    const fixedTimes = parseFixedTimes(os.syncFixedTimes);
    if (fixedTimes.length) {
      logger.info('定时同步', `固定时间点模式启动：每天 ${fixedTimes.join(', ')} 拉取`);
      // 每分钟检查一次是否到点
      autoSyncCheckTimer = setInterval(() => {
        const now = new Date();
        if (shouldTriggerFixed(fixedTimes, now)) {
          runSyncOnce('fixed');
        }
      }, 60 * 1000);
    } else {
      logger.warn('定时同步', '固定时间点模式已启用但未配置有效时间点（syncFixedTimes），跳过');
    }
  }
}

function stopAutoSync() {
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  if (autoSyncCheckTimer) { clearInterval(autoSyncCheckTimer); autoSyncCheckTimer = null; }
  autoSyncRunning = false;
  logger.info('定时同步', '已停止');
}

function getAutoSyncStatus() {
  const cfg = loadConfig();
  const os = cfg.objectStorage || {};
  const mode = os.syncMode || 'interval';
  const fixedTimes = parseFixedTimes(os.syncFixedTimes);
  const details = [];
  if (mode === 'interval' || mode === 'both') details.push(`每 ${os.syncIntervalMinutes || 5} 分钟`);
  if ((mode === 'fixed' || mode === 'both') && fixedTimes.length) details.push(`每天 ${fixedTimes.join(', ')}`);
  return {
    ok: true,
    running: autoSyncRunning,
    autoSyncEnabled: os.autoSync === true,
    storageEnabled: os.enabled === true,
    mode,
    intervalMinutes: os.syncIntervalMinutes || 5,
    fixedTimes,
    scheduleText: details.join(' + ') || '未配置',
    lastRunTime: autoSyncLastRunTime,
    lastRunMode: autoSyncLastRunMode
  };
}

/* ---------- 定时巡检 ---------- */
let autoInspectCheckTimer = null; // 每分钟检查是否到点
let autoInspectRunning = false;
let autoInspectLastRunTime = null;
let autoInspectLastRunMarkets = null;
let _lastInspectTriggeredMinute = '';

/** 执行一次定时巡检（只巡检指定市场） */
async function runAutoInspectOnce(marketsToInspect) {
  try {
    autoInspectLastRunTime = new Date().toLocaleString('zh-CN', { hour12: false });
    autoInspectLastRunMarkets = marketsToInspect;
    const curCfg = loadConfig();
    const scope = {
      zones: 'all',
      markets: marketsToInspect,
      compareMode: 'merged',
      compareAlgorithm: 'majority',
      runId: null,
      compareOnly: false
    };
    logger.info('定时巡检', `${autoInspectLastRunTime} 开始，市场：${marketsToInspect.join(', ')}`);
    const result = await inspect(curCfg, scope);
    try { history.saveRun(result, scope); } catch (e) { /* 忽略 */ }
    const s = result.summary || {};
    logger.info('定时巡检', `${autoInspectLastRunTime} 完成：服务器 ${s.groupTotalServers || 0}，异常 ${s.anomalousServers || 0}，代码 ${s.totalCodes || 0}，异常代码 ${s.anomalies || 0}`);
  } catch (e) {
    logger.error('定时巡检', `${autoInspectLastRunTime} 执行异常:`, e.message);
  }
}

/** 检查当前时间是否命中配置的时间点（分钟级精度，同一分钟只触发一次） */
function shouldTriggerInspect(timePoints, now) {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const curMinute = `${hh}:${mm}`;
  if (!timePoints.includes(curMinute)) return false;
  if (_lastInspectTriggeredMinute === curMinute) return false;
  _lastInspectTriggeredMinute = curMinute;
  return true;
}

function startAutoInspect() {
  stopAutoInspect();
  const cfg = loadConfig();
  const sch = (cfg.settings && cfg.settings.inspectSchedule) || {};
  if (!sch.enabled) { autoInspectRunning = false; return; }

  const mode = sch.mode || 'global'; // 'global' | 'per-market'
  autoInspectRunning = true;

  // 收集所有时间点（全局 + 各市场），用于每分钟检查
  const globalTimes = parseFixedTimes(sch.globalTimes);
  const marketTimes = {}; // { "09:00": ["SH","SZ"], "15:00": ["BJ"] }

  if (mode === 'global') {
    // 全局模式：所有时间点都巡检所有 enabled 市场
    for (const t of globalTimes) {
      marketTimes[t] = (cfg.markets || []).filter((m) => m.enabled !== false).map((m) => m.code);
    }
  } else if (mode === 'per-market') {
    // 按市场模式：每个市场有自己的巡检时间
    for (const m of (cfg.markets || [])) {
      if (m.enabled === false) continue;
      const times = parseFixedTimes(m.inspectTimes);
      for (const t of times) {
        if (!marketTimes[t]) marketTimes[t] = [];
        if (!marketTimes[t].includes(m.code)) marketTimes[t].push(m.code);
      }
    }
  }

  const allTimePoints = Object.keys(marketTimes).sort();
  if (!allTimePoints.length) {
    logger.warn('定时巡检', '已启用但未配置有效时间点，跳过');
    return;
  }

  const modeText = mode === 'global'
    ? `全局模式 · 时间 ${globalTimes.join(', ')}`
    : `按市场模式 · 时间点 ${allTimePoints.join(', ')}`;
  logger.info('定时巡检', `启动：${modeText}`);

  // 每分钟检查一次是否到点
  autoInspectCheckTimer = setInterval(() => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const curMinute = `${hh}:${mm}`;
    if (!allTimePoints.includes(curMinute)) return;
    if (_lastInspectTriggeredMinute === curMinute) return;
    _lastInspectTriggeredMinute = curMinute;
    const markets = marketTimes[curMinute] || [];
    if (markets.length) runAutoInspectOnce(markets);
  }, 60 * 1000);
}

function stopAutoInspect() {
  if (autoInspectCheckTimer) { clearInterval(autoInspectCheckTimer); autoInspectCheckTimer = null; }
  autoInspectRunning = false;
  logger.info('定时巡检', '已停止');
}

function getAutoInspectStatus() {
  const cfg = loadConfig();
  const sch = (cfg.settings && cfg.settings.inspectSchedule) || {};
  const mode = sch.mode || 'global';
  const globalTimes = parseFixedTimes(sch.globalTimes);
  const marketCount = (cfg.markets || []).filter((m) => m.enabled !== false).length;
  const perMarketConfigured = (cfg.markets || [])
    .filter((m) => m.enabled !== false && m.inspectTimes)
    .map((m) => ({ code: m.code, name: m.name, inspectTimes: m.inspectTimes }));
  return {
    ok: true,
    running: autoInspectRunning,
    enabled: sch.enabled === true,
    mode,
    globalTimes,
    marketCount,
    perMarketConfigured,
    lastRunTime: autoInspectLastRunTime,
    lastRunMarkets: autoInspectLastRunMarkets
  };
}

/* ---------- 钉钉定时发送巡检结果 ---------- */
let autoDingTalkCheckTimer = null;
let autoDingTalkRunning = false;
let autoDingTalkLastRunTime = null;
let _lastDingTalkTriggeredMinute = '';

async function runDingTalkSend(overrideDt) {
  const now = new Date();
  autoDingTalkLastRunTime = now.toLocaleString('zh-CN', { hour12: false });
  const cfg = loadConfig();
  // 优先用调用方传入的临时配置（测试发送场景），否则用 config.json 中的
  const dt = overrideDt || cfg.dingTalk || {};
  if (!dt.enabled || !dt.webhook) {
    logger.warn('钉钉', '未启用或未配置 webhook，跳过发送');
    return { ok: false, detail: '未启用或未配置 webhook' };
  }
  try {
    const { title, markdown, marketCount, anomalyCount } = dingtalk.buildInspectionReport(history, { loadConfig });
    const r = await dingtalk.sendMarkdown({ webhook: dt.webhook, secret: dt.secret }, title, markdown);
    if (r.ok) {
      logger.info('钉钉', `${autoDingTalkLastRunTime} 发送成功：${marketCount} 个市场，${anomalyCount} 个异常`);
    } else {
      logger.warn('钉钉', `${autoDingTalkLastRunTime} 发送失败: ${r.detail}`);
    }
    return r;
  } catch (e) {
    logger.error('钉钉', `${autoDingTalkLastRunTime} 发送异常:`, e.message);
    return { ok: false, detail: e.message };
  }
}

function startAutoDingTalk() {
  stopAutoDingTalk();
  const cfg = loadConfig();
  const dt = cfg.dingTalk || {};
  if (!dt.enabled) { autoDingTalkRunning = false; return; }

  const times = parseFixedTimes(dt.scheduleTimes);
  if (!times.length) {
    logger.warn('钉钉', '已启用但未配置有效时间点（scheduleTimes），跳过');
    return;
  }

  autoDingTalkRunning = true;
  logger.info('钉钉', `定时发送启动：每天 ${times.join(', ')}`);

  autoDingTalkCheckTimer = setInterval(() => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const curMinute = `${hh}:${mm}`;
    if (!times.includes(curMinute)) return;
    if (_lastDingTalkTriggeredMinute === curMinute) return;
    _lastDingTalkTriggeredMinute = curMinute;
    runDingTalkSend();
  }, 60 * 1000);
}

function stopAutoDingTalk() {
  if (autoDingTalkCheckTimer) { clearInterval(autoDingTalkCheckTimer); autoDingTalkCheckTimer = null; }
  autoDingTalkRunning = false;
  logger.info('钉钉', '已停止');
}

function getAutoDingTalkStatus() {
  const cfg = loadConfig();
  const dt = cfg.dingTalk || {};
  const times = parseFixedTimes(dt.scheduleTimes);
  return {
    ok: true,
    running: autoDingTalkRunning,
    enabled: dt.enabled === true,
    webhookConfigured: !!dt.webhook,
    secretConfigured: !!dt.secret,
    scheduleTimes: times,
    scheduleText: times.length ? `每天 ${times.join(', ')}` : '未配置',
    lastRunTime: autoDingTalkLastRunTime
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('请求体非合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    const ext = path.extname(filePath).toLowerCase();
    const noCache = urlPath === '/' || /\.(html|htm|js|css)$/i.test(urlPath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ...(noCache ? { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' } : {})
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const urlPath = (req.url.split('?')[0]) || '/';
  const _start = Date.now();

  // 响应结束时写入访问日志（状态码、耗时、IP、UA）
  res.on('finish', () => accessLog(req, res, Date.now() - _start));

  try {
    // ---- API ----
    if (urlPath === '/api/health') return sendJson(res, 200, { ok: true });

    if (urlPath === '/api/config' && method === 'GET') {
      return sendJson(res, 200, loadConfig());
    }

    if (urlPath === '/api/config' && method === 'PUT') {
      const cfg = await readBody(req);
      if (!cfg || !Array.isArray(cfg.markets)) {
        return sendJson(res, 400, { error: '配置缺少 markets 数组' });
      }
      cfg.settings = cfg.settings || {};
      // 文件命名模式/文件格式/代码后缀为系统固定常量，剔除旧配置中的残留字段
      if (cfg.objectStorage && typeof cfg.objectStorage === 'object') {
        delete cfg.objectStorage.pathPattern;
        delete cfg.objectStorage.fileFormat;
        delete cfg.objectStorage.codeStripSuffix;
      }
      saveConfig(cfg);
      // 配置变更后重启定时同步（如果启用）
      startAutoSync();
      // 配置变更后重启定时巡检（如果启用）
      startAutoInspect();
      // 配置变更后重启钉钉定时发送（如果启用）
      startAutoDingTalk();
      return sendJson(res, 200, { ok: true });
    }

    // ---- 对象存储定时同步状态 ----
    if (urlPath === '/api/auto-sync/status' && method === 'GET') {
      return sendJson(res, 200, getAutoSyncStatus());
    }

    // ---- 定时巡检状态 ----
    if (urlPath === '/api/auto-inspect/status' && method === 'GET') {
      return sendJson(res, 200, getAutoInspectStatus());
    }

    // ---- 钉钉通知 ----
    if (urlPath === '/api/dingtalk/status' && method === 'GET') {
      return sendJson(res, 200, getAutoDingTalkStatus());
    }
    if (urlPath === '/api/dingtalk/test' && method === 'POST') {
      // 支持前端传入临时配置（测试发送无需先保存）
      const body = await readBody(req);
      const overrideDt = (body && body.dingTalk) ? body.dingTalk : null;
      const r = await runDingTalkSend(overrideDt);
      // error 字段让前端 api() 抛出真实原因（否则只显示 "Bad Gateway"）
      return sendJson(res, r.ok ? 200 : 502, { ...r, error: r.ok ? undefined : r.detail });
    }

    if (urlPath === '/api/inspect' && method === 'POST') {
      const body = await readBody(req);
      const zonePick = (v) => (v === 'all' || !v) ? 'all' : (Array.isArray(v) ? v : 'all');
      const marketPick = (v) => {
        if (v === 'all' || !v) return 'all';
        if (Array.isArray(v)) return v;
        return String(v);
      };
      const scope = {
        zones: zonePick(body.zones),
        markets: marketPick(body.markets),
        compareMode: body.compareMode === 'merged' ? 'merged' : 'per-zone',
        maxCodes: body.maxCodes != null ? Number(body.maxCodes) : undefined,
        referenceServerId: body.referenceServerId || null,
        compareAlgorithm: body.compareAlgorithm === 'reference' ? 'reference' : 'majority',
        runId: body.runId || null,
        compareOnly: body.compareOnly === true
      };
      const result = await inspect(loadConfig(), scope);
      // 保存到历史（最近 5 次）
      try { history.saveRun(result, scope); } catch (e) { /* 历史保存失败不影响主流程 */ }
      return sendJson(res, 200, result);
    }

    // ---- 对象存储同步：用 TOS SDK 把 bucket/prefix 下的 b2sum 文件拉到本地 b2sumdata/ ----
    // 密钥直接从 config.json 的 objectStorage 节点读取（accessKey / secretKey）。
    if (urlPath === '/api/sync-b2sum' && method === 'POST') {
      const r = await syncObjectStorage(loadConfig());
      if (r.ok) return sendJson(res, 200, r);
      return sendJson(res, 502, { ok: false, error: r.detail, ...r });
    }

    // ---- 自动发现对象存储中的服务器（列举文件，按 pattern 反解 serverId，并按分区网段统计台数）----
    if (urlPath === '/api/servers/discover' && method === 'POST') {
      try {
        const r = await discoverServers(loadConfig());
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // ---- 本地 b2sumdata 已同步服务器台数（按分区网段分组计数，无需访问对象存储）----
    if (urlPath === '/api/servers/local-counts' && method === 'GET') {
      try {
        const r = countLocalServers(loadConfig());
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // ---- 巡检历史 ----
    if (urlPath === '/api/history' && method === 'GET') {
      return sendJson(res, 200, history.listHistory());
    }
    if (urlPath.startsWith('/api/history/') && method === 'GET') {
      const runId = urlPath.slice('/api/history/'.length);
      const data = history.getRun(runId);
      if (!data) return sendJson(res, 404, { error: '未找到该历史记录' });
      return sendJson(res, 200, data);
    }
    if (urlPath.startsWith('/api/history/') && method === 'DELETE') {
      const runId = urlPath.slice('/api/history/'.length);
      history.deleteRun(runId);
      return sendJson(res, 200, { ok: true });
    }

    // ---- 静态资源 ----
    if (method === 'GET') return serveStatic(req, res, urlPath);

    res.writeHead(404);
    res.end('Not Found');
  } catch (e) {
    logger.error('API', `${method} ${urlPath} 异常:`, e.message);
    sendJson(res, 500, { error: e.message });
  }
});

// 端口绑定 + EADDRINUSE 重试
function listenWithRetry(port, onReady, attempt = 1) {
  const maxAttempts = 60;
  const onError = (err) => {
    server.removeListener('error', onError);
    if (err && err.code === 'EADDRINUSE' && attempt < maxAttempts) {
      const delay = Math.min(120 * attempt, 1000);
      logger.info('启动', `端口 ${port} 暂被占用，第 ${attempt}/${maxAttempts} 次重试（${delay}ms 后）…`);
      setTimeout(() => listenWithRetry(port, onReady, attempt + 1), delay);
    } else {
      logger.error('启动', '服务启动失败:', err && err.message);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, () => {
    server.removeListener('error', onError);
    logger.info('启动', `FCS（File Check System）已启动: http://localhost:${port}`);
    if (typeof onReady === 'function') onReady();
  });
}
listenWithRetry(PORT, () => {
  // 服务启动后初始化定时同步
  startAutoSync();
  // 服务启动后初始化定时巡检
  startAutoInspect();
  // 服务启动后初始化钉钉定时发送
  startAutoDingTalk();
});
