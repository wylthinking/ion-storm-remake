# 《离子风暴》代码与框架分析（接手文档）

> 本文面向"第一次接手本项目"的开发者，目标是把**现有代码的真实结构、约束、陷阱和改动入口**讲清楚，便于后续修改与设计。
> 所有结论均基于仓库当前源码，关键处标注 `文件:行号`。
> 项目自身已有三份权威文档：[README.md](./README.md)（能力与结构概览）、[DEPLOYMENT.md](./DEPLOYMENT.md)（部署）、[json/CUSTOM_GAME_JSON_SPEC.md](./json/CUSTOM_GAME_JSON_SPEC.md)（自定义规则 JSON v4 规范）。本文不重复它们，而是补充**实现层面的地图**。
>
> **阅读指南**：只想快速了解全貌 → §0 + §2 + §17；准备改功能 → §15 + §16；准备做重构或排查线上问题 → §14（技术债清单，含实测确认的缺陷）+ §7.3（Node/Worker 分歧）；准备深入引擎 → §4 + §5。

---

## 0. 快速结论（TL;DR）

| 维度 | 结论 |
| --- | --- |
| 项目性质 | 多人化学卡牌网页游戏，**单仓库、单语言（TypeScript）、三运行环境**：浏览器 / Node.js / Cloudflare Workers |
| 依赖极简 | 运行时仅 3 个依赖：`express`、`ws`、`redis`；前端**无框架**（无 React/Vue），Vite 仅做打包 |
| 核心设计 | **服务端权威**。所有对局逻辑在 `src/shared/` 的纯函数引擎里，客户端只做渲染 + 发意图 |
| 最重要抽象 | `src/shared/ruleset.ts` —— 经典/自定义双引擎的统一门面（facade），118 行，客户端与服务端都经由它调用引擎 |
| 两套引擎 | `engine.ts`（经典 37 张牌硬编码，1878 行）、`custom-engine.ts`（JSON 驱动解释器，2811 行） |
| 双后端 | `src/server/*`（Express + ws + Redis/内存）与 `worker/index.ts`（2 个 Durable Object + 3 个 KV）**功能对齐、代码不共享** |
| 代码形态 | 源码合计 **35,159 行**；5 个文件占 **~70%**：`app.ts` 9226、`worker/index.ts` 5402、`styles.css` 3553、`users.ts` 3051、`custom-engine.ts` 2811 |
| 测试 | **零测试文件**（`glob **/*.{test,spec}.ts` 无结果）；仅 `advanced-ai.ts:658` 暴露了 `advancedAiTestHelpers` |
| 最大技术债 | ① 客户端 100+ 个可变全局变量 + 全量 `innerHTML` 重渲染；② Worker 与 Node 逻辑复制粘贴；③ 无测试 |
| 新增功能的正确入口 | 几乎总是：先改 `src/shared/` → 再改 `src/server/` **和** `worker/` **两份** → 最后改 `src/client/app.ts` |
| 最危险的一处 | `users.ts:2127-2136` 的 `catch { return [] }` —— 用户数据文件损坏会被静默当作"空库"，重建默认管理员 `admin/admin` 并**覆盖原文件**（详见 §14 P0-1） |

---

## 1. 技术栈与工程配置

### 1.1 依赖（`package.json:17-33`）

```
运行时：express ^4.19.2 · redis ^4.7.0 · ws ^8.18.0
开发时：typescript ^5.7.2 · tsx ^4.19.2 · vite ^8.2.1 · wrangler ^4.120.0 · @types/*
要求 Node >= 20
```

设计特征：**刻意保持零依赖膨胀**。没有状态管理库、没有 UI 框架、没有测试框架、没有 lint 配置、没有 CI 配置。这意味着新增任何"框架级"依赖都需要先得到明确同意。

### 1.2 三份 tsconfig 对应三种产物

| 文件 | 目标 | include | 说明 |
| --- | --- | --- | --- |
| `tsconfig.json` | 仅类型检查（`noEmit`） | `src` | 基准配置，`strict: true`、`target: ES2022`、`module: ESNext` + `moduleResolution: Bundler` |
| `tsconfig.server.json` | 产出 `dist/server` | `src/server`, `src/shared` | 关键差异：`module/moduleResolution: NodeNext`，**因此 shared 里所有相对 import 必须写 `.js` 后缀** |
| `tsconfig.worker.json` | 仅类型检查 | `worker/**/*.ts`, `src/shared/**/*.ts` | 排除 `src/client` 与 `src/server` |

> ⚠️ **最重要的编码约定**：`src/shared/**` 会被 Node（NodeNext）和浏览器（Bundler）**同时**消费，所以相对导入一律写 `.js` 后缀（如 `import { createGame } from "./engine.js"`）。新增 shared 文件时若漏写后缀，`npm run build` 会在 `tsc -p tsconfig.server.json` 阶段失败。

### 1.3 构建流水线（`package.json:6-16`）

```
npm run dev    = sync:ai-weights → sync:custom-json → vite --host 0.0.0.0
npm run build  = sync:ai-weights → sync:custom-json → tsc → vite build → tsc -p tsconfig.server.json
npm run worker:deploy = worker:build (= build + tsc -p tsconfig.worker.json) → wrangler deploy
npm start      = node dist/server/server.js
```

**两个"构建期代码生成"步骤**（这是本项目独有的、新人最容易困惑的机制）：

1. `scripts/sync-advanced-ai-weights.ts`：把 `src/shared/advanced-ai-weights.json`（人工可调参数）内联为 `src/shared/advanced-ai-weights.generated.ts` 常量。因为 Workers/浏览器 worker 不适合运行时读 JSON。
2. `scripts/sync-custom-json.ts`：读取 `json/all-cards-classic-deck.json` + `json/cards/*.json`（每张卡一个片段文件），用**真正的解析器** `parseCustomRules` 解析校验后，序列化为 `src/shared/generated/custom-json.generated.ts` 里的 `PLATFORM_PRESET` 常量（`deepFreeze`）。

   这带来一个很好的性质：**构建期就完成了规则校验**。JSON 写错 → `npm run dev` 直接失败，不会到运行时才炸。

> ⚠️ 手改 `src/shared/generated/custom-json.generated.ts` 或 `advanced-ai-weights.generated.ts` 会在下次构建被覆盖。要改规则请改 `json/`，要改 AI 参数请改 `advanced-ai-weights.json`。

### 1.4 静态资源与部署形态

- **前端产物**：`dist/client`（Vite，SPA，输入 `index.html`）。
- **Node**：`dist/server/server.js` 同时做 API + WebSocket + 静态托管；开发模式下内嵌 Vite middleware（`server.ts:915-921`）。
- **Worker**：`wrangler.toml` 中 `[assets] directory = "./dist/client"`，`run_worker_first = true`，`not_found_handling = "single-page-application"`。

---

## 2. 目录结构与分层

```
index.html                 单页入口，挂载 #app，脚本为 /src/client/app.ts
src/client/                浏览器层
  app.ts          (9226 行) 全部 UI + 客户端状态 + socket + 本地对局编排 ★最大文件
  styles.css      (3553 行) 全部样式
  advancedAiWorker.ts (25 行) Web Worker：调用 shared/advanced-ai（**唯一在用的 Worker**）
  botWorker.ts         (9 行) ⚠️ **死代码**：全仓库无任何地方实例化它，也不进产物
src/server/                Node 后端
  server.ts       (2222 行) Express 路由 + WebSocket + 对局驱动 + 计时器
  users.ts        (3051 行) 账户/权限/邀请/激活/工单/积分/音效存储（含 Redis + 文件）
  store.ts         (178 行) 房间存储（内存 Map + Redis 镜像，TTL 600s）
src/shared/                三端共用的纯逻辑（无 I/O、无 DOM、无 Node API）
  types.ts         (381 行) 两套状态机的类型根
  engine.ts       (1878 行) 经典引擎
  custom-engine.ts(2811 行) JSON 规则解释器
  custom-rules-parser.ts (896) / custom-rules-types.ts (554) / custom-rules-merge.ts (76)
  ruleset.ts       (118 行) 双引擎门面 ★
  cards.ts / formula.ts     经典牌库与化学式
  custom-formula.ts (333)   公式白名单求值器
  custom-card-registry.ts   规则 → 反应表索引
  custom-limits.ts          自定义模式额度模型
  bot.ts (45) / advanced-ai.ts (662)   AI
  room-limits.ts (215)      房间参数约束（底注/手牌/决斗）
  tax.ts / banker.ts / point-distribution.ts / custom-settlement.ts  经济与结算
  game-log.ts / spreadsheet-safety.ts  对局 CSV 日志与公式注入防护
  action-security.ts        操作意图白名单校验（防状态注入）
  http-security.ts          URL/静态资源防护（三端共用）
  stable-json.ts            稳定序列化 + 纯 TS SHA-256 + deepFreeze
  victory-music.ts / music-access.ts   胜利音效解析与权限
json/                      构建期数据（不参与运行时 import，除 ?raw）
  all-cards-classic-deck.json, cards/*.json, custom-game-template.json, CUSTOM_GAME_JSON_SPEC.md
worker/index.ts  (5402 行) Cloudflare Worker + Durable Objects
scripts/                   两个构建期生成脚本
```

### 2.1 依赖方向（已实测）

```
client ──► shared (ruleset/engine/custom-engine/cards/game-log/…) + json/*.json?raw
server ──► shared + ./store + ./users
worker ──► shared（不 import server/*，但复制了 server 的行为）
shared ──► shared（types ← custom-rules-types ← stable-json）
```

**没有任何反向依赖**，`shared` 不知道 `server`/`client`/`worker` 的存在。这是本项目最健康的一条边界，务必保持。

### 2.2 `ruleset.ts`：必须理解的 118 行

`src/shared/ruleset.ts` 是双引擎的统一入口。因为两种 `GameState` 形状不同（`GameState` vs `CustomGameState`），所有调用方都通过它而不是直接调 `engine`/`custom-engine`：

| 门面函数 | classic 分支 | custom 分支 |
| --- | --- | --- |
| `createRulesetGame` | `createGame` | `createCustomGame` |
| `applyRulesetAction` | `applyAction` | `applyCustomAction` |
| `publicRulesetGame` | `publicGame` | `publicCustomGame` |
| `enumerateRulesetActions` | `enumerateActions` | `enumerateCustomActions` |
| `rulesetCurrentPlayer` | `currentPlayer` | `currentCustomPlayer` |
| `advanceRulesetOpeningTimeout` | `finishOpeningExchange` | `applyCustomOpeningTimeout` |
| `randomRulesetTimeoutAction` | `autoplay` | `randomCustomTimeoutAction` |
| `createRulesetRematch` | `createLocalRematch` | `createLocalCustomRematch` |

调用方：`server.ts:14`、`app.ts:31`（实测均在用）。**新增对局能力时，默认应先在 `ruleset.ts` 加门面函数**，让两边都走同一条路径。

---

## 3. 数据模型

### 3.1 经典模式（`types.ts:84-110`）

```ts
GameState {
  id, status: "lobby"|"opening-exchange"|"playing"|"ended",
  mode: "local"|"online", revision, players: PlayerState[],
  zones: { solution: CardId[], products: ProductGroup[], discard: CardId[], drawPile: CardId[] },
  currentPlayer: number,          // 座位号
  startingSeat, direction: 1|-1,
  actionPoints,                   // 出牌机会
  turnStartedAt, turnDeadlineAt, turnTimeLimitMs, openingExchangeWindowMs,
  winnerId, pendingDraw?, pendingChoice?, openingExchange?, scoring?,
  log: string[],                  // 人类可读日志
  eventLog?: GameEventLogEntry[], // 结构化日志（CSV 导出用）
  logScoreMultiplier?, rngSeed
}
```

