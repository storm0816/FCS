const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { db, nextDataTask, setDataTask, getDataset, listDatasetBindings, listAgentTags, createDataRelease, createDataTask } = require('./database');
const { inspect } = require('./inspector');

const ONLINE_SECONDS = 45;

function zoneForIp(ip, zones) {
  const list = (zones || []).filter((z) => z.networkSegment && String(ip).startsWith(String(z.networkSegment) + '.'));
  list.sort((a, b) => String(b.networkSegment).length - String(a.networkSegment).length);
  return list.length ? list[0].id : '';
}

function scopeContains(scope, market) {
  return scope.markets === 'all' || (Array.isArray(scope.markets) && scope.markets.includes(market)) || scope.markets === market;
}

async function heartbeat(agent, config) {
  const conn = db();
  const item = {
    agentId: String(agent.agentId || '').trim(), hostname: String(agent.hostname || ''),
    innerIp: String(agent.innerIp || ''), outerIp: String(agent.outerIp || ''), market: String(agent.market || ''),
    zone: String(agent.zone || ''), version: String(agent.agentVersion || '')
  };
  if (!item.agentId || !item.innerIp) throw new Error('agentId、innerIp 为必填项');
  const zoneCode = item.zone || zoneForIp(item.innerIp, config.zones);
  await conn.execute(`INSERT INTO fcs_agents (agent_id,hostname,inner_ip,outer_ip,market_code,zone_code,agent_version,last_seen_at)
    VALUES (?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE hostname=VALUES(hostname),inner_ip=VALUES(inner_ip),outer_ip=VALUES(outer_ip),market_code=VALUES(market_code),zone_code=VALUES(zone_code),agent_version=VALUES(agent_version),last_seen_at=NOW()`,
    [item.agentId, item.hostname, item.innerIp, item.outerIp, item.market, zoneCode, item.version]);
  // 兼容已有行情 Agent：历史行情系统默认继承已心跳的 Agent，其他业务系统仍需在页面中显式关联。
  await conn.execute("INSERT IGNORE INTO fcs_business_system_agents (system_id,agent_id,enabled) SELECT 'quote',?,1 FROM fcs_business_systems WHERE system_id='quote'", [item.agentId]);
  const [rows] = await conn.execute(`SELECT t.task_id,t.scope_json FROM fcs_inspection_tasks t
    JOIN fcs_task_agents ta ON ta.task_id=t.task_id
    WHERE ta.agent_id=? AND ta.status='pending' AND t.status='pending' ORDER BY t.created_at LIMIT 1`, [item.agentId]);
  if (!rows.length) {
    const dataTask = await nextDataTask(item.agentId);
    if (!dataTask) return { online: true, task: null, dataTask: null };
    await setDataTask(dataTask.task_id, 'dispatched', dataTask.detail);
    const market = (config.markets || []).find((m) => m.code === dataTask.market_code) || {};
    const os = config.objectStorage || {};
    return { online: true, task: null, dataTask: { taskId: dataTask.task_id, releaseId: dataTask.release_id, action: dataTask.action, market: dataTask.market_code, objectKey: dataTask.object_key, tosUri: os.bucket ? `tos://${os.bucket}/${dataTask.object_key}` : '', sha256: dataTask.sha256, sizeBytes: Number(dataTask.size_bytes || 0), dataDir: market.dataDir || '', filePattern: market.filePattern || '*.NIG', ...JSON.parse(dataTask.detail || '{}') } };
  }
  const task = rows[0];
  const scope = typeof task.scope_json === 'string' ? JSON.parse(task.scope_json) : task.scope_json;
  await conn.execute("UPDATE fcs_task_agents SET status='dispatched', dispatched_at=NOW() WHERE task_id=? AND agent_id=?", [task.task_id, item.agentId]);
  if (scope.dataset) {
    const dataset = scope.dataset;
    const datasetConfig = {
      code: dataset.code || dataset.id,
      dataDir: dataset.sourceDir || '',
      // filePattern keeps older Agent versions usable; the remaining fields are
      // consumed by the generic scanner in current Agents.
      filePattern: String(dataset.filePatterns || '*').split(/[,;\r\n]/).map((item) => item.trim()).find(Boolean) || '*',
      filePatterns: dataset.filePatterns || '*',
      excludePatterns: dataset.excludePatterns || '',
      recursive: !!dataset.recursive,
      followSymlinks: !!dataset.followSymlinks
    };
    return { online: true, task: { taskId: task.task_id, scope, datasets: [dataset.id], datasetConfigs: [datasetConfig], markets: [datasetConfig.code], marketConfigs: [datasetConfig] } };
  }
  const marketConfigs = (config.markets || []).filter((m) => m.enabled !== false && scopeContains(scope, m.code)).map((m) => ({
    code: m.code, dataDir: m.dataDir || '', filePattern: m.filePattern || '*.NIG'
  }));
  return { online: true, task: { taskId: task.task_id, scope, markets: marketConfigs.map((m) => m.code), marketConfigs } };
}

