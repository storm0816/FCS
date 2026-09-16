const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

let pool;

function connectionOptions() {
  const file = path.join(__dirname, '..', 'config.json');
  if (!fs.existsSync(file)) throw new Error('缺少本地数据库配置 config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')).mysql || {};
  if (!cfg.host || !cfg.database || !cfg.user) throw new Error('config.json 中缺少 mysql 配置');
  return {
    host: cfg.host, port: Number(cfg.port || 3306), user: cfg.user, password: cfg.password,
    database: cfg.database, waitForConnections: true, connectionLimit: Number(cfg.poolSize || 10),
    connectTimeout: Number(cfg.timeout || 5000), charset: 'utf8mb4'
  };
}

async function initDatabase() {
  if (pool) return pool;
  pool = mysql.createPool(connectionOptions());
  await pool.query('SELECT 1');
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_agents (
    agent_id VARCHAR(128) PRIMARY KEY,
    hostname VARCHAR(255) NOT NULL DEFAULT '', inner_ip VARCHAR(64) NOT NULL DEFAULT '',
    outer_ip VARCHAR(64) NOT NULL DEFAULT '', market_code VARCHAR(64) NOT NULL DEFAULT '',
    zone_code VARCHAR(64) NOT NULL DEFAULT '', agent_version VARCHAR(64) NOT NULL DEFAULT '',
    last_seen_at DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_users (
    username VARCHAR(128) PRIMARY KEY, password_hash VARCHAR(255) NULL,
    display_name VARCHAR(128) NOT NULL DEFAULT '', enabled TINYINT(1) NOT NULL DEFAULT 1,
    auth_source VARCHAR(32) NOT NULL DEFAULT 'local', external_id VARCHAR(255) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [userColumns] = await pool.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fcs_users'");
  const userColumnNames = new Set(userColumns.map((c) => c.COLUMN_NAME));
  if (userColumnNames.has('password_hash')) await pool.query('ALTER TABLE fcs_users MODIFY password_hash VARCHAR(255) NULL');
  if (!userColumnNames.has('auth_source')) await pool.query("ALTER TABLE fcs_users ADD COLUMN auth_source VARCHAR(32) NOT NULL DEFAULT 'local'");
  if (!userColumnNames.has('external_id')) await pool.query("ALTER TABLE fcs_users ADD COLUMN external_id VARCHAR(255) NOT NULL DEFAULT ''");
  if (!userColumnNames.has('mfa_enabled')) await pool.query("ALTER TABLE fcs_users ADD COLUMN mfa_enabled TINYINT(1) NOT NULL DEFAULT 0");
  if (!userColumnNames.has('mfa_secret')) await pool.query("ALTER TABLE fcs_users ADD COLUMN mfa_secret VARCHAR(512) NOT NULL DEFAULT ''");
  else await pool.query("ALTER TABLE fcs_users MODIFY mfa_secret VARCHAR(512) NOT NULL DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_roles (
    role_id VARCHAR(64) PRIMARY KEY, role_name VARCHAR(128) NOT NULL, description VARCHAR(255) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_permissions (
    permission_id VARCHAR(128) PRIMARY KEY, permission_name VARCHAR(128) NOT NULL, description VARCHAR(255) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_user_roles (
    username VARCHAR(128) NOT NULL, role_id VARCHAR(64) NOT NULL, PRIMARY KEY(username,role_id),
    FOREIGN KEY(username) REFERENCES fcs_users(username) ON DELETE CASCADE,
    FOREIGN KEY(role_id) REFERENCES fcs_roles(role_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_role_permissions (
    role_id VARCHAR(64) NOT NULL, permission_id VARCHAR(128) NOT NULL, PRIMARY KEY(role_id,permission_id),
    FOREIGN KEY(role_id) REFERENCES fcs_roles(role_id) ON DELETE CASCADE,
    FOREIGN KEY(permission_id) REFERENCES fcs_permissions(permission_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_sessions (
    session_id CHAR(64) PRIMARY KEY, username VARCHAR(128) NOT NULL, expires_at DATETIME NOT NULL,
    ip_address VARCHAR(64) NOT NULL DEFAULT '', user_agent VARCHAR(512) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_session_user(username), INDEX idx_session_expiry(expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, username VARCHAR(128) NOT NULL DEFAULT '', action VARCHAR(128) NOT NULL,
    resource VARCHAR(255) NOT NULL DEFAULT '', detail JSON NULL, ip_address VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_audit_time(created_at), INDEX idx_audit_user(username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_system_settings (
    setting_key VARCHAR(64) PRIMARY KEY, setting_value JSON NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.execute(`INSERT INTO fcs_users (username,password_hash,display_name,enabled) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE username=username`, ['admin', hashPassword('fcs'), 'admin']);
  await pool.execute("INSERT INTO fcs_roles (role_id,role_name,description) VALUES ('admin','系统管理员','全部系统权限') ON DUPLICATE KEY UPDATE role_name=VALUES(role_name)");
  await pool.execute("INSERT INTO fcs_roles (role_id,role_name,description) VALUES ('manager','安全管理员','系统管理与巡检权限') ON DUPLICATE KEY UPDATE role_name=VALUES(role_name)");
  await pool.execute("INSERT INTO fcs_roles (role_id,role_name,description) VALUES ('readonly','只读审计员','仅查看权限') ON DUPLICATE KEY UPDATE role_name=VALUES(role_name)");
  await pool.execute("INSERT IGNORE INTO fcs_user_roles (username,role_id) VALUES ('admin','admin')");
  for (const permission of [['system.read','读取系统'],['system.write','修改系统'],['inspection.execute','执行巡检'],['release.manage','管理发布'],['user.manage','管理用户'],['audit.read','查看审计']]) await pool.execute('INSERT IGNORE INTO fcs_permissions (permission_id,permission_name) VALUES (?,?)', permission);
  for (const permission of ['system.read','system.write','inspection.execute','release.manage','user.manage','audit.read']) await pool.execute('INSERT IGNORE INTO fcs_role_permissions (role_id,permission_id) VALUES (\'admin\',?)', [permission]);
  for (const permission of ['system.read','inspection.execute','audit.read']) await pool.execute('INSERT IGNORE INTO fcs_role_permissions (role_id,permission_id) VALUES (\'manager\',?)', [permission]);
  for (const permission of ['system.read','audit.read']) await pool.execute('INSERT IGNORE INTO fcs_role_permissions (role_id,permission_id) VALUES (\'readonly\',?)', [permission]);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_zones (
    id VARCHAR(64) PRIMARY KEY, name VARCHAR(128) NOT NULL, network_segment VARCHAR(128) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_markets (
    code VARCHAR(64) PRIMARY KEY, name VARCHAR(128) NOT NULL, data_dir VARCHAR(512) NOT NULL DEFAULT '',
    file_pattern VARCHAR(128) NOT NULL DEFAULT '*.NIG', enabled TINYINT(1) NOT NULL DEFAULT 1,
    inspect_times VARCHAR(255) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_business_systems (
    system_id VARCHAR(64) PRIMARY KEY, system_code VARCHAR(64) NOT NULL UNIQUE,
    system_name VARCHAR(128) NOT NULL, description VARCHAR(255) NOT NULL DEFAULT '',
    owner VARCHAR(128) NOT NULL DEFAULT '', enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_datasets (
    dataset_id VARCHAR(64) PRIMARY KEY, system_id VARCHAR(64) NOT NULL,
    dataset_code VARCHAR(64) NOT NULL, dataset_name VARCHAR(128) NOT NULL,
    source_dir VARCHAR(512) NOT NULL DEFAULT '', target_dir VARCHAR(512) NOT NULL DEFAULT '',
    file_patterns VARCHAR(512) NOT NULL DEFAULT '*', exclude_patterns VARCHAR(512) NOT NULL DEFAULT '',
    is_recursive TINYINT(1) NOT NULL DEFAULT 1, follow_symlinks TINYINT(1) NOT NULL DEFAULT 0,
    sync_enabled TINYINT(1) NOT NULL DEFAULT 1, enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_dataset_system_code (system_id,dataset_code),
    KEY idx_dataset_system_enabled (system_id,enabled),
    CONSTRAINT fk_dataset_system FOREIGN KEY (system_id) REFERENCES fcs_business_systems(system_id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [datasetColumns] = await pool.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fcs_datasets'");
  const datasetColumnNames = new Set(datasetColumns.map((column) => column.COLUMN_NAME));
  for (const legacyColumn of ['schedule_enabled', 'inspect_times', 'schedule_agent_mode', 'schedule_tag_partition_id', 'schedule_agent_ids', 'schedule_plan_id']) {
    if (datasetColumnNames.has(legacyColumn)) await pool.query(`ALTER TABLE fcs_datasets DROP COLUMN ${legacyColumn}`);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_dataset_bindings (
    dataset_id VARCHAR(64) NOT NULL, agent_id VARCHAR(128) NOT NULL,
    source_dir_override VARCHAR(512) NOT NULL DEFAULT '', target_dir_override VARCHAR(512) NOT NULL DEFAULT '',
    source_enabled TINYINT(1) NOT NULL DEFAULT 1, target_enabled TINYINT(1) NOT NULL DEFAULT 1,
    enabled TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY(dataset_id,agent_id), KEY idx_dataset_binding_agent (agent_id,enabled),
    CONSTRAINT fk_binding_dataset FOREIGN KEY (dataset_id) REFERENCES fcs_datasets(dataset_id) ON DELETE CASCADE,
    CONSTRAINT fk_binding_agent FOREIGN KEY (agent_id) REFERENCES fcs_agents(agent_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_business_system_agents (
    system_id VARCHAR(64) NOT NULL, agent_id VARCHAR(128) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY(system_id,agent_id), KEY idx_system_agent(agent_id,enabled),
    CONSTRAINT fk_system_agent_system FOREIGN KEY (system_id) REFERENCES fcs_business_systems(system_id) ON DELETE CASCADE,
    CONSTRAINT fk_system_agent_agent FOREIGN KEY (agent_id) REFERENCES fcs_agents(agent_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`INSERT IGNORE INTO fcs_business_system_agents (system_id,agent_id)
    SELECT DISTINCT d.system_id,b.agent_id FROM fcs_datasets d JOIN fcs_dataset_bindings b ON b.dataset_id=d.dataset_id WHERE b.enabled=1`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_agent_tags (
    agent_id VARCHAR(128) NOT NULL, tag_key VARCHAR(64) NOT NULL, tag_value VARCHAR(128) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(agent_id,tag_key,tag_value),
    KEY idx_agent_tag_lookup(tag_key,tag_value),
    CONSTRAINT fk_agent_tag_agent FOREIGN KEY (agent_id) REFERENCES fcs_agents(agent_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [agentTagIndexes] = await pool.query("SELECT INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fcs_agent_tags' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX");
  const agentTagPrimary = agentTagIndexes.map((item) => item.COLUMN_NAME).join(',');
  if (agentTagPrimary === 'agent_id,tag_key') await pool.query('ALTER TABLE fcs_agent_tags DROP PRIMARY KEY, ADD PRIMARY KEY(agent_id,tag_key,tag_value)');
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_agent_tag_partitions (
    partition_id VARCHAR(64) PRIMARY KEY, partition_name VARCHAR(128) NOT NULL,
    tag_key VARCHAR(64) NOT NULL, tag_value VARCHAR(128) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '', enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_tag_partition_rule(tag_key,tag_value)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 测试环境示例标签：仅为当前两台测试 Agent 补充，不覆盖管理员已有标签。
  await pool.query(`INSERT IGNORE INTO fcs_agent_tags (agent_id,tag_key,tag_value)
    SELECT agent_id,'env','test' FROM fcs_agents WHERE inner_ip IN ('10.37.0.23','10.37.0.218')`);
  await pool.query(`INSERT IGNORE INTO fcs_agent_tags (agent_id,tag_key,tag_value)
    SELECT agent_id,'role','quote-agent' FROM fcs_agents WHERE inner_ip IN ('10.37.0.23','10.37.0.218')`);
  await pool.query(`INSERT IGNORE INTO fcs_agent_tags (agent_id,tag_key,tag_value)
    SELECT agent_id,'site','beijing-dc' FROM fcs_agents WHERE inner_ip IN ('10.37.0.23','10.37.0.218')`);
  await pool.query(`INSERT IGNORE INTO fcs_agent_tag_partitions (partition_id,partition_name,tag_key,tag_value,description,enabled) VALUES
    ('test-env','测试环境','env','test','测试环境示例标签',1),
    ('quote-agent','行情 Agent','role','quote-agent','行情巡检测试 Agent',1),
    ('beijing-dc','北京数据中心','site','beijing-dc','测试 Agent 所在数据中心',1)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_inspection_tasks (
    task_id CHAR(36) PRIMARY KEY, scope_json JSON NOT NULL, status VARCHAR(32) NOT NULL,
    expected_agents INT NOT NULL DEFAULT 0, reported_agents INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME NULL,
    result_json JSON NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_inspection_plans (
    plan_id CHAR(36) PRIMARY KEY, name VARCHAR(128) NOT NULL, description VARCHAR(255) NOT NULL DEFAULT '',
    dataset_id VARCHAR(64) NOT NULL, scope_json JSON NOT NULL, enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_by VARCHAR(128) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_inspection_plan_dataset (dataset_id,enabled), KEY idx_inspection_plan_updated (updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_inspection_schedules (
    schedule_id CHAR(36) PRIMARY KEY, plan_id CHAR(36) NOT NULL,
    schedule_times VARCHAR(255) NOT NULL DEFAULT '', enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_by VARCHAR(128) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_inspection_schedule_plan (plan_id,enabled), KEY idx_inspection_schedule_time (schedule_times),
    CONSTRAINT fk_inspection_schedule_plan FOREIGN KEY (plan_id) REFERENCES fcs_inspection_plans(plan_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [inspectionTaskColumns] = await pool.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fcs_inspection_tasks'");
  const inspectionTaskColumnNames = new Set(inspectionTaskColumns.map((column) => column.COLUMN_NAME));
  if (!inspectionTaskColumnNames.has('system_id')) await pool.query("ALTER TABLE fcs_inspection_tasks ADD COLUMN system_id VARCHAR(64) NULL AFTER task_id");
  if (!inspectionTaskColumnNames.has('dataset_id')) await pool.query("ALTER TABLE fcs_inspection_tasks ADD COLUMN dataset_id VARCHAR(64) NULL AFTER system_id");
  if (!inspectionTaskColumnNames.has('task_type')) await pool.query("ALTER TABLE fcs_inspection_tasks ADD COLUMN task_type VARCHAR(32) NOT NULL DEFAULT 'market' AFTER dataset_id");
  if (!inspectionTaskColumnNames.has('trigger_type')) await pool.query("ALTER TABLE fcs_inspection_tasks ADD COLUMN trigger_type VARCHAR(32) NOT NULL DEFAULT 'manual' AFTER task_type");
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_agent_reports (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, task_id CHAR(36) NOT NULL,
    agent_id VARCHAR(128) NOT NULL, market_code VARCHAR(64) NOT NULL,
    hash_content LONGTEXT NOT NULL, hash_count INT NOT NULL DEFAULT 0,
    reported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_task_agent_market (task_id, agent_id, market_code),
    KEY idx_report_task (task_id),
    CONSTRAINT fk_report_task FOREIGN KEY (task_id) REFERENCES fcs_inspection_tasks(task_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [reportColumns] = await pool.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fcs_agent_reports'");
  if (!reportColumns.some((column) => column.COLUMN_NAME === 'dataset_id')) await pool.query("ALTER TABLE fcs_agent_reports ADD COLUMN dataset_id VARCHAR(64) NULL AFTER task_id");
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_task_agents (
    task_id CHAR(36) NOT NULL, agent_id VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'pending',
    error_detail TEXT NULL, dispatched_at DATETIME NULL, reported_at DATETIME NULL, PRIMARY KEY (task_id, agent_id),
    CONSTRAINT fk_task_agent_task FOREIGN KEY (task_id) REFERENCES fcs_inspection_tasks(task_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [taskAgentColumns] = await pool.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fcs_task_agents'");
  if (!taskAgentColumns.some((column) => column.COLUMN_NAME === 'error_detail')) await pool.query("ALTER TABLE fcs_task_agents ADD COLUMN error_detail TEXT NULL AFTER status");
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_data_releases (
    release_id CHAR(36) PRIMARY KEY, market_code VARCHAR(64) NOT NULL, system_id VARCHAR(64) NULL, dataset_id VARCHAR(64) NULL, source_agent_id VARCHAR(128) NOT NULL,
    object_key VARCHAR(512) NOT NULL DEFAULT '', sha256 CHAR(64) NOT NULL DEFAULT '', size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'pending', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    uploaded_at DATETIME NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_release_market (market_code), KEY idx_release_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [releaseColumns] = await pool.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fcs_data_releases'");
  const releaseColumnNames = new Set(releaseColumns.map((column) => column.COLUMN_NAME));
  if (!releaseColumnNames.has('system_id')) await pool.query('ALTER TABLE fcs_data_releases ADD COLUMN system_id VARCHAR(64) NULL AFTER market_code');
  if (!releaseColumnNames.has('dataset_id')) await pool.query('ALTER TABLE fcs_data_releases ADD COLUMN dataset_id VARCHAR(64) NULL AFTER system_id');
  await pool.query(`CREATE TABLE IF NOT EXISTS fcs_data_tasks (
    task_id CHAR(36) PRIMARY KEY, release_id CHAR(36) NOT NULL, agent_id VARCHAR(128) NOT NULL,
    action VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'pending', detail TEXT NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 3,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME NULL,
    KEY idx_data_task_agent (agent_id,status), CONSTRAINT fk_data_task_release FOREIGN KEY (release_id) REFERENCES fcs_data_releases(release_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [dataTaskColumns] = await pool.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fcs_data_tasks'");
  const dataTaskColumnNames = new Set(dataTaskColumns.map((column) => column.COLUMN_NAME));
  if (!dataTaskColumnNames.has('attempt_count')) await pool.query("ALTER TABLE fcs_data_tasks ADD COLUMN attempt_count INT NOT NULL DEFAULT 0 AFTER detail");
  if (!dataTaskColumnNames.has('max_attempts')) await pool.query("ALTER TABLE fcs_data_tasks ADD COLUMN max_attempts INT NOT NULL DEFAULT 3 AFTER attempt_count");
  await seedGenericDataModel();
  return pool;
}

function db() { if (!pool) throw new Error('MySQL 尚未初始化'); return pool; }

async function listZones() {
  const [rows] = await db().query('SELECT id,name,network_segment AS networkSegment FROM fcs_zones ORDER BY id');
  return rows;
}
async function listMarkets() {
  const [rows] = await db().query('SELECT code,name,data_dir AS dataDir,file_pattern AS filePattern,enabled,inspect_times AS inspectTimes FROM fcs_markets ORDER BY code');
  return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
}
async function syncZonesAndMarkets(zones, markets) {
  const conn = await db().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM fcs_zones');
    for (const z of zones || []) await conn.execute('INSERT INTO fcs_zones (id,name,network_segment) VALUES (?,?,?)', [String(z.id), String(z.name || z.id), String(z.networkSegment || '')]);
    await conn.query('DELETE FROM fcs_markets');
    for (const m of markets || []) await conn.execute('INSERT INTO fcs_markets (code,name,data_dir,file_pattern,enabled,inspect_times) VALUES (?,?,?,?,?,?)', [String(m.code), String(m.name || m.code), String(m.dataDir || ''), String(m.filePattern || '*.NIG'), m.enabled === false ? 0 : 1, String(m.inspectTimes || '')]);
    await conn.commit();
    // 兼容入口：市场设置发生变更后，同步维护“行情系统”下的数据集映射。
    await seedGenericDataModel();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}
async function seedZonesAndMarkets(config) {
  const [z] = await db().query('SELECT COUNT(*) AS total FROM fcs_zones');
  const [m] = await db().query('SELECT COUNT(*) AS total FROM fcs_markets');
  if (!Number(z[0].total) && !Number(m[0].total)) await syncZonesAndMarkets(config.zones || [], config.markets || []);
}
async function fillMarketDirectories() {
  const [result] = await db().query("UPDATE fcs_markets SET data_dir=CONCAT('/home/MobileServer/DATA/', code, '/history/day'), file_pattern='*.NIG' WHERE data_dir='' OR data_dir IS NULL");
  return result.affectedRows;
}

function normalizeSystem(row) { return { ...row, enabled: !!row.enabled }; }
function parseFixedTimes(value) { return String(value || '').split(/[,，\s]+/).map((item) => item.trim()).filter((item) => /^([01]\d|2[0-3]):[0-5]\d$/.test(item)); }
function normalizeDataset(row) { return { ...row, recursive: !!row.is_recursive, followSymlinks: !!row.follow_symlinks, syncEnabled: !!row.sync_enabled, enabled: !!row.enabled, sourceDir: row.source_dir, targetDir: row.target_dir, filePatterns: row.file_patterns, excludePatterns: row.exclude_patterns }; }
async function seedGenericDataModel() {
  const conn = db();
  await conn.execute("INSERT INTO fcs_business_systems (system_id,system_code,system_name,description,owner,enabled) VALUES ('quote','quote','行情系统','由现有市场配置自动迁移的行情文件数据集','',1) ON DUPLICATE KEY UPDATE system_name=VALUES(system_name)");
  await conn.query(`INSERT INTO fcs_datasets (dataset_id,system_id,dataset_code,dataset_name,source_dir,target_dir,file_patterns,sync_enabled,enabled)
    SELECT CONCAT('quote-',code),'quote',code,name,data_dir,data_dir,file_pattern,1,enabled FROM fcs_markets
    ON DUPLICATE KEY UPDATE dataset_name=VALUES(dataset_name),source_dir=VALUES(source_dir),target_dir=VALUES(target_dir),file_patterns=VALUES(file_patterns),enabled=VALUES(enabled)`);
}
async function listBusinessSystems() {
  const [rows] = await db().query(`SELECT s.system_id,s.system_code,s.system_name,s.description,s.owner,s.enabled,s.created_at,s.updated_at,
    (SELECT COUNT(*) FROM fcs_datasets d WHERE d.system_id=s.system_id) AS dataset_count,
    (SELECT COUNT(*) FROM fcs_business_system_agents a WHERE a.system_id=s.system_id AND a.enabled=1) AS agent_count
    FROM fcs_business_systems s ORDER BY s.system_code`);
  return rows.map((row) => ({ ...normalizeSystem(row), agent_count: Number(row.agent_count || 0) }));
}
async function listBusinessSystemAgents(systemId) { const [rows] = await db().execute('SELECT system_id,agent_id,enabled FROM fcs_business_system_agents WHERE system_id=? ORDER BY agent_id', [String(systemId)]); return rows.map((row) => ({ systemId: row.system_id, agentId: row.agent_id, enabled: !!row.enabled })); }
async function saveBusinessSystemAgents(systemId, items = []) { const conn = await db().getConnection(); try { await conn.beginTransaction(); await conn.execute('DELETE FROM fcs_business_system_agents WHERE system_id=?', [String(systemId)]); for (const item of items) { const agentId = String(item.agentId || item.agent_id || '').trim(); if (agentId) await conn.execute('INSERT INTO fcs_business_system_agents (system_id,agent_id,enabled) VALUES (?,?,?)', [String(systemId), agentId, item.enabled === false ? 0 : 1]); } await conn.commit(); } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); } }
async function saveBusinessSystem(item) {
  const id = String(item.systemId || item.system_id || '').trim(); const code = String(item.systemCode || item.system_code || '').trim(); const name = String(item.systemName || item.system_name || '').trim();
  if (!id || !/^[a-z][a-z0-9_-]{0,63}$/i.test(id) || !/^[a-z][a-z0-9_-]{0,63}$/i.test(code) || !name) throw new Error('业务系统标识、代码或名称不合法');
  await db().execute(`INSERT INTO fcs_business_systems (system_id,system_code,system_name,description,owner,enabled) VALUES (?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE system_code=VALUES(system_code),system_name=VALUES(system_name),description=VALUES(description),owner=VALUES(owner),enabled=VALUES(enabled)`, [id, code, name, String(item.description || ''), String(item.owner || ''), item.enabled === false ? 0 : 1]);
}
async function deleteBusinessSystem(systemId) {
  const [rows] = await db().execute('SELECT COUNT(*) AS total FROM fcs_datasets WHERE system_id=?', [systemId]);
  if (Number(rows[0].total)) throw new Error('业务系统下存在数据集，不能删除');
  await db().execute('DELETE FROM fcs_business_systems WHERE system_id=?', [systemId]);
}
async function listDatasets(systemId = '') {
  const params = []; let where = '';
  if (systemId) { where = ' WHERE d.system_id=?'; params.push(systemId); }
  const [rows] = await db().execute(`SELECT d.*,s.system_code,s.system_name,
    (SELECT COUNT(*) FROM fcs_dataset_bindings b WHERE b.dataset_id=d.dataset_id AND b.enabled=1) AS binding_count,
    (SELECT MAX(t.created_at) FROM fcs_inspection_tasks t WHERE t.dataset_id=d.dataset_id AND t.trigger_type='scheduled') AS last_scheduled_at,
    (SELECT t.status FROM fcs_inspection_tasks t WHERE t.dataset_id=d.dataset_id AND t.trigger_type='scheduled' ORDER BY t.created_at DESC LIMIT 1) AS last_scheduled_status
    FROM fcs_datasets d JOIN fcs_business_systems s ON s.system_id=d.system_id${where} ORDER BY s.system_code,d.dataset_code`, params);
  return rows.map((row) => ({ ...normalizeDataset(row), systemCode: row.system_code, systemName: row.system_name, bindingCount: Number(row.binding_count || 0) }));
}
async function getDataset(datasetId) { const rows = await listDatasets(); return rows.find((row) => row.dataset_id === datasetId) || null; }
async function saveDataset(item) {
  const id = String(item.datasetId || item.dataset_id || '').trim(); const systemId = String(item.systemId || item.system_id || '').trim(); const code = String(item.datasetCode || item.dataset_code || '').trim(); const name = String(item.datasetName || item.dataset_name || '').trim();
  if (!id || !systemId || !/^[a-z][a-z0-9_-]{0,63}$/i.test(id) || !/^[a-z][a-z0-9_$.-]{0,63}$/i.test(code) || !name) throw new Error('数据集标识、代码、所属业务系统或名称不合法');
  await db().execute(`INSERT INTO fcs_datasets (dataset_id,system_id,dataset_code,dataset_name,source_dir,target_dir,file_patterns,exclude_patterns,is_recursive,follow_symlinks,sync_enabled,enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE system_id=VALUES(system_id),dataset_code=VALUES(dataset_code),dataset_name=VALUES(dataset_name),source_dir=VALUES(source_dir),target_dir=VALUES(target_dir),file_patterns=VALUES(file_patterns),exclude_patterns=VALUES(exclude_patterns),is_recursive=VALUES(is_recursive),follow_symlinks=VALUES(follow_symlinks),sync_enabled=VALUES(sync_enabled),enabled=VALUES(enabled)`, [id, systemId, code, name, String(item.sourceDir || item.source_dir || ''), String(item.targetDir || item.target_dir || ''), String(item.filePatterns || item.file_patterns || '*'), String(item.excludePatterns || item.exclude_patterns || ''), item.recursive === false ? 0 : 1, item.followSymlinks === true ? 1 : 0, item.syncEnabled === false ? 0 : 1, item.enabled === false ? 0 : 1]);
}
async function deleteDataset(datasetId) { await db().execute('DELETE FROM fcs_datasets WHERE dataset_id=?', [datasetId]); }
async function listDatasetBindings(datasetId) { const [rows] = await db().execute('SELECT dataset_id,agent_id,source_dir_override,target_dir_override,source_enabled,target_enabled,enabled FROM fcs_dataset_bindings WHERE dataset_id=? ORDER BY agent_id', [datasetId]); return rows.map((row) => ({ datasetId: row.dataset_id, agentId: row.agent_id, sourceDirOverride: row.source_dir_override, targetDirOverride: row.target_dir_override, sourceEnabled: !!row.source_enabled, targetEnabled: !!row.target_enabled, enabled: !!row.enabled })); }
async function saveDatasetBindings(datasetId, bindings) { const conn = await db().getConnection(); try { await conn.beginTransaction(); await conn.execute('DELETE FROM fcs_dataset_bindings WHERE dataset_id=?', [datasetId]); const [systems] = await conn.execute('SELECT system_id FROM fcs_datasets WHERE dataset_id=?', [datasetId]); const systemId = systems[0]?.system_id; for (const item of bindings || []) { const agentId = String(item.agentId || '').trim(); if (!agentId) continue; await conn.execute('INSERT INTO fcs_dataset_bindings (dataset_id,agent_id,source_dir_override,target_dir_override,source_enabled,target_enabled,enabled) VALUES (?,?,?,?,?,?,?)', [datasetId, agentId, String(item.sourceDirOverride || ''), String(item.targetDirOverride || ''), item.sourceEnabled === false ? 0 : 1, item.targetEnabled === false ? 0 : 1, item.enabled === false ? 0 : 1]); if (systemId) await conn.execute('INSERT INTO fcs_business_system_agents (system_id,agent_id,enabled) VALUES (?,?,1) ON DUPLICATE KEY UPDATE enabled=1', [systemId, agentId]); } await conn.commit(); } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); } }
async function listAgentTags(agentId) { const [rows] = await db().execute('SELECT tag_key,tag_value FROM fcs_agent_tags WHERE agent_id=? ORDER BY tag_key', [agentId]); return rows.map((row) => ({ key: row.tag_key, value: row.tag_value })); }
async function saveAgentTags(agentId, tags) { const conn = await db().getConnection(); try { await conn.beginTransaction(); await conn.execute('DELETE FROM fcs_agent_tags WHERE agent_id=?', [agentId]); for (const tag of tags || []) { const key = String(tag.key || '').trim(); const value = String(tag.value || '').trim(); if (key && value) await conn.execute('INSERT INTO fcs_agent_tags (agent_id,tag_key,tag_value) VALUES (?,?,?)', [agentId, key, value]); } await conn.commit(); } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); } }
async function listAgentTagPartitions() { const [rows] = await db().query(`SELECT p.*, (SELECT COUNT(*) FROM fcs_agent_tags t WHERE t.tag_key=p.tag_key AND t.tag_value=p.tag_value) AS agent_count FROM fcs_agent_tag_partitions p ORDER BY p.partition_id`); return rows.map((row) => ({ partitionId: row.partition_id, partitionName: row.partition_name, tagKey: row.tag_key, tagValue: row.tag_value, description: row.description, enabled: !!row.enabled, agentCount: Number(row.agent_count || 0) })); }
async function saveAgentTagPartition(item) { const id = String(item.partitionId || '').trim(); const name = String(item.partitionName || '').trim(); const key = String(item.tagKey || '').trim(); const value = String(item.tagValue || '').trim(); if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(id) || !name || !key || !value) throw new Error('标签分区标识、名称和标签条件不能为空'); await db().execute('INSERT INTO fcs_agent_tag_partitions (partition_id,partition_name,tag_key,tag_value,description,enabled) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE partition_name=VALUES(partition_name),tag_key=VALUES(tag_key),tag_value=VALUES(tag_value),description=VALUES(description),enabled=VALUES(enabled)', [id,name,key,value,String(item.description || ''),item.enabled === false ? 0 : 1]); }
async function deleteAgentTagPartition(id) { await db().execute('DELETE FROM fcs_agent_tag_partitions WHERE partition_id=?', [String(id)]); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
}
function verifyPassword(password, storedHash) {
  const stored = String(storedHash || '');
  if (/^[a-f0-9]{64}$/i.test(stored)) {
    const legacy = crypto.createHash('sha256').update(String(password || '')).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(legacy, 'hex'), Buffer.from(stored, 'hex'));
  }
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[a-f0-9]+$/i.test(parts[1]) || !/^[a-f0-9]{128}$/i.test(parts[2])) return false;
  const actual = crypto.scryptSync(String(password || ''), parts[1], 64);
  const expected = Buffer.from(parts[2], 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
async function authenticateUser(username, password) {
  const name = String(username || '').trim();
  const [rows] = await db().execute("SELECT username,display_name,mfa_enabled,password_hash FROM fcs_users WHERE username=? AND enabled=1 AND auth_source='local' LIMIT 1", [name]);
  const row = rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  if (/^[a-f0-9]{64}$/i.test(String(row.password_hash || ''))) await db().execute('UPDATE fcs_users SET password_hash=? WHERE username=?', [hashPassword(password), name]);
  delete row.password_hash;
  return row;
}
function mfaEncryptionKey() { const cfg = connectionOptions(); return crypto.createHash('sha256').update(`fcs-mfa-v1\0${cfg.database}\0${cfg.password || ''}`).digest(); }
function encryptMfaSecret(secret) { const value = String(secret || ''); if (!value) return ''; const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', mfaEncryptionKey(), iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`; }
function decryptMfaSecret(secret) { const value = String(secret || ''); if (!value.startsWith('enc:v1:')) return value; try { const [, , ivHex, tagHex, dataHex] = value.split(':'); const decipher = crypto.createDecipheriv('aes-256-gcm', mfaEncryptionKey(), Buffer.from(ivHex, 'hex')); decipher.setAuthTag(Buffer.from(tagHex, 'hex')); return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8'); } catch (_) { return ''; } }
async function getUserSecurity(username) { const [rows] = await db().execute('SELECT username,display_name,enabled,auth_source,mfa_enabled,mfa_secret FROM fcs_users WHERE username=? LIMIT 1', [String(username || '').trim()]); if (rows[0]) rows[0].mfa_secret = decryptMfaSecret(rows[0].mfa_secret); return rows[0] || null; }
async function setUserMfa(username, enabled, secret = '') { await db().execute('UPDATE fcs_users SET mfa_enabled=?,mfa_secret=? WHERE username=?', [enabled ? 1 : 0, enabled ? encryptMfaSecret(String(secret || '').toUpperCase()) : '', String(username)]); }
async function createSession(sessionId, username, expiresAt, ip = '', userAgent = '') { await db().execute('INSERT INTO fcs_sessions (session_id,username,expires_at,ip_address,user_agent) VALUES (?,?,?,?,?)', [sessionId, username, expiresAt, ip, userAgent]); }
async function deleteSession(sessionId) { await db().execute('DELETE FROM fcs_sessions WHERE session_id=?', [sessionId]); }
async function getSession(sessionId) { const [rows] = await db().execute('SELECT s.session_id,s.username,s.expires_at,u.display_name,u.enabled FROM fcs_sessions s JOIN fcs_users u ON u.username=s.username WHERE s.session_id=? AND s.expires_at>NOW() AND u.enabled=1 LIMIT 1', [String(sessionId || '')]); return rows[0] || null; }
async function cleanupExpiredSessions() { const [result] = await db().query('DELETE FROM fcs_sessions WHERE expires_at<=NOW()'); return result.affectedRows; }
async function upsertLdapUser(username, displayName, externalId) {
  const name = String(username || '').trim();
  const [rows] = await db().execute('SELECT username,display_name,enabled FROM fcs_users WHERE username=? LIMIT 1', [name]);
  if (rows[0] && !rows[0].enabled) return null;
  await db().execute("INSERT INTO fcs_users (username,password_hash,display_name,enabled,auth_source,external_id) VALUES (?,NULL,?,1,'ldap',?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),auth_source='ldap',external_id=VALUES(external_id)", [name, String(displayName || name), String(externalId || '')]);
  await db().execute("INSERT IGNORE INTO fcs_user_roles (username,role_id) VALUES (?,'readonly')", [name]);
  return { username: name, display_name: String(displayName || name), auth_source: 'ldap' };
}
async function listUsers() { const [rows] = await db().query("SELECT u.username,u.display_name,u.enabled,u.auth_source,u.created_at,u.updated_at,COALESCE(GROUP_CONCAT(ur.role_id ORDER BY ur.role_id SEPARATOR ','),'') AS roles FROM fcs_users u LEFT JOIN fcs_user_roles ur ON ur.username=u.username GROUP BY u.username,u.display_name,u.enabled,u.auth_source,u.created_at,u.updated_at ORDER BY u.username"); return rows.map((r) => ({ ...r, enabled: !!r.enabled, auth_source: r.auth_source || 'local', roles: r.roles ? String(r.roles).split(',') : [] })); }
async function saveUser(username, password, displayName, enabled = true) {
  const name = String(username || '').trim(); if (!name) throw new Error('用户名不能为空');
  if (password) await db().execute('INSERT INTO fcs_users (username,password_hash,display_name,enabled) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),display_name=VALUES(display_name),enabled=VALUES(enabled)', [name, hashPassword(password), String(displayName || name), enabled ? 1 : 0]);
  else {
    const [existing] = await db().execute('SELECT username FROM fcs_users WHERE username=?', [name]);
    if (!existing.length) throw new Error('新增用户必须设置密码');
    await db().execute('UPDATE fcs_users SET display_name=?,enabled=? WHERE username=?', [String(displayName || name), enabled ? 1 : 0, name]);
  }
}
async function deleteUser(username) { if (String(username) === 'admin') throw new Error('不能删除 admin 用户'); await db().execute('DELETE FROM fcs_users WHERE username=?', [username]); }
async function recordAudit(username, action, resource = '', detail = {}, ip = '') { await db().execute('INSERT INTO fcs_audit_logs (username,action,resource,detail,ip_address) VALUES (?,?,?,?,?)', [String(username || ''), String(action), String(resource || ''), JSON.stringify(detail || {}), String(ip || '')]); }
async function listRoles() { const [rows] = await db().query('SELECT role_id,role_name,description,created_at FROM fcs_roles ORDER BY role_id'); return rows; }
async function saveRole(roleId, roleName, description = '') { await db().execute('INSERT INTO fcs_roles (role_id,role_name,description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE role_name=VALUES(role_name),description=VALUES(description)', [String(roleId), String(roleName), String(description)]); }
async function deleteRole(roleId) { if (['admin', 'manager', 'readonly'].includes(String(roleId))) throw new Error('内置角色不能删除'); await db().execute('DELETE FROM fcs_roles WHERE role_id=?', [String(roleId)]); }
async function listPermissions() { const [rows] = await db().query('SELECT permission_id,permission_name,description FROM fcs_permissions ORDER BY permission_id'); return rows; }
async function getRolePermissions(roleId) { const [rows] = await db().execute('SELECT p.permission_id,p.permission_name,p.description FROM fcs_role_permissions rp JOIN fcs_permissions p ON p.permission_id=rp.permission_id WHERE rp.role_id=? ORDER BY p.permission_id', [String(roleId)]); return rows; }
async function setRolePermissions(roleId, permissionIds = []) { if (String(roleId) === 'admin') throw new Error('admin 为内置角色，不能修改权限'); const conn = await db().getConnection(); try { await conn.beginTransaction(); await conn.execute('DELETE FROM fcs_role_permissions WHERE role_id=?', [String(roleId)]); for (const permissionId of permissionIds) await conn.execute('INSERT IGNORE INTO fcs_role_permissions (role_id,permission_id) VALUES (?,?)', [String(roleId), String(permissionId)]); await conn.commit(); } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); } }
async function assignUserRoles(username, roleIds = []) { await db().execute('DELETE FROM fcs_user_roles WHERE username=?', [String(username)]); for (const roleId of roleIds) await db().execute('INSERT IGNORE INTO fcs_user_roles (username,role_id) VALUES (?,?)', [String(username), String(roleId)]); }
async function getUserRoles(username) { const [rows] = await db().execute('SELECT role_id FROM fcs_user_roles WHERE username=? ORDER BY role_id', [String(username)]); return rows.map((r) => r.role_id); }
async function hasPermission(username, permissionId) { const [rows] = await db().execute('SELECT 1 FROM fcs_user_roles ur JOIN fcs_role_permissions rp ON rp.role_id=ur.role_id WHERE ur.username=? AND rp.permission_id=? LIMIT 1', [String(username), String(permissionId)]); return !!rows.length; }
async function getUserPermissions(username) { const [rows] = await db().execute('SELECT DISTINCT rp.permission_id FROM fcs_user_roles ur JOIN fcs_role_permissions rp ON rp.role_id=ur.role_id WHERE ur.username=? ORDER BY rp.permission_id', [String(username)]); return rows.map((row) => row.permission_id); }
async function listAuditLogs(limit = 200) { const [rows] = await db().execute('SELECT id,username,action,resource,detail,ip_address,created_at FROM fcs_audit_logs ORDER BY id DESC LIMIT ?', [Math.min(1000, Math.max(1, Number(limit) || 200))]); return rows; }
async function createDataRelease(releaseId, market, agentId, objectKey, context = {}) { await db().execute('INSERT INTO fcs_data_releases (release_id,market_code,system_id,dataset_id,source_agent_id,object_key,status) VALUES (?,?,?,?,?,?,\'pending\')', [releaseId, market, context.systemId || null, context.datasetId || null, agentId, objectKey]); }
async function updateDataRelease(releaseId, values) { await db().execute('UPDATE fcs_data_releases SET status=?,sha256=?,size_bytes=?,uploaded_at=IF(?=\'uploaded\',NOW(),uploaded_at) WHERE release_id=?', [values.status, values.sha256 || '', Number(values.sizeBytes || 0), values.status, releaseId]); }
async function listDataReleases() { const [rows] = await db().query('SELECT release_id,market_code,system_id,dataset_id,source_agent_id,object_key,sha256,size_bytes,status,created_at,uploaded_at FROM fcs_data_releases ORDER BY created_at DESC'); return rows; }
async function listDataTasks(releaseId) { const [rows] = await db().execute('SELECT task_id,agent_id,action,status,detail,attempt_count,max_attempts,created_at,completed_at FROM fcs_data_tasks WHERE release_id=? ORDER BY created_at', [releaseId]); return rows; }
async function createDataTask(taskId, releaseId, agentId, action, detail = {}) { await db().execute('INSERT INTO fcs_data_tasks (task_id,release_id,agent_id,action,detail) VALUES (?,?,?,?,?)', [taskId, releaseId, agentId, action, JSON.stringify(detail)]); }
async function nextDataTask(agentId) { const [rows] = await db().execute("SELECT t.*,r.market_code,r.object_key,r.sha256,r.size_bytes FROM fcs_data_tasks t JOIN fcs_data_releases r ON r.release_id=t.release_id WHERE t.agent_id=? AND t.status='pending' ORDER BY t.created_at LIMIT 1", [agentId]); return rows[0] || null; }
async function setDataTask(taskId, status, detail = '') { const storedDetail = typeof detail === 'string' ? detail : JSON.stringify(detail || {}); await db().execute("UPDATE fcs_data_tasks SET status=?,detail=?,completed_at=IF(? IN ('completed','failed'),NOW(),completed_at) WHERE task_id=?", [status, storedDetail, status, taskId]); }
async function retryDataTask(taskId) { const [rows] = await db().execute('SELECT release_id,status,attempt_count,max_attempts FROM fcs_data_tasks WHERE task_id=? LIMIT 1', [taskId]); const row = rows[0]; if (!row) throw new Error('数据任务不存在'); if (row.status !== 'failed') throw new Error('只有失败任务可以重试'); if (Number(row.attempt_count || 0) >= Number(row.max_attempts || 3)) throw new Error('已达到最大重试次数'); await db().execute("UPDATE fcs_data_tasks SET status='pending',detail=?,attempt_count=attempt_count+1,completed_at=NULL WHERE task_id=?", ['等待重试', taskId]); await db().execute("UPDATE fcs_data_releases SET status='uploaded' WHERE release_id=? AND status='failed'", [row.release_id]); return { releaseId: row.release_id, attempt: Number(row.attempt_count || 0) + 1 }; }
async function cancelDataTask(taskId) { const [rows] = await db().execute('SELECT release_id,status FROM fcs_data_tasks WHERE task_id=? LIMIT 1', [taskId]); const row = rows[0]; if (!row) throw new Error('数据任务不存在'); if (['completed','failed','cancelled'].includes(row.status)) throw new Error('任务已经结束'); await db().execute("UPDATE fcs_data_tasks SET status='cancelled',detail='用户取消任务',completed_at=NOW() WHERE task_id=?", [taskId]); return { releaseId: row.release_id }; }
async function getSystemSettings() {
  const [rows] = await db().query('SELECT setting_key,setting_value FROM fcs_system_settings');
  const result = {};
  for (const row of rows) { try { result[row.setting_key] = typeof row.setting_value === 'string' ? JSON.parse(row.setting_value) : row.setting_value; } catch (_) {} }
  return result;
}
async function seedSystemSettings(config) {
  const [rows] = await db().query('SELECT COUNT(*) AS total FROM fcs_system_settings');
  if (Number(rows[0].total)) return;
  for (const key of ['settings', 'objectStorage', 'ldap', 'dingTalk']) if (config[key] !== undefined) await db().execute('INSERT INTO fcs_system_settings (setting_key,setting_value) VALUES (?,?)', [key, JSON.stringify(config[key])]);
}
async function saveSystemSettings(values) {
  for (const [key, value] of Object.entries(values || {})) await db().execute('INSERT INTO fcs_system_settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)', [key, JSON.stringify(value)]);
}
async function listInspectionPlans() {
  const [rows] = await db().query(`SELECT p.plan_id,p.name,p.description,p.dataset_id,p.scope_json,p.enabled,p.created_by,p.created_at,p.updated_at,
    (SELECT MAX(t.completed_at) FROM fcs_inspection_tasks t WHERE JSON_UNQUOTE(JSON_EXTRACT(t.scope_json,'$.planId'))=p.plan_id AND t.trigger_type='scheduled') AS last_scheduled_at,
    (SELECT t.status FROM fcs_inspection_tasks t WHERE JSON_UNQUOTE(JSON_EXTRACT(t.scope_json,'$.planId'))=p.plan_id AND t.trigger_type='scheduled' ORDER BY t.created_at DESC LIMIT 1) AS last_scheduled_status
    FROM fcs_inspection_plans p ORDER BY p.updated_at DESC`);
  return rows.map((row) => { let scope = {}; try { scope = typeof row.scope_json === 'string' ? JSON.parse(row.scope_json) : (row.scope_json || {}); } catch (_) {} return { ...row, enabled: !!row.enabled, scope }; });
}
async function saveInspectionPlan(item) {
  const id = String(item.planId || item.plan_id || crypto.randomUUID()).trim();
  const name = String(item.name || '').trim(); const datasetId = String(item.datasetId || item.dataset_id || '').trim();
  if (!name || name.length > 128 || !datasetId) throw new Error('巡检方案名称和数据集不能为空');
  const scope = item.scope && typeof item.scope === 'object' ? item.scope : {};
  await db().execute(`INSERT INTO fcs_inspection_plans (plan_id,name,description,dataset_id,scope_json,enabled,created_by) VALUES (?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description),dataset_id=VALUES(dataset_id),scope_json=VALUES(scope_json),enabled=VALUES(enabled)`, [id, name, String(item.description || ''), datasetId, JSON.stringify(scope), item.enabled === false ? 0 : 1, String(item.createdBy || item.created_by || '')]);
  return id;
}
async function deleteInspectionPlan(planId) { await db().execute('DELETE FROM fcs_inspection_plans WHERE plan_id=?', [String(planId)]); }
async function listInspectionSchedules() { const [rows] = await db().query('SELECT schedule_id,plan_id,schedule_times,enabled,created_by,created_at,updated_at FROM fcs_inspection_schedules ORDER BY updated_at DESC'); return rows.map((row) => ({ ...row, enabled: !!row.enabled })); }
async function saveInspectionSchedule(item) { const id = String(item.scheduleId || item.schedule_id || crypto.randomUUID()).trim(); const planId = String(item.planId || item.plan_id || '').trim(); const times = String(item.scheduleTimes || item.schedule_times || '').trim(); if (!planId || !times) throw new Error('巡检方案和定时时间不能为空'); if (!parseFixedTimes(times).length) throw new Error('定时时间格式无效，请使用 HH:mm'); await db().execute(`INSERT INTO fcs_inspection_schedules (schedule_id,plan_id,schedule_times,enabled,created_by) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE plan_id=VALUES(plan_id),schedule_times=VALUES(schedule_times),enabled=VALUES(enabled)`, [id, planId, times, item.enabled === false ? 0 : 1, String(item.createdBy || item.created_by || '')]); return id; }
async function deleteInspectionSchedule(scheduleId) { await db().execute('DELETE FROM fcs_inspection_schedules WHERE schedule_id=?', [String(scheduleId)]); }
module.exports = { initDatabase, db, listZones, listMarkets, syncZonesAndMarkets, seedZonesAndMarkets, fillMarketDirectories, seedGenericDataModel, listBusinessSystems, listBusinessSystemAgents, saveBusinessSystemAgents, saveBusinessSystem, deleteBusinessSystem, listDatasets, getDataset, saveDataset, deleteDataset, listDatasetBindings, saveDatasetBindings, listAgentTags, saveAgentTags, listAgentTagPartitions, saveAgentTagPartition, deleteAgentTagPartition, authenticateUser, getUserSecurity, setUserMfa, createSession, deleteSession, getSession, cleanupExpiredSessions, upsertLdapUser, listUsers, saveUser, deleteUser, recordAudit, listRoles, saveRole, deleteRole, listPermissions, getRolePermissions, setRolePermissions, assignUserRoles, getUserRoles, hasPermission, getUserPermissions, listAuditLogs, listInspectionPlans, saveInspectionPlan, deleteInspectionPlan, listInspectionSchedules, saveInspectionSchedule, deleteInspectionSchedule, createDataRelease, updateDataRelease, listDataReleases, listDataTasks, createDataTask, nextDataTask, setDataTask, retryDataTask, cancelDataTask, getSystemSettings, seedSystemSettings, saveSystemSettings };
