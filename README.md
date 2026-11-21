# dsh-omni-vision

> **本插件由 DeepSeek v4 Flash（`deepseek-v4-flash`）编写。**

**对话里的视觉 I/O 层**——把视觉世界送进对话，把对话里的画面送出去。

它出生时是给"看不见"的纯文本模型做的代偿（OCR 读字、像素网格看图形）。现在主模型自己就能看图，代偿层的意义变了，插件重心也随之转移：

| 方向 | 工具 | 现在的定位 |
|---|---|---|
| **进来** | `eyes_grab` | 截取窗口/屏幕/区域，直接交给模型看——"你看看"不用再手动截图 |
| **进来** | `eyes_paste` | 用户拖图/粘贴，PNG 落到工作区磁盘（需要文件本身时用） |
| **出去** | `eyes_render` | 在 GUI 里画图（含 Mermaid），并回传给模型——**画完自己看得见**，能自查 |
| **读字** | `eyes_ocr` | 本地离线 OCR：只想要文字去引用/检索时，比看图便宜 |
| **兜底** | `eyes_analyze` | 像素网格/主色/包围盒：没有视觉路由，或确实需要像素数值时 |
| **兜底** | `eyes_lmstudio` | 本机 LM Studio 的视觉模型，全程不出机器 |

全程本地闭环：浏览器 canvas → 本机 HTTP → 本机磁盘 → Windows OCR / 像素分析 / 系统截屏。**所有下载均按需、不盲目下载**（详见"下载策略"）；出网环节仅限：模型推理本身，以及（可选）首次渲染 Mermaid 图且本地无副本时按需获取一次 Mermaid 库。

## 平台要求

**仅支持 Windows。** `eyes_ocr` 通过 PowerShell 调用 Windows 自带 OCR 引擎（`Windows.Media.Ocr`），`eyes_grab` 通过 `System.Drawing` 截取桌面，两者都完全离线；`eyes_render` / `eyes_paste` / `eyes_analyze` 本身不依赖 Windows 特性，但整个插件按 Windows 平台维护。

## 下载策略：全部按需，不盲目下载

**安装与启动阶段零下载；所有获取均按需发生：**

- **插件本体**：本地 `link:` / `file:` 安装，无任何下载。
- **Mermaid 库**：唯一可能发生的运行时下载——仅在**首次实际渲染 Mermaid 图**且本地无副本时，浏览器按需从 CDN 获取一次（成功后缓存）；不渲染 Mermaid 就完全不会下载。
- **其余全部本地**：渲染、截屏、OCR、像素分析、图片接收，均不产生任何网络下载。

## 工作原理

```
模型 ──eyes_render──▶ 服务端工具 execute
  │                      │ 按 callId 注册"待渲染"承诺（15s；Mermaid 45s）
  │                      ▼
  │          会话事件流（tool/call 事件实时推送浏览器）
  │                      ▼
  │          浏览器 keyed tool.call.toolview 卡片
  │                      │ 解析命令 → canvas 绘制 → toBlob → PNG base64
  │                      ▼
  │          POST /eyes/render（同源校验，按 callId 匹配）
  │                      ▼
  │          写 <workspace>/renders/eyes-<callId>.png（读完即焚）
  │        + 永久副本 <workspace>/pics/eyes-<callId>.png
  │        + attachments.saveImage（内容寻址存储）
  │                      ▼
  └──────── 工具结果 = 文本信封 + （模型支持图片时）image 图片块 ──▶ 模型看见自己画的图

模型 ──eyes_grab──▶ grab.ps1（PowerShell + System.Drawing，DPI 感知）
  │                      │ scope=window（默认，前台窗口或按标题匹配）/ screen / region / list
  │                      ▼
  │          临时 PNG 只做中转（renders/grab-<callId>.png）
  │                      │ 读入内存 → saveImage → 立刻删掉临时文件
  └──────── 结果：尺寸/窗口标题/包围盒 + image 图片块 ──▶ 模型当场看见屏幕，磁盘上不留痕

用户图片进来：也可以直接用输入框发图（客户端原生支持）；eyes_paste 留作显式粘贴卡片
  │                      │ 浏览器捕获 → canvas → PNG base64
  │                      ▼
  │          POST /eyes/paste → 临时 PNG（renders/paste-<callId>.png）
  └────────── 附加到结果后立即删除；纯文本路由下保留给 eyes_ocr / eyes_analyze
```

