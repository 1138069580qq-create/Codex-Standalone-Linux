# Codex Standalone Linux

独立的 Linux Codex 工作台：**独立账号、独立 WebUI、独立端口（默认 3210）**。无需 ElementsPanel、数据库、前端构建或开发服务器。

> 不是 OpenAI 官方应用。生产程序只附加到已有 Codex 的 Unix socket / WebSocket，不启动、复制或重启 Codex。共享桌面任务的前提是桌面实例确实暴露了兼容接口；不能把任意新开的 app-server 当成桌面共享实例。

## 主要功能

- 中文响应式工作台：项目、任务列表、文本流、可折叠命令、审批、文件、Diff 和共享账号额度。
- 独立 scrypt 密码登录；管理员 / 项目授权；HttpOnly + SameSite Cookie、CSRF token、来源校验、速率限制。
- 只使用 Codex 实际返回的模型与推理强度；执行 / 规划模式；按项目隔离任务，限制并发。
- 创建和继续任务、停止、附件、一次性审批、用户问题回答；同一请求 ID 防止重复发起模型任务。
- 发现已有接口；手动保存与连接；断开 WebUI 不终止已有 Codex。
- 读取真实额度窗口；10080 分钟才标记为周限额。管理员二次确认后消耗共享重置卡，并重新读额度。
- 文件上传不覆盖现有文件；凭据文件、目录穿越、符号链接和目录重叠保护。

## 带宽与内存设计

| 项目 | 行为 / 上限 |
|---|---|
| 前端依赖 | 原生 HTML / CSS / JS；无 CDN、字体下载、框架运行时、屏幕视频流 |
| 静态资源 | 启动时预压缩 Brotli / gzip，ETag / 304；非首页缓存 1 小时 |
| 动态 JSON | 大于等于 1 KiB 才 gzip；无共享缓存 |
| 实时输出 | SSE，约 100 ms 合并一次增量；浏览器约 80 ms 合并 DOM 更新 |
| 断线恢复 | 游标重放；窗口过期才重新读取快照；重连指数退避，不重发写入命令 |
| 后台标签页 | 隐藏 15 秒后暂停 SSE，返回后续传；不定时刷新文件 / Diff / 额度 |
| 事件保留 | 最多 2048 条 / 4 MiB（先达到者） |
| 文本快照 | 最多 200 项 / 512 KiB 字符；单项 64 KiB 字符 |
| 慢客户端 | 每条流 64 KiB 高水位，积压时断开，靠游标恢复 |
| 长连接 | 每用户最多 6 条、全局最多 100 条；20 秒心跳 / 权限重验；10 分钟换新流 |
| 文件 | 上传 4 MiB / 下载 8 MiB；目录最多 500 项；Diff 256 KiB |

快照的 KiB 字符界限按 JS UTF-16 长度计算，不等同于网络字节数；SSE 缓冲和资源体积按实际字节计算。

## 快速运行（Linux，Node.js 22.14+ / 24）

```bash
# 克隆本仓库到新的独立目录，不需要原项目源码。
git clone https://github.com/1138069580qq-create/Codex-Standalone-Linux.git
cd Codex-Standalone-Linux
npm ci --omit=dev --ignore-scripts

# 用读取隐藏输入的方式创建本应用管理员。不要把真实密码写进 shell 命令历史。
read -r -s -p 'WebUI admin password (12+ chars): ' PASSWORD; printf '\n'
printf '%s' "$PASSWORD" | npm run user:add -- --username admin --admin
unset PASSWORD

# 直接运行生产程序，不执行 build，不启动 dev server。
npm start
```

默认监听 `127.0.0.1:3210`。远程访问推荐 HTTPS 反向代理；临时访问可用 SSH 隧道：

```bash
ssh -N -L 3210:127.0.0.1:3210 linux-user@your-server
```

在本机访问 `http://127.0.0.1:3210`。登录后：

1. **设置 → 扫描已有接口**，选择已验证的 Codex Unix socket 或 WebSocket；也可直接填入已有地址。
2. 在设置里创建普通账号，复制账号 ID。
3. 添加项目 JSON（目录须已存在），按需设置 grants。完整例子见 `config.example.json`。
4. 保存配置，点击 **连接 Codex**。连接不是启动 Codex。
5. 选择项目 → 选择 / 新建任务；模型列表来自真实 Codex。