关键子结构：
- `ProductGroup`（`types.ts:23-31`）：生成物区的一组牌，`kind` 是化学结果类型（`solid|gas|weak|nonexistent|micro|special`），可带 `radiationLeft`（铀衰变）与 `ownerPlayerId`。
- `PendingDrawState`（`types.ts:160-181`）：加牌流程（"摸 N 张，可跟牌/抵挡"）——本项目最复杂的状态机之一。
- `OpeningExchangeState`（`types.ts:151-158`）：开局换牌 + 开局加倍。
- `GameScoringState`（`types.ts:134-149`）：底注/倍率/税收/自定义缩放。

### 3.2 自定义模式（`types.ts:263-364`）

`CustomGameState` 用**实例牌**替换裸 `CardId`：

```ts
CardInstance { instanceId, cardId, marks: CardMark[], counters: Record<string,number>, ownerPlayerId?, source? }
```

即自定义模式下每张牌是**有身份的实体**（因为规则可以给具体某张牌挂标记、加计数器），而经典模式是纯字符串。这是两套引擎无法合并的根本原因，也是设计新功能时必须先问的第一个问题：**这个功能需要卡牌实例身份吗？**

`CustomRuntimeState`（`types.ts:339-354`）保存引擎运行时：`rulesHash`、`instanceSeq`、`batchSeq`、`rngState`、`deferredTriggers`、`audioEvents`、`inspectReveals`、`settlementLoserCap`。注意 `settlementCapByPlayerId` 已标注为**兼容旧房间的遗留字段**，新对局只写 `settlementLoserCap`。

---

## 4. 经典引擎（`src/shared/engine.ts`，1878 行）

### 4.1 化学模型（`cards.ts`）

- **牌库**：14 阳离子 + 10 阴离子 + 2 特殊（Au 金、U 铀）+ 11 功能牌 = **37 种，共 130 张**（`INIT_CARD`，`cards.ts:138-176`）。
- **反应表**：四张邻接表决定任意两离子的反应结果——`TO_GAS`/`TO_SOLID`/`TO_MICRO`/`TO_WEAK`/`TO_NONEXISTENT`（`cards.ts:205-242`），由 `mapPairs` 自动生成双向索引。
- **优先级**：`reactionKind()` 的查表顺序即优先级（gas → solid → micro → weak → nonexistent，`cards.ts:293-300`）。
- **配平**：`balance(a,b)` 用 `gcd` 算电荷配平比（`cards.ts:302-308`）。
- **强酸制弱酸顺序**：`WEAK_ACID_STRENGTH`（`engine.ts:33-40`），数值越小酸性越强，硬编码在引擎而非 `cards.ts`。

### 4.2 公共 API（仅 23 个导出符号）

```
常量：TURN_MS(60s) OPENING_EXCHANGE_MS(15s) AUTOMATED_ACTION_DELAY_MS(1s)
     MIN_INITIAL_HAND_SIZE(2) CHEMISTRY_WEAK_ACID_*
函数：createGame / cloneGame / createLocalRematch / finishOpeningExchange
     enumerateActions / applyAction / autoplay / autoplayBotTurns
     findReactionTargets / drawCards / currentPlayer / publicGame
     previewEnoughReactionCount / previewFunctionCardEffect
     maxInitialHandSize / recommendedHandSize
```

**纯函数不变式**：`applyAction(game, ...)` 第一行就 `cloneGame(input)`（`engine.ts:260`），返回**新状态**，绝不修改入参。`structuredClone` 是唯一的深拷贝手段（`engine.ts:188-190`）。这意味着每次操作拷贝整个对局状态——对局规模小（130 张牌）时可接受，但这是性能特征，改动时不要引入"原地修改 + 忘记通知"的 bug。

### 4.3 内部子系统（按行号）

| 行号 | 子系统 |
| --- | --- |
| 423-520 | 事件日志（`appendGameEvent`/`beginActionEvent`/`finalizeActionEvent`） |
| 607-723 | 开局换牌与加倍（`resolveOpeningExchange`/`expireOpeningDecisions`/`completeOpeningExchange`/`dealOpeningExchangeDraws`） |
| 737-853 | 反应结算（`resolveIon`/`resolveReactionTarget`/`stabilizeTableReactions`/`findNextTableReaction`） |
| 854-1043 | 功能牌（`resolveFunction`/`resolveStrongReagent`/`beginEnoughSelection`/`resolveEnoughChoice`/`resolveImpurity`/`resolveImpurityChoice`） |
| 1044-1296 | 场面移除与再平衡（`removeProductsBy`/`removeAllReactiveIons`/`rebalanceMicroProducts`/`resolveAddSodium`） |
| 1297-1490 | 回合与摸牌流程（`triggerTurnStart`/`applyTurnStartRadiation`/`spendActionPoint`/`advanceToNextPlayer`/`queueDrawOrSpend`/`resolveFollowFunction`/`resolveCounterDraw`） |
| 1500-1585 | 金/铀后效延迟结算（`applyPostDrawEffects*`） |
| 1586-1706 | 工具（`buildReaction`/`makeProduct`/`createDeck`/`shuffle`/`recycleDiscard`） |
| 1707-1878 | 评分与日志（`scoreAction`/`markTimeout`/`addScore`/`doubleScore`/`trimLog`） |

> ⚠️ `enumerateActions`（`engine.ts:216-257`）会为**每种可能的出牌数量 × 每个合法目标**生成一个动作。它是 AI、超时托管、客户端提示的共同基础，所以**它必须便宜**。而 `action-ranking.ts:33,47` 为了判断"这个动作是否有效"直接调用了 `applyAction`（即完整克隆 + 模拟），这在动作多时是明显的性能热点。

### 4.4 超时与托管

- `markTimeout`/`markNormal`（`engine.ts:1748-1777`）维护 `timeoutStreak`/`normalStreak`，连续超时触发 `forcedAutoplay`。
- 服务端/Worker 侧的计时推进在 `server.ts:1722+`（`advanceRoomIfNeeded`）与 `worker/index.ts:3281`。
- 本地对局的机器人调度在客户端：`app.ts:6105`（`maybeRunBot`）+ `localBotTimer`。

---

## 5. 自定义规则引擎（JSON v4）

### 5.1 管线

```
json/all-cards-classic-deck.json + json/cards/*.json
   │  （构建期）
   ▼
parseCustomCardFragment / parseCustomRules        custom-rules-parser.ts (855 行)
   │  严格校验：version → preset 链 → 合并(merge) → 卡牌类型 → 引用 → 公式编译
   │           → step 判别联合 → event/cause → audio → setup/deal → 牌堆数量
   │           → 归一化 → stable hash → deepFreeze
   ▼
ResolvedCustomRules（含 hash）                     custom-rules-types.ts (554 行)
   │
   ├─► PLATFORM_PRESET 常量（生成的 .ts）
   └─► createCustomCardRegistry()  规则 → 反应索引
          │
          ▼
   createCustomGame / applyCustomAction / enumerateCustomActions    custom-engine.ts (2811 行)
```

**严格解析是硬约束**（规范 §9，`CUSTOM_GAME_JSON_SPEC.md:314-318`）：未知 `op/when/cause/reactionResult/type` 一律报错，禁止静默忽略。

### 5.2 JSON 顶层结构

```jsonc
{
  "version": 4, "name": "...", "displayName": "...", "preset": "可选预设 id",
  "setup":  { "players": 2|[min,max], "baseBet", "initialHand"≥2,
              "initialHandByPlayers": {"2".."10": n},
              "disableOpeningExchange": bool, "allowWangZha": bool },
  "cards":  { "<id>": CustomCardDef },     // 键即程序 ID
  "combos": { "<id>": CustomComboDef },
  "deck":   { "cards": {id:count}, "deal": [ {seat,fixed,fill} ], "byPlayers": {...} },
  "display":{ "autoStack": bool, "maxStack": n, "order": [id...] }
}
```

**卡牌只有四种类型**：`ion` / `operation` / `special` / `generic`（`custom-rules-types.ts:7-8`）。

### 5.3 步骤（op）指令集

引擎是一个**解释器**，`CustomStep` 是判别联合（`custom-rules-types.ts:67-140`）。已实现的 op（规范 §5）：

```
action · audio · cancelDraw · choose · counter · draw · drawFlow · drawWhere
flushDeferred · if · inspect · move · play · pot · reactSweep · remove
reverse · score · skip
```

重点语义（改动前必读规范对应章节）：
- `drawFlow` = 经典"加牌流程"，`follow:true` 只对**产生该流程的那一个步骤**生效（步骤级，不是卡牌级；旧顶层 `follow` 仅作兼容回退）。
- `reactSweep` = 通用化学反应扫描（`virtual` 表示试剂不来自手牌；`mode:"enough"` 足量；`repeat:"stable"` 连锁至稳定）。
- `remove` 与延迟后效（`custom-rules-types.ts:130` 的 `deferCardTriggers` + `flushDeferred`）。
  ⚠️ **实测缺陷**：`deferCardTriggers` 只在解析期被校验（`custom-rules-parser.ts:347,357`）、在 `custom-engine.ts:1998` 被写入 `ctx.allowDefer`，但**运行时从不读取**（全仓库 grep `allowDefer` 只有声明处 `:536` 与赋值处 `:1998`）。而官方预设里 `"deferCardTriggers": true` 真实出现在 4 处（`generated/custom-json.generated.ts:787,814,1063,1090`）。同理 `reactSweep.virtual`（`:117`）与 `reactSweep.mode:"enough"` 也只有解析、无运行时读取，而 `virtual:true` 是强酸/强碱的定义方式（`generated:540,562`）。**即规范 §5 中"先完成操作牌主要摸牌，再结算金/铀后效"的经典顺序，在自定义引擎里目前并未按 JSON 声明生效**——这是一处规范与实现漂移，改动自定义引擎时应优先核实。
- `choose` 把选中的玩家/牌存进命名变量，后续 `target`/`to`/`scoreTo` 用变量引用。

### 5.4 事件与标记

- 事件类型（`custom-rules-types.ts:47`）：`turn.started`、`self.removed`、`marked.removed`、`marked.reacted`、`card.playedBatch`。
- 移除原因 `CustomRemoveCause`：`reaction | operation | rule | other`。
- `CardMark` 可带 `reactionPriority`（-100..100）——同名牌中优先被反应移除（Hat 的"大恶霸"= 1）。

**⚠️ 运行时"事件总线"其实是 5 个硬编码派发点**（没有通用事件表，新增事件类型必须找齐这些位置）：

| 事件 | 派发函数 | 触发绑定 |
| --- | --- | --- |
| `turn.started` | `fireTurnStarted:1248-1276` | 场上所有 `type:"special"` 的 `on` 监听器（逐个校验实例仍在场） |
| `marked.reacted` | `dispatchMarkedReacted:559-584` | 被移除牌的 `marks`；调用点 `:896`（定点反应）、`:2012`（`remove`）、`:1790`（`reactSweep`） |
| `marked.removed` | `dispatchRemoval:586-610` | `marks.splice(0)` 消费，**保证只触发一次**，且**立即执行**（不受延迟影响） |
| `self.removed` | `dispatchRemoval:611-623` | `special.on`；若 `phase:"afterOperationPrimaryEffect"` 且有 `context.exec` → 压入 `exec.deferred`，否则立即执行 |
| `card.playedBatch` | `dispatchPlayedBatch:651-703` | mark 监听器（**要求 `where.name === "marked.name"`**）+ 场上 `special.on`（`matchCount` 恒 0）；四条出牌路径调用（`:2507/2524/2542/2571`），**`play` 步骤不触发** |

