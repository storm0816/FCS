let cfg = { zones: [], markets: [], settings: {}, objectStorage: {} };
let editingMarketCode = null;
let editingZoneId = null;

const $ = (id) => document.getElementById(id);
const zoneName = (id) => { const z = (cfg.zones || []).find((x) => x.id === id); return z ? z.name : (id || '-'); };

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return r.json();
}

async function loadConfig() {
  cfg = await api('GET', '/api/config');
  if (!cfg.zones) cfg.zones = [];
  if (!cfg.markets) cfg.markets = [];
  if (!cfg.settings) cfg.settings = {};
  if (!cfg.objectStorage) cfg.objectStorage = {};
  if (!cfg.dingTalk) cfg.dingTalk = {};
  renderZones();
  renderMarkets();
  renderSettings();
  renderDingTalk();
  renderObjectStorage();
  renderZonePick();
  renderMarketPick();
  renderReferenceServerPick();
  refreshZoneCounts();
}

/* 把当前 cfg 直接保存到 config.json 并刷新界面（分区/市场增删改后即时持久化） */
async function saveCfgAndRender() {
  try {
    await api('PUT', '/api/config', cfg);
  } catch (e) { alert('保存配置失败: ' + e.message); }
  renderZones();
  renderMarkets();
  renderSettings();
  renderZonePick();
  renderMarketPick();
}

function bindClick(id, fn) {
  const el = $(id);
  if (!el) { console.warn('[bind] 缺失 DOM #' + id + '，跳过绑定'); return; }
  el.onclick = fn;
}
function bindChange(id, fn) {
  const el = $(id);
  if (!el) { console.warn('[bind] 缺失 DOM #' + id + '，跳过绑定'); return; }
  el.onchange = fn;
}

/* ---------- 分区 ---------- */
// 各分区台数缓存：{ zoneId: {count, servers, segment} }，由 refreshZoneCounts 刷新（本地 b2sumdata 计数）
window.__zoneCounts = window.__zoneCounts || {};

function renderZones() {
  const tb = $('zoneTable').querySelector('tbody');
  tb.innerHTML = '';
  if (!cfg.zones.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">暂无分区，点击右上角新增</td></tr>'; return; }
  for (const z of cfg.zones) {
    const c = window.__zoneCounts[z.id];
    const countHtml = c
      ? `<strong>${c.count}</strong> 台`
      : '<span class="subzone">—</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${esc(z.id)}</code></td>
      <td>${esc(z.name)}</td>
      <td>${z.networkSegment ? `<code>${esc(z.networkSegment)}</code>` : '<span class="subzone">未配置</span>'}</td>
      <td>${countHtml}</td>
      <td>
        <button class="btn sm" data-zed="${z.id}">编辑</button>
        <button class="btn sm" data-zdel="${z.id}">删除</button>
      </td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-zed]').forEach((b) => b.onclick = () => openZoneModal(b.dataset.zed));
  tb.querySelectorAll('[data-zdel]').forEach((b) => b.onclick = () => {
    cfg.zones = cfg.zones.filter((x) => x.id !== b.dataset.zdel);
    saveCfgAndRender();
  });
}

/* 拉取本地 b2sumdata 已同步服务器的台数（按分区网段计数），刷新分区表 */
async function refreshZoneCounts() {
  try {
    const r = await api('GET', '/api/servers/local-counts');
    if (r && r.ok && r.zones) {
      window.__zoneCounts = r.zones;
      renderZones();
    }
  } catch (e) { /* 计数失败静默，不影响主流程 */ }
}

function openZoneModal(id) {
  editingZoneId = id || null;
  const z = id ? cfg.zones.find((x) => x.id === id) : {};
  $('z_id').value = z.id || '';
  $('z_name').value = z.name || '';
  $('z_segment').value = z.networkSegment || '';
  $('zoneModal').style.display = 'flex';
  if (id) $('z_id').setAttribute('readonly', 'true'); else $('z_id').removeAttribute('readonly');
}
$('z_save').onclick = () => {
  const id = $('z_id').value.trim();
  if (!id) { alert('分区ID不能为空'); return; }
  const segment = $('z_segment').value.trim();
  const data = { id, name: $('z_name').value || id, networkSegment: segment };
  if (editingZoneId) { const z = cfg.zones.find((x) => x.id === editingZoneId); Object.assign(z, data); delete z.concurrency; }
  else if (cfg.zones.find((x) => x.id === id)) { alert('分区ID已存在'); return; }
  else cfg.zones.push(data);
  $('zoneModal').style.display = 'none';
  saveCfgAndRender();
  refreshZoneCounts();
};
$('z_cancel').onclick = () => { $('zoneModal').style.display = 'none'; };

/* ---------- 市场 ---------- */
function renderMarkets() {
  const tb = $('marketTable').querySelector('tbody');
  tb.innerHTML = '';
  if (!cfg.markets.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">暂无市场</td></tr>'; return; }
  for (const m of cfg.markets) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" data-enable="${m.code}" ${m.enabled !== false ? 'checked' : ''} /></td>
      <td><code>${esc(m.code)}</code></td>
      <td>${esc(m.name)}</td>
      <td>${m.inspectTimes ? `<code>${esc(m.inspectTimes)}</code>` : '<span class="subzone">—</span>'}</td>
      <td>
        <button class="btn sm" data-med="${m.code}">编辑</button>
        <button class="btn sm" data-mdel="${m.code}">删除</button>
      </td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-enable]').forEach((c) => c.onchange = (e) => {
    const m = cfg.markets.find((x) => x.code === e.target.dataset.enable);
    if (m) { m.enabled = e.target.checked; persistCfg(); }
  });
  tb.querySelectorAll('[data-med]').forEach((b) => b.onclick = () => openMarketModal(b.dataset.med));
  tb.querySelectorAll('[data-mdel]').forEach((b) => b.onclick = () => {
    cfg.markets = cfg.markets.filter((x) => x.code !== b.dataset.mdel);
    saveCfgAndRender();
  });
}

/* 静默把当前 cfg 写入 config.json（用于勾选启用等即时操作，失败不打扰） */
async function persistCfg() {
  try { await api('PUT', '/api/config', cfg); } catch (e) { /* 忽略 */ }
}

/**
 * 把「测试连接/发现服务器」发现的市场自动同步到市场配置。
 * 口径：**只自动加入「所有服务器都有、参与 diff 对比」的市场（fullMarkets）**；
 * 仅部分服务器有的市场（partial）不自动加入。
 *  - 新增：fullMarkets 中配置里没有的市场（默认 enabled=true、name=代码，名称可编辑）；
 *  - 清理：之前由自动导入产生、本次不在参与 diff 列表、且名称未被用户改过（name===code）
 *    且确实存在于对象存储发现结果中的市场（如 partial 市场被误导入），自动移除；
 *  - 保留：用户手动添加/编辑过名称的市场，以及不在发现结果中的市场，一律不动。
 * @returns {Promise<{added:string[], removed:string[]}>} 本次新增 / 清理的市场代码
 */
async function importDiscoveredMarkets(discover) {
  const full = (discover && discover.fullMarkets) || [];
  const discoveredSet = new Set(Object.keys((discover && discover.markets) || {}));
  const fullSet = new Set(full);
  const existingCodes = new Set((cfg.markets || []).map((m) => m.code));

  const added = [];
  for (const code of full) {
    if (!existingCodes.has(code)) {
      cfg.markets.push({ code, name: code, enabled: true });
      added.push(code);
    }
  }

  const removed = [];
  cfg.markets = (cfg.markets || []).filter((m) => {
    // 仅清理「自动导入且未改名、对象存储里有但不参与 diff」的市场；手动/改名市场保留
    const isAutoImported = m.name === m.code && discoveredSet.has(m.code);
    if (isAutoImported && !fullSet.has(m.code)) { removed.push(m.code); return false; }
    return true;
  });

  if (added.length || removed.length) {
    await persistCfg();
    renderMarkets();
    renderMarketPick();
  }
  return { added, removed };
}

