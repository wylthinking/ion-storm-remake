# 《离子风暴》自定义规则 JSON v4 规范

> 本规范根据 `ChemGame(6).zip` 的代码本体和当前需求重新整理；实现时明确忽略仓库 `./json/` 目录。

## 1. 顶层结构

```json
{
  "version": 4,
  "name": "CustomGameId",
  "displayName": "自定义游戏",
  "preset": "optionalPresetId",
  "setup": {},
  "cards": {},
  "combos": {},
  "display": {},
  "deck": { "cards": {} }
}
```

`cards` 使用对象，键即卡牌程序 ID。当前文件中同名定义覆盖预设和内置定义。`deck.cards` 只决定实际进入本局牌堆的数量；“定义了一张牌”不等于“把它放进牌堆”。

`setup` 支持 `players`（整数或 `[min,max]`）、`baseBet`（非负整数或 `[min,max]`，不设上限）、`initialHand`（至少为 2 的整数或范围，不设 130 张上限）、`disableOpeningExchange`（布尔值）、`allowWangZha`（布尔值），以及可选的 `initialHandByPlayers`。后者以 `"2"` 至 `"10"` 为键，按实际人数覆盖全局补足手牌数；键必须落在 `setup.players` 的允许范围内。自定义模式的初始手牌数不能为 1。

`setup.disableOpeningExchange` 省略或为 `false` 时沿用正常开局换牌；设为 `true` 时，本局所有用户均没有换牌权限，客户端隐藏换牌操作且服务端/Worker 会拒绝伪造的换牌请求。联机局原有的开局加倍选择保持独立，不会被该字段关闭。

`setup.allowWangZha` 省略或为 `true` 时，强酸与强碱可以按王炸组合打出或抵挡加牌；设为 `false` 时禁用王炸组合的所有出牌入口，但强酸、强碱各自原有的功能牌与同名跟牌行为不受影响。

也可以直接从 `combos` 中删除 `WangZha`，效果与禁用开关相同；编辑器不会因“允许王炸”处于勾选状态而重新生成已删除的组合。

## 2. 卡牌类型严格只有四种

```text
ion / operation / special / generic
```

所有类型均可选 `description`（最多 500 字符）作为卡牌说明，也可选 `topColor: "#RRGGBB"` 覆盖牌面顶部色条。规则编辑器可新建、补充或修改说明；缺省、空字符串或纯空白说明均不显示。游戏中仅对经典 37 种卡牌之外的 operation、special、generic 显示说明气泡；ion 的说明可保存和编辑，但不在牌面上显示。鼠标设备悬停/聚焦显示，触屏设备单击显示。

省略 `topColor` 时使用代码默认：正离子沿用 cation 顶色 `#b63e32`，负离子沿用 anion 顶色 `#226b70`，operation `#6b5aa9`，special `#c6972f`，generic 使用中性主题色。经典模式 CSS 默认不需要改变。

离子的 `color` 只控制化学式文字颜色，同时用于 `colored:true` 筛选；不可与 `topColor` 混用。

### 跟牌与任意抵挡

同名跟牌必须标在**产生加牌流程的具体 `drawFlow` 步骤**上，而不是笼统标在整张卡牌或整个组合的顶层：

```json
{
  "type": "operation",
  "displayName": "强酸",
  "counterAnyFollow": false,
  "steps": [
    { "op": "reactSweep", "reagent": "H^+", "virtual": true, "repeat": "stable", "as": "r" },
    { "op": "drawFlow", "n": "r.cards", "perPlayerCap": 3, "scoreTo": "self", "follow": true }
  ]
}
```

