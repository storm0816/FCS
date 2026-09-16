let cfg = { zones: [], markets: [], settings: {}, objectStorage: {} };
let editingMarketCode = null;
let editingZoneId = null;

const $ = (id) => document.getElementById(id);
const zoneName = (id) => { const z = (cfg.zones || []).find((x) => x.id === id); return z ? z.name : (id || '-'); };

function notify(message, type = 'info') {
  let region = document.getElementById('toastRegion');
  if (!region) { region = document.createElement('div'); region.id = 'toastRegion'; region.className = 'toast-region'; region.setAttribute('aria-live', 'polite'); document.body.appendChild(region); }
  const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = String(message || ''); region.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 180); }, 3200);
}
window.alert = (message) => notify(message, /失败|错误|不能为空|请先|至少/.test(String(message)) ? 'error' : 'success');
function confirmAction(message, title = '确认操作') {
  return new Promise((resolve) => {
    const box = document.createElement('div'); box.className = 'modal-backdrop';
    box.innerHTML = `<div class="modal-card compact" role="dialog" aria-modal="true" aria-labelledby="confirmTitle"><h3 id="confirmTitle">${esc(title)}</h3><p class="modal-message">${esc(message)}</p><div class="actions"><button class="btn primary" data-confirm>确认</button><button class="btn" data-cancel>取消</button></div></div>`;
    const close = (value) => { box.remove(); resolve(value); }; document.body.appendChild(box);
    box.querySelector('[data-confirm]').onclick = () => close(true); box.querySelector('[data-cancel]').onclick = () => close(false);
    box.onclick = (event) => { if (event.target === box) close(false); }; box.querySelector('[data-confirm]').focus();
  });
}
function openRoleForm(role = null) {
  const isEdit = !!role; const box = document.createElement('div'); box.className = 'modal-backdrop';
  box.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>${isEdit ? '编辑角色' : '新增角色'}</h3><div class="modal-form"><label>角色代码<input data-role-id maxlength="64" placeholder="例如 operator" ${isEdit ? 'readonly' : ''} value="${esc(role?.role_id || '')}" /></label><label>角色名称<input data-role-name maxlength="128" value="${esc(role?.role_name || '')}" /></label><label>角色说明<textarea data-role-description maxlength="255">${esc(role?.description || '')}</textarea></label></div><div class="actions"><button class="btn primary" data-save>保存</button><button class="btn" data-cancel>关闭</button></div></div>`;
  document.body.appendChild(box); const close = () => box.remove(); box.querySelector('[data-cancel]').onclick = close; box.onclick = (e) => { if (e.target === box) close(); };
  box.querySelector('[data-save]').onclick = async () => { const roleId = box.querySelector('[data-role-id]').value.trim(); const roleName = box.querySelector('[data-role-name]').value.trim(); if (!/^[a-z][a-z0-9_.-]*$/.test(roleId)) return notify('角色代码需以小写字母开头，仅支持小写字母、数字、点、横线和下划线', 'error'); if (!roleName) return notify('角色名称不能为空', 'error'); try { await api('POST', '/api/roles', { roleId, roleName, description: box.querySelector('[data-role-description]').value.trim() }); close(); notify('角色已保存', 'success'); loadRolePanel(); } catch (e) { notify(e.message, 'error'); } };
  box.querySelector('[data-role-id]').focus();
}

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) { if (r.status === 401 && !url.startsWith('/api/auth/')) { window.location.replace('/login' + window.location.hash); } const err = await r.json().catch(() => ({})); throw new Error(err.error || r.statusText); }
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
  renderDingTalk();
  renderLdap();
  if ($('inspectConcurrency')) $('inspectConcurrency').value = Math.max(1, Number(cfg.settings.concurrency) || 4);
  renderObjectStorage();
  renderZonePick();
  renderMarketPick();
  await loadBusinessInspectOptions();
  updateInspectSourceUI();
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
window.__inspectAgents = window.__inspectAgents || [];

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
        <button class="btn sm danger" data-zdel="${z.id}">删除</button>
      </td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-zed]').forEach((b) => b.onclick = () => openZoneModal(b.dataset.zed));
  tb.querySelectorAll('[data-zdel]').forEach((b) => b.onclick = () => {
    cfg.zones = cfg.zones.filter((x) => x.id !== b.dataset.zdel);
    saveCfgAndRender();
  });
}

async function loadTagPartitions() {
  const table = $('tagPartitionTable'); if (!table) return;
  try {
    const data = await api('GET', '/api/agent-tag-partitions'); const rows = data.partitions || [];
    table.querySelector('tbody').innerHTML = rows.map((item) => `<tr><td><code>${esc(item.partitionId)}</code></td><td>${esc(item.partitionName)}</td><td><span class="tag">${esc(item.tagKey)}=${esc(item.tagValue)}</span></td><td>${item.agentCount}</td><td>${systemStatus(item.enabled)}</td><td>${esc(item.description || '-')}</td><td><button class="btn sm" data-tag-partition-edit="${esc(item.partitionId)}">编辑</button><button class="btn sm danger" data-tag-partition-delete="${esc(item.partitionId)}">删除</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">暂无 Agent 标签</td></tr>';
    table.querySelectorAll('[data-tag-partition-edit]').forEach((button) => button.onclick = () => openTagPartitionForm(rows.find((item) => item.partitionId === button.dataset.tagPartitionEdit)));
    table.querySelectorAll('[data-tag-partition-delete]').forEach((button) => button.onclick = async () => { if (!await confirmAction('删除该标签分区不会删除 Agent 上已有的标签，是否继续？')) return; try { await api('DELETE', '/api/agent-tag-partitions/' + encodeURIComponent(button.dataset.tagPartitionDelete)); loadTagPartitions(); } catch (error) { notify(error.message, 'error'); } });
  } catch (error) { table.querySelector('tbody').innerHTML = `<tr><td colspan="7" class="empty">加载失败：${esc(error.message)}</td></tr>`; }
}
function openTagPartitionForm(item = null) {
  const editing = !!item; const box = document.createElement('div'); box.className = 'modal-backdrop';
  box.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>${editing ? '编辑 Agent 标签' : '新增 Agent 标签'}</h3><div class="modal-form"><label>标签标识<input data-id ${editing ? 'readonly' : ''} value="${esc(item?.partitionId || '')}" placeholder="例如 production-bj" /></label><label>名称<input data-name value="${esc(item?.partitionName || '')}" placeholder="例如 北京生产环境" /></label><label>标签键<input data-key value="${esc(item?.tagKey || '')}" placeholder="例如 env" /></label><label>标签值<input data-value value="${esc(item?.tagValue || '')}" placeholder="例如 production" /></label><label>说明<textarea data-description>${esc(item?.description || '')}</textarea></label><label><input data-enabled type="checkbox" ${item?.enabled !== false ? 'checked' : ''} /> 启用</label></div><div class="actions"><button class="btn primary" data-save>保存</button><button class="btn" data-cancel>关闭</button></div></div>`;
  const close=()=>box.remove(); document.body.appendChild(box); box.onclick=(event)=>{ if(event.target===box) close(); }; box.querySelector('[data-cancel]').onclick=close;
  box.querySelector('[data-save]').onclick=async()=>{ const body={partitionId:box.querySelector('[data-id]').value.trim(),partitionName:box.querySelector('[data-name]').value.trim(),tagKey:box.querySelector('[data-key]').value.trim(),tagValue:box.querySelector('[data-value]').value.trim(),description:box.querySelector('[data-description]').value.trim(),enabled:box.querySelector('[data-enabled]').checked}; try { await api(editing ? 'PUT':'POST', editing ? '/api/agent-tag-partitions/'+encodeURIComponent(item.partitionId):'/api/agent-tag-partitions',body); close(); notify('Agent 标签已保存','success'); loadTagPartitions(); } catch(error){ notify(error.message,'error'); } };
}

/* 拉取本地 b2sumdata 已同步服务器的台数（按分区网段计数），刷新分区表 */
async function refreshZoneCounts() {
  try {
    const r = await api('GET', '/api/agents/zone-counts');
    if (r && r.ok && r.zones) {
      window.__zoneCounts = r.zones;
      window.__discoveredServers = Array.from(new Set([
        ...Object.values(r.zones).flatMap((z) => z.servers || []),
        ...(r.unmapped || [])
      ])).sort();
      renderZones();
      renderReferenceServerPick();
      updateInspectGuard();
    }
  } catch (e) { /* 计数失败静默，不影响主流程 */ }
  try {
    const r = await api('GET', '/api/agents');
    window.__inspectAgents = (r.agents || []).filter((a) => a.online);
    renderReferenceServerPick();
    updateInspectGuard();
  } catch (e) { /* Agent 状态稍后刷新 */ }
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
  const tb = $('marketTable')?.querySelector('tbody');
  if (!tb) return;
  tb.innerHTML = '';
  if (!cfg.markets.length) { tb.innerHTML = '<tr><td colspan="8" class="empty">暂无市场</td></tr>'; return; }
  cfg.markets.forEach((m, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td><code>${esc(m.code)}</code></td>
      <td>${esc(m.name)}</td>
      <td><code>${esc(m.dataDir || '-')}</code></td>
      <td><code>${esc(m.filePattern || '*.NIG')}</code></td>
      <td>${m.inspectTimes ? `<code>${esc(m.inspectTimes)}</code>` : '<span class="subzone">-</span>'}</td>
      <td><span class="tag ${m.enabled !== false ? 'ok' : 'bad'}">${m.enabled !== false ? '启用' : '禁用'}</span></td>
      <td>
        <button class="btn sm" data-med="${m.code}">编辑</button>
        <button class="btn sm danger" data-mdel="${m.code}">删除</button>
      </td>`;
    tb.appendChild(tr);
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
  $('m_enabled').checked = code ? m.enabled !== false : true;
  $('m_dataDir').value = m.dataDir || '';
  $('m_filePattern').value = m.filePattern || '*.NIG';
  $('m_inspectTimes').value = m.inspectTimes || '';
  $('marketModal').style.display = 'flex';
}
$('m_save').onclick = () => {
  const code = $('m_code').value.trim();
  if (!code) { alert('市场代码不能为空'); return; }
  const data = { code, name: $('m_name').value || code, enabled: $('m_enabled').checked, dataDir: $('m_dataDir').value.trim(), filePattern: $('m_filePattern').value.trim() || '*.NIG', inspectTimes: $('m_inspectTimes').value.trim() };
  if (editingMarketCode) {
    const m = cfg.markets.find((x) => x.code === editingMarketCode);
    m.code = code; m.name = data.name; m.enabled = data.enabled; m.dataDir = data.dataDir; m.filePattern = data.filePattern; m.inspectTimes = data.inspectTimes;
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
  $('osAccessKey').value = os.accessKey || '';
  $('osSecretKey').value = os.secretKey || '';
}

async function saveObjectStorage() {
  // 仅保存界面可编辑字段；文件命名规则等为系统固定常量，剔除旧配置中的残留字段
  cfg.objectStorage = {
    enabled: $('osEnabled').checked,
    region: $('osRegion').value.trim(),
    endpoint: $('osEndpoint').value.trim(),
    bucket: $('osBucket').value.trim(),
    prefix: $('osPrefix').value.trim(),
    accessKey: $('osAccessKey').value.trim(),
    secretKey: $('osSecretKey').value
  };
  try {
    await api('PUT', '/api/config', cfg);
    $('osTip').textContent = '已保存对象存储配置 ✓';
    setTimeout(() => ($('osTip').textContent = ''), 2500);
  } catch (e) { alert('保存失败: ' + e.message); }
}
$('saveOsBtn').onclick = saveObjectStorage;
if ($('saveLdapBtn')) $('saveLdapBtn').onclick = async () => {
  const current = cfg.ldap || {};
  const password = $('ldapBindPassword').value;
  cfg.ldap = {
    ...current,
    state: $('ldapEnabled').checked ? 'on' : 'off',
    servers: $('ldapServers').value.split(',').map((x) => x.trim()).filter(Boolean),
    search_base: $('ldapSearchBase').value.trim(),
    bind_user: $('ldapBindUser').value.trim(),
    bind_password: password || current.bind_password || '',
    user_attribute: $('ldapUserAttribute').value.trim() || 'sAMAccountName',
    bind_template: $('ldapBindTemplate').value.trim() || '%s',
    start_tls: $('ldapStartTls').value,
    tls_verify: $('ldapTlsVerify').value,
    timeout: Math.max(1000, Number($('ldapTimeout').value) || 5000)
  };
  try { await api('PUT', '/api/config', cfg); $('ldapBindPassword').value = ''; $('ldapTip').textContent = 'LDAP 配置已保存'; setTimeout(() => ($('ldapTip').textContent = ''), 2500); }
  catch (e) { $('ldapTip').textContent = '保存失败: ' + e.message; }
};

function renderLdap() {
  const ldap = cfg.ldap || {};
  if (!$('ldapEnabled')) return;
  $('ldapEnabled').checked = ldap.state === 'on';
  $('ldapServers').value = Array.isArray(ldap.servers) ? ldap.servers.join(',') : (ldap.servers || '');
  $('ldapSearchBase').value = ldap.search_base || '';
  $('ldapBindUser').value = ldap.bind_user || '';
  $('ldapBindPassword').value = '';
  $('ldapUserAttribute').value = ldap.user_attribute || 'sAMAccountName';
  $('ldapBindTemplate').value = ldap.bind_template || '%s';
  $('ldapStartTls').value = ldap.start_tls || 'off';
  $('ldapTlsVerify').value = ldap.tls_verify || 'on';
  $('ldapTimeout').value = ldap.timeout || 5000;
}
function renderDingTalk() {
  const dt = cfg.dingTalk || {};
  $('dtEnabled').checked = dt.enabled === true;
  $('dtWebhook').value = dt.webhook || '';
  $('dtSecret').value = dt.secret || '';
  $('dtScheduleTimes').value = dt.scheduleTimes || '';
}
function renderZonePick() {
  const box = $('zonePick');
  box.innerHTML = '';
  for (const z of cfg.zones) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" value="${z.id}" /> ${esc(z.name)}(${esc(z.id)})`;
    l.querySelector('input').onchange = () => { renderReferenceServerPick(); updateInspectGuard(); };
    box.appendChild(l);
  }
}
function renderMarketPick() {
  const valueEl = $('marketScope');
  const button = $('marketScopeButton');
  const options = $('marketScopeOptions');
  if (!valueEl || !button || !options) return;
  const prev = valueEl.value || 'all';
  const search = $('marketScopeSearch');
  const keyword = search ? search.value.trim().toUpperCase() : '';
  const markets = (cfg.markets || []).filter((m) => m.enabled !== false && (!keyword || String(m.code).toUpperCase().includes(keyword)));
  const selectedExists = markets.some((m) => m.code === prev);
  const selected = selectedExists ? prev : (markets[0] ? markets[0].code : '');
  valueEl.value = selected;
  button.textContent = selected === 'all' ? '全部市场' : selected;
  options.innerHTML = '';
  const addOption = (value, text) => {
    if (value === 'all') return;
    const option = document.createElement('button');
    option.type = 'button'; option.className = 'market-combo-option' + (selected === value ? ' active' : '');
    option.textContent = text;
    option.onclick = () => {
      valueEl.value = value;
      if (search) search.value = '';
      $('marketScopePanel').hidden = true;
      button.setAttribute('aria-expanded', 'false');
      renderMarketPick();
    };
    options.appendChild(option);
  };
  addOption('all', '全部市场');
  markets.forEach((m) => addOption(m.code, m.code));
}
if ($('marketScopeSearch')) $('marketScopeSearch').oninput = () => renderMarketPick();
if ($('marketScopeButton')) $('marketScopeButton').onclick = () => {
  const panel = $('marketScopePanel');
  panel.hidden = !panel.hidden;
  $('marketScopeButton').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) $('marketScopeSearch').focus();
};
if ($('marketScopeSearch')) $('marketScopeSearch').onkeydown = (event) => { if (event.key === 'Escape') { $('marketScopePanel').hidden = true; $('marketScopeButton').setAttribute('aria-expanded', 'false'); $('marketScopeButton').focus(); } };
document.addEventListener('click', (event) => {
  const combo = $('marketScopeCombo');
  const panel = $('marketScopePanel');
  if (combo && panel && !combo.contains(event.target)) { panel.hidden = true; $('marketScopeButton').setAttribute('aria-expanded', 'false'); }
});

