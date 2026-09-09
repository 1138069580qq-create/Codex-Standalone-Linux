# 1.5.0 增量迁移验证报告（2026-09-09）

基线：GitHub 默认分支 `codex/standalone-linux` 的 `4823bf6`（1.4.2），已用实时 GitHub API 和后续 Git fetch 核实一致。本次不迁移私有 GitHub 文件功能，不改动原面板仓库。

## 自动验证

| 环境 | 全套覆盖 | 最终通过 | 明确跳过 | 未解决失败 |
|---|---:|---:|---:|---:|
| Windows | 222 | 219 | 3 | 0 |
| Linux / WSL | 222 | 221 | 1 | 0 |

上表由一次完整执行加针对失败项/受影响模块的 22 项复测合并得出，不是把首轮失败当通过。Windows 跳过项为真实现有 socket 探测、受系统权限限制的 symlink 测试、Unix transport；Linux 仅跳过未配置真实 socket 的探测。Linux 已覆盖符号链接与 Unix transport。没有用 mock 替代或冒充真实模型集成。

- `npm run check`：TypeScript noEmit、全部静态 JS 语法通过（包含新增 features.js）。
- 真实 Sharp：Windows/Linux 均完成 PNG/JPEG/WebP/AVIF 编解码，验证缩略图最大 384px / 256 KiB、全图保持 1600×1000 原始像素、非法图片拒绝。
- 传输与安全：Range / If-Range / ETag / HEAD、权限与 CSRF、附件 MIME、二进制分块重试与幂等提交、校验失败、过期、并发、UTF BOM / UTF 边界、受限 ZIP/Office、防私网与越域重定向。
- 审批：注册不签发会话、不建账号，管理员同意后普通身份可登录；普通成员不能审批、重复审批幂等、拒绝不建账号、重启持久化、模拟写账号后队列未写回的重试不重复建人。

## 真实 Chromium 浏览器验收

使用同一生产 Koa 应用与真实静态资源、真实文件和 Sharp；Codex 数据来自隔离协议模拟，无真实模型消息。

首轮 13 个有效检查通过，包括右侧/全屏文件预览、DOCX、ZIP、PDF 显式加载、媒体不预加载、浏览器沙盒、管理员同意/拒绝。后续最终 20 项交互检查全部通过：聊天小图、调用分组和单次展开、点击全分辨率、原始尺寸切换、分块上传、390×844 手机右侧和全屏预览、无横向溢出、待审批不能登录、旧成员能登录、退出清理私人预览。

验收调试过程中发现的 fixture 会话未投递内容、异步等待及日志观测脚本问题不算通过；最终交互结果单独保存在 browser-final.log。截图已检查：browser-chat.png、browser-image.png、browser-file.png、browser-mobile.png。

## 首轮发现并修正

1. Koa attachment() 按扩展名重写 MIME；改为调用后强制二进制下载 MIME，HTML 不得被 inline 参数提升为活动网页。
2. 旧上传竞态测试只覆盖 FileReader；改为执行新生产 upload helper，仍验证项目切换后零网络上传。
3. 新 JS 一处换行字符串生成问题由全量语法检查检出并修正。

## 尚待生产环境确认

此报告不将本地验收等同服务器部署。生产需确认已验证提交、依赖、服务健康、静态资源哈希。真实模型回复/工具执行、真实重置卡、长时间高并发及实际公网吞吐未执行，不应宣称通过。浏览器沙盒不保证所有网站允许嵌入；PDF/视频的完整媒体解码由用户浏览器完成。

完整日志位于 `.test-artifacts/migration-20260909/`（不提交临时账号、测试项目或日志）。
