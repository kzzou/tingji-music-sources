# 听己音乐订阅源

发布地址：`https://raw.githubusercontent.com/kzzou/tingji-music-sources/main/manifest.json`

App 只下载发布好的成品，不在手机上搜索、清洗或逐个测试 GitHub 脚本。仓库首次运行成功后才会出现 `manifest.json`；没有通过验证时不会发布空源。

App 优先通过 GitHub 官方 Contents API 的 raw 媒体格式获取同仓库原文，网络失败或限流时使用上述原始文件地址后备，避免部分手机无法访问原始文件域名时直接失败。两种通道均不携带账号凭据。

## 更新流程

GitHub 云端每天北京时间 02:00（`Asia/Shanghai`）触发 `Refresh subscription` 工作流，不依赖本地电脑或 Codex 开机。工作流搜索公开 GitHub 候选，结合 `pdone/lx-music-source`，固定上游提交，按脚本自身的提交日期排序、按内容去重，最多测试 10 个。这个范围代表本次搜索找到的候选，不代表全 GitHub 的绝对最新十个。

验证包含静态编译、LX 初始化、实际 `musicUrl` 请求、音频 GET 前缀与文件特征检查。首版验证范围为 **酷狗 / 128k**，样本是「不死鸟 — 霍尊」；不会把脚本声明的其他平台和无损能力当成已验证能力。单首歌通过也不保证所有歌曲都可播。

候选脚本在无发布凭据、只读代码挂载的临时容器内运行。Node VM 用于模拟 LX 环境，不作为安全边界。独立发布任务只校验和复制产物，不执行产物。

成功后发布不可变 `sources/<sha256>.js` 和稳定 `manifest.json`。失败、无候选通过或推送冲突时保留现有版本；`previous-manifest.json` 记录上一次发布，历史脚本继续保留。App 校验长度和摘要，初始化失败时恢复原来的音源。正常完成的每日检查会提交 `last-check.json`，记录检查时间与运行 ID，即使源内容未变化也留下运行记录。

## 手动运行

在 GitHub 的 [Actions](https://github.com/kzzou/tingji-music-sources/actions/workflows/refresh.yml) 页面运行工作流，或在已登录 GitHub CLI 的电脑执行：

```powershell
gh workflow run refresh.yml --repo kzzou/tingji-music-sources --ref main
gh run list --repo kzzou/tingji-music-sources --workflow refresh.yml --limit 3
```

仓库不需要配置个人访问令牌。发布使用该工作流独立发布任务的临时 `GITHUB_TOKEN`，App 无需任何 GitHub 凭据。

## 定时任务

已在 `.github/workflows/refresh.yml` 启用 **每天 02:00，时区 `Asia/Shanghai`** 的 GitHub schedule。GitHub 调度可能排队延迟，不保证恰好在整点开始。见 [GitHub 官方日程文档](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule)。

无需另外创建 Codex 日程；仍可让 Codex 手动触发工作流。若将来改回 Codex 调度，可参考 [备用任务正文](docs/codex-nightly-task.md)，先移除 GitHub schedule，避免重复执行。

## 开发

无 npm 运行时依赖。Node 20 及以上可运行纯函数回归测试：

```sh
node --test tests/*.test.cjs
node scripts/refresh.cjs --catalog-only
```

下载脚本的实际执行只用于工作流的临时验证容器。`output/` 是临时结果目录，不是线上发布目录。

源脚本保留原作者信息和原始代码，仓库不移除鉴权、不改写上游收费或授权要求。生成器及 LX 预加载环境沿用听己 / LX Music Mobile 代码，许可证和来源见 [NOTICE](NOTICE.md)。