function inspectSourceMode() { return 'dataset'; }
async function loadBusinessInspectOptions() {
  const system = $('inspectSystem'); const dataset = $('inspectDataset');
  if (!system || !dataset) return;
  try {
    const [systemsRes, datasetsRes, partitionsRes] = await Promise.all([api('GET', '/api/business-systems'), api('GET', '/api/datasets'), api('GET', '/api/agent-tag-partitions')]);
    window.__inspectBusinessSystems = (systemsRes.systems || []).filter((item) => item.enabled);
    window.__inspectDatasets = (datasetsRes.datasets || []).filter((item) => item.enabled);
    window.__inspectTagPartitions = (partitionsRes.partitions || []).filter((item) => item.enabled);
    const previousSystem = system.value;
    system.innerHTML = window.__inspectBusinessSystems.map((item) => `<option value="${esc(item.system_id)}">${esc(item.system_name)}</option>`).join('');
    if (window.__inspectBusinessSystems.some((item) => item.system_id === previousSystem)) system.value = previousSystem;
    const partition = $('inspectTagPartition'); const previousPartition = partition.value;
    partition.innerHTML = '<option value="">不按标签筛选</option>' + window.__inspectTagPartitions.map((item) => `<option value="${esc(item.partitionId)}">${esc(item.partitionName)} · ${esc(item.tagKey)}=${esc(item.tagValue)}</option>`).join('');
    if (window.__inspectTagPartitions.some((item) => item.partitionId === previousPartition)) partition.value = previousPartition;
    renderBusinessDatasetPick();
  } catch (error) { console.warn('[business inspection]', error); }
}
async function renderBusinessDatasetPick() {
  const system = $('inspectSystem'); const dataset = $('inspectDataset');
  if (!system || !dataset) return;
  const previous = dataset.value;
  const items = (window.__inspectDatasets || []).filter((item) => item.system_id === system.value);
  dataset.innerHTML = items.map((item) => `<option value="${esc(item.dataset_id)}">${esc(item.dataset_code)} · ${esc(item.dataset_name)}</option>`).join('') || '<option value="">暂无启用数据集</option>';
  if (items.some((item) => item.dataset_id === previous)) dataset.value = previous;
  renderInspectDatasetSummary();
  await refreshDatasetInspectAgents();
}
function renderInspectDatasetSummary() {
  const box = $('inspectDatasetSummary');
  if (!box) return;
  const dataset = (window.__inspectDatasets || []).find((item) => item.dataset_id === $('inspectDataset')?.value);
  if (!dataset) { box.innerHTML = '<span>当前业务系统暂无可巡检数据集。</span>'; return; }
  const path = dataset.sourceDir || dataset.dataDir || '-';
  const pattern = dataset.filePatterns || dataset.filePattern || '*';
  box.innerHTML = `<span><b>巡检目录</b><code>${esc(path)}</code></span><span><b>文件规则</b><code>${esc(pattern)}</code></span>`;
}
async function refreshDatasetInspectAgents() {
  const datasetId = $('inspectDataset')?.value;
  if (!datasetId) { window.__datasetInspectAgents = []; renderReferenceServerPick(); refreshInspectAutoSyncAgents(); updateInspectGuard(); return; }
  try {
    const systemId = $('inspectSystem')?.value || '';
    const [agentsRes, bindingsRes, systemRes] = await Promise.all([api('GET', '/api/agents'), api('GET', '/api/datasets/' + encodeURIComponent(datasetId) + '/bindings'), systemId ? api('GET', '/api/business-systems/' + encodeURIComponent(systemId) + '/agents') : Promise.resolve({ bindings: [] })]);
    const bound = new Set((bindingsRes.bindings || []).filter((item) => item.enabled).map((item) => item.agentId));
    const systemAgents = new Set((systemRes.bindings || []).filter((item) => item.enabled).map((item) => item.agentId));
    const applicable = bound.size ? bound : systemAgents;
    let candidates = (agentsRes.agents || []).filter((agent) => agent.online && applicable.has(agent.agentId));
    window.__datasetInspectBaseAgents = candidates;
    const mode = $('inspectAgentMode')?.value || 'all';
    const partition = mode === 'tag' ? (window.__inspectTagPartitions || []).find((item) => item.partitionId === $('inspectTagPartition')?.value) : null;
    if (partition) {
      const tagsByAgent = new Map(await Promise.all(candidates.map(async (agent) => { const data = await api('GET', '/api/agents/' + encodeURIComponent(agent.agentId) + '/tags'); return [agent.agentId, data.tags || []]; })));
      candidates = candidates.filter((agent) => (tagsByAgent.get(agent.agentId) || []).some((tag) => tag.key === partition.tagKey && tag.value === partition.tagValue));
    }
    const pick = $('inspectAgentPick');
    const manualInitialized = pick?.dataset.initialized === '1';
    const previousPicked = pick?.__manualSelected || new Set();
    if (mode === 'manual' && !manualInitialized) (window.__datasetInspectBaseAgents || []).forEach((agent) => previousPicked.add(agent.agentId));
    window.__datasetInspectAgents = mode === 'manual' ? candidates.filter((agent) => previousPicked.has(agent.agentId)) : candidates;
    if (pick) {
      pick.hidden = mode !== 'manual';
      const list = mode === 'manual' ? (window.__datasetInspectBaseAgents || []) : [];
      if (mode === 'manual') { pick.dataset.initialized = '1'; pick.__manualSelected = previousPicked; renderAgentPicker(pick, list, previousPicked, () => { window.__datasetInspectAgents = list.filter((agent) => previousPicked.has(agent.agentId)); renderReferenceServerPick(); updateInspectGuard(); }); }
      else { pick.innerHTML = ''; pick.__manualSelected = new Set(); }
    }
  } catch (_) { window.__datasetInspectAgents = []; }
  renderInspectDatasetSummary(); renderReferenceServerPick(); refreshInspectAutoSyncAgents(); updateInspectGuard();
}
function refreshInspectAutoSyncAgents(saved = null) {
  const source = $('inspectSyncSource'); if (!source) return;
  const current = saved || window.__inspectAutoSync || {};
  const agents = window.__datasetInspectAgents || [];
  const sourceValue = current.sourceAgentId || source.value || '';
  const options = agents.map((agent) => `<option value="${esc(agent.agentId)}">${esc(agent.innerIp || agent.agentId)}${agent.hostname ? ` (${esc(agent.hostname)})` : ''}</option>`).join('');
  source.innerHTML = '<option value="">请选择来源 Agent</option>' + options;
  if (Array.from(source.options).some((option) => option.value === sourceValue)) source.value = sourceValue;
}
function updateInspectAutoSyncUI() {
  const enabled = !!$('inspectAutoSync')?.checked;
  if ($('inspectSyncSource')) $('inspectSyncSource').disabled = !enabled;
}
function updateInspectSourceUI() {
  $('businessInspectGroup').hidden = false;
  const tagGroup = $('inspectTagPartition')?.closest('.scope-group');
  if (tagGroup) tagGroup.hidden = ($('inspectAgentMode')?.value || 'all') !== 'tag';
  $('zonePick').hidden = document.querySelector('input[name="zonescope"]:checked')?.value !== 'selected';
  $('zonePick').style.display = document.querySelector('input[name="zonescope"]:checked')?.value === 'selected' ? 'flex' : 'none';
  renderReferenceServerPick(); updateInspectGuard();
}
if ($('inspectSystem')) $('inspectSystem').onchange = renderBusinessDatasetPick;
if ($('inspectDataset')) $('inspectDataset').onchange = () => { if ($('inspectAgentPick')) { $('inspectAgentPick').dataset.initialized = '0'; $('inspectAgentPick').__manualSelected = new Set(); } refreshDatasetInspectAgents(); };
if ($('inspectTagPartition')) $('inspectTagPartition').onchange = refreshDatasetInspectAgents;
if ($('inspectAgentMode')) $('inspectAgentMode').onchange = () => { if ($('inspectAgentPick')) $('inspectAgentPick').dataset.initialized = '0'; updateInspectSourceUI(); refreshDatasetInspectAgents(); };
if ($('inspectAutoSync')) $('inspectAutoSync').onchange = updateInspectAutoSyncUI;

/* 大量 Agent 的统一选择器：只渲染当前页，搜索和勾选状态保留在内存中。 */
function renderAgentPicker(box, agents, selected, onChange) {
  if (!box) return;
  const state = box.__agentPicker || { page: 1, keyword: '' };
  box.__agentPicker = state;
  const pageSize = 20;
  const list = Array.isArray(agents) ? agents : [];
  const draw = () => {
    const keyword = String(state.keyword || '').trim().toLowerCase();
    const filtered = list.filter((agent) => `${agent.agentId} ${agent.innerIp || ''} ${agent.hostname || ''} ${agent.zone || ''}`.toLowerCase().includes(keyword));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); state.page = Math.min(Math.max(1, state.page), pages);
    const visible = filtered.slice((state.page - 1) * pageSize, state.page * pageSize);
    box.innerHTML = `<div class="agent-picker-toolbar"><input class="scope-input" data-agent-picker-search type="search" placeholder="搜索 IP、主机名或 Agent ID" value="${esc(state.keyword)}" /><span data-agent-picker-count>已选 ${selected.size} 台</span><button type="button" class="btn sm" data-agent-picker-select>全选当前结果</button><button type="button" class="btn sm" data-agent-picker-clear>清空当前结果</button></div><div class="agent-picker-list">${visible.map((agent) => `<label><input type="checkbox" data-picker-agent value="${esc(agent.agentId)}" ${selected.has(agent.agentId) ? 'checked' : ''}/> <b>${esc(agent.hostname || agent.innerIp || agent.agentId)}</b><small>${esc(agent.innerIp || agent.agentId)} · ${esc(agent.zone || '未分区')} · ${agent.online ? '在线' : '离线'}</small></label>`).join('') || '<span class="empty">暂无匹配 Agent</span>'}</div><div class="agent-picker-pagination"><span>第 ${state.page}/${pages} 页，共 ${filtered.length} 台</span><button type="button" class="btn sm" data-agent-picker-prev ${state.page <= 1 ? 'disabled' : ''}>上一页</button><button type="button" class="btn sm" data-agent-picker-next ${state.page >= pages ? 'disabled' : ''}>下一页</button></div>`;
    const search = box.querySelector('[data-agent-picker-search]'); search.oninput = () => { state.keyword = search.value; state.page = 1; draw(); };
    box.querySelectorAll('[data-picker-agent]').forEach((input) => { input.onchange = () => { if (input.checked) selected.add(input.value); else selected.delete(input.value); box.querySelector('[data-agent-picker-count]').textContent = `已选 ${selected.size} 台`; onChange?.(selected); }; });
    box.querySelector('[data-agent-picker-select]').onclick = () => { visible.forEach((agent) => selected.add(agent.agentId)); draw(); onChange?.(selected); };
    box.querySelector('[data-agent-picker-clear]').onclick = () => { visible.forEach((agent) => selected.delete(agent.agentId)); draw(); onChange?.(selected); };
    box.querySelector('[data-agent-picker-prev]').onclick = () => { state.page -= 1; draw(); };
    box.querySelector('[data-agent-picker-next]').onclick = () => { state.page += 1; draw(); };
  };
  draw();
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
  const scope = document.querySelector('input[name="zonescope"]:checked');
  const selectedZones = scope && scope.value === 'selected' ? checkedValues('zonePick') : null;
  const candidates = inspectSourceMode() === 'dataset' ? (window.__datasetInspectAgents || []) : (window.__inspectAgents || []);
  const onlineAgents = candidates.filter((a) => !selectedZones || selectedZones.includes(a.zone));
  const servers = onlineAgents.length
    ? onlineAgents.map((a) => ({ id: inspectSourceMode() === 'dataset' ? a.agentId : (a.innerIp || a.agentId), label: `${a.innerIp || a.agentId}${a.hostname ? ' (' + a.hostname + ')' : ''}` }))
    : (window.__discoveredServers || []).map((sid) => ({ id: sid, label: sid }));
  if (servers.length) {
    for (const server of servers) {
      const o = document.createElement('option');
      o.value = server.id;
      o.textContent = server.label;
      sel.appendChild(o);
    }
  }
  if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
}

/* 对比算法联动：少数服从多数(diff) 不需要参考机 → 参考机下拉置灰禁用；参考机 diff 对比 → 启用 */
function updateInspectGuard() {
  const guard = $('inspectGuard');
  const btn = $('runBtn');
  if (!guard || !btn) return;
  const datasetMode = inspectSourceMode() === 'dataset';
  const compareOnly = false;
  const scope = document.querySelector('input[name="zonescope"]:checked');
  const selected = scope && scope.value === 'selected' ? checkedValues('zonePick') : null;
  const counts = window.__zoneCounts || {};
  const dataAgents = (window.__datasetInspectAgents || []).filter((agent) => !selected || selected.includes(agent.zone));
  const count = datasetMode ? dataAgents.length : (selected ? selected.reduce((n, z) => n + Number((counts[z] && counts[z].count) || 0), 0) : Object.values(counts).reduce((n, z) => n + Number(z.count || 0), 0));
  const blocked = !compareOnly && count === 0;
  btn.disabled = blocked;
  guard.classList.toggle('warn', blocked);
  guard.textContent = blocked ? (datasetMode ? '当前范围没有可用 Agent，请检查业务关联、数据集范围或筛选条件。' : '当前巡检范围没有在线 Agent，请选择有在线 Agent 的分区。') : (count ? `已确认 ${count} 台 Agent，将向这些机器下发巡检任务。` : '');
  renderInspectAgentPreview(dataAgents);
}

function renderInspectAgentPreview(agents) {
  const box = $('inspectAgentPreview'); const countBox = $('inspectAgentCount');
  if (!box) return;
  const rows = Array.isArray(agents) ? agents : [];
  if (countBox) countBox.textContent = `${rows.length} 台`;
  if (!rows.length) { box.innerHTML = '<div class="empty">没有符合当前条件的在线 Agent</div>'; return; }
  box.innerHTML = rows.map((agent) => {
    const systems = Array.isArray(agent.businessSystems) ? agent.businessSystems.map((item) => item.systemName || item.systemId).filter(Boolean).join('、') : '';
    return `<div class="inspect-agent-item"><span class="agent-dot online" aria-hidden="true"></span><div><b>${esc(agent.hostname || agent.innerIp || agent.agentId)}</b><small>${esc(agent.innerIp || agent.agentId)}</small></div><span class="inspect-agent-meta">${esc(agent.zone || '未分区')}</span>${systems ? `<span class="inspect-agent-meta">${esc(systems)}</span>` : ''}<span class="inspect-agent-status">在线</span></div>`;
  }).join('');
}

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
updateInspectAutoSyncUI();
updateZonescopeUI();
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
function resetInspectScopeSelections() {
  // 分区范围变更后，旧范围下的筛选条件不再可靠，统一恢复默认值。
  $('zonePick')?.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
  if ($('inspectAgentMode')) $('inspectAgentMode').value = 'all';
  if ($('inspectTagPartition')) $('inspectTagPartition').value = '';
  const pick = $('inspectAgentPick');
  if (pick) { pick.dataset.initialized = '0'; pick.__manualSelected = new Set(); delete pick.__agentPicker; pick.innerHTML = ''; }
  if ($('referenceServer')) $('referenceServer').value = '';
  if ($('inspectAutoSync')) $('inspectAutoSync').checked = false;
  window.__inspectAutoSync = {};
  refreshInspectAutoSyncAgents({});
  updateInspectAutoSyncUI();
  const majority = document.querySelector('input[name="cmpalgorithm"][value="majority"]');
  if (majority) majority.checked = true;
  updateAlgorithmUI();
}
document.querySelectorAll('input[name="zonescope"]').forEach((r) => r.onchange = () => {
  resetInspectScopeSelections();
  $('zonePick').style.display = r.value === 'selected' ? 'flex' : 'none';
  updateZonescopeUI();
  updateInspectSourceUI();
  refreshDatasetInspectAgents();
});
if ($('compareOnlyChk')) $('compareOnlyChk').onchange = updateInspectGuard;

function checkedValues(boxId) {
  return Array.from($(boxId).querySelectorAll('input:checked')).map((c) => c.value);
}