**优先级机制只有两种**：mark 的 `reactionPriority`（决定同名牌被反应移除时的挑选顺序，`:507-529`，同优先级后进先出）与监听器数组的声明顺序。**没有其他优先级、中断或否决机制。**

**延迟后效**：`ExecContext.deferred` → `flushExecDeferred:1839-1844`；`flushDeferred` 步骤可显式提前冲刷；`finishOperation:2605` 在操作牌收尾时兜底冲刷。`scoreTo` 覆盖通过保留变量 `vars.__scoreTo` 传递。

**选择与续跑**：`suspendForChoice:1492-1502` 把 `pc` 回退一格并把 `serializeExec(ctx)` 存进 `pendingChoice.continuation`；`resolveCustomChoice:2462-2499` 回填 `vars` 后 `runSteps(ctx)` 续跑。引擎用**保留标识符**实现内置选择：`__reactionInstance`/`__reactionTargets`/`__reactionTargetLabels`（`:1743-1748`，还伪造一个 `as === "__reactionTarget"` 的伪步骤）、`__inspectPlayer`、`__scoreTo`。

### 5.5 公式求值（`custom-formula.ts`，333 行）

白名单解析器，**明确禁止 `eval`/`Function`**（规范 `CUSTOM_GAME_JSON_SPEC.md:146`）。支持 `+ - * / ^ ( )` 与 `ceil/floor/round/min/max/abs`（另有一个需要宿主回调的 `next(seat)`）。变量如 `players`、`stake`、`bet`、`self`、`self.counter.<name>`、`event.matchCount`、`event.actor`、`field.products.blockingForDistill`、`draw.source`，以及 `vars` 绑定的扫描结果 `r.cards`/`r.groups`/`r.specialGroups`/`r.name`。

**沙箱护栏（设计扎实，值得保持）**：无 `eval`/`Function`（`:223-236`）；源码级黑名单 `eval|Function|prototype|__proto__|constructor`；文本 ≤512 字符、token ≤64、AST 深度 ≤12；求值递归深度 ≤48；除零抛错、指数 ≤64、结果须有限且 `|结果| ≤ 1e9`；计数公式额外要求非负且 ≤130。解析期即编译（`assertFormula`），语法/未知函数在加载期就被拒。

**残余问题**：① 黑名单是**子串匹配**，会误伤含 `constructor` 的合法变量名（不会漏放，因为没有函数值可达路径）；② ⚠️ `compileCached` 名字骗人、**实际不缓存**（`custom-engine.ts:397-399`），每次求值都重新编译；③ 越界时抛错会穿透到调用方（见 §14 P0-10）。

### 5.6 额度与配额

自定义模式的经济约束是可配置的（`custom-limits.ts`）：

```ts
CustomMaxBaseBetRule   = {mode:"absolute",value} | {mode:"classic-multiple",factor} | {mode:"unlimited"}
CustomSettlementCapRule= {mode:"absolute",value} | {mode:"base-bet-multiple",factor} | {mode:"unlimited"}
```

结算函数 `calculateCustomSettlement`（`custom-settlement.ts:11-27`）保证**零和**：按开房者额度封顶每名输家扣分，赢家拿全部实际扣分，并返回 `capScale` 供日志展示。

**技术配额集中在 `CUSTOM_LIMITS`**（`custom-rules-types.ts:536-554`，注释明确"Node / Worker / client 共用"），是防病态规则集的第一道防线：

| 配额 | 值 | 强制点 |
| --- | --- | --- |
| `maxDocumentBytes` | 512KB | 解析期（文本与归一化后各测一次）；HTTP 层放 128KB 余量（`server.ts:66`） |
| `maxCardDefinitions` | 128 | `parser:632` |
| `maxAudioBytesPerCard` / `maxAudioBytesTotal` | 256KB / 1MB | `parser:386/389` / `parser:821-823` |
| `maxStepsPerCard` / `maxIfDepth` / `maxMarkListenersPerCard` | 64 / 8 / 16 | `parser:222/221/186` |
| `maxFormulaTokens` / `AstDepth` / `Exponent` / `AbsValue` | 64 / 12 / 64 / 1e9 | `custom-formula.ts` |
| `maxDynamicDraw` | 130 | 公式计数上限 / `drawWhere.pick` / `choose.count` / `perPlayerCap` |
| `maxChainReactions` | 64 | 连锁守卫（`custom-engine.ts:955/1041/1777`，超限写日志） |
| `maxPresetDepth` | 8 | `parser:569`（另有循环引用检测） |
| `allowedAudioMime` | 7 项 | `parser:384` |
| `maxEventsPerAction` | 256 | ⚠️ **全仓无引用（死配额）** |

其他散落硬上限：牌堆总数 ≤1000、`inspectReveals` ≤30（`custom-engine.ts:1700`）、`log` ≤120 行、组合枚举 ≤256（`:2076`）、开局超时兜底循环 ≤10（`:2701`）。

**缺口**：`action.add` 无累计上限（只受手牌/牌堆物理上限约束）；`ExecContext.depth` 只累加不校验（**规则层无循环结构，但 `if` 分支挂起缺陷可造成重复执行**，见 §14 P0-11）；`eventLog` 与 `audioEvents` 无裁剪。

---

## 6. 三端通信协议

### 6.1 HTTP API（Node 共 60+ 路由，Worker 一一对应）

分组（Node 行号见 `src/server/server.ts`）：

| 分组 | 路由 | 行号 |
| --- | --- | --- |
| 认证 | `POST /api/auth/register` `/login` `/logout`、`GET /api/auth/me` | 82-125 |
| 高级 AI | `POST /api/advanced-ai/access` | 126 |
| 安全日志 | `GET /api/security-logs/:id` | 136 |
| 用户 | `GET /api/users`、`PATCH/DELETE /api/users/:id`、`POST /api/users/points/bulk`、`GET /api/users.csv` | 150-235 |
| 专属房号 | `GET/POST /api/users/:id/reserved-room-codes`、`PATCH/DELETE .../:code` | 236-283 |
| 邀请码 | `GET/POST /api/invitations`、`DELETE /api/invitations/:code` | 284-312 |
| 激活码 | `GET/POST /api/activations`、`DELETE /:code`、`POST /redeem`、`/redeem/prepare` | 313-366 |
| 权限/额度 | `GET/PATCH /api/permissions`、`/api/custom-mode-limits` | 367-404 |
| 税收 | `GET/PATCH /api/tax-settings` | 405-501 |
| 自定义预设 | `GET /api/custom-presets`、`/enabled`、`/enabled/:id`、`POST /preview`、`POST`、`POST /:id`、`/:id/duplicate`、`DELETE /:id` | 414-491 |
| 工单 | `GET/POST /api/requests`、`/ack`、`/:id/respond` | 502-540 |
| 胜利音效 | `GET/POST/DELETE /api/users/:id/music`、`GET /api/music/manifest` | 179-192, 541-585 |
| 房间 | `POST /api/rooms` | 586 |
| 房间内 | `GET /api/rooms/:code`、`/rules`、`/state`、`POST /join`、`/start`、`/action`、`/cancel-autoplay`、`/bots`、`/kick`、`/edit`、`/leave`、`/heartbeat` | 699-904 |
| 排行榜 | `GET /api/leaderboard` | 170 |

### 6.2 WebSocket（`server.ts:53`，路径 `/ws`，`maxPayload` 限制）

客户端 → 服务端（`server.ts:1054-1198`）：

```
joinRoom · refreshState · gameStartedAck · cancelAutoplay · startGame
submitAction · botAction · addBot · kickPlayer · editRoom · leaveRoom
heartbeat · leaveSeat
```

服务端 → 客户端（节选，`server.ts:1864`, `1889`, `1703`）：

```
gameState · roomState · actionRejected · startAckRequired · …
```

`sendToPlayer(code, playerId, type, payload)`（`server.ts:1889`）是统一出口，广播走 `broadcastRoom`。

### 6.3 客户端的降级策略

`app.ts` 实现了**双通道**：WebSocket 优先，失败后 `startHttpFallback`（`app.ts:5428`）切到 HTTP 轮询（`pollRoomState`，`app.ts:5565`），`sendOnlineMessage`（`app.ts:5607`）统一封装"WS 优先、HTTP 兜底"。另有 `ensureHttpPolling`、`startReconcilePolling`（对账轮询）、`startHeartbeat`、`syncServerClock`（服务端时钟对齐，用于本地倒计时）。

---

## 7. 双后端：Node 与 Cloudflare Workers

### 7.1 对照表

| 关注点 | Node (`src/server/`) | Worker (`worker/index.ts`) |
| --- | --- | --- |
| 路由 | Express，`app.get/post/patch/delete` | 手写 `if (url.pathname === ... && method === ...)` 链（`1717-2440`） |
| 账户权限 | `users.ts` 的 `UserStore` 类 | `AccountState` Durable Object（`438-1037`）+ `memory.adminState` 请求级缓存 |
| 房间 | `store.ts` 的 `RoomStore`（Map + Redis 镜像，TTL 600s） | `RoomState` Durable Object（`1038-1716`） |
| 会话 | `users.ts` | KV `ION_SESSIONS`（TTL 14 天，`370`） |
| 实时 | `ws` 库，`WebSocketServer({server, path:"/ws"})`，`sockets: Map<WebSocket, SocketMeta>`（`server.ts:53,56`） | `new WebSocketPair()` + `server.accept()`（`worker/index.ts:1074`）+ **DO 实例内存里**的 socket Map（`:1040`）。**未使用 Hibernation API** |
| 计时推进 | 服务端 `setInterval`：`scheduleTimer`/`ensureTimer`（`server.ts:1711-1741`）+ `scanOfflinePlayers`（`:2053`） | **无 `alarm`，完全由客户端消息驱动**：`advanceRoomIfNeeded`（`worker/index.ts:3281`）只在 `refreshState`/`state`/`heartbeat` 到达时执行 |
| 持久化粒度 | 房间级：`store.ts:132` 每次 `set` 写一份房间 JSON（Redis，TTL 600s） | DO 单键全量：`persist()`（`worker/index.ts:1704`）每次动作写整份 `Room`（含完整 `game`）到 storage 键 `"room"` |
| 会话 | `sessions: Map<token,userId>`（`users.ts:496`）**纯进程内存、不落盘**；`userForToken`（`:622-626`）只查 Map，**无过期、不校验 `sessionVersion`**；改密靠 `revokeSessionsForUser`（`:1924`）主动清理 | KV `session:<token>`，**TTL 14 天**（`worker/index.ts:370`），且**强制比对 `user.sessionVersion`**（`:3810`） |
| 密码哈希 | 异步 `scrypt`（`users.ts:3035`） | **同步 `scryptSync`**（`worker/index.ts:5080-5091`，阻塞 isolate） |
| 密钥 | `process.env.AUTH_SECRET`（`users.ts:511`） | `env.AUTH_SECRET`（`5115`），加解密 `encrypt`/`decrypt`（`5048-5067`） |
| 密码 | scrypt + 随机盐 | `hashPassword`/`verifyPassword`（`5080-5092`） |

