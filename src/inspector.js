const fs = require('fs');
const path = require('path');
const objectStorage = require('./objectStorage');

/**
 * 简单并发池：以 limit 为并发上限，对 items 执行 fn，返回结果数组。
 * 采用「入队即调度、完成即补充」的模型，等价于一个受控的线程池（Node 异步 I/O）。
 */
function mapLimit(items, limit, fn) {
  return new Promise((resolve) => {
    const results = new Array(items.length);
    let idx = 0;
    let active = 0;
    let done = 0;
    const next = () => {
      if (done === items.length) return resolve(results);
      while (active < limit && idx < items.length) {
        const cur = idx++;
        active++;
        Promise.resolve()
          .then(() => fn(items[cur], cur))
          .then((r) => { results[cur] = r; active--; done++; next(); })
          .catch((e) => { results[cur] = { error: e.message }; active--; done++; next(); });
      }
    };
    next();
  });
}

/**
 * 解析远程脚本输出：每行 "CODE<空白>HASH"，忽略空行与非法行。
 * （保留以兼容历史调用；对象存储模式下主要用 parseB2sumContent。）
 */
function parseHashOutput(stdout) {
  const map = {};
  const lines = String(stdout || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length >= 2) map[parts[0]] = parts[1];
  }
  return map;
}

/**
 * 本地采集文件夹（哈希落盘、对比的数据源）。
 * 位置：环境变量 INSPECT_DATA_DIR > 项目根 inspect_data/。每个巡检批次一个 runId 子目录。
 */