如果扫描没有结果，程序会保持未连接。它不会读取 `~/.codex/auth.json` 来绕过没有共享接口的问题，也不会自动运行 `codex app-server`。

## 配置

| 环境变量 | 默认 / 说明 |
|---|---|
| `CODEX_WEBUI_HOST` | `127.0.0.1` |
| `CODEX_WEBUI_PORT` | `3210`，避免与原面板端口冲突 |
| `CODEX_WEBUI_ORIGIN` | 本地监听 origin；反代必须设置如 `https://codex.example.com`，无末尾斜杠 / 路径 |
| `CODEX_WEBUI_DATA` | `~/.local/share/codex-webui`；保存 users / config / receipts，目录应只允许服务用户访问 |
| `CODEX_WEBUI_PASSWORD` | 仅 CLI 创建 / 修改账号时读取；建议用 stdin 代替环境变量 |

非回环监听必须显式设置 HTTPS origin。WebUI 自身不处理 TLS，必须部署对应的 HTTPS 反代，**不要把 HTTP 后端直接公开到互联网**。程序不信任任意 `X-Forwarded-*`；来源以配置为准。反代后的登录速率限制按直连反代地址聚合，Nginx 可再做客户端 IP 限流。

`users.json` / `config.json` / `receipts.json` 使用原子写入与 `0600` 文件权限，父目录 `0700`。会话保存在内存里：重启需要重新登录，最长 12 小时、30 分钟无请求失效。活动 SSE 的权限检查算活动。修改账号使旧会话立即失效。

通过网页修改账号实时生效；通过 CLI 修改运行中的账号数据库后，需重启 WebUI。当前版本通过调整账号角色和移除项目 grants 撤销项目访问，不提供网页删除账号功能。

## 授权与边界

- `view`：项目任务 / 输出。
- `send`：创建、发送、停止任务和回答问题。
- `approve`：允许 / 拒绝命令和文件审批。
- `files`：文件列表、上传、下载、Diff、附件。
- 后三项必须同时具有 `view`。管理员拥有全部配置与项目权限。
- 同一项目同一时间只允许一个任务写入；不同项目可在总并发限制内运行。建议独立 Git worktree。
- **这不是 OS 多租户沙箱。** 多个 WebUI 用户共用同一 Linux 用户、同一 Codex 身份及额度。不要向互不信任的人授予 `send` / `approve`，尤其不要批准越权命令。需要强隔离时使用独立 Linux 用户 / VM / 容器及独立 Codex。
- 其他客户端启动的任务状态会尽可能查询，但跨客户端的项目互斥并非原子分布式锁。
- 不提供密码找回、SSO、MFA 或公网注册；若需要公网使用，建议 VPN / 额外身份认证网关。

## 部署与测试

- `docs/DEPLOYMENT.zh-CN.md`：systemd 用户服务、Nginx、容器与升级流程。
- `docs/TEST-REPORT.zh-CN.md`：本次实际测试结果与未验证事项。
- `docs/PROTOCOL.md`：官方协议来源、适配范围。

```bash
npm ci --ignore-scripts
npm run check           # tsc --noEmit + JS 语法；不是 build
npm test                # 单元 / 回归 / HTTP 测试：部分使用协议测试桩

# 只读连接已有真实 Codex；不会启动进程、创建任务或调用模型
CODEX_EXISTING_ENDPOINT=/run/user/1000/codex/app-server.sock npm run test:live

# 显式允许测试专用的隔离 Codex 进程（不使用真实登录凭据、不调用模型）
CODEX_TEST_BINARY=/absolute/path/to/codex CODEX_TEST_ISOLATED=1 npm run test:real
```

测试保留临时目录以便审计，不递归删除。无对应环境变量的真实测试会跳过，不得把跳过当成通过。

## 目录与许可

`src/backend/` 是复制到独立仓库的 Apache-2.0 插件协议核心；`src/auth.ts`、`src/server.ts`、`src/routes.ts` 等是独立服务层；`public/` 是无需构建的全新界面。所有路径均在本仓库内，没有指向原项目的源码依赖。

本实现没有修改原 ElementsPanel 项目，也没有复用原项目的端口、账户数据库或发布目录。来源与变更说明见 `NOTICE`，许可证见 `LICENSE`。
