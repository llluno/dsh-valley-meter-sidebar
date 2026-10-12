# Changelog

本项目是 [dsh-valley-meter](https://github.com/uckkk/dsh-valley-meter) 的衍生版，版本号从 0.1.0 重新起算。

## 0.1.0 — 2026-10-12

首个公开版本：在 DSH `>= 0.2.0-rc.2` 上把原插件的峰谷电表搬进左侧边栏。

### 相对上游的改动

- **位置**：从 `conversation.input.dock`（对话框上方）改为侧边栏 `sidebar.panellist` 的最下方一行（`order: 100`），正好位于工作区区域（`sidebar.workspaces`）上方；同时注册同 id 的 `main` 面板，点击整条即打开完整详情页。
- **通道**：移除 `@deepseek-ai/dsh-typert-protocol` 远程通道（上游钉在 `0.1.1-rc.2`，已与当前 DSH 不兼容）与不存在的 `@deepseek-ai/dsh-client-runtime` / `@deepseek-ai/dsh-client-ui-slots` 客户端依赖；主机侧只用内置 `webServer` 注册 `GET /api/valley-meter/state`（仅限回环地址），客户端轮询。运行时零依赖。
- **形态**：圆角胶囊，底色随当前时段（峰/谷）取浅色；左侧 24 小时时间轴 + 当前时刻游标 + 00/06/12/18/24 刻度，右侧余额（点击打开充值页）；全部常驻显示，不需要悬停；侧边栏里不显示文字标题。
- **配色**：15 套（糖果 / 薄荷 / 樱花 / 蜡笔 / One Dark / 德古拉 / 北境 / 东京夜 / 复古 / 日光 / 琥珀黛蓝 / 赭石天青 / 绛纱墨青 / 靛墨潘通 / 自定义），面板内点选即时生效、侧边栏同步，选择存 `localStorage`。
- **节假日与调休**：接入 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)，法定节假日全天按低谷计费，调休上班的周末同样全天低谷；侧边栏显示 `周末` / 节假日名 / `调休上班` 标签，休息日的时间轴不再画任何峰段。数据 12 小时后台刷新并缓存到 `<DSH_HOME>/storages/valley-meter-sidebar/holidays.json`。
- **余额刷新**：上游余额 TTL 与本地轮询解耦（`refreshSec` 默认 300s / `pollSec` 默认 20s）；余额查询是账户接口、不消耗 token。
- **依赖**：`dsh.engines.dsh >= 0.2.0-rc.2`，唯一 peer 依赖 `react ^18.2.0`；无 `dependencies`。

### 已知限制

- 主机侧 `lib/index.js` 的改动需要重启 `dsh web` 才生效（DSH 的模块热重载默认只看 profile 配置，不看模块文件）；客户端 `lib/client.js` 会按文件时间戳自动换版本，刷新页面即可。
- 侧边栏收起成 56px 轨道时只保留一个带时段颜色的小圆点。
