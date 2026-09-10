/**
 * 巡检历史管理：每次巡检完成后将结果 JSON 存到本地 history/ 目录，
 * 并维护一份 manifest.json 记录每个市场最近 5 次的 runId。
 */
const fs = require('fs');
const path = require('path');

const HISTORY_DIR_NAME = 'history';
const MAX_PER_MARKET = 5;

function historyDir() {
  const root = process.env.INSPECT_DATA_DIR
    ? path.resolve(process.env.INSPECT_DATA_DIR)
    : path.join(__dirname, '..', 'inspect_data');
  const dir = path.join(root, HISTORY_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestPath() {
  return path.join(historyDir(), 'manifest.json');
}

function runFilePath(runId) {
  return path.join(historyDir(), `${runId}.json`);
}

function readManifest() {
  try {
    if (!fs.existsSync(manifestPath())) return { runs: {} };
    const raw = fs.readFileSync(manifestPath(), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { runs: {} };
  }
}

function writeManifest(mf) {
  fs.writeFileSync(manifestPath(), JSON.stringify(mf, null, 2), 'utf-8');
}

/**
 * 保存一次巡检结果到历史。
 * @param {object} result - inspect() 的完整返回值
 * @param {object} scope  - 本次巡检的 scope（含 markets/zones 等）
 */
function saveRun(result, scope) {
  const runId = result && result.summary && result.summary.runId;
  if (!runId) return null;

  const dir = historyDir();
  const filePath = runFilePath(runId);

  // 构造存储对象：精简版结果 + 元信息
  const stored = {
    savedAt: new Date().toISOString(),
    runId,
    scope: {
      zones: scope && scope.zones,
      markets: scope && scope.markets,
      compareMode: scope && scope.compareMode,
      compareAlgorithm: scope && scope.compareAlgorithm
    },
    summary: result.summary,
    zones: result.zones,
    elapsedMs: result.elapsedMs
  };

  fs.writeFileSync(filePath, JSON.stringify(stored), 'utf-8');

  // 更新 manifest
  const mf = readManifest();
  const markets = collectMarketCodes(result);

  const runMeta = {
    runId,
    savedAt: stored.savedAt,
    elapsedMs: result.elapsedMs,
    compareMode: result.summary.compareMode,
    compareAlgorithm: result.summary.compareAlgorithm,
    groupTotalServers: result.summary.groupTotalServers,
    anomalousServers: result.summary.anomalousServers,
    totalCodes: result.summary.totalCodes,
    anomalies: result.summary.anomalies,
    extraCodes: result.summary.extraCodes,
    consistentCodes: result.summary.consistentCodes,
    markets,
    zoneNames: result.zones.map((z) => z.name || z.zone)
  };

  for (const m of markets) {
    if (!mf.runs[m]) mf.runs[m] = [];
    // 去重：同一 runId 已存在则先删
    mf.runs[m] = mf.runs[m].filter((r) => r.runId !== runId);
    mf.runs[m].unshift(runMeta);
    // 只保留最近 MAX_PER_MARKET 次
    mf.runs[m] = mf.runs[m].slice(0, MAX_PER_MARKET);
  }

  // 全局 runs 索引（便于按 runId 查找）
  if (!mf.allRuns) mf.allRuns = {};
  mf.allRuns[runId] = runMeta;

  writeManifest(mf);
  return runMeta;
}

/** 从巡检结果中提取所有涉及的市场代码 */
function collectMarketCodes(result) {
  const set = new Set();
  for (const z of result.zones || []) {
    for (const m of z.markets || []) {
      if (m.market) set.add(m.market);
    }
  }
  return Array.from(set).sort();
}

/** 获取所有市场的最近 N 次巡检概要（不含 zones 明细） */
function listHistory() {
  const mf = readManifest();
  const marketList = {};
  for (const [m, runs] of Object.entries(mf.runs || {})) {
    marketList[m] = runs.map((r) => ({ ...r }));
  }
  return { markets: marketList };
}

/** 获取某次巡检的完整结果 */
function getRun(runId) {
  const fp = runFilePath(runId);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) {
    return null;
  }
}

/** 删除某次巡检 */
function deleteRun(runId) {
  const fp = runFilePath(runId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);

  const mf = readManifest();
  for (const [m, runs] of Object.entries(mf.runs || {})) {
    mf.runs[m] = runs.filter((r) => r.runId !== runId);
    if (mf.runs[m].length === 0) delete mf.runs[m];
  }
  if (mf.allRuns && mf.allRuns[runId]) delete mf.allRuns[runId];
  writeManifest(mf);
  return true;
}

module.exports = { saveRun, listHistory, getRun, deleteRun, MAX_PER_MARKET };
