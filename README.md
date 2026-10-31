# 听己音乐订阅源

发布地址：`https://raw.githubusercontent.com/kzzou/tingji-music-sources/main/manifest.json`

App 只下载发布好的成品，不在手机上搜索、清洗或逐个测试 GitHub 脚本。仓库首次运行成功后才会出现 `manifest.json`；没有通过验证时不会发布空源。

App 优先通过 GitHub 官方 Contents API 的 raw 媒体格式获取同仓库原文，网络失败或限流时使用上述原始文件地址后备，避免部分手机无法访问原始文件域名时直接失败。两种通道均不携带账号凭据。

## 更新流程

GitHub 云端每天北京时间 02:00（`Asia/Shanghai`）触发 `Refresh subscription` 工作流，不依赖本地电脑或 Codex 开机。发现阶段使用 5 组中英文查询和可维护的 `config/repositories.json`，纳入仍有价值的 fork，最多扫描 20 个仓库、200 个文件，清洗最多 100 个去重候选（累计下载 32MiB），按仓库轮询挑选 30 个进入实际验证。支持嵌套目录和版本目录，折叠同一来源旧版本，并保留当前已发布的来源参加复检，避免仅按更新时间漏掉可用源。

验证包含静态编译、LX 初始化、实际 `musicUrl` 请求、音频 GET 前缀与文件特征检查。按真实歌曲样本分别验证酷狗、QQ、酷我，并尝试从官方公开接口补充网易和咪咕元数据；官方曲目信息无法核实时不虚构 ID。当前请求音质为 128k，各平台只有实际音频验证通过才进入清单，不能把脚本声明的全平台或无损能力当成已验证能力。

酷狗样本包含用户反馈无法播放的国风堂、哦漏版《知我》，由现有 App 的官方公开搜索 SDK 核对 ID 与哈希。一个来源首首失败时会在同次初始化中尝试后备曲目，避免用单首歌曲淘汰整个平台；但至少一首通过也不保证该源对所有歌可用。最终聚合脚本还会逐平台复检，并优先路由实际通过目标样本的来源。最终支持范围和实际通过的样本以 `manifest.json` 为准。

发现阶段仅在 GitHub API 请求中使用只读临时令牌，下载原文不携带令牌、不执行脚本。候选目录按固定路径、大小和哈希交给无凭据、只读代码挂载的临时容器，并发 3 个验证子进程。Node VM 用于模拟 LX 环境，不作为安全边界。独立发布任务只校验和复制产物，不执行产物。App 成品仍限制为最多 24 个来源、6MiB，优先覆盖不同平台与目标曲目。

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
node scripts/discover.cjs
```

`node scripts/discover.cjs` 只进行发现和静态清洗，输出 `discovery/catalog.json` 与 `discovery/scripts/<sha256>.js`。下载脚本的实际执行只用于工作流的临时验证容器；它只读 `TINGJI_CATALOG_DIR`，不接触发现令牌。`output/` 是临时结果目录，不是线上发布目录。动态公开曲目样本和验证诊断作为短期 Actions 附件保留，不包含歌曲文件或签名媒体 URL。

源脚本保留原作者信息和原始代码，仓库不移除鉴权、不改写上游收费或授权要求。生成器及 LX 预加载环境沿用听己 / LX Music Mobile 代码，许可证和来源见 [NOTICE](NOTICE.md)。
