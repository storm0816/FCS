# FCS · File Check System

FCS 是面向运维场景的文件一致性巡检与同步平台，当前版本为 `v0.1.0`。它不局限于行情文件：通过业务系统、数据集、Agent 分组和标签，可用于任意目录的文件校验、差异发现和受控同步。

每台服务器部署一个独立的 Go Agent。Agent 主动心跳、按 Master 下发的任务扫描配置目录中的文件并计算 **BLAKE2b-512** 哈希，然后把结果上报给 Master。Master 负责对比、保存历史、告警和发布任务编排；实际文件包始终由 Agent 通过 `tosutil` 与 TOS 传输。

## 核心能力

- **数据集巡检**：一个数据集对应一个业务目录、文件规则和参与 Agent 范围；目录必须使用绝对路径。
- **灵活选机**：可按物理分区、Agent 标签、业务系统或手工选择 Agent；标签与业务系统互不从属，可组合使用。
- **两种对比算法**：多数派对比与指定参考 Agent 对比；支持分区内对比或跨分区合并对比。
- **巡检方案与定时巡检**：将业务、数据集、Agent 范围和对比设置保存为方案；定时任务只关联已启用方案。
- **差异自动同步**：仅在定时巡检发现差异时执行；只向异常 Agent 下发同步任务，且来源 Agent 本次存在差异时会自动阻止覆盖。
- **文件同步**：源 Agent 打包并上传 TOS；目标 Agent 下载、SHA-256 校验、解压到临时目录后原子替换，失败自动回滚，支持任务取消与断点续传。
- **运维管理**：仪表盘、巡检历史、发布/下载记录、Agent 在线状态、离线告警、钉钉通知、日志与数据保留策略。
- **安全与审计**：本地账号、LDAP 登录、MFA（TOTP）、角色权限（RBAC）、MySQL 会话和审计日志。

## 架构

```text
┌─────────────────────────────── 每台受管服务器 ───────────────────────────────┐
│  fcs-agent（Go，无需 Node.js）                                                │
│  心跳 → 获取任务 → 扫描目录 / 计算哈希 → 上报结果                            │
│  发布：打包 → tosutil 上传 TOS                                                │
│  下载：tosutil 下载 → SHA-256 校验 → 解压 → 原子替换 / 失败回滚              │
└───────────────────────┬─────────────────────────────┬────────────────────────┘
                        │ HTTP                          │ TOS
                        ▼                               ▼
┌────────────────────────────────── Master ──────────────────────────────────┐
│ Node.js：鉴权、任务编排、对比、定时任务、通知、Web 管理台                    │
│ MySQL：配置、Agent、任务、结果、方案、发布、账号、权限、审计                 │
└────────────────────────────────────────────────────────────────────────────┘
```

## 使用流程

1. 在「资源管理 → 业务系统」中维护业务归属，并关联可参与该业务的 Agent。
2. 在「资源管理 → 数据集管理」中配置目录、文件规则和可选的 Agent 目录覆盖。
3. 在「巡检 → 发起巡检」选择业务系统、数据集、Agent 范围与对比方式，执行后查看结果。
4. 需要反复使用时，保存为「巡检方案」；在「定时巡检」中选择方案和执行时间。
5. 需要自动修复时，在发起巡检页面开启“自动同步”并指定来源 Agent。该设置仅对**定时巡检**生效，且只同步本次存在差异的目标 Agent。
6. 临时同步可在「文件同步」页面创建发布任务，或从巡检结果中的差异记录跳转创建。

## 菜单说明

| 菜单 | 用途 |
|---|---|
| 仪表盘 | 汇总 Agent 状态、巡检趋势、异常数据集、发布任务与近期异常。 |
| 巡检 → 发起巡检 | 按步骤选择数据集、参与 Agent、对比设置和可选自动同步。 |
| 巡检 → 巡检方案 | 保存、编辑、执行和删除可复用的巡检配置。 |
| 巡检 → 定时巡检 | 为巡检方案设置每天的执行时间和启停状态。 |
| 巡检 → 巡检结果 / 巡检历史 | 查看最新结果、异常详情和历史任务。 |
| 巡检 → 文件同步 | 管理发布、上传、下载、进度、失败原因与取消任务。 |
| 资源管理 | 管理 Agent、业务系统、数据集、物理分区和 Agent 标签。 |
| 设置 | 管理巡检执行参数、TOS、LDAP、钉钉通知和用户权限。 |

## 目录结构

```text
.
├─ server.js                 # Master HTTP 服务与定时任务入口
├─ src/
│  ├─ config.js              # 本地 config.json（仅 MySQL / Redis 连接）
│  ├─ database.js            # MySQL 建表、迁移与数据访问
│  ├─ agentService.js        # Agent 心跳、巡检、同步任务编排
│  ├─ inspector.js           # 多数派 / 参考 Agent 对比引擎
│  ├─ dashboardService.js    # 仪表盘统计
│  └─ ldap.js / dingtalk.js / logger.js / objectStorage.js
├─ public/                   # 原生 HTML、JavaScript、CSS 管理台
├─ agent/                    # Go Agent 源码、构建脚本、systemd 示例
├─ fcs-agent/                # Agent 部署包（本地二进制与私有配置，不入 Git）
├─ scripts/                  # 语法检查和冒烟测试
├─ compose.yaml / Dockerfile # Docker 部署
└─ config.example.json       # 本地连接配置样例
```

### 运行数据目录

