const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID, randomBytes } = require('crypto');
const { loadConfig, saveConfig, setRuntimeConfig } = require('./src/config');
const { inspect } = require('./src/inspector');
const { initDatabase, listZones, listMarkets, syncZonesAndMarkets, seedZonesAndMarkets, seedSystemSettings, getSystemSettings, saveSystemSettings, listBusinessSystems, listBusinessSystemAgents, saveBusinessSystemAgents, saveBusinessSystem, deleteBusinessSystem, listDatasets, getDataset, saveDataset, deleteDataset, listDatasetBindings, saveDatasetBindings, listAgentTags, saveAgentTags, listAgentTagPartitions, saveAgentTagPartition, deleteAgentTagPartition, authenticateUser, getUserSecurity, setUserMfa, createSession, deleteSession, getSession, cleanupExpiredSessions, upsertLdapUser, listUsers, saveUser, deleteUser, recordAudit, listRoles, saveRole, deleteRole, listPermissions, getRolePermissions, setRolePermissions, assignUserRoles, getUserRoles, hasPermission, getUserPermissions, listAuditLogs, listInspectionPlans, saveInspectionPlan, deleteInspectionPlan, listInspectionSchedules, saveInspectionSchedule, deleteInspectionSchedule, createDataRelease, updateDataRelease, listDataReleases, listDataTasks, createDataTask, setDataTask, retryDataTask, cancelDataTask } = require('./src/database');
const { authenticateLdap } = require('./src/ldap');
const agentService = require('./src/agentService');
const { getDashboardSummary } = require('./src/dashboardService');
const { logger, accessLog, installGlobalHandlers } = require('./src/logger');
const dingtalk = require('./src/dingtalk');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function base32Decode(value) { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const ch of String(value || '').toUpperCase().replace(/=+$/, '')) { const n = alphabet.indexOf(ch); if (n < 0) continue; bits += n.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function verifyTotp(secret, token, window = 1) { const key = base32Decode(secret); if (!key.length || !/^\d{6}$/.test(String(token || ''))) return false; const counter = Math.floor(Date.now() / 30000); for (let offset = -window; offset <= window; offset++) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter + offset)); const h = require('crypto').createHmac('sha1', key).update(b).digest(); const p = h[h.length - 1] & 15; const code = ((h[p] & 127) << 24 | h[p + 1] << 16 | h[p + 2] << 8 | h[p + 3]) % 1000000; if (String(code).padStart(6, '0') === String(token)) return true; } return false; }
function parseCookies(header) { return Object.fromEntries(String(header || '').split(';').map((x) => x.trim().split('=').map(decodeURIComponent)).filter((x) => x[0])); }
async function establishSession(res, user, req) { const token = randomBytes(32).toString('hex'); const expires = new Date(Date.now() + 8 * 60 * 60 * 1000); await createSession(token, user.username, expires, req.socket.remoteAddress, String(req.headers['user-agent'] || '').slice(0, 512)); res.setHeader('Set-Cookie', `fcs_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`); return token; }

const loginAttempts = new Map();
function loginAttemptKey(req, username) { return `${req.socket.remoteAddress || ''}|${String(username || '').trim().toLowerCase()}`; }
function isLoginBlocked(key) { const item = loginAttempts.get(key); if (!item) return false; if (item.blockedUntil > Date.now()) return true; if (Date.now() - item.firstAt > 5 * 60 * 1000) loginAttempts.delete(key); return false; }
function recordLoginFailure(key) { const now = Date.now(); const old = loginAttempts.get(key); const item = !old || now - old.firstAt > 5 * 60 * 1000 ? { count: 0, firstAt: now, blockedUntil: 0 } : old; item.count += 1; if (item.count >= 5) item.blockedUntil = now + 15 * 60 * 1000; loginAttempts.set(key, item); }
function requiredPermission(method, urlPath) {
  if (!urlPath.startsWith('/api/') || urlPath === '/api/health' || urlPath.startsWith('/api/auth/')) return null;
  if (urlPath.startsWith('/api/agent/')) return null;
  if (/^\/api\/data\/tasks\/[^/]+\/(report|progress|status)$/.test(urlPath) || /^\/api\/data\/releases\/[^/]+\/(upload|download)$/.test(urlPath)) return null;
  if (urlPath.startsWith('/api/users') || urlPath.startsWith('/api/roles') || urlPath === '/api/permissions') return 'user.manage';
  if (urlPath.startsWith('/api/business-systems') || urlPath.startsWith('/api/datasets') || urlPath.startsWith('/api/agent-tag-partitions') || urlPath === '/api/agents/tags/batch' || /\/api\/agents\/[^/]+\/(tags)$/.test(urlPath)) return method === 'GET' ? 'system.read' : 'system.write';
  if (urlPath.startsWith('/api/inspection-plans')) return method === 'GET' ? 'system.read' : 'inspection.execute';
  if (urlPath.startsWith('/api/inspection-schedules')) return method === 'GET' ? 'system.read' : 'inspection.execute';
  if (urlPath === '/api/audit-logs') return 'audit.read';
  if (urlPath === '/api/config') return method === 'GET' ? 'system.read' : 'system.write';
  if (urlPath === '/api/inspect' || urlPath === '/api/inspections') return 'inspection.execute';
  if (urlPath.startsWith('/api/data/')) return 'release.manage';
  if (urlPath.startsWith('/api/history/')) return method === 'DELETE' ? 'inspection.execute' : 'system.read';
  if (urlPath === '/api/dingtalk/test') return 'system.write';
  return 'system.read';
}

async function loadRuntimeConfig() {
  const cfg = loadConfig();
  const systemSettings = await getSystemSettings();
  for (const key of ['settings', 'objectStorage', 'ldap', 'dingTalk']) if (systemSettings[key] !== undefined) cfg[key] = systemSettings[key];
  cfg.zones = await listZones();
  cfg.markets = await listMarkets();
  setRuntimeConfig(cfg);
  return cfg;
}

