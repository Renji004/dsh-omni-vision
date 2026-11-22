# feat(render): plot / curve / grid, plus 0.7.0 cleanup —— dsh-omni-vision

> 本地 `main` 上 5 个提交，相对 `origin/main`（0.1.0）：
> 新增截屏工具与函数绘图 / 参数曲线 / 带刻度坐标系，
> 再加上一轮"拿 16 张真实图表画出来看"发现的坐标系细节修正，
> 最后移除本机 LM Studio 工具并清掉工作区里那套"读完即焚"的临时目录。

## 提交清单

| 提交 | 内容 | 规模 |
|---|---|---|
| `ced6f19` | 新增 `eyes_grab`；`eyes_render` 增加 `plot`/`curve`/`grid`；输出 schema 放宽到 png/webp/jpeg；README 重写；版本 0.6.0（该提交同时也带入了 `eyes_lmstudio`，已在最后一个提交里移除） | 7 文件 +2206/−138 |
| `2a2dbd2` | `grid`：刻度步长按"格数最接近目标"选 1-2-5，首尾标签不再被丢弃 | client +32/−8 |
| `71d8603` | `grid`：刻度数字移到绘图框外（边距里），零轴判定收紧 | client +45/−26 |
| `a826199` | `grid`：轴箭头尖端落在轴端点，不再冒出 2px 小尖 | client +8/−6 |
| 最新提交 | 移除 `eyes_lmstudio`；不再创建 `<workspace>/renders/`，临时 PNG 改走系统临时目录；版本 0.7.0 | 6 文件 +182/−418 |

## 1. render 新增三个数据坐标 op

`plot`、`curve`、`grid` 共用一套视窗：`x,y,w,h` 是绘图框，`x0,x1,y0,y1` 是数据范围。

```js
// y = f(x)：表达式在作用域内求值，按 x 采样
{ op: "plot", x: 80, y: 60, w: 420, h: 260,
  fn: "0.62*sin(2*x)*exp(-0.25*x)", x0: -1, x1: 6, y0: -0.7, y1: 0.7 }

// 参数曲线：x(t), y(t)，按"弦到中点距离"自适应细分（默认容差 0.35px）
{ op: "curve", x: 80, y: 60, w: 420, h: 260,
  fx: "cos(t)*(1+0.3*cos(5*t))", fy: "sin(t)*(1+0.3*cos(5*t))",
  t0: 0, t1: 6.283, closed: true }

// 坐标系：网格 + 零轴 + 箭头 + 刻度标签
{ op: "grid", x: 80, y: 60, w: 420, h: 260,
  x0: 0, x1: 12, y0: 0, y1: 100, ticks: 5 }
```

- `plot`：`fn` 里的函数名（`sin/cos/sqrt/pow/abs/min/max/hypot/atan2/PI/E…`）直接可用；多根曲线共用同一视窗，靠 `from/to` 只采一段；`fill` 出面积图。
- `curve`：圆、心形、玫瑰线、回头弯、闭合轮廓这类 `y=f(x)` 画不出来的形状，一条命令即可；`closed` 封口，`fill` 填充。
- `grid`：步长默认 1-2-5 好数字（约每 90px 一格），也可 `stepX`/`stepY` 固定；`labels:false`、`arrows:false` 可关。
- 兼容性：纯新增 op，旧命令（text/line/path/arc/field/stack/table…）行为不变；`plot/curve/grid` 用数据坐标，其余图元仍是像素坐标，混用需自行换算（README 已写明）。

## 2. grid 的三处实测修正

这轮不是跑 demo，是把 16 组虚构数据画成 4 张 1200×760 的 sheet（折线/面积/柱/堆叠/散点/雷达/热力/箱线/地图/函数图…），逐张核对刻度、标签、图例、合计之后修的：

**① 刻度数忽多忽少（`2a2dbd2`）**
旧实现把 `range/target` 直接向上取到 1-2-5：range=12、目标 5 时取到 5，只剩 3 格。改成在 `1,2,5,10` 里选"实际格数与目标格数对数距离最近"的那个。同时首尾两个刻度标签不再因为贴边就被 `continue` 掉，改为夹到框内并用左/右对齐。

