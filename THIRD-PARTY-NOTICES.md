# 第三方组件与素材说明（THIRD-PARTY NOTICES）

本文件列出「共享新闻池」项目**直接与间接**使用的全部第三方组件及其许可证，供任何人自行核验。
本项目**自身代码**以 [MIT](./LICENSE) 许可发布。

> **怎么复现**：`npm install` 之后，读取 `node_modules` 中每个包的 `package.json`（`scripts/audit.cjs` 也会打印同样的清单）。
> 本仓库**不包含** `node_modules`；发布 zip 由 `git archive` 生成，也不含依赖 —— 依赖由使用者自行 `npm install`，各自随包携带其许可证文本。

---

## 一、运行时直接依赖（3 个）

| 包 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| `bcryptjs` | 2.4.3 | MIT | 密码哈希（不落明文） |
| `better-sqlite3` | 11.10.0 | MIT | 本地 SQLite 数据库 |
| `ws` | 8.22.0 | MIT | WebSocket 实时同步 |

## 二、全部组件（含间接依赖，共 40 个）

| 包 | 版本 | 许可证 |
|---|---|---|
| base64-js | 1.5.1 | MIT |
| bcryptjs | 2.4.3 | MIT |
| better-sqlite3 | 11.10.0 | MIT |
| bindings | 1.5.0 | MIT |
| bl | 4.1.0 | MIT |
| buffer | 5.7.1 | MIT |
| chownr | 1.1.4 | ISC |
| decompress-response | 6.0.0 | MIT |
| deep-extend | 0.6.0 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| end-of-stream | 1.4.5 | MIT |
| expand-template | 2.0.3 | (MIT OR WTFPL) |
| file-uri-to-path | 1.0.0 | MIT |
| fs-constants | 1.0.0 | MIT |
| github-from-package | 0.0.0 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |
| inherits | 2.0.4 | ISC |
| ini | 1.3.8 | ISC |
| mimic-response | 3.1.0 | MIT |
| minimist | 1.2.8 | MIT |
| mkdirp-classic | 0.5.3 | MIT |
| napi-build-utils | 2.0.0 | MIT |
| node-abi | 3.99.0 | MIT |
| once | 1.4.0 | ISC |
| prebuild-install | 7.1.3 | MIT |
| pump | 3.0.4 | MIT |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) |
| readable-stream | 3.6.2 | MIT |
| safe-buffer | 5.2.1 | MIT |
| semver | 7.8.5 | ISC |
| simple-concat | 1.0.1 | MIT |
| simple-get | 4.0.1 | MIT |
| string_decoder | 1.3.0 | MIT |
| strip-json-comments | 2.0.1 | MIT |
| tar-fs | 2.1.5 | MIT |
| tar-stream | 2.2.0 | MIT |
| tunnel-agent | 0.6.0 | Apache-2.0 |
| util-deprecate | 1.0.2 | MIT |
| wrappy | 1.0.2 | ISC |
| ws | 8.22.0 | MIT |

## 三、许可证汇总

| 许可证 | 数量 | 性质 |
|---|---|---|
| MIT | 29 | 宽松 |
| ISC | 6 | 宽松 |
| Apache-2.0 | 2 | 宽松（含专利授权） |
| (MIT OR WTFPL) | 1 | 宽松（二选一，取 MIT 即可） |
| BSD-3-Clause | 1 | 宽松 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | 宽松（三选一） |

**结论：全部为宽松（permissive）许可证，不含 GPL / AGPL / LGPL 等 copyleft（传染性）许可证。**

→ 这些组件**不会**要求本项目、也不会要求本项目使用者开源自己的代码；唯一的义务是「保留版权与许可证声明」（且仅在随附这些依赖一并分发时才需要）。本项目不分发依赖，因此该义务不落在本项目上，而落在执行 `npm install` 的人身上。

## 四、非代码素材

- **字体**：应用**运行时不加载任何在线字体**。`design-preview/` 下的界面设计稿（静态 HTML，非应用运行时）以**链接**方式引用 Google Fonts，均为 **OFL（SIL Open Font License）**，允许自由使用与再分发；本项目**未分发**任何字体文件。
- **图片 / 图标 / 音视频**：本仓库**不含**任何第三方图片、图标、音视频素材；界面元素全部为纯 CSS 与内联 SVG。
- **新闻内容**：本应用**不内置**任何新闻正文或第三方内容。条目内容由使用者自行添加；运行时抓取的标题/摘要来自公开网页，仅存于使用者本机 `data/` 目录（已 gitignore），**不随本项目分发**。

## 五、运行时访问的外部服务（非本项目组件）

添加链接 / 核查 / 展开推文时，程序会主动访问以下**公开**服务，请遵守其各自的服务条款：

| 用途 | 服务 |
|---|---|
| 抓取网页标题 | 目标网页本身 |
| 交叉核查（搜索同题报道） | DuckDuckGo Lite、Bing |
| 取回 X/Twitter 推文正文 | fxtwitter、publish.twitter.com (oEmbed) |

> 若需对外公开或商业使用，建议改用上述服务的**官方 API**，并遵守其速率与内容使用条款。
