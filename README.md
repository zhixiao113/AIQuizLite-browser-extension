# AIQuizLite 浏览器题库助手

Chrome / Edge 侧边栏扩展（Manifest V3），把题库网页里的题目整理成 [AIQuizLite](https://github.com/zhixiao113/AIQuizLite-AS) Android 应用可导入的 JSON / ZIP 题库文件。

扩展与 App 配套使用，但**独立构建、独立发布**：扩展负责采集与整理，App 负责刷题与学习记录。

当前版本：**0.5.7（测试版）**

## 它解决什么问题

题库网站通常只能在网页上看题，没法导入到自己的刷题应用。这个扩展读取你已登录的题库页面，把题干、选项、标准答案和解析整理成标准题库文件，再导入 App 离线刷题。

## 主要能力

- **整库采集**：优先读取页面数据和内嵌 JSON；没有完整数据时按答题卡逐题读取，或使用“下一题”导航；观察到同源只读分页接口且能校验题号时改用接口读取。
- **对话式导出**：在侧边栏说“把这份题库导出来，共 100 题”，采集器自动执行；也可以点“导出整份题库”并填写总题数。
- **AI 整理**：把网页原文转成 App 题库 JSON，需自行配置 OpenAI 兼容的 Chat Completions 接口（Base URL / 模型 ID / API Key）。
- **待核对机制**：缺标准答案、关键图未取到、答案冲突或有截断时不猜答案，逐条列出原因，支持编辑原文后重试。
- **深度核对（可选）**：按原题定位截图 + 实际题图做识别，再结合原文校验补录；需要单独指定支持图片输入的模型。
- **导出**：无图输出 JSON；有图输出 ZIP（根文件 `question-bank.json`、`formatVersion=2`、图片在 `images/`）。
- **题型**：单选、多选、判断、单空填空、连线（含可复用左项）。

## 安装（开发者模式加载）

1. Edge 打开 `edge://extensions`，Chrome 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载解压缩的扩展」，选择本仓库的 `dist/` 目录（目录内必须直接包含 `manifest.json`）。
3. 在已登录的题库内容页点击工具栏图标（或按 `Alt+Shift+Q`）打开侧边栏。
4. 打开「设置」，填写模型 API 地址、模型 ID 和 API Key。

> 选择目录时只能看到文件夹，因此只看到 `lib` 属于正常现象，应选择包含 `manifest.json` 的父目录。

更新：替换 `dist/` 内容后，在扩展管理页点「重新加载」，关闭并重新打开侧边栏。扩展配置和本机草稿保存在浏览器扩展存储中，升级不会自动清空。

## 使用流程

1. 打开题库页面（保持登录）。
2. 侧边栏输入「把这份题库导出来，共 152 题」（导出要求与总题数缺一不可，可分两条消息）。
3. 观察采集 / 成品 / 待核对三个数字；原题号覆盖与成品数一致才算完整。
4. 点「下载」，文件保存到你设置的下载子目录（默认 `下载/AIQuizLite`）。
5. 通过微信、数据线或网盘把文件发到手机，用 App 的「导入题库」打开；App 设置里开启「显示手动放入的 ZIP」后，也能直接在 App 的下载库中导入。

## 输出格式

```json
{
  "name": "题库名",
  "questions": [
    {
      "id": "q1",
      "index": 1,
      "paper": "试卷名",
      "numberInPaper": 1,
      "type": "single",
      "stem": "题干",
      "options": [{"key": "A", "text": "选项"}],
      "answers": ["A"],
      "explanation": null,
      "image": null,
      "explanationImages": []
    }
  ]
}
```

`type` 取值：`single` / `multi` / `judge` / `fill_blank` / `matching`。连线题额外带 `matching` 字段（`mode`、`leftItems`、`rightItems`、`correctPairs`）。

有图时输出 ZIP：根目录 `question-bank.json`，图片位于 `images/`，图片用相对路径引用。

## 隐私与安全

- 模型密钥保存在扩展本地存储，默认仅当前浏览器会话；不写入网页、题库文件或日志。
- 使用浏览器现有登录态，不索取账号密码，不导出 Cookie 或登录数据。
- 只读取当前题库页及其同源只读接口；不猜测接口，不重放未知 POST 请求。
- 不上传手机已有题库、错题或学习记录；扩展也不保存 App 的学习数据。

## 已知限制

- 只支持具有可读文本或结构数据的页面；canvas 渲染、跨域嵌入、特殊导航需要单独适配。
- 深度核对的截图暂不支持内嵌 iframe 题库，这类题可编辑原文后用普通核对。
- 上限：单份 5000 题、快照 3 MiB、成品 JSON 4 MiB、单张输入图 8 MiB；ZIP 遵循 App 的 500 条目 / 单文件 25 MiB / 总解压 100 MiB。
- 未提供扫码或局域网直传：评估后决定暂不实施，请用文件方式把题库传到手机。

## 本地开发

```powershell
npm ci
npm run check          # 单元测试 + 构建 dist
npx playwright install chromium
npm run test:browser   # 隔离 Chromium 浏览器回归
npm run build          # 生成 dist
```

原生 JavaScript ES modules、HTML/CSS，无运行时第三方依赖和 CDN；Playwright 仅用于开发测试。

测试使用隔离 Chromium 和模拟题库 / 模拟模型，不使用真实账号或付费接口。

## 目录结构

| 路径 | 说明 |
|---|---|
| `extension/` | 扩展源码（manifest、background、侧边栏、lib 模块） |
| `dist/` | 构建产物，供「加载解压缩的扩展」直接使用 |
| `scripts/` | 构建与发布校验脚本 |
| `tests/` | 单元测试与浏览器回归 |

主要模块：

| 文件 | 职责 |
|---|---|
| `extension/lib/page-reader.js` | 页面数据、DOM、请求观察与同源分页读取 |
| `extension/lib/bank-collector.js` | 整库范围、导航、检查点与停止 |
| `extension/lib/snapshot-parser.js` | 有明确标准答案的原文转换 |
| `extension/lib/matching-parser.js` | 连线两列识别与关系转换 |
| `extension/lib/review-validator.js` | AI 核对、原文依据及失败原因 |
| `extension/lib/review-source.js` | 原文编辑覆盖与多空顺序作答转换 |
| `extension/lib/deep-capture.js` | 原题定位、截图裁切与尺寸校验 |
| `extension/lib/deep-review.js` | OCR、图文依据校验与逐题补录 |
| `extension/lib/schema.js` | 五类题型校验与 JSON 导出 |
| `extension/lib/storage.js` | 配置、文档与任务持久化 |
| `extension/lib/downloads.js` | 下载子目录与下载记录 |
| `extension/panel.js` | 侧边栏对话、进度与文档预览 |

## 版本记录

- **0.5.7**：修复第 16 题选项正文内嵌 `E.` 与独立 E 选项并存时的核对阻塞（保留完整命令与原文答案）；补录表单预填原文、兼容常见分隔符、错误就地显示并可重试；题目排序支持自动识别原题号与手动调整，已有题可移动且不破坏原题覆盖；导出保持所选顺序。
- **0.5.6**：深度核对失败原因可见（题号 + 原因 + 阶段代码），旧草稿无需重跑即可显示。
- **0.5.5**：原题库标签关闭后普通核对不再报错，改用已保存原文；深度核对按原网址恢复标签。
- **0.5.4**：普通整理超时保护，连续超时缩批后暂停。
- **0.5.3**：OCR 与整理模型用途分离，修复配置覆盖与纯文本识别误判。
- **0.5.2**：截图权限未就绪时不再误报核对结束。
- **0.5.1**：连接测试独立探测，避免把推理截断误判为题库截断。
- **0.5.0**：待核对原文编辑、深度核对（截图 + 题图识别 + 逐题补录）。
- **0.4.0**：设置改为子页面，支持下载子文件夹；新增草稿清理规则。
- **0.3.x**：整库采集、分段处理、截断恢复、连线题与待核对机制。

## 相关仓库

- Android 应用：[zhixiao113/AIQuizLite-AS](https://github.com/zhixiao113/AIQuizLite-AS)

## 许可

本仓库暂未声明开源许可证。如需在其它项目中使用，请先联系作者。