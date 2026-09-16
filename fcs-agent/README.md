# FCS Agent 部署包

部署时保留以下文件：

```text
fcs-agent/
├─ fcs-agent
└─ fcs-agent.json
```

Agent ID 会在启动时由本机 MAC 地址和内网 IP 自动生成，无需人工填写。

启动命令：

```bash
chmod +x fcs-agent
./fcs-agent --config ./fcs-agent.json
```
