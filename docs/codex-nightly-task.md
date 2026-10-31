# Codex 定时任务正文

当前已采用 GitHub 云端每天北京时间 02:00 自动执行，无需创建此任务。下面仅保留为切换回 Codex 调度的备用内容；切换前请先移除 GitHub workflow 的 schedule，避免重复执行。

名称：听己每日音源更新

日程：每天 02:00，时区 **Asia/Shanghai**。不要使用电脑当前的 America/Los_Angeles 时区代替。

工作目录：`G:\AITasks\听己音乐\tingji-music-sources`

将下面内容粘贴为任务正文：

```text
为 https://github.com/kzzou/tingji-music-sources 刷新听己 App 订阅源。

1. 使用当前已登录的 GitHub CLI，运行：
   gh workflow run refresh.yml --repo kzzou/tingji-music-sources --ref main
2. 查询该工作流此次新产生的 workflow_dispatch 运行；记录其运行 ID，等待完成。不要把旧的成功记录当作本次结果。
3. 检查 validate 和 publish 任务结果，以及当前 main 分支 manifest.json。工作流会搜索 GitHub 最新候选、去重后最多检查 10 个、进行实际音频验证，仅发布通过的能力。
4. 如果没有候选通过，保留线上 manifest 和历史可用脚本，这是正常的无更新结果。如果工作流本身失败，记录失败阶段，不要绕过音频验证或手工发布未经验证的脚本。
5. 简短报告：运行链接、是否发布新版本、通过的来源数量和验证范围；无更新或失败时说明原因。不要输出签名音频 URL、令牌或用户数据。

不要在本地直接执行新发现的第三方脚本，不要修改工作流的凭据隔离，不要将 GitHub 凭据写入源或 App。不需要打开手机，也不要在 App 中逐个导入测试。
```

此文件是任务配置内容；提交该文件本身不会创建或启用 Codex 的定时任务。创建后可手动运行一次，再确认下次运行时间为北京时间 02:00。
