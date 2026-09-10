/**
 * 对象存储数据源模块（TOS SDK @volcengine/tos-sdk）。
 *
 * 设计目标：把「哈希采集来源」从 SSH 换成对象存储——巡检时用 TOS SDK
 * 直接把对象存储里的 b2sum 文件拉到本地 b2sumdata/ 目录，再复用现有的
 * computeMajority / analyze / computeReferenceCompare 对比算法。
 *
 * 密钥配置：
 *   - AccessKey / SecretKey 直接配置在 config.json 的 objectStorage 节点中
 *     （accessKey / secretKey 字段），不再依赖 tosutil 配置文件或环境变量。
 *   - 本模块持有密钥仅用于初始化 TosClient，不外泄、不落日志。
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------
 * 对象存储文件约定（系统固定常量，不在界面配置）
 *   - 文件命名：<ip>-<market>-NIG.b2sum，如 10.61.1.56-ZO-NIG.b2sum
 *   - 文件格式：b2sum 原生输出（每行 "<hash><空白><code>.NIG"）
 *   - 代码后缀：.NIG（解析时剥离，得到项目内 code）
 * ------------------------------------------------------------------ */
const PATH_PATTERN = '{ip}-{market}-NIG.b2sum';
const FILE_FORMAT = 'b2sum';
const CODE_SUFFIX = '.NIG';

/**
 * 延迟加载 TOS SDK：仅在真正需要访问对象存储时才 require，
 * 保证测试 / 未启用对象存储的场景不依赖该包。
 */
function loadTosSdk() {
  return require('@volcengine/tos-sdk');
}

/**
 * 按 IP 网段把服务器(IP)归入分区。
 * 分区配置 zone.networkSegment 为网段前缀（如 '10.37'），
 * IP 以 '<segment>.' 开头（或完全相等）即归入该分区。
 * 匹配优先级：第 3 段更精确的网段优先（如 10.37.1 优先于 10.37）。
 *
 * @param {string} ip 服务器 IP（自动发现的 serverId）
 * @param {Array} zones 分区列表 [{ id, name, networkSegment }]
 * @returns {string|null} 命中的 zoneId，未命中返回 null
 */
function matchZoneBySegment(ip, zones) {
  if (!ip) return null;
  let best = null, bestLen = -1;
  for (const z of (zones || [])) {
    const seg = String(z.networkSegment || '').trim();
    if (!seg) continue;
    if (ip === seg || ip.startsWith(seg + '.')) {
      if (seg.length > bestLen) { best = z.id; bestLen = seg.length; }
    }
  }
  return best;
}

/**
 * 统计本地 b2sumdata 目录中已同步的服务器（按 <ip>-<market>-NIG.b2sum 去重 IP），
 * 并按分区网段分组计数，用于分区配置页展示「台数」。
 *
 * @param {object} cfg 完整配置
 * @returns {{ total:number, zones: {[zoneId:string]: {segment:string, count:number, servers:string[]}}, unmapped: string[] }}
 */
function countLocalServers(cfg) {
  const os = (cfg && cfg.objectStorage) || {};
  const localDir = path.resolve(__dirname, '..', os.localDir || 'b2sumdata');
  const ips = new Set();
  if (fs.existsSync(localDir)) {
    for (const f of fs.readdirSync(localDir)) {
      const info = parseObjectKey(f, '', PATH_PATTERN);
      if (info && info.serverId) ips.add(info.serverId);
    }
  }
  const zones = cfg.zones || [];
  const result = { total: ips.size, zones: {}, unmapped: [] };
  for (const z of zones) {
    result.zones[z.id] = { segment: z.networkSegment || '', count: 0, servers: [] };
  }
  for (const ip of ips) {
    const zoneId = matchZoneBySegment(ip, zones);
    if (zoneId && result.zones[zoneId]) {
      result.zones[zoneId].count++;
      result.zones[zoneId].servers.push(ip);
    } else {
      result.unmapped.push(ip);
    }
  }
  return result;
}

/**
 * 市场覆盖度判定（单点口径：发现接口与巡检 diff 共用，保证口径一致）。
 * 只有「所有已发现服务器都有该市场文件」的市场才参与 diff 对比；
 * 仅部分服务器有的市场跳过（少数机器才有的市场无法做跨机一致性对比）。
 *
 * @param {Object<string, string[]>} marketServers 市场 -> 有该市场文件的 serverId 列表
 * @param {string[]} allServerIds 全部已发现服务器 IP
 * @returns {{
 *   totalServers: number,
 *   full: string[],                       // 所有服务器都有的市场（参与 diff）
 *   partial: Array<{market:string, servers:string[], present:number, missing:string[]}> // 仅部分服务器有的市场（跳过）
 * }}
 */