- **图片能力探测 + 降级**：执行时探测当前模型路由是否声明 `image` 输入（`llm.resolveModelInfo().inputModalities`）。支持 → 结果带 `{type:'image', attachment}` 图片块；不支持 → 只返回文本信封，会话绝不报错。支持图片时**截图/粘贴不落盘**（临时 PNG 读完即删）；纯文本路由下截屏会保留 PNG，供 `eyes_ocr` 兜底。
- **渲染匹配**：客户端把工具调用的 `callId` 随 PNG 一起 POST 回来，服务端按 `exec.callId` 匹配待渲染条目，天然支持并行调用与多标签页（先到先得，其余 404 被客户端静默忽略）。
- **重放**：刷新页面后，历史会话里的卡片从工具参数（`block.call.argsRaw`）重放绘制，不再上传。
- **只有画出来的图才留档**：`eyes_render` 写两份——`renders/` 下的临时副本（OCR 自检后删，结果带 `fileDeleted`）+ `pics/` 下的永久副本（结果带 `keptPath`）**不会被删除**。`eyes_grab` / `eyes_paste` 的临时 PNG 在图片附加成功后立刻删除，默认不留任何文件；`eyes_grab` 传 `keep:true` 才额外留一份 `pics/`。用户放在其他目录的图片**绝不会**被删除。

## 安装

```powershell
cd <你的工作区>
dsh plugin --profile web add link:<你的工作区>\dsh-omni-vision
# 若链接失败：dsh plugin --profile web add file:<你的工作区>\dsh-omni-vision
```

安装后校验 `%USERPROFILE%\.dsh\profiles\web\package.json`：dependencies 与 `dsh.profile.bundles` 都应包含 `dsh-omni-vision`。

**可选**：`npm i mermaid@11` 仅在需要**全离线**渲染 Mermaid 图时安装；不装也能用——首次实际渲染时浏览器会**按需**从 CDN 加载（成功后缓存）。

**必须重启 web 服务**（生产启动时插件列表与客户端 bundle 在启动时固化）：

1. 在运行 `dsh web` 的窗口按 Ctrl+C（或结束监听 3080 端口的进程）。
2. 重新运行 `start-dsh.ps1`（或 `npx --yes @deepseek-ai/dsh web`）。
3. 浏览器硬刷新（Ctrl+Shift+R）。

## 使用

### eyes_grab —— 截屏进对话

参数：

| 参数 | 说明 |
|---|---|
| `scope` | `window`（默认，前台窗口或按标题匹配）、`screen`（整块虚拟屏）、`region`（显式矩形）、`list`（只列窗口，不截图） |
| `title` | `window` 专用：窗口标题的子串（大小写不敏感），如 `"DeepSeek Harness"`；省略则截当前前台窗口 |
| `x`/`y`/`w`/`h` | `region` 专用，物理像素 |
| `keep` | 是否额外保留 `pics/` 永久副本（默认 `false`，截完即删） |

返回 `width`、`height`、`title`、`process`、`bounds`、`windows`（当前可见窗口列表）、`path`（删除后为空），以及（模型支持图片时）图片块。临时 PNG 只是把像素从 `grab.ps1` 送到附件的中转站，**附加完成后立刻删除**，磁盘上不留截图；纯文本路由下才保留文件供 `eyes_ocr` 读。

DPI 缩放（125%/150%）已处理：先 `SetProcessDPIAware` 再取窗口矩形，坐标与像素 1:1。

### eyes_render —— 画

参数：`width`/`height`（64–2048）、`scale`（超采样倍数 1–3，默认 2）、`grain`（胶片颗粒 0–1，默认 0）、`background`（CSS 颜色）、`title`、`description`、`commands`（数组）、`mermaid`（字符串，可选）、`ocr`（布尔，渲染后顺带本地 OCR，默认 false）。

