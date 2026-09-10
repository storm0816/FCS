/**
 * 日志模块
 * - 运行日志：log/app-YYYY-MM-DD.log（定时同步/巡检、API 异常、未捕获异常等）
 * - 访问日志：log/access-YYYY-MM-DD.log（每个 HTTP 请求的方法/路径/状态/耗时/IP/UA）
 * 按天分割文件，同时输出到控制台，便于开发期查看。
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR_NAME = 'log';
const LEVEL_LABEL = { error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG' };

function pad2(n) { return String(n).padStart(2, '0'); }

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 检测 log 目录是否存在，不存在自动创建
function logDir() {
  const root = process.env.LOG_DIR
    ? path.resolve(process.env.LOG_DIR)
    : path.join(__dirname, '..', LOG_DIR_NAME);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 同步追加写一行（小项目足够，且避免日志错序） */
function appendLine(file, line) {
  try {
    fs.appendFileSync(file, line + '\n', 'utf-8');
  } catch (e) {
    // 写日志本身失败时退回 console，避免递归
    // eslint-disable-next-line no-console
    console.error('[logger] 写入失败:', e.message);
  }
}

function formatMsg(level, tag, parts) {
  const msg = parts.map((p) => {
    if (p instanceof Error) return p.stack || p.message;
    if (typeof p === 'string') return p;
    try { return JSON.stringify(p); } catch (e) { return String(p); }
  }).join(' ');
  return `${nowStamp()} [${LEVEL_LABEL[level] || level.toUpperCase()}] ${tag ? `[${tag}] ` : ''}${msg}`;
}

/**
 * 运行日志：写入 app-YYYY-MM-DD.log，并镜像到 console。
 * @param {'info'|'warn'|'error'|'debug'} level
 * @param {string} tag 分类标签，如 '定时同步'、'定时巡检'、'API'、'启动'
 * @param {...any} args 同 console 风格的可变参数
 */
function runtimeLog(level, tag, ...args) {
  const line = formatMsg(level, tag, args);
  appendLine(path.join(logDir(), `app-${todayStamp()}.log`), line);
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  // eslint-disable-next-line no-console
  console[fn](line);
}

const logger = {
  info: (tag, ...args) => runtimeLog('info', tag, ...args),
  warn: (tag, ...args) => runtimeLog('warn', tag, ...args),
  error: (tag, ...args) => runtimeLog('error', tag, ...args),
  debug: (tag, ...args) => runtimeLog('debug', tag, ...args),
  log: (tag, ...args) => runtimeLog('info', tag, ...args)
};

/**
 * 访问日志：写入 access-YYYY-MM-DD.log。
 * @param {object} req HTTP 请求
 * @param {object} res HTTP 响应
 * @param {number} durationMs 处理耗时（毫秒）
 */
function accessLog(req, res, durationMs) {
  try {
    const url = (req.url || '').split('?')[0] || '/';
    const method = req.method || '-';
    const status = res.statusCode || 0;
    const ip = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']))
      || (req.socket && req.socket.remoteAddress)
      || '-';
    const ua = (req.headers && req.headers['user-agent']) || '-';
    const line = `${nowStamp()} ${method} ${url} ${status} ${durationMs}ms ${ip} "${ua.replace(/"/g, "'")}"`;
    appendLine(path.join(logDir(), `access-${todayStamp()}.log`), line);
  } catch (e) {
    runtimeLog('error', '访问日志', '记录失败:', e.message);
  }
}

/** 安装全局未捕获异常与未处理 Promise rejection 捕获，写入运行日志 */
function installGlobalHandlers() {
  process.on('uncaughtException', (err) => {
    runtimeLog('error', '未捕获异常', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (reason) => {
    runtimeLog('error', '未处理Promise', reason && reason.stack ? reason.stack : reason);
  });
}

module.exports = { logger, accessLog, installGlobalHandlers, logDir };
