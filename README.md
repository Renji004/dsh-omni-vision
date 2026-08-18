# dsh-omni-vision

> **本插件全由 DeepSeek v4 Flash（`deepseek-v4-flash`）编写。**

让 Agent 自己"看见"文字与图形的 DSH 插件，全程本地、不依赖视觉模型：

- **`eyes_render`** — 在 Web GUI 对话流里渲染画布（文字、线条、矩形、圆形、椭圆），PNG 落盘到工作区 `renders/`（读完即焚），并**一式两份**另存永久副本到 `pics/`。
- **`eyes_paste`** — 让用户把剪贴板图片（截图/照片）直接 Ctrl+V 粘贴或拖进页面：浏览器捕获图片、归一化为 PNG 存到工作区，供本地 OCR/像素分析读取。只写 `renders/`（读完即焚，**不留** `pics/` 永久副本）。**全本地读图路径**（不限流、离线），独立于 DSH 原生发图链路（DSH 输入框本身支持图片粘贴/拖放，但发图需要选择支持图片的模型，见"限制"）。
- **`eyes_ocr`** — 用 Windows 自带 OCR（`Windows.Media.Ocr`，完全离线）把 PNG 里的文字读回成文本。**这是 Agent "看见文字"的途径**：DeepSeek 是纯文本模型，但识别出的文本可以原样喂回给模型引用。
- **`eyes_analyze`** — 把 PNG 解码成像素数据（N×N 颜色网格、主色占比、内容包围盒）。**这是 Agent "看见图形/颜色"的途径**：无需视觉模型，图形以结构化数据呈现。

全程本地闭环：浏览器 canvas → 本机 HTTP → 本机磁盘 → Windows OCR / 像素分析。**所有下载均按需、不盲目下载**（详见"下载策略"）；出网环节仅限：模型推理本身，以及（可选）首次渲染 Mermaid 图且本地无副本时按需获取一次 Mermaid 库。

## 平台要求

**仅支持 Windows。** `eyes_ocr` 通过 PowerShell 调用 Windows 自带 OCR 引擎（`Windows.Media.Ocr`，完全离线）；`eyes_render` / `eyes_paste` / `eyes_analyze` 本身不依赖 Windows 特性，但整个插件在非 Windows 上无法提供"读字"能力，按 Windows 平台维护。

## 下载策略：全部按需，不盲目下载

**安装与启动阶段零下载；所有获取均按需发生：**

- **插件本体**：本地 `link:` / `file:` 安装，无任何下载。
- **Mermaid 库**：唯一可能发生的运行时下载——仅在**首次实际渲染 Mermaid 图**且本地无副本时，浏览器按需从 CDN 获取一次（成功后缓存）；不渲染 Mermaid 就完全不会下载。
- **其余全部本地**：渲染、OCR、像素分析、图片接收，均不产生任何网络下载。

## 工作原理

```
模型 ──eyes_render──▶ 服务端工具 execute
  │                      │ 按 callId 注册"待渲染"承诺（15s 超时）
  │                      ▼
  │          会话事件流（tool/call 事件实时推送浏览器）
  │                      ▼
  │          浏览器 keyed tool.call.toolview 卡片
  │                      │ 解析命令 → canvas 绘制 → toBlob → PNG base64
  │                      ▼
  │          POST /eyes/render（同源校验，按 callId 匹配）
  │                      ▼
  │          工具恢复：写 <workspace>/renders/eyes-<callId>.png（读完即焚）
  │                    + 永久副本 <workspace>/pics/eyes-<callId>.png
  │                    + attachments.saveImage（内容寻址存储）
  │                      ▼
  │          工具结果 = 文本信封（路径/尺寸/命令数/OCR 文本）
  └──────────────────────（模型声明支持图片时，结果额外带 image 图片块）

模型 "看见"文字：eyes_render（或任意 PNG）→ eyes_ocr ──▶ 行文本
模型 "看见"图形：PNG → eyes_analyze ──▶ 颜色网格 / 主色 / 内容包围盒

用户图片进来：模型 ──eyes_paste──▶ 粘贴卡片（Ctrl+V 提示）
  │                      │ 浏览器捕获剪贴板图片 → canvas → PNG base64
  │                      ▼
  │          POST /eyes/paste（同源校验，按 callId 匹配）
  │                      ▼
  │          写 <workspace>/renders/paste-<callId>.png（读完即焚，无永久副本）
  └────────── 之后 eyes_ocr / eyes_analyze 读取
```