**② 数字压在数据上（`71d8603`）**
原先标签画在绘图框里，正好盖住曲线和数据点；`x0:0 / y0:0` 还被当成"中间零轴"，把 y 标签也推回框内。现在：标签放到框**下方/左侧的边距**（画布边上不够时才回落框内）；只有零线**严格在视窗内部**时才算内部轴；首尾 x 标签夹到画布边缘；x 轴已有 `0` 时 y 轴不再重复标 `0`。

**③ 箭头冒 2px 小尖（`a826199`）**
轴线画到 `x+w`，箭头三角形的尖却在 `x+w-2`，于是轴末端露出一截短棍。现在尖端精确落在轴端点，箭头略加大到 9×9。

## 3. 0.7.0 清理（最新提交）

- **删掉 `eyes_lmstudio`**：它是本机 LM Studio 的个人扩展，DSH 输入框与主模型现在都能直接看图，这条链路不再需要维护。代码、schema、注册、README、包描述一并移除。
- **不再创建 `<workspace>/renders/`**：这层"临时副本 + 读完即焚"在实践里只对带 `ocr:true` 的渲染生效，平时只会让工作区多出一个不断变大的目录。现在：
  - `eyes_render` 只写 `pics/` 一份永久副本（`keptPath`），OCR 自检也直接读这一份，不再删；
  - `eyes_grab` / `eyes_paste` 的中转 PNG 放进 `%TEMP%\dsh-omni-vision\`，图片附加成功后立刻删除，纯文本路由下留给 `eyes_ocr` 读完再删；
  - "读完即焚"的删除逻辑只作用于这个插件自己的临时目录，用户保存在任何其他位置的图片都不会被碰。
- 结果字段随之收敛：`eyes_render` 去掉 `fileSaved`/`fileError`/`fileDeleted`/`deleteError`，`path` 现在就是永久副本的路径。

## 4. 影响面

- 工具名、参数均为**增量**，无破坏性变更；0.1.0 的命令可以直接跑。0.7.0 移除了 `eyes_lmstudio`（非发布版工具），工作区不再产生 `renders/`。
- 输出 schema 的 `mediaType` 放宽为 `png/webp/jpeg`：宿主把截图/贴图规范化成 webp 时也能直接回传附件。
- 依赖不变（`mermaid` 仍为可选、按需加载）。
- **`lib/index.js` 有改动 → 需要重启 `dsh web`**，再硬刷新浏览器；只改 `client/client.js` 时刷新页面即可。
- 回滚：`git revert <最新提交> a826199 71d8603 2a2dbd2 ced6f19`。

## 5. 验证

```powershell
node --check client/client.js
node --check lib/index.js
```

重启后画一张自检图（三个框：`grid`、`grid+plot` 共视窗、`curve` 闭合玫瑰线）：

- 刻度标签全部在框外，首尾标签完整、不重叠；
- 箭头尖正好停在轴端，没有超出的小尾巴；
- 闭合 curve 首尾接上（缺 `closed:true` 的 path 不闭合，这是预期行为）；
- 工作区里**不再出现** `renders/`：`eyes_render` 只写 `pics/`，`eyes_grab` / `eyes_paste` 结束后 `%TEMP%\dsh-omni-vision\` 里也不留文件。

实测审计：16 张图逐张核对，问题全部收敛到上面三处修正；另有一处雷达图的网格圈未闭合，属于调用方命令漏写 `closed`（`path` 对开折线就该不闭合），未改代码——重画后逐像素比对，差异 1318px 且完整落在五段补上的线上。

## 6. 已知限制

- `eyes_render` 需要浏览器 GUI 在线（15s / Mermaid 45s，无服务端渲染兜底）。
- `plot/curve/grid` 之外仍是像素坐标，复杂排版要自己算。
- 这个工具的强项是**程序化图形**（图表、示意图、卡片、流程图、函数曲线）；人像/场景插画不是它的能力范围，真实地图需要 GeoJSON 走 `path`。

## 7. 附件（不在仓库内）

- `pics/charts-a.png`、`charts-b.png`、`charts-c.png`、`charts-d.png` —— 16 张图的四张 sheet（1200×760，2× 超采样）。
- `renders/radar-before-after.png` —— 雷达网格圈修复前后对比。