function selectMarketsByCoverage(marketServers, allServerIds) {
  const all = Array.from(allServerIds || []);
  const full = [];
  const partial = [];
  for (const [market, srvs] of Object.entries(marketServers || {})) {
    const list = srvs || [];
    const present = new Set(list);
    const missing = all.filter((id) => !present.has(id));
    if (all.length > 0 && missing.length === 0) {
      full.push(market);
    } else {
      partial.push({ market, servers: list, present: list.length, missing });
    }
  }
  full.sort();
  partial.sort((a, b) => a.market.localeCompare(b.market));
  return { totalServers: all.length, full, partial };
}

/**
 * 用 config.objectStorage 里的密钥创建 TosClient 实例。
 * @param {object} cfg 完整配置（读 cfg.objectStorage）
 * @returns {TosClient}
 */
function createTosClient(cfg) {
  const os = (cfg && cfg.objectStorage) || {};
  if (!os.accessKey || !os.secretKey) {
    throw new Error('对象存储未配置密钥：请在 config.json 的 objectStorage 中填写 accessKey 与 secretKey');
  }
  if (!os.region) {
    throw new Error('对象存储未配置 region：请在 config.json 的 objectStorage 中填写 region（如 cn-shanghai）');
  }
  const { TosClient } = loadTosSdk();
  return new TosClient({
    accessKeyId: os.accessKey,
    accessKeySecret: os.secretKey,
    region: os.region,
    endpoint: os.endpoint || `tos-${os.region}.volces.com`,
    connectionTimeout: os.connectionTimeout || 10000,
    requestTimeout: os.requestTimeout || 120000,
    maxRetryCount: os.maxRetryCount != null ? os.maxRetryCount : 3
  });
}

/**
 * 解析某个市场某台服务器在 b2sumdata 下的文件路径。
 * pattern 支持占位符：{ip} {market} {server}(=server.id，{ip} 的别名) {serverName} {zone}。
 * 默认对象存储命名：{ip}-{market}-NIG.b2sum（如 10.61.1.56-ZO-NIG.b2sum）。
 * 例：pattern='{ip}-{market}-NIG.b2sum' + market='ZO' + server={id:'10.61.1.56'}
 *     => '<localDir>/10.61.1.56-ZO-NIG.b2sum'
 */
function resolveB2sumPath(localDir, market, server, pattern) {
  const pat = pattern || PATH_PATTERN;
  const name = pat
    .replace(/\{ip\}/g, server.id)
    .replace(/\{market\}/g, market)
    .replace(/\{server\}/g, server.id)
    .replace(/\{serverName\}/g, server.name || server.id)
    .replace(/\{zone\}/g, server.zone || '');
  return path.join(localDir, name);
}

/**
 * 从对象 key 反解出 market 与 serverId(=IP)。
 * 占位符用非贪婪 .+? 匹配，兼容含 '.' 的 IP（10.61.1.56）与 '-' 分隔的命名。
 * 例：key='file/b2sumkline/10.61.1.56-ZO-NIG.b2sum', prefix='file/b2sumkline',
 *     pattern='{ip}-{market}-NIG.b2sum' => { market: 'ZO', serverId: '10.61.1.56' }
 * 无法匹配时返回 null。
 */
function parseObjectKey(key, prefix, pattern) {
  const pat = pattern || PATH_PATTERN;
  // 去掉前缀，得到相对文件名（含可能的子目录）
  let rel = key;
  if (prefix) {
    const p = prefix.replace(/\/+$/, '') + '/';
    if (rel.startsWith(p)) rel = rel.slice(p.length);
  }
  // 取最后一级文件名（兼容子目录）
  const fileName = path.basename(rel);
  // 把 pattern 转成正则：占位符 -> (?<name>.+?)（非贪婪，兼容 IP 的 '.'）
  const regexStr = '^' + pat
    .replace(/[.+?^${}()|[\]\\]/g, (m) => m === '.' ? '\\.' : m)
    .replace(/\{ip\}/g, '(?<ip>.+?)')
    .replace(/\{market\}/g, '(?<market>.+?)')
    .replace(/\{server\}/g, '(?<server>.+?)')
    .replace(/\{serverName\}/g, '.+?')
    .replace(/\{zone\}/g, '.*?') + '$';
  const m = fileName.match(new RegExp(regexStr));
  if (!m || !m.groups) return null;
  const serverId = m.groups.ip || m.groups.server;
  if (!serverId) return null;
  return { market: m.groups.market, serverId };
}