function openMarketModal(code) {
  editingMarketCode = code || null;
  const m = code ? cfg.markets.find((x) => x.code === code) : {};
  $('m_code').value = m.code || '';
  $('m_name').value = m.name || '';
  $('m_inspectTimes').value = m.inspectTimes || '';
  $('marketModal').style.display = 'flex';
}
$('m_save').onclick = () => {
  const code = $('m_code').value.trim();
  if (!code) { alert('市场代码不能为空'); return; }
  const data = { code, name: $('m_name').value || code, enabled: true, inspectTimes: $('m_inspectTimes').value.trim() };
  if (editingMarketCode) {
    const m = cfg.markets.find((x) => x.code === editingMarketCode);
    m.code = code; m.name = data.name; m.inspectTimes = data.inspectTimes;
  } else if (cfg.markets.find((x) => x.code === code)) {
    alert('市场代码已存在'); return;
  } else {
    cfg.markets.push(data);
  }
  $('marketModal').style.display = 'none';
  saveCfgAndRender();
};
$('m_cancel').onclick = () => { $('marketModal').style.display = 'none'; };

/* ---------- 对象存储配置 ---------- */
function renderObjectStorage() {
  const os = cfg.objectStorage || {};
  $('osEnabled').checked = os.enabled === true;
  $('osRegion').value = os.region || '';
  $('osEndpoint').value = os.endpoint || '';
  $('osBucket').value = os.bucket || '';
  $('osPrefix').value = os.prefix || '';
  $('osLocalDir').value = os.localDir || 'b2sumdata';
  $('osAccessKey').value = os.accessKey || '';
  $('osSecretKey').value = os.secretKey || '';
  // 定时拉取配置
  $('osAutoSync').checked = os.autoSync === true;
  $('osSyncMode').value = os.syncMode || 'interval';
  $('osSyncInterval').value = os.syncIntervalMinutes || 5;
  $('osSyncFixedTimes').value = os.syncFixedTimes || '';
  updateSyncModeUI();
  refreshAutoSyncStatus();
}

/* 根据模式切换禁用灰显 */
function updateSyncModeUI() {
  const mode = $('osSyncMode').value;
  const intervalLabel = $('osSyncIntervalLabel');
  const fixedLabel = $('osSyncFixedLabel');
  const intervalInput = $('osSyncInterval');
  const fixedInput = $('osSyncFixedTimes');
  if (mode === 'interval') {
    intervalInput.disabled = false;
    fixedInput.disabled = true;
    intervalLabel.classList.remove('is-disabled');
    fixedLabel.classList.add('is-disabled');
  } else {
    intervalInput.disabled = true;
    fixedInput.disabled = false;
    intervalLabel.classList.add('is-disabled');
    fixedLabel.classList.remove('is-disabled');
  }
}
document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('osSyncMode');
  if (sel) sel.addEventListener('change', updateSyncModeUI);
});
// 兼容旧浏览器：直接绑定
if ($('osSyncMode')) $('osSyncMode').addEventListener('change', updateSyncModeUI);

/* 刷新定时拉取状态显示 */
async function refreshAutoSyncStatus() {
  try {
    const r = await api('GET', '/api/auto-sync/status');
    if (r && r.ok) {
      const status = $('autoSyncStatus');
      if (r.running) {
        const parts = [`✅ 运行中`];
        if (r.scheduleText) parts.push(r.scheduleText);
        if (r.lastRunTime) parts.push(`上次：${r.lastRunTime}`);
        status.textContent = parts.join(' · ');
      } else {
        const parts = [r.autoSyncEnabled ? '⏸ 未启动' : '未启用'];
        if (r.storageEnabled && r.autoSyncEnabled) {
          parts.push('请保存配置以启动');
        }
        if (r.lastRunTime) parts.push(`上次：${r.lastRunTime}`);
        status.textContent = parts.join(' · ');
      }
    }
  } catch (e) { /* 静默 */ }
}

async function saveObjectStorage() {
  // 仅保存界面可编辑字段；文件命名规则等为系统固定常量，剔除旧配置中的残留字段
  cfg.objectStorage = {
    enabled: $('osEnabled').checked,
    region: $('osRegion').value.trim(),
    endpoint: $('osEndpoint').value.trim(),
    bucket: $('osBucket').value.trim(),
    prefix: $('osPrefix').value.trim(),
    localDir: $('osLocalDir').value.trim() || 'b2sumdata',
    accessKey: $('osAccessKey').value.trim(),
    secretKey: $('osSecretKey').value,
    autoSync: $('osAutoSync').checked,
    syncMode: $('osSyncMode').value || 'interval',
    syncIntervalMinutes: Math.max(1, Number($('osSyncInterval').value) || 5),
    syncFixedTimes: $('osSyncFixedTimes').value.trim()
  };
  try {
    await api('PUT', '/api/config', cfg);
    $('osTip').textContent = '已保存对象存储配置 ✓';
    setTimeout(() => ($('osTip').textContent = ''), 2500);
    refreshAutoSyncStatus();
  } catch (e) { alert('保存失败: ' + e.message); }
}
$('saveOsBtn').onclick = saveObjectStorage;

/* 手动立即拉取对象存储文件 */
$('syncOsBtn').onclick = async () => {
  await saveObjectStorage();
  const btn = $('syncOsBtn');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    const r = await api('POST', '/api/sync-b2sum');
    if (r.ok) {
      $('osTip').textContent = `拉取完成 ✓ 下载 ${r.downloaded}，跳过 ${r.skipped}${r.failed ? '，失败 ' + r.failed : ''}`;
      refreshZoneCounts();
    } else {
      $('osTip').textContent = '拉取失败: ' + (r.detail || r.error || '未知错误');
    }
  } catch (e) {
    $('osTip').textContent = '拉取失败: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    refreshAutoSyncStatus();
    setTimeout(() => ($('osTip').textContent = ''), 4000);
  }
};