### 7.2 ⚠️ 最重要的一致性风险

**Worker 没有复用 `server.ts` 的任何代码**，而是把同样的业务规则重新实现了一遍。两边共有约 **60 个同名 API 路由**，靠人工维持对齐。已经可以看到的重复：

- 注册/登录/会话：`server.ts:82-125` ↔ `worker/index.ts:1724-1747`
- 房间全生命周期：`server.ts:586-904` ↔ `worker/index.ts:2900-3770`
- 权限/额度判定：`server.ts` 的 users.ts ↔ `worker/index.ts:3824-4900`
- 邀请码/激活码/工单/预设：两份独立实现

**唯一被两端真正共享的是 `src/shared/**`**（实测 `worker/index.ts` 的 16 条 shared import）。因此：

> **任何业务规则的修改，如果不想两端漂移，就必须把逻辑放进 `src/shared/`。**
> 典型正例：`http-security.ts`（两端都用）、`action-security.ts`（两端都用）、`room-limits.ts`（两端都用）、`custom-settlement.ts`、`tax.ts`、`banker.ts`、`victory-music.ts`。

### 7.3 已确证的 Node ↔ Worker 行为分歧（实测）

这些不是"设计差异"，而是**会导致用户可感知的不一致**：

| # | 分歧 | Node | Worker |
| --- | --- | --- | --- |
| 1 | 超时/托管推进 | ✅ 服务端定时器（`scheduleTimer:1711-1736`、`timeoutPlay:1758`） | ❌ 仅客户端消息触发（`advanceRoomIfNeeded:3281`） |
| 2 | 空闲离线检测（30s 无心跳） | ❌ **死代码**：`PRESENCE_OFFLINE_MS`（`server.ts:60`）只被无调用点的 `scanOfflinePlayers:2053` 引用；`scheduleOfflineAutoplay:1940` 只调 clear，`offlineTimers` 恒空 | ✅ 真实生效（`refreshWorkerPresence:3784-3795`） |
| 3 | 房间状态并发 | ❌ `RoomStore.get()`→`set()` 为**无锁整对象覆盖**（`store.ts:98-133`），无 CAS；房号唯一性也有 get-then-set 竞态 | ✅ DO 单实例 + `operationQueue`（`:1039,1054-1061`）串行化，强一致 |
| 4 | 会话 | ❌ 纯内存、不落盘 → **一次服务端重启 = 全员立刻 401**；无过期、不校验 `sessionVersion` | ✅ KV 14 天 TTL + 校验 `sessionVersion`（`:3810`） |
| 5 | WebSocket 存活 | ✅ 独立 `ws` 进程，全局 `sockets` Map | ❌ socket 存在 DO 实例内存；DO 被驱逐则连接丢失（未用 Hibernation） |
| 6 | 自定义规则快照体积 | ✅ `persistPayload`（`store.ts:171-178`）剥离 `game.custom.rules` | ❌ `persist():1704-1709` 只剥离顶层 `room.customRules`，**`game.custom.rules` 仍内联写入** → 同一份规则存两份 |
| 7 | 安全日志 / CSV 导出 | ✅ `GET /api/security-logs/:id`、`GET /api/users.csv` | ❌ **两个端点都不存在** |
| 8 | 请求体大小上限 | ✅ 三档（`server.ts:65-67`：默认 100KB / 规则 512KB+128KB / 音效 14MB） | ❌ 无显式上限 |
| 9 | 密码哈希 | 异步 `scrypt` | 同步 `scryptSync`（阻塞 isolate） |
| 10 | 房间码生成失败 | ✅ 1000 次冲突后显式抛错（`store.ts:81`） | ❌ 旧 KV/内存路径静默返回空 code（`:2969-2977`） |
| 11 | 每 2 秒全量落库 | 每次心跳 `store.set` + 全员广播（Redis 无 TTL 续期） | 每次心跳 `markPlayerOnline` → `persist()` 全量写 + 全房广播 |
| 12 | 只读请求延迟 | ✅ 读写分离，读不加锁 | ❌ `AccountState.fetch`（`:443-450`）**读也被串行**，一个慢的管理写会阻塞同实例所有只读请求 |

> ⚠️ **不要笼统地说"Worker 是简化版"**：第 1/2 条是**互补缺陷**（Node 有钟没离线判定，Worker 有离线判定没钟），第 3/4 条 Worker 反而**优于** Node。做任何"对齐两端"的工作前，先逐条确认哪边是更好的行为，不要默认以 Node 为准。
> 修复 Worker 计时需先给 `DurableObjectState` 的手写声明（`worker/index.ts:49-55`）补 `setAlarm/getAlarm/deleteAlarm`。

其他确认项：决斗额度的"建房时只检查、开局时才扣减"所造成的并发窗口**两端都存在**（Node `server.ts:654-660` / Worker `:2229-2233`）；两端的 `reserveDuelRoomCreation`/`/duel/reserve` 与 release 对应实现**都是死代码**，实际扣减点在开局（Node `chargeDuelRoomStart:1388` / Worker `recordWorkerDuelRoomCreation:3161`）。

### 7.4 Worker 内部结构（两级路由）

Worker 有两套"路由"，理解这一点是改 Worker 的前提：

**第一级 · 公网 API**：`handleApi`（`worker/index.ts:1717-2440`），约 60 个 `if (url.pathname === ... && method === ...)` 分支，与 Node 的路由一一对应。

**第二级 · DO 内部 RPC**：Worker 通过 `durableRoomRequest`（`:2935`）/ stub `fetch` 调用 DO，DO 内部再用路径字符串分派：

- `AccountState`（`:438-1036`，**全局单例** `idFromName("global")`）→ 约 36 个操作：`/initialize`、`/users/register|set|replace|delete|settle|points/bulk`、`/invitations/*`、`/activations/*`、`/permissions/update`、`/custom-mode-limits/update`、`/presets/*`、`/tax/update`、`/requests/*`、`/security/record`、`/reserved-room-codes/*`、`/duel/*`。
- `RoomState`（`:1038-1715`，**每房间一个** `idFromName(房间号)`）→ 约 15 个操作：`/ws`（WebSocket upgrade，`:407`）、`/join`、`/start`、`/action`、`/state`、`/heartbeat`、`/edit`、`/leave`、`/kick`、`/bots`、`/cancel-autoplay`、`/rules` 等。

两个 DO 都是 SQLite 类（`wrangler.toml:20-26` 的 `new_sqlite_classes`），但**只用了 `storage.get/put/delete` 键值 API，没有 SQL、没有事务**。`AccountState` 的状态是**单键全量**（键 `"state"`，`:462`），每次审计/改用户都写整份 payload（含全部用户 + 安全事件 + 已结算 gameId 列表）。

KV 用途（`wrangler.toml:28-38`）：`ION_USERS` 与 `ION_ROOMS` 是**旧数据迁移来源**（`RoomState.load` 会读 `ION_ROOMS` 的 `room:<code>` 并迁移进 DO 后删除，`:1678-1684`），`ION_SESSIONS` 是登录会话。

---

## 8. 安全设计（必须保持的部分）

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| 操作意图白名单 | `action-security.ts:20` `isStrictActionIntent` | 只接受形状合法的 `AnyActionIntent`，拒绝多余字段 |
| 防状态注入 | `action-security.ts:68` `containsProtectedGameMutation` | 递归检测 payload 里是否夹带 `PROTECTED_GAME_KEYS`（禁止客户端直接改对局状态） |
| 静态资源防护 | `http-security.ts:9` `isProtectedAdvancedAiAssetPath` | 用文件名正则拦截高级 AI 的 JS chunk，两端都要求 `ion_ai_access` cookie + `canUseAdvancedAi`（`server.ts:905-913`、`worker/index.ts:422-424`） |
| Cookie 安全解析 | `http-security.ts:13` `safeCookieValue` | 避免抛异常 |
| 高级 AI 资源授权 cookie | `server.ts` / `worker:1756` | `ion_ai_access`，HttpOnly、SameSite=Strict、Max-Age 600 |
| 密码存储 | `users.ts` | scrypt + 随机盐；用户名用 `AUTH_SECRET` 派生的密钥加密（`users.ts:2305` 支持 `AUTH_SECRET_PREVIOUS` 轮换） |
| 密钥要求 | `users.ts:3022` `requireAuthSecret` | `AUTH_SECRET` 至少 32 字符，缺失即启动失败 |
| CSV 公式注入防护 | `spreadsheet-safety.ts` | 导出用户/对局 CSV 时中和 `= + - @` 开头 |
| 上传体积限制 | `victory-music.ts:1-2` | 胜利音效 ≤ 10MB、时长 ≤ 15.2s，且**手动解析 WAV/MP3/OGG 头**验证时长而非信任声明 |
| 速率限制 | `worker/index.ts:380-381` | 注册 60s / 8 次（Worker 侧内存计数） |
| 安全审计 | `worker/index.ts:5198-5380` | 事件 + 事故（incident）+ NDJSON 导出，上限 2MB |
| 原子哈希 | `stable-json.ts:97` | 纯 TS SHA-256，保证 Node/浏览器/Worker 三端 hash 一致 |

> `stable-json.ts` 手写 SHA-256 的原因很明确：**三端运行环境没有共同的 crypto API**，而 `rulesHash` 必须跨端完全一致（用于自定义规则快照校验，规范 §2"开局前规则预下载"）。

---

## 9. 经济与结算模型

```
经典联机：
  scoring.baseBet（底注） → stake → total（累计）
  开局加倍：每名玩家可加倍，倍率 = 2^openingDoublePlayerIds.length（game-log-score.ts:6）
  结算：winnerGrossPoints = amountPerLoser × 人类输家数（tax.ts:34-40）
        实际税收 = min(rawTax, floor(gross × taxRate/100))，且受积分门槛控制
                    （tax.ts:42-63；rate = -1 表示关闭征税）
自定义模式：
  calculateCustomSettlement 按开房者 settlementCap 封顶，保证零和（custom-settlement.ts）
庄家（banker）：
  按固定座位顺序轮转，不随 direction 变化（banker.ts:9-23）
积分分配：
  激活码红包 → point-distribution.ts（等分 / 随机，Worker:4713-4730）
```

`logScoreMultiplier`（`game-log-score.ts:3-10`）是"假设底注为 1 且无人加倍时，积分引擎当前应有的累计倍率"，仅用于日志展示——不要把它当作真实结算依据。

---

## 10. 三端职责与状态流

### 10.1 一次联机出牌的完整链路

```
① 客户端 app.ts:6061 submit(action)
     ├─ 本地模式：直接 applyRulesetAction(game, seatId, action)（app.ts:6093）
     └─ 联机模式：sendOnlineMessage → WS "submitAction" / HTTP POST /api/rooms/:code/action
② 服务端 server.ts:1104 收到 → 校验（isStrictActionIntent + containsProtectedGameMutation）
③ server.ts:1689 applyRulesetAction(room.game, playerId, action, source)
     └─ ruleset.ts → applyAction / applyCustomAction（纯函数，返回新 state）
④ server.ts:1864 publicRulesetGame(room.game, viewerId)  ← ★ 视角裁剪（隐藏他人手牌）
⑤ 广播 gameState 给房间内每个 socket
⑥ 客户端 app.ts:5704 applyServerPayload → trackDrawAnimation / playStateSound → render()
```

**关键安全边界在 ④**：`publicGame` / `publicCustomGame` 是唯一的手牌隐藏点。任何新字段若含敏感信息，必须在这里裁剪。

