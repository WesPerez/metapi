# mine 分支清理前变更记录

记录时间：2026-06-23。

本文件用于记录 `mine` 分支在重置为最新上游 `main` 前包含的自定义变更，方便后续需要时回查。清理目标是：保留界面显示与操作相关改动，以及“显示已启用模型”的后端接口；移除额外的调度、分发、协议兼容、路由 fallback、数据库策略迁移等后台逻辑。

## 基准引用

- 清理前 `mine` / `origin/mine`：`2ae0b4aebd243bcb795aa115e8548ac40ec14b66`
- 清理时最新 `upstream/main`：`e72d19e235289bd56be8aeb9166de82195db5e1e`
- 清理前本地备份分支：`backup/mine-before-cleanup-20260623`

## 清理前未提交内容

清理前工作区存在一组未提交改动，主要作用是撤销 HotaruAPI 专门兼容逻辑，并新增一条 endpoint 降级判断：

- 删除 `docs/hotaruapi-codex-integration.md` 及文档入口。
- 删除 `src/server/services/hotaruApiCompatibility.ts`。
- 删除 HotaruAPI 相关 endpoint 顺序与请求体整形测试。
- 从 `upstreamEndpointDerivation` 和 `upstreamRequestBuilder` 移除 HotaruAPI 特判。
- 在 `endpointCompatibility` 中将 `403 image generation is not enabled for this group` 视为可降级错误。

这些未提交内容不进入清理后的 `mine` 主线，仅保留在备份分支中。

## 计划保留的内容

以下内容会在清理后作为一个综合提交重新落到 `mine`：

- 账号/API Key 管理界面增强：筛选、分页、显示禁用项开关、批量启用/禁用、状态切换、列宽与横向滚动优化。
- 站点管理界面增强：名称/URL 分列、状态点击切换、操作列宽度、禁用模型显示与保存体验。
- 日志和模型可见性相关界面调整：日志页面显示改进、模型页和账号页的可见模型信息展示。
- 侧边栏 API Key 管理入口。
- 列表排序辅助逻辑：禁用记录后置。
- “显示已启用模型”的后端接口与服务：`enabledModelsSummaryService` 及 `sites` API 中对应输出。
- 构建镜像所需的 `mine` 分支远程 CI workflow。

## 计划移除的后台逻辑

以下内容属于调度、分发、协议兼容、路由 fallback 或运行时行为改造，不进入清理后的 `mine` 主线：

- 原生 endpoint routing policy：
  - `drizzle/0027_token_route_endpoint_policy.sql`
  - token route endpoint policy 字段、数据库 schema/generated SQL/schema contract 变更
  - `tokenRouter`、`channelSelection`、`endpointProtocol` 相关逻辑
  - Token Routes 页面中的 endpoint policy 配置 UI
- AnyRouter / New API / HotaruAPI 兼容逻辑：
  - `anyrouterClaudeCompatibility`
  - HotaruAPI Codex Responses 适配
  - Responses 请求自动补 `reasoning.encrypted_content`
  - 删除 `stream_options`
  - 压平 `input_image.image_url`
  - Claude Code system marker 注入
- 上游 endpoint 派生与 fallback 行为改造：
  - `upstreamEndpointDerivation`
  - `upstreamRequestBuilder`
  - `siteApiEndpointService`
  - `modelPricingService` 中用于调度决策的扩展
  - proxy responses/chat count_tokens fallback 相关测试和实现
- 后台任务开关：
  - `DISABLE_BACKGROUND_TASKS`
  - server index 中后台任务启动逻辑调整
- 告警自动处理例外：
  - Volcengine Ark 站点跳过 token-expired 自动标记
- 协议兼容排查文档：
  - `docs/protocol-compatibility-review.md`
  - `docs/hotaruapi-codex-integration.md`
- 每日 upstream 自动同步 workflow：
  - `.github/workflows/mine-sync-upstream.yml`

## 清理前提交清单

- `28ae923` ci(mine): add GHCR docker build workflow for mine branch
- `97238a3` ci(mine): add daily upstream sync workflow
- `fce8b31` fix(mine): inject reasoning.encrypted_content include for anyrouter responses
- `30da1b3` fix(mine): drop stream_options for anyrouter responses requests
- `e8588ed` fix(mine): flatten input_image.image_url object form for anyrouter
- `52f5b25` fix(mine): inject Claude Code system marker for new-api family *-cc channels
- `b469977` docs: document protocol compatibility review
- `578edca` feat: add native endpoint routing policy
- `1dc4d0b` feat(mine): improve logs and model visibility
- `59560ed` feat(mine): move disabled records last
- `da659b6` feat(mine): add apikey status toggle
- `18feed0` feat(sidebar): add API Key management quick link under console
- `f478a4e` fix(proxy): support hotaruapi codex responses
- `71c56b9` feat(server): allow disabling background tasks
- `c84948f` Fix Claude count_tokens fallback
- `4ab3bf1` feat: 站点管理和APIKEY管理增强
- `62ff4dd` fix: 修复APIKEY管理和日志管理问题
- `645710f` fix: APIKEY管理分页始终显示
- `7be2355` Add API key pagination
- `8e4cf37` style(accounts): widen 非禁用模型 column and shrink 签到 column
- `80352b0` style(sites): split name/URL columns, clickable status, fixed action width
- `d8495e9` fix(alert): skip auto token-expired marking for volcengine ark sites
- `fbd3105` fix(accounts): tighten apikey table column rendering
- `a77ed21` fix(accounts): widen connection name column, trim actions column whitespace
- `911314a` fix(accounts): widen connection name column by ~20% only
- `575afd4` feat(accounts): promote site column to first place on apikey segment with bold gradient badge
- `bb6fe91` feat(accounts): apikey filters with site/model dropdowns, show-disabled toggle and bulk enable/disable
- `4cb17be` feat(ui): align apikey status column with sites toggle and reflow bulk buttons
- `2df2ba6` fix(accounts): add horizontal scroll to apikey/accounts table card
- `7791141` Improve upstream routing failure handling
- `11c4209` Handle AnyRouter Claude models via Messages API
- `2ae0b4a` Show enabled models for all account segments

## 回查方式

查看清理前完整代码：

```bash
git switch backup/mine-before-cleanup-20260623
```

查看某个文件在清理前的内容：

```bash
git show backup/mine-before-cleanup-20260623:path/to/file
```

比较清理前 `mine` 与最新上游 `main`：

```bash
git diff upstream/main...backup/mine-before-cleanup-20260623
```
