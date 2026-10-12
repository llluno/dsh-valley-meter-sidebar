# dsh-valley-meter-sidebar

DeepSeek 峰谷电价时间轴 + 账户余额，**常驻显示在左侧边栏工作区上方**。

这是 [dsh-valley-meter](https://github.com/uckkk/dsh-valley-meter) 的移植版：原插件把控件放在对话框（composer）区域，且依赖在当前 DSH 版本上已经失效的 `@deepseek-ai/dsh-typert-protocol` 远程通道与 `@deepseek-ai/dsh-client-runtime` 包。本插件改为：

- **位置**：注册到侧边栏的 `sidebar.panellist` 槽位，也就是「插件 / 技能 / MCP」那组图标列表的最下方一行 —— 在侧边栏里它正好位于工作区区域（workspace region）的正上方。
- **形态**：一条圆角胶囊，底色取当前时段的浅色（随峰/谷切换），左侧紧贴 24 小时峰谷时间轴（峰段暖色、谷段冷色、当前时刻游标 + 00/06/12/18/24 刻度），右侧余额。全部信息无条件显示，不需要悬停，侧边栏里不占用任何文字标题。
- **配色**：默认是偏卡通、偏浅的「糖果」主题；面板里提供 15 套配色（糖果 / 薄荷 / 樱花 / 蜡笔 / One Dark / 德古拉 / 北境 / 东京夜 / 复古 / 日光 / 琥珀黛蓝 / 赭石天青 / 绛纱墨青 / 靛墨潘通 / 自定义），点一下即时生效并存进 `localStorage`，侧边栏那条同时跟着换。
- **通道**：主机侧只用内置的 `webServer` 服务注册一条 **仅限本机回环** 的 HTTP 路由，客户端轮询它。没有远程 RPC 通道，也 **没有任何运行时依赖**（不需要 `dsh-typert-protocol`，不需要 `dsh-client-runtime`）。
- **计费口径**：北京时间周一至周五 09:00-12:00、14:00-18:00 为高峰；其余时段（含周末）为低谷。**中国法定节假日全天按低谷计费**，调休上班的周末同样全天按低谷计费 —— 所以日历里会显示节假日名称 / `周末` / `调休上班` 标签，休息日的时间轴上不再画任何峰段。

```
侧边栏
├─ 顶栏 / 品牌 / 新建会话
├─ 插件 · 技能 · MCP        ← sidebar.panellist 的其它行
├─ [峰| ▁▔▁▔ 24h 刻度 | ¥42.50]   ← 本插件
└─ 工作区 / 会话区域         ← sidebar.workspaces
```

## 安装

```bash
dsh plugin --profile web add link:/Volumes/GM7/dsh/valleyplugin
```

或者用 Harness 的插件管理界面（`plugin_manager`）以 `link:<本仓库路径>` 安装 —— 用 `plugin_manager` 时它会把包写进 profile 的 `package.json`／`dsh.profile.bundles`，本包自带的 `cordis.patch.yml` 作为 bundle 补丁层生效，无需你手动编辑 profile 的 patch 文件。

改代码之后：**客户端半（`lib/client.js`）热更新** —— 它由文件 mtime 生成 `rev`，刷新页面就是新代码；**主机半（`lib/index.js`）需要重启 `dsh web`** —— Node 的 ESM 模块缓存会一直返回进程启动时加载的那份，模块热更新在本 harness 里默认关闭（`dsh-base/cordis.patch.yml` 的 `hmr.config.root: []`）。判断方法：`curl http://127.0.0.1:3080/api/valley-meter/state`，响应里有 `display.pollSec`、`peak.offPeakReason`、`peak.calendar` 就是新代码。

余额需要 API Key，默认从凭证服务 / 环境变量 `DEEPSEEK_API_KEY` 读取。**查询余额不消耗 token**：`GET /user/balance` 是账户接口，不是模型调用，只有请求频率需要节制（见 `refreshSec`）。

## 配置

所有可调项走 profile patch 行里的 `config:`，例如：

```yaml
- insert:
    - id: valley-meter-sidebar
      name: dsh-valley-meter-sidebar
      config:
        pollSec: 20
        refreshSec: 300
        peakColor: '#e08a3c'
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `endpoint` | `https://api.deepseek.com` | 余额接口；非 `https` 会被忽略（API Key 只走 TLS） |
| `envName` | `DEEPSEEK_API_KEY` | 凭证名 / 环境变量名 |
| `pollSec` | `20` | 客户端轮询本机路由的间隔，下限 10 秒（只打本机，不消耗任何额度） |
| `refreshSec` | `300` | 上游余额查询的最小间隔（TTL），下限 30 秒；面板的「刷新余额」按钮会强制穿透它 |
| `currency` | `CNY` | 优先取的币种，缺失时回退到接口返回的第一条 |
| `weekendOffPeak` | `true` | 休息日全天低谷规则（含周末与法定节假日），自北京时间 2026-08-23 00:00 起生效；设为 `false` 则一律按窗口计费 |
| `windows` | `[{start:1,end:4},{start:6,end:10}]` | **UTC 小时**，即北京时间 09:00-12:00、14:00-18:00 |
| `holidayUrl` / `holidayUrls` | jsDelivr / fastly / raw.githubusercontent 三处 holiday-cn 镜像 | 节假日数据地址模板，必须含 `{year}` 占位符，可指向自建镜像 |
| `holidays` | `[]` | 手工追加的法定节假日日期，如 `['2026-11-11', {date: '2026-11-12', name: '自定假日'}]` |
| `workdays` | `[]` | 手工追加的调休上班日期（仅用于显示标签，不改变计费） |
| `holidayCacheHours` | `12` | 节假日数据的重新拉取间隔（上限 168 小时），同时决定磁盘缓存的复用窗口 |
| `peakColor` | `#e08a3c` | 「自定义」主题的峰段颜色（其它主题在面板里选） |
| `valleyColor` | `#4d7fd6` | 「自定义」主题的谷段颜色 |
| `topUpUrl` | `https://platform.deepseek.com/top_up` | 点击余额跳转的充值页（仅 https） |

> ⚠️ `windows` 用的是 **UTC 小时**（与原插件的口径一致）。要写北京时间就减 8 小时：`09:00-12:00` → `{start:1,end:4}`。

## 节假日数据

按 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)（抓取国务院放假通知）的 `{year}.json` 判断，字段为 `{name, date, isOffDay}`：`isOffDay: true` 是放假日，`false` 是调休上班日。因为年末的日期可能写在下一年那份通知里，查一个日期时会同时查它自己的年份和下一年的数据。