async function createTask(scope, config) {
  const conn = db();
    const [agents] = await conn.query(`SELECT agent_id,market_code,zone_code,inner_ip FROM fcs_agents WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL ${ONLINE_SECONDS} SECOND)`);
  const requestedZones = scope.zones === 'all' ? null : (Array.isArray(scope.zones) ? scope.zones : [scope.zones]);
  const selected = requestedZones
    ? agents.filter((a) => requestedZones.includes(a.zone_code || zoneForIp(a.inner_ip, config.zones)))
    : agents;
  if (!selected.length) throw new Error('没有在线 Agent，无法执行巡检');
  if (scope.referenceServerId && !selected.some((a) => a.agent_id === scope.referenceServerId || a.inner_ip === scope.referenceServerId)) {
    throw new Error('参考机不属于当前选择的分区，请重新选择参考机或选择全部分区');
  }
  const taskId = randomUUID();
  await conn.execute('INSERT INTO fcs_inspection_tasks (task_id,scope_json,status,expected_agents) VALUES (?,?,' + "'pending'" + ',?)', [taskId, JSON.stringify(scope), selected.length]);
  for (const a of selected) await conn.execute('INSERT INTO fcs_task_agents (task_id,agent_id) VALUES (?,?)', [taskId, a.agent_id]);
  return { taskId, expectedAgents: selected.length };
}