| 目录 | 内容 | 是否提交 Git |
|---|---|---|
| `inspect_data/` | Agent 上报的运行缓存、批次快照 | 否 |
| `b2sumdata/` | 兼容历史 b2sum 缓存，不作为当前 Agent 巡检数据源 | 否 |
| `log/` | 应用与访问日志 | 否 |
| `config.json` | MySQL、Redis 本地连接参数 | 否 |

这些目录由 Docker 挂载。保留周期由系统设置控制；不要在服务运行时手工清空。

## 数据与配置

- **MySQL** 是业务数据唯一来源：系统设置、用户、角色、权限、会话、审计、Agent、分区、标签、业务系统、数据集、巡检方案、定时任务、巡检结果、发布记录和数据任务均存于 MySQL。
- **`config.json`** 只保留 MySQL、Redis 连接信息。Redis 当前为预留配置，核心流程并不依赖 Redis。
- **系统设置** 中保存巡检并发、历史保留、TOS、LDAP 与钉钉配置。密钥在接口输出中脱敏；表单留空保存会保留原值。
- 首次启动会自动创建 `fcs_` 前缀的数据表和内置角色：`admin`、`manager`、`readonly`。

## 快速开始

### Docker 部署（推荐）

```bash
cp config.example.json config.json
# 编辑 config.json，填写可访问的 MySQL 连接参数
docker compose up -d --build
```

访问 `http://localhost:3000`。首次本地账号为 `admin / fcs`；首次登录后，请在「设置 → 用户与权限 → 管理员密码」修改密码（至少 12 位）。

常用命令：

```bash
docker compose ps
docker compose logs -f fcs
docker compose down
```

### 本地运行

```bash
npm ci
npm start
```

### 验证

```bash
npm run check
npm run test:smoke
cd agent && go test ./... && go vet ./...
```

## Agent 构建与部署

Agent 是单文件 Go 程序，生产服务器无需安装 Node.js 或额外的哈希脚本。

```bash
cd agent
make linux-amd64
```

将 `dist/fcs-agent-linux-amd64` 放置为服务器上的 `/opt/fcs-agent/fcs-agent`，再创建 `/opt/fcs-agent/agent.json`：

```json
{
  "masterUrl": "http://<master-ip>:3000",
  "zone": "",
  "innerIp": "",
  "outerIp": "",
  "heartbeatSeconds": 10
}
```

- Agent ID 会根据本机 MAC 地址和内网 IP 自动生成。
- `innerIp` 留空时自动探测；`outerIp` 留空时尝试通过 `api.ip.sb` 获取，失败不影响心跳和巡检。
- systemd 示例见 `agent/fcs-agent.service`，默认使用 `root` 运行，以保证能够访问并原子替换受管目录。

```bash
systemctl daemon-reload
systemctl enable --now fcs-agent
systemctl status fcs-agent
```

## 对比规则

| 项目 | 说明 |
|---|---|
| 多数派对比（默认） | 以同一范围内多数 Agent 的 `(文件名, 哈希)` 为基准，识别哈希不一致、无共识、缺失和多出文件。 |
| 参考 Agent 对比 | 以手工选择的参考 Agent 为基准，其他 Agent 与其逐项比较。 |
| 分区内对比 | 每个物理分区独立比较，避免跨机房数据差异造成误报。 |
| 跨分区对比 | 将选中分区合并为一个比较范围。 |

异常分为：`hash_mismatch`（哈希不一致）、`hash_conflict`（无多数共识）、`missing`（缺失）、`extra`（多出）与 `unreachable`（任务未上报或 Agent 不可达）。

## 文件同步规则

1. Master 创建发布记录，向来源 Agent 下发打包任务。
2. 来源 Agent 将数据集的完整目录树打包为 `tar.gz`，并用 `tosutil` 上传到 TOS。
3. 上传完成后，Master 才向目标 Agent 下发下载任务。
4. 目标 Agent 下载后校验 SHA-256，解压至临时目录，对原目录加锁并原子替换；失败时恢复备份目录。
5. 同步任务会记录大小、上传耗时、下载耗时、状态与错误信息；支持取消和大文件断点续传。

自动同步仅由定时巡检触发，不会覆盖所有 Agent；系统只选择本次对比确认存在差异的 Agent 作为目标。

## 主要接口

除健康检查、认证、Agent 心跳/上报/取任务外，其余接口均要求有效会话和对应角色权限。

- 认证：`/api/auth/login`、`/api/auth/logout`、`/api/auth/me`、`/api/auth/mfa/verify`
- 巡检：`/api/inspections`、`/api/inspection-plans`、`/api/inspection-schedules`、`/api/history`
- Agent：`/api/agent/heartbeat`、`/api/agent/report`、`/api/agent/tasks/{taskId}`、`/api/agents`
- 资源：`/api/business-systems`、`/api/datasets`、`/api/agent-tag-partitions`
- 同步：`/api/data/releases`、`/api/data/tasks/{taskId}/progress`、`/api/data/tasks/{taskId}/report`
- 管理：`/api/config`、`/api/users`、`/api/roles`、`/api/audit-logs`、`/api/dashboard/summary`

## 安全建议

- 请立即修改初始管理员密码，并为管理员启用 MFA。
- TOS、LDAP、钉钉密钥只应通过系统设置维护，不要提交到 Git 或写入前端代码。
- Agent 与 Master 默认使用 HTTP；生产环境应在反向代理层启用 TLS，并限制管理端口与 Agent 上报来源。
- 使用独立 MySQL 账号并按最小权限授权；定期备份 MySQL 的 `fcs_` 表。