/**
 * 解析单个 b2sum 文件内容。
 * @param {string} content 文件全文
 * @param {object} opts { fileFormat: 'b2sum'|'code-hash', codeStripSuffix: '.NIG' }
 *   每行约定 "<字段A><空白><字段B>"：
 *   - 'b2sum'（默认，b2sum/sha256sum 原生输出）：A=hash, B=code(文件名) => key=B, value=A
 *   - 'code-hash'（本项目 SSH 模式 awk 交换后的格式）：A=code, B=hash => key=A, value=B
 *   code 取 basename 并剥离 codeStripSuffix（默认剥离 .NIG），与项目内 code 语义一致。
 * @returns {object} { code: hash }
 */
function parseB2sumContent(content, opts = {}) {
  const fileFormat = opts.fileFormat || FILE_FORMAT;
  const suffix = opts.codeStripSuffix != null ? opts.codeStripSuffix : CODE_SUFFIX;
  const map = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^#/.test(t)) continue; // 跳过注释行
    const parts = t.split(/\s+/);
    if (parts.length < 2) continue;
    let code, hash;
    if (fileFormat === 'code-hash') {
      code = parts[0];
      hash = parts[1];
    } else {
      hash = parts[0];
      code = parts[1];
    }
    code = path.basename(code); // 兼容 b2sum 输出绝对/相对路径
    if (suffix && code.endsWith(suffix)) code = code.slice(0, -suffix.length);
    if (!code) continue;
    map[code] = hash;
  }
  return map;
}

/**
 * 从本地 b2sumdata 目录读取某市场各服务器的哈希，重建 perServer。
 * 输出结构与 inspector.readFolderForComparison 完全一致：
 *   { serverId: {code:hash} } 或 { serverId: {__error: msg} }（文件缺失/读取失败）
 * 因此可原样喂给 computeMajority / analyze / computeReferenceCompare。
 *
 * @param {string} localDir b2sumdata 根目录（绝对或相对项目根）
 * @param {string} market 市场代码（如 SH）
 * @param {Array} servers 服务器配置数组 [{id,name,zone,...}]
 * @param {object} opts { pathPattern, fileFormat, codeStripSuffix }
 */
function readObjectStorageForComparison(localDir, market, servers, opts = {}) {
  const perServer = {};
  for (const s of servers) {
    const file = resolveB2sumPath(localDir, market, s, opts.pathPattern);
    try {
      if (!fs.existsSync(file)) {
        perServer[s.id] = { __error: 'b2sumdata 文件缺失: ' + path.basename(file) };
        continue;
      }
      const content = fs.readFileSync(file, 'utf8');
      const hashes = parseB2sumContent(content, opts);
      perServer[s.id] = hashes;
    } catch (e) {
      perServer[s.id] = { __error: e.message };
    }
  }
  return perServer;
}

/**
 * 列举对象存储中指定 prefix 下的所有对象（自动分页）。
 * @param {TosClient} client
 * @param {string} bucket
 * @param {string} prefix
 * @returns {Promise<Array<{key:string, size:number, lastModified:string}>>}
 */
async function listAllObjects(client, bucket, prefix) {
  const objects = [];
  let continuationToken = undefined;
  do {
    const params = { bucket, prefix };
    if (continuationToken) params.continuationToken = continuationToken;
    const { data } = await client.listObjectsType2(params);
    const contents = data.Contents || data.contents || [];
    for (const o of contents) {
      objects.push({
        key: o.Key || o.key,
        size: Number(o.Size || o.size || 0),
        lastModified: o.LastModified || o.lastModified || ''
      });
    }
    continuationToken = data.IsTruncated === true || data.isTruncated === true
      ? (data.NextContinuationToken || data.nextContinuationToken)
      : undefined;
  } while (continuationToken);
  return objects;
}

/**
 * 从对象存储列举文件，按 pattern 反解出「市场 -> 服务器列表」映射。
 * 用于自动发现有哪些服务器（不再需要在 config.json 里维护服务器列表）。
 *
 * @param {object} cfg 完整配置
 * @returns {Promise<{ markets, allServers, objectCount, zoneCounts, unmappedServers, fullMarkets, partialMarkets }>}
 *   markets: 每个市场下有哪些 serverId；allServers: 去重后的全部 serverId；
 *   zoneCounts: 按分区网段统计的台数 { zoneId: { segment, count, servers } }；
 *   unmappedServers: 未命中任何分区网段的 IP 列表；
 *   fullMarkets: 所有服务器都有的市场（参与 diff）；
 *   partialMarkets: 仅部分服务器有的市场（diff 跳过），含 missing（缺该市场文件的 IP）。
 */