- **图片能力探测 + 降级**：执行时探测当前模型路由是否声明 `image` 输入（`llm.resolveModelInfo().inputModalities`）。支持 → 结果带 `{type:'image', attachment}` 图片块，模型下一轮起能看见；不支持（如 DeepSeek API，适配器声明 `["text"]` 且遇图片块抛 `UNSUPPORTED_CONTENT`）→ 只返回文本信封，会话绝不报错。画布仍渲染在 GUI 里，用户可见。
- **本地感知（文字）**：`eyes_ocr` 通过 PowerShell 5.1 调用 Windows 自带 OCR 引擎，离线识别，支持已安装的语言包（如 `zh-Hans-CN` 中文简体）。识别结果按行返回文本。
- **本地感知（图形）**：`eyes_analyze` 自带纯 Node PNG 解码器（zlib + 反滤波，支持 8-bit RGB/RGBA 非交错 PNG），输出网格平均色、主色直方图、内容包围盒。
- **渲染匹配**：客户端把工具调用的 `callId` 随 PNG 一起 POST 回来，服务端按 `exec.callId` 匹配待渲染条目，天然支持并行调用与多标签页（先到先得，其余 404 被客户端静默忽略）。
- **重放**：刷新页面后，历史会话里的卡片从工具参数（`block.call.argsRaw`）重放绘制，不再上传。
- **读完即焚 + 一式两份**：`eyes_render` 每次产出都写两份——`renders/` 下的临时副本在 `eyes_ocr` / `eyes_analyze` 读取成功后自动删除（返回结果带 `fileDeleted` 标记，`renders/` 不会越积越多）；`pics/` 下的永久副本（返回结果带 `keptPath`）**不会被删除**，用户随时可以打开查看。`eyes_paste` 只写 `renders/`（读完即焚），**不保留** `pics/` 永久副本。用户放在其他目录的图片（截图、照片等）**绝不会**被删除。

## 安装

```powershell
cd <你的工作区>
dsh plugin --profile web add link:<你的工作区>\dsh-omni-vision
# 若链接失败：dsh plugin --profile web add file:<你的工作区>\dsh-omni-vision
```

安装后校验 `%USERPROFILE%\.dsh\profiles\web\package.json`：dependencies 与 `dsh.profile.bundles` 都应包含 `dsh-omni-vision`。

**可选**：`npm i mermaid@11` 仅在需要**全离线**渲染 Mermaid 图时安装；不装也能用——首次实际渲染时浏览器会**按需**从 CDN 加载（成功后缓存）。**安装/启动阶段不会盲目下载任何东西。**

**必须重启 web 服务**（生产启动时插件列表与客户端 bundle 在启动时固化）：

1. 在运行 `dsh web` 的窗口按 Ctrl+C（或结束监听 3080 端口的进程）。
2. 重新运行 `start-dsh.ps1`（或 `npx --yes @deepseek-ai/dsh web`）。
3. 浏览器硬刷新（Ctrl+Shift+R）。

## 使用

### eyes_render —— 画

参数：`width`/`height`（64–2048）、`background`（CSS 颜色）、`title`、`description`、`commands`（数组）、`mermaid`（字符串，可选）、`ocr`（布尔，渲染后顺带本地 OCR，默认 false）。

**Mermaid 连线图**：传 `mermaid` 参数（Mermaid 源码字符串，如 `graph LR\n  A[start] --> B[process] --> C[end]`）即可让浏览器渲染出流程图/时序图等，**无需手工计算坐标**；`mermaid` 存在时优先于 `commands`。支持 flowchart / sequenceDiagram / classDiagram / stateDiagram 等 Mermaid 语法。渲染结果走同一套 PNG 存档（一式两份）+ 可选 OCR（可把节点文字读回给模型）。**按需加载**（本插件所有下载均按需，见"下载策略"）：只有实际传 `mermaid` 参数渲染时才加载，优先用本地副本（在插件目录 `npm i mermaid@11` 后全离线可用），缺失时才回退 CDN（首次需浏览器联网，成功后浏览器缓存）。加载或语法失败时工具返回明确错误。

落盘 PNG 的像素尺寸与 `width`/`height` **完全一致**（不做设备像素比缩放），命令坐标与 PNG 像素一一对应——`eyes_analyze` 看到的网格坐标、`contentBox` 都与命令里的 x/y 直接可比。

`text` 的 `y` 是**首行字形顶部**的坐标：绘制时用 `measureText` 量出字形顶部相对字母基线的距离（`actualBoundingBoxAscent`），在 `y + ascent` 处画基线，字形顶精确落在 y 上（跨引擎一致，不随字体/字号/浏览器解释差异偏下），中文、拉丁文混排时顶部对齐一致。

PNG **一式两份**：`renders/eyes-<callId>.png`（`ocr:true` 且读回成功后自动删除，读完即焚）+ `pics/eyes-<callId>.png`（永久保留，结果里的 `keptPath`）。

| op | 字段 |
|---|---|
| `text` | `x`,`y`,`text`,`size`,`font`,`weight`,`color`,`align`,`maxWidth` |
| `line` | `x1`,`y1`,`x2`,`y2`,`color`,`width` |
| `rect` | `x`,`y`,`w`,`h`,`radius`,`fill`,`stroke`,`strokeWidth` |
| `circle` | `cx`,`cy`,`r`,`fill`,`stroke`,`strokeWidth` |
| `ellipse` | `cx`,`cy`,`rx`,`ry`,`fill`,`stroke`,`strokeWidth` |
| `clear` | `color`（清屏底色） |

