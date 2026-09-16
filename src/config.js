const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let runtimeConfig = null;

function defaultConfig() {
  return {
    mysql: { host: '', port: 3306, database: '', user: '', password: '', poolSize: 10, timeout: 5000 },
    redis: { host: '', port: 6379, password: '', db: 0, state: 'off' },
    zones: [],
    markets: [],
    settings: {
      concurrency: 4,
      retentionDays: 90
    },
    objectStorage: {
      enabled: false,
      endpoint: '',
      region: '',
      bucket: '',
      prefix: '',
      accessKey: '',
      secretKey: ''
    },
    dingTalk: {
      enabled: false,
      webhook: '',                  // 钉钉群机器人 Webhook（含 access_token）
      secret: '',                    // 钉钉加签密钥（选填，机器人安全设置中开启加签时填写）
      scheduleTimes: ''              // 定时发送时间点，如 "09:00,12:00,18:00"；空=不定时
    },
    ldap: {
      state: 'off',
      servers: [],
      bind_user: '',
      bind_password: '',
      search_base: '',
      user_attribute: 'sAMAccountName',
      bind_template: '%s',
      start_tls: 'off',
      tls_verify: 'on',
      timeout: 5000
    }
  };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const d = defaultConfig();
    saveConfig(d);
    return d;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return runtimeConfig ? { ...cfg, ...runtimeConfig } : cfg;
  } catch (e) {
    throw new Error('config.json 解析失败: ' + e.message);
  }
}

function setRuntimeConfig(cfg) { runtimeConfig = cfg ? { ...cfg } : null; }

function saveConfig(cfg) {
  const current = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  const persistent = { mysql: cfg.mysql || current.mysql || defaultConfig().mysql, redis: cfg.redis || current.redis || defaultConfig().redis };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(persistent, null, 2), 'utf8');
  return cfg;
}

module.exports = { loadConfig, saveConfig, setRuntimeConfig, CONFIG_PATH, defaultConfig };
