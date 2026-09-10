const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function defaultConfig() {
  return {
    zones: [],
    markets: [],
    settings: {
      concurrency: 4
    },
    objectStorage: {
      enabled: false,
      endpoint: '',
      region: '',
      bucket: '',
      prefix: '',
      accessKey: '',
      secretKey: '',
      localDir: 'b2sumdata',
      autoSync: false,
      syncMode: 'interval',        // 'interval' | 'fixed' | 'both'
      syncIntervalMinutes: 5,
      syncFixedTimes: ''            // 如 "09:00,11:00,18:00"
      // 文件命名/格式/后缀为系统固定常量（见 src/objectStorage.js）：
      //   {ip}-{market}-NIG.b2sum / b2sum / .NIG，不在 config.json 中配置
    },
    dingTalk: {
      enabled: false,
      webhook: '',                  // 钉钉群机器人 Webhook（含 access_token）
      secret: '',                    // 钉钉加签密钥（选填，机器人安全设置中开启加签时填写）
      scheduleTimes: ''              // 定时发送时间点，如 "09:00,12:00,18:00"；空=不定时
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
    // 向后兼容：补充新增的 dingTalk 字段
    if (!cfg.dingTalk) {
      cfg.dingTalk = defaultConfig().dingTalk;
      saveConfig(cfg);
    }
    return cfg;
  } catch (e) {
    throw new Error('config.json 解析失败: ' + e.message);
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH, defaultConfig };