async function createDatasetTask(datasetId, scope = {}, config) {
  const dataset = await getDataset(String(datasetId || ''));
  if (!dataset || !dataset.enabled) throw new Error('数据集不存在或已禁用');
  if (!path.isAbsolute(String(dataset.sourceDir || ''))) throw new Error('数据集源目录必须是绝对路径，请先完善数据集目录配置');
  if (scope.syncRequested && !path.isAbsolute(String(dataset.targetDir || ''))) throw new Error('数据集目标目录必须是绝对路径，请先完善数据集目录配置');
  let bindings = (await listDatasetBindings(dataset.dataset_id)).filter((binding) => binding.enabled);
  const conn = db();
  const [onlineAgents] = await conn.query(`SELECT agent_id,zone_code,inner_ip FROM fcs_agents WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL ${ONLINE_SECONDS} SECOND)`);
  const [systemAgents] = await conn.execute('SELECT agent_id FROM fcs_business_system_agents WHERE system_id=? AND enabled=1', [dataset.system_id]);
  const systemAgentIds = new Set(systemAgents.map((row) => row.agent_id));
  const hasExplicitSystemAgents = systemAgentIds.size > 0;
  if (!bindings.length && systemAgentIds.size) bindings = [...systemAgentIds].map((agentId) => ({ agentId, enabled: true }));
  if (!bindings.length) throw new Error('数据集未配置适用 Agent，请先关联业务系统 Agent 或绑定数据集 Agent');
  const requestedAgents = Array.isArray(scope.agentIds) && scope.agentIds.length ? new Set(scope.agentIds.map(String)) : null;
  const requestedZones = scope.zones === 'all' || !scope.zones ? null : new Set(Array.isArray(scope.zones) ? scope.zones : [scope.zones]);
  const bindingMap = new Map(bindings.map((binding) => [binding.agentId, binding]));
  let selected = onlineAgents.filter((agent) => bindingMap.has(agent.agent_id) && (!hasExplicitSystemAgents || systemAgentIds.has(agent.agent_id)) && (!requestedAgents || requestedAgents.has(agent.agent_id)) && (!requestedZones || requestedZones.has(agent.zone_code || zoneForIp(agent.inner_ip, config.zones))));
  const requiredTags = Array.isArray(scope.tags) ? scope.tags.map((tag) => ({ key: String(tag?.key || '').trim(), value: String(tag?.value || '').trim() })).filter((tag) => tag.key && tag.value) : [];
  if (requiredTags.length) {
    const tagsByAgent = new Map(await Promise.all(selected.map(async (agent) => [agent.agent_id, await listAgentTags(agent.agent_id)])));
    selected = selected.filter((agent) => requiredTags.every((required) => (tagsByAgent.get(agent.agent_id) || []).some((tag) => tag.key === required.key && tag.value === required.value)));
  }
  if (!selected.length) throw new Error('没有符合条件的在线已绑定 Agent');
  const selectedIds = new Set(selected.map((agent) => agent.agent_id));
  if (scope.referenceServerId && !selectedIds.has(String(scope.referenceServerId))) throw new Error('参考机必须是本次巡检范围内的已绑定 Agent');
  const taskId = randomUUID();
  const datasetSnapshot = { id: dataset.dataset_id, code: dataset.dataset_code, name: dataset.dataset_name, sourceDir: dataset.sourceDir, targetDir: dataset.targetDir, filePatterns: dataset.filePatterns, excludePatterns: dataset.excludePatterns, recursive: dataset.recursive, followSymlinks: dataset.followSymlinks };
  const taskScope = { ...scope, datasetId: dataset.dataset_id, systemId: dataset.system_id, taskType: 'dataset', triggerType: scope.triggerType || 'manual', markets: [dataset.dataset_code], dataset: datasetSnapshot };
  await conn.execute("INSERT INTO fcs_inspection_tasks (task_id,system_id,dataset_id,task_type,trigger_type,scope_json,status,expected_agents) VALUES (?,?,?,?,?,?, 'pending',?)", [taskId, dataset.system_id, dataset.dataset_id, 'dataset', taskScope.triggerType, JSON.stringify(taskScope), selected.length]);
  for (const agent of selected) await conn.execute('INSERT INTO fcs_task_agents (task_id,agent_id) VALUES (?,?)', [taskId, agent.agent_id]);
  return { taskId, expectedAgents: selected.length, dataset: datasetSnapshot, agentIds: [...selectedIds] };
}