### 10.2 服务端计时推进

`advanceRoomIfNeeded`（Node：`server.ts:1722+` 的 `timeoutPlay`/`timeoutOpeningExchange`；Worker：`worker/index.ts:3281`）按 `turnDeadlineAt` / `openingExchange.deadlineAt` 推进：超时 → `randomRulesetTimeoutAction` → 更新 `timeoutStreak`/`forcedAutoplay`。

> ⚠️ **两端机制根本不同**：Node 用真正的服务端定时器（`scheduleTimer`/`ensureTimer`，`server.ts:1711-1741`），即使所有玩家离线也会推进；Worker **没有使用 Durable Object `alarm`**，只有在收到客户端 WebSocket/HTTP 消息时才检查是否超时。因此 **Worker 部署下全员掉线会让房间停摆**。若要在 Worker 上修复，需要引入 `state.storage.setAlarm()` + `alarm()` 处理器。

---

## 11. 客户端架构（`app.ts`，9226 行）

### 11.1 状态：全局可变变量

`app.ts:853-940` 定义了 **84 个模块级 `let`**，包括 `game`、`room`、`socket`、`selfId`、`selectedCard`、`modal`、`dialog`、`managedUsers`、`leaderboard`、`advancedAi*`、以及十几个 timer id 和动画状态。**没有 store、没有 reducer、没有订阅机制。**

约定俗成的更新方式是「直接赋值 → `render()`」，例如 `app.ts:3852-3858`。只有 `modal`/`dialog` 两个判别联合用展开语法做不可变更新（`5191`、`4355`）。

### 11.2 渲染：全量 innerHTML 替换

```ts
function render(): void {                       // app.ts:1013
  // 1. 按 location.pathname 分派到子页面（/user /invite /activation /ticket /leaderboard）
  // 2. syncDrawModal()
  const interaction = captureInteractionSnapshot();   // 保存焦点/选区/滚动/输入值
  app.innerHTML = `…巨大模板字符串…`;                  // 3. 整棵树重建
  scheduleLocalOpeningExchange(); bind(); renderTimer();
  restoreInteractionSnapshot(interaction);            // 4. 恢复交互状态
  maybeRunBot(); scheduleAdvancedAiCalculation();     // 5. 副作用（注意：render 不纯）
}
```

- 模板全部是**字符串拼接**：共 **150+ 个 `render*` 函数**（`renderSidebar`、`renderBoard`、`renderModal`、`renderRulesEditorDialog`、`renderUserRow`…）。
- **事件绑定不是委托**：`bind()`（`app.ts:3767-4391`，**624 行**）在每次 render 后以 `querySelectorAll(...).forEach(el => el.addEventListener(...))` 逐元素重新绑定，共 **107 处绑定**（`change` 59、`input` 26、`click` 7、其余为拖拽/指针/焦点）。全仓库 `closest()` 只用 1 次（`app.ts:266`），即基本没有事件委托。
- **动作分发**：`data-act="xxx"` → `handleAct(action, el)`（`app.ts:4392-5118`，**728 行**，约 130 个平铺 `if (action === "...")`）。共有 **154 处 `data-act`**。
- 交互状态保护是自己实现的"虚拟 DOM 补丁"：`renderScopeKey()`（`1133`，拼 `pathname|modalKey|dialogKey|…` 存到 `app.dataset.renderScope`）+ `captureInteractionSnapshot`（`1164`，遍历 `input/select/textarea/details/*`）+ `restoreInteractionSnapshot`（`1215`，按 `id:` → `data-ui-key:` → `name:` → DOM 路径回填）。**scope 一变快照整体作废**，这就是弹窗切换会丢输入的原因。此外有 3 个专用的 `renderXxxPreservingScroll()`（`:1081/:1097/:1115`）作为补丁。
- 唯一"外科手术式"更新是计时器：`renderTimer`（`6165`）直接改 `#timer`，避免每秒重建整树。
- 变更检测靠**整体序列化**：`roomRenderSignature`（`5781`）/`gameRenderSignature`（`5787`）对整局做 `JSON.stringify`，每条对账消息至少 2 次（`5716`、`5738`）。

### 11.3 路由与启动

`render()` 开头按 `location.pathname` 早退分派（`1014-1033`）；房间页不是路由，而是 `history.pushState("/room/{code}")`（`947`）+ `popstate` 互斥（`967`）。启动块在 `app.ts:962-1011`：首屏模态决策 → 首次 `render()` → `refreshAuth()` → 注册 `popstate` → 暴露 e2e 钩子 `window.render_game_to_text` / `window.advanceTime`（**这两个测试钩子在 `app.ts:980-1011`，生产构建同样存在**）。

**并发控制的核心机制**：两个单调递增版本号 `gameContextVersion`（`908`）与 `roomJoinVersion`（`909`）。`beginGameContextSwitch()`（`5507`）一次性重置 30+ 个状态字段、清 8 个定时器、关闭 socket；`joinRoom`/`submitModal` 在每次 `await` 后重校验版本号（如 `5263-5265`）。**新增任何异步回调都必须捕获并比对 `gameContextVersion`**（参考 `pollRoomState:5585`、`advancedAiWorker.onmessage:6570-6579`）。

### 11.4 通信

- WS 建连：`new WebSocket(`.../ws?code=${code}`)`（`5332`），1800ms 未 OPEN 即降级 HTTP（`5343`）。
- 收到 8 种：`joined`(5368)、`gameStarted`(5377)、`refreshStateResult`(5381)、`roomState`(5388)、`gameState`(5389)、`leftRoom`(5392)、`duelDissolved`(5393)、`actionRejected`(5397)。
- 发出 10 种：`joinRoom`(5357)、`addBot`(4801/5373)、`gameStartedAck`(5379)、`heartbeat`(5469)、`startGame`(4795)、`kickPlayer`(5082)、`cancelAutoplay`(5902)、`editRoom`(5990)、`botAction`(6074)、`submitAction`(6080)。
- 服务端定义了但**客户端从不发送**的：`refreshState`、`leaveRoom`、`leaveSeat`（客户端改走 HTTP `/state`、`/leave`）。
- **双通道发送器** `sendOnlineMessage(wsMessage, httpPath, body)`（`5607`）：WS 优先，异常时改 POST 同一 path。⚠️ `socket.send` 成功即返回、**不做超时重试**；抛错后会立刻用 HTTP 重发同一动作，存在重复提交窗口，完全依赖服务端幂等/版本校验。
- 节奏常量（`app.ts:503-510`）：心跳 2s、对账 5s、重连 10s、HTTP 兜底 6s、隐藏页最小 20s、对局中最小 5s、大厅最小 10s、presence 同步 20s。
- 请求头（`5674-5679`）：`Authorization: Bearer <authToken>` + `x-ion-device-id` + `x-ion-browser-fingerprint`。`authToken` 存在 **localStorage**（`858`）。
- ⚠️ **客户端用中文字符串匹配错误**（`5592-5595`、`5626`，如 `error.message.includes("决斗房间已自动解散")`）——服务端文案一改，客户端逻辑静默失效。

### 11.5 本地对局 vs 联机对局

**本地（`mode==="local"`）**：引擎完全跑在浏览器里。
- 建房 `app.ts:5195-5236`：经典走 `createGame`（`5222`），自定义先 `parseCustomRules` → `prepareCustomRulesForPlay`（预热音频 + 写 Cache Storage）→ `createRulesetGame`（`5207-5226`）。
- 出牌 `submit()`（`6061`）→ `applyRulesetAction(previous, seat.id, action)`（`6093`）→ 就地替换 `game`。本地也统一走 `applyRulesetAction`（`applyAction` 只被 `simulatePlayIonOutcome:6795` 用于预演）。
- 机器人 `maybeRunBot()`（`6105`）**在主线程同步**调用 `chooseBotAction`（`6134`），靠复合 key `gameId:revision:seatId:turnStartedAt:actionPoints` 防重入。

**联机**：客户端只做"渲染 + 提交意图"，不预测。权威状态来自 `roomState`/`gameState`/`joined`/`gameStarted` → `applyServerPayload`（`5704`）。断线双保险：5s 对账轮询（WS 正常时也跑）+ WS 挂了切 6s HTTP 轮询并每 10s 重连。

### 11.6 自定义规则的客户端分发

`app.ts:288-410`：`loadRoomCustomRules(code, expectedHash)` 做**三重校验**（服务端 hash、`rules.hash`、本地重算 `canonicalCustomRulesHash`，`311-313`）→ 落 Cache Storage（`342`）→ 预热卡牌音效（`354`）。开局确认时必须携带一致的 `customRulesHashReady`，否则两端都拒绝（`server.ts:1199`）。

### 11.7 两个 Web Worker

| Worker | 状态 | 说明 |
| --- | --- | --- |
| `advancedAiWorker.ts` | **在用** | 唯一实例化点 `app.ts:6558`。每次计算都 `terminate()` 旧 worker 再新建；`postMessage` 前 `structuredClone(game)` 整局深拷贝；4 重失效校验（`requestId` 双查 + `gameId` + `revision` + 计算 key，`6570-6579`）。鉴权先 `POST /api/advanced-ai/access`（`6627`），等级存 `localStorage.ionStormAdvancedAiLevel` |
| `botWorker.ts` | ⚠️ **死代码** | 全仓库无 `new Worker(...botWorker...)`、无字符串引用。因 Vite 只从 `index.html` 入口做可达性打包，**该文件不进任何产物**；本地机器人实际在主线程跑 |

> ⚠️ 高级 AI 的 JS chunk 通过**文件名正则**受保护（`http-security.ts:10`）。给 `advancedAiWorker.ts` 改名或引入新的含 "advanced-ai"/"advancedAiWorker" 的文件，会影响这条鉴权路径。

### 11.8 样式

`styles.css`（3553 行）单一文件、无预处理器、无 CSS Modules。**实际上没有设计令牌**：`:root` 只有 6 个属性（`styles.css:1-9`），**没有 `--color-*`/`--space-*` 变量**，颜色硬编码散落上百处；全文仅 6 处注释，无分区标记；`color-scheme: light` 写死，**无暗色主题**。仅有的自定义属性由运行期注入（`--card-top-color`、`--stack-size`、`--stack-dx`）。

响应式断点 **5 种混用**：`600px`（`2956-3019` 顶栏/表格）、`720px`（`1282` 规则编辑器单列）、`760px`（`2913` 发分控件）、`900px`/`min-width:901px`（`2589-2704` **主布局切换**：≥901 用 flex 两段，≤900 改 grid 单列 + 取消 `100vh`）。新增规则容易漏改 `900/901` 这一对造成断层。无 `prefers-reduced-motion` 处理，而 `@keyframes` 动画有 5 组。

移动端特化在脚本侧：`isTouchInputDevice()`（`211`）决定说明气泡用 click 还是 pointerenter；卡片单击有 **220ms 防抖**以区分双击（`3776-3799`，低端机上有可感知延迟，且定时器内 `render()` 时状态可能已变）。

### 11.9 ⚠️ 客户端 XSS 面（当前安全，但脆弱）

全量 `innerHTML` + 手工转义模型下，纪律目前很好（`escapeHtml`/`escapeAttr` 调用点 222 处，`toast` 用 `textContent`）。两处需要持续盯：