/* 测试对象存储连接 + 自动发现服务器 */
$('testOsBtn').onclick = async () => {
  await saveObjectStorage();
  const btn = $('testOsBtn');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '发现中…';
  $('osDiscoverResult').style.display = 'none';
  try {
    const r = await api('POST', '/api/servers/discover');
    const box = $('osDiscoverResult');
    box.style.display = 'block';
    if (r.ok) {
      window.__discoveredServers = r.allServers || [];
      if (r.zoneCounts) window.__zoneCounts = r.zoneCounts;
      renderZones();
      renderReferenceServerPick();
      // 自动把「参与 diff 对比」的市场（所有服务器都有）同步到「市场配置」；仅部分服务器有的市场不加入
      const { added: addedMarkets, removed: removedMarkets } = await importDiscoveredMarkets(r);
      const fullCnt = (r.fullMarkets || []).length;
      const mks = Object.keys(r.markets || {});
      let html = `<div class="cch">发现 ${r.allServers.length} 台服务器，覆盖 ${mks.length} 个市场（共 ${r.objectCount} 个对象）</div>`;
      let syncMsg = `已自动同步「参与 diff 对比」的 <strong>${fullCnt}</strong> 个市场到市场配置`;
      if (addedMarkets.length) syncMsg += `（本次新增 <strong>${addedMarkets.length}</strong> 个：${addedMarkets.map((m) => `<code>${esc(m)}</code>`).join('、')}）`;
      if (removedMarkets.length) syncMsg += `；已移除不参与对比的 ${removedMarkets.length} 个：${removedMarkets.map((m) => `<code>${esc(m)}</code>`).join('、')}`;
      if (!addedMarkets.length && !removedMarkets.length) syncMsg += '（无变化）';
      syncMsg += '，名称可在市场配置中编辑';
      html += `<div style="margin:6px 0;color:var(--info-700)">${syncMsg}</div>`;
      // 各分区按网段统计的台数
      const zc = r.zoneCounts || {};
      const zoneLines = cfg.zones
        .map((z) => {
          const c = zc[z.id];
          const seg = z.networkSegment ? `网段 <code>${esc(z.networkSegment)}</code>` : '未配置网段';
          return `<div style="margin:2px 0">${esc(z.name)}（${seg}）：<strong>${c ? c.count : 0}</strong> 台</div>`;
        }).join('');
      if (zoneLines) html += `<div style="margin:8px 0">${zoneLines}</div>`;
      if (r.unmappedServers && r.unmappedServers.length) {
        html += `<div style="margin:6px 0;color:var(--warn-700)">未归入任何分区网段（${r.unmappedServers.length} 台）：${r.unmappedServers.map((s) => `<code>${esc(s)}</code>`).join('、')}</div>`;
      }
      const full = r.fullMarkets || [];
      const partial = r.partialMarkets || [];
      const n = r.allServers.length;
      // 所有服务器都有的市场 → 参与 diff 对比
      html += `<div style="margin:12px 0 4px;color:var(--ok-700)"><strong>✅ 全部 ${n} 台服务器都有的市场（参与 diff 对比）：${full.length} 个</strong></div>`;
      html += `<div style="margin:2px 0 6px;line-height:1.9">${full.length ? full.map((m) => `<code style="margin:1px 3px">${esc(m)}</code>`).join('') : '<span class="subzone">无</span>'}</div>`;
      // 仅部分服务器有的市场 → diff 自动跳过（折叠明细，标注缺哪些 IP）
      if (partial.length) {
        html += `<details style="margin:8px 0"><summary style="cursor:pointer;color:var(--warn-700)"><strong>⚠️ 仅部分服务器有的市场（diff 自动跳过）：${partial.length} 个（点击展开明细）</strong></summary>`;
        for (const p of partial) {
          html += `<div style="margin:4px 0"><strong>${esc(p.market)}</strong> <span class="subzone">(${p.present}/${n} 台)</span> 缺：${p.missing.length ? p.missing.map((s) => `<code>${esc(s)}</code>`).join('、') : '—'}</div>`;
        }
        html += `</details>`;
      }
      box.innerHTML = html;
    } else {
      box.innerHTML = `<div class="empty">发现失败: ${esc(r.error || '未知错误')}</div>`;
    }
  } catch (e) {
    $('osDiscoverResult').style.display = 'block';
    $('osDiscoverResult').innerHTML = `<div class="empty">请求失败: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
};

/* ---------- 运行设置 ---------- */
function renderSettings() {
  $('concurrency').value = cfg.settings.concurrency || 4;
  const sch = cfg.settings.inspectSchedule || {};
  $('inspectSchedEnabled').checked = sch.enabled === true;
  $('inspectSchedMode').value = sch.mode || 'global';
  $('inspectSchedTimes').value = sch.globalTimes || '';
  renderSchedMarkets();
  updateSchedModeUI();
}

function renderDingTalk() {
  const dt = cfg.dingTalk || {};
  $('dtEnabled').checked = dt.enabled === true;
  $('dtWebhook').value = dt.webhook || '';
  $('dtSecret').value = dt.secret || '';
  $('dtScheduleTimes').value = dt.scheduleTimes || '';
}

/* 渲染「按市场」模式下的市场巡检时间表格 */
function renderSchedMarkets() {
  const tb = $('schedMarketTbl').querySelector('tbody');
  tb.innerHTML = '';
  const markets = cfg.markets || [];
  if (!markets.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">暂无市场，请先在「市场配置」中添加</td></tr>'; return; }
  for (const m of markets) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" data-sch-enable="${esc(m.code)}" ${m.enabled !== false ? 'checked' : ''} /></td>
      <td><code>${esc(m.code)}</code></td>
      <td>${esc(m.name || '')}</td>
      <td><input type="text" data-sch-times="${esc(m.code)}" value="${esc(m.inspectTimes || '')}" placeholder="如 09:00,15:00" style="width:200px" /></td>`;
    tb.appendChild(tr);
  }
  // 勾选「启用」直接写回 cfg
  tb.querySelectorAll('input[data-sch-enable]').forEach((c) => c.onchange = (e) => {
    const m = cfg.markets.find((x) => x.code === e.target.dataset.schEnable);
    if (m) m.enabled = e.target.checked;
  });
}

/* 定时巡检模式切换：全局→显示统一时间输入框；按市场→显示市场时间表格 */
function updateSchedModeUI() {
  const mode = $('inspectSchedMode').value;
  $('schedGlobalRow').style.display = mode === 'global' ? '' : 'none';
  $('schedPerMarketBox').style.display = mode === 'per-market' ? '' : 'none';
}
function renderZonePick() {
  const box = $('zonePick');
  box.innerHTML = '';
  for (const z of cfg.zones) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" value="${z.id}" /> ${esc(z.name)}(${esc(z.id)})`;
    box.appendChild(l);
  }
}
function renderMarketPick() {
  const sel = $('marketScope');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = '全部市场';
  sel.appendChild(all);
  for (const m of cfg.markets) {
    const o = document.createElement('option');
    o.value = m.code;
    o.textContent = `${m.name}(${m.code})`;
    sel.appendChild(o);
  }
  if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
}

/**
 * 渲染「参考机」下拉：服务器从本地 b2sumdata 文件自动发现。
 * 若本地暂无文件，提示先同步对象存储。
 */
function renderReferenceServerPick() {
  const sel = $('referenceServer');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  // 服务器由后端在 inspect 时按固定命名 <ip>-<market>-NIG.b2sum 自动发现；
  // 用 fetch 调一个轻量接口不合适，这里直接用 inspect 时后端会自动发现；
  // 下拉默认提供"自动选择"选项 + 已发现的服务器（来自 discover 结果缓存）
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '（自动选择第一台）';
  sel.appendChild(auto);
  // 如果有缓存的发现结果，填入
  if (window.__discoveredServers && window.__discoveredServers.length) {
    for (const sid of window.__discoveredServers) {
      const o = document.createElement('option');
      o.value = sid;
      o.textContent = sid;
      sel.appendChild(o);
    }
  }
  if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
}

/* 对比算法联动：少数服从多数(diff) 不需要参考机 → 参考机下拉置灰禁用；参考机 diff 对比 → 启用 */
function updateAlgorithmUI() {
  const algoEl = document.querySelector('input[name="cmpalgorithm"]:checked');
  const algo = algoEl ? algoEl.value : 'majority';
  const needRef = algo === 'reference';
  const sel = $('referenceServer');
  const group = $('referenceServerGroup');
  if (sel) sel.disabled = !needRef;
  if (group) group.classList.toggle('is-disabled', !needRef);
}
document.querySelectorAll('input[name="cmpalgorithm"]').forEach((r) => r.addEventListener('change', updateAlgorithmUI));
updateAlgorithmUI();
updateZonescopeUI();
$('inspectSchedMode').addEventListener('change', updateSchedModeUI);

$('saveConfigBtn').onclick = async () => {
  cfg.settings.concurrency = Number($('concurrency').value) || 4;
  // 收集「按市场」表格中各市场的巡检时间，写回 cfg.markets
  const tb = $('schedMarketTbl');
  tb.querySelectorAll('input[data-sch-times]').forEach((inp) => {
    const m = (cfg.markets || []).find((x) => x.code === inp.dataset.schTimes);
    if (m) m.inspectTimes = inp.value.trim();
  });
  cfg.settings.inspectSchedule = {
    enabled: $('inspectSchedEnabled').checked,
    mode: $('inspectSchedMode').value,
    globalTimes: $('inspectSchedTimes').value.trim()
  };
  try {
    await api('PUT', '/api/config', cfg);
    $('saveTip').textContent = '已保存巡检设置 ✓';
    setTimeout(() => ($('saveTip').textContent = ''), 2500);
  } catch (e) { alert('保存失败: ' + e.message); }
};