// 安装全局未捕获异常 / Promise rejection 捕获，写入运行日志
installGlobalHandlers();

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

/* ---------- 巡检方案定时执行 ---------- */
let autoDatasetInspectCheckTimer = null;
let _lastDatasetInspectTriggeredMinute = '';

async function runScheduledDatasetInspections() {
  const cfg = loadConfig();
  const now = new Date();
  const minute = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (_lastDatasetInspectTriggeredMinute === minute) return;
  const schedules = (await listInspectionSchedules()).filter((item) => item.enabled && parseFixedTimes(item.schedule_times).includes(minute));
  if (!schedules.length) return;
  _lastDatasetInspectTriggeredMinute = minute;
  const runtimeConfig = await loadRuntimeConfig();
  for (const schedule of schedules) {
    try {
      let scope = { zones: 'all', triggerType: 'scheduled' };
      const plan = (await listInspectionPlans()).find((item) => item.plan_id === schedule.plan_id && item.enabled);
      if (!plan) throw new Error(`关联巡检方案不存在或已停用：${schedule.plan_id}`);
      {
        const plannedScope = typeof plan.scope_json === 'string' ? JSON.parse(plan.scope_json) : (plan.scope || {});
        scope = { ...plannedScope, triggerType: 'scheduled', planId: plan.plan_id, planName: plan.name };
      }
      const task = await agentService.createDatasetTask(plan.dataset_id, scope, runtimeConfig);
      logger.info('定时巡检', `方案 ${plan.name} 已下发任务 ${task.taskId}，在线 Agent ${task.expectedAgents} 台`);
    } catch (error) {
      logger.error('定时巡检', `方案 ${schedule.plan_id} 下发失败:`, error.message);
    }
  }
}