| op | 字段 |
|---|---|
| `text` | `x`,`y`,`text`,`size`,`font`,`weight`,`color`,`align`,`maxWidth` |
| `line` | `x1`,`y1`,`x2`,`y2`,`color`,`width` |
| `arrow` | `x1`,`y1`,`x2`,`y2`,`color`,`width`,`head`（箭头长度，默认随线宽） |
| `rect` | `x`,`y`,`w`,`h`,`radius`,`fill`,`stroke`,`strokeWidth` |
| `circle` | `cx`,`cy`,`r`,`fill`,`stroke`,`strokeWidth` |
| `ellipse` | `cx`,`cy`,`rx`,`ry`,`fill`,`stroke`,`strokeWidth` |
| `path` | `points`（`[[x,y],…]`）、`smooth`（曲线连接）、`closed`、`fill`,`stroke`,`strokeWidth` |
| `arc` | `cx`,`cy`,`r`,`start`,`end`（角度）、`pie`（扇形）、`ccw`,`fill`,`stroke` |
| `stack` | `x`,`y`,`w`、`children`（子命令数组）、`gap`、`padding`、`fill`,`stroke`,`radius` —— 子项自动纵向排列，高度由内容算 |
| `table` | `x`,`y`,`w`、`columns`（`[{title,width,align}]`）、`rows`（字符串二维数组）、`rowHeight`、`headerHeight`、`zebra`、`headerColor`、`padding`、`fill`（表头底色） |
| `field` | `x`,`y`,`w`,`h`、`seed`、`cell`（特征尺寸 px）、`octaves`、`warp`（域扭曲）、`palette`（颜色数组）—— 程序化噪声场（云雾/大理石/烟） |
| `plot` | `x`,`y`,`w`,`h`（绘图框）、`fn`（x 的表达式）、`x0`,`x1`,`y0`,`y1`（视窗数据范围）、`from`,`to`（采样区间）、`samples`、`fill`（面积）—— y=f(x) 函数曲线 |
| `curve` | `x`,`y`,`w`,`h`（绘图框）、`fx`,`fy`（t 的表达式）、`t0`,`t1`（默认 0–2π）、`samples`、`tolerance`（平坦度容差 px）、`closed`、`fill`,`stroke`,`width` —— 参数曲线，可画闭合/回头曲线 |
| `grid` | `x`,`y`,`w`,`h` + `x0`,`x1`,`y0`,`y1`（与 plot 同一视窗）、`grid`（网格颜色）、`gridWidth`、`ticks`、`stepX`,`stepY`、`labels`、`arrows`、`color`（零轴/标签色）、`size`（标签字号） —— 带刻度的坐标系 |
| `clear` | `color`（清屏底色） |

所有 op 都额外接受 `opacity`（0–1）、`dash`（`[实线,空白]`，如 `[8,6]`）、`shadow`（`"dx dy blur color"`）、`filter`（CSS 滤镜，如 `"blur(12px) saturate(1.3)"`）和 `blend`（`multiply` / `screen` / `overlay` / `soft-light` …）；描边接受 `color`/`stroke`、`width`/`strokeWidth`、`cap`、`join`；`fill`/`stroke` 还接受渐变字符串：`linear-gradient(135deg,#4f46e5,#22d3ee)`、`radial-gradient(#a,#b)`（按图形包围盒计算，支持多色标）。

**`plot` 函数绘图**：`fn` 是一段以 `x` 为变量的表达式（`sin/cos/sqrt/pow/abs/min/max/PI/…` 都在作用域里），渲染器在 `from`–`to` 上采样并映射进 `x,y,w,h` 框；`x0/x1/y0/y1` 是视窗（多根曲线共用同一坐标系），`samples` 控制精度，`fill` 可填成面积图。函数图、人像线稿都能直接写公式画。注意：其他图元（`circle`/`line`/`text`）用**像素**坐标，只有 `plot`/`curve`/`grid` 用数据坐标，混用时要自己换算。

**`curve` 参数曲线**：`fx`/`fy` 是 t 的表达式，t 走 `t0`–`t1`（默认 0–2π）。内部按"弦到中点的距离"做自适应细分（`tolerance` 默认 0.35 px），圆弧处自动加密、直线段自动省点；`closed:true` 首尾封口，`fill` 可填充。**闭曲线、回头弯、耳朵、发尾、心形/玫瑰线**这类 `y=f(x)` 画不出来的形状，用它一条命令就够。