1. `app.ts:1598`：`${describeAction(action)}` **未转义**直接插入 `innerHTML`。当前安全仅因为 `describeAction`（`6740`）内部对所有动态来源都做了转义（`6741` 自定义描述、`6917` 自定义卡名、`6918` 回退 `escapeHtml`）——**一旦 `formulaHtml`(6915) 改成拼接非白名单内容就会破防**。
2. `app.ts:9211` `renderGameLog`：先整体 `escapeHtml`，再把白名单 HTML（`LOG_ION_FORMATS`，来源是常量 `FORMULA_HTML`，`498`）`replaceAll` 塞回。模式危险，但数据源是常量。

配合"`authToken` 存 localStorage"，**任何 XSS 都等于长期登录令牌失窃**；且 `index.html` 全文 12 行、**无 CSP**。

---

## 12. 构建期数据流与"真相来源"清单

| 数据 | 真相来源（改这里） | 生成物（别改） |
| --- | --- | --- |
| 经典牌库 / 卡牌定义 | `json/all-cards-classic-deck.json`、`json/cards/*.json` | `src/shared/generated/custom-json.generated.ts` |
| 规则 JSON 规范文档 | `json/CUSTOM_GAME_JSON_SPEC.md`（同时被客户端 `?raw` 内嵌为"下载规则说明"） | — |
| 规则编辑器模板 | `json/custom-game-template.json`（同样 `?raw` 内嵌） | — |
| 高级 AI 调参 | `src/shared/advanced-ai-weights.json` | `src/shared/advanced-ai-weights.generated.ts` |
| 经典引擎牌值 | `src/shared/cards.ts`（**与 json/ 是两套独立数据！**） | — |

> ⚠️ **重要陷阱**：经典模式的牌值/反应表在 `cards.ts` 里硬编码，而 `json/all-cards-classic-deck.json` 是自定义模式下对同一套 130 张牌的**JSON 重述**。规范 §8 明确"经典不变原则"：改 JSON 不会影响经典模式，反之亦然。两者必须人工保持一致，**目前没有任何自动校验**。

---

## 13. 测试、构建与质量现状

- **无任何测试文件**（`**/*.{test,spec}.ts` 为空）。
- **无 lint / format 配置**（无 eslint、prettier、biome、editorconfig）。
- **无 CI 配置**（无 `.github/`）。
- 唯一的质量保障是 `tsc --strict`（构建时执行）+ 构建期规则解析校验。
- `tsconfig.server.json:10` 与 `tsconfig.worker.json:10` 都写了 `exclude: ["**/*.test.ts"]` —— 说明曾预留测试位置，但从未落地。

**接手后的第一个建议**：在没有测试的重构风险下，任何大改动前先补最小验证手段（哪怕是针对 `engine.ts`/`custom-engine.ts` 纯函数的 node:test 用例，因为它们是纯函数，最容易测）。

---

## 14. 技术债与风险清单（按优先级）

### 🔴 P0：数据丢失 / 正确性 / 安全

1. **【已实测确认】用户数据文件一旦损坏，会静默重建默认管理员并覆盖全部历史数据。**
   链路：`readFileUsers()`（`users.ts:2127-2136`）用 `catch { return [] }` **吞掉所有异常（含 JSON 解析失败）** → `connect()` 看到 `users.length === 0` → `bootstrapSuperAdmin()`（`users.ts:2265`）创建 `admin/admin` 并 `save()` **直写原文件**（`users.ts:2167-2168`，非原子、无 tmp+rename、无 fsync）。
   即：磁盘满 / 写入被截断 / 手动编辑出错 → 重启后不是"报错拒绝启动"，而是"用公开默认口令重建一个空库并覆盖"。默认口令只在控制台 `console.warn`（`2273`）。
   **建议**：`readFileUsers` 区分 ENOENT 与解析失败；解析失败必须抛错并保留原文件（先备份为 `.corrupt-<ts>`）；文件写入改 tmp+rename；补 SIGTERM/SIGINT flush（当前**全仓库无任何进程信号处理器**）。

2. **`gameStarted` 消息链路是死代码。** `maybeSendGameStarted`（`server.ts:1877`）定义了但**从未被调用**（grep 全仓库仅声明处），因此 Node 服务端**从不发送 `gameStarted`**；而客户端 `app.ts:5377-5380` 会回 `gameStartedAck`，服务端 `startAckedPlayerIds`/`startAckLastSentAtByPlayerId` 也随之形同虚设。相关死代码：`scanOfflinePlayers`（`server.ts:2053`，从未调用）导致 `PRESENCE_OFFLINE_MS` 与 `offlineTimers` 机制实际失效——**HTTP 轮询客户端断开后在线标记永不过期**；`forceOfflineAutoplay`（`:1951`）同样从未调用。
   **建议**：先确认"开局握手"是否仍有需求：要么接线，要么删掉这条链路和 `startAck*` 字段。

3. **双后端手工同步**（`server.ts` ↔ `worker/index.ts`）。任何业务修改漏改一边就会产生"Node 能做的操作 Worker 上失败"这类难查 bug。**建议**：新逻辑一律下沉到 `src/shared/`，并在 PR 检查清单里加"两端是否都改了"。

4. **Node 房间无写串行化**：`RoomStore.get()` 返回**可变活对象**（`store.ts:99-104,128-133`），HTTP 与 WS 两条路径在同一房间并发时会在 `await` 点交错（如 `server.ts:807`、`:1127`、`:1687`），Redis 侧无 CAS/版本号 → 后写覆盖。对比 `UserStore` 有 `saveQueue`（`users.ts:508,2138`），房间这边没有。多进程部署下更严重（Redis 中的房间对 `activeRooms`/`prune` 不可见）。
   **建议**：加房间级 mutation 队列或乐观版本校验。

5. **`cards.ts` 与 `json/all-cards-classic-deck.json` 双份牌库**无一致性校验。**建议**：加一个构建期脚本（类似 `sync-custom-json.ts`）断言两者牌值/反应表一致。

6. **自定义引擎的规范漂移（已逐行实测）**——**10 个字段只被解析、运行时从不读取**，其中多个正在官方预设里使用：

   | 字段 | 类型/解析 | 运行时 | 官方预设在用 |
   | --- | --- | --- | --- |
   | `reactSweep.virtual` | `:117` / `parser:341` | ❌ `reactSweep` 分支（`custom-engine.ts:1772-1785`）只读 `reagent`/`repeat` | ✅ `generated:540,562`（强酸/强碱） |
   | `reactSweep.mode:"enough"` | `:118` / `parser:342` | ❌ 同上 | ✅ `generated:604` |
   | `remove.deferCardTriggers` | `:130` / `parser:357` | ❌ 只赋给 `RemovalContext.allowDefer`（`:1998`），**无人读** | ✅ `generated:787,814,1063,1090` |
   | `flushDeferred.from` | `:102` / `parser:291` | ❌ 只用 `scoreTo`（`:1660`） | ✅ |
   | `remove.to` | `:127` / `parser:354` | ❌ 硬编码进 discard（`:555`） | ✅ |
   | `listener.while:"self.onField"` | `:54` / `parser:209` | ❌ | ✅ `generated:486`（铀） |
   | `ExecContext.depth` | `:85` | 只累加，**无任何上限比较** | — |
   | `custom.deferredTriggers` / `custom.playedListenerSeq` / `custom.rulesRevision` | `types:341,346,349` | 只初始化 | — |
   | `CUSTOM_LIMITS.maxEventsPerAction` | `types:548` | ❌ 全仓无引用 | — |

   即规范 §5 承诺的"先摸牌、再结算金/铀后效"顺序**在自定义引擎里并未按 JSON 声明生效**（真实延迟靠 `ExecContext.deferred` + `phase:"afterOperationPrimaryEffect"`，与 `deferCardTriggers` 无关）。**建议**：优先核实并补实现，或在规范中显式标注为未生效——现状对规则作者是静默误导。

   ⚠️ **双向漂移**：`where.name` 对 mark 监听器只认字面量哨兵 `"marked.name"`（`custom-engine.ts:655-656`），而解析器把它当普通 1-200 字符串放行（`parser:207`）→ 用户写 `"name": "Na^+"` 会**静默永不触发**。

7. **`compileCached` 根本不缓存**（`custom-engine.ts:397-399`）：函数名暗示缓存，实际每次都重新词法分析 + 建 AST。每次 `evalCount`/`evalNumber`/`if`/`score` 都触发一次编译。

8. **`CustomCardRegistry.has()` 用 `in`**（`custom-card-registry.ts:64`），`constructor`/`toString`/`__proto__` 等 `Object.prototype` 键会被判为"已定义"；而解析器做引用校验时用的是 `hasOwnProperty`（`custom-rules-parser.ts:858`）——**前后不一致**。后果：`"reagent": "constructor"` 能通过解析、运行期静默无效（"该拒未拒"，非崩溃）。仓库对此陷阱的处理也不一致：`normalizeDeckCards:706` 与 `mergeRulesDocument.setOwn` 正确用了 `Object.defineProperty`，而 `fillReferencedPlatformCards:871` 是裸赋值（当前恰好安全）。**建议**统一为 `Object.prototype.hasOwnProperty.call(rules.cards, id)`。

9. **`audio.oncePer:"event"` 去重键不匹配**（`custom-engine.ts:1528-1533`）：写入用 `ctx.sourceCard ?? ctx.selfInstanceId`，比较用 `ctx.sourceCard ?? ""` → 标记监听器触发的音频永远无法去重。且 `custom.audioEvents` **无上限、永不清空**，去重是 O(n²) 扫描；`eventLog` 同样无裁剪（`:2450` 只裁剪 `log` 到 120 行）。这些都会随之进入房间持久化载荷。

10. **公式求值越界直接 throw 且无捕获**：`custom-formula.ts:321-326` 的求值次数上限触发时抛错，`applyCustomAction`（`custom-engine.ts:2368-2452`）与 `server.ts:1689` 的 `submit` **都没有 try/catch** → 玩家看到 **500** 而非结构化拒绝。唯一有 try/catch 的是 `isOperationPlayable`（`custom-engine.ts:2290-2317`），但它的 `catch {}` **吞掉所有异常（含真实 TypeError）**，使"不可打出的操作牌"与"规则有 bug"无法区分。积极面：变更都发生在克隆上（`:2369`），抛错不会留下半应用状态。

11. **`if` 分支内挂起会破坏外层程序流**：`custom-engine.ts:1667` 用 `runSteps({...ctx, steps: branch, pc: 0})` 递归执行分支，而挂起/中断都是**内层 `return`**（`:1570` choose 挂起、`:1619` drawFlow 让位、`:1566`/`:1636` 空集中断）→ 不会中断外层循环。后果：分支内 `choose` 挂起时，玩家还没选，`if` 之后的步骤已经执行；且序列化的 continuation 只含 `steps = branch`，续跑只跑分支。

12. **`isOperationPlayable` 造成的计算放大**：`enumerateCustomActions` 会对**手中每种操作牌**做 `cloneCustomGame` + 跑完整程序（`:2291-2313`），而枚举在每次 `applyCustomAction`（`:2378`）**以及客户端每次渲染**时都会执行 → 克隆 + 全程序模拟次数 = 手中不同操作牌种类数，成本随牌面线性放大，公式编译无缓存进一步放大。

13. **高级 AI chunk 靠文件名正则保护**（`http-security.ts:10`）。改构建产物命名即静默失效。**建议**：改为显式资源清单（构建期生成受保护 chunk 名列表）而非正则匹配。