/* ---------- 钉钉通知 ---------- */
$('saveConfigBtn2').onclick = async () => {
  cfg.dingTalk = {
    enabled: $('dtEnabled').checked,
    webhook: $('dtWebhook').value.trim(),
    secret: $('dtSecret').value.trim(),
    scheduleTimes: $('dtScheduleTimes').value.trim()
  };
  try {
    await api('PUT', '/api/config', cfg);
    $('saveTip2').textContent = '已保存钉钉设置 ✓';
    setTimeout(() => ($('saveTip2').textContent = ''), 2500);
  } catch (e) { alert('保存失败: ' + e.message); }
};
$('dtTestBtn').onclick = async () => {
  // 把当前表单值作为临时配置传给后端（无需先保存 config.json）
  const dt = {
    enabled: $('dtEnabled').checked,
    webhook: $('dtWebhook').value.trim(),
    secret: $('dtSecret').value.trim(),
    scheduleTimes: $('dtScheduleTimes').value.trim()
  };
  try {
    const r = await api('POST', '/api/dingtalk/test', { dingTalk: dt });
    alert(r.ok ? '测试发送成功 ✓' : '发送失败：' + r.detail);
  } catch (e) {
    alert('发送失败: ' + e.message);
  }
};

function updateZonescopeUI() {
  const zs = document.querySelector('input[name="zonescope"]:checked').value;
  const perZone = $('cmpPerZone');
  const merged = $('cmpMerged');
  if (zs === 'all') {
    // 全部分区时：禁用单区对比，自动切到多区合并
    perZone.disabled = true;
    perZone.parentElement.classList.add('is-disabled');
    merged.disabled = false;
    merged.parentElement.classList.remove('is-disabled');
    if (document.querySelector('input[name="cmpmode"]:checked').value === 'per-zone') {
      merged.checked = true;
    }
  } else {
    // 指定分区时：禁用多区合并，自动切到单区对比
    perZone.disabled = false;
    perZone.parentElement.classList.remove('is-disabled');
    merged.disabled = true;
    merged.parentElement.classList.add('is-disabled');
    if (document.querySelector('input[name="cmpmode"]:checked').value === 'merged') {
      perZone.checked = true;
    }
  }
}
document.querySelectorAll('input[name="zonescope"]').forEach((r) => r.onchange = () => {
  $('zonePick').style.display = r.value === 'selected' ? 'flex' : 'none';
  updateZonescopeUI();
});

function checkedValues(boxId) {
  return Array.from($(boxId).querySelectorAll('input:checked')).map((c) => c.value);
}

/* ---------- 巡检 ---------- */
$('runBtn').onclick = async () => {
  const zs = document.querySelector('input[name="zonescope"]:checked').value;
  const cmp = document.querySelector('input[name="cmpmode"]:checked').value;
  const markets = $('marketScope') ? $('marketScope').value : 'all';
  const zones = zs === 'selected' ? checkedValues('zonePick') : 'all';
  const cmpAlgoEl = document.querySelector('input[name="cmpalgorithm"]:checked');
  const compareAlgorithm = cmpAlgoEl ? cmpAlgoEl.value : 'majority';
  // 参考机仅「参考机 diff 对比」算法使用；少数服从多数(diff) 不需要参考机
  const refSel = $('referenceServer');
  const referenceServerId = (compareAlgorithm === 'reference' && refSel && refSel.value) ? refSel.value : null;
  const runIdInput = $('runIdInput');
  const compareOnlyChk = $('compareOnlyChk');
  const runId = runIdInput ? runIdInput.value.trim() : '';
  const compareOnly = compareOnlyChk ? compareOnlyChk.checked : false;
  if (compareOnly && !runId) { alert('请先填写「采集批次 runId」，或取消勾选以发起新采集'); return; }
  if (compareAlgorithm === 'reference' && !referenceServerId) {
    alert('「参考机哈希值对比」算法需要先选择参考机'); return;
  }
  if (zs === 'selected' && !zones.length) { alert('请至少勾选一个分区'); return; }
  $('progress').style.display = 'block';
  $('progress').textContent = compareOnly
    ? '复查中（读取本地采集文件夹做对比）…'
    : '巡检中（使用本地 b2sumdata 文件做跨机 diff 对比）…';
  $('dataDirNote').style.display = 'none';
  $('resultCard').style.display = 'none';
  try {
    const res = await api('POST', '/api/inspect', { zones, markets, compareMode: cmp, referenceServerId, runId, compareOnly, compareAlgorithm });
    renderResult(res);
    refreshZoneCounts();
    let done = `完成，用时 ${res.elapsedMs} ms`;
    $('progress').textContent = done;
    if (res.summary && res.summary.runId) {
      if (runIdInput) runIdInput.value = res.summary.runId;
      const note = $('dataDirNote');
      const mode = res.summary.collectMode === 'compare_only' ? '（仅对比本地采集）' : '';
      note.textContent = `本次采集批次：${res.summary.runId}${mode} · 本地文件夹：${res.summary.dataDir}`;
      note.style.display = 'block';
    }
  } catch (e) {
    $('progress').textContent = '巡检失败: ' + e.message;
  }
};

function renderResult(res) {
  window.__resultRendered = true;
  $('resultCard').style.display = 'block';
  // 清理上一次遗留的提示条，避免重复堆积
  $('resultCard').querySelectorAll('.run-tip').forEach((t) => t.remove());
  const s = res.summary;
  const isMerged = s.compareMode === 'merged';

  const codeCount = (s.codeListSizeTotal > 0 ? s.codeListSizeTotal : (s.totalCodes || 0));
  const normalCount = s.consistentCodes || 0;
  $('summary').innerHTML = `
    <div class="stat"><div class="num">${s.groupTotalServers || 0}</div><div class="lbl">服务器数</div></div>
    <div class="stat bad" title="${(s.anomalousServerIds && s.anomalousServerIds.length) ? '异常服务器：' + s.anomalousServerIds.map(esc).join('、') : '无异常服务器'}"><div class="num">${s.anomalousServers || 0}</div><div class="lbl">异常服务器</div></div>
    <div class="stat ok"><div class="num">${codeCount}</div><div class="lbl">代码数</div></div>
    <div class="stat ok" title="跨服务器对比哈希值完全一致的代码总数"><div class="num">${normalCount}</div><div class="lbl">正常代码数</div></div>
    <div class="stat bad" title="哈希值与多数服务器不一致的代码数（distinct，不超过代码数）"><div class="num">${s.anomalies}</div><div class="lbl">异常代码数</div></div>
    <div class="stat warn2" title="仅少数服务器多出、多数服务器都没有的代码数"><div class="num">${s.extraCodes || 0}</div><div class="lbl">多出代码数</div></div>`;

  const box = $('resultDetail');
  box.innerHTML = '';
  if (typeof window.__navFocusResult === 'function') window.__navFocusResult();
  if (!res.zones.length) { box.innerHTML = '<div class="empty">无数据</div>'; return; }
  const scopeNote = document.createElement('div');
  scopeNote.className = 'scope-note';
  const compared = (s.comparedMarkets != null) ? s.comparedMarkets : (s.markets || 0);
  const skippedHint = s.skippedMarketCount
    ? ` · <span style="color:var(--warn-700)">已自动跳过 <strong>${s.skippedMarketCount}</strong> 个仅部分服务器有的市场（${(s.skippedMarkets || []).map((m) => esc(m.market)).join('、')}）</span>`
    : '';
  scopeNote.innerHTML = `巡检市场：<strong>${s.marketScope === 'all' ? '全部市场' : esc(s.marketScope)}</strong> · 参与 diff <strong>${compared}</strong> 个市场${skippedHint}`;
  box.appendChild(scopeNote);
  box.appendChild(ipOverviewBlock(res.zones, isMerged));
  for (const zr of res.zones) {
    const zBlock = document.createElement('div');
    zBlock.className = 'zone-block';
    const znote = zr.note ? ` <span class="tag unreachable">${esc(zr.note)}</span>` : '';
    const mergedHint = (isMerged && zr.zone === '__merged__')
      ? ' <span class="tag zone">已合并所有服务器跨区比对</span>'
      : '';
    zBlock.innerHTML = `<div class="zh">${isMerged ? '对比范围' : '分区'}：${esc(zr.name)}(${esc(zr.zone)}) ${znote}${mergedHint}</div>`;
    const inner = document.createElement('div');
    inner.style.padding = '4px 10px 10px';
    if (!zr.markets.length) {
      inner.innerHTML = '<div class="empty">该范围无市场数据</div>';
    }
    for (const mk of zr.markets) {
      inner.appendChild(marketBlock(mk, isMerged));
    }
    zBlock.appendChild(inner);
    box.appendChild(zBlock);
  }
}