async function submitReport(payload, config) {
  const conn = db();
  const taskId = String(payload.taskId || ''); const agentId = String(payload.agentId || '');
  const reports = Array.isArray(payload.reports) ? payload.reports : [];
  const reportError = String(payload.error || '').trim();
  if (!taskId || !agentId || (!reports.length && !reportError)) throw new Error('任务、Agent 或哈希结果为空');
  const [assignment] = await conn.execute('SELECT status FROM fcs_task_agents WHERE task_id=? AND agent_id=?', [taskId, agentId]);
  if (!assignment.length) throw new Error('Agent 不属于该巡检任务');
  const [taskRows] = await conn.execute('SELECT dataset_id FROM fcs_inspection_tasks WHERE task_id=?', [taskId]);
  for (const r of reports) {
    const content = String(r.hashContent || '');
    if (!r.market || !content) throw new Error('上报哈希内容不完整');
    const count = content.split(/\r?\n/).filter(Boolean).length;
    await conn.execute(`INSERT INTO fcs_agent_reports (task_id,dataset_id,agent_id,market_code,hash_content,hash_count)
      VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE dataset_id=VALUES(dataset_id),hash_content=VALUES(hash_content),hash_count=VALUES(hash_count),reported_at=NOW()`, [taskId, taskRows[0]?.dataset_id || null, agentId, r.market, content, count]);
  }
  await conn.execute("UPDATE fcs_task_agents SET status=?, error_detail=?, reported_at=NOW() WHERE task_id=? AND agent_id=?", [reportError ? 'failed' : 'reported', reportError, taskId, agentId]);
  const [counts] = await conn.execute("SELECT COUNT(*) expected, SUM(status IN ('reported','failed')) reported, SUM(status='failed') failed FROM fcs_task_agents WHERE task_id=?", [taskId]);
  await conn.execute('UPDATE fcs_inspection_tasks SET reported_agents=? WHERE task_id=?', [Number(counts[0].reported || 0), taskId]);
  if (Number(counts[0].expected) === Number(counts[0].reported)) {
    if (Number(counts[0].failed || 0) > 0) { const [failed] = await conn.execute("SELECT agent_id,error_detail FROM fcs_task_agents WHERE task_id=? AND status='failed'", [taskId]); await conn.execute("UPDATE fcs_inspection_tasks SET status='failed',completed_at=NOW(),result_json=? WHERE task_id=?", [JSON.stringify({ error: failed.map((item) => `${item.agent_id}: ${item.error_detail}`).join('; ') }), taskId]); }
    else await completeTask(taskId, config);
  }
  return { ok: true, taskId, reportedAgents: Number(counts[0].reported || 0), expectedAgents: Number(counts[0].expected || 0) };
}

/* Create a publish task after a scheduled inspection when the plan enables
 * automatic synchronization.  This deliberately reuses the same release/task
 * tables and Agent workflow as the manual 发布/下载 page. */