- `drawFlow.follow:true`：只有这个步骤实际产生的加牌流程允许后续玩家跟出**相同卡牌 ID**或**相同组合 ID**。单牌跟出 1 张，组合跟出 `requires` 中的全部牌；跟牌者随后摸 1 张，成为新的加牌来源，并把剩余流程传给下家。
- `drawFlow.follow:false` 或省略：这个步骤产生的流程不能同名跟牌。若一张牌在 `if.then`、`if.else` 或其他程序位置包含多个 `drawFlow`，可逐项写不同值，实际执行到哪一步就采用哪一步的值。
- 卡牌/组合顶层的 `counterAnyFollow:true`：该卡牌或组合可在任意 `drawFlow` 中作为抵挡项，行为入口与加钠/王炸相同。选中后先消耗对应单牌或整组牌，再执行顶层 `counter` 步骤并取消剩余加牌；省略或给出空 `counter` 时仍执行基础取消流程。
- `counterAnyFollow:false`：即使定义中保留 `counter`，也不允许其作为任意抵挡项。该字段描述“这张牌可否响应别人的流程”，所以仍位于卡牌/组合顶层。

旧版顶层 `follow` 只作为兼容字段：当某个 `drawFlow` 自己没有 `follow` 时，才回退使用所属卡牌/组合的旧顶层值；两处都省略时为 `false`。因此新步骤级字段可以精确覆盖旧顶层值。`counterAnyFollow` 省略时，存在非空 `counter` 的卡牌/组合按 `true` 处理，否则按 `false` 处理。

旧 JSON 点击“应用 JSON”、导入或从旧版预设打开编辑器后，高级 JSON 会删除旧顶层 `follow`，递归为每个 `drawFlow` 补写迁移后的 `follow:true/false`，并在卡牌/组合顶层显式补写 `counterAnyFollow`。运行旧房间快照时不会改写原对象或 hash。

`setup.allowWangZha:false` 与删除 `combos.WangZha` 的优先级高于组合上的跟牌/抵挡字段：被禁用或不存在的王炸不会出现在任何入口。

### 开局前规则与音效预下载

联机自定义房间在大厅阶段向每名参与用户下载完整的已解析规则快照，校验 `rules.hash` 与房间当前 `customRulesHash` 后写入浏览器 Cache Storage，并对 `cards.*.audio` 中的所有音频源执行预加载。下载/校验/预加载未完成时“确认开始”保持禁用；确认请求必须携带当前 `customRulesHashReady`，Node 与 Worker 均拒绝缺失或过期 hash。规则被房主修改后 hash 改变、全员确认状态清空，每名用户必须重新取得新快照。经典模式不使用此握手。

本地自定义游戏同样在创建游戏状态前完成规则缓存和音效预加载。对局中音效播放复用预加载资源，不再临时请求规则正文。

## 3. 离子牌

```json
{
  "type": "ion",
  "displayName": "Fe³⁺",
  "charge": 3,
  "reactions": {
    "solid": ["OH^-", "PO_4^{3-}"],
    "nonexistent": ["S^{2-}"]
  },
  "color": "#A64B2A",
  "flameTest": false
}
```

`reactions` 子项只允许 `solid/gas/micro/weak/nonexistent`。省略某子项即空数组；五类均为空时自动派生 `nonreactive`。`flameTest` 省略即 `false`。

## 4. 特殊物质牌

`special.play` 描述正常打出时进入的区域及初始运行时状态；`on` 是通用事件监听器。铀的寿命必须通过通用 counter/badge 表示，不再让自定义引擎依赖 `radiationLeft` 专用字段。

支持的通用事件至少包括：

```text
turn.started
self.removed
marked.removed
marked.reacted
card.playedBatch
```

`self.removed`/`marked.removed`/`marked.reacted` 事件至少包含：

```text
event.actor
event.cause = reaction | operation | rule | other
event.reactionResult = water | nonexistent | solid | gas | micro | weak | ...
event.sourceCard
event.batchId
```

## 5. 操作牌步骤

v4 完整文件实际使用的 `op` 必须全部实现，解析器不得忽略未知字段：

