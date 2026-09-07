# Linux 部署指南

## 推荐：与已有 Codex 相同的 Linux 用户运行

目标是访问同一用户的 Unix socket、项目目录和既有 app-server。不要用 root 绕过访问权限，也不要把底层 Codex socket / 原始 WebSocket 公开到互联网。

要求：Node.js 22.14+（本次 Linux 测试 22.22.1）、npm、Git。发现功能可利用 `ss`（iproute2）；没有 `ss` 时仍会检查可见 socket / 进程地址。

### 1. 安装到全新的目录

```bash
git clone https://github.com/1138069580qq-create/Codex-Standalone-Linux.git /opt/codex-webui
cd /opt/codex-webui
npm ci --omit=dev --ignore-scripts
```

请先让服务用户获得 `/opt/codex-webui` 的适当访问权限。仓库为私有时，使用自己的 GitHub 凭据 / SSH / `gh auth login`；不要把 GitHub token 写进仓库或服务配置。

本项目没有前端 build 步骤。`npm start` 直接运行生产服务，tsx 只负责运行 TypeScript。

### 2. 配置 origin 并创建管理员

```bash
mkdir -p ~/.config/codex-webui
cp deploy/webui.env.example ~/.config/codex-webui/env
chmod 600 ~/.config/codex-webui/env
```

编辑 `env` 中的 HTTPS 域名。如只用 SSH 隧道，把 origin 改为 `http://127.0.0.1:3210`，或者省略该项。若改了 `CODEX_WEBUI_DATA`，运行账号 CLI 时必须使用同一配置。

```bash
set -a
. ~/.config/codex-webui/env
set +a
read -r -s -p 'Admin password (12+ chars): ' PASSWORD; printf '\n'
printf '%s' "$PASSWORD" | npm run user:add -- --username admin --admin
unset PASSWORD
```

账号 CLI 也能修改现有账号密码，但正在运行的服务须重启后加载；网页账号编辑即时生效并使旧会话失效。不要在配置 JSON 中填写明文密码。

### 3. 安装 systemd 用户服务

```bash
mkdir -p ~/.config/systemd/user
cp deploy/codex-webui.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-webui
systemctl --user status codex-webui
journalctl --user -u codex-webui -n 100 --no-pager
```

示例假定 `/usr/bin/node` 与 `/opt/codex-webui`；路径不同请修改单元。若希望退出 SSH 后仍运行，由管理员按需设置 `loginctl enable-linger 用户名`。

服务不会替你启停 Codex。不要配置 `PrivateTmp=true`，否则 `/tmp` 内的既有 socket 可能不可见。默认内存上限 512 MiB 是资源保护值，不是经过大规模生产压测的容量保证；按实际并发与项目情况调整。

### 4. HTTPS 反向代理

将 `deploy/nginx.conf.example` 合并到你自己的 Nginx 配置；修改域名与证书路径。该文件的 `limit_req_zone` 位于 `http` 层，不得放到 `server` / `location` 内。

配置重点：

- 后端监听 `127.0.0.1:3210`，与原 ElementsPanel 端口分离。
- `CODEX_WEBUI_ORIGIN` 必须等于浏览器地址栏的 origin。
- `/api/codex/events` 禁止缓冲 / 缓存 / gzip，允许至少 180 秒读超时。
- 20 秒 SSE 心跳维持连接；10 分钟主动换流并验证登录。
- 上传请求按 base64 体积预留 6 MiB；实际文件仍最多 4 MiB。
- 浏览器只访问本 WebUI，不直接连接 Codex。

Nginx 配置与 systemd 单元在本次环境中只做静态检查，未在你的远端机器上安装或加载。

### 5. 添加项目

在网页设置中填入 `config.example.json` 对应的字段。项目路径必须是当前 Linux 机器上的绝对路径且已存在。

禁止：`/`、用户 home、Codex 凭据目录、WebUI 数据目录以及与这些目录有包含关系的项目；多个项目不得嵌套。项目授权只能隔离 WebUI 操作，不能替代 OS 级信任隔离。

## 升级 / 回退

仅在**本独立仓库目录**内升级，不接触原项目：

1. 等待运行任务完成，备份 WebUI 数据目录（包含密码哈希，备份也应限制权限）。
2. `systemctl --user stop codex-webui`
3. 查看目标版本 / 提交，再 `git pull --ff-only` 或明确 checkout 指定 tag。
4. `npm ci --omit=dev --ignore-scripts`
5. `systemctl --user start codex-webui` 并查看日志。

服务重启不自动重连或重放命令，需登录后显式连接已有 Codex。回退时对本仓库使用已知可用提交即可。不要把旧数据库直接覆盖新数据库，先检查格式兼容性。

## 可选容器

提供 Dockerfile，但本次未执行 Docker 构建。容器必须能访问已有接口，且 UID / GID、项目路径与 socket 权限匹配。

- Unix socket：挂载其父目录，并保持该 socket 路径与 JSON 配置一致。
- 主机 WebSocket：容器里的 `127.0.0.1` 不是主机。优先 Linux 主机网络或使用适当的安全地址；不要为解决连接问题公开原始端口。
- `/data` 需要服务 UID 可写；先使用账号 CLI 初始化管理员。
- 容器默认监听 `0.0.0.0:3210`，必须显式设置 HTTPS `CODEX_WEBUI_ORIGIN` 并置于 HTTPS 反代之后。
- 不挂载整个 home / Codex 凭据目录。应用只需要共享 socket / 项目目录，不需要读取 Codex 登录凭据。

## 故障排查

| 现象 | 检查 |
|---|---|
| 启动提示无管理员 | CLI 与服务是否使用同一个数据目录 |
| 登录后 API 返回 403 Origin / CSRF | 域名、HTTPS、端口是否与 origin 完全一致；重新登录 |
| 扫描无接口 | 是否同一 Linux 用户；Codex 版本是否提供共享端点；不要把 stdio 当成 socket |
| 显示未连接 | 配置启用后仍需点击连接；不会自动启动或重连 Codex |
| 额度不可用 | 登录方式 / 供应商是否支持账号额度 API；不会填造周额度 |
| 发送未确认 | 先刷新任务；相同内容可复用请求 ID，程序不会自动重发 |
| 文件不可见 | 授权、路径、符号链接 / 私密文件规则和大小上限 |
| SSE 延迟很大 | 反代是否缓冲；是否使用了全局压缩过滤器；检查 Nginx location |
| 项目忙 / 并发上限 | 等待任务完成，或为独立项目配置不同 worktree |
| 新建 app-server 看不到桌面任务状态 | 独立 app-server 不等于桌面共享实例，须确认桌面的实际共享接口 |