**`grid` 坐标系**：和 `plot`/`curve` 共用 `x,y,w,h` + `x0,x1,y0,y1` 视窗，画网格、零轴、轴箭头和刻度标签。刻度步长自动取 1-2-5 的"好数字"（约每 90 px 一格），也能用 `stepX`/`stepY` 固定。画线稿时先铺一层 `grid` 当草稿纸，按格子摆五官，比盲猜坐标稳得多。

**`field` 程序化场**：域扭曲的 fBm 值噪声，逐像素计算后按 `palette` 映射颜色。`warp` 把球状噪声拉成云/大理石纹理，`octaves` 加细节，`cell` 调特征尺寸，换个 `seed` 就是另一张图。配合 `filter`（模糊/对比/饱和）和 `blend`（screen 发光、multiply 压暗、soft-light 提质感），能从"几何拼贴"跨到"氛围画"。代价是逐像素计算：900×520 的场在 2 倍超采样下约 0.5–1 秒。

**`stack` 自动排版**：`children` 从上往下流式排列，`x` 是相对内容左边距的偏移，`y` 被忽略；子项 `text` 不给 `maxWidth` 时按剩余宽度自动折行。卡片高度 = 内容 + `padding`×2 + `gap`×间隔，所以不要手算 `y`，也不会出现估高/估矮导致的空白或重叠。子项不支持再嵌套 `stack`。

**`table` 数据表格**：给 `columns` 和 `rows` 即可，列宽可固定可均分，`align` 控制每列对齐，`zebra` 默认开，网格线走同一套像素吸附。高度 = `headerHeight + rows*rowHeight`，可以直接作为 `stack` 的子项。

**Mermaid 连线图**：传 `mermaid` 参数（Mermaid 源码，如 `graph LR\n  A[start] --> B[process] --> C[end]`）即可让浏览器渲染流程图/时序图，**无需手工计算坐标**；`mermaid` 存在时优先于 `commands`。优先用本地副本（插件目录 `npm i mermaid@11` 后全离线），缺失时回退 CDN（首次需浏览器联网）。加载或语法失败时工具返回明确错误。SVG 会按画布设备分辨率改写宽高再光栅化（不是把小图放大），省略 `height` 时画布按图自身比例自适应高度。

落盘 PNG 的像素尺寸是 `width*scale × height*scale`（默认 2 倍超采样）：命令坐标按逻辑像素书写，画布按 `scale` 倍光栅化，聊天框把图缩窄显示时仍然清晰。`scale:1` 退回 1:1，单边上限 4096 px。CSS 只设置宽度、高度交给 `height:auto`，因此卡片缩窄时不会压扁画面。

排版与几何细节：

- `text` 的 `maxWidth` 是**折行上限**而不是挤压上限：超出宽度会按语义换行（西文按空格、中文按字），只有单个不可断开的字符串才退化为横向压缩；换行后字号和行距（1.25×`size`）不变。
- 轴对齐的 1px 直线和直角边框会**吸附到设备像素网格**（描边中心对到像素边界），`y=420.37` 这种坐标也不会糊成两行灰。
- `path` + `smooth:true` 用 **Catmull-Rom 转三次贝塞尔**，曲线穿过每个数据点（旧实现走中点二次曲线，会切角、偏离数据）。
- `arrow` 的线身收在箭尖之前（约 0.9×箭头长度），半透明箭头不会在尖端叠出深色块。
- 矩形支持负的 `w`/`h`（自动规范化），圆角半径自动收敛到短边一半。

`text` 的 `y` 是**首行字形顶部**的坐标：绘制时用 `measureText` 量出字形顶部相对字母基线的距离（`actualBoundingBoxAscent`），在 `y + ascent` 处画基线，字形顶精确落在 y 上（跨引擎一致），中文、拉丁文混排时顶部对齐一致；绘制前会 `document.fonts.load` 一遍声明的字体，避免 PNG 落到回退字形上。

### eyes_ocr —— 读文字

参数：`path`（PNG 绝对路径）。返回 `ok`、`text`（全文）、`lines`（逐行）、`language`，以及 `fileDeleted`（`renders/` 下的源文件读取后自动删除）。

### eyes_analyze —— 看像素

参数：`path`、`grid`（采样网格 N×N，2–32，默认 8）、`maxColors`（主色数量，1–16，默认 6）。返回 `gridCells`（网格平均色）、`dominantColors`（主色及占比）、`contentBox`（内容包围盒）。