```text
action
audio
cancelDraw
choose
counter
draw
drawFlow
drawWhere
flushDeferred
if
inspect
move
play
pot
reactSweep
remove
reverse
score
skip
```

### 数值公式

字符串数值允许：`+ - * / ^ ( )` 和 `ceil/floor/round/min/max/abs`。必须使用白名单解析器，禁止 `eval`/`Function`。

常用变量：

```text
players
stake              当前实际积分单位（已包含底注与倍率）
bet                当前底注
r.cards             实体牌数
r.groups            生成物组数
r.specialGroups     含特殊物质的组数
event.matchCount
```

### `drawFlow`

表示经典“加牌流程”，而不是立刻摸牌。`follow:true` 只允许同名卡牌/组合跟随本步骤产生的流程；`follow:false` 或省略则不允许（旧顶层 `follow` 兼容回退除外）。卡牌/组合顶层 `counterAnyFollow:true` 仍可抵挡任意流程；`perPlayerCap` 控制单个玩家一次最多接受多少张，`scoreTo` 表示实际摸到牌时积分归属。

### `choose`

- `from:"players.other"`：从除效果执行者外的玩家中选择一人，并把玩家 ID 保存到 `as`；该变量之后可用于 `target`、`to`、`scoreTo` 等目标引用。
- `from:"self.hand"`、`count:1` 且 `where.type:"ion"`：选择框按离子种类去重，同种离子只显示一次并绑定其中一个实体。
- `mode:"kind+count"` 或 `count>1` 的多离子选择保持原有数量/组合选项，不进行上述去重。

### `reactSweep`

通用化学反应扫描：

- `virtual:true`：试剂本身不来自手牌，如强酸/强碱；
- `mode:"enough"`：足量模式；
- `repeat:"stable"`：每次场面改变后继续处理连锁反应直到稳定；
- `as` 保存实际被处理的目标牌结果。

### `drawWhere`

从指定区域只在匹配集合中随机抽取。`Impurity` 使用它从牌堆中的所有离子实体里均匀随机一张，而不是“从牌顶翻到离子”。

### `remove` 与延迟后效

`cause` 必须传入结构化移除原因。`deferCardTriggers:true` 用于“先完成操作牌主要摸牌，再结算金/铀后效”的经典顺序；随后通过 `flushDeferred` 结算。Hat 的 mark 离场事件属于立即生命周期事件，不得因金/铀后效延迟而丢失。

`from:"player.hand"` 必须同时提供 `target`。`where.reactsWith` 接受离子 ID 或形如 `x.name` 的已选牌引用，仅匹配能与该离子发生已定义反应的离子牌；当 `cause:"reaction"` 时，移除牌会按实际反应类型触发 `marked.reacted`，再进入弃牌堆。

## 6. Hat

Hat 不属于代码预置卡牌；必须来自 JSON 或管理员预设。只能选择一张合法离子作为“大恶霸”。标记绑定实体牌 `instanceId`，右上角显示 `badge:"大恶霸"`。

手中没有任何合法离子时 Hat 仍可空打：`choose` 的 `empty:"stop"` 会在无可选目标时终止后续步骤，Hat 照常进入弃牌堆且不产生任何效果；`empty:"illegal"` 则会令整次打出不可用。

- 大恶霸参与任意反应（任意 `reactionResult`，含沉淀/气体进入产物组的情形）：触发 `marked.reacted`，`event.actor` 先摸 1，再 +1 出牌机会；
- 因操作牌直接移除：`event.actor` +1 出牌机会；
- 一次动作打出 n 张同名牌：打出该批次的玩家（`event.actor`）摸 n 张；`card.playedBatch` 只发一个事件，音频 `oncePer:"event"` 只播放一次；
- 新挂载标记不能收到自己首次入场前的 batch 事件，但如果入场后立即反应，必须能收到 `marked.reacted`（若反应导致离场，还会收到 `marked.removed`）；
- 同名反应优先：`mark` 可声明 `reactionPriority`（-100 到 100 的整数，省略即 0）。任何按牌名选取实体牌的反应移除（`reactSweep` 与定点反应）在同名实体牌中优先操作 `reactionPriority` 更高者，同优先级保持后进先出。Hat 的“大恶霸”标记声明 `"reactionPriority": 1`，因此玩家选择与“大恶霸”同名的牌反应时一定先操作带标记的实体。

