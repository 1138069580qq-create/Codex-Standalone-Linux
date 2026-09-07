# 本次交付测试报告

日期：2026-09-07。此报告描述实际观察结果，不沿用附件里旧插件的“已测试”声明。

## 实现与环境

- 独立源代码仓库；原 ElementsPanel 的已跟踪文件未修改，原有未提交 `standalone/` 草稿原样保留。
- Windows：Node.js 24.18.0，用于类型检查、HTTP 回归和真实浏览器界面验收。
- Linux：WSL Ubuntu、Node.js 22.22.1。
- 真实 Codex：**codex-cli 0.153.4**。这表示实际测试版本，不表示声称它是最新版本。
- 没有构建项目，也没有启动 dev 服务器。HTTP / 浏览器测试短暂启动的是本应用的生产入口或同一个 `createApp` 运行时。
- 没有调用子代理。

## 自动化检查

| 检查 | 实际结果 |
|---|---|
| `npm run check` | 通过；TypeScript `--noEmit` 与前端 JS 语法 |
| Windows 回归 | **47 项：44 通过、3 跳过、0 失败** |
| Linux 回归 | **47 项：46 通过、1 跳过、0 失败** |
| Linux 真实 Codex 集成 | **2 项通过，0 失败**：Unix socket / TCP WebSocket |
| `npm audit --omit=dev` | 本次执行时 **0 个已知漏洞**；不代表不存在未知漏洞 |

Linux 回归唯一跳过项是“连接操作员提供的既有 Codex 端点”；没有给出 `CODEX_EXISTING_ENDPOINT`。它没有被当成通过；另外的两项显式隔离进程测试则实际运行了真实 Codex。

回归覆盖：鉴权、CSRF、跨来源请求、用户角色 / 密码更新使会话失效、最后一个管理员保护、项目越权、目录穿越、凭据路径、符号链接、Diff 安全、并发任务、幂等回执、审批重复提交、WebSocket 超时 / 超大帧、Unicode 增量、重放去重、缓冲上限。

额外对生产前端函数验证了两个竞态：网络暂时失败后继续退避重连；文件读取过程中切换项目会在传输前取消上传，不误传到新项目。

## 真实 Codex 测试到底验证了什么

`tests/live.real.ts` 在 Linux 临时目录内启动测试专用的真实 Codex app-server，使用新的 CODEX_HOME，不复制登录凭据，不发起模型调用。

每种传输实际执行：

1. initialize / initialized 握手。
2. 从真实 Codex 读取 model/list。
3. Unix 接口被发现并探测验证。
4. 启动生产 HTTP 运行时，验证它**不会自动连接 / 启动 Codex**。
5. 独立账号登录，经 HTTP 显式连接。
6. 模型 / 项目任务列表、创建真实任务、thread/name/set、快照。
7. 建立浏览器用 SSE 端点并接收真实协议触发的输出帧。
8. 断开 WebUI 后，Codex 进程及另一个已连接客户端仍存活、仍可读取模型。

**没有把模拟 RPC 的回归测试冒充真实 Codex 集成。**

## 浏览器验收

在真实浏览器中，以真实 Codex WebSocket 测试后端验证：

- 独立管理员登录 / 退出。
- 显式连接已有测试接口；真实模型列表显示。
- 新建任务对话框、任务创建、快照、SSE 显示“已连接”。
- 真实临时项目的 README 文件列出。
- 设置面板展示实际接口、并发值、项目授权 JSON、账号 ID。
- 桌面 1440×1000、手机 390×844：DOM 无水平溢出，手机发送按钮位于视窗内。
- 手机项目抽屉与检查面板可打开和关闭。
- 普通只读账号看不到管理设置，不能新建或发送任务。
- 主界面无浏览器 JavaScript error / warn。

最初的浏览器驱动遇到原生 prompt 对话框处理问题，因此将“新建任务”改成应用内对话框；最终使用另一个可用浏览器完成上述验收，而不是把驱动超时记成 UI 通过。

## 静态资源实测

通过 `node scripts/measure-assets.cjs` 直接对交付文件计算压缩体积，单位：字节。

| 文件 | 原始 | gzip | Brotli |
|---|---:|---:|---:|
| `index.html` | 10,286 | 4,183 | 3,135 |
| `style.css` | 14,269 | 3,966 | 3,405 |
| `state.js` | 1,797 | 788 | 666 |
| `app.js` | 27,628 | 9,378 | 7,904 |
| **合计** | **53,980** | **18,315** | **15,110** |

Brotli 相对本应用原始静态文件减少 **72%**。不包含 HTTP / TLS 头，不包括动态任务文本，不是与原面板做同负载实验的降幅。尚未做大量真实模型输出下的生产负载测试。

## 尚未验证 / 不应承诺

1. **测试环境无可用 Codex 登录态**（Linux / Windows CLI 均显示 Not logged in）。未验证实际模型回复、真实工具执行和用户交互产生的审批链路。
2. 未读取到账户真实周额度；未消耗真实重置卡。解析与幂等逻辑有回归测试，但无法替代登录后的验收。
3. 未验证你远端 Linux 图形版 Codex 是否暴露共享端点，更不能保证另起 app-server 自动同步桌面活动任务。
4. 未部署到你的远端服务器；systemd / Nginx 配置未被实际加载，Dockerfile 未构建。
5. 未做多小时断网、百人并发或长时间模型输出压测。缓冲 / 并发上限是实现约束，不是生产容量承诺。
6. WebUI 的项目 ACL 不是 OS 多租户安全隔离。高权限用户与 Codex 仍共享底层系统身份。

## 可重复执行

```bash
npm ci --ignore-scripts
npm run check
npm test
CODEX_TEST_BINARY=/absolute/path/to/codex CODEX_TEST_ISOLATED=1 npm run test:real
CODEX_EXISTING_ENDPOINT=/actual/existing/socket npm run test:live
node scripts/measure-assets.cjs
```

不要向真实测试传入别人的端点或凭据；只使用你有权访问的 Codex 实例。测试会留下临时目录供检查，本次未批量删除文件。