async function createScheduledAutoSync(taskId, scope, result, config) {
  const auto = scope && scope.autoSync;
  if (scope?.triggerType !== 'scheduled' || !auto || auto.enabled !== true) return null;
  const dataset = scope.dataset;
  if (!dataset?.id) throw new Error('自动同步缺少数据集信息');
  const conn = db();
  const [assignedRows] = await conn.execute('SELECT ta.agent_id,a.inner_ip FROM fcs_task_agents ta JOIN fcs_agents a ON a.agent_id=ta.agent_id WHERE ta.task_id=?', [taskId]);
  const assigned = assignedRows.map((row) => String(row.agent_id));
  // 巡检结果以 Agent 的内网 IP 作为 serverId；同步任务必须转换回 Agent ID。
  const abnormalServerIds = new Set(result?.summary?.anomalousServerIds || []);
  for (const zone of result?.zones || []) for (const market of zone.markets || []) {
    for (const item of [...(market.anomalies || []), ...(market.extraCodes || []), ...(market.missing || []), ...(market.conflicts || [])]) if (item?.serverId) abnormalServerIds.add(String(item.serverId));
  }
  const targets = assignedRows.filter((row) => abnormalServerIds.has(String(row.agent_id)) || abnormalServerIds.has(String(row.inner_ip))).map((row) => String(row.agent_id));
  if (!targets.length) return { skipped: true, reason: 'no-anomaly' };
  const sourceId = String(auto.sourceAgentId || '');
  if (!sourceId || !assigned.includes(sourceId)) throw new Error('自动同步来源 Agent 未在本次巡检范围内');
  if (targets.includes(sourceId)) throw new Error('自动同步来源 Agent 本次巡检存在差异，已阻止使用异常来源覆盖其他主机');
  let bindings = (await listDatasetBindings(dataset.id)).filter((item) => item.enabled);
  if (!bindings.length) {
    const [rows] = await conn.execute('SELECT agent_id FROM fcs_business_system_agents WHERE system_id=? AND enabled=1', [scope.systemId || '']);
    bindings = rows.map((row) => ({ agentId: row.agent_id, enabled: true }));
  }
  const bindingByAgent = new Map(bindings.map((item) => [String(item.agentId), item]));
  if (!bindingByAgent.has(sourceId)) throw new Error('自动同步来源 Agent 未绑定该数据集');
  const validTargets = targets.filter((id, index) => id !== sourceId && assigned.includes(id) && bindingByAgent.has(id) && targets.indexOf(id) === index);
  if (!validTargets.length) return { skipped: true, reason: 'no-target' };
  const sourceBinding = bindingByAgent.get(sourceId);
  const sourceDir = sourceBinding.sourceDirOverride || dataset.sourceDir || '';
  if (!path.posix.isAbsolute(sourceDir)) throw new Error('自动同步源目录必须是绝对路径');
  const targetDataDirs = Object.fromEntries(validTargets.map((id) => {
    const binding = bindingByAgent.get(id); return [id, binding.targetDirOverride || dataset.targetDir || sourceDir];
  }));
  const invalid = Object.entries(targetDataDirs).find(([, dir]) => !path.posix.isAbsolute(String(dir)));
  if (invalid) throw new Error(`自动同步目标 Agent ${invalid[0]} 未配置绝对路径目录`);
  const releaseId = randomUUID();
  const safeCode = String(dataset.code || dataset.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const objectKey = `${(config.objectStorage || {}).prefix || 'fcs/releases'}/data/${safeCode}/${releaseId}.tar.gz`;
  await createDataRelease(releaseId, String(dataset.code || dataset.id), sourceId, objectKey, { systemId: scope.systemId, datasetId: dataset.id });
  const publishTaskId = randomUUID();
  await createDataTask(publishTaskId, releaseId, sourceId, 'publish', { datasetId: dataset.id, dataDir: sourceDir, filePattern: dataset.filePatterns || '*', targetAgentIds: validTargets, targetDataDirs, autoSyncFromInspection: taskId });
  return { releaseId, publishTaskId, sourceAgentId: sourceId, targetAgentIds: validTargets, condition: 'anomaly-only' };
}

async function completeTask(taskId, config) {
  const conn = db();
  const [taskRows] = await conn.execute('SELECT scope_json,status FROM fcs_inspection_tasks WHERE task_id=?', [taskId]);
  if (!taskRows.length || taskRows[0].status !== 'pending') return;
  await conn.execute("UPDATE fcs_inspection_tasks SET status='processing' WHERE task_id=?", [taskId]);
  try {
    const [reports] = await conn.execute(`SELECT r.*,a.inner_ip FROM fcs_agent_reports r JOIN fcs_agents a ON a.agent_id=r.agent_id WHERE r.task_id=?`, [taskId]);
    const dir = path.join(__dirname, '..', 'inspect_data', 'agent-cache', taskId);
    fs.mkdirSync(dir, { recursive: true });
    for (const r of reports) fs.writeFileSync(path.join(dir, `${r.inner_ip}-${r.market_code}-NIG.b2sum`), r.hash_content, 'utf8');
    const scope = typeof taskRows[0].scope_json === 'string' ? JSON.parse(taskRows[0].scope_json) : taskRows[0].scope_json;
    // Generic data sets reuse the proven comparison engine.  Supply a
    // one-item market-compatible view only for this task, without changing
    // existing market configuration or legacy inspection behavior.
    const dataset = scope && scope.dataset;
    const taskMarkets = dataset ? [{
      code: dataset.code || dataset.id,
      name: dataset.name || dataset.code || dataset.id,
      dataDir: dataset.sourceDir || '',
      filePattern: String(dataset.filePatterns || '*').split(/[,;\r\n]/).map((item) => item.trim()).find(Boolean) || '*',
      enabled: true
    }] : config.markets;
    const cfg = { ...config, markets: taskMarkets, objectStorage: { ...(config.objectStorage || {}), localDir: dir } };
    const result = await inspect(cfg, scope);
    result.summary.dataSource = 'agent';
    result.summary.codeListSource = 'agent';
    for (const zone of result.zones || []) for (const market of zone.markets || []) market.codeListSource = 'agent';
    try {
      const autoSync = await createScheduledAutoSync(taskId, scope, result, config);
      if (autoSync) result.autoSync = autoSync;
    } catch (autoError) {
      // Inspection remains successful; expose the sync error in the result for
      // operators instead of losing the completed comparison.
      result.autoSync = { error: autoError.message };
    }
    await conn.execute("UPDATE fcs_inspection_tasks SET status='completed',completed_at=NOW(),result_json=? WHERE task_id=?", [JSON.stringify(result), taskId]);
  } catch (e) {
    await conn.execute("UPDATE fcs_inspection_tasks SET status='failed',completed_at=NOW(),result_json=? WHERE task_id=?", [JSON.stringify({ error: e.message }), taskId]);
  }
}

async function taskStatus(taskId) {
  const [rows] = await db().execute('SELECT task_id,status,expected_agents,reported_agents,result_json,created_at,completed_at FROM fcs_inspection_tasks WHERE task_id=?', [taskId]);
  if (!rows.length) return null;
  const r = rows[0];
  r.result = r.result_json ? (typeof r.result_json === 'string' ? JSON.parse(r.result_json) : r.result_json) : null;
  delete r.result_json; return r;
}

async function zoneCounts(config) {
  const [agents] = await db().query('SELECT agent_id,inner_ip,zone_code FROM fcs_agents ORDER BY inner_ip');
  const zones = {};
  for (const z of config.zones || []) zones[z.id] = { count: 0, servers: [], segment: z.networkSegment || '' };
  const unmapped = [];
  for (const agent of agents) {
    const zoneId = agent.zone_code || zoneForIp(agent.inner_ip, config.zones);
    if (zoneId && zones[zoneId]) { zones[zoneId].count++; zones[zoneId].servers.push(agent.inner_ip); }
    else unmapped.push(agent.inner_ip);
  }
  return { ok: true, total: agents.length, zones, unmapped };
}

async function listAgents(config) {
  const [agents] = await db().query(`SELECT a.agent_id,a.hostname,a.inner_ip,a.outer_ip,a.zone_code,a.agent_version,a.last_seen_at,
    (a.last_seen_at >= DATE_SUB(NOW(), INTERVAL ${ONLINE_SECONDS} SECOND)) AS online,
    (SELECT ta.status FROM fcs_task_agents ta WHERE ta.agent_id=a.agent_id ORDER BY COALESCE(ta.reported_at, ta.dispatched_at) DESC LIMIT 1) AS last_task_status,
    (SELECT GROUP_CONCAT(s.system_name ORDER BY s.system_code SEPARATOR ',') FROM fcs_business_system_agents sa JOIN fcs_business_systems s ON s.system_id=sa.system_id WHERE sa.agent_id=a.agent_id AND sa.enabled=1) AS business_systems
    FROM fcs_agents a ORDER BY a.last_seen_at DESC`);
  return agents.map((a) => ({
    agentId: a.agent_id, hostname: a.hostname, innerIp: a.inner_ip, outerIp: a.outer_ip,
    zone: a.zone_code || zoneForIp(a.inner_ip, config.zones), agentVersion: a.agent_version,
    lastSeenAt: a.last_seen_at, online: !!a.online, lastTaskStatus: a.last_task_status || '', businessSystems: a.business_systems ? String(a.business_systems).split(',') : []
  }));
}

async function listHistory() {
  const [rows] = await db().query("SELECT task_id,scope_json,result_json,completed_at FROM fcs_inspection_tasks WHERE status='completed' ORDER BY completed_at DESC");
  const markets = {};
  const recentRuns = [];
  for (const row of rows) {
    const result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json;
    const scope = typeof row.scope_json === 'string' ? JSON.parse(row.scope_json) : row.scope_json;
    let codes = Array.from(new Set((result.zones || []).flatMap((z) => (z.markets || []).map((m) => m.market)).filter(Boolean)));
    // 即使所选分区没有 Agent 数据，也保留本次已完成任务在历史页中。
    if (!codes.length && scope && scope.markets && scope.markets !== 'all') {
      codes = Array.isArray(scope.markets) ? scope.markets : [scope.markets];
    }
    const meta = { runId: row.task_id, savedAt: row.completed_at, elapsedMs: result.elapsedMs, markets: codes,
      triggerType: scope?.triggerType || 'manual', planId: scope?.planId || '', planName: scope?.planName || '',
      compareMode: result.summary && result.summary.compareMode, compareAlgorithm: result.summary && result.summary.compareAlgorithm,
      groupTotalServers: result.summary && result.summary.groupTotalServers, anomalousServers: result.summary && result.summary.anomalousServers,
      totalCodes: result.summary && result.summary.totalCodes, anomalies: result.summary && result.summary.anomalies,
      extraCodes: result.summary && result.summary.extraCodes, consistentCodes: result.summary && result.summary.consistentCodes,
      zoneNames: (result.zones || []).map((z) => z.name || z.zone) };
    if (recentRuns.length < 5) recentRuns.push(meta);
    for (const code of codes) { if (!markets[code]) markets[code] = []; if (markets[code].length < 5) markets[code].push(meta); }
  }
  return { markets, recentRuns };
}

async function getRun(taskId) {
  const [rows] = await db().execute("SELECT task_id,scope_json,result_json,completed_at FROM fcs_inspection_tasks WHERE task_id=? AND status='completed'", [taskId]);
  if (!rows.length) return null;
  const row = rows[0]; const result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json;
  return { savedAt: row.completed_at, runId: row.task_id, scope: typeof row.scope_json === 'string' ? JSON.parse(row.scope_json) : row.scope_json,
    summary: result.summary, zones: result.zones, elapsedMs: result.elapsedMs };
}

async function deleteRun(taskId) { await db().execute('DELETE FROM fcs_inspection_tasks WHERE task_id=?', [taskId]); }

async function expireStaleTasks() {
  const conn = db();
  const [settingsRows] = await conn.query("SELECT setting_value FROM fcs_system_settings WHERE setting_key='settings' LIMIT 1");
  let settings = {};
  try { settings = settingsRows[0] ? JSON.parse(settingsRows[0].setting_value || '{}') : {}; } catch (_) {}
  const retentionDays = Math.min(3650, Math.max(1, Number(settings.retentionDays) || 90));
  const [inspection] = await conn.execute("UPDATE fcs_inspection_tasks SET status='failed',completed_at=NOW(),result_json=JSON_OBJECT('error','任务超过 6 小时未完成') WHERE status IN ('pending','processing') AND created_at < DATE_SUB(NOW(), INTERVAL 6 HOUR)");
  const [data] = await conn.execute("UPDATE fcs_data_tasks SET status='failed',completed_at=NOW(),detail='任务超过 24 小时未完成' WHERE status IN ('pending','dispatched','processing') AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)");
  const [oldInspections] = await conn.execute(`DELETE FROM fcs_inspection_tasks WHERE created_at < DATE_SUB(NOW(), INTERVAL ${retentionDays} DAY)`);
  const [oldReleases] = await conn.execute(`DELETE FROM fcs_data_releases WHERE created_at < DATE_SUB(NOW(), INTERVAL ${retentionDays} DAY)`);
  return { inspections: inspection.affectedRows, dataTasks: data.affectedRows, removedInspections: oldInspections.affectedRows, removedReleases: oldReleases.affectedRows, retentionDays };
}

module.exports = { heartbeat, createTask, createDatasetTask, submitReport, taskStatus, zoneCounts, listAgents, listHistory, getRun, deleteRun, expireStaleTasks };