14. **`publicGame`/`publicCustomGame` 是唯一手牌隐藏点**。新增字段必须过这里。
    ⚠️ **Node 侧 `GET /api/rooms/:code` 完全公开**（`server.ts:699`），会返回 `capacity`/`creatorAccountId`/`baseBet`/`playerId`/`accountId`/`profile`（含 `permissions`）；`/state` 也是**先查房间再鉴权**（`742-745`），可用于未登录探测房间号是否存在。
    ⚠️ `custom.deferredTriggers`、`custom.audioEvents` 原样下发（`custom-engine.ts:2762-2781` 未处理），`audioEvents` 的 `to` 定向**靠客户端自行过滤**（`app.ts:6407`）——过滤在渲染层，属"信任客户端"设计。

15. **Worker 缺少两个管理端点**：`GET /api/security-logs/:id`（NDJSON 安全日志）与 `GET /api/users.csv` 在 Worker 上**不存在**（`worker/index.ts` 无对应分支），且 Worker 请求体**无大小上限**（Node 有 `server.ts:65-67` 的三档限制）。若两种部署都在用，这属于功能缺口 + DoS 面。

16. **Worker 计时依赖客户端消息**（`worker/index.ts:3281` 无 `alarm`）→ 全员掉线房间卡死。修复需先给手写的 `DurableObjectState`（`:49-55`）补 `setAlarm/getAlarm/deleteAlarm`。反向地，**Node 的空闲离线检测是死代码**（见 P0-2），两端缺的正好相反。

17. **可被 400 错误放大的写放大**：`recordSecurityEvent` 每次审计事件都 `await save()` **全量落盘**（`users.ts:1893`），即攻击者用无效请求即可放大磁盘/Redis 写压力。

### 🟠 P1：架构性维护成本

18. **`app.ts` 9226 行、单文件、84 个全局变量、`handleAct` 728 行平铺 if 链、`bind` 624 行/107 处绑定**。这是最大的维护瓶颈。渲染依赖"全量重建 + 快照恢复"，任何新 UI 都要小心不要把焦点/滚动/输入值弄丢。新增一个控件必须同时改**三处**：模板字符串、`bind()`、`handleAct()`；漏掉 `bind()` 就是"点了没反应"的静默失败。
19. **`render()` 不纯**：末尾调用 `scheduleLocalOpeningExchange()`/`bind()`/`renderTimer()`/`maybeRunBot()`/`scheduleAdvancedAiCalculation()`（`1073-1078`）。`maybeRunBot → submit → render` 构成潜在环，仅靠复合 key 与 `localBotTimer` 兜底。
20. **合法操作的过滤条件被复制了两份**：`renderHandbar` 的 filter（`1562-1569`）与 `data-action-index` 点击处理的 filter（`3819-3829`）必须手工保持一致，否则**点击时索引错位**。建议抽成单一函数。
21. **`worker/index.ts` 5402 行**同样单文件包含 2 个 Durable Object + 60 个公网路由 + 36/15 个 DO 内部操作 + 完整权限系统。Node 侧同样有巨函数：`POST /api/rooms` 112 行（`:586-697`）、`startGame` 103 行（`:1214-1316`）、`users.updateUser` 142 行（`users.ts:872-1013`）、`upsertActivationCode` 109 行。
22. **`action-ranking.ts` 通过真实执行动作来判断有效性**（`:33`、`:47`），每次克隆 + 模拟整个对局。动作枚举 × 模拟的组合可能成为卡顿源（与 P0-12 同源的放大模式）。
23. **`structuredClone` 全量拷贝**是每次操作的成本。`broadcastRoom`（`server.ts:1859`）在 per-socket 循环内调用 `publicRulesetGame`（每人一次深拷贝）+ `summarizeRoom` → 每回合 O(人数 × 局大小)；客户端 2s 心跳又叠加一次全员广播。当前规模可行，但若引入"大牌堆/多玩家"自定义模式需重新评估。
24. **遗留/兼容字段散落**：`types.ts:166` (`follow`)、`types.ts:351` (`settlementCapByPlayerId`)、`custom-rules-types.ts:212-215`（旧顶层 `follow`/`counterAnyFollow`）、`store.ts:109-123`（房间字段补默认值）。这些是"读旧数据"的必要妥协，但需要文档化，否则新人会误以为可以清理。

### 🟡 P2：可读性与规范

25. **无测试、无 lint、无 CI**。
26. **错误处理不一致**：`custom-rules-parser.ts` 是抛异常式严格校验，而路由层大量 `res.status(400).json({error})`，Worker 侧还有 `throw new Error("中文消息")` 被上层捕获成 JSON（`worker/index.ts:1819`）。鉴权失败在多数路由被映射为 **400/404 而非 401**（`server.ts:136-148` 用 404、`:193-206` 用 400）。**建议**统一为共享层的 `Result` 或错误码。
27. **未匹配的 `GET /api/*` 返回 index.html + 200**（SPA 回落在最后，`server.ts:923`）→ 客户端**无法用 404 判断接口是否存在**，任何拼错路径都会静默拿到 HTML。
28. **中文字符串硬编码在所有层**（UI、错误消息、日志、分类名如 `GameEventLogEntry.category` 的 `"开局"|"发牌"|...`）。没有 i18n 层（`app.ts` 中约 950 行含中文字面量；`advancedAiLevelLabel`（`app.ts:6658`）形似本地化实为恒等函数），且**日志分类名被当作数据使用**（`game-log.ts:44`），改动会破坏 CSV 兼容性。
29. **类型逃逸与断言**：`deserializeExec` 全字段 `as`（`custom-engine.ts:1474-1489`，`continuation` 是 `unknown` 且**无 schema 校验**）；`custom.rules as ResolvedCustomRules` 在多处强制断言；`(parser as unknown as { pos: number }).pos`（`custom-formula.ts:232`，**通过断言读私有字段**）；`CustomRulesSource`/`CustomSetup`/`CustomWhereClause` 都带 `[key: string]: unknown` 索引签名，使类型系统失去多余字段检查能力（真正把关全靠手写 `assertKeys`）。
30. **`custom-engine.ts` 2811 行单文件**：事件总线 + 步骤解释器 + 选择/续延 + 结算 + 音频/揭示队列全在一个文件。
31. **重复代码（实测）**：
    - 自定义引擎与经典引擎逐行重复：`reactionPriority`（`engine.ts:1832-1870`）≡ `customReactionPriority`（`custom-engine.ts:764-784`）；`buildReaction`（`engine.ts:1586-1645`）≈ `buildCustomReaction`（`custom-engine.ts:709-762`），唯一差别是后者 `score` 少了 `kindScore` → **同优先级排序结果与经典模式不一致**。
    - 客户端"保存滚动 → render → 恢复"抄了 3 份（`app.ts:1081/1097/1115`）；卡面模板在 `renderCard:1643` 与 `renderHandStack:1696` 各维护一份；字段联动 19 个 `update*Fields` 与摘要 25 个 `*Summary` 高度同构。
    - 服务端"房间参数校验"三套：建房 `:586-697`、编辑 `editRoom:1445-1531`、复核 `ensureRoomConfigWithinCreatorPermissions:1335-1374`；房间号分配三处：`store.ts:71-96`、`server.ts:2197-2217`、`users.ts:2049-2072`。
    - 自定义模式规则文档在 Worker 落库时存了两份（见 §7.3 第 6 条）。
32. **跨端确定性的隐患**：自定义引擎的稳定排序 tie-break 用 `localeCompare`（`custom-engine.ts:993`、`:384`、`custom-rules-types.ts:407`）。locale/ICU 差异会改变并列项顺序，进而改变 `drawWhere` 之后的 RNG 消耗顺序与反应结果。当前靠"服务端权威 + 全量快照下发"掩盖；**一旦要做录像回放、客户端预测或多端复算，这立刻变成不一致源**。另注：`rngState: seed || 123456789`（`:206`）意味着 `seed === 0` 会被替换。

### 🟢 P3：小问题

33. **构建物过期无人发现**：`json/*.json` 与 `src/shared/generated/custom-json.generated.ts` 是**双份真相**，而生成器（`sync-custom-json.ts`）只打印 hash 前 12 位，**没有任何"生成物是否最新"的断言**。改了 `json/cards/Hat.json` 却没跑 `custom:json:sync` → 运行时仍用旧快照且 hash 不变（房间/客户端握手都发现不了）。**建议**：给生成器加 `--check` 模式（生成到内存后与磁盘比对，不同则非零退出）并在 CI 调用。
34. `ruleset.ts:109` 存在格式问题（`{` 与函数签名同一行），说明该文件缺少 formatter。
35. `tsconfig.worker.json:9` include 了不存在的 `data/**/*.json`（实际目录是 `json/`）。
36. `src/client/vite-env.d.ts` 仅 1 行，`?raw` 导入的类型声明依赖 Vite 内置类型；`index.html` 无 CSP。
37. 客户端死代码：`app.ts:4` 导入的 `createLocalRematch` 与 `currentPlayer` 从未被调用；`botWorker.ts` 整个文件无用（见 §11.7）。
38. 客户端把 e2e 测试钩子 `window.render_game_to_text`（会把整局手牌数/座位/区域明细序列化）与 `window.advanceTime` 无条件暴露在生产构建里（`app.ts:980-1011`）。
39. 服务端死代码：`users.ts` 的 `addStats:1029`、`transferPoints:1043`、`guestProfile:774`、`sessionVersion`（只写不读）、`settleGame` 的 `loserCaps` 形参（唯一调用者只传 5 参）、`reserveDuelRoomCreation`/`releaseDuelRoomCreation`（两端的对应实现都是死代码，实际扣减在开局）均无实际作用。
40. 无登录限流（`server.ts:107`）、无 `trust proxy`（反代后 IP 全为 127.0.0.1，使注册限流退化为全站共享 8 次/分）、`ion_ai_access` cookie **缺 `Secure`**、`recordSecurityEvent` 可被 400 请求放大写盘。
41. 无 CORS / 无 helmet / 无 CSP / 无 HSTS / 无 `X-Content-Type-Options`；`store.connect`/`users.connect` 无重试，启动时 Redis 不可达即崩溃。

---

## 15. 修改指南（How-to）

### 15.1 新增一个经典模式卡牌效果

1. `src/shared/cards.ts`：加牌 id、`LABELS`、`FORMULA_HTML`、`INIT_CARD`、`CHARGE`（若是离子则加反应表）。
2. `src/shared/engine.ts`：在 `resolveFunction`（`:854`）或对应结算分支加逻辑。
3. `src/shared/action-ranking.ts` + `src/shared/bot.ts`：加 AI 评分（否则机器人不会用）。
4. 若要进自定义模式：`json/all-cards-classic-deck.json` 同步定义。
5. 客户端展示：`app.ts` 的 `describeAction`（`:6740`）等文案函数。

### 15.2 新增一个自定义规则步骤（op）

按规范 §9 的固定顺序改（**共 6 处**）：

1. `custom-rules-types.ts`：在 `CUSTOM_OPS` 常量与 `CustomStep` 判别联合里加新成员（`:136-156`）。
2. `custom-formula.ts`：若引入新变量，加白名单。
3. `custom-rules-parser.ts`：加严格的 `assertKeys` 字段校验 + 未知字段报错分支（参考 `:339`、`:347`）。
4. `custom-engine.ts:1504-1837` 的 `runSteps` 加 `case "..."` 执行分支（19 个 op 的分发点都在这一个 switch 里）。
5. `json/CUSTOM_GAME_JSON_SPEC.md`：更新规范（客户端会 `?raw` 内嵌为"下载规则说明"，所以**改文档即改用户可见内容**）。
6. `app.ts` 规则编辑器：若要可视化编辑，改 `RulesDraft` 相关函数（`rulesDraftFromResolved:280`、`renderRulesEditorDialog:3341`）。