- 数据按 `holidayCacheHours` 后台刷新，并缓存在 `<DSH_HOME>/storages/valley-meter-sidebar/holidays.json`，所以离线启动也知道节假日；拉取失败只是回退成「周末 + 时间窗口」的判定，不会让状态接口报错。
- 面板的「节假日数据」一行显示已载入的年份、数据来源主机与抓取时间；不可用时显示「不可用」，悬停可看到原因。
- 判定口径：`峰 = 北京时间周一至周五 ∧ 该日不在节假日集合 ∧ 落在高峰窗口`。调休上班日只显示标签，仍然全天低谷 —— 与「调休上班的周末全天按低谷价计费」一致。

## 交互

- **点整条状态条** → 打开同名的完整面板（大号彩色时间轴、当前时段、今日、下次切换倒计时、高峰时段、余额与更新时间、节假日数据、配色选择、手动刷新按钮）。
- **点右侧余额** → 新窗口打开充值页（已阻止冒泡，不会误触发面板切换）。
- **悬停整条** → 气泡显示「时段 · 倒计时 · 日期类型 · 余额」以及出错原因。
- **面板里点配色色板** → 立即切换峰谷配色；侧边栏那条同步变化，选择记在 `localStorage` 里，刷新后仍然生效。
- **侧边栏收起**（56px 轨道）→ 自动缩成一个带当前时段颜色的小圆角方块。

## 实现要点