async function discoverServers(cfg) {
  const os = (cfg && cfg.objectStorage) || {};
  if (!os.enabled) throw new Error('对象存储未启用：config.objectStorage.enabled=false');
  const client = createTosClient(cfg);
  const prefix = (os.prefix || '').replace(/\/+$/, '') + '/';
  const objects = await listAllObjects(client, os.bucket, prefix);
  const markets = {};
  const serverSet = new Set();
  for (const o of objects) {
    const info = parseObjectKey(o.key, os.prefix, PATH_PATTERN);
    if (!info) continue;
    if (!markets[info.market]) markets[info.market] = [];
    if (!markets[info.market].includes(info.serverId)) markets[info.market].push(info.serverId);
    serverSet.add(info.serverId);
  }
  // 按分区网段统计台数
  const zones = cfg.zones || [];
  const zoneCounts = {};
  for (const z of zones) zoneCounts[z.id] = { segment: z.networkSegment || '', count: 0, servers: [] };
  const unmappedServers = [];
  for (const ip of serverSet) {
    const zoneId = matchZoneBySegment(ip, zones);
    if (zoneId && zoneCounts[zoneId]) {
      zoneCounts[zoneId].count++;
      zoneCounts[zoneId].servers.push(ip);
    } else {
      unmappedServers.push(ip);
    }
  }
  // 市场覆盖度：所有服务器都有的市场才参与 diff
  const coverage = selectMarketsByCoverage(markets, Array.from(serverSet));
  return {
    markets,
    allServers: Array.from(serverSet),
    objectCount: objects.length,
    zoneCounts,
    unmappedServers,
    fullMarkets: coverage.full,
    partialMarkets: coverage.partial
  };
}

/**
 * 执行一次对象存储同步：用 TOS SDK 把 bucket/prefix 下的所有 b2sum 文件
 * 下载到本地 localDir 目录。下载完成后即可用 readObjectStorageForComparison 做 diff。
 *
 * @param {object} cfg 完整配置
 * @returns {Promise<{ok:boolean, downloaded:number, skipped:number, failed:number, detail:string, errors?:string[]}>}
 */
async function syncObjectStorage(cfg) {
  const os = (cfg && cfg.objectStorage) || {};
  if (!os.enabled) {
    return { ok: false, downloaded: 0, skipped: 0, failed: 0, detail: '对象存储未启用（config.objectStorage.enabled=false）' };
  }
  if (!os.bucket) {
    return { ok: false, downloaded: 0, skipped: 0, failed: 0, detail: '对象存储未配置 bucket' };
  }
  const localDir = path.resolve(__dirname, '..', os.localDir || 'b2sumdata');
  fs.mkdirSync(localDir, { recursive: true });

  const client = createTosClient(cfg);
  const prefix = (os.prefix || '').replace(/\/+$/, '') + '/';
  const pattern = PATH_PATTERN;

  let objects;
  try {
    objects = await listAllObjects(client, os.bucket, prefix);
  } catch (e) {
    return {
      ok: false, downloaded: 0, skipped: 0, failed: 0,
      detail: '列举对象存储失败: ' + (e.message || String(e))
    };
  }

  // 只下载匹配 pattern 的文件（b2sum 哈希文件），其他文件跳过
  const targets = [];
  for (const o of objects) {
    const info = parseObjectKey(o.key, os.prefix, pattern);
    if (!info) continue; // 不匹配 pattern 的文件跳过
    const fileName = path.basename(o.key);
    const localFile = path.join(localDir, fileName);
    targets.push({ key: o.key, localFile, size: o.size });
  }

  const errors = [];
  let downloaded = 0;
  let skipped = 0;
  for (const t of targets) {
    try {
      // 如果本地已存在且大小一致，跳过（增量同步，减少下载量）
      if (fs.existsSync(t.localFile)) {
        const stat = fs.statSync(t.localFile);
        if (stat.size === t.size) { skipped++; continue; }
      }
      await client.getObjectToFile({
        bucket: os.bucket,
        key: t.key,
        filePath: t.localFile
      });
      downloaded++;
    } catch (e) {
      errors.push(`${t.key}: ${e.message || String(e)}`);
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    downloaded,
    skipped,
    failed: errors.length,
    detail: ok
      ? `同步完成：下载 ${downloaded} 个，跳过 ${skipped} 个（本地已存在），失败 ${errors.length} 个`
      : `同步完成但有失败：下载 ${downloaded}，跳过 ${skipped}，失败 ${errors.length}`,
    errors: errors.length ? errors : undefined,
    localDir: path.relative(path.resolve(__dirname, '..'), localDir)
  };
}

module.exports = {
  PATH_PATTERN,
  FILE_FORMAT,
  CODE_SUFFIX,
  matchZoneBySegment,
  countLocalServers,
  selectMarketsByCoverage,
  createTosClient,
  resolveB2sumPath,
  parseObjectKey,
  parseB2sumContent,
  readObjectStorageForComparison,
  discoverServers,
  syncObjectStorage,
  listAllObjects
};