### eyes_ocr —— 读文字

参数：`path`（PNG 绝对路径，如 `eyes_render` 返回的 path）。返回 `ok`、`text`（全文）、`lines`（逐行）、`language`，以及 `fileDeleted`（`renders/` 下的源文件读取后自动删除）。

### eyes_analyze —— 看图形

参数：`path`（PNG 绝对路径）、`grid`（采样网格 N×N，2–32，默认 8）、`maxColors`（主色数量，1–16，默认 6）。返回 `gridCells`（网格平均色）、`dominantColors`（主色及占比）、`contentBox`（内容包围盒），以及 `fileDeleted`（同上，读完即焚）。

### eyes_paste —— 收图

参数：`hint`（可选，显示在粘贴卡片上的说明）。调用后 GUI 出现粘贴卡片，用户选择一张图片复制后ctrl+v或直接拖到浏览器界面（批量读取时，可把多张图片副本直接放入 renders/ 文件夹并告诉所用AI），浏览器捕获并保存为 `<workspace>/renders/paste-<callId>.png`（读完即焚，**无** `pics/` 永久副本读完即焚；未读取的文件会留在 renders/ 中，可手动清理）。返回 `path`、`width`、`height`、`bytes`、`fileSaved`、`fileError`。

### 示例

> 用 eyes_paste 让用户粘贴一张截图，然后用 eyes_ocr 读出里面的文字并复述给我

> 用 eyes_render 画一张 800x400 的画布，写上文字"Hello 世界 123"，设 ocr:true，然后告诉我你看到了什么

> 用 eyes_render 画一张 900x500 的 Mermaid 流程图：`graph TD\n  A[登录] --> B{校验}\n  B -->|成功| C[进入主页]\n  B -->|失败| D[提示错误]`，设 ocr:true 读回节点文字

> eyes_ocr 读取 <workspace>\renders\eyes-xxx.png，把识别出的文字逐行复述给我

> eyes_analyze 分析 <workspace>\renders\eyes-xxx.png，网格 12，然后描述画面布局和主要颜色

## 限制

- **仅支持 Windows**：`eyes_ocr` 依赖 Windows 自带 OCR（`Windows.Media.Ocr` + PowerShell 5.1），其他平台无法读字；渲染/粘贴/像素分析不依赖 Windows，但插件整体按 Windows 平台维护。
- **需要浏览器 GUI 打开**：`eyes_render` / `eyes_paste` 会等浏览器回传——普通渲染 15 秒、Mermaid 首次加载放宽到 45 秒、`eyes_paste` 等人粘贴放宽到 60 秒；GUI 未开时返回明确错误。无服务端渲染兜底。
- **Mermaid 依赖（按需）**：本插件所有下载均按需（见"下载策略"）——Mermaid 仅在实际渲染时才加载，优先取宿主 `/eyes/mermaid.min.js`（在插件目录 `npm i mermaid@11` 后提供，全离线），否则回退 jsDelivr CDN（仅首次需浏览器联网，成功后浏览器缓存）；不渲染就完全不会下载。渲染与语法错误会作为工具报错返回。
- **OCR 效果**：依赖 Windows 自带语言包（需已安装对应语言包，如 `zh-Hans-CN`）；`Windows.Media.Ocr` 对中英混排会在中文字符间插入空格，效果一般但可读；纯图形内容识别为空属正常。
- **OCR 路径**：WinRT `StorageFile` 要求反斜杠路径，脚本已自动把 `/` 规范化为 `\`。
- **`eyes_analyze` 仅支持 8-bit RGB/RGBA 非交错 PNG**（覆盖本插件的渲染输出与常见截图）；其他变体返回明确错误。
- 无 `attachments` 服务时不注册工具（与 `read_image` 相同门槛）。
- **DSH 输入框原生支持图片**（粘贴/拖放，"图片拖动到此处即可添加，最多 20 张/20MB"，UI 在 `dsh-client-ui-conversation`）；发图被拒是因为当前 DeepSeek 路由是纯文本（错误码 `MODEL_DOES_NOT_SUPPORT_IMAGES`，提示"当前模型不支持图片"）——切换到 dsh-vision-router 的「自动识图」模型即可原生发图。`eyes_paste` 是**全本地**读图路径（不依赖云/不限流），适合 OCR/像素细看用户图。

## 开发

- 服务端半区：`lib/index.js`（纯 ESM，无构建）、`lib/png.js`（PNG 解码+分析）、`lib/ocr.ps1`（Windows OCR 封装）。
- 客户端半区：`client/client.js`（手写 `window.__ModuleLoader__.load` factory bundle，无构建；loader 表提供 `react`）。
- 改动后需重启 `dsh web` 才生效（生产启动无 HMR watcher）。