function marketBlock(mk, isMerged) {
  const block = document.createElement('div');
  block.className = 'market-block';
  const extraList = mk.extraCodes || [];
  const total = mk.anomalies.length + extraList.length + mk.missing.length + mk.conflicts.length + mk.unreachable.length;
  const status = total === 0 ? '<span class="tag ok">健康</span>' : '<span class="tag mismatch">异常</span>';
  const sub = isMerged ? ` · 参与服务器 ${mk.totalServers || '-'}` : '';
  const msize = (mk.majoritySize != null) ? mk.majoritySize : mk.totalCodes;
  const minority = mk.minorityOnlyTotal || 0;
  const mkRefTag = mk.referenceServerId
    ? `<span class="tag zone" title="参考机 ${esc(mk.referenceServerName || mk.referenceServerId)}">参考机 ${esc(mk.referenceServerName || mk.referenceServerId)}</span>`
    : '';
  const mkRefBadge = mk.codeListSource
    ? ` · 码表 ${mk.codeListSize}${mkRefTag}`
    : '';
  block.innerHTML = `<div class="mh">${esc(mk.name)}(${esc(mk.market)}) ${status} 多数派 ${mk.consistentCodes}/${msize}${sub} · 少数派独有 ${minority}${mkRefBadge}</div>`;
  const body = document.createElement('div');
  body.style.padding = '8px 12px';
  if (mk.unreachable.length) body.appendChild(sectionHtml('不可达服务器', mk.unreachable.map((u) => `${esc(u.serverName || u.serverId)}（${esc(u.zoneName || '-')}）— ${esc(u.detail)}`), 'unreachable'));

  const ipGroups = aggregateByIp([
    ...mk.conflicts.map((c) => ({ ...c, _kind: 'conflict' })),
    ...mk.missing.map((c) => ({ ...c, _kind: 'missing' })),
    ...extraList.map((c) => ({ ...c, _kind: 'extra' })),
    ...mk.anomalies.map((a) => ({ ...a, _kind: 'mismatch' }))
  ]);
  if (ipGroups.length) {
    body.appendChild(ipGroupHtml('按 IP 反向聚合（一个 IP 对应多个代码）', ipGroups));
  }

  if (mk.anomalies.length) {
    const rows = mk.anomalies.map((a) => `<tr><td>${esc(a.code)}</td><td>${esc(a.serverName || a.serverId)}<br><small class="subzone">区域 ${esc(a.zoneName || '-')} · 市场 ${esc(a.market || mk.market)}</small></td><td><code>${esc(a.actual)}</code></td><td><code>${esc(a.expected)}</code></td></tr>`).join('');
    const div = document.createElement('div');
    div.style.marginTop = '8px';
    div.innerHTML = `<details class="detail-fold"><summary>哈希不一致 明细表 (代码 × 区域·IP·市场) · ${mk.anomalies.length}</summary>
      <table class="detail-tbl"><thead><tr><th>不同代码</th><th>异常服务器(IP · 区域 · 市场)</th><th>本机哈希</th><th>多数派哈希</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    body.appendChild(div);
  }

  if (extraList.length) {
    const rows = extraList.map((a) => `<tr><td>${esc(a.code)}</td><td>${esc(a.serverName || a.serverId)}<br><small class="subzone">区域 ${esc(a.zoneName || '-')} · 市场 ${esc(a.market || mk.market)}</small></td><td><code>${esc(a.actual)}</code></td><td><span class="subzone">多数服务器无此代码</span></td></tr>`).join('');
    const div = document.createElement('div');
    div.style.marginTop = '8px';
    div.innerHTML = `<details class="detail-fold" open><summary>多出代码 明细表（仅少数服务器有，多数服务器没有）· ${extraList.length}</summary>
      <table class="detail-tbl"><thead><tr><th>多出代码</th><th>所在服务器(IP · 区域 · 市场)</th><th>本机哈希</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    body.appendChild(div);
  }

  if (mk.minorityOnlyDetail && Object.keys(mk.minorityOnlyDetail).length) {
    const ipRows = Object.entries(mk.minorityOnlyDetail).map(([serverId, codes]) => {
      if (!codes.length) return '';
      const meta = (mk.anomalies.find((x) => x.serverId === serverId) ||
                    mk.missing.find((x) => x.serverId === serverId) ||
                    mk.conflicts.find((x) => x.serverId === serverId) ||
                    mk.unreachable.find((x) => x.serverId === serverId)) || {};
      const sName = meta.serverName || serverId;
      const zName = meta.zoneName || '-';
      const PREVIEW = 100;
      const preview = codes.slice(0, PREVIEW).map((c) => `<span class="code-chip minority-only" title="少数派独有">${esc(c)}</span>`).join('');
      const more = codes.length > PREVIEW ? `<span class="code-chip more">+${codes.length - PREVIEW}…</span>` : '';
      return `<div class="ip-row">
        <div class="ip-meta">
          <span class="ip-name" title="${esc(sName)}">${esc(sName)}</span>
          <span class="ip-id">${esc(serverId)}</span>
          <span class="ip-zone">${esc(zName)}</span>
          <span class="ip-tags"><span class="tag minority-only" title="本机独有代码，不参与跨机哈希对比">独有 ${codes.length}</span></span>
        </div>
        <div class="ip-codes">${preview}${more}</div>
      </div>`;
    }).join('');
    if (ipRows) {
      const div = document.createElement('div');
      div.style.marginTop = '8px';
      div.innerHTML = `<details class="detail-fold" open><summary>少数派独有代码 · 按 IP · ${minority} 个</summary>
        <div class="hint" style="margin:6px 0">
          这些代码仅在少数派机器出现（多数派机器无），不计入跨机哈希对比池。
        </div>
        <div class="ip-rows">${ipRows}</div>
      </details>`;
      body.appendChild(div);
    }
  }

  if (!total && minority === 0) body.innerHTML = '<div class="empty">本市场全部一致 ✓</div>';
  block.appendChild(body);
  return block;
}

function aggregateByIp(records) {
  const byId = {};
  for (const r of records) {
    const id = r.serverId || 'unknown';
    if (!byId[id]) byId[id] = {
      serverId: id,
      serverName: r.serverName || id,
      zoneName: r.zoneName || '-',
      totals: { mismatch: 0, missing: 0, conflict: 0, extra: 0 },
      codes: []
    };
    const k = r._kind || r.type;
    if (byId[id].totals[k] != null) byId[id].totals[k]++;
    byId[id].codes.push({ code: r.code, type: k });
  }
  const list = Object.values(byId);
  list.sort((a, b) => {
    const sa = a.totals.mismatch * 3 + a.totals.missing * 2 + a.totals.conflict + a.totals.extra;
    const sb = b.totals.mismatch * 3 + b.totals.missing * 2 + b.totals.conflict + b.totals.extra;
    if (sb !== sa) return sb - sa;
    return (a.serverName || '').localeCompare(b.serverName || '');
  });
  return list;
}