### eyes_paste —— 收图

参数：`hint`（可选，显示在粘贴卡片上的说明）。调用后 GUI 出现粘贴卡片，用户复制一张图片按 Ctrl+V 或直接拖入，浏览器捕获并转成 PNG。模型支持图片时直接附加到结果并删除临时文件；纯文本路由下保留 `<workspace>/renders/paste-<callId>.png` 供 `eyes_ocr` / `eyes_analyze` 读。注意：DSH 输入框现在本身就能收图，日常直接把图发给对话即可，这个工具只在需要显式提示用户贴图时才有优势。

### eyes_lmstudio —— 本机视觉模型

参数：`prompt`、`path`（可选 PNG）、`model`、`baseUrl`、`maxTokens`、`temperature`、`timeoutMs`。默认 `http://127.0.0.1:1234`、模型 `minicpm-v-4.6-thinking`。需要先开 LM Studio 的服务端，否则连接失败。

### 示例

> 用 eyes_grab 截一下当前窗口，看看我在看什么

> 用 eyes_grab 列一下窗口，然后把 DeepSeek Harness 那个窗口截给我看

> 用 eyes_render 画一张 800x400 的画布，写上文字"Hello 世界 123"，然后告诉我你看到了什么

> 用 eyes_render 画一张 900x500 的 Mermaid 流程图：`graph TD\n  A[登录] --> B{校验}\n  B -->|成功| C[进入主页]\n  B -->|失败| D[提示错误]`

> eyes_ocr 读取 <workspace>\renders\eyes-xxx.png，把识别出的文字逐行复述给我

## 限制

- **仅支持 Windows**：`eyes_ocr` 依赖 Windows 自带 OCR，`eyes_grab` 依赖 `System.Drawing` + `user32`，其他平台无法读字/截屏；渲染/粘贴/像素分析不依赖 Windows，但插件整体按 Windows 平台维护。
- **需要浏览器 GUI 打开**：`eyes_render` / `eyes_paste` 会等浏览器回传——普通渲染 15 秒、Mermaid 首次加载放宽到 45 秒、`eyes_paste` 等人粘贴放宽到 60 秒；GUI 未开时返回明确错误。无服务端渲染兜底。`eyes_grab` 不需要浏览器。
- **截屏是"所见即所得"**：`CopyFromScreen` 截的是屏幕上实际显示的像素，被其他窗口遮挡的部分也会被截进去；最小化的窗口无法截取（会返回明确错误）。默认只截当前前台窗口，`screen` / `region` 需要显式指定。
- **Mermaid 依赖（按需）**：仅在实际渲染时才加载，优先取宿主 `/eyes/mermaid.min.js`（插件目录 `npm i mermaid@11` 后提供，全离线），否则回退 jsDelivr CDN。
- **OCR 效果**：依赖 Windows 自带语言包（如 `zh-Hans-CN`）；`Windows.Media.Ocr` 对中英混排会在中文字符间插入空格，效果一般但可读；纯图形内容识别为空属正常。
- **OCR 路径**：WinRT `StorageFile` 要求反斜杠路径，脚本已自动把 `/` 规范化为 `\`。
- **`eyes_analyze` 仅支持 8-bit RGB/RGBA 非交错 PNG**（覆盖本插件的渲染输出与常见截图）；其他变体返回明确错误。
- 无 `attachments` 服务时不注册工具（与 `read_image` 相同门槛）。
- **图片可以直接粘进输入框了**：DSH 输入框原生支持粘贴/拖放，当前主模型（DeepSeek-V4.1-Flash）本身支持图片输入，所以日常发图不需要 `eyes_paste`。`eyes_paste` 保留给"需要把图落到工作区磁盘"的场景（离线 OCR、像素统计、后续工具引用）。

## 开发

- 服务端半区：`lib/index.js`（纯 ESM，无构建）、`lib/png.js`（PNG 解码+分析）、`lib/ocr.ps1`（Windows OCR 封装）、`lib/lmstudio.js`（本机 LM Studio）、`lib/grab.ps1`（截屏封装）。
- 客户端半区：`client/client.js`（手写 `window.__ModuleLoader__.load` factory bundle，无构建；loader 表提供 `react`）。
- 改动后需重启 `dsh web` 才生效（生产启动无 HMR watcher）。
