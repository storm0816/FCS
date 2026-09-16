# FCS Agent

Agent 是部署在行情服务器上的单文件 Go 程序，不依赖 Node.js、`b2sum` 或 `b2sum.sh`。

## 构建 Linux 二进制

```bash
cd agent
make linux-amd64
```

产物为 `dist/fcs-agent-linux-amd64`。将其复制到行情服务器的 `/opt/fcs-agent/fcs-agent`，再将 `config.example.json` 改名为 `agent.json` 并填写本机信息。

## 配置

```json
{
  "masterUrl": "http://10.15.45.156:3000",
  "zone": "",
  "innerIp": "",
  "outerIp": "",
  "heartbeatSeconds": 10
}
```

Agent ID 会由本机 MAC 地址和内网 IP 自动生成；内网 IP 留空时自动探测，多网卡或 NAT 环境可手工填写内外网 IP。

## systemd

将 `fcs-agent.service` 复制到 `/etc/systemd/system/` 后执行：

```bash
systemctl daemon-reload
systemctl enable --now fcs-agent
systemctl status fcs-agent
```

Agent 每 10 秒主动向 Master 心跳。Master 下发巡检任务后，Agent 根据 Master 中全部选中市场的“行情目录”和“文件匹配”扫描本机文件，按文件名排序并以 BLAKE2b-512 计算哈希后主动上报。
