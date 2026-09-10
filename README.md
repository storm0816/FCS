# FCS · File Check System

文件哈希一致性巡检平台。

当前发布版本：`v0.1.0`

对多台行情服务器上「同一市场、同一代码」的历史日 K 数据进行哈希一致性对比，
用**少数派判定**自动识别异常数据。

数据源从对象存储（火山引擎 TOS）拉取 b2sum 哈希文件到本地，再做跨机 diff 对比。

## 特性

- **对象存储数据源**：使用 `@volcengine/tos-sdk` 直接把 TOS bucket 中的 b2sum 文件拉到本地 `b2sumdata/` 目录，无需 SSH 登录服务器。
- **密钥配置在 config.json**：`objectStorage.accessKey` / `secretKey` 直接写入配置文件。
- **服务器自动发现**：从对象存储文件名 `{ip}-{market}-NIG.b2sum`（如 `10.61.1.56-ZO-NIG.b2sum`）自动解析出 IP（=服务器）与市场列表，无需在 config 中维护服务器。
- **分区分组**：通过 `serverZoneMap`（IP → zoneId）把服务器映射到分区，对比在同分区内进行。
- **diff 对比算法**：把同市场各 IP 的 `NIG.b2sum` 文件视为「(code,hash) 行集合」直接 diff，少数服从多数——少数派不同的行即异常，按「区域+IP+市场」展示详细不同的代码。参考机模式则以基准 IP 的文件做 diff。
- **本地采集复查**：每次巡检把哈希落盘到 `inspect_data/<runId>/`，支持 `compareOnly` 仅对比历史采集。

## 运行

```bash
npm install          # 安装 @volcengine/tos-sdk
npm start            # http://localhost:3000
```

运行环境：Node.js 16 或更高版本。首次运行前，请复制 `config.example.json` 为
`config.json`，再填写实际的 TOS 凭据；`config.json` 已被 Git 忽略，不会被提交。

## 配置（config.json）

- `zones[]`：分区列表（id、name、concurrency）。
- `markets[]`：市场列表（code、name、enabled）。
- `serverZoneMap`：IP → zoneId 映射，用于把自动发现的服务器（IP）归入分区。
- `settings`：concurrency（全局并发上限）、maxCodes（巡检代码数，0=全部）。
- `objectStorage`：
  - `enabled`：是否启用对象存储数据源
  - `region` / `endpoint` / `bucket` / `prefix`：TOS 连接信息
  - `accessKey` / `secretKey`：TOS 密钥（直接配置在此）
  - `localDir`：本地下载目录（默认 `b2sumdata`）
- 文件命名规则、文件格式、代码后缀为**系统固定常量**（见 `src/objectStorage.js`：`{ip}-{market}-NIG.b2sum` / b2sum / `.NIG`），无需也无法在界面或配置中修改。

## 使用流程

1. 在「对象存储配置」页填写 TOS 连接信息与密钥，保存。
2. 点击「测试连接 / 发现服务器」验证连通性并自动发现服务器。
3. 点击「☁️ 同步对象存储」把 b2sum 文件拉到本地 `b2sumdata/`。
4. 在「执行巡检」页选择分区、市场、对比算法，点击「开始巡检」。

## 文件命名约定

- 对象存储 key：`<prefix>/<ip>-<market>-NIG.b2sum`（如 `file/b2sumkline/10.61.1.56-ZO-NIG.b2sum`）
- 本地目录：`b2sumdata/<ip>-<market>-NIG.b2sum`
- 文件内容（b2sum 格式）：每行 `<hash><空格><code>.NIG`
- 对比维度：同 `<market>` 的所有 IP 文件做 diff，少数派不同的行即异常，展示「区域 + IP + 市场 + 不同代码」。

## API

- `GET  /api/config`            读取配置
- `PUT  /api/config`            保存配置
- `POST /api/inspect`           执行巡检
- `POST /api/sync-b2sum`        同步对象存储文件到本地
- `POST /api/servers/discover`  自动发现对象存储中的服务器
- `GET  /api/health`            健康检查

详见 [设计文档](design_doc.md) 和 [变更记录](CHANGELOG.md)。