function startAutoDatasetInspect() {
  if (autoDatasetInspectCheckTimer) clearInterval(autoDatasetInspectCheckTimer);
  runScheduledDatasetInspections().catch((error) => logger.error('定时巡检', '数据集定时检查失败:', error.message));
  autoDatasetInspectCheckTimer = setInterval(() => runScheduledDatasetInspections().catch((error) => logger.error('定时巡检', '数据集定时检查失败:', error.message)), 15 * 1000);
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
  // 优先用调用方传入的临时配置（测试发送场景），否则用运行时系统设置
  const dt = overrideDt || cfg.dingTalk || {};
  if (!dt.enabled || !dt.webhook) {
    logger.warn('钉钉', '未启用或未配置 webhook，跳过发送');
    return { ok: false, detail: '未启用或未配置 webhook' };
  }
  try {
    const hist = await agentService.listHistory();
    const { title, markdown, marketCount, anomalyCount } = dingtalk.buildInspectionReport(hist, cfg);
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

async function sendFailureAlert(title, message) {
  const dt = (loadConfig().dingTalk || {});
  if (!dt.enabled || !dt.webhook || dt.notifyOnFailure === false) return;
  try {
    const result = await dingtalk.sendMarkdown({ webhook: dt.webhook, secret: dt.secret }, title, `### ${title}\n\n${message}\n\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    if (!result.ok) logger.warn('钉钉', `失败告警发送失败: ${result.detail || 'unknown'}`);
  } catch (error) { logger.warn('钉钉', `失败告警异常: ${error.message}`); }
}
const offlineAgentAlerts = new Set();
async function checkOfflineAgentAlerts() {
  const conn = require('./src/database').db();
  const [rows] = await conn.query("SELECT agent_id,hostname,inner_ip,(last_seen_at < DATE_SUB(NOW(), INTERVAL 180 SECOND)) AS offline FROM fcs_agents");
  const current = new Set(rows.filter((row) => row.offline).map((row) => row.agent_id));
  for (const row of rows) if (row.offline && !offlineAgentAlerts.has(row.agent_id)) { offlineAgentAlerts.add(row.agent_id); void sendFailureAlert('FCS Agent 离线告警', `Agent：${row.hostname || row.agent_id}\n\n内网 IP：${row.inner_ip}\n\n已超过 180 秒未收到心跳`); }
  for (const row of rows) if (!row.offline && offlineAgentAlerts.has(row.agent_id)) { offlineAgentAlerts.delete(row.agent_id); void sendFailureAlert('FCS Agent 恢复在线', `Agent：${row.hostname || row.agent_id}\n\n内网 IP：${row.inner_ip}\n\n已重新收到心跳`); }
  for (const id of [...offlineAgentAlerts]) if (!current.has(id)) offlineAgentAlerts.delete(id);
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
  let rel = urlPath === '/' ? '/index.html' : (urlPath === '/login' ? '/login.html' : urlPath);
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
    const permissionByPath = requiredPermission(method, urlPath);
    if (permissionByPath && !(urlPath === '/api/auth/login')) { const sid = parseCookies(req.headers.cookie).fcs_session; const session = sid ? await getSession(sid) : null; if (!session) return sendJson(res, 401, { error: '未登录或会话已过期' }); if (!(await hasPermission(session.username, permissionByPath))) return sendJson(res, 403, { error: '无权限' }); req.fcsUser = session; }
    if (urlPath === '/api/data/releases' && method === 'GET') { const releases = await listDataReleases(); for (const release of releases) release.tasks = await listDataTasks(release.release_id); return sendJson(res, 200, { releases }); }
    const retryTaskMatch = urlPath.match(/^\/api\/data\/tasks\/([^/]+)\/retry$/);
    if (retryTaskMatch && method === 'POST') { const taskId = decodeURIComponent(retryTaskMatch[1]); const result = await retryDataTask(taskId); await recordAudit(req.fcsUser?.username || '', 'dataset.release.retry', taskId, result, req.socket.remoteAddress); return sendJson(res, 202, { ok: true, ...result }); }
    const cancelTaskMatch = urlPath.match(/^\/api\/data\/tasks\/([^/]+)\/cancel$/);
    if (cancelTaskMatch && method === 'POST') { const taskId = decodeURIComponent(cancelTaskMatch[1]); const result = await cancelDataTask(taskId); await recordAudit(req.fcsUser?.username || '', 'dataset.release.cancel', taskId, result, req.socket.remoteAddress); return sendJson(res, 200, { ok: true, ...result }); }
    if (urlPath === '/api/data/releases' && method === 'POST') {
      const body = await readBody(req);
      if (body.datasetId) {
        if (!body.sourceAgentId) return sendJson(res, 400, { error: '发布源 Agent 为必填项' });
        const dataset = await getDataset(String(body.datasetId));
        if (!dataset || !dataset.enabled) return sendJson(res, 400, { error: '数据集不存在或已禁用' });
        let bindings = (await listDatasetBindings(dataset.dataset_id)).filter((item) => item.enabled);
        if (!bindings.length) {
          const systemBindings = (await listBusinessSystemAgents(dataset.system_id)).filter((item) => item.enabled);
          bindings = systemBindings.map((item) => ({ agentId: item.agentId, enabled: true, sourceDirOverride: '', targetDirOverride: '' }));
        }
        if (!bindings.length) return sendJson(res, 400, { error: '数据集未配置适用 Agent，请先关联业务系统 Agent 或绑定数据集 Agent' });
        const bindingByAgent = new Map(bindings.map((item) => [String(item.agentId), item]));
        const sourceId = String(body.sourceAgentId);
        const sourceBinding = bindingByAgent.get(sourceId);
        if (!sourceBinding) return sendJson(res, 400, { error: '发布源 Agent 未绑定该数据集' });
        let targets = Array.isArray(body.targetAgentIds) ? body.targetAgentIds.map(String) : [];
        if (!targets.length) targets = bindings.map((item) => String(item.agentId)).filter((agentId) => agentId !== sourceId);
        targets = targets.filter((agentId) => agentId !== sourceId && bindingByAgent.has(agentId));
        if (!targets.length) return sendJson(res, 400, { error: '请至少选择一台已绑定的目标 Agent' });
        const sourceDir = sourceBinding.sourceDirOverride || dataset.sourceDir || '';
        if (!path.posix.isAbsolute(sourceDir)) return sendJson(res, 400, { error: '数据集源目录必须是绝对路径' });
        const targetDataDirs = Object.fromEntries(targets.map((agentId) => {
          const binding = bindingByAgent.get(agentId); return [agentId, binding.targetDirOverride || dataset.targetDir || sourceDir];
        }));
        const invalidTarget = Object.entries(targetDataDirs).find(([, targetDir]) => !path.posix.isAbsolute(targetDir));
        if (invalidTarget) return sendJson(res, 400, { error: `目标 Agent ${invalidTarget[0]} 未配置绝对路径的目标目录` });
        const releaseId = randomUUID();
        const safeCode = String(dataset.dataset_code).replace(/[^a-zA-Z0-9_.-]/g, '_');
        const objectKey = `${((await loadRuntimeConfig()).objectStorage || {}).prefix || 'fcs/releases'}/data/${safeCode}/${releaseId}.tar.gz`;
        await createDataRelease(releaseId, String(dataset.dataset_code), sourceId, objectKey, { systemId: dataset.system_id, datasetId: dataset.dataset_id });
        const taskId = randomUUID();
        await createDataTask(taskId, releaseId, sourceId, 'publish', { datasetId: dataset.dataset_id, dataDir: sourceDir, filePattern: dataset.filePatterns || '*', targetAgentIds: targets, targetDataDirs });
        await recordAudit(req.fcsUser?.username || '', 'dataset.release.create', dataset.dataset_id, { releaseId, sourceAgentId: sourceId, targetAgentIds: targets }, req.socket.remoteAddress);
        return sendJson(res, 202, { ok: true, releaseId, taskId, status: 'pending', objectKey, datasetId: dataset.dataset_id });
      }
      return sendJson(res, 400, { error: '发布任务必须选择业务数据集' });
    }
    const dataReportMatch = urlPath.match(/^\/api\/data\/tasks\/([^/]+)\/report$/);
    if (dataReportMatch && method === 'POST') {
      const body = await readBody(req); const taskId = decodeURIComponent(dataReportMatch[1]); const db = require('./src/database').db();
      const [taskRows] = await db.execute('SELECT release_id,agent_id,action,detail,status FROM fcs_data_tasks WHERE task_id=? LIMIT 1', [taskId]); const taskRow = taskRows[0];
      if (!taskRow) return sendJson(res, 404, { error: '数据任务不存在' });
      if (taskRow.status === 'cancelled') return sendJson(res, 409, { error: '任务已取消' });
      await setDataTask(taskId, body.ok ? 'completed' : 'failed', body.detail || '');
      if (!body.ok) {
        if (taskRow.release_id) await updateDataRelease(taskRow.release_id, { status: 'failed' });
        if (taskRow.status !== 'failed') void sendFailureAlert('FCS 发布/下载任务失败', `发布任务：${taskRow.release_id || '-'}\n\nAgent：${taskRow.agent_id}\n\n阶段：${taskRow.action}\n\n原因：${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail || {})}`);
        return sendJson(res, 200, { ok: true });
      }
      if (taskRow.action === 'publish' && taskRow.release_id) {
        await updateDataRelease(taskRow.release_id, { status: 'uploaded', sha256: body.sha256, sizeBytes: body.sizeBytes });
        const [releaseRows] = await db.execute('SELECT source_agent_id,object_key FROM fcs_data_releases WHERE release_id=? LIMIT 1', [taskRow.release_id]);
        const publishDetail = JSON.parse(taskRow.detail || '{}'); const targets = publishDetail.targetAgentIds || []; const targetDataDirs = publishDetail.targetDataDirs || {};
        const bucket = ((await loadRuntimeConfig()).objectStorage || {}).bucket;
        for (const agentId of targets) if (agentId !== releaseRows[0]?.source_agent_id) await createDataTask(randomUUID(), taskRow.release_id, agentId, 'download', { tosUri: bucket && releaseRows[0]?.object_key ? `tos://${bucket}/${releaseRows[0].object_key}` : '', dataDir: targetDataDirs[agentId] || '' });
      }
      return sendJson(res, 200, { ok: true });
    }
    const dataProgressMatch = urlPath.match(/^\/api\/data\/tasks\/([^/]+)\/progress$/);
    if (dataProgressMatch && method === 'POST') { const body = await readBody(req); const taskId = decodeURIComponent(dataProgressMatch[1]); const detail = body.detail || {}; const status = ['processing', 'dispatched'].includes(String(body.status)) ? String(body.status) : 'processing'; await setDataTask(taskId, status, detail); return sendJson(res, 200, { ok: true, taskId, status }); }
    const dataStatusMatch = urlPath.match(/^\/api\/data\/tasks\/([^/]+)\/status$/);
    if (dataStatusMatch && method === 'GET') { const taskId = decodeURIComponent(dataStatusMatch[1]); const [rows] = await require('./src/database').db().execute('SELECT task_id,status FROM fcs_data_tasks WHERE task_id=? LIMIT 1', [taskId]); return rows[0] ? sendJson(res, 200, rows[0]) : sendJson(res, 404, { error: '数据任务不存在' }); }
    if (urlPath === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const attemptKey = loginAttemptKey(req, body.username);
      if (isLoginBlocked(attemptKey)) return sendJson(res, 429, { ok: false, error: '登录失败次数过多，请 15 分钟后重试' });
      const user = await authenticateUser(body.username, body.password);
      if (user && user.mfa_enabled && !verifyTotp((await getUserSecurity(user.username))?.mfa_secret, body.mfaToken)) return sendJson(res, 401, { ok: false, mfaRequired: true, error: '需要 MFA 验证码' });
      if (user) { loginAttempts.delete(attemptKey); await establishSession(res, user, req); await recordAudit(user.username, 'login.success', 'auth', { source: 'local' }, req.socket.remoteAddress); }
      if (!user) {
        const runtimeConfig = await loadRuntimeConfig();
        const ldapUser = await authenticateLdap(body.username, body.password, runtimeConfig.ldap || {});
        if (ldapUser) {
          const mapped = await upsertLdapUser(ldapUser.username, ldapUser.displayName, ldapUser.externalId);
          if (mapped) {
            const security = await getUserSecurity(mapped.username);
            if (security?.mfa_enabled && !verifyTotp(security.mfa_secret, body.mfaToken)) return sendJson(res, 401, { ok: false, mfaRequired: true, error: '需要 MFA 验证码' });
            loginAttempts.delete(attemptKey); await establishSession(res, mapped, req); await recordAudit(mapped.username, 'login.success', 'auth', { source: 'ldap' }, req.socket.remoteAddress); return sendJson(res, 200, { ok: true, user: mapped });
          }
        }
      }
      if (!user) { recordLoginFailure(attemptKey); await recordAudit(String(body.username || ''), 'login.failure', 'auth', {}, req.socket.remoteAddress); }
      return user ? sendJson(res, 200, { ok: true, user }) : sendJson(res, 401, { ok: false, error: '用户名或密码错误' });
    }
    if (urlPath === '/api/auth/me' && method === 'GET') {
      const sid = parseCookies(req.headers.cookie).fcs_session;
      const session = sid ? await getSession(sid) : null;
      if (!session) return sendJson(res, 401, { ok: false, error: '未登录或会话已过期' });
      return sendJson(res, 200, { ok: true, user: { username: session.username, displayName: session.display_name || session.username }, permissions: await getUserPermissions(session.username) });
    }
    if (urlPath === '/api/roles' && method === 'GET') return sendJson(res, 200, { roles: await listRoles() });
    if (urlPath === '/api/roles' && method === 'POST') { const body = await readBody(req); if (!/^[a-z][a-z0-9_.-]*$/.test(String(body.roleId || '')) || !String(body.roleName || '').trim()) return sendJson(res, 400, { error: '角色代码或名称不合法' }); await saveRole(body.roleId, body.roleName, body.description); await recordAudit(req.fcsUser?.username || '', 'role.save', body.roleId, {}, req.socket.remoteAddress); return sendJson(res, 200, { ok: true }); }
    const roleDeleteMatch = urlPath.match(/^\/api\/roles\/([^/]+)$/);
    if (roleDeleteMatch && method === 'DELETE') { const roleId = decodeURIComponent(roleDeleteMatch[1]); await deleteRole(roleId); await recordAudit(req.fcsUser?.username || '', 'role.delete', roleId, {}, req.socket.remoteAddress); return sendJson(res, 200, { ok: true }); }
    if (urlPath === '/api/permissions' && method === 'GET') return sendJson(res, 200, { permissions: await listPermissions() });
    const rolePermissionMatch = urlPath.match(/^\/api\/roles\/([^/]+)\/permissions$/);
    if (rolePermissionMatch && method === 'GET') return sendJson(res, 200, { permissions: await getRolePermissions(decodeURIComponent(rolePermissionMatch[1])) });
    if (rolePermissionMatch && method === 'PUT') { const body = await readBody(req); const roleId = decodeURIComponent(rolePermissionMatch[1]); await setRolePermissions(roleId, body.permissionIds || []); await recordAudit(req.fcsUser?.username || '', 'role.permissions.update', roleId, { permissionIds: body.permissionIds || [] }, req.socket.remoteAddress); return sendJson(res, 200, { ok: true }); }
    if (urlPath === '/api/auth/logout' && method === 'POST') { const sid = parseCookies(req.headers.cookie).fcs_session; if (sid) { const session = await getSession(sid); await deleteSession(sid); await recordAudit(session?.username || '', 'logout', 'auth', {}, req.socket.remoteAddress); } res.setHeader('Set-Cookie', 'fcs_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); return sendJson(res, 200, { ok: true }); }
    const mfaMatch = urlPath.match(/^\/api\/users\/([^/]+)\/mfa$/);
    if (mfaMatch && method === 'GET') { const security = await getUserSecurity(decodeURIComponent(mfaMatch[1])); return security ? sendJson(res, 200, { enabled: !!security.mfa_enabled }) : sendJson(res, 404, { error: '用户不存在' }); }
    if (mfaMatch && method === 'PUT') { const body = await readBody(req); const name = decodeURIComponent(mfaMatch[1]); if (body.enabled && !/^[A-Z2-7]{16,128}$/i.test(String(body.secret || '').replace(/\s+/g, ''))) return sendJson(res, 400, { error: '请输入合法的 Base32 MFA 密钥' }); await setUserMfa(name, body.enabled === true, body.enabled ? String(body.secret).replace(/\s+/g, '') : ''); await recordAudit(req.fcsUser?.username || '', body.enabled ? 'mfa.enable' : 'mfa.disable', name, {}, req.socket.remoteAddress); return sendJson(res, 200, { ok: true }); }
    if (urlPath === '/api/auth/mfa/verify' && method === 'POST') { const body = await readBody(req); const security = await getUserSecurity(body.username); const ok = !!(security && security.mfa_enabled && verifyTotp(security.mfa_secret, body.token)); if (ok) await recordAudit(security.username, 'mfa.verify.success', 'auth', {}, req.socket.remoteAddress); else await recordAudit(body.username, 'mfa.verify.failure', 'auth', {}, req.socket.remoteAddress); return sendJson(res, ok ? 200 : 401, { ok }); }
    if (/^\/api\/users\/[^/]+\/roles$/.test(urlPath) && method === 'GET') { const name = decodeURIComponent(urlPath.split('/')[3]); return sendJson(res, 200, { roles: await getUserRoles(name) }); }
    if (/^\/api\/users\/[^/]+\/roles$/.test(urlPath) && method === 'PUT') { const name = decodeURIComponent(urlPath.split('/')[3]); const body = await readBody(req); await assignUserRoles(name, body.roleIds || []); await recordAudit(req.fcsUser?.username || '', 'user.roles.update', name, { roleIds: body.roleIds || [] }, req.socket.remoteAddress); return sendJson(res, 200, { ok: true }); }
    if (urlPath === '/api/audit-logs' && method === 'GET') return sendJson(res, 200, { logs: await listAuditLogs(new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('limit')) });
    if (urlPath === '/api/users' && method === 'GET') return sendJson(res, 200, { users: await listUsers() });
    if (urlPath === '/api/users' && method === 'POST') {
      const body = await readBody(req); if (body.password && String(body.password).length < 12) return sendJson(res, 400, { error: '密码至少 12 位' }); await saveUser(body.username, body.password, body.displayName, body.enabled !== false); await recordAudit(req.fcsUser?.username || '', 'user.save', body.username, { enabled: body.enabled !== false }, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true });
    }
    if (urlPath === '/api/users/admin/password' && method === 'PUT') { const body = await readBody(req); const current = await authenticateUser('admin', body.currentPassword); if (!current || !body.newPassword || String(body.newPassword).length < 12 || body.newPassword !== body.confirmPassword) return sendJson(res, 400, { error: '当前密码或新密码校验失败' }); await saveUser('admin', body.newPassword, 'admin', true); await recordAudit('admin', 'password.change', 'auth', {}, req.socket.remoteAddress); return sendJson(res, 200, { ok: true }); }
    if (urlPath.startsWith('/api/users/') && method === 'DELETE') {
      const name = decodeURIComponent(urlPath.slice('/api/users/'.length)); await deleteUser(name); await recordAudit(req.fcsUser?.username || '', 'user.delete', name, {}, req.socket.remoteAddress); return sendJson(res, 200, { ok: true });
    }

    if (urlPath === '/api/agent/heartbeat' && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await agentService.heartbeat(body, await loadRuntimeConfig()));
    }
    if (urlPath === '/api/agent/report' && method === 'POST') {
      const body = await readBody(req);
      const result = await agentService.submitReport(body, await loadRuntimeConfig());
      if (body.error) void sendFailureAlert('FCS 巡检 Agent 上报失败', `任务：${body.taskId}\n\nAgent：${body.agentId}\n\n原因：${body.error}`);
      const taskStatus = await agentService.taskStatus(String(body.taskId || ''));
      if (taskStatus?.status === 'failed' && !body.error) void sendFailureAlert('FCS 巡检任务失败', `任务：${body.taskId}\n\n原因：${taskStatus.result?.error || '巡检对比失败'}`);
      return sendJson(res, 202, result);
    }
    if (urlPath.startsWith('/api/agent/tasks/') && method === 'GET') {
      const task = await agentService.taskStatus(urlPath.slice('/api/agent/tasks/'.length));
      return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: '巡检任务不存在' });
    }
    if (urlPath === '/api/agents/zone-counts' && method === 'GET') {
      return sendJson(res, 200, await agentService.zoneCounts(await loadRuntimeConfig()));
    }
    if (urlPath === '/api/agents' && method === 'GET') {
      return sendJson(res, 200, { agents: await agentService.listAgents(await loadRuntimeConfig()) });
    }

    if (urlPath === '/api/inspection-plans' && method === 'GET') {
      return sendJson(res, 200, { plans: await listInspectionPlans() });
    }
    if (urlPath === '/api/inspection-plans' && method === 'POST') {
      const body = await readBody(req); const dataset = await getDataset(body.datasetId);
      if (!dataset || !dataset.enabled) return sendJson(res, 400, { error: '数据集不存在或已禁用' });
      const planId = await saveInspectionPlan({ ...body, createdBy: req.fcsUser?.username || '' });
      await recordAudit(req.fcsUser?.username || '', 'inspection-plan.save', planId, { datasetId: dataset.dataset_id }, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true, planId });
    }
    const inspectionPlanMatch = urlPath.match(/^\/api\/inspection-plans\/([^/]+)$/);
    if (inspectionPlanMatch && method === 'PUT') {
      const body = await readBody(req); const planId = decodeURIComponent(inspectionPlanMatch[1]); const dataset = await getDataset(body.datasetId);
      if (!dataset || !dataset.enabled) return sendJson(res, 400, { error: '数据集不存在或已禁用' });
      await saveInspectionPlan({ ...body, planId, createdBy: req.fcsUser?.username || '' });
      await recordAudit(req.fcsUser?.username || '', 'inspection-plan.save', planId, { datasetId: dataset.dataset_id }, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true, planId });
    }
    if (inspectionPlanMatch && method === 'DELETE') {
      const planId = decodeURIComponent(inspectionPlanMatch[1]); await deleteInspectionPlan(planId);
      await recordAudit(req.fcsUser?.username || '', 'inspection-plan.delete', planId, {}, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true });
    }
    if (urlPath === '/api/inspection-schedules' && method === 'GET') return sendJson(res, 200, { schedules: await listInspectionSchedules() });
    if (urlPath === '/api/inspection-schedules' && method === 'POST') { const body = await readBody(req); const plan = (await listInspectionPlans()).find((item) => item.plan_id === String(body.planId || '') && item.enabled); if (!plan) return sendJson(res, 400, { error: '请选择有效的启用巡检方案' }); const scheduleId = await saveInspectionSchedule({ ...body, createdBy: req.fcsUser?.username || '' }); await recordAudit(req.fcsUser?.username || '', 'inspection-schedule.save', scheduleId, { planId: plan.plan_id }, req.socket.remoteAddress); return sendJson(res, 200, { ok: true, scheduleId }); }
    const scheduleMatch = urlPath.match(/^\/api\/inspection-schedules\/([^/]+)$/);
    if (scheduleMatch && method === 'PUT') { const body = await readBody(req); const plan = (await listInspectionPlans()).find((item) => item.plan_id === String(body.planId || '') && item.enabled); if (!plan) return sendJson(res, 400, { error: '请选择有效的启用巡检方案' }); const scheduleId = decodeURIComponent(scheduleMatch[1]); await saveInspectionSchedule({ ...body, scheduleId, createdBy: req.fcsUser?.username || '' }); return sendJson(res, 200, { ok: true, scheduleId }); }
    if (scheduleMatch && method === 'DELETE') { const scheduleId = decodeURIComponent(scheduleMatch[1]); await deleteInspectionSchedule(scheduleId); await recordAudit(req.fcsUser?.username || '', 'inspection-schedule.delete', scheduleId, {}, req.socket.remoteAddress); return sendJson(res, 200, { ok: true }); }

    if (urlPath === '/api/inspections' && method === 'POST') {
      const body = await readBody(req);
      if (!body.datasetId) return sendJson(res, 400, { error: 'datasetId 为必填项' });
      const runtimeConfig = await loadRuntimeConfig();
      const task = await agentService.createDatasetTask(body.datasetId, { zones: body.zones || 'all', agentIds: body.agentIds || [], tags: body.tags || [], referenceServerId: body.referenceServerId || '', compareMode: body.compareMode === 'merged' ? 'merged' : 'per-zone', compareAlgorithm: body.compareAlgorithm === 'reference' ? 'reference' : 'majority', triggerType: body.triggerType || 'manual', planId: String(body.planId || ''), planName: String(body.planName || '') }, runtimeConfig);
      await recordAudit(req.fcsUser?.username || '', 'dataset.inspection.create', String(body.datasetId), { taskId: task.taskId, agents: task.agentIds, tags: body.tags || [] }, req.socket.remoteAddress);
      return sendJson(res, 202, { ok: true, ...task });
    }

    if (urlPath === '/api/business-systems' && method === 'GET') return sendJson(res, 200, { systems: await listBusinessSystems() });
    if (urlPath === '/api/business-systems' && method === 'POST') {
      const body = await readBody(req); await saveBusinessSystem(body);
      await recordAudit(req.fcsUser?.username || '', 'business-system.save', String(body.systemId || ''), {}, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true });
    }
    const systemMatch = urlPath.match(/^\/api\/business-systems\/([^/]+)$/);
    if (systemMatch && method === 'PUT') {
      const body = await readBody(req); body.systemId = decodeURIComponent(systemMatch[1]); await saveBusinessSystem(body);
      await recordAudit(req.fcsUser?.username || '', 'business-system.save', body.systemId, {}, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true });
    }
    if (systemMatch && method === 'DELETE') {
      const systemId = decodeURIComponent(systemMatch[1]); await deleteBusinessSystem(systemId);
      await recordAudit(req.fcsUser?.username || '', 'business-system.delete', systemId, {}, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true });
    }
    const systemAgentsMatch = urlPath.match(/^\/api\/business-systems\/([^/]+)\/agents$/);
    if (systemAgentsMatch && method === 'GET') return sendJson(res, 200, { bindings: await listBusinessSystemAgents(decodeURIComponent(systemAgentsMatch[1])) });
    if (systemAgentsMatch && method === 'PUT') { const body = await readBody(req); const systemId = decodeURIComponent(systemAgentsMatch[1]); await saveBusinessSystemAgents(systemId, body.bindings || []); await recordAudit(req.fcsUser?.username || '', 'business-system.agents.save', systemId, { total: (body.bindings || []).length }, req.socket.remoteAddress); return sendJson(res, 200, { ok: true }); }
    if (urlPath === '/api/datasets' && method === 'GET') {
      const systemId = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('systemId') || '';
      return sendJson(res, 200, { datasets: await listDatasets(systemId) });
    }
    if (urlPath === '/api/datasets' && method === 'POST') {
      const body = await readBody(req); await saveDataset(body);
      await recordAudit(req.fcsUser?.username || '', 'dataset.save', String(body.datasetId || ''), {}, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true });
    }
    const datasetMatch = urlPath.match(/^\/api\/datasets\/([^/]+)$/);
    if (datasetMatch && method === 'GET') { const item = await getDataset(decodeURIComponent(datasetMatch[1])); return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: '数据集不存在' }); }
    if (datasetMatch && method === 'PUT') {
      const body = await readBody(req); body.datasetId = decodeURIComponent(datasetMatch[1]); await saveDataset(body);
      await recordAudit(req.fcsUser?.username || '', 'dataset.save', body.datasetId, {}, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true });
    }
    if (datasetMatch && method === 'DELETE') {
      const datasetId = decodeURIComponent(datasetMatch[1]); await deleteDataset(datasetId);
      await recordAudit(req.fcsUser?.username || '', 'dataset.delete', datasetId, {}, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true });
    }
    const bindingMatch = urlPath.match(/^\/api\/datasets\/([^/]+)\/bindings$/);
    if (bindingMatch && method === 'GET') return sendJson(res, 200, { bindings: await listDatasetBindings(decodeURIComponent(bindingMatch[1])) });
    if (bindingMatch && method === 'PUT') {
      const body = await readBody(req); const datasetId = decodeURIComponent(bindingMatch[1]); await saveDatasetBindings(datasetId, body.bindings || []);
      await recordAudit(req.fcsUser?.username || '', 'dataset.bindings.save', datasetId, { total: (body.bindings || []).length }, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true });
    }
    if (urlPath === '/api/agent-tag-partitions' && method === 'GET') return sendJson(res, 200, { partitions: await listAgentTagPartitions() });
    if (urlPath === '/api/agent-tag-partitions' && method === 'POST') { const body = await readBody(req); await saveAgentTagPartition(body); await recordAudit(req.fcsUser?.username || '', 'agent-tag-partition.save', body.partitionId || '', {}, req.socket.remoteAddress); return sendJson(res, 200, { ok: true }); }
    const tagPartitionMatch = urlPath.match(/^\/api\/agent-tag-partitions\/([^/]+)$/);
    if (tagPartitionMatch && method === 'PUT') { const body = await readBody(req); body.partitionId = decodeURIComponent(tagPartitionMatch[1]); await saveAgentTagPartition(body); return sendJson(res, 200, { ok: true }); }
    if (tagPartitionMatch && method === 'DELETE') { await deleteAgentTagPartition(decodeURIComponent(tagPartitionMatch[1])); return sendJson(res, 200, { ok: true }); }
    if (urlPath === '/api/agents/tags/batch' && method === 'POST') { const body = await readBody(req); const tags = Array.isArray(body.tags) ? body.tags : []; const ids = [...new Set((body.agentIds || []).map(String))]; if (!ids.length || !tags.length) return sendJson(res, 400, { error: '请选择 Agent 并填写标签' }); for (const agentId of ids) { const existing = await listAgentTags(agentId); const merged = new Map(existing.map((tag) => [`${tag.key}\u0000${tag.value}`, tag])); tags.forEach((tag) => { if (tag.key && tag.value) { const item = { key: String(tag.key), value: String(tag.value) }; merged.set(`${item.key}\u0000${item.value}`, item); } }); await saveAgentTags(agentId, [...merged.values()]); } await recordAudit(req.fcsUser?.username || '', 'agent.tags.batch', 'agents', { total: ids.length, tags }, req.socket.remoteAddress); return sendJson(res, 200, { ok: true, total: ids.length }); }
    const agentTagMatch = urlPath.match(/^\/api\/agents\/([^/]+)\/tags$/);
    if (agentTagMatch && method === 'GET') return sendJson(res, 200, { tags: await listAgentTags(decodeURIComponent(agentTagMatch[1])) });
    if (agentTagMatch && method === 'PUT') {
      const body = await readBody(req); const agentId = decodeURIComponent(agentTagMatch[1]); await saveAgentTags(agentId, body.tags || []);
      await recordAudit(req.fcsUser?.username || '', 'agent.tags.save', agentId, { total: (body.tags || []).length }, req.socket.remoteAddress);
      return sendJson(res, 200, { ok: true });
    }

    if (urlPath === '/api/dashboard/summary' && method === 'GET') {
      const range = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('range');
      return sendJson(res, 200, await getDashboardSummary(range));
    }

    if (urlPath === '/api/config' && method === 'GET') {
      const cfg = await loadRuntimeConfig();
      if (cfg.ldap) cfg.ldap = { ...cfg.ldap, bind_password: '' };
      if (cfg.objectStorage) cfg.objectStorage = { ...cfg.objectStorage, accessKey: '', secretKey: '' };
      if (cfg.dingTalk) cfg.dingTalk = { ...cfg.dingTalk, webhook: '', secret: '' };
      return sendJson(res, 200, cfg);
    }

    if (urlPath === '/api/config' && method === 'PUT') {
      const cfg = await readBody(req);
      if (!cfg || !Array.isArray(cfg.markets)) {
        return sendJson(res, 400, { error: '配置缺少 markets 数组' });
      }
      cfg.settings = cfg.settings || {};
      const previousConfig = { ...loadConfig(), ...(await getSystemSettings()) };
      if (cfg.ldap && !cfg.ldap.bind_password && previousConfig.ldap?.bind_password) cfg.ldap.bind_password = previousConfig.ldap.bind_password;
      if (cfg.objectStorage && !cfg.objectStorage.accessKey && previousConfig.objectStorage?.accessKey) cfg.objectStorage.accessKey = previousConfig.objectStorage.accessKey;
      if (cfg.objectStorage && !cfg.objectStorage.secretKey && previousConfig.objectStorage?.secretKey) cfg.objectStorage.secretKey = previousConfig.objectStorage.secretKey;
      if (cfg.dingTalk && !cfg.dingTalk.webhook && previousConfig.dingTalk?.webhook) cfg.dingTalk.webhook = previousConfig.dingTalk.webhook;
      if (cfg.dingTalk && !cfg.dingTalk.secret && previousConfig.dingTalk?.secret) cfg.dingTalk.secret = previousConfig.dingTalk.secret;
      await syncZonesAndMarkets(cfg.zones || [], cfg.markets || []);
      // 文件命名模式/文件格式/代码后缀为系统固定常量，剔除旧配置中的残留字段
      if (cfg.objectStorage && typeof cfg.objectStorage === 'object') {
        delete cfg.objectStorage.pathPattern;
        delete cfg.objectStorage.fileFormat;
        delete cfg.objectStorage.codeStripSuffix;
        delete cfg.objectStorage.localDir;
        delete cfg.objectStorage.autoSync;
        delete cfg.objectStorage.syncMode;
        delete cfg.objectStorage.syncIntervalMinutes;
        delete cfg.objectStorage.syncFixedTimes;
      }
      await saveSystemSettings({ settings: cfg.settings, objectStorage: cfg.objectStorage || {}, ldap: cfg.ldap || {}, dingTalk: cfg.dingTalk || {} });
      saveConfig(cfg);
      setRuntimeConfig(cfg);
      // 巡检方案可能随系统配置更新，刷新独立定时巡检调度器。
      startAutoDatasetInspect();
      // 配置变更后重启钉钉定时发送（如果启用）
      startAutoDingTalk();
      return sendJson(res, 200, { ok: true });
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
      const runtimeConfig = await loadRuntimeConfig();
      if (scope.markets !== 'all') {
        const requestedMarkets = Array.isArray(scope.markets) ? scope.markets : [scope.markets];
        const disabled = requestedMarkets.filter((code) => {
          const market = (runtimeConfig.markets || []).find((m) => m.code === code);
          return !market || market.enabled === false;
        });
        if (disabled.length) throw new Error(`市场未启用或不存在：${disabled.join(', ')}`);
      }
      const task = await agentService.createTask(scope, runtimeConfig);
      return sendJson(res, 202, { ok: true, pending: true, ...task });
    }

    // ---- 巡检历史 ----
    if (urlPath === '/api/history' && method === 'GET') {
      return sendJson(res, 200, await agentService.listHistory());
    }
    if (urlPath.startsWith('/api/history/') && method === 'GET') {
      const runId = urlPath.slice('/api/history/'.length);
      const data = await agentService.getRun(runId);
      if (!data) return sendJson(res, 404, { error: '未找到该历史记录' });
      return sendJson(res, 200, data);
    }
    if (urlPath.startsWith('/api/history/') && method === 'DELETE') {
      const runId = urlPath.slice('/api/history/'.length);
      await agentService.deleteRun(runId);
      return sendJson(res, 200, { ok: true });
    }

    // ---- 静态资源 ----
    if (method === 'GET' && urlPath === '/') {
      const sid = parseCookies(req.headers.cookie).fcs_session;
      if (!sid || !(await getSession(sid))) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    }
    if (method === 'GET' && urlPath === '/login') {
      const sid = parseCookies(req.headers.cookie).fcs_session;
      if (sid && await getSession(sid)) { res.writeHead(302, { Location: '/' }); return res.end(); }
    }
    if (method === 'GET') return serveStatic(req, res, urlPath);

    res.writeHead(404);
    res.end('Not Found');
  } catch (e) {
    logger.error('API', `${method} ${urlPath} 异常:`, e.message);
    sendJson(res, 500, { error: e.message });
  }
});