function resolveDataRoot() {
  return process.env.INSPECT_DATA_DIR
    ? path.resolve(process.env.INSPECT_DATA_DIR)
    : path.resolve(__dirname, '..', 'inspect_data');
}
function resolveRunDir(runId) {
  return path.join(resolveDataRoot(), String(runId));
}
function ensureDirSync(p) {
  fs.mkdirSync(p, { recursive: true });
}
function writeJsonFile(p, obj) {
  ensureDirSync(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function readJsonFileSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/**
 * 把单台机的哈希结果写入本地文件夹 <runDir>/<market>/<serverId>.json。
 * ok 文件含 hashes；error 文件含 error，供后续对比把该机归入 unreachable。
 */
function writeServerHashes(runDir, market, serverId, payload) {
  const file = path.join(runDir, String(market), `${serverId}.json`);
  writeJsonFile(file, payload);
}

/**
 * 写批次 manifest（记录码表、参与者、阈值依据），供 compareOnly 复查与人工核对。
 */
function writeManifest(runDir, manifest) {
  writeJsonFile(path.join(runDir, 'manifest.json'), manifest);
}

/**
 * 从本地文件夹读取某市场的所有机器哈希，重建 perServer。
 * 返回的 perServer 与内存版完全一致（ok → {code:hash}，error → {__error}），
 * 因此后续 computeMajority + analyze 可原样复用「少数服从多数」逻辑。
 */
function readFolderForComparison(runDir, market) {
  const dir = path.join(runDir, String(market));
  const perServer = {};
  if (!fs.existsSync(dir)) return perServer;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const serverId = f.replace(/\.json$/, '');
    const data = readJsonFileSafe(path.join(dir, f));
    if (!data) continue;
    if (data.status === 'error') perServer[serverId] = { __error: data.error || 'unknown' };
    else perServer[serverId] = data.hashes || {};
  }
  return perServer;
}

/**
 * 参考机对比算法：以 perServer[baselineId] 的哈希为基准，对其他机器：
 *   - 同 code 哈希不一致 → anomaly（hash_mismatch）
 *   - 该机缺该 code → missing
 *   - 哈希一致 / 基线缺该 code 而其他机有 → 视为 OK（不报"基线少码"）
 *   - 其他机失败的 (__error) → unreachable（与多数派算法一致）
 */
function computeReferenceCompare(perServer, baselineId, serverInfo, opts = {}) {
  const market = opts.market;
  const meta = (id) => {
    const i = (serverInfo && serverInfo[id]) || {};
    return { serverName: i.name || id, zone: i.zone || '-', zoneName: i.zoneName || '-', market };
  };
  const baseline = perServer[baselineId];
  if (!baseline || baseline.__error) {
    throw new Error('computeReferenceCompare: 基准机 ' + baselineId + ' 无哈希数据');
  }
  const erroredServers = {};
  const otherIds = Object.keys(perServer).filter((id) => id !== baselineId);
  for (const id of otherIds) {
    const m = perServer[id];
    if (m && m.__error) erroredServers[id] = m.__error;
  }
  const anomalies = [];
  const missing = [];
  let consistentCodes = 0;
  for (const code of Object.keys(baseline)) {
    const baseHash = baseline[code];
    let codeConsistent = true;
    for (const id of otherIds) {
      if (erroredServers[id]) continue;
      const m = perServer[id] || {};
      const other = m[code];
      if (other == null) {
        codeConsistent = false;
        missing.push({ code, serverId: id, type: 'missing', ...meta(id) });
      } else if (other !== baseHash) {
        codeConsistent = false;
        anomalies.push({ code, serverId: id, type: 'hash_mismatch', expected: baseHash, actual: other, ...meta(id) });
      }
    }
    if (codeConsistent) consistentCodes++;
  }
  const unreachable = Object.keys(erroredServers).map((id) => ({
    serverId: id,
    type: 'unreachable',
    detail: erroredServers[id],
    ...meta(id)
  }));
  return {
    totalCodes: Object.keys(baseline).length,
    consistentCodes,
    anomalies,
    missing,
    conflicts: [],
    unreachable,
    baselineId
  };
}

/**
 * 少数派 / 冲突 / 缺失 判定（在同一组服务器集合内进行）。
 * perServer: { serverId: { code: hash } | { __error: msg } }
 * serverInfo: { serverId: { name, zone, zoneName } } 用于结果装饰
 */
function analyze(perServer, servers, serverInfo) {
  const meta = (id) => {
    const i = (serverInfo && serverInfo[id]) || {};
    return { serverName: i.name || id, zone: i.zone || '-', zoneName: i.zoneName || '-' };
  };
  const allCodes = new Set();
  const erroredServers = {};
  for (const s of servers) {
    const m = perServer[s.id] || {};
    if (m.__error) {
      erroredServers[s.id] = m.__error;
    } else {
      for (const k of Object.keys(m)) allCodes.add(k);
    }
  }

  const anomalies = [];
  const missing = [];
  const conflicts = [];
  let consistentCodes = 0;

  for (const code of allCodes) {
    const present = [];
    for (const s of servers) {
      if (erroredServers[s.id]) continue;
      const m = perServer[s.id] || {};
      if (m[code] != null) present.push({ serverId: s.id, hash: m[code] });
    }
    if (present.length === 0) continue;

    const groups = {};
    for (const p of present) (groups[p.hash] = groups[p.hash] || []).push(p.serverId);
    const hashes = Object.keys(groups);

    if (hashes.length === 1) {
      consistentCodes++;
    } else {
      const sorted = hashes
        .map((h) => ({ hash: h, count: groups[h].length }))
        .sort((a, b) => b.count - a.count);
      const max = sorted[0].count;
      const tied = sorted.filter((g) => g.count === max);
      if (tied.length > 1) {
        for (const p of present) {
          conflicts.push({ code, serverId: p.serverId, type: 'conflict', expected: '多数值平局', actual: p.hash, ...meta(p.serverId) });
        }
      } else {
        const modeHash = sorted[0].hash;
        for (const p of present) {
          if (p.hash !== modeHash) {
            anomalies.push({ code, serverId: p.serverId, type: 'hash_mismatch', expected: modeHash, actual: p.hash, ...meta(p.serverId) });
          }
        }
      }
    }

    for (const s of servers) {
      if (erroredServers[s.id]) continue;
      const m = perServer[s.id] || {};
      if (m[code] == null) missing.push({ code, serverId: s.id, type: 'missing', ...meta(s.id) });
    }
  }

  const unreachable = Object.keys(erroredServers).map((id) => ({
    serverId: id,
    type: 'unreachable',
    detail: erroredServers[id],
    ...meta(id)
  }));

  return { totalCodes: allCodes.size, consistentCodes, anomalies, missing, conflicts, unreachable };
}

/**
 * 少数服务多数算法：计算「多数派代码集合」与「每台机少数派独有代码集合」。
 */
function computeMajority(perServer, servers, intendedN) {
  const N = (typeof intendedN === 'number' && intendedN > 0) ? intendedN : servers.length;
  const threshold = N >= 3 ? (N - 1) : (N >= 1 ? 1 : 0);

  const codeCounts = new Map();
  const perServerCodes = {};
  for (const s of servers) {
    const m = perServer[s.id];
    if (!m || m.__error) { perServerCodes[s.id] = []; continue; }
    const codes = Object.keys(m);
    perServerCodes[s.id] = codes;
    for (const c of codes) codeCounts.set(c, (codeCounts.get(c) || 0) + 1);
  }

  const majoritySet = new Set();
  for (const [code, count] of codeCounts) {
    if (count >= threshold) majoritySet.add(code);
  }

  const minorityOnly = {};
  const minorityOnlyByServer = {};
  let minorityOnlyTotal = 0;
  for (const s of servers) {
    const codes = perServerCodes[s.id] || [];
    const own = codes.filter((c) => !majoritySet.has(c));
    minorityOnly[s.id] = own;
    minorityOnlyByServer[s.id] = own.length;
    minorityOnlyTotal += own.length;
  }

  return { threshold, N, majoritySet, majoritySize: majoritySet.size, minorityOnly, minorityOnlyByServer, minorityOnlyTotal };
}

/**
 * 直接 diff 对比算法（少数服从多数）。
 *
 * 不再「逐 code 比哈希值」，而是把每台机的 b2sum 文件视为「(code,hash) 行集合」做 diff：
 *   - 统计每个 (code,hash) 对在多少台机出现；
 *   - 出现次数 ≥ 阈值(N≥3 ? N-1 : 1) 的 (code,hash) 进入「多数派」；
 *   - 某台机里不在多数派集合中的行 → 少数派差异 → 异常(diff)；
 *   - 多数派代码在该机缺失 → missing；
 *   - 失败/无数据(__error) 的机 → unreachable。
 *
 * 少数派（不同）即异常，满足「少数服从多数」语义。每条异常/缺失/不可达都带 market，
 * 便于前端按「区域+IP+市场」展示详细不同的代码。
 *
 * @param {object} perServer { serverId: { code: hash } | { __error: msg } }
 * @param {Array} servers [{ id }]
 * @param {object} opts { intendedN, serverInfo, market }
 */
function computeMajorityDiff(perServer, servers, opts = {}) {
  const serverInfo = opts.serverInfo || {};
  const market = opts.market;
  const meta = (id) => {
    const i = (serverInfo && serverInfo[id]) || {};
    return { serverName: i.name || id, zone: i.zone || '-', zoneName: i.zoneName || '-', market };
  };
  const N = (typeof opts.intendedN === 'number' && opts.intendedN > 0) ? opts.intendedN : servers.length;
  const threshold = N >= 3 ? (N - 1) : (N >= 1 ? 1 : 0);

  const erroredServers = {};
  for (const s of servers) {
    const m = perServer[s.id];
    if (!m || (m && m.__error)) erroredServers[s.id] = (m && m.__error) || '无数据';
  }

  // 按 code 聚合各 hash 的出现次数
  const codePairs = new Map(); // code -> Map(hash -> count)
  for (const s of servers) {
    if (erroredServers[s.id]) continue;
    const m = perServer[s.id] || {};
    for (const [code, hash] of Object.entries(m)) {
      if (!codePairs.has(code)) codePairs.set(code, new Map());
      const hm = codePairs.get(code);
      hm.set(hash, (hm.get(hash) || 0) + 1);
    }
  }

  // 多数派：某 code 下出现次数最高的 hash，若该次数 ≥ threshold 则该 code 为多数派代码（hash 一致）
  const majoritySet = new Set();
  const majorityHashByCode = new Map();
  for (const [code, hm] of codePairs) {
    let bestHash = null, bestCount = 0;
    for (const [hash, cnt] of hm) {
      if (cnt > bestCount) { bestCount = cnt; bestHash = hash; }
    }
    if (bestCount >= threshold) {
      majoritySet.add(code);
      majorityHashByCode.set(code, bestHash);
    }
  }

  // 多数文件代码：出现于 ≥ threshold 台服务器的代码（不要求 hash 一致，只要代码行数够多即算）
  const majorityCodeSet = new Set();
  for (const [code, hm] of codePairs) {
    let totalServersWithCode = 0;
    for (const [hash, cnt] of hm) totalServersWithCode += cnt;
    if (totalServersWithCode >= threshold) majorityCodeSet.add(code);
  }

  const anomalies = [];   // 哈希不一致明细（代码在多数服务器中存在，但本机哈希与多数派不同）
  const extraCodes = [];  // 多出代码明细（代码只在少数服务器出现，多数服务器没有）
  const missing = [];
  const anomalyCodeSet = new Set();  // 哈希不一致的 distinct 代码
  const extraCodeSet = new Set();    // 多出的 distinct 代码
  for (const s of servers) {
    if (erroredServers[s.id]) continue;
    const m = perServer[s.id] || {};
    for (const [code, hash] of Object.entries(m)) {
      if (!majorityCodeSet.has(code)) {
        // 多出代码：多数服务器（≥ threshold 台）都没有这个代码，只有少数机器有
        extraCodes.push({ code, serverId: s.id, type: 'extra', expected: '(多数服务器无此代码)', actual: hash, ...meta(s.id) });
        extraCodeSet.add(code);
      } else if (majoritySet.has(code) && majorityHashByCode.get(code) !== hash) {
        // 哈希不一致：代码在多数派中，但本机哈希与多数派哈希不同
        anomalies.push({ code, serverId: s.id, type: 'hash_mismatch', expected: majorityHashByCode.get(code), actual: hash, ...meta(s.id) });
        anomalyCodeSet.add(code);
      } else if (!majoritySet.has(code)) {
        // 代码多数服务器都有，但哈希分裂、无共识（如 5 台 hashA / 5 台 hashB）→ 也算哈希不一致
        anomalies.push({ code, serverId: s.id, type: 'hash_conflict', expected: '(各服务器哈希不一致)', actual: hash, ...meta(s.id) });
        anomalyCodeSet.add(code);
      }
    }
    // 多数文件代码缺失 → missing（多数服务器有的代码，本机没有）
    for (const code of majorityCodeSet) {
      if (m[code] == null) missing.push({ code, serverId: s.id, type: 'missing', ...meta(s.id) });
    }
  }

  // 全一致代码：多数派代码且每台非失败机都持有该多数派 hash
  let consistentCodes = 0;
  for (const code of majoritySet) {
    const mh = majorityHashByCode.get(code);
    let allOk = true;
    for (const s of servers) {
      if (erroredServers[s.id]) continue;
      if ((perServer[s.id] || {})[code] !== mh) { allOk = false; break; }
    }
    if (allOk) consistentCodes++;
  }

  const unreachable = Object.keys(erroredServers).map((id) => ({
    serverId: id, type: 'unreachable', detail: erroredServers[id], ...meta(id)
  }));

  return {
    threshold, N,
    totalCodes: majorityCodeSet.size,
    consistentCodes,
    anomalies, extraCodes, missing, conflicts: [], unreachable,
    // distinct 计数（不会超过代码总数）
    anomalyCodeCount: anomalyCodeSet.size,   // 哈希不一致的代码数
    extraCodeCount: extraCodeSet.size,       // 多出代码数
    anomalyCodeSet, extraCodeSet,
    majoritySet, majoritySize: majoritySet.size,
    majorityCodeSet, majorityCodeSize: majorityCodeSet.size,
    // 少数派独有已并入 extraCodes，这里保留空结构以兼容前端
    minorityOnly: {}, minorityOnlyByServer: {}, minorityOnlyTotal: 0
  };
}

/**
 * 从本地 b2sumdata 目录扫描某市场下有哪些服务器(IP)文件。
 * 默认按 {ip}-{market}-NIG.b2sum 解析 IP；也兼容 {market}.{server}.txt 旧命名。
 * 返回 serverId(IP) 数组。
 */
function scanLocalServers(localDir, market, pattern) {
  const pat = pattern || objectStorage.PATH_PATTERN;
  // 转义 market 中的正则特殊字符（如 $ ^ . * + ? 等），否则含 $ 的市场代码（B$、A$）会破坏正则
  const escapedMarket = String(market).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + pat
    .replace(/[.+?^${}()|[\]\\]/g, (m) => m === '.' ? '\\.' : m)
    .replace(/\{ip\}/g, '(?<ip>.+?)')
    .replace(/\{market\}/g, escapedMarket)
    .replace(/\{server\}/g, '(?<server>.+?)')
    .replace(/\{serverName\}/g, '.+?')
    .replace(/\{zone\}/g, '.*?') + '$';
  const re = new RegExp(regexStr);
  const serverIds = [];
  if (!fs.existsSync(localDir)) return serverIds;
  for (const f of fs.readdirSync(localDir)) {
    const m = f.match(re);
    const id = m && m.groups && (m.groups.ip || m.groups.server);
    if (id) serverIds.push(id);
  }
  return serverIds;
}

/**
 * 执行巡检（对象存储数据源）。
 *
 * 流程：
 *   1. 从本地 b2sumdata/ 目录（由 syncObjectStorage 从对象存储拉取）读取各市场各服务器的哈希文件；
 *   2. 按文件名 {market}.{serverId}.txt 自动发现服务器（无需在 config.json 配置服务器）；
 *   3. 对每个市场构建 perServer，运行多数派 / 参考机对比算法；
 *   4. 输出 summary + 分区结果。
 *
 * @param {object} config 完整配置
 * @param {object} scope { zones:'all'|string[], markets:'all'|string[], compareMode:'per-zone'|'merged', compareAlgorithm:'majority'|'reference', referenceServerId, maxCodes }
 */
async function inspect(config, scope) {
  const t0 = Date.now();
  const settings = config.settings || {};
  const os = config.objectStorage || {};
  const localDir = path.resolve(__dirname, '..', os.localDir || 'b2sumdata');

  // 对比算法：'majority'（默认，少数服从多数）或 'reference'（以参考机哈希为基准差异即异常）
  const compareAlgorithm = (scope.compareAlgorithm === 'reference') ? 'reference' : 'majority';

  const globalLimit = Math.max(1, settings.concurrency || 4);
  const compareMode = scope.compareMode === 'merged' ? 'merged' : 'per-zone';

  // 巡检代码数上限：0 / 未传 = 不限制，比较全部代码。
  const effectiveMax = (scope.maxCodes != null && Number(scope.maxCodes) >= 0)
    ? Number(scope.maxCodes)
    : (Number(settings.maxCodes) || 0);

  const runId = scope.runId || ('run-' + Date.now());
  const runDir = resolveRunDir(runId);
  const projectRoot = path.resolve(__dirname, '..');
  if (scope.compareOnly === true) {
    if (!fs.existsSync(runDir)) {
      throw new Error('采集批次文件夹不存在: ' + runDir + '（请先执行一次普通巡检生成采集）');
    }
  } else {
    ensureDirSync(runDir);
  }

  // 直接使用本地 b2sumdata/ 目录中已同步的文件做 diff 对比。
  // 对象存储文件拉取由定时任务或手动「立即拉取」按钮触发，不再在巡检流程中自动拉取。

  // 市场筛选
  const requestedMarketScope = scope.markets === 'all' || scope.markets == null
    ? 'all'
    : (Array.isArray(scope.markets) ? scope.markets.join(',') : scope.markets);
  const marketCodes = scope.markets === 'all' || scope.markets == null
    ? null
    : (Array.isArray(scope.markets) ? scope.markets : [scope.markets]);
  const markets = (config.markets || [])
    .filter((m) => m.enabled !== false)
    .filter((m) => marketCodes === null || marketCodes.includes(m.code));

  // 分区筛选（对象存储模式下分区仅用于结果分组；服务器自动发现，按 IP 网段归区）
  const definedZones = config.zones || [];
  const zones = definedZones.filter(
    (z) => scope.zones === 'all' || (Array.isArray(scope.zones) && scope.zones.includes(z.id))
  );
  const zoneNameById = {};
  definedZones.forEach((z) => { zoneNameById[z.id] = z.name; });

  // 服务器 -> 分区归区：
  //   1) 优先按分区网段匹配（zone.networkSegment，如华北 10.37 / 华东 10.36 / 华南 10.61）；
  //   2) 回退到旧的 serverZoneMap 手动映射（兼容历史 config）；
  //   3) 都未命中归入「未分区」。
  const serverZoneMap = config.serverZoneMap || {};
  const resolveZoneForServer = (ip) =>
    objectStorage.matchZoneBySegment(ip, definedZones) || serverZoneMap[ip] || '__default__';

  // 批次 manifest
  const manifest = {
    runId,
    createdAt: new Date().toISOString(),
    compareMode,
    effectiveMax,
    codeListByMarket: {},
    referenceServerId: null,
    referenceServerName: null,
    codeListSource: 'objectStorage',
    totalServers: 0,
    excludedServerIds: []
  };

  // 全部参与服务器 IP（所有已同步/已快照文件中出现的服务器，与「发现服务器」口径一致）：
  //   - 普通模式：扫描本地 b2sumdata 所有 <ip>-<market>-NIG.b2sum 文件
  //   - compareOnly 模式：扫描 runDir 下所有 <market>/<ip>.json
  const allServerIds = new Set();
  if (scope.compareOnly === true) {
    if (fs.existsSync(runDir)) {
      for (const mk of fs.readdirSync(runDir)) {
        const mkDir = path.join(runDir, mk);
        let st; try { st = fs.statSync(mkDir); } catch (e) { continue; }
        if (!st.isDirectory()) continue;
        for (const f of fs.readdirSync(mkDir)) {
          if (f.endsWith('.json')) allServerIds.add(f.replace(/\.json$/, ''));
        }
      }
    }
  } else if (fs.existsSync(localDir)) {
    for (const f of fs.readdirSync(localDir)) {
      const info = objectStorage.parseObjectKey(f, '', objectStorage.PATH_PATTERN);
      if (info && info.serverId) allServerIds.add(info.serverId);
    }
  }

  // 各启用市场的服务器覆盖（market -> 有该市场文件的 serverId[]）
  const marketServers = {};
  for (const m of markets) {
    marketServers[m.code] = scope.compareOnly === true
      ? Object.keys(readFolderForComparison(runDir, m.code))
      : scanLocalServers(localDir, m.code, objectStorage.PATH_PATTERN);
  }

  // 市场覆盖度（与「发现服务器」共用同一单点口径）：
  //   - 所有服务器都有的市场（full）→ 参与 diff 对比
  //   - 仅部分服务器有的市场（partial）→ 跳过（少数机器才有的市场无法做跨机一致性对比）
  const coverage = objectStorage.selectMarketsByCoverage(marketServers, Array.from(allServerIds));
  const fullMarketSet = new Set(coverage.full);
  const compareMarkets = markets.filter((m) => fullMarketSet.has(m.code));
  const skippedMarkets = coverage.partial
    .filter((p) => markets.some((m) => m.code === p.market))
    .map((p) => ({ market: p.market, present: p.present, totalServers: coverage.totalServers, missing: p.missing }));

  // 服务器元数据（id -> {name, zone, zoneName}）：name 取 IP，zone 按网段归区
  const serverInfo = {};
  for (const id of allServerIds) {
    const zoneId = resolveZoneForServer(id);
    serverInfo[id] = { name: id, zone: zoneId, zoneName: zoneNameById[zoneId] || (zoneId === '__default__' ? '未分区' : zoneId) };
  }

  // 构造对比分组（并发统一使用全局 settings.concurrency，不再按分区配置）
  let groups;
  if (compareMode === 'merged') {
    // 多区合并：把所有服务器放入一个对比池
    const pool = Array.from(allServerIds).map((id) => ({ id, ...serverInfo[id] }));
    groups = [{ zone: '__merged__', name: '全部服务器对比', concurrency: globalLimit, servers: pool }];
  } else {
    // 单区对比：按分区网段把服务器分组；未命中网段的服务器归入"未分区"
    const zoneServers = {};
    for (const id of allServerIds) {
      const zoneId = resolveZoneForServer(id);
      if (!zoneServers[zoneId]) zoneServers[zoneId] = [];
      zoneServers[zoneId].push({ id, ...serverInfo[id] });
    }
    const zoneList = zones.length ? zones : [{ id: '__default__', name: '未分区' }];
    groups = zoneList.map((z) => ({
      zone: z.id,
      name: z.name,
      concurrency: globalLimit,
      servers: zoneServers[z.id] || []
    }));
  }

  // 逐组对比
  const groupResults = await mapLimit(groups, globalLimit, async (group) => {
    if (!group.servers.length) {
      return { zone: group.zone, name: group.name, note: '无服务器数据', markets: [], excludedServers: [] };
    }

    const groupLimit = Math.max(1, group.concurrency || globalLimit);
    const groupTotalServers = group.servers.length;
    // 只对比所有服务器都有的市场（compareMarkets）；部分覆盖市场已跳过
    const marketResults = await mapLimit(compareMarkets, groupLimit, async (market) => {
      // 只取本分组内、该市场有哈希文件的服务器
      const marketServerIds = marketServers[market.code] || [];
      const liveServers = group.servers.filter((s) => marketServerIds.includes(s.id));

      if (!liveServers.length) {
        return {
          market: market.code,
          name: market.name,
          totalCodes: 0, consistentCodes: 0,
          anomalies: [], missing: [], conflicts: [], unreachable: [],
          totalServers: 0, groupTotalServers,
          majorityThreshold: 0, majoritySize: 0, minorityOnlyByServer: {}, minorityOnlyTotal: 0, minorityOnlyDetail: {},
          codeListSize: 0, codeListSource: 'objectStorage',
          referenceServerId: null, referenceServerName: null,
          runId, dataDir: path.relative(projectRoot, runDir) || String(runDir),
          compareAlgorithm
        };
      }

      // 读取各服务器哈希：
      //   - 普通模式：从本地 b2sumdata 读取
      //   - compareOnly 模式：从 runDir 历史快照读取
      let perServer;
      if (scope.compareOnly === true) {
        perServer = readFolderForComparison(runDir, market.code);
      } else {
        // 文件命名/格式/后缀为系统固定常量（{ip}-{market}-NIG.b2sum / b2sum / .NIG），不从配置读取
        perServer = objectStorage.readObjectStorageForComparison(
          localDir,
          market.code,
          liveServers
        );
      }

      // 参考机选择：优先 scope.referenceServerId，否则分组第一台
      let referenceServer = null;
      if (scope.referenceServerId) {
        referenceServer = liveServers.find((s) => s.id === scope.referenceServerId) || null;
      }
      if (!referenceServer) referenceServer = liveServers[0] || null;

      // 把哈希落盘到 runDir，支持 compareOnly 复查
      if (scope.compareOnly !== true) {
        for (const s of liveServers) {
          const h = perServer[s.id];
          if (h && !h.__error) {
            writeServerHashes(runDir, market.code, s.id, {
              serverId: s.id, market: market.code, fetchedAt: new Date().toISOString(),
              status: 'ok', hashes: h
            });
          } else if (h && h.__error) {
            writeServerHashes(runDir, market.code, s.id, {
              serverId: s.id, market: market.code, fetchedAt: new Date().toISOString(),
              status: 'error', error: h.__error
            });
          }
        }
      }

      // 截断到 effectiveMax（按 code 数截断，仅影响展示，不影响文件）
      // 注意：对象存储模式下 code 来自文件，截断会减少对比的 code 数量
      let effectivePerServer = perServer;
      if (effectiveMax > 0) {
        effectivePerServer = {};
        for (const sid of Object.keys(perServer)) {
          const h = perServer[sid];
          if (h && !h.__error) {
            const codes = Object.keys(h).slice(0, effectiveMax);
            const sliced = {};
            for (const c of codes) sliced[c] = h[c];
            effectivePerServer[sid] = sliced;
          } else {
            effectivePerServer[sid] = h;
          }
        }
      }

      const folderServers = Object.keys(effectivePerServer);
      let a, maj, compareMeta = {};

      // 无论对比算法如何，先跑一遍 computeMajorityDiff 拿到「多数文件代码数」(totalCodes)
      // 以及真正的多数派 hash 集合 (majoritySet/majoritySize)
      const diff = computeMajorityDiff(effectivePerServer, folderServers.map((id) => ({ id })), {
        intendedN: group.servers.length, serverInfo, market: market.code
      });

      if (compareAlgorithm === 'reference' && referenceServer && effectivePerServer[referenceServer.id] && !effectivePerServer[referenceServer.id].__error) {
        const ref = computeReferenceCompare(effectivePerServer, referenceServer.id, serverInfo, { market: market.code });
        // 参考机模式：哈希不一致代码数按 ref.anomalies 的 distinct 代码统计
        const refAnomalyCodes = new Set((ref.anomalies || []).map((x) => x.code));
        // totalCodes 统一用多数文件代码数（出现于 ≥ threshold 台服务器的代码数）
        a = {
          totalCodes: diff.totalCodes,
          consistentCodes: ref.consistentCodes,
          anomalies: ref.anomalies,
          extraCodes: diff.extraCodes,
          anomalyCodeCount: refAnomalyCodes.size,
          extraCodeCount: diff.extraCodeCount,
          missing: ref.missing,
          conflicts: ref.conflicts,
          unreachable: ref.unreachable
        };
        maj = {
          threshold: diff.threshold, N: diff.N,
          majoritySet: diff.majoritySet, majoritySize: diff.majoritySize,
          minorityOnly: {}, minorityOnlyByServer: {}, minorityOnlyTotal: 0
        };
        compareMeta = { compareAlgorithm: 'reference', baselineServerId: referenceServer.id, baselineServerName: referenceServer.name };
      } else {
        // 直接 diff（少数服从多数）：少数派不同的行即异常，带 market 便于按 区域+IP+市场 展示
        a = {
          totalCodes: diff.totalCodes,
          consistentCodes: diff.consistentCodes,
          anomalies: diff.anomalies,
          extraCodes: diff.extraCodes,
          anomalyCodeCount: diff.anomalyCodeCount,
          extraCodeCount: diff.extraCodeCount,
          missing: diff.missing,
          conflicts: diff.conflicts,
          unreachable: diff.unreachable
        };
        maj = {
          threshold: diff.threshold, N: diff.N, majoritySet: diff.majoritySet,
          majoritySize: diff.majoritySize, minorityOnly: diff.minorityOnly,
          minorityOnlyByServer: diff.minorityOnlyByServer, minorityOnlyTotal: diff.minorityOnlyTotal
        };
        compareMeta = { compareAlgorithm: 'majority' };
      }

      // 码表大小 = 多数文件代码数（出现于 ≥ threshold 台服务器的代码，不要求 hash 一致）
      const codeListSize = diff.majorityCodeSize || a.totalCodes || 0;
      manifest.codeListByMarket[market.code] = Array.from(maj.majoritySet || []);
      if (!manifest.referenceServerId && referenceServer) {
        manifest.referenceServerId = referenceServer.id;
        manifest.referenceServerName = referenceServer.name;
      }

      return {
        market: market.code,
        name: market.name,
        ...a,
        totalServers: folderServers.length,
        groupTotalServers,
        majorityThreshold: maj.threshold,
        majoritySize: maj.majoritySize,
        minorityOnlyByServer: maj.minorityOnlyByServer,
        minorityOnlyTotal: maj.minorityOnlyTotal,
        minorityOnlyDetail: maj.minorityOnly,
        codeListSize,
        codeListSource: 'objectStorage',
        referenceServerId: referenceServer ? referenceServer.id : null,
        referenceServerName: referenceServer ? referenceServer.name : null,
        runId,
        dataDir: path.relative(projectRoot, runDir) || String(runDir),
        ...compareMeta
      };
    });

    manifest.totalServers += group.servers.length;
    return { zone: group.zone, name: group.name, totalServers: group.servers.length, markets: marketResults, excludedServers: [] };
  });

  // manifest 记录市场覆盖口径：仅 full 市场参与对比
  manifest.totalMarkets = markets.length;
  manifest.comparedMarkets = compareMarkets.map((m) => m.code);
  manifest.skippedMarkets = skippedMarkets;
  if (scope.compareOnly !== true) writeManifest(runDir, manifest);

  // 聚合（台数按分区求和：每台服务器只归一个分区，不重复计数）
  let totalCodes = 0, consistent = 0, anom = 0, extra = 0, miss = 0, conf = 0, unreach = 0;
  let majoritySizeTotal = 0, minorityOnlyTotalSum = 0, majorityThresholdMax = 0;
  let codeListSizeTotal = 0;
  const groupTotalServersSum = groupResults.reduce((n, gr) => n + (gr.totalServers || 0), 0);
  let firstReferenceServerId = null, firstReferenceServerName = null;
  // 异常服务器去重集合：任一市场/分区中出现哈希不一致或多出代码的服务器 IP（跨市场只计一次）
  const anomalousServerSet = new Set();
  for (const gr of groupResults) {
    for (const mr of gr.markets) {
      totalCodes += mr.totalCodes;
      consistent += mr.consistentCodes;
      // 异常代码数：按 distinct 代码计数（不超过代码总数），而非按服务器×代码条目数
      anom += (mr.anomalyCodeCount || 0);
      extra += (mr.extraCodeCount || 0);
      miss += (mr.missing || []).length;
      conf += (mr.conflicts || []).length;
      unreach += (mr.unreachable || []).length;
      for (const x of (mr.anomalies || [])) {
        if (x && x.serverId) anomalousServerSet.add(x.serverId);
      }
      for (const x of (mr.extraCodes || [])) {
        if (x && x.serverId) anomalousServerSet.add(x.serverId);
      }
      majoritySizeTotal += mr.majoritySize || 0;
      minorityOnlyTotalSum += mr.minorityOnlyTotal || 0;
      if ((mr.majorityThreshold || 0) > majorityThresholdMax) majorityThresholdMax = mr.majorityThreshold;
      codeListSizeTotal += mr.codeListSize || 0;
      if (!firstReferenceServerId && mr.referenceServerId) firstReferenceServerId = mr.referenceServerId;
      if (!firstReferenceServerName && mr.referenceServerName) firstReferenceServerName = mr.referenceServerName;
    }
  }
  const anomalousServerIds = Array.from(anomalousServerSet).sort();

  const summary = {
    compareMode,
    maxCodes: effectiveMax,
    marketScope: requestedMarketScope,
    dataSource: 'objectStorage',
    totalMarkets: markets.length,
    comparedMarkets: compareMarkets.length,
    skippedMarketCount: skippedMarkets.length,
    skippedMarkets,
    majorityThreshold: majorityThresholdMax,
    groupTotalServers: groupTotalServersSum,
    majoritySize: majoritySizeTotal,
    minorityOnlyTotal: minorityOnlyTotalSum,
    zones: groupResults.length,
    markets: groupResults.reduce((n, z) => n + z.markets.length, 0),
    totalCodes,
    consistentCodes: consistent,
    anomalies: anom,
    extraCodes: extra,
    anomalousServers: anomalousServerIds.length,
    anomalousServerIds,
    missing: miss,
    conflicts: conf,
    unreachableServers: unreach,
    excludedServers: 0,
    healthRate: majoritySizeTotal > 0 ? Number((consistent / majoritySizeTotal).toFixed(4)) : 1,
    codeListSizeTotal,
    referenceServerId: firstReferenceServerId,
    referenceServerName: firstReferenceServerName,
    codeListSource: 'objectStorage',
    compareAlgorithm,
    runId,
    dataDir: path.relative(projectRoot, runDir) || String(runDir),
    collectMode: scope.compareOnly === true ? 'compare_only' : 'full'
  };

  return { summary, zones: groupResults, elapsedMs: Date.now() - t0 };
}

module.exports = {
  inspect, analyze, computeMajority, computeMajorityDiff, computeReferenceCompare,
  parseHashOutput,
  mapLimit,
  resolveRunDir, writeServerHashes, readFolderForComparison, writeManifest,
  scanLocalServers
};