if ($('userQuery')) $('userQuery').oninput = () => loadUsers();
if ($('addUserOpenBtn')) $('addUserOpenBtn').onclick = () => { resetUserForm(false); if ($('userFormPanel')) $('userFormPanel').hidden = false; $('cancelUserEditBtn').hidden = false; $('cancelUserEditBtn').textContent = '关闭'; $('userSettingName').focus(); };
if ($('saveUserMfaBtn')) $('saveUserMfaBtn').onclick = async () => { const name = $('securityUserSelect').value; const secret = $('securityMfaSecret').value.trim(); try { await api('PUT', '/api/users/' + encodeURIComponent(name) + '/mfa', { enabled: !!secret, secret }); $('userSecurityTip').textContent = secret ? 'MFA 已启用' : 'MFA 已关闭'; } catch (e) { $('userSecurityTip').textContent = e.message; } };
if ($('saveUserRoleBtn')) $('saveUserRoleBtn').onclick = async () => { const name = $('securityUserSelect').value; const roleIds = Array.from($('securityRoleSelect').selectedOptions).map((o) => o.value); try { await api('PUT', '/api/users/' + encodeURIComponent(name) + '/roles', { roleIds }); $('userSecurityTip').textContent = '角色已保存'; } catch (e) { $('userSecurityTip').textContent = e.message; } };
document.addEventListener('click', (e) => { if (e.target.id === 'addRoleBtn') openRoleForm(); if (e.target.id === 'refreshAuditBtn') loadAuditPanel(); if (e.target.id === 'saveAdminPasswordBtn') (async () => { const tip=$('adminPasswordTip'); try { await api('PUT','/api/users/admin/password',{currentPassword:$('adminCurrentPassword').value,newPassword:$('adminNewPassword').value,confirmPassword:$('adminConfirmPassword').value}); tip.textContent='管理员密码已更新'; notify('管理员密码已更新', 'success'); } catch(err) { tip.textContent=err.message; notify(err.message, 'error'); } })(); });
if ($('addUserBtn') && $('cancelUserEditBtn') && !$('addUserBtn').parentElement.classList.contains('user-form-actions')) { const actions = document.createElement('span'); actions.className = 'user-form-actions'; $('addUserBtn').parentElement.insertBefore(actions, $('addUserBtn')); actions.append($('addUserBtn'), $('cancelUserEditBtn')); }
/* ---------- 巡检 ---------- */
async function loadAgents() {
  const tbody = $('agentTable') && $('agentTable').querySelector('tbody');
  const summary = $('agentStatusSummary');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="13" class="empty">加载中…</td></tr>';
  try {
    const res = await api('GET', '/api/agents');
    const agents = res.agents || [];
    const online = agents.filter((a) => a.online).length;
    if (summary) summary.textContent = `共 ${agents.length} 台 Agent，在线 ${online} 台，离线 ${agents.length - online} 台`;
    if (!agents.length) { tbody.innerHTML = '<tr><td colspan="13" class="empty">暂无 Agent 心跳记录</td></tr>'; return; }
    const tagsByAgent = new Map(await Promise.all(agents.map(async (agent) => {
      try { const data = await api('GET', '/api/agents/' + encodeURIComponent(agent.agentId) + '/tags'); return [agent.agentId, data.tags || []]; } catch (_) { return [agent.agentId, []]; }
    })));
    tbody.innerHTML = agents.map((a) => { const tags = tagsByAgent.get(a.agentId) || []; return `<tr>
      <td><input type="checkbox" data-agent-select value="${esc(a.agentId)}" aria-label="选择 ${esc(a.innerIp || a.agentId)}" /></td><td><span class="tag ${a.online ? 'ok' : 'bad'}">${a.online ? '在线' : '离线'}</span></td>
      <td><code>${esc(a.agentId)}</code></td><td>${esc(a.hostname || '-')}</td>
      <td><code>${esc(a.innerIp || '-')}</code></td><td><code>${esc(a.outerIp || '-')}</code></td>
      <td>${esc(a.zone || '-')}</td><td>${a.businessSystems?.length ? a.businessSystems.map((name) => `<span class="tag ok">${esc(name)}</span>`).join(' ') : '-'}</td><td class="agent-tag-list">${tags.length ? tags.map((tag) => `<span class="tag">${esc(tag.key)}=${esc(tag.value)}</span>`).join(' ') : '-'}</td><td>${esc(a.agentVersion || '-')}</td>
      <td>${a.lastSeenAt ? new Date(a.lastSeenAt).toLocaleString('zh-CN', { hour12: false }) : '-'}</td>
      <td>${esc(a.lastTaskStatus || '-')}</td><td><button class="btn sm primary" data-agent-tags="${esc(a.agentId)}">标签</button></td></tr>`; }).join('');
    tbody.querySelectorAll('[data-agent-tags]').forEach((button) => { button.onclick = () => openAgentTagForm(button.dataset.agentTags); });
    const all = $('agentSelectAll'); if (all) { all.checked = false; all.onchange = () => tbody.querySelectorAll('[data-agent-select]').forEach((input) => { input.checked = all.checked; }); }
  } catch (e) {
    if (summary) summary.textContent = '';
    tbody.innerHTML = `<tr><td colspan="13" class="empty">加载失败：${esc(e.message)}</td></tr>`;
  }
}
$('refreshAgentsBtn') && ($('refreshAgentsBtn').onclick = loadAgents);
function parseAgentTagText(value) {
  return String(value || '').split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    return index > 0 ? { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() } : null;
  }).filter((tag) => tag && tag.key && tag.value);
}
function mergeAgentTags(...groups) {
  const tags = new Map();
  groups.flat().forEach((tag) => { if (tag?.key && tag?.value) tags.set(`${tag.key}\u0000${tag.value}`, { key: tag.key, value: tag.value }); });
  return [...tags.values()];
}
function tagPresetOptions(partitions, selected = []) {
  const enabled = (partitions || []).filter((item) => item.enabled);
  if (!enabled.length) return '<p class="modal-message">暂无已定义标签。请先到“设置 → 标签设置”新增标签。</p>';
  const selectedKeys = new Set(selected.map((tag) => `${tag.key}\u0000${tag.value}`));
  return `<div class="tag-preset-options">${enabled.map((item) => { const key = `${item.tagKey}\u0000${item.tagValue}`; return `<label><input type="checkbox" data-tag-preset data-key="${esc(item.tagKey)}" data-value="${esc(item.tagValue)}" ${selectedKeys.has(key) ? 'checked' : ''} /> <strong>${esc(item.partitionName)}</strong><span>${esc(item.tagKey)}=${esc(item.tagValue)}</span></label>`; }).join('')}</div>`;
}
function selectedPresetTags(box) {
  return Array.from(box.querySelectorAll('[data-tag-preset]:checked')).map((input) => ({ key: input.dataset.key, value: input.dataset.value }));
}
if ($('batchAgentTagsBtn')) $('batchAgentTagsBtn').onclick = async () => {
  const ids = Array.from(document.querySelectorAll('#agentTable [data-agent-select]:checked')).map((input) => input.value);
  if (!ids.length) return notify('请先选择至少一台 Agent', 'error');
  let partitions = [];
  try { partitions = (await api('GET', '/api/agent-tag-partitions')).partitions || []; } catch (error) { return notify(error.message, 'error'); }
  const box = document.createElement('div'); box.className = 'modal-backdrop';
  box.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>批量设置 Agent 标签</h3><p class="modal-message">已选择 ${ids.length} 台 Agent。勾选标签或手工填写标签；保存后会保留每台 Agent 的其他已有标签。</p><label>选择已定义标签</label>${tagPresetOptions(partitions)}<label>补充标签（每行一个 键=值）<textarea data-tags rows="4" placeholder="env=production&#10;region=bj"></textarea></label><div class="actions"><button class="btn primary" data-save>保存</button><button class="btn" data-cancel>关闭</button></div></div>`;
  const close=()=>box.remove(); document.body.appendChild(box); box.onclick=(event)=>{if(event.target===box)close();}; box.querySelector('[data-cancel]').onclick=close;
  box.querySelector('[data-save]').onclick=async()=>{ const tags=mergeAgentTags(selectedPresetTags(box), parseAgentTagText(box.querySelector('[data-tags]').value)); if(!tags.length)return notify('请至少选择或填写一个标签','error'); try { const result=await api('POST','/api/agents/tags/batch',{agentIds:ids,tags}); close(); notify(`已为 ${result.total} 台 Agent 更新标签`,'success'); loadAgents(); } catch(error){ notify(error.message,'error'); } };
};

async function openAgentTagForm(agentId) {
  try {
    const [{ agents }, { tags }, tagSettings] = await Promise.all([
      api('GET', '/api/agents'), api('GET', '/api/agents/' + encodeURIComponent(agentId) + '/tags'), api('GET', '/api/agent-tag-partitions')
    ]);
    const agent = (agents || []).find((item) => item.agentId === agentId) || { agentId };
    const box = document.createElement('div'); box.className = 'modal-backdrop';
    box.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>Agent 标签</h3><p class="modal-message">${esc(agent.hostname || agent.innerIp || agent.agentId)} · 标签用于按机房、环境或职责筛选目标 Agent，与业务系统没有从属关系。</p><label>选择已定义标签</label>${tagPresetOptions(tagSettings.partitions || [], tags || [])}<p class="modal-message">标签请先在“设置 → 标签设置”中定义，再为 Agent 勾选。</p><div class="actions"><button class="btn primary" data-save>保存</button><button class="btn" data-cancel>关闭</button></div></div>`;
    document.body.appendChild(box);
    const close = () => box.remove();
    box.querySelector('[data-cancel]').onclick = close;
    box.onclick = (event) => { if (event.target === box) close(); };
    box.querySelector('[data-save]').onclick = async () => {
      const partitions = tagSettings.partitions || [];
      const defined = new Set(partitions.map((item) => `${item.tagKey}\u0000${item.tagValue}`));
      const preserved = (tags || []).filter((tag) => !defined.has(`${tag.key}\u0000${tag.value}`));
      const parsed = mergeAgentTags(preserved, selectedPresetTags(box));
      await api('PUT', '/api/agents/' + encodeURIComponent(agentId) + '/tags', { tags: parsed });
      close(); notify('Agent 标签已保存', 'success'); loadAgents();
    };
  } catch (error) { notify(error.message, 'error'); }
}