> ⚠️ 加 op 前请先确认它是否真的会被运行时读取——本仓库已有 **10 个"只解析不执行"的字段**（见 §14 P0-6 的表格）。**只加类型和解析、不加执行分支，会造出一个静默失效的规则字段。**

### 15.3 新增一个 HTTP 接口

1. `src/server/server.ts` 加 Express 路由 —— **必须插在 `:905` 之前**，否则会被静态/SPA 回落吞掉（`GET` 会静默返回 index.html）。
2. `worker/index.ts:1717` 的 `handleApi` 加同路径分支（**必须两边都加**）。
3. 客户端 `app.ts` 加 `httpGet/httpPost/...` 调用（`:5634-5672`）。
4. 若涉及账户字段：`users.ts`（Node，注意同步 `save()` 的 payload 白名单 `:2141-2162`）与 `AccountState` DO（Worker）都要处理。
5. 需要大请求体时，在 `server.ts:69-80` 的 parser 分派里加 path 分支（Worker 侧无体积上限，属已知缺口）。

### 15.4 新增一个 WebSocket 消息

1. `server.ts:27-40` 的 `ClientMessage` 联合加成员；在 `handleMessage`（`:1053-1193`）加分支。需绕过房间守卫的放 `:1068` 之前（参考 `joinRoom`），其余放 `:1076` 之后并至少调用 `ensureSocketPlayer`。
2. `worker/index.ts` 的 `RoomState` 加同样分支。
3. 客户端 `app.ts:5359-5402` 的 `onmessage` 加 `msg.type` 分支，并**通过 `sendOnlineMessage`（`:5607`）提供 HTTP 降级等价路径**（强约束：WS 不可用时客户端整体切 REST）。
4. 广播走 `sendToPlayer`/`broadcastRoom`（Node `:1859-1897`）与 DO 内广播（Worker）。
5. 任何异步回调都要捕获并比对 `gameContextVersion`（参考 `pollRoomState:5585`）。

### 15.5 新增一个 UI 界面

**整页级（URL 路由）**：
1. `app.ts`：加 `renderXxxPage()`（参考 `renderUserPage:1922`），在 `render()`（`:1013`）的 pathname 分派里注册早退分支。
2. 页面外壳用 `renderPageShell`（`:1895`，它自带 `innerHTML` 赋值 + `bind()` + 快照恢复，**不要**再自己赋值 `innerHTML`）。
3. 数据加载函数（参考 `openUserManagement:7109` / `loadUsersPage:7119`）**必须同时在 `refreshAuth()` 的 pathname 分派（`:6994-7007`）里挂上**，否则刷新页面会白屏。
4. 按钮用 `data-act="xxx"` 并在 `handleAct`（`:4392`）加分支；**非 `data-act` 的控件必须在 `bind()`（`:3767`）里补监听**——漏掉就是"点了没反应"的静默失败。
5. 样式加进 `styles.css`（注意 `900/901px` 那对断点）。

**对话框级**：
6. `DialogState` 联合加成员（`:775-819`，并在 `renderScopeKey:1133` 的字段判断链里补键）→ 写 `renderXxxDialog` → 在 `renderDialog()`（`:2189`）注册 → `handleAct` 加开关/提交分支 → 错误回填用 `setDialogError`（`:8280`）+ `dialog = {...dialog, error}`。

### 15.6 修改对局经济/结算

1. 纯计算放 `src/shared/`（`tax.ts`、`custom-settlement.ts`、`point-distribution.ts`）。
2. 调用点：`server.ts:2073 settleRoomStats`（Node）+ `worker/index.ts:3359 settleStats`（Worker）。
3. 幂等键：`users.settleGame` 的 `settledGameIds`（保留最近 1 万）+ 房间的 `statsSettledGameId`——**改动结算逻辑时不要破坏这两层幂等**。
4. 日志列在 `game-log.ts:14-77`（**改动列顺序会破坏已有 CSV 解析**）。
5. ⚠️ 税额是**从赢家积分扣除且无接收方（销毁）**（`users.ts:1090-1095`），不是转移给任何人。

### 15.7 改 AI

- 经典快棋：`src/shared/bot.ts`（45 行，纯启发式评分）。
- 高级 AI：`src/shared/advanced-ai.ts`（662 行，信息集 + determinization + rollout；`ADVANCED_AI_PRESETS` 定义 5 档预算）。
- 调参：`src/shared/advanced-ai-weights.json` → 构建期生成。
- ⚠️ **高级 AI 只支持经典引擎**（`advanced-ai.ts:63` 起全部基于 `GameState`），自定义模式没有 AI 建议。

---

## 16. 本地开发与验证

```bash
npm ci
npm run dev          # 会自动同步 AI 参数与自定义 JSON，然后 Vite 起在 0.0.0.0
npm run server       # 单独跑 Node 后端（tsx 直跑，需 AUTH_SECRET）

# 完整验证（改动后的必做项）
npm run build        # 包含 tsc --strict + 两端类型检查 + 规则 JSON 解析校验
npm run worker:build # 额外验证 worker/ 的类型
```

**当前环境的实测状态**：`node_modules/` 与 `dist/` 均不存在，即**尚未安装依赖**。第一次接手请先 `npm ci`。

**最小自查清单**（每次改动后）：
1. `npm run build` 通过（tsc + 规则校验）。
2. `npm run worker:build` 通过（worker 类型）。
3. 若改了路由/消息/权限 → **Node 与 Worker 两端都验证**。
4. 若改了 `json/` → 确认 `custom-json.generated.ts` 被重新生成且 hash 变化符合预期。
5. 若改了 shared 的 import → 确认带 `.js` 后缀。

---

## 17. 设计意图小结（写新代码时应遵守的既有约定）

1. **纯函数引擎 + 服务端权威**：`shared` 里的引擎不碰 I/O，输入输出都是完整状态对象；客户端永远不能直接改状态，只能发"意图"。
2. **门面模式**：双引擎差异封装在 `ruleset.ts`，调用方不写 `if (isCustomGame(...))`（除少量 UI 处）。
3. **构建期生成 + 冻结快照**：规则/参数在构建期解析校验并 `deepFreeze`，运行时只读；自定义对局用带 hash 的冻结快照，保证同一局内所有玩家、所有端看到同一份规则。
4. **严格解析，拒绝静默忽略**：未知字段一律报错，避免"看起来生效其实被忽略"。
5. **跨端一致的手工工具**：因为三端没有共同的 crypto/JSON 能力，`stable-json.ts`（稳定序列化 + 纯 TS SHA-256）必须保持三端行为完全一致——**改它等于改协议**。
6. **零依赖倾向**：新增依赖前先确认是否能用现有代码解决（例如 CSV 安全、哈希、公式求值都是手写的）。

---

## 18. 建议的接手动作顺序

在动手改功能之前，按以下顺序做，性价比最高（前 3 项都是"小改动、防大事故"）：

| # | 动作 | 为什么先做 | 关键位置 |
| --- | --- | --- | --- |
| 1 | 修 `readFileUsers` 吞异常 | 唯一的**静默数据全损**路径；改动约 5 行 | `users.ts:2127-2136` + `:2265` |
| 2 | 用户文件改原子写 + 补 SIGTERM flush | 防截断，配合第 1 项形成完整保护 | `users.ts:2167-2168` + 新增信号处理器 |
| 3 | 给 `sync-custom-json.ts` 加 `--check` 模式 | 防"改了 JSON 但生成物过期"的隐性 bug | `scripts/sync-custom-json.ts` |
| 4 | 补最小测试（`node:test`，零依赖） | 纯函数引擎最易测；也是上述 P0 项回归验证的前提 | 新建 `src/shared/*.test.ts`（`tsconfig` 已预留 exclude） |
| 5 | 核实并修复 P0-6 的 10 个"只解析不执行"字段 | 规范与实现漂移会持续误导规则作者 | `custom-engine.ts` 对应 op 分支 |
| 6 | 接线或删除 `gameStarted` 链路 | 消除一大片死代码与空转字段 | `server.ts:1877` / `app.ts:5377` |
| 7 | 房间级写串行化 | 消除 Node 侧并发覆盖 | `store.ts` + `server.ts` 写路径 |
| 8 | 抽取重复逻辑到 `src/shared/` | 降低双后端漂移风险 | 见 §7.2 清单 |

---

## 19. 待确认/待补充

以下问题需要与项目所有者确认，会显著影响后续设计：

1. **两套部署是否都在生产使用？** 若只用其一，可以放弃另一侧的部分对齐工作（但 `worker/index.ts` 与 `server.ts` 仍是两份代码）。若都在用，P0-13（Worker 缺端点）与 §7.3 的 12 条分歧必须逐条定调。
2. **"开局握手"（`gameStarted`/`gameStartedAck`/`startAck*`）是否仍有需求？** 决定是接线还是删除。
3. **自定义规则规范里的 `deferCardTriggers`/`virtual`/`mode:"enough"` 是"忘记实现"还是"已被新机制取代"？** 这决定是补实现还是改文档——直接影响现有预设的行为正确性。
4. **测试策略**：是否允许引入测试框架（`node:test` 零依赖 vs vitest）？仓库已有 0 测试、0 lint、0 CI。
5. **`app.ts` 是否拆分**：拆成多模块（router/render/socket/state）是大工程，需要明确收益与风险容忍度。
6. **`cards.ts` 与 `json/` 的牌库双份**是否应合并为单一来源（构建期由 JSON 生成 `cards.ts`）？
7. **是否有隐藏的运行时数据/部署实例**需要兼容（`store.ts:109-123` 的房间字段兼容、`settlementCapByPlayerId` 的兜底读取都暗示存在线上旧数据）。
8. **i18n 需求**：目前全中文硬编码，若有多语言计划，越早抽象成本越低（尤其日志分类名已被当作数据）。
9. **是否需要录像回放 / 客户端预测 / 多端复算？** 若需要，必须先解决 §14 P2-32 的 `localeCompare` 跨端确定性问题。
10. **性能目标**：当前 `render()` 全量重建 + 每回合 O(人数 × 局大小) 广播 + `structuredClone` 全量拷贝，在 10 人自定义大牌堆下是否已有可感知卡顿？这决定是否值得投入渲染/通信重构。

---

## 附录：本文档的证据等级说明

本文件的结论分三类，阅读时请注意区分：

- **实测复核**（由我在本次分析中直接读取源码验证）：文件行数、依赖图、`ruleset.ts` 门面用法、`readFileUsers` 吞异常、`maybeSendGameStarted` 无调用点、`reactSweep` 不读 `virtual`/`mode`、`deferCardTriggers` 无人读、`compileCached` 无缓存、`audio.oncePer` 键不匹配、`compileCached`/`CustomCardRegistry.has` 用 `in`、Worker 无 `alarm`/Hibernation/`scryptSync`、Worker `persist` 不剥离 `game.custom.rules`、`app.ts:503` 心跳常量、`botWorker.ts` 零引用、生成物编码为合法 UTF-8。
- **交叉核对**（由并行深度分析给出、并在关键处抽查验证）：两端 API/消息清单、权限系统细节、计分与税收公式、自定义引擎内部子系统划分与行号。
- **推断/建议**（明确标注为"建议"）：修复方案、优先级排序、重构方向。

若发现本文与源码不符，**以源码为准**，并请更新本文——这类接手文档最大的风险就是过期。