function ipGroupHtml(title, groups) {
  const wrap = document.createElement('div');
  wrap.className = 'ip-aggregate';
  wrap.style.marginBottom = '8px';
  const totalCodes = groups.reduce((n, g) => n + g.codes.length, 0);
  const rows = groups.map((g) => {
    const tagMismatch = g.totals.mismatch ? `<span class="tag dot mismatch"    title="哈希不一致 · ${g.totals.mismatch} 条"></span><span class="dot-lbl mismatch">异</span>` : '';
    const tagExtra    = g.totals.extra    ? `<span class="tag dot extra"       title="多出代码 · ${g.totals.extra} 条"></span><span class="dot-lbl extra">多</span>` : '';
    const tagMissing  = g.totals.missing     ? `<span class="tag dot missing"     title="缺失 · ${g.totals.missing} 条"></span>`      : '';
    const tagConflict = g.totals.conflict    ? `<span class="tag dot conflict"    title="冲突 · ${g.totals.conflict} 条"></span>`     : '';
    const tagUnreach  = g.totals.unreachable ? `<span class="tag dot unreachable" title="不可达 · ${g.totals.unreachable} 条"></span>`  : '';
    const tagMinority = g.totals.minorityOnly? `<span class="tag minority-only"   title="少数派独有代码数 · ${g.totals.minorityOnly}">独有 ${g.totals.minorityOnly}</span>` : '';
    const tags = tagMismatch + tagExtra + tagMissing + tagConflict + tagUnreach + tagMinority;
    const codeChips = g.codes.map((c) => {
      const tagCls = c.type === 'mismatch' ? 'mismatch'
        : c.type === 'extra' ? 'extra'
        : c.type === 'missing' ? 'missing'
        : 'conflict';
      const tagLbl = c.type === 'mismatch' ? '异' : c.type === 'extra' ? '多' : c.type === 'missing' ? '缺' : '冲';
      // 异常(mismatch)只显示红色代码、多出(extra)只显示蓝色代码，均不带角标字样；缺/冲保留角标区分
      const suffix = (c.type === 'mismatch' || c.type === 'extra') ? '' : ` <em>${tagLbl}</em>`;
      return `<span class="code-chip ${tagCls}" title="${tagLbl}">${esc(c.code)}${suffix}</span>`;
    }).join('');
    return `<div class="ip-row">
      <div class="ip-meta">
        <span class="ip-name" title="${esc(g.serverName)}">${esc(g.serverName)}</span>
        <span class="ip-id">${esc(g.serverId)}</span>
        <span class="ip-zone">${esc(g.zoneName)}</span>
        <span class="ip-tags">${tags}</span>
      </div>
      <div class="ip-codes">${codeChips}</div>
    </div>`;
  }).join('');
  wrap.innerHTML = `<div class="tag conflict">${esc(title)} · ${groups.length} IP · ${totalCodes} 条记录</div>
    <div class="ip-rows">${rows}</div>`;
  return wrap;
}

