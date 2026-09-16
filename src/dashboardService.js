const { db } = require('./database');

function json(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function number(value) { return Number(value || 0); }

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function taskMarkets(scope, result) {
  if (scope && scope.dataset) {
    const dataset = scope.dataset;
    return [dataset.name || dataset.code || dataset.id].filter(Boolean);
  }
  const resultMarkets = (result.zones || []).flatMap((zone) => (zone.markets || []).map((market) => market.market)).filter(Boolean);
  if (resultMarkets.length) return [...new Set(resultMarkets)];
  if (Array.isArray(scope.markets)) return scope.markets;
  return scope.markets && scope.markets !== 'all' ? [scope.markets] : [];
}

async function getDashboardSummary(days = 7) {
  const range = Math.min(30, Math.max(7, Number(days) || 7));
  const conn = db();
  const [agents] = await conn.query(`SELECT agent_id,hostname,inner_ip,last_seen_at,
    (last_seen_at >= DATE_SUB(NOW(), INTERVAL 180 SECOND)) AS online
    FROM fcs_agents ORDER BY last_seen_at DESC`);
  const [inspections] = await conn.execute(`SELECT task_id,scope_json,status,expected_agents,reported_agents,created_at,completed_at,result_json
    FROM fcs_inspection_tasks WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    ORDER BY created_at DESC`, [range]);
  const [releases] = await conn.execute(`SELECT release_id,market_code,status,size_bytes,created_at,uploaded_at
    FROM fcs_data_releases WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ORDER BY created_at DESC`, [range]);
  const [dataTasks] = await conn.execute(`SELECT action,status,created_at,completed_at FROM fcs_data_tasks
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`, [range]);
  const [schedules] = await conn.execute('SELECT COUNT(*) AS total, SUM(enabled=1) AS enabled FROM fcs_inspection_schedules');

  const trendMap = new Map();
  for (let offset = range - 1; offset >= 0; offset--) {
    const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - offset);
    trendMap.set(dateKey(day), { date: dateKey(day), total: 0, completed: 0, failed: 0, abnormal: 0 });
  }
  const marketMap = new Map();
  const recentAnomalies = [];
  let abnormalInspectionCount = 0;
  for (const item of inspections) {
    const scope = json(item.scope_json);
    const result = json(item.result_json);
    const summary = result.summary || {};
    const abnormalServers = number(summary.anomalousServers);
    const anomalies = number(summary.anomalies);
    const key = dateKey(item.created_at);
    const daily = trendMap.get(key);
    if (daily) {
      daily.total++;
      if (item.status === 'completed') daily.completed++;
      if (item.status === 'failed') daily.failed++;
      if (abnormalServers > 0) daily.abnormal++;
    }
    for (const market of taskMarkets(scope, result)) {
      const value = marketMap.get(market) || { market, taskCount: 0, anomalousServers: 0, anomalies: 0, lastCompletedAt: null };
      value.taskCount++;
      value.anomalousServers += abnormalServers;
      value.anomalies += anomalies;
      if (!value.lastCompletedAt || new Date(item.completed_at || 0) > new Date(value.lastCompletedAt || 0)) value.lastCompletedAt = item.completed_at;
      marketMap.set(market, value);
    }
    if (abnormalServers > 0) abnormalInspectionCount++;
    if (abnormalServers > 0 && recentAnomalies.length < 8) recentAnomalies.push({
      taskId: item.task_id, markets: taskMarkets(scope, result), completedAt: item.completed_at,
      anomalousServers: abnormalServers, anomalies, totalCodes: number(summary.totalCodes),
      reference: summary.referenceServer || ''
    });
  }
  const taskStats = { total: dataTasks.length, pending: 0, running: 0, completed: 0, failed: 0, downloads: 0 };
  for (const task of dataTasks) {
    if (Object.prototype.hasOwnProperty.call(taskStats, task.status)) taskStats[task.status]++;
    if (task.action === 'download') taskStats.downloads++;
  }
  const releaseStats = { total: releases.length, uploaded: 0, pending: 0, failed: 0, sizeBytes: 0 };
  for (const release of releases) {
    releaseStats.sizeBytes += number(release.size_bytes);
    if (Object.prototype.hasOwnProperty.call(releaseStats, release.status)) releaseStats[release.status]++;
  }
  const completed = inspections.filter((item) => item.status === 'completed');
  const durations = completed.map((item) => number(json(item.result_json).elapsedMs)).filter((item) => item > 0);
  const today = dateKey(new Date());
  const todayInspections = inspections.filter((item) => dateKey(item.created_at) === today).length;
  return {
    range,
    summary: {
      agents: agents.length, onlineAgents: agents.filter((agent) => !!agent.online).length,
      offlineAgents: agents.filter((agent) => !agent.online).length,
      todayInspections, inspections: inspections.length,
      completedInspections: completed.length,
      failedInspections: inspections.filter((item) => item.status === 'failed').length,
      abnormalInspections: abnormalInspectionCount,
      averageInspectionMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      activeSchedules: number(schedules[0]?.enabled), totalSchedules: number(schedules[0]?.total)
    },
    agents: agents.slice(0, 8).map((agent) => ({ agentId: agent.agent_id, hostname: agent.hostname, innerIp: agent.inner_ip, online: !!agent.online, lastSeenAt: agent.last_seen_at })),
    inspectionTrend: [...trendMap.values()],
    markets: [...marketMap.values()].sort((a, b) => b.anomalies - a.anomalies || b.anomalousServers - a.anomalousServers || a.market.localeCompare(b.market)).slice(0, 5),
    releases: releaseStats,
    dataTasks: taskStats,
    recentAnomalies
  };
}

module.exports = { getDashboardSummary };