Hat 的 `audio` 使用 Data URL Base64。服务器需要限制 MIME、解码后字节数和总文档大小。

## 7. FlameTest

完整 JSON 中显式定义 `FlameTest`。如果代码仍保留其便捷内置定义，当前 JSON 同名定义优先。Na⁺ 优先：目标手中有 Na⁺ 时只显示 Na⁺；没有时显示其他 `flameTest:true` 的离子种类，不显示数量；都没有显示“无焰色反应”。

## 7.1 批斗

`cards/Criticism.json` 使用通用步骤表达：先选择另一名玩家，再从自己手中按种类选择并直接打出一张离子；随后弃置目标手中所有能与该离子反应的离子牌。目标手牌的弃置数不直接生成反应积分；如果打出的离子恰好与场上的牌发生反应，反应类型、参与牌数、额外出牌机会和反应积分全部交由标准反应引擎计算。设弃置数为 `n`，仅当 `n>2` 时目标摸 `n-2` 张，摸牌积分归批斗使用者。该牌只作为独立自定义卡定义提供，不加入经典 130 张牌堆。

## 8. deck 与经典不变原则

`all-cards-classic-deck.json` 定义 39 种卡牌，但 `deck.cards` 只包含代码中的 37 种经典牌，合计 130 张。Hat/FlameTest 不会自动进入经典牌堆。自定义模式要启用时只需添加：

```json
"deck": {
  "cards": {
    "Hat": 2,
    "FlameTest": 1
  }
}
```

若基于预设，`deck.cards` 按牌名覆盖数量；数量 0 表示从继承牌堆删除。

## 8.1 deck.deal 初始发牌

`deck.deal` 为座位规则数组，省略或空数组表示按 `setup.initialHand` 自动发牌：

```json
"deck": {
  "cards": { "Na^+": 12, "Cl^-": 12 },
  "deal": [
    { "seat": 0, "fixed": { "Na^+": 2 }, "fill": 4 },
    { "seat": 1, "fill": 4 }
  ]
}
```

- `seat` 从 0 开始，不得超出玩家人数上限；
- `fixed` 指定该座位开局必发的卡牌与数量，从牌堆中定向取出；各座位同一卡牌的 `fixed` 总数不能超过 `deck.cards` 供应；
- `fill` 表示固定发牌后补足到的手牌数，省略时使用 `setup.initialHand` / `initialHandByPlayers.N`；`fill` 不能为 1，且不能小于该席位 `fixed` 的总张数；
- 全局补足手牌数不能小于任何席位的固定发牌总数或显式 `fill`；若所有席位均省略 `fill`，开房者可设置本局全局补足数（至少 2），该值写入本局规则快照的 `initialHandByPlayers.N`；
- 数组长度即座位数，房间人数会被固定为该人数；**只允许 0（自动发牌）或 ≥2 个座位，禁止仅 1 个座位**。
- 可视化编辑器在“初始发牌”页提供“禁止所有用户换牌”复选框，对应 `setup.disableOpeningExchange`；它与 `deck.deal` 的固定发牌内容相互独立。

## 8.2 按人数高级设置

牌堆相同时，**只写一次**通用 `deck.cards`（及可选的通用 `deck.deal`），无需写 `byPlayers`。当不同人数需要不同牌堆或不同初始发牌时，才在 `deck.byPlayers` 中按人数覆盖：