function ipOverviewBlock(zones, isMerged) {
  const bucket = {};
  const ensure = (rec) => {
    const id = rec.serverId || 'unknown';
    if (!bucket[id]) bucket[id] = {
      serverId: id,
      serverName: rec.serverName || id,
      zoneName: rec.zoneName || '-',
      totals: { mismatch: 0, extra: 0, missing: 0, conflict: 0, unreachable: 0, minorityOnly: 0 },
      markets: new Set(),
      codes: new Set()
    };
    return bucket[id];
  };
  let minorityOnlyTotalAll = 0;
  for (const zr of zones) {
    for (const mk of zr.markets) {
      for (const a of mk.anomalies) { const e = ensure(a); e.totals.mismatch++; e.markets.add(mk.market); e.codes.add(a.code); }
      for (const x of (mk.extraCodes || [])) { const e = ensure(x); e.totals.extra++; e.markets.add(mk.market); e.codes.add(x.code); }
      for (const m of mk.missing)   { const e = ensure(m); e.totals.missing++;  e.markets.add(mk.market); e.codes.add(m.code); }
      for (const c of mk.conflicts) { const e = ensure(c); e.totals.conflict++; e.markets.add(mk.market); e.codes.add(c.code); }
      for (const u of mk.unreachable){ const e = ensure(u); e.totals.unreachable++; e.markets.add(mk.market); }
      if (mk.minorityOnlyByServer) {
        for (const [sid, cnt] of Object.entries(mk.minorityOnlyByServer)) {
          const probe = (mk.anomalies.find((x) => x.serverId === sid) ||
                         mk.missing.find((x) => x.serverId === sid) ||
                         mk.conflicts.find((x) => x.serverId === sid) ||
                         mk.unreachable.find((x) => x.serverId === sid)) || { serverId: sid, serverName: sid, zoneName: '-' };
          const e = ensure(probe);
          e.totals.minorityOnly += cnt;
          minorityOnlyTotalAll += cnt;
          e.markets.add(mk.market);
        }
      }
    }
  }

  const list = Object.values(bucket).sort((a, b) => {
    const sa = a.totals.mismatch * 3 + a.totals.extra + a.totals.missing * 2 + a.totals.conflict * 2 + a.totals.unreachable * 2;
    const sb = b.totals.mismatch * 3 + b.totals.extra + b.totals.missing * 2 + b.totals.conflict * 2 + b.totals.unreachable * 2;
    if (sb !== sa) return sb - sa;
    return (a.serverName || '').localeCompare(b.serverName || '');
  });

  const wrap = document.createElement('div');
  wrap.className = 'ip-overview';
  if (!list.length) {
    wrap.innerHTML = `<div class="zh" style="background:transparent;border:none;color:var(--ok-700);">按 IP 分布：全部健康 ✓</div>`;
    return wrap;
  }
  const minorityHint = minorityOnlyTotalAll > 0 ? ` · 少数派独有 ${minorityOnlyTotalAll}` : '';
  const renderIpRow = (g) => {
    const dirty = g.totals.mismatch + g.totals.extra + g.totals.missing + g.totals.conflict + g.totals.unreachable;
    const level = dirty === 0 ? 'ok' : (g.totals.mismatch >= 5 || dirty >= 10) ? 'bad' : 'warn';
    const tagMismatch = g.totals.mismatch    ? `<span class="tag dot mismatch"    title="哈希不一致 · ${g.totals.mismatch} 条"></span>` : '';
    const tagExtra    = g.totals.extra       ? `<span class="tag dot extra"       title="多出代码 · ${g.totals.extra} 条"></span>` : '';
    const tagMissing  = g.totals.missing     ? `<span class="tag dot missing"     title="缺失 · ${g.totals.missing} 条"></span>`      : '';
    const tagConflict = g.totals.conflict    ? `<span class="tag dot conflict"    title="冲突 · ${g.totals.conflict} 条"></span>`     : '';
    const tagUnreach  = g.totals.unreachable ? `<span class="tag dot unreachable" title="不可达 · ${g.totals.unreachable} 条"></span>`  : '';
    const tagMinority = g.totals.minorityOnly? `<span class="tag minority-only"   title="少数派独有代码数 · ${g.totals.minorityOnly}">独有 ${g.totals.minorityOnly}</span>` : '';
    const tags = tagMismatch + tagExtra + tagMissing + tagConflict + tagUnreach + tagMinority;
    const statusText = dirty === 0 ? '<span class="tag ok">正常</span>' : '<span class="tag bad">异常</span>';
    const mks = Array.from(g.markets).slice(0, 12).map((m) => `<code>${esc(m)}</code>`).join(' ');
    const mksMore = g.markets.size > 12 ? `<code class="more">+${g.markets.size - 12}</code>` : '';
    return `<tr class="ip-list-row ${level}" data-server="${esc(g.serverId)}" title="点击展开 / 收起详情">
      <td><span class="ip-name">${esc(g.serverName)}</span><br><small class="ip-id">${esc(g.serverId)}</small></td>
      <td>${esc(g.zoneName)}</td>
      <td class="num-cell">${g.markets.size}</td>
      <td class="num-cell">${g.totals.mismatch || '<span class="dim">-</span>'}</td>
      <td class="num-cell">${g.totals.extra || '<span class="dim">-</span>'}</td>
      <td class="num-cell">${g.totals.missing || '<span class="dim">-</span>'}</td>
      <td class="num-cell">${g.totals.conflict || '<span class="dim">-</span>'}</td>
      <td class="num-cell">${g.totals.unreachable || '<span class="dim">-</span>'}</td>
      <td class="num-cell">${g.totals.minorityOnly || '<span class="dim">-</span>'}</td>
      <td class="status-cell"><span class="row-status">${statusText}</span><span class="ip-tags">${tags}</span></td>
    </tr>
    <tr class="ip-list-detail" data-detail="${esc(g.serverId)}" style="display:none">
      <td colspan="10">
        <div class="ip-detail-body">
          <strong>涉及市场：</strong>${mks}${mksMore}<br>
          <strong>异常代码数：</strong>${g.codes.size} 个
        </div>
      </td>
    </tr>`;
  };
  const rows = list.map(renderIpRow).join('');
  wrap.innerHTML = `<div class="zh">按 IP 分布 · 数据异常 ${list.length} 台${minorityHint}</div>
    <table class="ip-list-table">
      <thead>
        <tr>
          <th>服务器 / IP</th>
          <th>分区</th>
          <th>市场</th>
          <th>异常</th>
          <th>多出</th>
          <th>缺失</th>
          <th>冲突</th>
          <th>不可达</th>
          <th>独有</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  wrap.querySelectorAll('tr.ip-list-row').forEach((tr) => {
    tr.onclick = () => {
      const sid = tr.dataset.server;
      const detail = wrap.querySelector(`tr.ip-list-detail[data-detail="${CSS.escape(sid)}"]`);
      if (!detail) return;
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : 'table-row';
      tr.classList.toggle('open', !open);
    };
  });
  return wrap;
}

function sectionHtml(title, items, cls) {
  const div = document.createElement('div');
  div.style.marginBottom = '8px';
  div.innerHTML = `<div class="tag ${cls}">${title} ${items.length}</div>` +
    (items.length ? '<ul style="margin:4px 0 0 18px;font-size:12px">' + items.map((i) => `<li>${i}</li>`).join('') + '</ul>' : '');
  return div;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- 左侧侧边栏导航（一级/二级目录，点击只显示对应页面） ---------- */
const NAV_SECTION_IDS = ['sec-dashboard', 'sec-zones', 'sec-markets', 'sec-storage', 'sec-settings', 'sec-dingtalk', 'sec-inspect', 'resultCard', 'sec-history'];

/* 显示指定 section，隐藏其他所有 section */
function showSection(id) {
  for (const sid of NAV_SECTION_IDS) {
    const el = document.getElementById(sid);
    if (el) el.style.display = (sid === id) ? 'block' : 'none';
  }
  const nav = document.getElementById('sidebarNav');
  if (nav) {
    nav.querySelectorAll('.nav-item, .nav-top-item').forEach((a) => {
      const target = a.dataset.target;
      a.classList.toggle('active', target === id);
    });
  }
  window.scrollTo(0, 0);
}

/* 点击菜单进入对应页面时，自动刷新该页面数据 */
function refreshPageData(id) {
  switch (id) {
    case 'sec-dashboard':
      renderDashboard();
      break;
    case 'sec-history':
      loadHistory();
      break;
    case 'resultCard':
      // 每次进入都重新拉取最近一次巡检结果
      loadLatestResult(true);
      break;
    case 'sec-zones':
    case 'sec-markets':
    case 'sec-storage':
    case 'sec-settings':
    case 'sec-inspect':
      loadConfig().then(() => { if (id === 'sec-zones') refreshZoneCounts(); }).catch((e) => console.error('[refreshPageData]', e));
      break;
    default:
      break;
  }
}

/* 加载历史中最近一次巡检结果并渲染 */
async function loadLatestResult() {
  const box = $('resultDetail');
  try {
    const r = await api('GET', '/api/history');
    const markets = r.markets || {};
    let latest = null;
    for (const runs of Object.values(markets)) {
      for (const meta of runs || []) {
        const t = Date.parse(meta.savedAt || '') || Number(String(meta.runId || '').replace(/\D/g, '')) || 0;
        if (!latest || t > latest.t) latest = { runId: meta.runId, savedAt: meta.savedAt, t };
      }
    }
    if (!latest) {
      if (box) box.innerHTML = '<div class="empty">暂无巡检结果，执行一次巡检后此处显示最近一次结果</div>';
      return;
    }
    if (box) box.innerHTML = '<div class="empty">正在加载最近一次巡检结果…</div>';
    const data = await api('GET', '/api/history/' + latest.runId);
    const result = { summary: data.summary, zones: data.zones, elapsedMs: data.elapsedMs };
    renderResult(result);
    // 底部提示：系统最近一次巡检（放在巡检结果卡片之后）
    const tip = document.createElement('div');
    tip.className = 'run-tip';
    tip.innerHTML = `🕘 系统最近一次巡检：<code>${esc(latest.runId)}</code>（${esc(latest.savedAt || '')}） <button class="btn sm" onclick="this.parentElement.remove()">关闭</button>`;
    const rc = $('resultCard');
    rc.insertAdjacentElement('beforeend', tip);
  } catch (e) {
    if (box) box.innerHTML = '<div class="empty">加载最近一次巡检结果失败：' + esc(e.message) + '</div>';
  }
}

function initSidebarNav() {
  const nav = document.getElementById('sidebarNav');
  if (!nav) return;
  const items = Array.from(nav.querySelectorAll('.nav-item, .nav-top-item'));
  const targets = items.map((a) => {
    const id = a.dataset.target || (a.getAttribute('href') || '').replace(/^#/, '');
    return { link: a, id, el: id ? document.getElementById(id) : null };
  }).filter((t) => t.el);

  targets.forEach(({ link, id }) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      // 展开所属一级目录（若被折叠）
      const group = link.closest('.nav-group');
      if (group && group.classList.contains('collapsed')) group.classList.remove('collapsed');
      showSection(id);
      // 进入页面自动刷新该页数据
      refreshPageData(id);
    });
  });

  // 一级目录点击：折叠/展开子菜单
  nav.querySelectorAll('.nav-parent').forEach((parent) => {
    parent.addEventListener('click', () => {
      const group = parent.closest('.nav-group');
      if (group) group.classList.toggle('collapsed');
    });
  });

  // 巡检结果产生后聚焦到结果页
  window.__navFocusResult = () => {
    showSection('resultCard');
  };

  // 默认进入页面显示「仪表盘」
  showSection('sec-dashboard');
  renderDashboard();
}

/* init */
$('addZoneBtn') && ($('addZoneBtn').onclick = () => openZoneModal(null));
$('addMarketBtn') && ($('addMarketBtn').onclick = () => openMarketModal(null));
initSidebarNav();
loadConfig().catch((e) => {
  console.error('[loadConfig]', e);
  alert('加载配置失败: ' + e.message);
});

/* ---------- 仪表盘 ---------- */
function fmtTime(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function renderDashboard() {
  const sumEl = $('dashSummary');
  const gridEl = $('dashMarkets');
  if (!sumEl || !gridEl) return;
  sumEl.innerHTML = '<div class="empty">加载中…</div>';
  gridEl.innerHTML = '';
  try {
    const r = await api('GET', '/api/history');
    const markets = r.markets || {};
    const codes = Object.keys(markets).sort();

    let totalRuns = 0;
    let abnormalMarkets = 0;
    let latestTime = 0;
    const cards = codes.map((code) => {
      const runs = markets[code] || [];
      totalRuns += runs.length;
      const latest = runs[0] || null;
      const t = latest ? (Date.parse(latest.savedAt || '') || 0) : 0;
      if (t > latestTime) latestTime = t;
      const isAbnormal = latest && (latest.anomalousServers || 0) > 0;
      if (isAbnormal) abnormalMarkets++;
      const name = ((cfg.markets || []).find((m) => m.code === code) || {}).name || code;
      return { code, name, latest, runCount: runs.length, isAbnormal };
    });

    // 异常市场排前面，其余按最近巡检时间倒序
    cards.sort((a, b) => {
      if (a.isAbnormal !== b.isAbnormal) return a.isAbnormal ? -1 : 1;
      const ta = a.latest ? (Date.parse(a.latest.savedAt || '') || 0) : 0;
      const tb = b.latest ? (Date.parse(b.latest.savedAt || '') || 0) : 0;
      return tb - ta;
    });

    const stat = (num, lbl, cls, title) => `
      <div class="dash-stat ${cls || ''}" ${title ? `title="${esc(title)}"` : ''}>
        <div class="num">${num}</div>
        <div class="lbl">${lbl}</div>
      </div>`;
    sumEl.innerHTML =
      stat(cards.length, '巡检市场', '', '有历史记录的市场数量') +
      stat(totalRuns, '巡检记录', '', '历史巡检总次数（每市场保留最近 5 次）') +
      stat(abnormalMarkets, '异常市场', abnormalMarkets ? 'bad' : 'ok', '最近一次巡检存在异常服务器的市场数') +
      stat(cards.length - abnormalMarkets, '正常市场', 'ok', '最近一次巡检全部健康的市场数') +
      stat(latestTime ? fmtTime(new Date(latestTime).toISOString()) : '-', '最近巡检', '', '全系统最近一次巡检时间');

    if (!cards.length) {
      gridEl.innerHTML = '<div class="empty">暂无巡检数据，执行一次巡检后仪表盘自动展示</div>';
      return;
    }

    gridEl.innerHTML = cards.map((c) => {
      if (!c.latest) {
        return `<div class="dash-card"><div class="dash-card-head"><span class="dash-market">${esc(c.code)}</span><span class="dash-tag">无记录</span></div><div class="empty">暂无巡检</div></div>`;
      }
      const L = c.latest;
      return `
      <div class="dash-card ${c.isAbnormal ? 'is-bad' : 'is-ok'}" data-run="${esc(L.runId)}" title="点击查看完整巡检结果">
        <div class="dash-card-head">
          <span class="dash-market">${esc(c.code)}<small>${esc(c.name)}</small></span>
          <span class="dash-tag ${c.isAbnormal ? 'tag-bad' : 'tag-ok'}">${c.isAbnormal ? '异常' : '健康'}</span>
        </div>
        <div class="dash-time">${fmtTime(L.savedAt)} · 共 ${c.runCount} 次记录</div>
        <div class="dash-metrics">
          <div><b>${L.groupTotalServers || 0}</b><span>服务器</span></div>
          <div class="${c.isAbnormal ? 'm-bad' : ''}"><b>${L.anomalousServers || 0}</b><span>异常服务器</span></div>
          <div><b>${L.totalCodes || 0}</b><span>代码数</span></div>
        </div>
        <div class="dash-metrics">
          <div class="m-ok"><b>${L.consistentCodes || 0}</b><span>正常代码</span></div>
          <div class="m-bad"><b>${L.anomalies || 0}</b><span>异常代码</span></div>
          <div class="m-extra"><b>${L.extraCodes || 0}</b><span>多出代码</span></div>
        </div>
      </div>`;
    }).join('');

    // 点击卡片查看该市场最近一次完整结果
    gridEl.querySelectorAll('.dash-card[data-run]').forEach((card) => {
      card.onclick = () => viewHistoryRun(card.dataset.run);
    });
  } catch (e) {
    sumEl.innerHTML = '';
    gridEl.innerHTML = '<div class="empty">仪表盘加载失败：' + esc(e.message) + '</div>';
  }
}
$('refreshDashBtn') && ($('refreshDashBtn').onclick = renderDashboard);

/* ---------- 历史巡检 ---------- */
async function loadHistory() {
  const el = $('historyList');
  try {
    const r = await api('GET', '/api/history');
    const markets = r.markets || {};
    const marketCodes = Object.keys(markets).sort();
    if (!marketCodes.length) {
      el.innerHTML = '<div class="empty">暂无历史记录，执行一次巡检后自动保存</div>';
      return;
    }
    el.innerHTML = marketCodes.map((m) => {
      const runs = markets[m];
      const rows = runs.map((r) => {
        const cls = r.anomalousServers > 0 ? 'bad' : 'ok';
        const time = new Date(r.savedAt).toLocaleString('zh-CN', { hour12: false });
        return `<tr data-runid="${esc(r.runId)}" class="hist-row">
          <td>${time}</td>
          <td>${esc(r.runId)}</td>
          <td><code>${esc(m)}</code></td>
          <td>${r.groupTotalServers ?? '-'}</td>
          <td class="${cls}">${r.anomalousServers ?? 0}</td>
          <td>${r.totalCodes ?? '-'}</td>
          <td class="${cls}">${r.anomalies ?? 0}</td>
          <td>${r.consistentCodes ?? '-'}</td>
          <td>${r.extraCodes ?? 0}</td>
          <td>${esc(r.compareMode === 'merged' ? '多区合并' : '单区')}</td>
          <td><button class="btn sm" data-view="${esc(r.runId)}">查看</button> <button class="btn sm danger" data-del="${esc(r.runId)}">删除</button></td>
        </tr>`;
      }).join('');
      return `<div class="hist-market">
        <div class="hist-mk-title">市场 <code>${esc(m)}</code> · 最近 ${runs.length} 次</div>
        <table class="hist-tbl"><thead><tr><th>时间</th><th>runId</th><th>市场</th><th>服务器数</th><th>异常服务器</th><th>代码数</th><th>异常代码</th><th>正常代码</th><th>多出代码</th><th>对比方式</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    }).join('');
    // 绑定查看/删除
    el.querySelectorAll('button[data-view]').forEach((b) => b.onclick = () => viewHistoryRun(b.dataset.view));
    el.querySelectorAll('button[data-del]').forEach((b) => b.onclick = async () => {
      if (!confirm(`确定删除历史记录 ${b.dataset.del} ？`)) return;
      try { await api('DELETE', '/api/history/' + b.dataset.del); } catch (e) { alert('删除失败: ' + e.message); return; }
      loadHistory();
    });
  } catch (e) {
    el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/* 查看某次历史巡检结果：复用 renderResult 渲染 */
async function viewHistoryRun(runId) {
  try {
    const data = await api('GET', '/api/history/' + runId);
    // 构造 UI 需要的结构
    const result = { summary: data.summary, zones: data.zones, elapsedMs: data.elapsedMs };
    renderResult(result);
    // 跳转到结果卡片
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // 结果下方提示
    const tip = document.createElement('div');
    tip.className = 'run-tip';
    tip.innerHTML = `📜 查看历史记录：<code>${esc(runId)}</code>（${esc(data.savedAt)}）· 对比方式 ${esc(data.summary.compareMode === 'merged' ? '多区合并' : '单区')} · 算法 ${esc(data.summary.compareAlgorithm === 'reference' ? '参考机 diff' : '少数服从多数')} <button class="btn sm" onclick="this.parentElement.remove()">关闭</button>`;
    $('resultCard').insertAdjacentElement('beforeend', tip);
  } catch (e) {
    alert('加载历史失败: ' + e.message);
  }
}

$('refreshHistoryBtn') && ($('refreshHistoryBtn').onclick = loadHistory);
// 页面加载时拉一次历史
loadHistory();
