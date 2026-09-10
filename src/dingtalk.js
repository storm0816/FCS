/**
 * 钉钉巡检结果通知模块
 * - 支持群机器人 Webhook + 加签（HMAC-SHA256）
 * - 从 history 取每个市场最新巡检记录，构造 Markdown 消息
 * - 异常代码 / 异常服务器用 <font color="#FF0000"> 标红
 */
const crypto = require('crypto');
const https = require('https');
const http = require('http');

/** 钉钉签名：timestamp + "\n" + secret 做 HMAC-SHA256 → base64 → URL encode */
function sign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(stringToSign);
  const signBytes = hmac.digest('base64');
  return encodeURIComponent(signBytes);
}

/**
 * 发送钉钉 Markdown 消息
 * @param {object} cfg { webhook, secret }
 * @param {string} title 消息标题
 * @param {string} markdownText Markdown 正文
 * @returns {Promise<{ok:boolean, detail?:string}>}
 */
function sendMarkdown(cfg, title, markdownText) {
  return new Promise((resolve) => {
    if (!cfg || !cfg.webhook) {
      resolve({ ok: false, detail: 'webhook 未配置' });
      return;
    }

    const ts = Date.now();
    let webhookUrl = cfg.webhook;
    if (cfg.secret) {
      webhookUrl += `&timestamp=${ts}&sign=${sign(cfg.secret, ts)}`;
    }

    const body = JSON.stringify({
      msgtype: 'markdown',
      markdown: { title, text: markdownText }
    });

    const parsed = new URL(webhookUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    };

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const resp = JSON.parse(buf);
          if (resp.errcode === 0) resolve({ ok: true });
          else resolve({ ok: false, detail: `钉钉返回错误: errcode=${resp.errcode}, errmsg=${resp.errmsg}` });
        } catch (e) {
          resolve({ ok: false, detail: `响应解析失败: ${buf.slice(0, 200)}` });
        }
      });
    });

    req.on('error', (e) => resolve({ ok: false, detail: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, detail: '请求超时' }); });
    req.write(body);
    req.end();
  });
}

/**
 * 构造钉钉 Markdown 巡检报告
 * @param {object} historyMod require('./history')
 * @param {object} configMod require('./config') 用于映射市场代码→中文名
 * @returns {{title: string, markdown: string, marketCount: number, anomalyCount: number}}
 */
function buildInspectionReport(historyMod, configMod) {
  const hist = historyMod.listHistory();
  const cfg = configMod.loadConfig();
  const marketNames = {};
  for (const m of (cfg.markets || [])) {
    marketNames[m.code] = m.name || m.code;
  }

  const marketCodes = Object.keys(hist.markets || {}).sort();
  if (!marketCodes.length) {
    return { title: '📊 行情巡检报告', markdown: '暂无巡检历史数据。', marketCount: 0, anomalyCount: 0 };
  }

  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const lines = [];
  lines.push(`### 📊 FCS 文件巡检报告`);
  lines.push('');
  lines.push(`> 发送时间：${now}`);
  lines.push('');

  let totalAnomalyMarkets = 0;

  // 钉钉 Markdown 表格列宽不可控，改用紧凑行格式保证横向显示
  for (const code of marketCodes) {
    const runs = hist.markets[code];
    if (!runs || !runs.length) continue;
    const latest = runs[0];
    const s = latest;
    const hasAnomaly = s.anomalies > 0;
    if (hasAnomaly) totalAnomalyMarkets++;

    const d = new Date(latest.savedAt);
    const timeStr = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const serverCount = s.groupTotalServers ?? '-';
    const totalCodes = s.totalCodes ?? '-';
    const consistentCodes = s.consistentCodes ?? '-';
    const anomServers = hasAnomaly ? `<font color="#FF0000">${s.anomalousServers ?? 0}</font>` : '0';
    const anomCodes = hasAnomaly ? `<font color="#FF0000">${s.anomalies ?? 0}</font>` : '0';

    lines.push(`- **${code}** ${timeStr} · 服务器 ${serverCount} · 代码 ${totalCodes} · 正常 ${consistentCodes} · 异服 ${anomServers} · 异码 ${anomCodes}`);
  }

  lines.push('');
  const summaryLine = totalAnomalyMarkets > 0
    ? `**汇总**：共 ${marketCodes.length} 个市场，其中 <font color="#FF0000">${totalAnomalyMarkets}</font> 个市场存在异常`
    : `**汇总**：共 ${marketCodes.length} 个市场，全部正常 ✅`;
  lines.push(summaryLine);

  const title = totalAnomalyMarkets > 0
    ? `⚠️ 行情巡检报告（${totalAnomalyMarkets}/${marketCodes.length} 市场异常）`
    : `✅ 行情巡检报告（全部正常）`;

  let markdown = lines.join('\n');
  // 钉钉限制 body ≤ 20000 bytes（中文及全角字符占 3 字节），按字节兜底截断
  if (Buffer.byteLength(markdown, 'utf8') > 18000) {
    let cut = markdown.length;
    while (cut > 0 && Buffer.byteLength(markdown.slice(0, cut), 'utf8') > 18000) cut -= 200;
    markdown = markdown.slice(0, cut) + '\n\n...（消息过长已截断）';
  }

  return { title, markdown, marketCount: marketCodes.length, anomalyCount: totalAnomalyMarkets };
}

module.exports = { sendMarkdown, buildInspectionReport, sign };