// Node 默认会在 5 分钟后中断尚未结束的请求。发布包由 Agent 流式上传，
// 大市场在较低带宽下可超过该时间，因此取消 HTTP 总请求时限；连接、TOS
// 与任务失败仍由各自的错误处理负责。
server.requestTimeout = 0;
server.timeout = 0;

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
initDatabase().then(async () => {
  const expireTasks = () => agentService.expireStaleTasks().then((result) => { if (result.inspections || result.dataTasks || result.removedInspections || result.removedReleases) logger.warn('任务清理', `超时巡检 ${result.inspections}，同步 ${result.dataTasks}；清理历史巡检 ${result.removedInspections}，发布记录 ${result.removedReleases}`); }).catch((error) => logger.error('任务清理', error.message));
  await cleanupExpiredSessions();
  setInterval(() => cleanupExpiredSessions().catch((e) => logger.warn('会话清理', e.message)), 60 * 60 * 1000).unref();
  await seedZonesAndMarkets(loadConfig());
  await seedSystemSettings(loadConfig());
  await loadRuntimeConfig();
  await expireTasks();
  setInterval(expireTasks, 10 * 60 * 1000).unref();
  await checkOfflineAgentAlerts();
  setInterval(() => checkOfflineAgentAlerts().catch((error) => logger.warn('Agent 离线检查', error.message)), 60 * 1000).unref();
  listenWithRetry(PORT, () => {
  // 服务启动后初始化巡检方案定时任务
  startAutoDatasetInspect();
  // 服务启动后初始化钉钉定时发送
  startAutoDingTalk();
  });
}).catch((e) => {
  logger.error('启动', 'MySQL 初始化失败:', e.message);
  process.exit(1);
});