```json
{
  "setup": {
    "players": [2, 4],
    "initialHand": 6,
    "initialHandByPlayers": { "2": 8, "4": 5 }
  },
  "deck": {
    "cards": { "Na^+": 12, "Cl^-": 12 },
    "byPlayers": {
      "2": {
        "cards": { "Na^+": 16, "Cl^-": 16 },
        "deal": [
          { "fixed": { "Na^+": 2 }, "fill": 8 },
          { "fixed": { "Cl^-": 2 }, "fill": 8 }
        ]
      },
      "4": {
        "deal": [
          { "fill": 5 }, { "fill": 5 }, { "fill": 5 }, { "fill": 5 }
        ]
      }
    }
  }
}
```

- `byPlayers` 的键只能是 `"2"` 到 `"10"`；未列出的可选人数使用通用设置；
- `byPlayers.N.cards` 是 N 人局的**完整替代牌堆**，省略 `cards` 时复用通用 `deck.cards`；
- `byPlayers.N.deal` 覆盖通用 `deck.deal`，其非空数组长度必须恰好为 N；`null` 可清除继承的通用发牌规则；
- `initialHandByPlayers.N` 只覆盖自动发牌的默认手牌数。指定 `deal.fill` 时仍以该座位的 `fill` 为准；
- 高级人数差异由 JSON 维护；当前可视化编辑器不会改写这些字段。只要有效人数范围内存在牌堆、初始发牌或默认初始手牌差异，牌堆/初始发牌的相应可视化编辑项以及玩家人数上、下限会锁定，并提示“已在json中进行高级设定，暂不支持可视化编辑”；开房窗口仍可在 `setup.players` 范围内选择本局人数。

### 8.2.1 为所有用户发放一样的卡牌（格式不变）

规则编辑器中的“为所有用户发放一样的卡牌”不会增加新的 JSON 字段。编辑器会在 `setup.players` 允许范围内，为每个人数 N 自动生成 `deck.byPlayers.N.deal`，数组包含 N 份相同的单人模板。例如允许 2-3 人、每人固定 1 张 A：

```json
"deck": {
  "cards": { "A": 2, "B": 4 },
  "byPlayers": {
    "2": { "deal": [{ "fixed": { "A": 1 } }, { "fixed": { "A": 1 } }] },
    "3": { "deal": [{ "fixed": { "A": 1 } }, { "fixed": { "A": 1 } }, { "fixed": { "A": 1 } }] }
  }
}
```

当允许范围内每个 N 都有 N 份完全相同的 `fixed`/`fill` 模板时，运行时将其识别为统一发牌模板，房间人数不被某个数组长度锁定。开房时系统只为所选人数物化牌堆：先补足所有固定牌，再按原牌堆牌种比例补到所有玩家的目标手牌总数；补牌只写入该房间冻结的规则快照，不修改服务器预设。单种牌与初始发牌数不再设置 130 张上限，牌堆总数仍不得超过 1000 张。

## 8.3 display 显示设置

```json
"display": {
  "autoStack": true,
  "maxStack": 0,
  "order": ["Wild", "Ban", "Na^+"]
}
```

- `autoStack`：手牌与换牌界面同名牌自动堆叠，省略即 `true`；
- `maxStack`：单堆最多显示的实体牌数，超过按该值分堆；0 表示无限制；仅在 `autoStack` 开启时生效；
- `order`：卡牌显示顺序（堆叠排序），省略时按类型默认排序（generic → operation → special → ion，同类保持定义顺序）；未列入 `order` 的卡牌排在最后。

## 9. 严格解析

服务器按固定顺序执行：JSON 语法 → version → preset 链 → 合并 → 卡牌类型 → 引用 → 公式编译 → step 判别联合 → event/cause → audio → setup/deal → 牌堆数量 → 归一化 → stable hash → 冻结。

所有未知 `op/when/cause/reactionResult/type` 都必须报错；禁止静默忽略。所有自定义游戏运行时只使用冻结快照。
