# 来源说明

本仓库的生成器及订阅发布工具使用 Apache License 2.0，见根目录 `LICENSE`。

`lib/generator.cjs` 和 `lib/runtimeTemplate.cjs` 来自听己音乐项目的 `src/utils/sourceGenerator/`，为 Node 构建端编译版本。添加了只允许已验证平台与音质进入生成源的限制。

`lib/user-api-preload.js` 来自 [LX Music Mobile](https://github.com/lyswhut/lx-music-mobile) 的 `android/app/src/main/assets/script/user-api-preload.js`，用于模拟真实 App 的自定义源接口。原许可证见 `lib/LICENSE.lx-music-mobile.txt`，文件摘要和编译来源见 `lib/PROVENANCE.json`。

上游音源候选来自公开 GitHub 仓库，初始收集入口是 [pdone/lx-music-source](https://github.com/pdone/lx-music-source)。生成源保留各脚本原始代码和作者元数据，`manifest.json` 中的 `upstreams` 记录仓库、固定提交、脚本路径及原始内容摘要。各音源原作者的声明和使用条件继续适用。

本仓库保存源脚本和订阅元数据，不保存下载的歌曲文件、用户歌单、登录 Cookie 或 GitHub 个人令牌。