async function loadUsers() {
  const body = $('userTable') && $('userTable').querySelector('tbody');
  if (!body) return;
  try {
    const section = $('sec-user-settings');
    if (section && !section.querySelector('.user-tabs')) {
      const tabs = document.createElement('div'); tabs.className = 'user-tabs';
      tabs.innerHTML = '<button class="user-tab active" data-user-tab="users">用户</button><button class="user-tab" data-user-tab="roles">角色与权限</button><button class="user-tab" data-user-tab="audit">审计日志</button><button class="user-tab" data-user-tab="password">管理员密码</button>';
      section.insertBefore(tabs, section.firstElementChild);
      const panels = document.createElement('div'); panels.id = 'userExtraPanels'; panels.innerHTML = '<div class="user-extra-panel" data-panel="roles" hidden><div class="card-head"><span>管理角色及权限</span><button id="addRoleBtn" class="btn primary">新增角色</button></div><table class="tbl"><thead><tr><th>角色</th><th>说明</th><th>权限</th><th>类型</th><th>操作</th></tr></thead><tbody id="roleTableBody"></tbody></table><div id="rolePermissionEditor" class="system-module" hidden></div></div><div class="user-extra-panel" data-panel="audit" hidden><div class="card-head"><span>保留最近 200 条账号与权限操作</span><button id="refreshAuditBtn" class="btn">刷新</button></div><table class="tbl"><thead><tr><th>时间</th><th>用户</th><th>动作</th><th>对象</th><th>来源 IP</th><th>详情</th></tr></thead><tbody id="auditTableBody"></tbody></table></div><div class="user-extra-panel" data-panel="password" hidden><div class="password-panel"><p>此处仅修改本地 admin 管理员密码，LDAP 用户密码由 LDAP 服务器统一维护。</p><div class="settings-row"><label>当前密码 <input id="adminCurrentPassword" type="password" /></label><label>新密码 <input id="adminNewPassword" type="password" minlength="12" /></label><label>确认密码 <input id="adminConfirmPassword" type="password" /></label><button id="saveAdminPasswordBtn" class="btn primary">保存新密码</button></div><span id="adminPasswordTip" class="tip"></span></div></div>';
      section.appendChild(panels);
      const showTab = (name) => { tabs.querySelectorAll('.user-tab').forEach((b) => b.classList.toggle('active', b.dataset.userTab === name)); section.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; }); const isUsers = name === 'users'; $('userTable').hidden = !isUsers; section.querySelector('.card-head').hidden = !isUsers; if (!isUsers) $('userFormPanel').hidden = true; if (name === 'roles') loadRolePanel(); if (name === 'audit') loadAuditPanel(); };
      tabs.querySelectorAll('.user-tab').forEach((b) => b.onclick = () => showTab(b.dataset.userTab));
      window.__showUserTab = showTab;
    }
    const data = await api('GET', '/api/users');
    const roleData = await api('GET', '/api/roles');
    const roleSelect = $('securityRoleSelect');
    if (roleSelect) roleSelect.innerHTML = (roleData.roles || []).map((r) => `<option value="${esc(r.role_id)}">${esc(r.role_name)}</option>`).join('');
    const securitySelect = $('securityUserSelect');
    if (securitySelect) {
      securitySelect.innerHTML = (data.users || []).map((u) => `<option value="${esc(u.username)}">${esc(u.username)}</option>`).join('');
      securitySelect.onchange = async () => { try { const base = '/api/users/' + encodeURIComponent(securitySelect.value); const [m, r] = await Promise.all([api('GET', base + '/mfa'), api('GET', base + '/roles')]); $('securityMfaSecret').value = ''; Array.from($('securityRoleSelect').options).forEach((o) => { o.selected = (r.roles || []).includes(o.value); }); } catch (_) {} };
      securitySelect.dispatchEvent(new Event('change'));
    }
    const keyword = (($('userQuery') && $('userQuery').value) || '').trim().toLowerCase();
    const users = (data.users || []).filter((u) => !keyword || `${u.username} ${u.display_name || ''}`.toLowerCase().includes(keyword));
    body.innerHTML = (data.users || []).map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.display_name || u.username)}</td><td>${u.roles && u.roles.length ? u.roles.map((r) => `<span class="tag">${esc(r)}</span>`).join(' ') : '-'}</td><td><span class="tag ${u.enabled ? 'ok' : 'bad'}">${u.enabled ? '启用' : '停用'}</span></td><td><button class="btn sm" data-user-role="${esc(u.username)}">角色</button> <button class="btn sm" data-user-edit="${esc(u.username)}">编辑</button>${u.username === 'admin' ? '' : ` <button class="btn sm" data-user-del="${esc(u.username)}">删除</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无用户</td></tr>';
    const visibleUsers = new Set(users.map((u) => u.username));
    body.querySelector('td.empty')?.setAttribute('colspan', '5');
    const header = $('userTable')?.querySelector('thead tr');
    if (header && !header.querySelector('[data-user-source-head]')) { const th = document.createElement('th'); th.dataset.userSourceHead = '1'; th.textContent = '认证来源'; header.insertBefore(th, header.children[2] || null); }
    if (header && !header.querySelector('[data-user-role-head]')) { const th = document.createElement('th'); th.dataset.userRoleHead = '1'; th.textContent = '角色'; header.insertBefore(th, header.children[3] || null); }
    body.querySelectorAll('tr').forEach((row) => { const edit = row.querySelector('[data-user-edit]'); const user = edit && (data.users || []).find((u) => u.username === edit.dataset.userEdit); const status = row.querySelector('.tag')?.parentElement; if (user && status && !status.previousElementSibling?.dataset?.userSourceCell) { const td = document.createElement('td'); td.dataset.userSourceCell = '1'; td.textContent = user.auth_source === 'ldap' ? 'LDAP 用户' : '本地用户'; status.before(td); } });
    body.querySelectorAll('tr').forEach((row) => { const edit = row.querySelector('[data-user-edit]'); if (edit && !visibleUsers.has(edit.dataset.userEdit)) row.hidden = true; });
    body.querySelectorAll('[data-user-edit="admin"]').forEach((edit) => { const cell = edit.parentElement; if (cell && !cell.querySelector('[data-user-del="admin"]')) cell.insertAdjacentHTML('beforeend', ' <button class="btn sm" data-user-del="admin" disabled title="admin 用户不可删除">删除</button>'); });
    body.querySelectorAll('[data-user-del]').forEach((b) => { if (b.dataset.userDel === 'admin') { b.disabled = true; b.title = 'admin 用户不可删除'; } });
    body.querySelectorAll('[data-user-edit]').forEach((b) => b.onclick = () => {
      const user = (data.users || []).find((u) => u.username === b.dataset.userEdit);
      if (!user) return;
      if ($('userFormPanel')) $('userFormPanel').hidden = false;
      window.__editingUser = user.username;
      $('userSettingName').value = user.username;
      $('userSettingName').readOnly = true;
      $('userSettingDisplay').value = user.display_name || user.username;
      $('userSettingPassword').value = '';
      $('userSettingPassword').placeholder = '留空则不修改密码';
      $('userSettingEnabled').checked = !!user.enabled;
      $('addUserBtn').textContent = '保存修改';
      $('cancelUserEditBtn').hidden = false;
      $('cancelUserEditBtn').textContent = '取消编辑';
    });
    body.querySelectorAll('[data-user-role]').forEach((b) => b.onclick = () => openUserRoleEditor(b.dataset.userRole, roleData.roles || []));
    body.querySelectorAll('[data-user-del]').forEach((b) => b.onclick = async () => { if (b.disabled || !(await confirmAction(`确认删除用户 ${b.dataset.userDel}？`))) return; try { await api('DELETE', '/api/users/' + encodeURIComponent(b.dataset.userDel)); notify('用户已删除', 'success'); loadUsers(); } catch (e) { notify(e.message, 'error'); } });
  } catch (e) { body.innerHTML = `<tr><td colspan="4" class="empty">加载失败：${esc(e.message)}</td></tr>`; }
}
async function loadRolePanel() { const body=$('roleTableBody'); if (!body) return; const [roles, permissions] = await Promise.all([api('GET','/api/roles'),api('GET','/api/permissions')]); const all = permissions.permissions || []; const builtIn = new Set(['admin','manager','readonly']); const rows = await Promise.all((roles.roles||[]).map(async (role) => ({ role, permissions:(await api('GET','/api/roles/'+encodeURIComponent(role.role_id)+'/permissions')).permissions||[] }))); body.innerHTML=rows.map(({role,permissions:items})=>`<tr><td><strong>${esc(role.role_id)}</strong></td><td>${esc(role.description||'')}</td><td>${items.map((p)=>`<span class="tag ok">${esc(p.permission_id)}</span>`).join(' ')||'-'}</td><td><span class="tag">${builtIn.has(role.role_id)?'内置':'自定义'}</span></td><td><button class="btn sm" data-role-info="${esc(role.role_id)}">编辑</button> <button class="btn sm" data-role-edit="${esc(role.role_id)}" ${role.role_id==='admin'?'disabled title="admin 权限固定"':''}>编辑权限</button> ${builtIn.has(role.role_id)?'<button class="btn sm danger" disabled title="内置角色不可删除">删除</button>':`<button class="btn sm danger" data-role-del="${esc(role.role_id)}">删除</button>`}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">暂无角色</td></tr>'; body.querySelectorAll('[data-role-edit]:not([disabled])').forEach((button)=>button.onclick=()=>openRolePermissionEditor(button.dataset.roleEdit,all)); body.querySelectorAll('[data-role-info]').forEach((button)=>button.onclick=()=>openRoleForm(rows.find((x)=>x.role.role_id===button.dataset.roleInfo).role)); body.querySelectorAll('[data-role-del]').forEach((button)=>button.onclick=async()=>{if(!(await confirmAction('确认删除角色 '+button.dataset.roleDel+'？')))return; try { await api('DELETE','/api/roles/'+encodeURIComponent(button.dataset.roleDel)); notify('角色已删除','success'); loadRolePanel(); } catch(e) { notify(e.message,'error'); }}); }
async function openRolePermissionEditor(roleId, allPermissions) { const editor=$('rolePermissionEditor'); const selected=(await api('GET','/api/roles/'+encodeURIComponent(roleId)+'/permissions')).permissions.map((p)=>p.permission_id); editor.hidden=false; editor.innerHTML=`<h3 class="system-module-title">编辑 ${esc(roleId)} 权限</h3><div class="permission-options">${allPermissions.map((p)=>`<label><input type="checkbox" value="${esc(p.permission_id)}" ${selected.includes(p.permission_id)?'checked':''}/> ${esc(p.permission_id)} — ${esc(p.permission_name)}</label>`).join('')}</div><div class="actions"><button id="saveRolePermissionBtn" class="btn primary">保存权限</button><button id="cancelRolePermissionBtn" class="btn">关闭</button></div>`; $('saveRolePermissionBtn').onclick=async()=>{const permissionIds=Array.from(editor.querySelectorAll('input:checked')).map((x)=>x.value);await api('PUT','/api/roles/'+encodeURIComponent(roleId)+'/permissions',{permissionIds});editor.hidden=true;loadRolePanel();}; $('cancelRolePermissionBtn').onclick=()=>{editor.hidden=true;}; }
async function openUserRoleEditor(username, roles) { const current=(await api('GET','/api/users/'+encodeURIComponent(username)+'/roles')).roles||[]; const box=document.createElement('div'); box.className='modal-backdrop'; box.innerHTML=`<div class="modal-card"><h3>设置 ${esc(username)} 的角色</h3><div class="permission-options">${roles.map((r)=>`<label><input type="checkbox" value="${esc(r.role_id)}" ${current.includes(r.role_id)?'checked':''}/> ${esc(r.role_name)}</label>`).join('')}</div><div class="actions"><button class="btn primary" data-save-user-role>保存</button><button class="btn" data-close-user-role>关闭</button></div></div>`; document.body.appendChild(box); box.querySelector('[data-close-user-role]').onclick=()=>box.remove(); box.querySelector('[data-save-user-role]').onclick=async()=>{const roleIds=Array.from(box.querySelectorAll('input:checked')).map((x)=>x.value);await api('PUT','/api/users/'+encodeURIComponent(username)+'/roles',{roleIds});box.remove();loadUsers();}; }
async function loadAuditPanel() { const body=$('auditTableBody'); if (!body) return; const r=await api('GET','/api/audit-logs?limit=200'); body.innerHTML=(r.logs||[]).map((x)=>`<tr><td>${esc(new Date(x.created_at).toLocaleString('zh-CN',{hour12:false}))}</td><td>${esc(x.username)}</td><td>${esc(x.action)}</td><td>${esc(x.resource)}</td><td>${esc(x.ip_address)}</td><td><code>${esc(typeof x.detail==='string'?x.detail:JSON.stringify(x.detail||{}))}</code></td></tr>`).join('')||'<tr><td colspan="6" class="empty">暂无审计记录</td></tr>'; }
function taskDetail(value) { if (!value) return {}; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch (_) { return { message: String(value) }; } }
function formatDuration(ms) { const value = Number(ms || 0); if (!value) return '-'; if (value < 1000) return `${value} ms`; if (value < 60000) return `${(value / 1000).toFixed(1)} 秒`; return `${Math.floor(value / 60000)} 分 ${Math.round((value % 60000) / 1000)} 秒`; }
function formatBytes(bytes) { const value = Number(bytes || 0); if (!value) return '0 B'; const units = ['B','KB','MB','GB','TB']; const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / (1024 ** index)).toFixed(index ? 2 : 0)} ${units[index]}`; }
async function loadReleases() {
  const table = $('releaseTable')?.querySelector('tbody'); if (!table) return;
  const [agentsRes, releasesRes, datasetsRes] = await Promise.all([api('GET','/api/agents'), api('GET','/api/data/releases'), api('GET','/api/datasets')]);
  window.__releaseDatasets = datasetsRes.datasets || [];
  let agents = (agentsRes.agents || []).filter((a) => a.online);
  const selectedDatasetKey = String($('releaseMarket')?.value || '');
  if (selectedDatasetKey.startsWith('dataset:')) {
    try {
      const bindingData = await api('GET', '/api/datasets/' + encodeURIComponent(selectedDatasetKey.slice('dataset:'.length)) + '/bindings');
      let allowed = new Set((bindingData.bindings || []).filter((binding) => binding.enabled).map((binding) => binding.agentId));
      if (!allowed.size) {
        const dataset = (window.__releaseDatasets || []).find((item) => item.dataset_id === selectedDatasetKey.slice('dataset:'.length));
        if (dataset?.system_id) { const systemData = await api('GET', '/api/business-systems/' + encodeURIComponent(dataset.system_id) + '/agents'); allowed = new Set((systemData.bindings || []).filter((binding) => binding.enabled).map((binding) => binding.agentId)); }
      }
      agents = agents.filter((agent) => allowed.has(agent.agentId));
    } catch (_) { agents = []; }
  }
  const tagFilter = String($('releaseTagFilter')?.value || '').trim();
  if (tagFilter.includes('=')) {
    const requiredTags = tagFilter.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf('='); return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : null;
    }).filter(Boolean);
    if (requiredTags.length) {
      const tagRows = await Promise.all(agents.map(async (agent) => {
        try { const data = await api('GET', '/api/agents/' + encodeURIComponent(agent.agentId) + '/tags'); return [agent.agentId, data.tags || []]; } catch (_) { return [agent.agentId, []]; }
      }));
      const tagsByAgent = new Map(tagRows);
      agents = agents.filter((agent) => requiredTags.every(([key, value]) => (tagsByAgent.get(agent.agentId) || []).some((tag) => tag.key === key && tag.value === value)));
    }
  }
  const previousSource = window.__syncSourceAgent || $('releaseSource').value;
  const sourceSearch = $('releaseSourceSearch');
  const sourceKeyword = sourceSearch ? sourceSearch.value.trim().toUpperCase() : '';
  const sourceList = agents.filter((a) => !sourceKeyword || `${a.innerIp} ${a.hostname} ${a.agentId}`.toUpperCase().includes(sourceKeyword));
  const source = agents.find((a) => a.agentId === previousSource) || agents[0];
  if (source) $('releaseSource').value = source.agentId;
  $('releaseSourceButton').textContent = source ? `${source.innerIp} (${source.hostname})` : '请选择发布源 Agent';
  $('releaseSourceOptions').innerHTML = sourceList.map((a) => `<button type="button" class="market-combo-option${a.agentId === $('releaseSource').value ? ' active' : ''}" data-release-source="${esc(a.agentId)}">${esc(a.innerIp)} (${esc(a.hostname)})</button>`).join('') || '<div class="empty">暂无匹配 Agent</div>';
  $('releaseSourceOptions').querySelectorAll('[data-release-source]').forEach((option) => option.onclick = () => { $('releaseSource').value = option.dataset.releaseSource; $('releaseSourceButton').textContent = option.textContent; $('releaseSourceOptions').querySelectorAll('.active').forEach((x) => x.classList.remove('active')); option.classList.add('active'); $('releaseSourcePanel').hidden = true; $('releaseSourceButton').setAttribute('aria-expanded', 'false'); window.__syncSourceAgent = ''; window.__releaseTargets = null; loadReleases(); });
  const sourceId = $('releaseSource').value;
  const box = $('releaseTargetOptions');
  const picked = window.__syncTargetAgents || window.__releaseTargets || agents.filter((a) => a.agentId !== sourceId && (!window.__syncZones || !window.__syncZones.length || window.__syncZones.includes(a.zone))).map((a) => a.agentId);
  box.innerHTML = agents.filter((a) => a.agentId !== sourceId).map((a) => `<label class="market-combo-option"><input type="checkbox" value="${esc(a.agentId)}" ${picked.includes(a.agentId) ? 'checked' : ''}/> ${esc(a.innerIp)}</label>`).join('');
  const updateTargets = () => { window.__releaseTargets = Array.from(box.querySelectorAll('input:checked')).map((x) => x.value); $('releaseTargetButton').textContent = window.__releaseTargets.length ? `已选择 ${window.__releaseTargets.length} 台目标 Agent` : '请选择目标 Agent'; };
  box.querySelectorAll('input').forEach((x) => x.onchange = updateTargets); updateTargets();
  window.__syncTargetAgents = null;
  const syncMarket = String(window.__syncMarket || sessionStorage.getItem('fcs.syncMarket') || '').trim();
  const marketSearch = $('releaseMarketSearch');
  const marketKeyword = marketSearch ? marketSearch.value.trim().toUpperCase() : '';
  // 发布/下载统一按数据集执行。行情数据集也属于数据集，不能回退到已下线的
  // 旧“市场”发布逻辑，否则目标 Agent 无法得到自己的目标目录。
  const releaseMarkets = (window.__releaseDatasets || []).filter((item) => item.enabled && (!marketKeyword || `${item.dataset_code} ${item.dataset_name} ${item.systemName || item.system_id || ''}`.toUpperCase().includes(marketKeyword))).map((item) => ({ code: `dataset:${item.dataset_id}`, label: `数据集 · ${item.dataset_code}`, name: `${item.systemName || item.system_id} / ${item.dataset_name}`, type: 'dataset', datasetCode: item.dataset_code }));
  const syncedDataset = (window.__releaseDatasets || []).find((item) => String(item.dataset_id) === syncMarket || String(item.dataset_code) === syncMarket);
  const syncedValue = syncedDataset ? `dataset:${syncedDataset.dataset_id}` : '';
  const releaseMarket = $('releaseMarket');
  const releaseMarketButton = $('releaseMarketButton');
  const releaseMarketOptions = $('releaseMarketOptions');
  const selectedMarket = syncedValue || releaseMarket.value;
  // 只有巡检结果明确带入数据集时才预选；不能默认选择列表第一项，
  // 否则用户可能在未确认的情况下把错误的数据集发布到目标 Agent。
  releaseMarket.value = releaseMarkets.some((m) => String(m.code) === selectedMarket) ? selectedMarket : '';
  if (syncedValue) { window.__syncMarket = ''; sessionStorage.removeItem('fcs.syncMarket'); }
  releaseMarketButton.textContent = releaseMarkets.find((item) => item.code === releaseMarket.value)?.label || '请选择数据集';
  releaseMarketOptions.innerHTML = releaseMarkets.map((m) => `<button type="button" class="market-combo-option${String(m.code) === releaseMarket.value ? ' active' : ''}" data-release-market="${esc(m.code)}">${esc(m.label)}</button>`).join('') || '<div class="empty">暂无可发布的数据集</div>';
  releaseMarketOptions.querySelectorAll('[data-release-market]').forEach((option) => {
    const item = releaseMarkets.find((market) => String(market.code) === option.dataset.releaseMarket);
    option.onclick = () => { releaseMarket.value = option.dataset.releaseMarket; releaseMarketButton.textContent = option.textContent; releaseMarketOptions.querySelectorAll('.active').forEach((x) => x.classList.remove('active')); option.classList.add('active'); $('releaseMarketPanel').hidden = true; releaseMarketButton.setAttribute('aria-expanded', 'false'); window.__releaseTargets = null; loadReleases(); };
  });
  table.innerHTML = (releasesRes.releases || []).map((r) => { const source = (r.tasks || []).find((t) => t.action === 'publish'); const sourceInfo = taskDetail(source?.detail); const sourceText = source ? `${esc(source.status)}<br><small>打包 ${formatDuration(sourceInfo.packageMs)} · 上传 ${formatDuration(sourceInfo.uploadMs)}</small>${source.status === 'failed' ? `<br><button class="btn sm" data-release-retry="${esc(source.task_id)}">重试（${source.attempt_count || 0}/${source.max_attempts || 3}）</button>` : ''}${!['completed','failed','cancelled'].includes(source.status) ? `<br><button class="btn sm" data-release-cancel="${esc(source.task_id)}">取消</button>` : ''}` : '-'; const targets = (r.tasks || []).filter((t) => t.action === 'download'); const targetText = targets.length ? targets.map((t) => { const info=taskDetail(t.detail); return `${esc(t.agent_id)}: ${esc(t.status)}<br><small>下载 ${formatDuration(info.downloadMs)} · 替换 ${formatDuration(info.replaceMs)}</small>${t.status === 'failed' ? `<br><button class="btn sm" data-release-retry="${esc(t.task_id)}">重试（${t.attempt_count || 0}/${t.max_attempts || 3}）</button>` : ''}${!['completed','failed','cancelled'].includes(t.status) ? `<br><button class="btn sm" data-release-cancel="${esc(t.task_id)}">取消</button>` : ''}`; }).join('<br>') : '-'; return `<tr><td>${r.created_at ? new Date(r.created_at).toLocaleString('zh-CN',{hour12:false}) : '-'}</td><td>${esc(r.market_code)}</td><td>${esc(r.source_agent_id)}</td><td>${sourceText}</td><td>${esc(r.status)}</td><td>${targetText}</td><td>${formatBytes(r.size_bytes)}</td><td><code>${esc(r.sha256 || '-')}</code></td></tr>`; }).join('') || '<tr><td colspan="8" class="empty">暂无发布记录</td></tr>';
  table.querySelectorAll('[data-release-retry]').forEach((button) => { button.onclick = async () => { try { await api('POST', '/api/data/tasks/' + encodeURIComponent(button.dataset.releaseRetry) + '/retry'); notify('任务已加入重试队列', 'success'); loadReleases(); } catch (e) { notify(e.message, 'error'); } }; });
  table.querySelectorAll('[data-release-cancel]').forEach((button) => { button.onclick = async () => { if (!await confirmAction('确定取消该传输任务吗？')) return; try { await api('POST', '/api/data/tasks/' + encodeURIComponent(button.dataset.releaseCancel) + '/cancel'); notify('任务已取消', 'success'); loadReleases(); } catch (e) { notify(e.message, 'error'); } }; });
}
if ($('releaseSourceCombo') && !$('releaseTagFilter')) {
  const group = document.createElement('div'); group.className = 'scope-group';
  group.innerHTML = '<span class="scope-label">Agent 标签</span><input id="releaseTagFilter" class="scope-select" placeholder="如 env=production" />';
  $('releaseSourceCombo').closest('.scope-group')?.after(group);
  $('releaseTagFilter').onchange = () => { window.__releaseTargets = null; loadReleases(); };
}
if ($('releaseTargetButton')) $('releaseTargetButton').onclick = () => { const panel=$('releaseTargetPanel'); panel.hidden = !panel.hidden; $('releaseTargetButton').setAttribute('aria-expanded', String(!panel.hidden)); };
if ($('releaseMarketButton')) $('releaseMarketButton').onclick = () => { const panel = $('releaseMarketPanel'); panel.hidden = !panel.hidden; $('releaseMarketButton').setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) $('releaseMarketSearch').focus(); };
if ($('releaseSourceButton')) $('releaseSourceButton').onclick = () => { const panel = $('releaseSourcePanel'); panel.hidden = !panel.hidden; $('releaseSourceButton').setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) $('releaseSourceSearch').focus(); };
if ($('releaseMarketSearch')) $('releaseMarketSearch').oninput = () => loadReleases();
if ($('releaseSourceSearch')) $('releaseSourceSearch').oninput = () => loadReleases();
for (const [searchId, panelId, buttonId] of [['releaseMarketSearch','releaseMarketPanel','releaseMarketButton'],['releaseSourceSearch','releaseSourcePanel','releaseSourceButton']]) { if ($(searchId)) $(searchId).addEventListener('keydown', (event) => { if (event.key === 'Escape') { $(panelId).hidden = true; $(buttonId).setAttribute('aria-expanded','false'); $(buttonId).focus(); } }); }
if ($('releaseTargetPanel')) $('releaseTargetPanel').addEventListener('keydown', (event) => { if (event.key === 'Escape') { $('releaseTargetPanel').hidden=true; $('releaseTargetButton').setAttribute('aria-expanded','false'); $('releaseTargetButton').focus(); } });
if ($('releaseTargetAll')) $('releaseTargetAll').onclick = () => { const xs=$('releaseTargetOptions').querySelectorAll('input'); const all=Array.from(xs).every((x)=>x.checked); xs.forEach((x)=>x.checked=!all); xs[0]?.dispatchEvent(new Event('change')); };
if ($('refreshReleaseBtn')) $('refreshReleaseBtn').onclick = loadReleases;
// `dataset:<id>` is mandatory. Master validates the Agent bindings and applies
// the corresponding per-Agent target directory override.
if ($('createReleaseBtn')) $('createReleaseBtn').onclick = async () => {
  try {
    const selected = $('releaseMarket').value;
    const datasetId = selected.startsWith('dataset:') ? selected.slice('dataset:'.length) : '';
    if (!datasetId) throw new Error('请选择要发布的数据集');
    const result = await api('POST', '/api/data/releases', {
      datasetId, sourceAgentId: $('releaseSource').value,
      targetAgentIds: window.__releaseTargets || []
    });
    $('releaseTip').textContent = `发布任务已创建：${result.releaseId}`;
    loadReleases();
  } catch (error) { $('releaseTip').textContent = '创建失败：' + error.message; }
};
if ($('addUserBtn')) $('addUserBtn').onclick = async () => {
  try {
    const username = $('userSettingName').value.trim();
    if (!window.__editingUser && !$('userSettingPassword').value) throw new Error('新增用户必须设置密码');
    await api('POST', '/api/users', { username, displayName: $('userSettingDisplay').value, password: $('userSettingPassword').value, enabled: $('userSettingEnabled').checked });
    resetUserForm(); if ($('userFormPanel')) $('userFormPanel').hidden = true; notify('用户已保存', 'success'); loadUsers();
  } catch (e) { alert(e.message); }
};
function resetUserForm(hide = true) {
  window.__editingUser = '';
  $('userSettingName').value = ''; $('userSettingName').readOnly = false;
  $('userSettingDisplay').value = ''; $('userSettingPassword').value = '';
  $('userSettingPassword').placeholder = '登录密码'; $('userSettingEnabled').checked = true;
  $('addUserBtn').textContent = '新增用户'; $('cancelUserEditBtn').hidden = true;
}
if ($('cancelUserEditBtn')) $('cancelUserEditBtn').onclick = () => { resetUserForm(); if ($('userFormPanel')) $('userFormPanel').hidden = true; };

/* ---------- 巡检 ---------- */
$('runBtn').onclick = async () => {
  if (inspectSourceMode() === 'dataset') return runDatasetInspection();
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
  if (zs === 'selected' && !zones.length) { alert('请至少勾选一个分区'); return; }
  $('progress').style.display = 'block';
  $('progress').textContent = compareOnly
    ? '复查中（读取本地采集文件夹做对比）…'
    : '巡检中（已向在线 Agent 下发哈希采集任务）…';
  $('dataDirNote').style.display = 'none';
  $('resultCard').style.display = 'none';
  try {
    let res = await api('POST', '/api/inspect', { zones, markets, compareMode: cmp, referenceServerId, runId, compareOnly, compareAlgorithm });
    if (res.pending) {
      $('progress').textContent = `已下发巡检任务，等待 ${res.expectedAgents} 台 Agent 上报…`;
      res = await waitForAgentTask(res.taskId);
    }
    await refreshRecentRuns();
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

async function runDatasetInspection() {
  const datasetId = $('inspectDataset')?.value;
  if (!datasetId) return notify('请选择业务系统和数据集', 'error');
  const selectedZones = checkedValues('zonePick');
  const cmp = document.querySelector('input[name="cmpmode"]:checked')?.value || 'per-zone';
  const compareAlgorithm = document.querySelector('input[name="cmpalgorithm"]:checked')?.value || 'majority';
  const referenceServerId = compareAlgorithm === 'reference' ? ($('referenceServer')?.value || '') : '';
  $('progress').style.display = 'block';
  $('progress').textContent = '巡检中（已向数据集绑定的在线 Agent 下发哈希采集任务）…';
  $('dataDirNote').style.display = 'none'; $('resultCard').style.display = 'none';
  try {
    const mode = $('inspectAgentMode')?.value || 'all';
    const partition = mode === 'tag' ? (window.__inspectTagPartitions || []).find((item) => item.partitionId === $('inspectTagPartition')?.value) : null;
    const tags = partition ? [{ key: partition.tagKey, value: partition.tagValue }] : [];
    const agentIds = mode === 'manual' ? Array.from(document.querySelectorAll('#inspectAgentPick [data-inspect-agent]:checked')).map((input) => input.value) : [];
    const selectedPlan = window.__inspectionPlans?.find((p) => p.plan_id === $('inspectPlanSelect')?.value);
    const task = await api('POST', '/api/inspections', { datasetId, zones: selectedZones.length ? selectedZones : 'all', agentIds, tags, compareMode: cmp, compareAlgorithm, referenceServerId, planId: selectedPlan?.plan_id || '', planName: selectedPlan?.name || '', triggerType: 'manual' });
    $('progress').textContent = `已下发巡检任务，等待 ${task.expectedAgents} 台 Agent 上报…`;
    const result = await waitForAgentTask(task.taskId);
    await refreshRecentRuns(); renderResult(result); refreshZoneCounts();
    $('progress').textContent = `完成，用时 ${result.elapsedMs || 0} ms`;
  } catch (error) { $('progress').textContent = '巡检失败: ' + error.message; }
}

function currentInspectionScope() {
  const mode = $('inspectAgentMode')?.value || 'all';
  const selectedZones = checkedValues('zonePick');
  const tags = mode === 'tag' ? (() => { const p = (window.__inspectTagPartitions || []).find((item) => item.partitionId === $('inspectTagPartition')?.value); return p ? [{ key: p.tagKey, value: p.tagValue }] : []; })() : [];
  const agentIds = mode === 'manual' ? [...($('inspectAgentPick')?.__manualSelected || new Set())] : [];
  const compareAlgorithm = document.querySelector('input[name="cmpalgorithm"]:checked')?.value || 'majority';
  const autoSync = $('inspectAutoSync')?.checked ? { enabled: true, sourceAgentId: $('inspectSyncSource')?.value || '' } : undefined;
  return { systemId: $('inspectSystem')?.value || '', datasetId: $('inspectDataset')?.value || '', zones: selectedZones.length ? selectedZones : 'all', agentMode: mode, agentIds, tags, compareMode: document.querySelector('input[name="cmpmode"]:checked')?.value || 'per-zone', compareAlgorithm, referenceServerId: compareAlgorithm === 'reference' ? ($('referenceServer')?.value || '') : '', ...(autoSync ? { autoSync } : {}) };
}
async function applyInspectionScope(scope = {}) {
  const system = $('inspectSystem'); const dataset = $('inspectDataset');
  if (scope.systemId && system && Array.from(system.options).some((o) => o.value === scope.systemId)) { system.value = scope.systemId; await renderBusinessDatasetPick(); }
  if (scope.datasetId && dataset && Array.from(dataset.options).some((o) => o.value === scope.datasetId)) { dataset.value = scope.datasetId; await refreshDatasetInspectAgents(); }
  const zoneMode = Array.isArray(scope.zones) && scope.zones.length ? 'selected' : 'all';
  const zoneRadio = document.querySelector(`input[name="zonescope"][value="${zoneMode}"]`); if (zoneRadio) { zoneRadio.checked = true; updateZonescopeUI(); }
  if (zoneMode === 'selected') { renderZonePick(); (scope.zones || []).forEach((zone) => { const cb = document.querySelector(`#zonePick input[value="${CSS.escape(zone)}"]`); if (cb) cb.checked = true; }); }
  const cmp = document.querySelector(`input[name="cmpmode"][value="${scope.compareMode === 'merged' ? 'merged' : 'per-zone'}"]`); if (cmp) cmp.checked = true;
  const algo = document.querySelector(`input[name="cmpalgorithm"][value="${scope.compareAlgorithm === 'reference' ? 'reference' : 'majority'}"]`); if (algo) { algo.checked = true; updateAlgorithmUI(); }
  const mode = ['tag', 'manual'].includes(scope.agentMode) ? scope.agentMode : (Array.isArray(scope.agentIds) && scope.agentIds.length ? 'manual' : (Array.isArray(scope.tags) && scope.tags.length ? 'tag' : 'all'));
  const modeSel = $('inspectAgentMode'); if (modeSel) modeSel.value = mode;
  if (mode === 'tag' && scope.tags?.[0]) { const p = (window.__inspectTagPartitions || []).find((x) => x.tagKey === scope.tags[0].key && x.tagValue === scope.tags[0].value); if (p && $('inspectTagPartition')) $('inspectTagPartition').value = p.partitionId; }
  await refreshDatasetInspectAgents();
  if (mode === 'manual') { const pick = $('inspectAgentPick'); const wanted = new Set(scope.agentIds || []); if (pick) { pick.__manualSelected = wanted; window.__datasetInspectAgents = (window.__datasetInspectBaseAgents || []).filter((a) => wanted.has(a.agentId)); renderAgentPicker(pick, window.__datasetInspectBaseAgents || [], wanted, () => { window.__datasetInspectAgents = (window.__datasetInspectBaseAgents || []).filter((a) => wanted.has(a.agentId)); renderReferenceServerPick(); updateInspectGuard(); }); } }
  if ($('referenceServer') && scope.referenceServerId && Array.from($('referenceServer').options).some((o) => o.value === scope.referenceServerId)) $('referenceServer').value = scope.referenceServerId;
  window.__inspectAutoSync = scope.autoSync || {};
  if ($('inspectAutoSync')) $('inspectAutoSync').checked = scope.autoSync?.enabled === true;
  refreshInspectAutoSyncAgents(scope.autoSync || {}); updateInspectAutoSyncUI();
  renderReferenceServerPick(); updateInspectGuard();
}
async function loadInspectionPlans() {
  const select = $('inspectPlanSelect'); const table = $('inspectionPlanTable')?.querySelector('tbody');
  try {
    const data = await api('GET', '/api/inspection-plans'); window.__inspectionPlans = data.plans || [];
    if (select) { const previous = select.value; select.innerHTML = '<option value="">不使用方案</option>' + window.__inspectionPlans.filter((p) => p.enabled).map((p) => `<option value="${esc(p.plan_id)}">${esc(p.name)}</option>`).join(''); if (window.__inspectionPlans.some((p) => p.plan_id === previous)) select.value = previous; }
    if (table) table.innerHTML = window.__inspectionPlans.map((p) => { const s = p.scope || {}; const ds = (window.__inspectDatasets || []).find((x) => x.dataset_id === p.dataset_id); const range = s.agentMode === 'manual' ? `指定 ${s.agentIds?.length || 0} 台` : s.agentMode === 'tag' ? '按标签' : '全部候选'; const auto = s.autoSync?.enabled ? '启用（仅异常 Agent）' : '未启用'; return `<tr><td>${esc(p.name)}${p.description ? `<br><small>${esc(p.description)}</small>` : ''}</td><td>${esc(ds ? `${ds.dataset_code} · ${ds.dataset_name}` : p.dataset_id)}</td><td>${range}</td><td>${s.compareAlgorithm === 'reference' ? '参考 Agent' : '多数结果'} · ${s.compareMode === 'merged' ? '跨分区' : '分区内'}</td><td>${auto}</td><td>${p.enabled ? '<span class="tag ok">启用</span>' : '<span class="tag">停用</span>'}</td><td>${p.updated_at ? new Date(p.updated_at).toLocaleString('zh-CN', { hour12: false }) : '-'}</td><td><button class="btn sm primary" data-plan-use="${esc(p.plan_id)}">执行</button> <button class="btn sm" data-plan-edit="${esc(p.plan_id)}">编辑</button> <button class="btn sm danger" data-plan-delete="${esc(p.plan_id)}">删除</button></td></tr>`; }).join('') || '<tr><td colspan="8" class="empty">暂无巡检方案</td></tr>';
    table?.querySelectorAll('[data-plan-use]').forEach((b) => b.onclick = () => { const p = window.__inspectionPlans.find((x) => x.plan_id === b.dataset.planUse); if (p) applyPlanAndNavigate(p); });
    table?.querySelectorAll('[data-plan-edit]').forEach((b) => b.onclick = () => editInspectionPlan(window.__inspectionPlans.find((x) => x.plan_id === b.dataset.planEdit)));
    table?.querySelectorAll('[data-plan-delete]').forEach((b) => b.onclick = async () => { if (!await confirmAction('确定删除该巡检方案吗？')) return; try { await api('DELETE', '/api/inspection-plans/' + encodeURIComponent(b.dataset.planDelete)); notify('巡检方案已删除', 'success'); loadInspectionPlans(); } catch (e) { notify(e.message, 'error'); } });
  } catch (e) { if (table) table.innerHTML = `<tr><td colspan="8" class="empty">加载失败：${esc(e.message)}</td></tr>`; }
}
async function loadInspectionSchedules() {
  const table = $('inspectionScheduleTable')?.querySelector('tbody'); if (!table) return;
  try {
    if (!window.__inspectionPlans) await loadInspectionPlans();
    const data = await api('GET', '/api/inspection-schedules'); const rows = data.schedules || [];
    table.innerHTML = rows.map((item) => { const plan = (window.__inspectionPlans || []).find((p) => p.plan_id === item.plan_id); return `<tr><td>${esc(plan?.name || item.plan_id)}${plan ? `<br><small>${esc(plan.dataset_id)}</small>` : ''}</td><td><code>${esc(item.schedule_times)}</code></td><td>${item.enabled ? '<span class="tag ok">启用</span>' : '<span class="tag">停用</span>'}</td><td>${plan?.last_scheduled_at ? esc(new Date(plan.last_scheduled_at).toLocaleString('zh-CN', { hour12: false })) : '-'}</td><td><button class="btn sm" data-schedule-edit="${esc(item.schedule_id)}">编辑</button> <button class="btn sm danger" data-schedule-delete="${esc(item.schedule_id)}">删除</button></td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">暂无定时巡检任务</td></tr>';
    table.querySelectorAll('[data-schedule-edit]').forEach((button) => button.onclick = () => openInspectionScheduleForm(rows.find((x) => x.schedule_id === button.dataset.scheduleEdit)));
    table.querySelectorAll('[data-schedule-delete]').forEach((button) => button.onclick = async () => { if (!await confirmAction('确定删除该定时巡检任务吗？')) return; try { await api('DELETE', '/api/inspection-schedules/' + encodeURIComponent(button.dataset.scheduleDelete)); notify('定时任务已删除', 'success'); loadInspectionSchedules(); } catch (e) { notify(e.message, 'error'); } });
  } catch (e) { table.innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)}</td></tr>`; }
}
function openInspectionScheduleForm(item = null) {
  const plans = (window.__inspectionPlans || []).filter((p) => p.enabled); const box = document.createElement('div'); box.className = 'modal-backdrop';
  box.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>${item ? '编辑定时巡检' : '新增定时巡检'}</h3><div class="modal-form"><label>巡检方案<select data-schedule-plan>${plans.map((p) => `<option value="${esc(p.plan_id)}" ${item?.plan_id === p.plan_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label><label>定时时间（HH:mm，多个时间用逗号分隔）<input data-schedule-times value="${esc(item?.schedule_times || '')}" placeholder="09:00,15:00" /></label><label><input data-schedule-enabled type="checkbox" ${item?.enabled !== false ? 'checked' : ''}/> 启用定时巡检</label></div><div class="actions"><button class="btn primary" data-save>保存</button><button class="btn" data-cancel>关闭</button></div></div>`;
  document.body.appendChild(box); const close = () => box.remove(); box.querySelector('[data-cancel]').onclick = close; box.onclick = (e) => { if (e.target === box) close(); }; box.querySelector('[data-save]').onclick = async () => { const payload = { planId: box.querySelector('[data-schedule-plan]').value, scheduleTimes: box.querySelector('[data-schedule-times]').value.trim(), enabled: box.querySelector('[data-schedule-enabled]').checked }; try { await api(item ? 'PUT' : 'POST', item ? '/api/inspection-schedules/' + encodeURIComponent(item.schedule_id) : '/api/inspection-schedules', payload); close(); notify('定时巡检已保存', 'success'); loadInspectionSchedules(); } catch (e) { notify(e.message, 'error'); } };
}
if ($('addInspectionScheduleBtn')) $('addInspectionScheduleBtn').onclick = () => openInspectionScheduleForm();
async function applyPlanAndNavigate(plan) { window.__editingPlanId = ''; if ($('saveInspectPlanBtn')) $('saveInspectPlanBtn').textContent = '另存为方案'; window.__inspectPrefilling = true; window.__pendingPlan = plan; if (window.location.hash !== '#sec-inspect') window.location.hash = '#sec-inspect'; else showSection('sec-inspect'); try { await loadBusinessInspectOptions(); await applyInspectionScope(plan.scope || {}); if ($('inspectPlanSelect')) $('inspectPlanSelect').value = plan.plan_id; notify('已按巡检方案预填，请确认后点击开始巡检', 'success'); } finally { window.__inspectPrefilling = false; } }
function selectedValues(select) { return Array.from(select?.selectedOptions || []).map((item) => item.value); }
async function editInspectionPlan(plan) { if (!plan) return; await applyPlanAndNavigate(plan); window.__editingPlanId = plan.plan_id; if ($('saveInspectPlanBtn')) $('saveInspectPlanBtn').textContent = '保存方案修改'; notify('已回填方案，可直接修改巡检范围、对比设置和自动同步', 'success'); }
function openInspectionPlanForm(plan = null, scopeOverride = null) { const datasets = window.__inspectDatasets || []; const box = document.createElement('div'); box.className = 'modal-backdrop'; box.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>新增巡检方案</h3><div class="modal-form"><label>方案名称<input data-plan-name value="${esc(plan?.name || '')}" placeholder="例如 北京行情 SZ 日检" /></label><label>说明<textarea data-plan-desc>${esc(plan?.description || '')}</textarea></label><label><input data-plan-enabled type="checkbox" ${plan?.enabled !== false ? 'checked' : ''}/> 启用</label></div><div class="actions"><button class="btn primary" data-save>保存</button><button class="btn" data-cancel>关闭</button></div></div>`; document.body.appendChild(box); const close = () => box.remove(); box.querySelector('[data-cancel]').onclick = close; box.onclick = (e) => { if (e.target === box) close(); }; box.querySelector('[data-save]').onclick = async () => { const scope = { ...(scopeOverride || currentInspectionScope()) }; const dataset = datasets.find((item) => item.dataset_id === scope.datasetId); if (!scope.datasetId || !dataset) return notify('请先选择业务系统和数据集', 'error'); if (scope.autoSync?.enabled && !scope.autoSync.sourceAgentId) return notify('启用自动同步时必须选择来源 Agent', 'error'); try { await api('POST', '/api/inspection-plans', { name: box.querySelector('[data-plan-name]').value.trim(), description: box.querySelector('[data-plan-desc]').value.trim(), datasetId: scope.datasetId, scope: { ...scope, systemId: dataset.system_id }, enabled: box.querySelector('[data-plan-enabled]').checked }); close(); notify('巡检方案已保存', 'success'); loadInspectionPlans(); } catch (e) { notify(e.message, 'error'); } }; }
if ($('inspectPlanSelect')) $('inspectPlanSelect').onchange = async () => { const plan = window.__inspectionPlans?.find((p) => p.plan_id === $('inspectPlanSelect').value); if (plan) { window.__editingPlanId = ''; if ($('saveInspectPlanBtn')) $('saveInspectPlanBtn').textContent = '另存为方案'; window.__inspectPrefilling = true; try { await applyInspectionScope(plan.scope || {}); notify('已回填巡检方案，请确认后执行', 'success'); } finally { window.__inspectPrefilling = false; } } else { window.__editingPlanId = ''; if ($('saveInspectPlanBtn')) $('saveInspectPlanBtn').textContent = '另存为方案'; resetInspectForm(); } };
if ($('saveInspectPlanBtn')) $('saveInspectPlanBtn').onclick = async () => { const scope = currentInspectionScope(); if (!scope.datasetId) return notify('请先选择业务系统和数据集', 'error'); if (scope.autoSync?.enabled && !scope.autoSync.sourceAgentId) return notify('启用自动同步时必须选择来源 Agent', 'error'); const plan = window.__editingPlanId ? window.__inspectionPlans?.find((item) => item.plan_id === window.__editingPlanId) : null; if (!plan) return openInspectionPlanForm(null, scope); try { await api('PUT', '/api/inspection-plans/' + encodeURIComponent(plan.plan_id), { name: plan.name, description: plan.description || '', datasetId: scope.datasetId, scope, enabled: plan.enabled }); window.__editingPlanId = ''; $('saveInspectPlanBtn').textContent = '另存为方案'; notify('巡检方案已更新', 'success'); loadInspectionPlans(); } catch (error) { notify(error.message, 'error'); } };
if ($('addInspectionPlanBtn')) $('addInspectionPlanBtn').onclick = () => { window.location.hash = '#sec-inspect'; };

async function waitForAgentTask(taskId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const task = await api('GET', `/api/agent/tasks/${encodeURIComponent(taskId)}`);
    if (task.status === 'completed') return task.result;
    if (task.status === 'failed') throw new Error((task.result && task.result.error) || 'Agent 巡检任务失败');
    $('progress').textContent = `等待 Agent 上报：${task.reported_agents || 0}/${task.expected_agents || 0}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('等待 Agent 上报超时');
}

function renderResult(res) {
  window.__resultRendered = true;
  window.__syncMarket = res && res.summary && res.summary.marketScope && res.summary.marketScope !== 'all' ? res.summary.marketScope : '';
  window.__syncZones = (res.zones || []).map((z) => z.zone).filter((z) => z && z !== '__merged__');
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
      inner.innerHTML = '<div class="empty">该范围没有可对比的 Agent 数据，请确认所选分区存在在线 Agent，且 Agent 已上报对应市场。</div>';
    }
    for (const mk of zr.markets) {
      inner.appendChild(marketBlock(mk, isMerged));
    }
    zBlock.appendChild(inner);
    box.appendChild(zBlock);
  }
}

async function refreshRecentRuns() {
  try {
    const history = await api('GET', '/api/history');
    populateRecentResultPicker(Array.isArray(history.recentRuns) ? history.recentRuns : []);
  } catch (e) {
    // 不影响本次已完成的巡检结果展示；下次进入结果页会再次加载。
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
const systemStorageSection = document.getElementById('sec-storage');
const dingTalkSection = document.getElementById('sec-dingtalk');
if (systemStorageSection) {
  systemStorageSection.id = 'sec-system-settings';
  const heading = systemStorageSection.querySelector('h2');
  if (heading) heading.textContent = '系统设置';
  if (dingTalkSection) { systemStorageSection.appendChild(dingTalkSection); dingTalkSection.style.display = 'block'; }
}
let businessSystems = [];

function systemStatus(enabled) { return `<span class="tag ${enabled ? 'ok' : 'bad'}">${enabled ? '启用' : '禁用'}</span>`; }
async function loadBusinessSystems() {
  const table = $('businessSystemTable'); if (!table) return;
  try {
    const res = await api('GET', '/api/business-systems'); businessSystems = res.systems || [];
    table.querySelector('tbody').innerHTML = businessSystems.map((item) => { const datasetCount = Number(item.dataset_count || 0); const cannotDelete = datasetCount > 0; return `<tr><td><code>${esc(item.system_code)}</code></td><td>${esc(item.system_name)}</td><td>${esc(item.owner || '-')}</td><td>${datasetCount}</td><td>${systemStatus(item.enabled)}</td><td>${esc(item.description || '-')}</td><td><button class="btn sm" data-system-agents="${esc(item.system_id)}">Agent（${item.agent_count || 0}）</button><button class="btn sm" data-system-edit="${esc(item.system_id)}">编辑</button><button class="btn sm danger" data-system-delete="${esc(item.system_id)}" ${cannotDelete ? `disabled title="请先迁移或删除 ${datasetCount} 个数据集"` : ''}>删除</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">暂无业务系统</td></tr>';
    table.querySelectorAll('[data-system-agents]').forEach((button) => { button.onclick = () => openBusinessSystemAgentsForm(businessSystems.find((item) => item.system_id === button.dataset.systemAgents)); });
    table.querySelectorAll('[data-system-edit]').forEach((button) => { button.onclick = () => openBusinessSystemForm(businessSystems.find((item) => item.system_id === button.dataset.systemEdit)); });
    table.querySelectorAll('[data-system-delete]:not([disabled])').forEach((button) => { button.onclick = async () => { if (!await confirmAction('确认删除此业务系统？')) return; try { await api('DELETE', '/api/business-systems/' + encodeURIComponent(button.dataset.systemDelete)); notify('业务系统已删除', 'success'); loadBusinessSystems(); } catch (error) { notify(error.message, 'error'); } }; });
  } catch (error) { table.querySelector('tbody').innerHTML = `<tr><td colspan="7" class="empty">加载失败：${esc(error.message)}</td></tr>`; }
}
function openBusinessSystemForm(item = null) {
  const editing = !!item; const box = document.createElement('div'); box.className = 'modal-backdrop';
  box.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>${editing ? '编辑业务系统' : '新增业务系统'}</h3><div class="modal-form"><label>系统标识<input data-system-id ${editing ? 'readonly' : ''} value="${esc(item?.system_id || '')}" placeholder="例如 risk" /></label><label>系统代码<input data-system-code value="${esc(item?.system_code || '')}" placeholder="例如 risk" /></label><label>系统名称<input data-system-name value="${esc(item?.system_name || '')}" placeholder="例如 风控系统" /></label><label>负责人<input data-system-owner value="${esc(item?.owner || '')}" /></label><label>说明<textarea data-system-description>${esc(item?.description || '')}</textarea></label><label><input data-system-enabled type="checkbox" ${item?.enabled !== false ? 'checked' : ''} /> 启用</label></div><div class="actions"><button class="btn primary" data-save>保存</button><button class="btn" data-cancel>关闭</button></div></div>`;
  const close = () => box.remove(); document.body.appendChild(box); box.onclick = (event) => { if (event.target === box) close(); }; box.querySelector('[data-cancel]').onclick = close;
  box.querySelector('[data-save]').onclick = async () => { const systemId = box.querySelector('[data-system-id]').value.trim(); const systemCode = box.querySelector('[data-system-code]').value.trim(); const systemName = box.querySelector('[data-system-name]').value.trim(); if (!systemId || !systemCode || !systemName) return notify('请填写系统标识、代码和名称', 'error'); try { await api(editing ? 'PUT' : 'POST', editing ? '/api/business-systems/' + encodeURIComponent(item.system_id) : '/api/business-systems', { systemId, systemCode, systemName, owner: box.querySelector('[data-system-owner]').value.trim(), description: box.querySelector('[data-system-description]').value.trim(), enabled: box.querySelector('[data-system-enabled]').checked }); close(); notify('业务系统已保存', 'success'); await loadBusinessSystems(); loadDatasets(); } catch (error) { notify(error.message, 'error'); } };
}
async function openBusinessSystemAgentsForm(system) {
  if (!system) return;
  try {
    const [{ agents }, bindingData] = await Promise.all([api('GET', '/api/agents'), api('GET', '/api/business-systems/' + encodeURIComponent(system.system_id) + '/agents')]);
    const selected = new Set((bindingData.bindings || []).filter((item) => item.enabled).map((item) => item.agentId));
    const box = document.createElement('div'); box.className = 'modal-backdrop';
    box.innerHTML = `<div class="modal-card business-agent-form" role="dialog" aria-modal="true"><h3>关联 Agent：${esc(system.system_name)}</h3><p class="modal-message">业务系统与 Agent 为多对多关系。一台 Agent 可以关联多个业务系统。使用搜索和分页快速定位机器。</p><div class="business-agent-picker"></div><div class="actions"><button class="btn primary" data-save>保存关联</button><button class="btn" data-cancel>关闭</button></div></div>`;
    const picker = box.querySelector('.business-agent-picker');
    renderAgentPicker(picker, agents || [], selected, null);
    const close = () => box.remove(); document.body.appendChild(box); box.onclick = (event) => { if (event.target === box) close(); }; box.querySelector('[data-cancel]').onclick = close;
    box.querySelector('[data-save]').onclick = async () => { const bindings = Array.from(selected).map((agentId) => ({ agentId, enabled: true })); try { await api('PUT', '/api/business-systems/' + encodeURIComponent(system.system_id) + '/agents', { bindings }); close(); notify('业务系统 Agent 关联已保存', 'success'); loadBusinessSystems(); } catch (error) { notify(error.message, 'error'); } };
  } catch (error) { notify(error.message, 'error'); }
}
async function loadDatasets() {
  if (!window.__inspectionPlans) { try { await loadInspectionPlans(); } catch (_) {} }
  const table = $('datasetTable'); const filter = $('datasetSystemFilter'); if (!table || !filter) return;
  try {
    if (!businessSystems.length) { const systems = await api('GET', '/api/business-systems'); businessSystems = systems.systems || []; }
    const previous = filter.value; filter.innerHTML = '<option value="">全部业务系统</option>' + businessSystems.map((item) => `<option value="${esc(item.system_id)}">${esc(item.system_name)}</option>`).join(''); filter.value = businessSystems.some((item) => item.system_id === previous) ? previous : '';
    const res = await api('GET', '/api/datasets' + (filter.value ? '?systemId=' + encodeURIComponent(filter.value) : '')); const datasets = res.datasets || [];
    table.querySelector('tbody').innerHTML = datasets.map((item) => {
      return `<tr><td>${esc(item.systemName)}</td><td><code>${esc(item.dataset_code)}</code></td><td>${esc(item.dataset_name)}</td><td><code>${esc(item.sourceDir || '-')}</code></td><td><code>${esc(item.filePatterns || '*')}</code></td><td>${systemStatus(item.enabled)}</td><td><button class="btn sm" data-dataset-edit="${esc(item.dataset_id)}">编辑</button><button class="btn sm danger" data-dataset-delete="${esc(item.dataset_id)}">删除</button></td></tr>`;
    }).join('') || '<tr><td colspan="9" class="empty">暂无数据集</td></tr>';
    table.querySelectorAll('[data-dataset-edit]').forEach((button) => { button.onclick = () => openDatasetForm(datasets.find((item) => item.dataset_id === button.dataset.datasetEdit)); });
    table.querySelectorAll('[data-dataset-delete]').forEach((button) => { button.onclick = async () => { if (!await confirmAction('删除后该数据集的绑定关系也会删除，是否继续？')) return; try { await api('DELETE', '/api/datasets/' + encodeURIComponent(button.dataset.datasetDelete)); notify('数据集已删除', 'success'); loadDatasets(); } catch (error) { notify(error.message, 'error'); } }; });
  } catch (error) { table.querySelector('tbody').innerHTML = `<tr><td colspan="8" class="empty">加载失败：${esc(error.message)}</td></tr>`; }
}
async function openDatasetInspectForm(dataset) {
  if (!dataset) return;
  const box = document.createElement('div'); box.className = 'modal-backdrop';
  box.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>执行巡检：${esc(dataset.dataset_name)}</h3><div class="modal-form"><label>Agent 标签筛选（可选）<input data-inspect-tags placeholder="例如 env=production,region=bj" /></label><p class="modal-message">多个标签为“同时满足”。留空时巡检全部在线且已绑定的 Agent。</p></div><div class="actions"><button class="btn primary" data-save>开始巡检</button><button class="btn" data-cancel>关闭</button></div></div>`;
  const close = () => box.remove(); document.body.appendChild(box); box.onclick = (event) => { if (event.target === box) close(); }; box.querySelector('[data-cancel]').onclick = close;
  box.querySelector('[data-save]').onclick = async () => {
    const raw = box.querySelector('[data-inspect-tags]').value.trim(); const tags = raw ? raw.split(',').map((part) => part.trim()).filter(Boolean).map((part) => { const index = part.indexOf('='); return index > 0 ? { key: part.slice(0, index).trim(), value: part.slice(index + 1).trim() } : null; }).filter(Boolean) : [];
    if (raw && !tags.length) return notify('标签格式应为 key=value，多个标签用逗号分隔', 'error');
    try { const result = await api('POST', '/api/inspections', { datasetId: dataset.dataset_id, tags }); close(); notify(`巡检任务已创建，等待 ${result.expectedAgents} 台 Agent 上报`, 'success'); } catch (error) { notify(error.message, 'error'); }
  };
  box.querySelector('[data-inspect-tags]').focus();
}
function openDatasetForm(item = null) {
  const editing = !!item; const options = businessSystems.map((system) => `<option value="${esc(system.system_id)}" ${system.system_id === item?.system_id ? 'selected' : ''}>${esc(system.system_name)}</option>`).join(''); const box = document.createElement('div'); box.className = 'modal-backdrop';
  box.innerHTML = `<div class="modal-card dataset-form" role="dialog" aria-modal="true"><h3>${editing ? '编辑数据集' : '新增数据集'}</h3><div class="modal-form"><label>所属业务系统<select data-dataset-system>${options}</select></label><label>数据集标识<input data-dataset-id ${editing ? 'readonly' : ''} value="${esc(item?.dataset_id || '')}" placeholder="例如 risk-rules" /></label><label>数据集代码<input data-dataset-code value="${esc(item?.dataset_code || '')}" placeholder="例如 rules" /></label><label>数据集名称<input data-dataset-name value="${esc(item?.dataset_name || '')}" /></label><label>源目录<input data-dataset-source value="${esc(item?.sourceDir || '')}" placeholder="/opt/app/data" /></label><label>目标目录<input data-dataset-target value="${esc(item?.targetDir || '')}" placeholder="/opt/app/data" /></label><label>文件匹配规则<input data-dataset-pattern value="${esc(item?.filePatterns || '*')}" placeholder="*.json,*.yaml" /></label><label>排除规则<input data-dataset-exclude value="${esc(item?.excludePatterns || '')}" placeholder="*.tmp,cache/**" /></label><div class="form-checks"><label><input data-dataset-recursive type="checkbox" ${item?.recursive !== false ? 'checked' : ''}/> 递归扫描子目录</label><label><input data-dataset-sync type="checkbox" ${item?.syncEnabled !== false ? 'checked' : ''}/> 允许同步</label><label><input data-dataset-enabled type="checkbox" ${item?.enabled !== false ? 'checked' : ''}/> 启用</label></div></div><div class="actions"><button class="btn primary" data-save>保存</button><button class="btn" data-cancel>关闭</button></div></div>`;
  const checks = box.querySelector('.form-checks');
  if (checks) checks.insertAdjacentHTML('beforeend', `<label><input data-dataset-follow-symlinks type="checkbox" ${item?.followSymlinks ? 'checked' : ''}/> 跟随文件符号链接</label>`);
  const close = () => box.remove(); document.body.appendChild(box); box.onclick = (event) => { if (event.target === box) close(); }; box.querySelector('[data-cancel]').onclick = close;
  box.querySelector('[data-save]').onclick = async () => { const value = (name) => box.querySelector(name).value.trim(); const datasetId = value('[data-dataset-id]'); const datasetCode = value('[data-dataset-code]'); const datasetName = value('[data-dataset-name]'); if (!datasetId || !datasetCode || !datasetName) return notify('请填写数据集标识、代码和名称', 'error'); try { await api(editing ? 'PUT' : 'POST', editing ? '/api/datasets/' + encodeURIComponent(item.dataset_id) : '/api/datasets', { datasetId, systemId: value('[data-dataset-system]'), datasetCode, datasetName, sourceDir: value('[data-dataset-source]'), targetDir: value('[data-dataset-target]'), filePatterns: value('[data-dataset-pattern]') || '*', excludePatterns: value('[data-dataset-exclude]'), recursive: box.querySelector('[data-dataset-recursive]').checked, followSymlinks: box.querySelector('[data-dataset-follow-symlinks]').checked, syncEnabled: box.querySelector('[data-dataset-sync]').checked, enabled: box.querySelector('[data-dataset-enabled]').checked }); close(); notify('数据集已保存', 'success'); loadDatasets(); } catch (error) { notify(error.message, 'error'); } };
}

async function openDatasetBindingForm(dataset) {
  try {
    const [agentRes, bindingRes] = await Promise.all([api('GET', '/api/agents'), api('GET', '/api/datasets/' + encodeURIComponent(dataset.dataset_id) + '/bindings')]);
    const existingBindings = bindingRes.bindings || [];
    const bindings = new Map(existingBindings.map((binding) => [binding.agentId, binding])); const agents = agentRes.agents || [];
    const box = document.createElement('div'); box.className = 'modal-backdrop';
    box.innerHTML = `<div class="modal-card dataset-binding-form" role="dialog" aria-modal="true"><h3>设置 Agent 范围：${esc(dataset.dataset_name)}</h3><p class="modal-message">默认继承所属业务系统的 Agent。需要限定部分机器时，取消继承并勾选指定 Agent；路径覆盖留空时使用数据集标准目录。</p><label class="binding-inherit"><input type="checkbox" data-bind-inherit ${existingBindings.length ? '' : 'checked'} /> 继承业务系统 Agent（推荐）</label><div class="binding-list">${agents.map((agent) => { const binding = bindings.get(agent.agentId); return `<div class="binding-row"><label><input type="checkbox" data-bind-agent value="${esc(agent.agentId)}" ${binding?.enabled ? 'checked' : ''} ${existingBindings.length ? '' : 'disabled'}/> <b>${esc(agent.hostname || agent.innerIp)}</b><small>${esc(agent.innerIp)} · ${agent.online ? '在线' : '离线'}</small></label><input data-bind-source="${esc(agent.agentId)}" value="${esc(binding?.sourceDirOverride || '')}" placeholder="源目录覆盖（可选）" ${existingBindings.length ? '' : 'disabled'}/><input data-bind-target="${esc(agent.agentId)}" value="${esc(binding?.targetDirOverride || '')}" placeholder="目标目录覆盖（可选）" ${existingBindings.length ? '' : 'disabled'}/></div>`; }).join('') || '<div class="empty">暂无已注册 Agent</div>'}</div><div class="actions"><button class="btn primary" data-save>保存范围</button><button class="btn" data-cancel>关闭</button></div></div>`;
    const close = () => box.remove(); document.body.appendChild(box); box.onclick = (event) => { if (event.target === box) close(); }; box.querySelector('[data-cancel]').onclick = close;
    box.querySelector('[data-bind-inherit]').onchange = (event) => { box.querySelectorAll('[data-bind-agent],[data-bind-source],[data-bind-target]').forEach((input) => { input.disabled = event.target.checked; }); };
    box.querySelector('[data-save]').onclick = async () => { const values = box.querySelector('[data-bind-inherit]').checked ? [] : Array.from(box.querySelectorAll('[data-bind-agent]:checked')).map((input) => ({ agentId: input.value, sourceDirOverride: box.querySelector(`[data-bind-source="${CSS.escape(input.value)}"]`).value.trim(), targetDirOverride: box.querySelector(`[data-bind-target="${CSS.escape(input.value)}"]`).value.trim(), enabled: true })); if (!values.length && !box.querySelector('[data-bind-inherit]').checked) return notify('请至少选择一台 Agent，或选择继承业务系统 Agent', 'error'); try { await api('PUT', '/api/datasets/' + encodeURIComponent(dataset.dataset_id) + '/bindings', { bindings: values }); close(); notify('数据集 Agent 范围已保存', 'success'); loadDatasets(); } catch (error) { notify(error.message, 'error'); } };
  } catch (error) { notify(error.message, 'error'); }
}

const NAV_SECTION_IDS = ['sec-dashboard', 'sec-zones', 'sec-agent-tags', 'sec-business-systems', 'sec-datasets', 'sec-system-settings', 'sec-user-settings', 'sec-releases', 'sec-inspect', 'sec-inspection-plans', 'sec-inspection-schedules', 'sec-agents', 'resultCard', 'sec-history'];
const dashboardScopeHeading = $('dashMarkets')?.closest('.dashboard-panel')?.querySelector('h3');
if (dashboardScopeHeading) dashboardScopeHeading.textContent = '数据集健康度';
const storageLink = document.querySelector('.nav-item[data-target="sec-storage"]');
if (storageLink) { storageLink.dataset.target = 'sec-system-settings'; storageLink.setAttribute('href', '#sec-system-settings'); storageLink.querySelector('.nav-text').textContent = '系统设置'; }
const dingTalkLink = document.querySelector('.nav-item[data-target="sec-dingtalk"]');
if (dingTalkLink) dingTalkLink.remove();
const releaseLink = document.querySelector('.nav-item[data-target="sec-releases"]');
const inspectMenu = document.querySelector('.nav-children[data-children="inspect"]');
if (releaseLink && inspectMenu) inspectMenu.appendChild(releaseLink);

function organizeSystemSettings() {
  const section = document.getElementById('sec-system-settings');
  const dingTalk = document.getElementById('sec-dingtalk');
  if (!section || !dingTalk || section.querySelector('.system-module')) return;
  const tosModule = document.createElement('div');
  tosModule.className = 'system-module';
  tosModule.innerHTML = '<h3 class="system-module-title">对象存储（TOS）</h3>';
  Array.from(section.children).filter((el) => !el.classList.contains('card-head') && el !== dingTalk).forEach((el) => tosModule.appendChild(el));
  const ldapSettings = tosModule.querySelector('#ldapSettings');
  if (ldapSettings) {
    const ldapModule = document.createElement('div');
    ldapModule.className = 'system-module';
    ldapSettings.remove();
    const title = document.createElement('h3'); title.className = 'system-module-title'; title.textContent = 'LDAP 登录';
    ldapModule.append(title, ldapSettings);
    section.__ldapModule = ldapModule;
  }
  section.appendChild(tosModule);
  if (section.__ldapModule) { section.appendChild(section.__ldapModule); delete section.__ldapModule; }
  dingTalk.classList.add('system-module');
  const dtHeading = dingTalk.querySelector('h2');
  if (dtHeading) dtHeading.textContent = '钉钉通知';
  section.appendChild(dingTalk);
}
organizeSystemSettings();

function ensureConcurrencySettings() {
  const section = document.getElementById('sec-system-settings');
  const module = section?.querySelector('.system-module');
  if (!section || !module || $('inspectConcurrencySettings')) return;
  const box = document.createElement('div');
  box.className = 'system-module'; box.id = 'inspectConcurrencySettings';
  box.innerHTML = '<h3 class="system-module-title">巡检执行参数</h3><div class="settings-row"><label>全局并发上限 <input id="inspectConcurrency" type="number" min="1" max="64" /></label><span class="tip">控制巡检分区/市场任务的并发数量</span></div><div class="settings-row"><label>历史保留天数 <input id="inspectRetentionDays" type="number" min="1" max="3650" /></label><span class="tip">自动清理超过该天数的巡检和发布记录</span></div><div class="actions"><button id="saveConcurrencyBtn" class="btn primary">保存巡检参数</button><span id="concurrencyTip" class="tip"></span></div>';
  section.insertBefore(box, module);
  $('inspectConcurrency').value = Math.max(1, Number((cfg.settings || {}).concurrency) || 4);
  if ($('inspectRetentionDays')) $('inspectRetentionDays').value = Math.min(3650, Math.max(1, Number((cfg.settings || {}).retentionDays) || 90));
  $('saveConcurrencyBtn').onclick = async () => {
    cfg.settings = { ...(cfg.settings || {}), concurrency: Math.min(64, Math.max(1, Number($('inspectConcurrency').value) || 4)), retentionDays: Math.min(3650, Math.max(1, Number($('inspectRetentionDays')?.value) || 90)) };
    try { await api('PUT', '/api/config', cfg); $('concurrencyTip').textContent = '巡检并发参数已保存'; setTimeout(() => ($('concurrencyTip').textContent = ''), 2500); }
    catch (e) { $('concurrencyTip').textContent = '保存失败: ' + e.message; }
  };
}
ensureConcurrencySettings();

/* 显示指定 section，隐藏其他所有 section */
function showSection(id) {
  document.querySelectorAll('.market-combo-panel').forEach((panel) => { panel.hidden = true; });
  document.querySelectorAll('.market-combo-button').forEach((button) => button.setAttribute('aria-expanded', 'false'));
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
    const activeChild = nav.querySelector('.nav-item.active');
    const group = activeChild && activeChild.closest('.nav-group');
    if (id === 'sec-dashboard') {
      nav.querySelectorAll('.nav-group').forEach((item) => item.classList.add('collapsed'));
    } else if (group) {
      nav.querySelectorAll('.nav-group').forEach((item) => {
        item.classList.toggle('collapsed', item !== group);
      });
    }
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
    case 'sec-system-settings':
      loadConfig().then(() => { if (id === 'sec-zones') refreshZoneCounts(); }).catch((e) => console.error('[refreshPageData]', e));
      break;
    case 'sec-inspect':
      // 由「再执行」预填驱动时不重置，避免覆盖已回填的参数
      if (window.__inspectPrefilling) break;
      loadConfig().then(() => {
        resetInspectForm();
        loadInspectionPlans();
        if (id === 'sec-zones') refreshZoneCounts();
      }).catch((e) => console.error('[refreshPageData]', e));
      break;
    case 'sec-inspection-plans':
      loadBusinessInspectOptions().then(loadInspectionPlans).catch((e) => console.error('[refreshPageData]', e));
      break;
    case 'sec-inspection-schedules':
      loadInspectionPlans().then(loadInspectionSchedules).catch((e) => console.error('[refreshPageData]', e));
      break;
    case 'sec-agent-tags':
      loadTagPartitions();
      break;
    case 'sec-agent-tags':
      loadTagPartitions();
      break;
    case 'sec-business-systems':
      loadBusinessSystems();
      break;
    case 'sec-datasets':
      loadDatasets();
      break;
    case 'sec-user-settings':
      loadUsers();
      break;
    case 'sec-releases':
      loadConfig().then(loadReleases);
      break;
    case 'sec-agents':
      loadAgents();
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
    const recentRuns = Array.isArray(r.recentRuns) ? r.recentRuns : [];
    populateRecentResultPicker(recentRuns);
    const markets = r.markets || {};
    let latest = recentRuns[0] || null;
    if (latest) latest = { runId: latest.runId, savedAt: latest.savedAt, t: Date.parse(latest.savedAt || '') || 0 };
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

function populateRecentResultPicker(runs) {
  const panel = $('recentRunsTable');
  if (!panel) return;
  if (!runs.length) {
    panel.innerHTML = '<div class="empty">暂无巡检记录</div>';
    return;
  }
  panel.innerHTML = `<table class="hist-tbl"><thead><tr><th>#</th><th>巡检时间</th><th>来源</th><th>市场</th><th>服务器数</th><th>异常服务器</th><th>操作</th></tr></thead><tbody>${runs.map((r, i) => {
    const time = r.savedAt ? new Date(r.savedAt).toLocaleString('zh-CN', { hour12: false }) : '-';
    const markets = Array.isArray(r.markets) && r.markets.length ? r.markets.join(', ') : '全部市场';
    const marketCode = Array.isArray(r.markets) && r.markets.length === 1 ? r.markets[0] : (Array.isArray(r.markets) && r.markets.length > 1 ? 'all' : '');
    const savePlanAction = ` <button class="btn sm" data-save-plan-run="${esc(r.runId)}" title="保存本次巡检参数为可复用方案">保存方案</button>`;
    const syncAction = Number(r.anomalousServers || 0) > 0
      ? ` <button class="btn sm primary" data-sync-run="${esc(r.runId)}" data-sync-market="${esc(marketCode)}">同步</button>`
      : '';
    const source = r.planName ? `方案：${r.planName}` : (r.triggerType === 'scheduled' ? '定时巡检' : '手动巡检');
    return `<tr><td>${i + 1}</td><td>${esc(time)}</td><td>${esc(source)}</td><td>${esc(markets)}</td><td>${r.groupTotalServers ?? '-'}</td><td>${r.anomalousServers ?? 0}</td><td><button class="btn sm" data-result-run="${esc(r.runId)}">查看</button>${savePlanAction}${syncAction}</td></tr>`;
  }).join('')}</tbody></table>`;
  panel.querySelectorAll('[data-result-run]').forEach((button) => button.onclick = async () => {
    const runId = button.dataset.resultRun;
    const box = $('resultDetail');
    if (box) box.innerHTML = '<div class="empty">正在加载巡检结果…</div>';
    try {
      const data = await api('GET', '/api/history/' + encodeURIComponent(runId));
      renderResult({ summary: data.summary, zones: data.zones, elapsedMs: data.elapsedMs });
    } catch (e) {
      if (box) box.innerHTML = '<div class="empty">加载巡检结果失败：' + esc(e.message) + '</div>';
    }
  });
  panel.querySelectorAll('[data-sync-run]').forEach((button) => button.onclick = () => syncResultToRelease(button.dataset.syncRun, button.dataset.syncMarket));
  panel.querySelectorAll('[data-save-plan-run]').forEach((button) => button.onclick = () => savePlanFromRun(button.dataset.savePlanRun));
}

async function savePlanFromRun(runId) {
  try {
    const data = await api('GET', '/api/history/' + encodeURIComponent(runId));
    if (!window.__inspectDatasets || !window.__inspectDatasets.length) await loadBusinessInspectOptions();
    const scope = data.scope || {};
    const datasetId = scope.datasetId || scope.dataset?.dataset_id || '';
    if (!datasetId) return notify('该历史记录没有关联业务数据集，无法保存方案', 'error');
    openInspectionPlanForm(null, { ...scope, datasetId });
  } catch (e) { notify('读取巡检参数失败：' + e.message, 'error'); }
}

async function syncResultToRelease(runId, marketHint = '') {
  try {
    const data = await api('GET', '/api/history/' + encodeURIComponent(runId));
    const summary = data.summary || {};
    const zones = data.zones || [];
    const market = String(marketHint || ((summary.marketScope && summary.marketScope !== 'all') ? summary.marketScope : ((zones.flatMap((z) => z.markets || []).map((m) => m.market).find(Boolean)) || ''))).trim();
    const zoneIds = zones.map((z) => z.zone).filter((z) => z && z !== '__merged__');
    const source = summary.referenceServerId || zones.flatMap((z) => z.markets || []).map((m) => m.referenceServerId).find(Boolean) || '';
    window.__syncMarket = market;
    sessionStorage.setItem('fcs.syncMarket', market);
    window.__syncZones = zoneIds;
    window.__syncSourceAgent = source;
    window.__syncTargetAgents = null;
    const agentsRes = await api('GET', '/api/agents');
    const agents = agentsRes.agents || [];
    const sourceAgent = agents.find((a) => a.agentId === source || a.innerIp === source);
    window.__syncSourceAgent = sourceAgent ? sourceAgent.agentId : '';
    window.__syncTargetAgents = agents.filter((a) => a.agentId !== window.__syncSourceAgent && (!zoneIds.length || zoneIds.includes(a.zone))).map((a) => a.agentId);
    window.location.hash = '#sec-releases';
  } catch (e) {
    const tip = $('releaseTip');
    if (tip) tip.textContent = '同步巡检信息失败：' + e.message;
  }
}

/**
 * 再执行：读取某次历史巡检的 scope，把参数回填到「执行巡检」页面，
 * 让用户确认范围后再次下发巡检。导航期间用 __inspectPrefilling 标记，
 * 避免进入 sec-inspect 时的无参数重置把预填值清掉。
 */
async function rerunInspection(runId) {
  let data;
  try {
    data = await api('GET', '/api/history/' + encodeURIComponent(runId));
  } catch (e) {
    notify('载入巡检参数失败：' + e.message, 'error');
    return;
  }
  const scope = data.scope || {};
  // 确保业务系统 / 数据集下拉已加载
  if (!window.__inspectDatasets || !window.__inspectDatasets.length) {
    await loadBusinessInspectOptions();
  }
  window.__inspectPrefilling = true;
  if (window.location.hash !== '#sec-inspect') window.location.hash = '#sec-inspect';
  else showSection('sec-inspect');

  try {
    const system = $('inspectSystem');
    const dataset = $('inspectDataset');
    const systemId = scope.systemId || (scope.dataset && scope.dataset.system_id);
    const datasetId = scope.datasetId || (scope.dataset && scope.dataset.dataset_id);

    if (systemId && Array.from(system.options).some((o) => o.value === systemId)) {
      system.value = systemId;
      await renderBusinessDatasetPick();
    }
    if (datasetId && Array.from(dataset.options).some((o) => o.value === datasetId)) {
      dataset.value = datasetId;
      if ($('inspectAgentPick')) { $('inspectAgentPick').dataset.initialized = '0'; $('inspectAgentPick').__manualSelected = new Set(); }
      await refreshDatasetInspectAgents();
    } else {
      if (datasetId) notify('历史中的数据集已不可见（可能被删除或停用），已按当前默认数据集预填', 'warn');
      await refreshDatasetInspectAgents();
    }

    // 分区范围
    const zoneScope = (Array.isArray(scope.zones) && scope.zones.length) ? 'selected' : 'all';
    const zsRadio = document.querySelector('input[name="zonescope"][value="' + zoneScope + '"]');
    if (zsRadio && !zsRadio.checked) { zsRadio.checked = true; zsRadio.dispatchEvent(new Event('change')); }
    else if (zsRadio) { updateZonescopeUI(); }
    if (zoneScope === 'selected' && !document.querySelector('#zonePick input[type="checkbox"]')) renderZonePick();
    if (zoneScope === 'selected' && Array.isArray(scope.zones)) {
      document.querySelectorAll('#zonePick input[type="checkbox"]').forEach((cb) => { cb.checked = scope.zones.includes(cb.value); });
      renderReferenceServerPick();
      updateInspectGuard();
    }

    // 分区对比方式
    const cmpVal = scope.compareMode === 'merged' ? 'merged' : 'per-zone';
    const cmpRadio = document.querySelector('input[name="cmpmode"][value="' + cmpVal + '"]');
    if (cmpRadio && !cmpRadio.checked) cmpRadio.checked = true;

    // 对比算法 + 参考机联动
    const algoVal = scope.compareAlgorithm === 'reference' ? 'reference' : 'majority';
    const algoRadio = document.querySelector('input[name="cmpalgorithm"][value="' + algoVal + '"]');
    if (algoRadio && !algoRadio.checked) { algoRadio.checked = true; updateAlgorithmUI(); }

    // Agent 选择方式：全部 / 标签 / 手工
    let agentMode = 'all';
    if (Array.isArray(scope.agentIds) && scope.agentIds.length) agentMode = 'manual';
    else if (Array.isArray(scope.tags) && scope.tags.length) agentMode = 'tag';
    const modeSel = $('inspectAgentMode');
    if (modeSel) { modeSel.value = agentMode; modeSel.dispatchEvent(new Event('change')); }

    if (agentMode === 'tag' && Array.isArray(scope.tags) && scope.tags[0]) {
      const tag = scope.tags[0];
      const partitions = window.__inspectTagPartitions || [];
      const match = partitions.find((p) => p.tagKey === tag.key && p.tagValue === tag.value)
        || partitions.find((p) => p.tagKey === tag.key);
      if (match) { $('inspectTagPartition').value = match.partitionId; await refreshDatasetInspectAgents(); }
      else notify('未找到与历史标签匹配的标签分区，已按全部候选 Agent 预填', 'warn');
    }

    if (agentMode === 'manual' && Array.isArray(scope.agentIds) && scope.agentIds.length) {
      await refreshDatasetInspectAgents();
      const pick = $('inspectAgentPick');
      const base = window.__datasetInspectBaseAgents || [];
      const wanted = new Set(scope.agentIds);
      if (pick && pick.__manualSelected) {
        // 直接修改内部选中集合（与渲染闭包引用同一对象），覆盖分页内外的 Agent
        pick.__manualSelected.clear();
        base.forEach((a) => { if (wanted.has(a.agentId)) pick.__manualSelected.add(a.agentId); });
      }
      window.__datasetInspectAgents = base.filter((a) => pick && pick.__manualSelected && pick.__manualSelected.has(a.agentId));
      // 当前页可见的复选框同步勾选状态（执行时以 DOM 勾选为准，分页外的 Agent 已计入集合）
      document.querySelectorAll('#inspectAgentPick [data-picker-agent]').forEach((cb) => { cb.checked = wanted.has(cb.value); });
      renderReferenceServerPick();
      updateInspectGuard();
    }

    // 参考机（选项来自在线 Agent，离线则保持默认自动选择）
    const refSel = $('referenceServer');
    if (refSel && scope.referenceServerId && Array.from(refSel.options).some((o) => o.value === scope.referenceServerId)) {
      refSel.value = scope.referenceServerId;
    }

    updateInspectGuard();
    notify('已按本次巡检参数预填「执行巡检」，请确认范围后点击「开始巡检」', 'success');
  } catch (e) {
    notify('预填巡检参数失败：' + e.message, 'error');
  } finally {
    window.__inspectPrefilling = false;
  }
}

/**
 * 独立进入「执行巡检」时把所有筛选条件恢复为默认（不带任何预填参数）。
 * 仅在非「再执行」预填时由 refreshPageData 调用。
 */
function resetInspectForm() {
  window.__editingPlanId = '';
  if ($('saveInspectPlanBtn')) $('saveInspectPlanBtn').textContent = '另存为方案';
  if ($('inspectPlanSelect')) $('inspectPlanSelect').value = '';
  const system = $('inspectSystem');
  if (system && system.options.length) system.selectedIndex = 0;
  const allRadio = document.querySelector('input[name="zonescope"][value="all"]');
  if (allRadio) allRadio.checked = true;
  const perZone = document.querySelector('input[name="cmpmode"][value="per-zone"]');
  if (perZone) perZone.checked = true;
  const majority = document.querySelector('input[name="cmpalgorithm"][value="majority"]');
  if (majority) majority.checked = true;
  updateZonescopeUI();
  renderBusinessDatasetPick().then(() => {
    if ($('inspectAgentMode')) $('inspectAgentMode').value = 'all';
    if ($('inspectTagPartition')) $('inspectTagPartition').value = '';
    const pick = $('inspectAgentPick');
    if (pick) { pick.dataset.initialized = '0'; pick.__manualSelected = new Set(); delete pick.__agentPicker; pick.innerHTML = ''; }
    if ($('referenceServer')) $('referenceServer').value = '';
    if ($('inspectAutoSync')) $('inspectAutoSync').checked = false;
    window.__inspectAutoSync = {};
    refreshInspectAutoSyncAgents({});
    updateInspectAutoSyncUI();
    updateAlgorithmUI();
    updateInspectSourceUI();
    renderReferenceServerPick();
    updateInspectGuard();
  });
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
      if (window.location.hash !== '#' + id) window.location.hash = id;
      else {
        showSection(id);
        // 重复点击当前菜单时才立即刷新；切换 hash 由 hashchange 统一处理。
        refreshPageData(id);
      }
    });
  });

  // 一级目录点击：折叠/展开子菜单
  nav.querySelectorAll('.nav-parent').forEach((parent) => {
    parent.addEventListener('click', () => {
      const group = parent.closest('.nav-group');
      if (!group) return;
      if (group.classList.contains('collapsed')) {
        nav.querySelectorAll('.nav-group').forEach((item) => item.classList.toggle('collapsed', item !== group));
      } else {
        group.classList.add('collapsed');
      }
    });
  });

  // 巡检结果产生后聚焦到结果页
  window.__navFocusResult = () => {
    if (window.location.hash !== '#resultCard') window.location.hash = '#resultCard';
    else showSection('resultCard');
  };

  // 按现有 hash 恢复页面；无有效 hash 时进入仪表盘
  const initialId = (window.location.hash || '').replace(/^#/, '');
  const initialTarget = targets.find((t) => t.id === initialId);
  showSection(initialTarget ? initialId : 'sec-dashboard');
  if (initialTarget) refreshPageData(initialId);
  else renderDashboard();

  window.addEventListener('hashchange', () => {
    const id = (window.location.hash || '').replace(/^#/, '');
    const target = targets.find((t) => t.id === id);
    if (!target) return;
    showSection(id);
    refreshPageData(id);
  });
}

/* init */
$('addZoneBtn') && ($('addZoneBtn').onclick = () => openZoneModal(null));
$('addTagPartitionBtn') && ($('addTagPartitionBtn').onclick = () => openTagPartitionForm());
$('addMarketBtn') && ($('addMarketBtn').onclick = () => openMarketModal(null));
$('addBusinessSystemBtn') && ($('addBusinessSystemBtn').onclick = () => openBusinessSystemForm());
$('addDatasetBtn') && ($('addDatasetBtn').onclick = () => openDatasetForm());
$('datasetSystemFilter') && ($('datasetSystemFilter').onchange = loadDatasets);
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

async function renderLegacyDashboard() {
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
function dashboardNumber(value) { return Number(value || 0).toLocaleString('zh-CN'); }

function dashboardBarChart(items) {
  if (!items.length) return '<div class="empty">统计周期内暂无巡检记录</div>';
  const max = Math.max(1, ...items.map((item) => Math.max(item.total, item.abnormal)));
  return `<div class="dash-bars">${items.map((item) => {
    const completed = Math.round((item.completed || 0) / max * 100);
    const abnormal = Math.round((item.abnormal || 0) / max * 100);
    return `<div class="dash-bar-item" title="${esc(item.date)}：巡检 ${item.total} 次，异常 ${item.abnormal} 次">
      <div class="dash-bar-stack"><i class="dash-bar-completed" style="height:${completed}%"></i><i class="dash-bar-abnormal" style="height:${abnormal}%"></i></div>
      <span>${esc(item.date.slice(5))}</span>
    </div>`;
  }).join('')}</div><div class="dash-chart-legend"><span><i class="legend-ok"></i>完成巡检</span><span><i class="legend-bad"></i>发现异常</span></div>`;
}

async function renderDashboard() {
  const summaryEl = $('dashSummary');
  const trendEl = $('dashTrend');
  const agentEl = $('dashAgents');
  const marketEl = $('dashMarkets');
  const releaseEl = $('dashRelease');
  const anomalyEl = $('dashAnomalies');
  if (!summaryEl || !trendEl || !agentEl || !marketEl || !releaseEl || !anomalyEl) return;
  const range = Number($('dashRange')?.value || 7) === 30 ? 30 : 7;
  summaryEl.innerHTML = '<div class="empty">加载中…</div>';
  [trendEl, agentEl, marketEl, releaseEl].forEach((el) => { el.innerHTML = ''; });
  anomalyEl.innerHTML = '';
  try {
    const data = await api('GET', `/api/dashboard/summary?range=${range}`);
    const s = data.summary || {};
    const stat = (value, label, cls = '') => `<div class="dash-stat ${cls}"><div class="num">${dashboardNumber(value)}</div><div class="lbl">${label}</div></div>`;
    summaryEl.innerHTML = [
      stat(s.agents, 'Agent 总数'),
      stat(s.onlineAgents, '在线 Agent', s.offlineAgents ? '' : 'ok'),
      stat(s.todayInspections, '今日巡检'),
      stat(s.abnormalInspections, '异常巡检', s.abnormalInspections ? 'bad' : 'ok'),
      stat(s.failedInspections, '失败巡检', s.failedInspections ? 'bad' : 'ok'),
      stat(s.averageInspectionMs ? `${dashboardNumber(s.averageInspectionMs)} ms` : '-', '平均耗时'),
      stat(`${dashboardNumber(s.activeSchedules || 0)}/${dashboardNumber(s.totalSchedules || 0)}`, '启用定时任务')
    ].join('');
    $('dashTrendHint').textContent = `最近 ${data.range || range} 天`;
    trendEl.innerHTML = dashboardBarChart(data.inspectionTrend || []);
    $('dashAgentHint').textContent = `${s.onlineAgents || 0} 在线 / ${s.offlineAgents || 0} 离线`;
    const agents = data.agents || [];
    agentEl.innerHTML = agents.length ? agents.map((agent) => `<div class="dash-agent-row"><span class="agent-dot ${agent.online ? 'online' : 'offline'}"></span><div><b>${esc(agent.hostname || agent.innerIp || agent.agentId)}</b><small>${esc(agent.innerIp || '-')} · ${fmtTime(agent.lastSeenAt)}</small></div><span class="tag ${agent.online ? 'ok' : 'bad'}">${agent.online ? '在线' : '离线'}</span></div>`).join('') : '<div class="empty">暂无 Agent 心跳数据</div>';
    const markets = data.markets || [];
    const maxAnomalies = Math.max(1, ...markets.map((market) => Number(market.anomalies || 0)));
    marketEl.innerHTML = markets.length ? markets.map((market) => `<div class="dash-market-bar"><div class="dash-market-bar-title"><code>${esc(market.market)}</code><span>${dashboardNumber(market.anomalies)} 异常代码</span></div><div class="dash-progress"><i class="${market.anomalies ? 'bad' : 'ok'}" style="width:${Math.round(Number(market.anomalies || 0) / maxAnomalies * 100)}%"></i></div><small>${dashboardNumber(market.anomalousServers)} 台异常服务器 · ${dashboardNumber(market.taskCount)} 次巡检</small></div>`).join('') : '<div class="empty">统计周期内暂无市场巡检记录</div>';
    const releases = data.releases || {};
    const tasks = data.dataTasks || {};
    $('dashReleaseHint').textContent = `${dashboardNumber(releases.total)} 个发布包`;
    releaseEl.innerHTML = `<div><b>${dashboardNumber(releases.uploaded)}</b><span>上传完成</span></div><div><b>${dashboardNumber(tasks.completed)}</b><span>任务完成</span></div><div class="${tasks.failed ? 'is-bad' : ''}"><b>${dashboardNumber(tasks.failed)}</b><span>任务失败</span></div><div><b>${dashboardNumber(releases.sizeBytes / 1024 / 1024).replace(/\.0$/, '')} MB</b><span>发布包总量</span></div>`;
    const anomalies = data.recentAnomalies || [];
    anomalyEl.innerHTML = anomalies.length ? anomalies.map((item) => `<tr><td>${fmtTime(item.completedAt)}</td><td>${item.markets.map((market) => `<code>${esc(market)}</code>`).join(' ') || '-'}</td><td>${esc(item.reference || '-')}</td><td class="bad">${dashboardNumber(item.anomalousServers)}</td><td class="bad">${dashboardNumber(item.anomalies)}</td><td><button class="btn sm" data-dash-run="${esc(item.taskId)}">查看</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty">统计周期内没有异常巡检</td></tr>';
    anomalyEl.querySelectorAll('[data-dash-run]').forEach((button) => { button.onclick = () => viewHistoryRun(button.dataset.dashRun); });
  } catch (error) {
    summaryEl.innerHTML = '';
    trendEl.innerHTML = `<div class="empty">仪表盘加载失败：${esc(error.message)}</div>`;
  }
}
$('refreshDashBtn') && ($('refreshDashBtn').onclick = renderDashboard);
$('dashRange') && ($('dashRange').onchange = renderDashboard);

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
      if (!(await confirmAction(`确定删除历史记录 ${b.dataset.del} ？`))) return;
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