- **主机侧** `lib/index.js`：`inject: ['webServer']`，`ctx.effect` 注册 `GET /api/valley-meter/state`；请求必须来自回环地址且 `Host` 头也是回环（不信任 `X-Forwarded-For`），否则 403。余额有 TTL 缓存、并发去重，失败时保留上一次成功数值并回报 `error`。峰谷判定用「北京时间（UTC+8，无夏令时，直接对 epoch 做位移后读 UTC 字段，因此与主机时区无关）」+ 节假日日历，`nextSwitch` 按分钟向前扫描、每天只解析一次日期类型，因此节假日整段会被正确跳过（21 天上限）。
- **节假日** `lib/holidays.js`：`createCalendar({urls, fetchJson, storagePath, refreshMs, extraHolidays, extraWorkdays})`，逐个镜像尝试、每年一份内存缓存 + 磁盘缓存、失败只记录 `error` 不抛出；`fetchJson` 可注入，所以测试完全离线。
- **客户端** `lib/client.js`：单文件、只 `require('react')`，`inject: ['slots','locale']`，注册 `sidebar.panellist`（`order: 100`，最后一行 = 紧邻工作区上方）与同 id 的 `main` 面板；文案走 `ctx.locale.register('valley-meter', ...)`；样式通过组件内的 `<style>` 注入，只用 `--dsw-*` 主题令牌。
- 槽位里的组件不是 `panelRow` 的直接子节点：渲染器会在中间插一层 `<div data-slot="sidebar.panellist" style="display:contents">`（`dsh-client-ui-renderer` 的 `ANCHOR_STYLE`），所以我们落进的是 `button.panelRow > span.panelGlyph(aria-hidden) > div[data-slot] > span.vmx-root`。组件因此用**后代** `:has()` 兜住这一层：
  - `button:has(.vmx-root) > span:has(.vmx-root){flex:1 1 auto;min-width:0;container-type:inline-size}` —— 把装着我们那一格撑满整行；`button:has(.vmx-root) > span:first-of-type{...}` 作为 `flex-basis:auto` 在同一行时的兜底。
  - `button:has(.vmx-root) > span:not(:has(.vmx-root)){display:none}` —— 隐藏右侧的 `.panelTitle` 文字（也就是「峰谷电表」那四个字）。
  - 撑满后靠 `container-type:inline-size` + `@container (max-width:210px/150px)` 依次丢掉刻度和时段徽章。
  - 浏览器不支持 `:has()` 时会退化成「内容宽度 + 显示文字标题」，仍然可读。

## 测试

```bash
node test/host.test.mjs                       # 36 项：峰谷窗口、下次切换、周末规则、节假日日历、回环白名单
TZ=Asia/Shanghai node test/client.test.mjs    # 34 项：槽位注册、组件树、本地时间几何、日期类型、配色主题、三种状态
```

主机测试用注入的假 `fetchJson` 与假日历，覆盖：节假日整段跳过、节后第一个工作日恢复高峰、调休周六报 `workdayName` 但仍全天低谷、`nextSwitch` 跨过整个国庆假期（10-09 18:30 → 10-12 09:00，以及 09-30 18:30 → 10-08 09:00）、镜像逐个回退、年末日期查下一年、拉取失败只记录错误、磁盘缓存在断网时仍可用、缓存文件损坏被忽略。

客户端测试用一个极小的 React shim 直接渲染组件树，因此可以断言到「峰段落在本地 37.5%–50% 和 58.33%–75%」这种像素级结论，也能断言 24 小时刻度、余额回退、收起态圆点、15 套配色与当前选中的主题，以及休息日「峰段数为 0 + 徽章只剩 谷 + 标签为 周末 / 节假日名 / 调休上班」。它还包含一条针对上面那层 anchor `div` 的回归断言：样式表里必须出现 `button:has(.vmx-root) > span:has(.vmx-root)` 和 `button:has(.vmx-root) > span:not(:has(.vmx-root))`，且不得再出现早先那种写法的 `button:has(> span > .vmx-root)`。

## 来源与致谢

本项目是 [uckkk/dsh-valley-meter](https://github.com/uckkk/dsh-valley-meter)（作者 [istone](https://github.com/uckkk)，MIT）的**移植/衍生版**，不是从零开始的独立实现：

- 保留自原项目的部分：峰谷时段与价格判定口径、24 小时时间轴与刻度的交互形态、充值页跳转、配色主题的色板选择、`peakProgress` / `dayPeakSegments` 一类时间轴几何算法、以及大量中英文案。
- 本项目的改动：把控件从对话框区域搬到左侧边栏工作区上方；去掉已失效的 `dsh-typert-protocol` 远程通道与不存在的 `dsh-client-runtime` / `dsh-client-ui-slots` 依赖，主机侧改用内置 `webServer` 的回环 HTTP 路由、客户端轮询，运行时零依赖；新增节假日/调休感知（[NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)）；配色扩到 15 套并支持面板内切换与 `localStorage` 记忆；圆角卡通化外观。
- 如果您只想要原始形态（对话框上方悬浮、typert 远程通道），请直接使用上游仓库，或在旧版 DSH 上使用上游 `v0.1.6`。

致谢同样属于 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)：中国法定节假日与调休数据由该项目抓取国务院放假通知并整理，本插件只是消费它的 `{year}.json`。

## 许可证

[MIT](./LICENSE)。因为本插件包含原项目的代码与文案，`LICENSE` 里同时保留了上游的版权声明：

```
Copyright (c) 2026 istone <ad571@qq.com> — original project "dsh-valley-meter"
(https://github.com/uckkk/dsh-valley-meter)

Copyright (c) 2026 llluno <372592461@qq.com> — this port "dsh-valley-meter-sidebar"
```
