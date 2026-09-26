import { OPENING_EXCHANGE_MS, TURN_MS, CHEMISTRY_WEAK_ACID_ANIONS, CHEMISTRY_WEAK_ACID_STRENGTH } from "./engine.js";
import { createCustomCardRegistry, type CustomCardRegistry } from "./custom-card-registry.js";
import { compileFormula, evaluateFormulaBoolean, evaluateFormulaCount, evaluateFormulaNumber, type CompiledFormula, type FormulaScope, type FormulaValue } from "./custom-formula.js";
import { collectMarkListeners, listenerMatchesEvent, type CustomEventContext, type DeferredTrigger } from "./custom-events.js";
import type { CustomCardDef, CustomComboDef, CustomEventListenerRule, CustomStep, CustomWhereClause, ResolvedCustomRules } from "./custom-rules-types.js";
import { CUSTOM_LIMITS, customDeckForPlayerCount, customInitialHandForPlayerCount } from "./custom-rules-types.js";
import { stableStringify } from "./stable-json.js";
import type {
  CardId,
  CardInstance,
  CustomCardInstanceGroup,
  CustomGameState,
  CustomPlayerState,
  PlayerId,
  PlayerProfile,
  PendingDrawState,
  ProductKind,
  CustomActionIntent,
  GameEventLogEntry,
} from "./types.js";
import { addGameLogMultiplier, currentGameLogMultiplier, multiplyGameLogMultiplier } from "./game-log-score.js";

export interface CustomLegalAction {
  id: string;
  kind: "play-ion" | "play-special" | "play-operation" | "play-combo" | "pass" | "accept-draw" | "follow" | "counter" | "choice";
  cardIds: CardId[];
  instanceIds: string[];  count?: number;
  targetId?: string;
  comboId?: string;
  choiceId?: string;
  choiceValue?: unknown;
  description: string;
}

export interface CreateCustomGameOptions {
  mode: "local" | "online";
  rules: ResolvedCustomRules;
  players: Array<{
    nickname: string;
    accountId?: string;
    profile?: PlayerProfile;
    canOpeningExchange?: boolean;
  }>;
  handSize?: number;
  seed?: number;
  baseBet?: number;
  turnTimeLimitMs?: number;
  openingExchangeWindowMs?: number;
  startingSeat?: number;
  settlementLoserCap?: number | null;
}

interface CustomReactionGroup {
  id: string;
  kind: ProductKind;
  playedCard: CardId;
  playedNeeded: number;
  solutionPlayedNeeded?: number;
  tableCard: CardId;
  tableNeeded: number;
  solutionTableNeeded?: number;
  source: "solution" | "product";
  productId?: string;
  priority: number;
  score: number;
  label: string;
  groupCount?: number;
}

interface ExecContext {
  game: CustomGameState;
  registry: CustomCardRegistry;
  actor: PlayerId;
  sourceCard?: CardId;
  sourceComboId?: string;
  heldInstanceId?: string;
  heldInstance?: CardInstance;
  vars: Record<string, unknown>;
  batchId: string;
  event?: CustomEventContext & { matchCount?: number };
  selfInstanceId?: string;
  deferred: DeferredTrigger[];
  steps: CustomStep[];
  pc: number;
  depth: number;
  spendOnFinish: boolean;
  pendingChoiceStep?: CustomStep;
}

interface SweepResult {
  cards: number;
  groups: number;
  specialGroups: number;
}

const NH4OH_DISPLACEMENT_PRIORITY = 5;

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

const CUSTOM_ACTION_EVENT: Record<CustomLegalAction["kind"], { category: GameEventLogEntry["category"]; operation: string }> = {
  "play-ion": { category: "操作", operation: "打出离子牌" },
  "play-special": { category: "操作", operation: "打出特殊牌" },
  "play-operation": { category: "操作", operation: "打出操作牌" },
  "play-combo": { category: "操作", operation: "打出组合牌" },
  pass: { category: "操作", operation: "跳过出牌" },
  "accept-draw": { category: "摸牌", operation: "接受摸牌" },
  follow: { category: "操作", operation: "跟出加牌" },
  counter: { category: "操作", operation: "抵挡加牌" },
  choice: { category: "操作", operation: "完成选择" },
};

function appendCustomEvent(
  game: CustomGameState,
  player: CustomPlayerState | undefined,
  input: {
    category: GameEventLogEntry["category"];
    operation: string;
    quantity?: number;
    cards?: CardId[];
    result: string;
    pointsOperation?: string;
    normalizedPointsOperation?: string;
  },
): GameEventLogEntry {
  game.eventLog ??= [];
  const entry: GameEventLogEntry = {
    sequence: game.eventLog.length + 1,
    timestamp: Date.now(),
    category: input.category,
    playerId: player?.id,
    username: player?.profile?.username,
    nickname: player?.profile?.nickname ?? player?.nickname,
    role: player?.profile?.role,
    operation: input.operation,
    quantity: input.quantity,
    cards: [...(input.cards ?? [])],
    result: input.result,
    remainingCards: (player?.hand ?? []).map((instance) => instance.cardId),
    solutionCards: game.zones.solution.map((instance) => instance.cardId),
    productGroups: game.zones.products.map((product) => product.cards.map((instance) => instance.cardId)),
    pointsOperation: input.pointsOperation,
    normalizedPointsOperation: input.normalizedPointsOperation,
    cumulativePoints: game.scoring?.total ?? 0,
    scoreMultiplier: currentGameLogMultiplier(game),
    remainingActionPoints: customLogRemainingActionPoints(game, player),
  };
  game.eventLog.push(entry);
  return entry;
}

function customLogRemainingActionPoints(game: CustomGameState, player: CustomPlayerState | undefined): number {
  if (!player) return game.actionPoints;
  return game.players[game.currentPlayer]?.id === player.id ? game.actionPoints : 0;
}

function appendCustomRuntimeEvent(
  game: CustomGameState,
  player: CustomPlayerState | undefined,
  input: {
    category: GameEventLogEntry["category"];
    operation: string;
    quantity?: number;
    cards?: CardId[];
    result: string;
    pointsOperation?: string;
    normalizedPointsOperation?: string;
  },
): GameEventLogEntry {
  game.log.unshift(input.result);
  return appendCustomEvent(game, player, input);
}

export function createCustomGame(options: CreateCustomGameOptions): CustomGameState {
  const rules = options.rules;
  const openingExchangeDisabled = rules.setup.disableOpeningExchange === true;
  if (options.players.some((player) => (player as { bot?: boolean }).bot)) throw new Error("自定义模式不允许机器人");
  const activeDeck = customDeckForPlayerCount(rules, options.players.length);
  const registry = createCustomCardRegistry(rules);
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
  const state: CustomGameState = {
    id: `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: "playing",
    mode: options.mode,
    rulesetMode: "custom",
    revision: 0,
    players: [],
    zones: { solution: [], products: [], discard: [], drawPile: [] },
    currentPlayer: 0,
    startingSeat: 0,
    direction: 1,
    actionPoints: 1,
    turnStartedAt: Date.now(),
    log: ["游戏开始（自定义规则）"],
    eventLog: [],
    logScoreMultiplier: 1,
    rngSeed: seed,
    turnTimeLimitMs: options.turnTimeLimitMs ?? TURN_MS,
    openingExchangeWindowMs: options.openingExchangeWindowMs ?? OPENING_EXCHANGE_MS,
    custom: {
      rulesHash: rules.hash,
      rules,
      instanceSeq: 0,
      batchSeq: 0,
      rngState: seed || 123456789,
      deferredTriggers: [],
      audioEvents: [],
      inspectReveals: [],
      playedListenerSeq: 0,
    },
    scoring: {
      baseBet: Math.max(0, Math.floor(options.baseBet ?? 0)),
      multiplier: 1,
      stake: Math.max(0, Math.floor(options.baseBet ?? 0)),
      total: Math.max(0, Math.floor(options.baseBet ?? 0)),
      pendingByPlayerId: {},
      openingDoublePlayerIds: [],
    },
  };

  const deck: CardInstance[] = [];
  for (const [cardId, count] of Object.entries(activeDeck.cards)) {
    for (let i = 0; i < count; i++) deck.push(newInstance(state, cardId));
  }
  shuffleRng(state, deck);
  state.zones.drawPile = deck;

  const players: CustomPlayerState[] = options.players.map((player, seat) => ({
    id: `p_${seat}_${Math.random().toString(36).slice(2, 8)}`,
    nickname: player.nickname.trim() || `玩家${seat + 1}`,
    accountId: player.accountId,
    profile: player.profile,
    hand: [],
    online: true,
    lastSeenAt: Date.now(),
    seat,
    timeoutLimitMs: options.turnTimeLimitMs ?? TURN_MS,
    timeoutStreak: 0,
    normalStreak: 0,
    forcedAutoplay: false,
    canOpeningExchange: !openingExchangeDisabled && Boolean(player.canOpeningExchange),
    openingExchangeMin: player.profile?.permissions?.exchangeMin ?? 0,
    openingExchangeMax: player.profile?.permissions ? player.profile.permissions.exchangeMax : 3,
    openingExchangeWindowMs: options.openingExchangeWindowMs ?? OPENING_EXCHANGE_MS,
  }));
  state.players = players;

  // 开局冻结开房者额度，本局不再随权限变动；该额度限制每名输家的实际扣分。
  if (options.settlementLoserCap !== undefined) state.custom.settlementLoserCap = options.settlementLoserCap;

  // fixed deal first, then fill
  const dealRules = activeDeck.deal ?? [];
  const fillBySeat = new Map<number, number>();
  for (const [index, rule] of dealRules.entries()) {
    const seat = rule.seat ?? index;
    if (seat >= players.length) continue;
    const player = players[seat];
    for (const [cardId, count] of Object.entries(rule.fixed ?? {})) {
      for (let i = 0; i < count; i++) {
        const index = state.zones.drawPile.findIndex((instance) => instance.cardId === cardId);
        if (index < 0) throw new Error(`初始固定发牌失败：牌堆缺少 ${cardId}`);
        player.hand.push(state.zones.drawPile.splice(index, 1)[0]);
      }
    }
    if (rule.fill !== undefined) fillBySeat.set(seat, rule.fill);
  }
  const defaultHandSize = resolveDefaultHandSize(rules, players.length, options.handSize);
  for (const player of players) {
    const target = fillBySeat.get(player.seat) ?? defaultHandSize;
    while (player.hand.length < target) {
      const card = state.zones.drawPile.pop();
      if (!card) throw new Error(`初始发牌失败：牌堆不足以将座位 ${player.seat + 1} 补足到 ${target} 张`);
      player.hand.push(card);
    }
    sortHand(registry, player.hand);
  }

  const openingDoublingEnabled = options.mode === "online" && (options.baseBet ?? 0) > 0;
  const eligibleOpening = openingExchangeDisabled
    ? openingDoublingEnabled
      ? players.map((player) => player.id)
      : []
    : players.filter((player) => player.canOpeningExchange).map((player) => player.id);
  const startingSeat = Number.isInteger(options.startingSeat) ? Math.max(0, Math.min(players.length - 1, options.startingSeat as number)) : 0;
  state.startingSeat = startingSeat;
  state.currentPlayer = startingSeat;
  const openingStartedAt = Date.now();
  const openingDeadlines = Object.fromEntries(
    players
      .filter((player) => eligibleOpening.includes(player.id))
      .map((player) => [player.id, options.mode === "local" ? 0 : openingStartedAt + Math.max(0, player.openingExchangeWindowMs ?? OPENING_EXCHANGE_MS)]),
  );
  if (eligibleOpening.length > 0) {
    state.status = "opening-exchange";
    state.openingExchange = {
      deadlineAt: options.mode === "local" ? 0 : Math.max(openingStartedAt, ...Object.values(openingDeadlines).filter((deadline) => deadline > 0)),
      deadlineByPlayerId: openingDeadlines,
      eligiblePlayerIds: eligibleOpening,
      completedPlayerIds: openingExchangeDisabled ? [...eligibleOpening] : [],
      doubleCompletedPlayerIds: openingDoublingEnabled ? [] : [...eligibleOpening],
    };
    state.turnDeadlineAt = options.mode === "online" ? state.openingExchange.deadlineAt : undefined;
  } else {
    state.turnDeadlineAt = options.mode === "online" ? Date.now() + players[startingSeat].timeoutLimitMs : undefined;
    triggerCustomTurnStart(state, registry);
  }
  appendCustomEvent(state, undefined, {
    category: "开局",
    operation: "创建对局",
    result: `自定义对局 ${state.id}；规则 ${rules.displayName ?? rules.name}；玩家 ${players.length} 人；底注 ${state.scoring?.baseBet ?? 0}`,
  });
  for (const player of players) {
    appendCustomEvent(state, player, {
      category: "玩家信息",
      operation: "加入对局",
      result: `席位 ${player.seat + 1}；账号 ${player.accountId ?? "本地/访客"}；身份 ${player.profile?.role ?? "normal"}；初始账户积分 ${player.profile?.points ?? 0}`,
    });
    appendCustomEvent(state, player, {
      category: "发牌",
      operation: "初始发牌",
      quantity: player.hand.length,
      cards: player.hand.map((instance) => instance.cardId),
      result: `${player.profile?.username ? `@${player.profile.username}` : player.nickname} 获得初始手牌`,
    });
    state.log.unshift(`${player.nickname} 获得初始手牌 ${player.hand.length} 张`);
  }
  state.log.unshift(
    `自定义对局 ${state.id}；规则 ${rules.displayName ?? rules.name}；底注 ${state.scoring?.baseBet ?? 0}；倍率 x${state.scoring?.multiplier ?? 1}；stake ${state.scoring?.stake ?? 0}`,
  );
  return state;
}

function resolveDefaultHandSize(rules: ResolvedCustomRules, players: number, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const setup = customInitialHandForPlayerCount(rules, players);
  if (typeof setup === "number") return setup;
  if (Array.isArray(setup)) return setup[0];
  const total = Object.values(customDeckForPlayerCount(rules, players).cards).reduce((sum, count) => sum + count, 0);
  const recommended = players <= 2 ? 10 : players <= 4 ? 7 : players <= 7 ? 6 : 5;
  return Math.max(1, Math.min(recommended, Math.floor(total / Math.max(1, players))));
}

export function cloneCustomGame(game: CustomGameState): CustomGameState {
  const rules = game.custom.rules;
  const copy = structuredClone({ ...game, custom: { ...game.custom, rules: undefined } });
  (copy.custom as { rules?: unknown }).rules = rules;
  return copy;
}

export function customRegistryOf(game: CustomGameState): CustomCardRegistry {
  const rules = game.custom.rules as ResolvedCustomRules | undefined;
  if (!rules) throw new Error("当前状态缺少自定义规则快照");
  return createCustomCardRegistry(rules);
}

function newInstance(game: CustomGameState, cardId: CardId): CardInstance {
  game.custom.instanceSeq += 1;
  return { instanceId: `ci_${game.custom.instanceSeq.toString(36)}`, cardId, marks: [], counters: {} };
}

function rngNext(game: CustomGameState): number {
  let x = game.custom.rngState || 123456789;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  game.custom.rngState = x >>> 0 || 1;
  return (game.custom.rngState % 1_000_000) / 1_000_000;
}

function shuffleRng(game: CustomGameState, deck: CardInstance[]): void {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rngNext(game) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function sortHand(registry: CustomCardRegistry, hand: CardInstance[]): void {
  const typeOrder = { operation: 0, generic: 1, special: 2, ion: 3 } as const;
  hand.sort((a, b) => {
    const ta = registry.typeOf(a.cardId) ?? "ion";
    const tb = registry.typeOf(b.cardId) ?? "ion";
    if (typeOrder[ta] !== typeOrder[tb]) return typeOrder[ta] - typeOrder[tb];
    if (ta === "ion") return (registry.chargeOf(b.cardId) ?? 0) - (registry.chargeOf(a.cardId) ?? 0) || a.cardId.localeCompare(b.cardId);
    return a.cardId.localeCompare(b.cardId);
  });
}

export function currentCustomPlayer(game: CustomGameState): CustomPlayerState {
  return game.players[game.currentPlayer];
}

// ---------------------------------------------------------------------------
// formula scope
// ---------------------------------------------------------------------------

function compileCached(source: string | number): CompiledFormula {
  return compileFormula(typeof source === "number" ? String(source) : source);
}

function countBlockingForDistill(game: CustomGameState, registry: CustomCardRegistry): number {
  return game.zones.products.filter((group) => {
    if (group.kind === "solid" || group.kind === "micro" || group.kind === "gas" || group.kind === "special") return true;
    return group.cards.some((instance) => registry.typeOf(instance.cardId) === "special");
  }).length;
}

function makeFormulaScope(ctx: ExecContext, scoringOverride?: { stake: number; bet: number }): FormulaScope {
  const game = ctx.game;
  return {
    resolvePath(path) {
      const key = path.join(".");
      const root = path[0];
      if (key === "players") return game.players.length;
      if (key === "stake") return scoringOverride?.stake ?? game.scoring?.stake ?? 1;
      if (key === "bet") return scoringOverride?.bet ?? game.scoring?.baseBet ?? 1;
      if (key === "self") return game.players.find((player) => player.id === ctx.actor)?.seat ?? 0;
      if (root === "r" || (ctx.vars[root] !== undefined && isSweepVar(ctx.vars[root]))) {
        const variable = ctx.vars[root];
        if (isSweepVar(variable)) {
          if (path[1] === "cards") return variable.cards;
          if (path[1] === "groups") return variable.groups;
          if (path[1] === "specialGroups") return variable.specialGroups;
          if (path[1] === "name") return variable.name as FormulaValue;
        }
      }
      if (root === "event" && ctx.event) {
        if (path[1] === "matchCount") return ctx.event.matchCount ?? 0;
        if (path[1] === "actor") return ctx.event.actor;
      }
      if (root === "self" && path[1] === "counter" && ctx.selfInstanceId) {
        const instance = findInstanceById(game, ctx.selfInstanceId);
        if (instance && path[2]) return instance.counters[path[2]] ?? 0;
      }
      if (key === "field.products.blockingForDistill") return countBlockingForDistill(game, ctx.registry);
      if (key === "draw.source") return game.pendingDraw?.sourceSeat;
      return undefined;
    },
    callFunction(name, args) {
      if (name !== "next") return undefined;
      const seat = typeof args[0] === "number" ? args[0] : undefined;
      if (seat === undefined) return undefined;
      return nextCustomSeat(game, seat);
    },
  };
}

function isSweepVar(value: unknown): value is SweepResult & { name?: string } {
  return Boolean(value && typeof value === "object" && "cards" in (value as Record<string, unknown>));
}

function evalCount(ctx: ExecContext, source: string | number, label: string): number {
  try {
    return evaluateFormulaCount(compileCached(source), makeFormulaScope(ctx));
  } catch (error) {
    throw new Error(`${label} 计算失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function evalNumber(ctx: ExecContext, source: string | number, label: string): number {
  return evaluateFormulaNumber(compileCached(source), makeFormulaScope(ctx));
}

// ---------------------------------------------------------------------------
// zones / instances
// ---------------------------------------------------------------------------

function findInstanceById(game: CustomGameState, instanceId: string): CardInstance | undefined {
  const scan = (instances: CardInstance[]): CardInstance | undefined => instances.find((instance) => instance.instanceId === instanceId);
  for (const player of game.players) {
    const hit = scan(player.hand);
    if (hit) return hit;
  }
  return scan(game.zones.solution) ?? scan(game.zones.discard) ?? scan(game.zones.drawPile) ?? scan(game.zones.products.flatMap((group) => group.cards));
}

function detachInstance(game: CustomGameState, instanceId: string): CardInstance | undefined {
  const detachFrom = (instances: CardInstance[]): CardInstance | undefined => {
    const index = instances.findIndex((instance) => instance.instanceId === instanceId);
    return index >= 0 ? instances.splice(index, 1)[0] : undefined;
  };
  for (const player of game.players) {
    const hit = detachFrom(player.hand);
    if (hit) return hit;
  }
  let hit = detachFrom(game.zones.solution) ?? detachFrom(game.zones.discard) ?? detachFrom(game.zones.drawPile);
  if (hit) return hit;
  for (const group of game.zones.products) {
    hit = detachFrom(group.cards);
    if (hit) {
      game.zones.products = game.zones.products.filter((item) => item.cards.length > 0);
      return hit;
    }
  }
  return undefined;
}

function removeHandInstances(player: CustomPlayerState, instanceIds: string[]): CardInstance[] {
  const removed: CardInstance[] = [];
  for (const id of instanceIds) {
    const index = player.hand.findIndex((instance) => instance.instanceId === id);
    if (index >= 0) removed.push(player.hand.splice(index, 1)[0]);
  }
  return removed;
}

function markReactionPriority(instance: CardInstance): number {
  let priority = 0;
  for (const mark of instance.marks) {
    if (typeof mark.reactionPriority === "number" && mark.reactionPriority > priority) priority = mark.reactionPriority;
  }
  return priority;
}

function takeInstancesByCardId(zone: CardInstance[], cardId: CardId, count: number): CardInstance[] {
  // 反应优先操作带高 reactionPriority 标记（如“大恶霸”）的同名牌；同优先级保持后进先出
  const candidates: Array<{ index: number; priority: number }> = [];
  for (let i = 0; i < zone.length; i++) {
    if (zone[i].cardId === cardId) candidates.push({ index: i, priority: markReactionPriority(zone[i]) });
  }
  candidates.sort((a, b) => b.priority - a.priority || b.index - a.index);
  const chosen = candidates
    .slice(0, count)
    .map((entry) => entry.index)
    .sort((a, b) => b - a);
  const taken: CardInstance[] = [];
  for (const index of chosen) taken.push(zone.splice(index, 1)[0]);
  return taken.reverse();
}

// ---------------------------------------------------------------------------
// unified removal + event dispatch
// ---------------------------------------------------------------------------

interface RemovalContext extends CustomEventContext {
  allowDefer?: boolean;
  exec?: ExecContext;
}

function sanitizeEvent(context: RemovalContext): CustomEventContext {
  return {
    actor: context.actor,
    cause: context.cause,
    sourceCard: context.sourceCard,
    reactionResult: context.reactionResult,
    batchId: context.batchId,
  };
}

function removeInstances(game: CustomGameState, registry: CustomCardRegistry, instances: CardInstance[], context: RemovalContext): void {
  if (instances.length === 0) return;
  for (const instance of instances) {
    detachInstance(game, instance.instanceId);
  }
  game.zones.discard.push(...instances);
  dispatchRemoval(game, registry, instances, context);
}

function dispatchMarkedReacted(game: CustomGameState, registry: CustomCardRegistry, instances: CardInstance[], context: CustomEventContext): void {
  for (const instance of instances) {
    for (const mark of instance.marks) {
      for (const listener of mark.listeners) {
        if (listener.when !== "marked.reacted") continue;
        if (!listenerMatchesEvent(listener, context)) continue;
        const exec: ExecContext = {
          game,
          registry,
          actor: context.actor ?? mark.ownerId ?? currentCustomPlayer(game).id,
          sourceCard: context.sourceCard,
          vars: {},
          batchId: context.batchId ?? nextBatchId(game),
          event: sanitizeEvent(context),
          selfInstanceId: instance.instanceId,
          deferred: [],
          steps: listener.do,
          pc: 0,
          depth: 0,
          spendOnFinish: false,
        };
        runSteps(exec);
      }
    }
  }
}

function dispatchRemoval(game: CustomGameState, registry: CustomCardRegistry, instances: CardInstance[], context: RemovalContext): void {
  for (const instance of instances) {
    // mark listeners fire immediately, even inside deferred operation resolution
    for (const mark of instance.marks.splice(0)) {
      for (const listener of mark.listeners) {
        if (listener.when !== "marked.removed") continue;
        if (!listenerMatchesEvent(listener, context)) continue;
        const exec: ExecContext = {
          game,
          registry,
          actor: mark.ownerId ?? context.actor ?? currentCustomPlayer(game).id,
          sourceCard: context.sourceCard,
          vars: {},
          batchId: context.batchId ?? nextBatchId(game),
          event: sanitizeEvent(context),
          selfInstanceId: instance.instanceId,
          deferred: [],
          steps: listener.do,
          pc: 0,
          depth: 0,
          spendOnFinish: false,
        };
        runSteps(exec);
      }
    }
    const def = registry.get(instance.cardId);
    if (def?.type === "special" && def.on) {
      for (const listener of def.on) {
        if (listener.when !== "self.removed") continue;
        if (!listenerMatchesEvent(listener, context)) continue;
        const trigger: DeferredTrigger = { listener, selfInstanceId: instance.instanceId, event: sanitizeEvent(context) };
        if (listener.phase === "afterOperationPrimaryEffect" && context.exec) {
          context.exec.deferred.push(trigger);
        } else {
          runListenerTrigger(game, registry, trigger);
        }
      }
    }
  }
}

function runListenerTrigger(game: CustomGameState, registry: CustomCardRegistry, trigger: DeferredTrigger, scoreToOverride?: PlayerId): void {
  const exec: ExecContext = {
    game,
    registry,
    actor: trigger.event.actor ?? currentCustomPlayer(game).id,
    sourceCard: trigger.event.sourceCard,
    vars: scoreToOverride ? { __scoreTo: scoreToOverride } : {},
    batchId: trigger.event.batchId ?? nextBatchId(game),
    event: { ...trigger.event },
    selfInstanceId: trigger.selfInstanceId,
    deferred: [],
    steps: trigger.listener.do,
    pc: 0,
    depth: 0,
    spendOnFinish: false,
  };
  runSteps(exec);
}

function nextBatchId(game: CustomGameState): string {
  game.custom.batchSeq += 1;
  return `b_${game.custom.batchSeq.toString(36)}`;
}

function dispatchPlayedBatch(game: CustomGameState, registry: CustomCardRegistry, actor: PlayerId, entries: Array<{ cardId: CardId; count: number }>): string {
  const batchId = nextBatchId(game);
  const hits = collectMarkListeners(game, "card.playedBatch");
  for (const hit of hits) {
    const whereName = hit.listener.where?.name;
    if (whereName !== "marked.name") continue;
    const markedName = hit.instance.cardId;
    const matchCount = entries.filter((entry) => entry.cardId === markedName).reduce((sum, entry) => sum + entry.count, 0);
    if (matchCount <= 0) continue;
    const mark = hit.instance.marks[hit.markIndex];
    const exec: ExecContext = {
      game,
      registry,
      actor: mark?.ownerId ?? actor,
      vars: {},
      batchId,
      event: { actor, cause: "other", batchId, matchCount },
      selfInstanceId: hit.instance.instanceId,
      deferred: [],
      steps: hit.listener.do,
      pc: 0,
      depth: 0,
      spendOnFinish: false,
    };
    runSteps(exec);
  }
  // special card `on` listeners may also subscribe to card.playedBatch
  for (const group of game.zones.products) {
    for (const instance of group.cards) {
      const def = registry.get(instance.cardId);
      if (def?.type !== "special" || !def.on) continue;
      for (const listener of def.on) {
        if (listener.when !== "card.playedBatch") continue;
        const exec: ExecContext = {
          game,
          registry,
          actor: instance.ownerPlayerId ?? actor,
          vars: {},
          batchId,
          event: { actor, cause: "other", batchId, matchCount: 0 },
          selfInstanceId: instance.instanceId,
          deferred: [],
          steps: listener.do,
          pc: 0,
          depth: 0,
          spendOnFinish: false,
        };
        runSteps(exec);
      }
    }
  }
  return batchId;
}

// ---------------------------------------------------------------------------
// chemistry (ported from the classic engine, instance-aware)
// ---------------------------------------------------------------------------

function buildCustomReaction(
  registry: CustomCardRegistry,
  played: CardId,
  playedCount: number,
  other: CardId,
  availableOther: number,
  source: "solution" | "product",
  productId?: string,
  availablePlayedInSolution = 0,
  productCards?: CardInstance[],
  availableOtherInSolution = 0,
): CustomReactionGroup | undefined {
  const playedCharge = registry.chargeOf(played) ?? 0;
  const otherCharge = registry.chargeOf(other) ?? 0;
  if (!registry.isIon(other) || Math.sign(playedCharge) === Math.sign(otherCharge)) return undefined;
  const kind = registry.reactionKind(played, other);
  if (!kind) return undefined;
  const [playedPerGroup, tablePerGroup] = registry.balance(played, other);
  const availablePlayed = playedCount + availablePlayedInSolution;
  const possibleGroups = Math.min(Math.floor(availablePlayed / playedPerGroup), Math.floor((availableOther + Math.max(0, availableOtherInSolution)) / tablePerGroup));
  const groupCount = kind === "micro" ? possibleGroups - 1 : possibleGroups;
  if (groupCount < 1) return undefined;
  const playedNeeded = playedPerGroup * groupCount;
  const tableNeeded = tablePerGroup * groupCount;
  const solutionPlayedNeeded = Math.max(0, playedNeeded - playedCount);
  const solutionTableNeeded = Math.min(Math.max(0, availableOtherInSolution), Math.max(0, tableNeeded - availableOther));
  if (playedCount + solutionPlayedNeeded < playedNeeded || solutionPlayedNeeded > availablePlayedInSolution || availableOther + solutionTableNeeded < tableNeeded) {
    return undefined;
  }
  let priority = customReactionPriority(played, other, kind);
  if (
    source === "product" &&
    productCards?.some((instance) => instance.cardId === "NH_4^+") &&
    ((played === "H^+" && other === "OH^-") || (played === "OH^-" && other === "H^+"))
  ) {
    priority = Math.max(priority, NH4OH_DISPLACEMENT_PRIORITY);
  }
  return {
    id: `${source}:${productId ?? "solution"}:${played}:${other}:${playedNeeded}:${solutionPlayedNeeded}:${tableNeeded}:${solutionTableNeeded}:${kind}`,
    kind,
    playedCard: played,
    playedNeeded,
    solutionPlayedNeeded,
    tableCard: other,
    tableNeeded,
    solutionTableNeeded: solutionTableNeeded > 0 ? solutionTableNeeded : undefined,
    source,
    productId,
    priority,
    score: playedNeeded + tableNeeded,
    label: `${registry.displayName(played)} + ${registry.displayName(other)} -> ${kind}`,
    groupCount,
  };
}

function customReactionPriority(played: CardId, other: CardId, kind: ProductKind): number {
  const acidBasePriority: Record<string, number> = { "OH^-": 0, "S^{2-}": 10, "SO_3^{2-}": 10, "CO_3^{2-}": 10, "SiO_3^{2-}": 20, "PO_4^{3-}": 30, "Ac^-": 30 };
  if (played === "H^+" && acidBasePriority[other] !== undefined) return acidBasePriority[other];
  if (other === "H^+" && acidBasePriority[played] !== undefined) return acidBasePriority[played];
  if ((played === "OH^-" && other === "NH_4^+") || (played === "NH_4^+" && other === "OH^-")) return 40;
  const hydroxidePriority: Record<string, number> = {
    "Fe^{3+}": 50,
    "Al^{3+}": 50,
    "Cu^{2+}": 55,
    "Fe^{2+}": 55,
    "Mg^{2+}": 60,
    "Zn^{2+}": 60,
    "Pb^{2+}": 60,
    "Ca^{2+}": 65,
    "Ag^+": 70,
  };
  if (played === "OH^-" && hydroxidePriority[other] !== undefined) return hydroxidePriority[other];
  if (other === "OH^-" && hydroxidePriority[played] !== undefined) return hydroxidePriority[played];
  const kindPriority: Record<ProductKind, number> = { gas: 100, solid: 200, micro: 210, weak: 300, nonexistent: 400, special: 500 };
  return kindPriority[kind];
}

function countByCardId(instances: CardInstance[]): Record<CardId, number> {
  return instances.reduce<Record<CardId, number>>((acc, instance) => {
    acc[instance.cardId] = (acc[instance.cardId] ?? 0) + 1;
    return acc;
  }, {});
}

function canDisplaceCustomProduct(registry: CustomCardRegistry, reagent: CardId, targetIon: CardId, product: CustomCardInstanceGroup): boolean {
  if (product.kind === "micro") return Boolean(registry.reactionKind(reagent, targetIon));
  if (reagent === "H^+") {
    if (targetIon === "OH^-") return true;
    if (!CHEMISTRY_WEAK_ACID_ANIONS.has(targetIon)) return false;
    return !(targetIon === "S^{2-}" && product.cards.some((instance) => instance.cardId === "Cu^{2+}"));
  }
  if (reagent === "OH^-" && targetIon === "H^+") {
    return product.cards.some((instance) => CHEMISTRY_WEAK_ACID_ANIONS.has(instance.cardId));
  }
  if (targetIon === "H^+" && CHEMISTRY_WEAK_ACID_ANIONS.has(reagent)) {
    const productAnion = product.cards.find((instance) => CHEMISTRY_WEAK_ACID_ANIONS.has(instance.cardId));
    if (!productAnion) return false;
    return (CHEMISTRY_WEAK_ACID_STRENGTH[productAnion.cardId] ?? 0) < (CHEMISTRY_WEAK_ACID_STRENGTH[reagent] ?? 0);
  }
  return false;
}

function findCustomReactionTargets(game: CustomGameState, registry: CustomCardRegistry, card: CardId, playedCount: number): CustomReactionGroup[] {
  if (!registry.isIon(card)) return [];
  const targets: CustomReactionGroup[] = [];
  const solutionCounts = countByCardId(game.zones.solution);
  for (const [other, available] of Object.entries(solutionCounts)) {
    const group = buildCustomReaction(registry, card, playedCount, other, available, "solution", undefined, solutionCounts[card] ?? 0);
    if (group) targets.push(group);
  }
  for (const product of game.zones.products) {
    if (product.inert) continue;
    const productCounts = countByCardId(product.cards);
    for (const [other, available] of Object.entries(productCounts)) {
      if (!canDisplaceCustomProduct(registry, card, other, product)) continue;
      const otherInSolution = other === "H^+" && CHEMISTRY_WEAK_ACID_ANIONS.has(card) ? solutionCounts["H^+"] ?? 0 : 0;
      const group = buildCustomReaction(registry, card, playedCount, other, available, "product", product.id, solutionCounts[card] ?? 0, product.cards, otherInSolution);
      if (group && customRecreatesSameProduct(product.cards, card, group.playedNeeded, other, group.tableNeeded)) continue;
      if (group) targets.push(group);
    }
  }
  const sorted = targets.sort((a, b) => a.priority - b.priority || b.score - a.score);
  const best = sorted[0]?.priority;
  return best === undefined ? [] : sorted.filter((target) => target.priority === best);
}

const CUSTOM_PRODUCT_KIND_LABELS: Record<ProductKind, string> = {
  solid: "沉淀",
  gas: "气体",
  weak: "弱电解质",
  nonexistent: "不存在物",
  micro: "微溶物",
  special: "特殊物质",
};

function customReactionTargetChoiceLabel(game: CustomGameState, registry: CustomCardRegistry, target: CustomReactionGroup): string {
  const source = target.source === "solution"
    ? "溶液区"
    : `生成物区第 ${Math.max(0, game.zones.products.findIndex((product) => product.id === target.productId)) + 1} 组`;
  return `${source}：${registry.displayName(target.playedCard)} 与 ${registry.displayName(target.tableCard)} 反应（${CUSTOM_PRODUCT_KIND_LABELS[target.kind]}）`;
}

function customRecreatesSameProduct(productCards: CardInstance[], played: CardId, playedNeeded: number, other: CardId, otherNeeded: number): boolean {
  const currentCounts = countByCardId(productCards);
  const nextCounts: Record<string, number> = {};
  nextCounts[played] = playedNeeded;
  nextCounts[other] = (nextCounts[other] ?? 0) + otherNeeded;
  const keys = new Set([...Object.keys(currentCounts), ...Object.keys(nextCounts)]);
  return [...keys].every((card) => (currentCounts[card] ?? 0) === (nextCounts[card] ?? 0));
}

function isWaterInstances(cards: CardInstance[]): boolean {
  const counts = countByCardId(cards);
  return Object.keys(counts).length === 2 && (counts["H^+"] ?? 0) === (counts["OH^-"] ?? 0) && (counts["H^+"] ?? 0) > 0;
}

function resolveCustomReactionTarget(
  game: CustomGameState,
  registry: CustomCardRegistry,
  actor: PlayerId,
  card: CardId,
  playedInstances: CardInstance[],
  target: CustomReactionGroup,
  batchId: string,
): void {
  const playedCount = playedInstances.length;
  const usedPlayed = target.playedNeeded - (target.solutionPlayedNeeded ?? 0);
  const leftover = playedCount - usedPlayed;
  const removedForReaction: CardInstance[] = [];
  if (target.solutionPlayedNeeded) removedForReaction.push(...takeInstancesByCardId(game.zones.solution, card, target.solutionPlayedNeeded));
  if (target.source === "solution") {
    removedForReaction.push(...takeInstancesByCardId(game.zones.solution, target.tableCard, target.tableNeeded));
  } else {
    const product = game.zones.products.find((item) => item.id === target.productId);
    if (product) {
      if (target.solutionTableNeeded) removedForReaction.push(...takeInstancesByCardId(game.zones.solution, target.tableCard, target.solutionTableNeeded));
      removedForReaction.push(...takeInstancesByCardId(product.cards, target.tableCard, target.tableNeeded - (target.solutionTableNeeded ?? 0)));
      // free the remainder of the broken product
      for (const free of product.cards.splice(0)) {
        if (registry.isIon(free.cardId)) game.zones.solution.push(free);
        else removeInstances(game, registry, [free], { actor, cause: "reaction", reactionResult: target.kind, batchId });
      }
      game.zones.products = game.zones.products.filter((item) => item.cards.length > 0);
    }
  }
  const reacting = [...playedInstances.slice(0, usedPlayed), ...removedForReaction];
  const reactionResult = target.kind === "nonexistent" ? "nonexistent" : isWaterInstances(reacting) ? "water" : target.kind;
  dispatchMarkedReacted(game, registry, reacting, { actor, cause: "reaction", reactionResult, batchId });
  if (reactionResult === "nonexistent" || reactionResult === "water") {
    removeInstances(game, registry, reacting, { actor, cause: "reaction", reactionResult, batchId });
    game.log.unshift(`${playerName(game, actor)} 触发 ${target.label}，生成物不能在水中存在，参与反应的牌进入弃牌堆`);
  } else {
    const groups = target.groupCount ?? 1;
    if (groups > 1) {
      const playedPerGroup = target.playedNeeded / groups;
      const tablePerGroup = target.tableNeeded / groups;
      for (let i = 0; i < groups; i++) {
        const groupCards = [
          ...reacting.filter((instance) => instance.cardId === card).slice(i * playedPerGroup, (i + 1) * playedPerGroup),
          ...reacting.filter((instance) => instance.cardId === target.tableCard).slice(i * tablePerGroup, (i + 1) * tablePerGroup),
        ];
        game.zones.products.push(makeCustomProduct(game, registry, target.kind, groupCards, target.label, actor));
      }
    } else {
      game.zones.products.push(makeCustomProduct(game, registry, target.kind, reacting, target.label, actor));
    }
  }
  if (leftover > 0) game.zones.solution.push(...playedInstances.slice(usedPlayed));
  const bonus = Math.ceil(reacting.length / 2);
  game.actionPoints += bonus;
  const points = addCustomScore(game, actor, bonus);
  const result = `${playerName(game, actor)}：${reacting.map((instance) => registry.displayName(instance.cardId)).join(" ")} 发生反应，生成${reactionResult === "water" ? "水" : target.kind}，额外获得 ${bonus} 次出牌机会${points > 0 ? `（+${points} 积分）` : ""}`;
  game.log.unshift(result);
  appendCustomEvent(game, game.players.find((player) => player.id === actor), {
    category: "操作",
    operation: "增加出牌机会",
    quantity: bonus,
    cards: reacting.map((instance) => instance.cardId),
    result,
    pointsOperation: points > 0 ? `+${points}` : undefined,
    normalizedPointsOperation: bonus > 0 ? `+${bonus}` : undefined,
  });
}

function makeCustomProduct(
  game: CustomGameState,
  registry: CustomCardRegistry,
  kind: ProductKind,
  cards: CardInstance[],
  label?: string,
  ownerPlayerId?: PlayerId,
): CustomCardInstanceGroup {
  game.custom.instanceSeq += 1;
  const hasSpecial = cards.some((instance) => registry.typeOf(instance.cardId) === "special");
  return {
    id: `pg_${game.custom.instanceSeq.toString(36)}`,
    kind,
    cards,
    label: label ?? `${cards.map((instance) => registry.displayName(instance.cardId)).join(" + ")} -> ${kind}`,
    inert: hasSpecial ? true : undefined,
    ownerPlayerId,
  };
}

function stabilizeCustomTable(game: CustomGameState, registry: CustomCardRegistry, actor: PlayerId, batchId: string): boolean {
  let changed = false;
  for (let guard = 0; guard < CUSTOM_LIMITS.maxChainReactions * 4; guard++) {
    const dissolved = rebalanceCustomMicroProducts(game, registry);
    if (dissolved) changed = true;
    const target = findNextCustomTableReaction(game, registry);
    if (!target) {
      if (!dissolved) return changed;
      continue;
    }
    changed = true;
    resolveCustomReactionTarget(game, registry, actor, target.playedCard, [], target, batchId);
  }
  game.log.unshift("连续反应达到安全上限，请检查当前牌面");
  return changed;
}

function findNextCustomTableReaction(game: CustomGameState, registry: CustomCardRegistry): CustomReactionGroup | undefined {
  const counts = countByCardId(game.zones.solution);
  const cards = Object.keys(counts);
  const targets: CustomReactionGroup[] = [];
  for (let left = 0; left < cards.length; left++) {
    for (let right = left + 1; right < cards.length; right++) {
      const played = cards[left];
      const other = cards[right];
      const group = buildCustomReaction(registry, played, 0, other, counts[other] ?? 0, "solution", undefined, counts[played] ?? 0);
      if (group) targets.push(group);
    }
  }
  for (const played of cards) {
    for (const product of game.zones.products) {
      if (product.inert) continue;
      for (const [other, available] of Object.entries(countByCardId(product.cards))) {
        if (!canDisplaceCustomProduct(registry, played, other, product)) continue;
        const otherInSolution = other === "H^+" && CHEMISTRY_WEAK_ACID_ANIONS.has(played) ? counts["H^+"] ?? 0 : 0;
        const group = buildCustomReaction(registry, played, 0, other, available, "product", product.id, counts[played] ?? 0, product.cards, otherInSolution);
        if (group && !customRecreatesSameProduct(product.cards, played, group.playedNeeded, other, group.tableNeeded)) targets.push(group);
      }
    }
  }
  return targets.sort((a, b) => a.priority - b.priority || b.score - a.score || a.id.localeCompare(b.id))[0];
}

function rebalanceCustomMicroProducts(game: CustomGameState, registry: CustomCardRegistry): boolean {
  const byFormula = new Map<string, CustomCardInstanceGroup[]>();
  for (const product of game.zones.products.filter((item) => item.kind === "micro")) {
    const key = Object.entries(countByCardId(product.cards))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([card, count]) => `${card}:${count}`)
      .join("|");
    const list = byFormula.get(key) ?? [];
    list.push(product);
    byFormula.set(key, list);
  }
  if (byFormula.size === 0) return false;
  let changed = false;
  const available = countByCardId(game.zones.solution);
  for (const products of byFormula.values()) {
    const needed = countByCardId(products[0].cards);
    const has = Object.entries(needed).every(([card, count]) => (available[card] ?? 0) >= count);
    if (!has) {
      const dissolved = products[0];
      game.zones.products = game.zones.products.filter((item) => item.id !== dissolved.id);
      game.zones.solution.push(...dissolved.cards);
      for (const card of dissolved.cards) available[card.cardId] = (available[card.cardId] ?? 0) + 1;
      game.log.unshift(`${dissolved.label} 溶回溶液区，以保留一组微溶物离子`);
      changed = true;
    }
    if (Object.entries(needed).every(([card, count]) => (available[card] ?? 0) >= count)) {
      for (const [card, count] of Object.entries(needed)) available[card] = (available[card] ?? 0) - count;
    }
  }
  return changed;
}

function sweepResultKind(reagent: CardId, ion: CardId, kind: string): string {
  // H+ + OH- neutralization produces water, which the event layer must distinguish
  const pair = [reagent, ion].sort();
  if (pair[0] === "H^+" && pair[1] === "OH^-") return "water";
  return kind;
}

function sweepReactiveIonsKinded(game: CustomGameState, registry: CustomCardRegistry, reagent: CardId, actor: PlayerId, batchId: string): Map<string, CardInstance[]> {
  const removed = new Map<string, CardInstance[]>();
  const push = (kind: string, instances: CardInstance[]) => {
    if (instances.length === 0) return;
    removed.set(kind, [...(removed.get(kind) ?? []), ...instances]);
  };
  for (let guard = 0; guard < CUSTOM_LIMITS.maxChainReactions; guard++) {
    const dissolved = rebalanceCustomMicroProducts(game, registry);
    const before = [...removed.values()].reduce((sum, list) => sum + list.length, 0);
    for (const [ion, available] of Object.entries(countByCardId(game.zones.solution))) {
      if (!registry.isIon(ion)) continue;
      const kind = registry.reactionKind(reagent, ion);
      if (!kind) continue;
      const [, otherNeeded] = registry.balance(reagent, ion);
      const count = Math.floor(available / otherNeeded) * otherNeeded;
      if (count <= 0) continue;
      push(sweepResultKind(reagent, ion, kind), takeInstancesByCardId(game.zones.solution, ion, count));
    }
    for (const product of [...game.zones.products]) {
      if (product.inert) continue;
      const productCounts = countByCardId(product.cards);
      let touched = false;
      for (const [ion, available] of Object.entries(productCounts)) {
        if (!registry.isIon(ion) || !canDisplaceCustomProduct(registry, reagent, ion, product)) continue;
        const kind = registry.reactionKind(reagent, ion);
        if (!kind) continue;
        const [reagentNeeded, otherNeeded] = registry.balance(reagent, ion);
        if (customRecreatesSameProduct(product.cards, reagent, reagentNeeded, ion, otherNeeded)) continue;
        const count = Math.floor(available / otherNeeded) * otherNeeded;
        if (count <= 0) continue;
        push(sweepResultKind(reagent, ion, kind), takeInstancesByCardId(product.cards, ion, count));
        touched = true;
      }
      if (touched) releaseCustomProductRemainder(game, registry, product, actor, batchId);
    }
    const after = [...removed.values()].reduce((sum, list) => sum + list.length, 0);
    if (after === before && !dissolved) break;
  }
  return removed;
}

function releaseCustomProductRemainder(game: CustomGameState, registry: CustomCardRegistry, product: CustomCardInstanceGroup, actor: PlayerId, batchId: string): void {
  for (const instance of product.cards.splice(0)) {
    if (registry.isIon(instance.cardId)) game.zones.solution.push(instance);
    else removeInstances(game, registry, [instance], { actor, cause: "reaction", reactionResult: product.kind, batchId });
  }
  game.zones.products = game.zones.products.filter((item) => item.id !== product.id);
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

function addCustomScore(game: CustomGameState, playerId: PlayerId, units: number): number {
  addGameLogMultiplier(game, units);
  const scoring = game.scoring;
  if (!scoring || units <= 0) return 0;
  const stake = scoring.stake || 0;
  const points = units * stake;
  scoring.total = (scoring.total ?? stake) + points;
  scoring.pendingByPlayerId[playerId] = (scoring.pendingByPlayerId[playerId] ?? 0) + points;
  return points;
}

function addCustomScorePoints(game: CustomGameState, playerId: PlayerId, points: number, normalizedPoints = points): number {
  addGameLogMultiplier(game, normalizedPoints);
  const scoring = game.scoring;
  if (!scoring || points <= 0) return 0;
  scoring.total = (scoring.total ?? scoring.stake) + points;
  scoring.pendingByPlayerId[playerId] = (scoring.pendingByPlayerId[playerId] ?? 0) + points;
  return points;
}

function multiplyCustomPot(game: CustomGameState, playerId: PlayerId, factor: number): void {
  multiplyGameLogMultiplier(game, factor);
  const scoring = game.scoring;
  if (!scoring || factor <= 0) return;
  const current = scoring.total ?? scoring.stake;
  scoring.total = current * factor;
  scoring.pendingByPlayerId[playerId] = (scoring.pendingByPlayerId[playerId] ?? 0) + current * (factor - 1);
  game.log.unshift(`${playerName(game, playerId)} 使积分倍率 x${factor}，当前 stake ${scoring.stake}，累计积分 ${scoring.total}`);
}

function playerName(game: CustomGameState, playerId: PlayerId): string {
  return game.players.find((player) => player.id === playerId)?.nickname ?? playerId;
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

function drawInstances(
  game: CustomGameState,
  seat: number,
  count: number,
  scorePlayerId?: PlayerId,
  log?: { reason: string; operation?: string },
): CardInstance[] {
  const player = game.players[seat];
  const drawn: CardInstance[] = [];
  for (let i = 0; i < count; i++) {
    if (game.zones.drawPile.length === 0) recycleCustomDiscard(game);
    const card = game.zones.drawPile.pop();
    if (!card) break;
    player.hand.push(card);
    drawn.push(card);
    if (scorePlayerId) addCustomScore(game, scorePlayerId, 1);
  }
  if (log && player) {
    const shortage = drawn.length < count ? `，应摸 ${count} 张但牌堆仅提供 ${drawn.length} 张` : "";
    appendCustomRuntimeEvent(game, player, {
      category: "摸牌",
      operation: log.operation ?? "摸牌",
      quantity: drawn.length,
      cards: drawn.map((card) => card.cardId),
      result: `${player.nickname} 因${log.reason}摸牌 ${drawn.length} 张${shortage}`,
    });
  }
  return drawn;
}

function recycleCustomDiscard(game: CustomGameState, keepExistingPile = false): void {
  if (game.zones.discard.length === 0) return;
  const recycled = game.zones.discard.splice(0);
  const pile = keepExistingPile ? [...game.zones.drawPile, ...recycled] : recycled;
  shuffleRng(game, pile);
  game.zones.drawPile = pile;
}

function resolveTargetSeat(game: CustomGameState, ctx: ExecContext, ref: string): number | undefined {
  const actorSeat = game.players.find((player) => player.id === ctx.actor)?.seat ?? game.currentPlayer;
  switch (ref) {
    case "self":
      return actorSeat;
    case "event.actor": {
      const id = ctx.event?.actor;
      return id !== undefined ? game.players.find((player) => player.id === id)?.seat : undefined;
    }
    case "event.turnPlayer":
      return game.currentPlayer;
    case "owner": {
      const instance = ctx.selfInstanceId ? findInstanceById(game, ctx.selfInstanceId) : undefined;
      const owner = instance?.ownerPlayerId;
      if (owner) return game.players.find((player) => player.id === owner)?.seat;
      return actorSeat;
    }
    case "next":
      return nextCustomSeat(game, actorSeat);
    case "minHand":
      return minHandSeatFrom(game, actorSeat);
    default: {
      const bound = ctx.vars[ref];
      const playerId = typeof bound === "string" ? bound : ref;
      return game.players.find((player) => player.id === playerId)?.seat;
    }
  }
}

function nextCustomSeat(game: CustomGameState, from: number): number {
  return (from + game.direction + game.players.length) % game.players.length;
}

function minHandSeatFrom(game: CustomGameState, startSeat: number): number {
  return minHandSeatsFrom(game, startSeat)[0] ?? 0;
}

function minHandSeatsFrom(game: CustomGameState, startSeat: number): number[] {
  const min = Math.min(...game.players.map((player) => player.hand.length));
  const seats: number[] = [];
  let seat = startSeat;
  for (let i = 0; i < game.players.length; i++) {
    if (game.players[seat].hand.length === min) seats.push(seat);
    seat = nextCustomSeat(game, seat);
  }
  return seats;
}

// ---------------------------------------------------------------------------
// turn management
// ---------------------------------------------------------------------------

function spendCustomActionPoint(game: CustomGameState, registry: CustomCardRegistry): void {
  if (game.pendingDraw || game.pendingChoice) return;
  game.actionPoints -= 1;
  if (game.actionPoints > 0) {
    game.turnStartedAt = Date.now();
    game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentCustomPlayer(game).timeoutLimitMs : undefined;
    return;
  }
  if (game.status !== "playing") return;
  advanceCustomToNextPlayer(game, registry, true);
}

function advanceCustomToNextPlayer(game: CustomGameState, registry: CustomCardRegistry, triggerStart: boolean): void {
  game.currentPlayer = nextCustomSeat(game, game.currentPlayer);
  game.actionPoints = 1;
  game.turnStartedAt = Date.now();
  game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentCustomPlayer(game).timeoutLimitMs : undefined;
  if (triggerStart) triggerCustomTurnStart(game, registry);
}

function triggerCustomTurnStart(game: CustomGameState, registry: CustomCardRegistry): void {
  let guard = 0;
  while (guard++ < game.players.length) {
    const current = currentCustomPlayer(game);
    if (!current.skipped) break;
    current.skipped = false;
    game.log.unshift(`${current.nickname} 的回合被跳过`);
    advanceCustomToNextPlayer(game, registry, false);
  }
  fireTurnStarted(game, registry);
}

function fireTurnStarted(game: CustomGameState, registry: CustomCardRegistry): void {
  const turnPlayer = currentCustomPlayer(game);
  const fieldInstances = game.zones.products.flatMap((group) => group.cards);
  for (const instance of [...fieldInstances]) {
    const def = registry.get(instance.cardId);
    if (def?.type !== "special" || !def.on) continue;
    // ensure the instance is still on the field
    if (!game.zones.products.some((group) => group.cards.some((card) => card.instanceId === instance.instanceId))) continue;
    for (const listener of def.on) {
      if (listener.when !== "turn.started") continue;
      const exec: ExecContext = {
        game,
        registry,
        actor: instance.ownerPlayerId ?? turnPlayer.id,
        sourceCard: instance.cardId,
        vars: {},
        batchId: nextBatchId(game),
        event: { actor: turnPlayer.id, cause: "rule" },
        selfInstanceId: instance.instanceId,
        deferred: [],
        steps: listener.do,
        pc: 0,
        depth: 0,
        spendOnFinish: false,
      };
      runSteps(exec);
    }
  }
}

// ---------------------------------------------------------------------------
// pending draw flow
// ---------------------------------------------------------------------------

function queueCustomDrawFlow(
  game: CustomGameState,
  registry: CustomCardRegistry,
  source: CustomPlayerState,
  count: number,
  reason: string,
  sourceCard: CardId | undefined,
  sourceComboId: string | undefined,
  followAllowed: boolean,
  scorePlayerId: PlayerId | undefined,
  perPlayerCap: number,
  resumeCtx?: ExecContext,
): void {
  if (count <= 0) {
    return; // caller continues with remaining steps
  }
  const pending: PendingDrawState = {
    sourceSeat: source.seat,
    sourceActionPoints: game.actionPoints,
    turnSeat: source.seat,
    turnActionPoints: game.actionPoints,
    targetSeat: nextCustomSeat(game, source.seat),
    remaining: count,
    perPlayerCap,
    reason,
    functionCard: sourceCard,
    customFunctionComboId: sourceComboId,
    customFollowAllowed: followAllowed,
    followedPlayerIds: [],
    drawnByPlayerId: {},
    scorePlayerId,
    customContinuation: resumeCtx ? serializeExec(resumeCtx) : undefined,
  };
  game.pendingDraw = pending;
  enterCustomPendingDrawTurn(game, pending.targetSeat);
  game.log.unshift(`${currentCustomPlayer(game).nickname} 需要因${reason}加牌 ${count} 张`);
}

function enterCustomPendingDrawTurn(game: CustomGameState, seat: number): void {
  game.currentPlayer = seat;
  game.actionPoints = 1;
  game.turnStartedAt = Date.now();
  game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentCustomPlayer(game).timeoutLimitMs : undefined;
  if (game.pendingDraw) game.pendingDraw.targetSeat = seat;
}

function resolveCustomAcceptDraw(game: CustomGameState, registry: CustomCardRegistry, player: CustomPlayerState): void {
  const pending = game.pendingDraw;
  if (!pending) return;
  const amount = Math.min(pending.perPlayerCap, pending.remaining);
  const actual = drawInstances(game, player.seat, amount, pending.scorePlayerId, { reason: pending.reason, operation: "接受加牌" }).length;
  pending.drawnByPlayerId ??= {};
  pending.drawnByPlayerId[player.id] = (pending.drawnByPlayerId[player.id] ?? 0) + amount;
  pending.remaining -= amount;
  if (pending.remaining > 0) {
    let seat = nextCustomSeat(game, player.seat);
    for (let i = 0; i < game.players.length; i++) {
      if (seat !== pending.sourceSeat) {
        enterCustomPendingDrawTurn(game, seat);
        return;
      }
      seat = nextCustomSeat(game, seat);
    }
  }
  completeCustomPendingDraw(game, registry, pending);
}

function completeCustomPendingDraw(game: CustomGameState, registry: CustomCardRegistry, pending: PendingDrawState): void {
  const sourceSeat = pending.sourceSeat;
  pending.remaining = 0;
  game.pendingDraw = undefined;
  game.currentPlayer = pending.turnSeat ?? sourceSeat;
  game.actionPoints = Math.max(1, pending.turnActionPoints ?? pending.sourceActionPoints ?? 1);
  const continuation = pending.customContinuation;
  if (continuation) {
    const exec = deserializeExec(game, registry, continuation);
    exec.game = game;
    runSteps(exec);
    finishOperation(exec);
    return;
  }
  spendCustomActionPoint(game, registry);
}

function resolveCustomFollow(game: CustomGameState, registry: CustomCardRegistry, player: CustomPlayerState, action: CustomLegalAction): void {
  const pending = game.pendingDraw;
  if (!pending) return;
  const rules = game.custom.rules as ResolvedCustomRules;
  let label: string;
  if (pending.customFunctionComboId) {
    const comboId = pending.customFunctionComboId;
    const combo = rules.combos[comboId];
    const expected = combo ? comboInstancesFromHand(player, combo) : undefined;
    if (!combo || !customPendingFollowAllowed(pending, combo) || !customComboEnabled(rules, comboId, combo) || action.comboId !== comboId || !expected) return;
    if (expected.length !== action.instanceIds.length || expected.some((id) => !action.instanceIds.includes(id))) return;
    label = combo.displayName ?? comboId;
  } else {
    if (!pending.functionCard || action.comboId) return;
    const card = registry.get(pending.functionCard);
    const instance = action.instanceIds.length === 1 ? player.hand.find((item) => item.instanceId === action.instanceIds[0]) : undefined;
    if (!card || !customPendingFollowAllowed(pending, card) || instance?.cardId !== pending.functionCard) return;
    label = registry.displayName(instance.cardId);
  }
  const instances = removeHandInstances(player, action.instanceIds);
  if (instances.length !== action.instanceIds.length) return;
  fireTurnStartedForPlayer(game, registry, player.seat);
  game.zones.discard.push(...instances);
  drawInstances(game, player.seat, 1, undefined, { reason: `跟出 ${label}`, operation: "跟牌后摸牌" });
  pending.sourceSeat = player.seat;
  pending.targetSeat = nextCustomSeat(game, player.seat);
  pending.followedPlayerIds ??= [];
  pending.followedPlayerIds.push(player.id);
  enterCustomPendingDrawTurn(game, pending.targetSeat);
  game.log.unshift(`${player.nickname} 跟出 ${label}，将加牌效果传给 ${currentCustomPlayer(game).nickname}`);
}

function fireTurnStartedForPlayer(game: CustomGameState, registry: CustomCardRegistry, seat: number): void {
  // counter/follow actions happen outside a normal turn start; specials still radiate
  const saved = game.currentPlayer;
  game.currentPlayer = seat;
  fireTurnStarted(game, registry);
  game.currentPlayer = saved;
}

function resolveCustomCounter(game: CustomGameState, registry: CustomCardRegistry, player: CustomPlayerState, action: CustomLegalAction): void {
  const pending = game.pendingDraw;
  if (!pending) return;
  const rules = game.custom.rules as ResolvedCustomRules;
  const instances = removeHandInstances(player, action.instanceIds);
  if (instances.length !== action.instanceIds.length) return;
  fireTurnStartedForPlayer(game, registry, player.seat);
  for (const instance of instances) game.zones.discard.push(instance);
  const steps = action.comboId ? rules.combos[action.comboId]?.counter : registry.get(action.cardIds[0])?.counter;
  game.log.unshift(`${player.nickname} 用${action.description}抵挡加牌`);
  const exec: ExecContext = {
    game,
    registry,
    actor: player.id,
    sourceCard: action.cardIds[0],
    sourceComboId: action.comboId,
    vars: {},
    batchId: nextBatchId(game),
    deferred: [],
    steps: steps ?? [],
    pc: 0,
    depth: 0,
    spendOnFinish: false,
  };
  runSteps(exec);
  flushExecDeferred(exec);
  if (game.pendingDraw === pending) {
    // cancelDraw was not executed as a step; fall back to classic-like resolution
    game.pendingDraw = undefined;
    const sourceNext = nextCustomSeat(game, pending.sourceSeat);
    const next = sourceNext === player.seat ? nextCustomSeat(game, player.seat) : sourceNext;
    game.currentPlayer = next;
    game.actionPoints = 1;
    game.turnStartedAt = Date.now();
    game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentCustomPlayer(game).timeoutLimitMs : undefined;
    triggerCustomTurnStart(game, registry);
  }
}

// ---------------------------------------------------------------------------
// step executor
// ---------------------------------------------------------------------------

function serializeExec(ctx: ExecContext): Record<string, unknown> {
  return {
    actor: ctx.actor,
    sourceCard: ctx.sourceCard,
    sourceComboId: ctx.sourceComboId,
    heldInstanceId: ctx.heldInstanceId,
    heldInstance: ctx.heldInstance,
    vars: ctx.vars,
    batchId: ctx.batchId,
    event: ctx.event,
    selfInstanceId: ctx.selfInstanceId,
    deferred: ctx.deferred,
    steps: ctx.steps,
    pc: ctx.pc,
    depth: ctx.depth,
    spendOnFinish: ctx.spendOnFinish,
    pendingChoiceStep: ctx.pendingChoiceStep,
  };
}

function deserializeExec(game: CustomGameState, registry: CustomCardRegistry, raw: unknown): ExecContext {
  const data = raw as Record<string, unknown>;
  return {
    game,
    registry,
    actor: data.actor as PlayerId,
    sourceCard: data.sourceCard as CardId | undefined,
    sourceComboId: data.sourceComboId as string | undefined,
    heldInstanceId: data.heldInstanceId as string | undefined,
    heldInstance: data.heldInstance as CardInstance | undefined,
    vars: (data.vars ?? {}) as Record<string, unknown>,
    batchId: data.batchId as string,
    event: data.event as ExecContext["event"],
    selfInstanceId: data.selfInstanceId as string | undefined,
    deferred: (data.deferred ?? []) as DeferredTrigger[],
    steps: data.steps as CustomStep[],
    pc: data.pc as number,
    depth: data.depth as number,
    spendOnFinish: Boolean(data.spendOnFinish),
    pendingChoiceStep: data.pendingChoiceStep as CustomStep | undefined,
  };
}

function suspendForChoice(ctx: ExecContext, step: Extract<CustomStep, { op: "choose" | "inspect" }>, prompt: string): void {
  ctx.pendingChoiceStep = step;
  ctx.game.pendingChoice = {
    kind: "custom-choice",
    choiceId: `choice_${ctx.batchId}_${ctx.pc}`,
    playerId: ctx.actor,
    prompt,
    sourceActionId: ctx.batchId,
    continuation: serializeExec(ctx),
  };
}

function runSteps(ctx: ExecContext): void {
  const game = ctx.game;
  const registry = ctx.registry;
  while (ctx.pc < ctx.steps.length) {
    const step = ctx.steps[ctx.pc];
    ctx.pc += 1;
    switch (step.op) {
      case "action": {
        const seat = resolveTargetSeat(game, ctx, step.to);
        if (seat === undefined) break;
        const add = evalCount(ctx, step.add, "action.add");
        if (seat === game.currentPlayer) game.actionPoints += add;
        const target = game.players[seat];
        appendCustomRuntimeEvent(game, target, {
          category: "操作",
          operation: "增加出牌机会",
          quantity: add,
          cards: ctx.sourceCard ? [ctx.sourceCard] : [],
          result: `${target.nickname} 因${ctx.sourceCard ? registry.displayName(ctx.sourceCard) : "规则效果"}获得 ${add} 次额外出牌机会${seat === game.currentPlayer ? "" : "（当前不在其回合）"}`,
        });
        break;
      }
      case "audio": {
        const to = step.to === "all" ? "all" : (resolveTargetPlayerId(game, ctx, step.to) ?? "all");
        const dedupKey = `${ctx.batchId}:${ctx.sourceCard ?? ""}:${step.id}`;
        const duplicate = step.oncePer === "event" && game.custom.audioEvents.some((event) => `${event.batchId}:${event.cardId}:${event.audioKey}` === dedupKey);
        if (!duplicate) {
          game.custom.audioEvents.push({
            id: `ae_${game.custom.audioEvents.length + 1}`,
            cardId: ctx.sourceCard ?? ctx.selfInstanceId ?? "",
            audioKey: step.id,
            to,
            batchId: ctx.batchId,
          });
        }
        break;
      }
      case "cancelDraw": {
        const pending = game.pendingDraw;
        if (!pending) break;
        const sourceSeat = pending.sourceSeat;
        const requestedNext = step.next === undefined ? nextCustomSeat(game, sourceSeat) : evalNumber(ctx, step.next, "cancelDraw.next");
        if (!Number.isInteger(requestedNext) || requestedNext < 0 || requestedNext >= game.players.length) {
          throw new Error(`cancelDraw.next 必须计算为有效席位，实际为 ${requestedNext}`);
        }
        game.pendingDraw = undefined;
        let next = requestedNext;
        const skipSeat = step.skip ? resolveTargetSeat(game, ctx, step.skip) : undefined;
        if (skipSeat !== undefined && next === skipSeat) next = nextCustomSeat(game, next);
        game.currentPlayer = next;
        game.actionPoints = 1;
        game.turnStartedAt = Date.now();
        game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentCustomPlayer(game).timeoutLimitMs : undefined;
        triggerCustomTurnStart(game, registry);
        break;
      }
      case "choose": {
        const bound = ctx.vars[step.as];
        if (bound === undefined) {
          const options = enumerateChoiceOptions(ctx, step);
          if (options.length === 0) {
            if (step.empty === "illegal") throw new Error("该操作当前没有合法选择");
            return; // empty: stop
          }
          ctx.pc -= 1; // re-enter this step once the choice is bound
          suspendForChoice(ctx, step, "请选择目标");
          return;
        }
        break;
      }
      case "counter": {
        const add = evalNumber(ctx, step.add, "counter.add");
        for (const instance of resolveCounterTargets(game, ctx, step.target)) {
          instance.counters[step.name] = (instance.counters[step.name] ?? 0) + add;
        }
        break;
      }
      case "draw": {
        const n = evalCount(ctx, step.n, "draw.n");
        if (step.to === "all") {
          let seat = step.start ? resolveTargetSeat(game, ctx, step.start) : resolveTargetSeat(game, ctx, "self");
          if (seat === undefined) seat = game.currentPlayer;
          const scoreSeat = step.scoreTo ? resolveTargetSeat(game, ctx, step.scoreTo) : undefined;
          const scorePlayerId = scoreSeat !== undefined ? game.players[scoreSeat]?.id : undefined;
          for (let i = 0; i < game.players.length; i++) {
            drawInstances(game, seat, n, scorePlayerId, { reason: ctx.sourceCard ? registry.displayName(ctx.sourceCard) : "规则效果", operation: "效果摸牌" });
            seat = nextCustomSeat(game, seat);
          }
        } else if (step.to === "minHand") {
          const actorSeat = game.players.find((player) => player.id === ctx.actor)?.seat ?? game.currentPlayer;
          const scoreSeat = step.scoreTo ? resolveTargetSeat(game, ctx, step.scoreTo) : undefined;
          const scorePlayerId = scoreSeat !== undefined ? game.players[scoreSeat]?.id : ctx.vars.__scoreTo as PlayerId | undefined;
          for (const seat of minHandSeatsFrom(game, actorSeat)) {
            drawInstances(game, seat, n, scorePlayerId, { reason: ctx.sourceCard ? registry.displayName(ctx.sourceCard) : "规则效果", operation: "效果摸牌" });
          }
        } else {
          const seat = resolveTargetSeat(game, ctx, step.to);
          if (seat === undefined) break;
          const scoreSeat = step.scoreTo ? resolveTargetSeat(game, ctx, step.scoreTo) : undefined;
          const scorePlayerId = scoreSeat !== undefined ? game.players[scoreSeat]?.id : ctx.vars.__scoreTo as PlayerId | undefined;
          drawInstances(game, seat, n, scorePlayerId, { reason: ctx.sourceCard ? registry.displayName(ctx.sourceCard) : "规则效果", operation: "效果摸牌" });
        }
        break;
      }
      case "drawFlow": {
        const n = evalCount(ctx, step.n, "drawFlow.n");
        const source = game.players.find((player) => player.id === ctx.actor);
        if (!source) break;
        const scoreSeat = step.scoreTo ? resolveTargetSeat(game, ctx, step.scoreTo) : undefined;
        const scorePlayerId = scoreSeat !== undefined ? game.players[scoreSeat]?.id : undefined;
        const combo = ctx.sourceComboId ? (game.custom.rules as ResolvedCustomRules).combos[ctx.sourceComboId] : undefined;
        const sourceDef = combo ?? (ctx.sourceCard ? registry.get(ctx.sourceCard) : undefined);
        const followAllowed = step.follow ?? sourceDef?.follow ?? false;
        const reason = combo ? (combo.displayName ?? ctx.sourceComboId!) : ctx.sourceCard ? registry.displayName(ctx.sourceCard) : "加牌";
        queueCustomDrawFlow(game, registry, source, n, reason, ctx.sourceCard, ctx.sourceComboId, followAllowed, scorePlayerId, step.perPlayerCap ?? 3, ctx);
        if (game.pendingDraw) return; // pending draw takes over the turn; steps resume on completion
        break;
      }
      case "drawWhere": {
        const seat = resolveTargetSeat(game, ctx, step.to);
        if (seat === undefined) break;
        const pickMatch = /^random:(\d+)$/.exec(step.pick);
        const pickCount = pickMatch ? Math.min(Number(pickMatch[1]), CUSTOM_LIMITS.maxDynamicDraw) : 1;
        const matches = game.zones.drawPile.filter((instance) => matchesWhere(ctx, instance, step.where, "deck"));
        if (matches.length === 0 && step.recycleDiscard) {
          recycleCustomDiscard(game, true);
        }
        const pool = game.zones.drawPile.filter(
          (instance) => matchesWhere(ctx, instance, step.where, "deck") && (!step.excludeSourceCard || instance.instanceId !== ctx.heldInstanceId),
        );
        if (pool.length === 0) {
          if (step.empty === "illegal") throw new Error("drawWhere 没有可抽取的牌");
          return;
        }
        const picked: CardInstance[] = [];
        for (let i = 0; i < pickCount && pool.length > 0; i++) {
          const index = Math.floor(rngNext(game) * pool.length);
          const instance = pool.splice(index, 1)[0];
          detachInstance(game, instance.instanceId);
          game.players[seat].hand.push(instance);
          picked.push(instance);
          const scoreSeat = step.scoreTo ? resolveTargetSeat(game, ctx, step.scoreTo) : undefined;
          if (scoreSeat !== undefined) addCustomScore(game, game.players[scoreSeat].id, 1);
        }
        ctx.vars[step.as] = picked.map((instance) => instance.instanceId);
        const target = game.players[seat];
        appendCustomRuntimeEvent(game, target, {
          category: "摸牌",
          operation: "条件摸牌",
          quantity: picked.length,
          cards: picked.map((instance) => instance.cardId),
          result: `${target.nickname} 因${ctx.sourceCard ? registry.displayName(ctx.sourceCard) : "规则效果"}从牌堆选取并摸牌 ${picked.length} 张`,
        });
        break;
      }
      case "flushDeferred": {
        const scoreSeat = step.scoreTo ? resolveTargetSeat(game, ctx, step.scoreTo) : undefined;
        flushExecDeferred(ctx, scoreSeat !== undefined ? game.players[scoreSeat]?.id : undefined);
        break;
      }
      case "if": {
        const test = evaluateFormulaBoolean(compileCached(step.test), makeFormulaScope(ctx));
        const branch = test ? step.then : (step.else ?? []);
        runSteps({ ...ctx, steps: branch, pc: 0, depth: ctx.depth + 1 });
        break;
      }
      case "inspect": {
        let targetPlayerId: PlayerId | undefined;
        if (step.player === "choose:other") {
          const bound = ctx.vars.__inspectPlayer as PlayerId | undefined;
          if (!bound) {
            ctx.pc -= 1; // re-enter this step once the target player is chosen
            suspendForChoice(ctx, step, "选择一名其他玩家查看");
            return;
          }
          targetPlayerId = bound;
        } else {
          targetPlayerId = resolveTargetPlayerId(game, ctx, step.player);
        }
        const target = game.players.find((player) => player.id === targetPlayerId);
        if (!target) break;
        let text = step.empty ?? "无结果";
        for (const inspectCase of step.cases) {
          const matched = target.hand.filter((instance) => matchesWhere(ctx, instance, inspectCase.where, "hand"));
          if (matched.length === 0) continue;
          const names = [...new Set(matched.map((instance) => registry.displayName(instance.cardId)))];
          text = names.join("、");
          break;
        }
        const revealTargetId = step.revealTo ? (resolveTargetPlayerId(game, ctx, step.revealTo) ?? ctx.actor) : ctx.actor;
        const cardName = ctx.sourceCard ? registry.displayName(ctx.sourceCard) : "焰色";
        const line =
          revealTargetId === ctx.actor
            ? `${playerName(game, ctx.actor)} 对 ${target.nickname} 使用${cardName}，结果仅自己可见`
            : `${playerName(game, ctx.actor)} 对 ${target.nickname} 使用${cardName}，结果仅对 ${playerName(game, revealTargetId)} 可见`;
        game.custom.inspectReveals.push({ id: `ir_${game.custom.inspectReveals.length + 1}`, playerId: revealTargetId, text, line, cardName });
        if (game.custom.inspectReveals.length > 30) game.custom.inspectReveals.splice(0, game.custom.inspectReveals.length - 30);
        game.log.unshift(line);
        break;
      }
      case "move": {
        const ids = (ctx.vars[step.cards] as string[] | undefined) ?? [];
        for (const id of ids) {
          const instance = detachInstance(game, id);
          if (!instance) continue;
          if (step.to === "field.solution") game.zones.solution.push(instance);
          else if (step.to === "discard") game.zones.discard.push(instance);
          else if (step.to === "field.products") game.zones.products.push(makeCustomProduct(game, registry, "special", [instance], undefined, ctx.actor));
        }
        break;
      }
      case "play": {
        const ids = (ctx.vars[step.card] as string[] | undefined) ?? [];
        const markDef = step.mark;
        for (const id of [...ids]) {
          const instance = detachInstance(game, id);
          if (!instance) continue;
          appendCustomRuntimeEvent(game, game.players.find((player) => player.id === ctx.actor), {
            category: "操作",
            operation: "效果出牌",
            quantity: 1,
            cards: [instance.cardId],
            result: `${playerName(game, ctx.actor)} 因${ctx.sourceCard ? registry.displayName(ctx.sourceCard) : "规则效果"}打出 ${registry.displayName(instance.cardId)}`,
          });
          // attach mark first so entry reactions trigger mark listeners, but keep the
          // instance out of the solution while computing targets so it is not double-counted
          if (markDef) {
            const ownerId = markDef.owner ? (resolveTargetPlayerId(game, ctx, markDef.owner) ?? ctx.actor) : ctx.actor;
            instance.marks.push({
              name: markDef.name,
              ownerId,
              badge: markDef.badge,
              reactionPriority: markDef.reactionPriority,
              listeners: (markDef.on ?? []) as CustomEventListenerRule[],
            });
          }
          const targets = findCustomReactionTargets(game, registry, instance.cardId, 1);
          if (targets.length > 1 && !step.consumeAction) {
            game.zones.solution.push(instance);
            ctx.vars.__reactionInstance = id;
            ctx.vars.__reactionTargets = targets.map((target) => target.id);
            ctx.vars.__reactionTargetLabels = Object.fromEntries(
              targets.map((target) => [target.id, customReactionTargetChoiceLabel(game, registry, target)]),
            );
            ctx.pendingChoiceStep = { op: "choose", from: "self.hand", as: "__reactionTarget", empty: "illegal" } as CustomStep;
            game.pendingChoice = {
              kind: "custom-choice",
              choiceId: `choice_${ctx.batchId}_${ctx.pc}`,
              playerId: ctx.actor,
              prompt: "选择反应目标",
              sourceActionId: ctx.batchId,
              continuation: serializeExec(ctx),
            };
            return;
          }
          const target = targets[0];
          if (target) resolveCustomReactionTarget(game, registry, ctx.actor, instance.cardId, [instance], target, ctx.batchId);
          else game.zones.solution.push(instance);
          stabilizeCustomTable(game, registry, ctx.actor, ctx.batchId);
        }
        break;
      }
      case "pot": {
        const factor = evalNumber(ctx, step.mul, "pot.mul");
        const creditSeat = step.creditTo ? resolveTargetSeat(game, ctx, step.creditTo) : resolveTargetSeat(game, ctx, "self");
        if (creditSeat !== undefined) multiplyCustomPot(game, game.players[creditSeat].id, factor);
        break;
      }
      case "reactSweep": {
        const reagent = resolveReagent(ctx, step.reagent);
        if (!reagent) break;
        const swept = sweepReactiveIonsKinded(game, registry, reagent, ctx.actor, ctx.batchId);
        if (step.repeat === "stable") {
          for (let guard = 0; guard < CUSTOM_LIMITS.maxChainReactions; guard++) {
            const changed = stabilizeCustomTable(game, registry, ctx.actor, ctx.batchId);
            const extra = sweepReactiveIonsKinded(game, registry, reagent, ctx.actor, ctx.batchId);
            for (const [kind, list] of extra) {
              swept.set(kind, [...(swept.get(kind) ?? []), ...list]);
            }
            if (!changed && extra.size === 0) break;
          }
        }
        let total = 0;
        for (const [kind, list] of swept) {
          if (list.length === 0) continue;
          total += list.length;
          dispatchMarkedReacted(game, registry, list, { actor: ctx.actor, cause: "reaction", sourceCard: ctx.sourceCard, batchId: ctx.batchId, reactionResult: kind });
          removeInstances(game, registry, list, { actor: ctx.actor, cause: "reaction", sourceCard: ctx.sourceCard, batchId: ctx.batchId, reactionResult: kind });
        }
        ctx.vars[step.as] = { cards: total, groups: 0, specialGroups: 0 } satisfies SweepResult;
        if (total > 0) {
          game.log.unshift(`${playerName(game, ctx.actor)} 的 ${registry.displayName(reagent)} 与 ${total} 张牌反应`);
        }
        break;
      }
      case "remove": {
        const result = execRemove(ctx, step);
        if (step.as) ctx.vars[step.as] = result;
        break;
      }
      case "reverse": {
        game.direction = game.direction === 1 ? -1 : 1;
        game.log.unshift(`${playerName(game, ctx.actor)} 逆转了出牌顺序`);
        break;
      }
      case "score": {
        const seat = resolveTargetSeat(game, ctx, step.to);
        if (seat === undefined) break;
        const points = evalNumber(ctx, step.add, "score.add");
        const normalizedPoints = evaluateFormulaNumber(compileCached(step.add), makeFormulaScope(ctx, { stake: 1, bet: 1 }));
        if (points > 0 || normalizedPoints > 0) {
          addCustomScorePoints(game, game.players[seat].id, points, normalizedPoints);
          const result = `${playerName(game, ctx.actor)} 获得 ${points} 规则积分（底注 ${game.scoring?.baseBet ?? 0}，倍率 x${game.scoring?.multiplier ?? 1}，stake ${game.scoring?.stake ?? 0}，归一化 ${normalizedPoints}）`;
          appendCustomRuntimeEvent(game, game.players[seat], {
            category: "操作",
            operation: "规则积分",
            result,
            pointsOperation: `+${points}`,
            normalizedPointsOperation: `+${normalizedPoints}`,
          });
        }
        break;
      }
      case "skip": {
        const seat = resolveTargetSeat(game, ctx, step.player);
        if (seat !== undefined) {
          game.players[seat].skipped = true;
          game.log.unshift(`${playerName(game, ctx.actor)} 跳过 ${game.players[seat].nickname}`);
        }
        break;
      }
    }
  }
}

function flushExecDeferred(ctx: ExecContext, scoreToOverride?: PlayerId): void {
  const queued = ctx.deferred.splice(0);
  for (const trigger of queued) {
    runListenerTrigger(ctx.game, ctx.registry, trigger, scoreToOverride ?? (ctx.vars.__scoreTo as PlayerId | undefined));
  }
}

function resolveTargetPlayerId(game: CustomGameState, ctx: ExecContext, ref: string): PlayerId | undefined {
  const seat = resolveTargetSeat(game, ctx, ref);
  return seat !== undefined ? game.players[seat]?.id : undefined;
}

function resolveCounterTargets(game: CustomGameState, ctx: ExecContext, ref: string): CardInstance[] {
  if (ref === "self") {
    const self = ctx.selfInstanceId ? findInstanceById(game, ctx.selfInstanceId) : undefined;
    return self ? [self] : [];
  }
  const value = ctx.vars[ref];
  const ids = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set<string>();
  const instances: CardInstance[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || seen.has(id)) continue;
    const instance = findInstanceById(game, id);
    if (!instance) continue;
    seen.add(id);
    instances.push(instance);
  }
  if (instances.length > 0) return instances;
  const direct = findInstanceById(game, ref);
  return direct ? [direct] : [];
}

function resolveReagent(ctx: ExecContext, reagent: string): CardId | undefined {
  if (ctx.registry.has(reagent)) return reagent;
  const varMatch = /^([A-Za-z_]\w*)\.name$/.exec(reagent);
  if (varMatch) {
    const ids = ctx.vars[varMatch[1]];
    if (Array.isArray(ids) && ids.length > 0) {
      const instance = findInstanceById(ctx.game, ids[0] as string);
      return instance?.cardId;
    }
    const direct = ctx.vars[varMatch[1]];
    if (typeof direct === "string") return direct;
    if (direct && typeof direct === "object" && "cardId" in (direct as Record<string, unknown>)) {
      return (direct as { cardId: string }).cardId;
    }
  }
  return undefined;
}

function matchesWhere(ctx: ExecContext, instance: CardInstance, where: CustomWhereClause | undefined, zone: string): boolean {
  if (!where) return true;
  const registry = ctx.registry;
  if (where.any) return where.any.some((sub) => matchesWhere(ctx, instance, sub, zone));
  if (where.type !== undefined && registry.typeOf(instance.cardId) !== where.type) return false;
  if (where.colored !== undefined && registry.isColored(instance.cardId) !== where.colored) return false;
  if (where.flameTest !== undefined && registry.hasFlameTest(instance.cardId) !== where.flameTest) return false;
  if (where.name !== undefined) {
    if (typeof where.name === "string" && instance.cardId !== where.name) return false;
    if (typeof where.name === "object" && "not" in where.name && instance.cardId === where.name.not) return false;
  }
  if (where.reactsWith !== undefined) {
    const reagent = resolveReagent(ctx, where.reactsWith);
    if (!reagent || !registry.isIon(instance.cardId) || !registry.reactionKind(reagent, instance.cardId)) return false;
  }
  if (where.playableTo === "field" && !registry.isIon(instance.cardId)) return false;
  if (where.kind !== undefined) {
    // only meaningful for product groups; instances do not carry a kind
    return false;
  }
  return true;
}

function productGroupMatchesWhere(ctx: ExecContext, group: CustomCardInstanceGroup, where: CustomWhereClause | undefined): boolean {
  if (!where) return true;
  if (where.any) return where.any.some((sub) => productGroupMatchesWhere(ctx, group, sub));
  if (where.kind !== undefined) {
    const kinds = Array.isArray(where.kind) ? where.kind : [where.kind];
    if (!kinds.includes(group.kind as never)) return false;
  }
  if (where.contains !== undefined) {
    if (!group.cards.some((instance) => matchesWhere(ctx, instance, where.contains, "product"))) return false;
  }
  if (where.reactsWith !== undefined && !group.cards.some((instance) => matchesWhere(ctx, instance, { reactsWith: where.reactsWith }, "product"))) {
    return false;
  }
  if (where.type !== undefined) {
    // a bare type filter on products means "groups containing this type"
    if (!group.cards.some((instance) => ctx.registry.typeOf(instance.cardId) === where.type)) return false;
  }
  return true;
}

function execRemove(ctx: ExecContext, step: Extract<CustomStep, { op: "remove" }>): SweepResult {
  const game = ctx.game;
  const registry = ctx.registry;
  const removed: CardInstance[] = [];
  let groups = 0;
  let specialGroups = 0;
  if (step.target === "self" && ctx.selfInstanceId) {
    const instance = findInstanceById(game, ctx.selfInstanceId);
    if (instance) removed.push(instance);
  } else if (step.from === "field" || step.from === undefined) {
    const keptSolution: CardInstance[] = [];
    for (const instance of game.zones.solution) {
      if (matchesWhere(ctx, instance, step.where, "solution")) removed.push(instance);
      else keptSolution.push(instance);
    }
    game.zones.solution = keptSolution;
    const matchedGroups = game.zones.products.filter((group) => productGroupMatchesWhere(ctx, group, step.where));
    game.zones.products = game.zones.products.filter((group) => !productGroupMatchesWhere(ctx, group, step.where));
    for (const group of matchedGroups) {
      groups += 1;
      if (group.cards.some((instance) => registry.typeOf(instance.cardId) === "special")) specialGroups += 1;
      removed.push(...group.cards);
    }
  } else if (step.from === "field.solution") {
    const kept: CardInstance[] = [];
    for (const instance of game.zones.solution) {
      if (matchesWhere(ctx, instance, step.where, "solution")) removed.push(instance);
      else kept.push(instance);
    }
    game.zones.solution = kept;
  } else if (step.from === "field.products") {
    const matchedGroups = game.zones.products.filter((group) => productGroupMatchesWhere(ctx, group, step.where));
    game.zones.products = game.zones.products.filter((group) => !productGroupMatchesWhere(ctx, group, step.where));
    for (const group of matchedGroups) {
      groups += 1;
      if (group.cards.some((instance) => registry.typeOf(instance.cardId) === "special")) specialGroups += 1;
      removed.push(...group.cards);
    }
  } else if (step.from === "self.hand") {
    const player = game.players.find((item) => item.id === ctx.actor);
    if (player) {
      const kept: CardInstance[] = [];
      for (const instance of player.hand) {
        if (matchesWhere(ctx, instance, step.where, "hand")) removed.push(instance);
        else kept.push(instance);
      }
      player.hand = kept;
    }
  } else if (step.from === "player.hand") {
    const seat = step.target ? resolveTargetSeat(game, ctx, step.target) : undefined;
    const player = seat !== undefined ? game.players[seat] : undefined;
    if (player) {
      const kept: CardInstance[] = [];
      for (const instance of player.hand) {
        if (matchesWhere(ctx, instance, step.where, "hand")) removed.push(instance);
        else kept.push(instance);
      }
      player.hand = kept;
    }
  }
  const removalContext = {
    actor: ctx.actor,
    cause: step.cause,
    sourceCard: ctx.sourceCard,
    batchId: ctx.batchId,
    allowDefer: step.deferCardTriggers,
    exec: ctx,
  } satisfies RemovalContext;
  const reagent = step.cause === "reaction" && step.where?.reactsWith ? resolveReagent(ctx, step.where.reactsWith) : undefined;
  if (reagent) {
    const byResult = new Map<string, CardInstance[]>();
    for (const instance of removed) {
      const kind = registry.reactionKind(reagent, instance.cardId);
      if (!kind) continue;
      const result = sweepResultKind(reagent, instance.cardId, kind);
      byResult.set(result, [...(byResult.get(result) ?? []), instance]);
    }
    for (const [reactionResult, instances] of byResult) {
      const context = { ...removalContext, reactionResult };
      dispatchMarkedReacted(game, registry, instances, context);
      removeInstances(game, registry, instances, context);
    }
  } else {
    removeInstances(game, registry, removed, removalContext);
  }
  return { cards: removed.length, groups, specialGroups };
}

// ---------------------------------------------------------------------------
// choice enumeration
// ---------------------------------------------------------------------------

interface ChoiceOption {
  value: unknown;
  label: string;
}

function enumerateChoiceOptions(ctx: ExecContext, step: Extract<CustomStep, { op: "choose" | "inspect" }>): ChoiceOption[] {
  const game = ctx.game;
  const registry = ctx.registry;
  if (step.op === "inspect") {
    if (step.player !== "choose:other") return [{ value: resolveTargetPlayerId(game, ctx, step.player), label: "目标玩家" }];
    return game.players.filter((player) => player.id !== ctx.actor).map((player) => ({ value: player.id, label: player.nickname }));
  }
  if (step.as === "__reactionTarget") {
    const ids = (ctx.vars.__reactionTargets as string[] | undefined) ?? [];
    const labels = ctx.vars.__reactionTargetLabels as Record<string, string> | undefined;
    return ids.map((id, index) => ({ value: { targetId: id }, label: labels?.[id] ?? `反应目标 ${index + 1}` }));
  }
  if (step.from === "players.other") {
    return game.players.filter((player) => player.id !== ctx.actor).map((player) => ({ value: player.id, label: player.nickname }));
  }
  const player = game.players.find((item) => item.id === ctx.actor);
  if (!player) return [];
  if (step.from !== "self.hand") return [];
  const matching = player.hand.filter((instance) => matchesWhere(ctx, instance, step.where, "hand"));
  if (step.mode === "kind+count") {
    const counts = countByCardId(matching);
    return Object.entries(counts).flatMap(([cardId, max]) =>
      Array.from({ length: max }, (_, index) => ({ value: { cardId, count: index + 1 }, label: `${registry.displayName(cardId)} x${index + 1}` })),
    );
  }
  const count = step.count ?? 1;
  if (count === 1) {
    if (step.where?.type === "ion") {
      const uniqueByIon = new Map<CardId, CardInstance>();
      for (const instance of matching) {
        if (!uniqueByIon.has(instance.cardId)) uniqueByIon.set(instance.cardId, instance);
      }
      return [...uniqueByIon.values()].map((instance) => ({
        value: { instanceIds: [instance.instanceId] },
        label: registry.displayName(instance.cardId),
      }));
    }
    return matching.map((instance) => ({ value: { instanceIds: [instance.instanceId] }, label: registry.displayName(instance.cardId) }));
  }
  // bounded combination enumeration for count > 1
  const options: ChoiceOption[] = [];
  const combine = (start: number, picked: string[]) => {
    if (picked.length === count) {
      options.push({ value: { instanceIds: [...picked] }, label: picked.map((id) => registry.displayName(findInstanceById(game, id)?.cardId ?? id)).join(" ") });
      return;
    }
    for (let i = start; i < matching.length && options.length < 256; i++) combine(i + 1, [...picked, matching[i].instanceId]);
  };
  combine(0, []);
  return options;
}

// ---------------------------------------------------------------------------
// action enumeration
// ---------------------------------------------------------------------------

export function enumerateCustomActions(game: CustomGameState, playerId: PlayerId = currentCustomPlayer(game).id): CustomLegalAction[] {
  if (game.status !== "playing") return [];
  const player = game.players.find((item) => item.id === playerId);
  if (!player || player.id !== currentCustomPlayer(game).id) return [];
  const registry = customRegistryOf(game);
  const rules = game.custom.rules as ResolvedCustomRules;

  if (game.pendingChoice) {
    if (game.pendingChoice.playerId !== playerId || game.pendingChoice.kind !== "custom-choice") return [];
    const ctx = deserializeExec(game, registry, game.pendingChoice.continuation);
    const step = ctx.pendingChoiceStep as Extract<CustomStep, { op: "choose" | "inspect" }> | undefined;
    if (!step) return [];
    return enumerateChoiceOptions(ctx, step).map((option) => ({
      id: customActionId({ kind: "choice", choiceId: game.pendingChoice!.choiceId, choiceValue: option.value }),
      kind: "choice" as const,
      cardIds: [],
      instanceIds: [],
      choiceId: game.pendingChoice!.choiceId,
      choiceValue: option.value,
      description: option.label,
    }));
  }

  if (game.pendingDraw) {
    const pending = game.pendingDraw;
    const actions: CustomLegalAction[] = [
      { id: "ad", kind: "accept-draw", cardIds: [], instanceIds: [], description: `接受摸牌（${Math.min(pending.perPlayerCap, pending.remaining)} 张）` },
    ];
    if (pending.customFunctionComboId) {
      const comboId = pending.customFunctionComboId;
      const combo = rules.combos[comboId];
      if (combo && customPendingFollowAllowed(pending, combo) && customComboEnabled(rules, comboId, combo)) {
        const instanceIds = comboInstancesFromHand(player, combo);
        if (instanceIds) {
          actions.push({
            id: customActionId({ kind: "follow", comboId }),
            kind: "follow",
            cardIds: Object.keys(combo.requires),
            instanceIds,
            comboId,
            description: `跟出 ${combo.displayName ?? comboId}`,
          });
        }
      }
    } else if (pending.functionCard) {
      const def = registry.get(pending.functionCard);
      if (def && customPendingFollowAllowed(pending, def)) {
        const instance = player.hand.find((item) => item.cardId === pending.functionCard);
        if (instance) {
          actions.push({
            id: customActionId({ kind: "follow", cardIds: [instance.cardId] }),
            kind: "follow",
            cardIds: [instance.cardId],
            instanceIds: [instance.instanceId],
            description: `跟出 ${registry.displayName(instance.cardId)}`,
          });
        }
      }
    }
    const seen = new Set(actions.map((action) => action.id));
    for (const instance of player.hand) {
      const def = registry.get(instance.cardId);
      if (def && customCounterAnyFollowEnabled(def)) {
        const id = customActionId({ kind: "counter", cardIds: [instance.cardId] });
        if (seen.has(id)) continue;
        seen.add(id);
        actions.push({
          id,
          kind: "counter",
          cardIds: [instance.cardId],
          instanceIds: [instance.instanceId],
          description: `用 ${registry.displayName(instance.cardId)} 抵挡`,
        });
      }
    }
    for (const [comboId, combo] of Object.entries(rules.combos)) {
      if (!customComboEnabled(rules, comboId, combo)) continue;
      if (!customCounterAnyFollowEnabled(combo)) continue;
      const instanceIds = comboInstancesFromHand(player, combo);
      if (!instanceIds) continue;
      actions.push({
        id: customActionId({ kind: "counter", comboId }),
        kind: "counter",
        cardIds: Object.keys(combo.requires),
        instanceIds,
        comboId,
        description: `用 ${combo.displayName ?? comboId} 抵挡`,
      });
    }
    return actions;
  }

  const actions: CustomLegalAction[] = [];
  const handCounts = countByCardId(player.hand);

  for (const [cardId, count] of Object.entries(handCounts)) {
    const def = registry.get(cardId);
    if (!def) continue;
    if (def.type === "ion") {
      for (let n = 1; n <= count; n++) {
        const targets = findCustomReactionTargets(game, registry, cardId, n);
        const instances = player.hand.filter((item) => item.cardId === cardId).slice(0, n).map((item) => item.instanceId);
        if (targets.length === 0) {
          actions.push({
            id: customActionId({ kind: "play-ion", cardIds: [cardId], count: n }),
            kind: "play-ion",
            cardIds: [cardId],
            instanceIds: instances,
            count: n,
            description: `打出 ${n} 张 ${registry.displayName(cardId)}`,
          });
        }
        for (const target of targets) {
          actions.push({
            id: customActionId({ kind: "play-ion", cardIds: [cardId], count: n, targetId: target.id }),
            kind: "play-ion",
            cardIds: [cardId],
            instanceIds: instances,
            count: n,
            targetId: target.id,
            description: `打出 ${n} 张 ${registry.displayName(cardId)}（${target.label}）`,
          });
        }
      }
    } else if (def.type === "special") {
      const instance = player.hand.find((item) => item.cardId === cardId);
      if (instance) {
        actions.push({
          id: customActionId({ kind: "play-special", cardIds: [cardId] }),
          kind: "play-special",
          cardIds: [cardId],
          instanceIds: [instance.instanceId],
          description: `打出 ${registry.displayName(cardId)}`,
        });
      }
    } else if (isOperationPlayable(game, registry, player, cardId, def)) {
      const instance = player.hand.find((item) => item.cardId === cardId);
      actions.push({
        id: customActionId({ kind: "play-operation", cardIds: [cardId] }),
        kind: "play-operation",
        cardIds: [cardId],
        instanceIds: instance ? [instance.instanceId] : [],
        description: `使用 ${registry.displayName(cardId)}`,
      });
    }
  }

  for (const [comboId, combo] of Object.entries(rules.combos)) {
    if (!customComboEnabled(rules, comboId, combo)) continue;
    const satisfied = Object.entries(combo.requires).every(([cardId, count]) => (handCounts[cardId] ?? 0) >= count);
    if (!satisfied) continue;
    const instanceIds = Object.entries(combo.requires).flatMap(([cardId, count]) => player.hand.filter((item) => item.cardId === cardId).slice(0, count).map((item) => item.instanceId));
    actions.push({
      id: customActionId({ kind: "play-combo", comboId }),
      kind: "play-combo",
      cardIds: Object.keys(combo.requires),
      instanceIds,
      comboId,
      description: `打出 ${combo.displayName ?? comboId}`,
    });
  }

  actions.push({ id: "pass", kind: "pass", cardIds: [], instanceIds: [], description: "跳过出牌机会" });
  return actions;
}

function customComboEnabled(rules: ResolvedCustomRules, comboId: string, combo: CustomComboDef): boolean {
  if (rules.setup.allowWangZha !== false) return true;
  const requiredIds = Object.keys(combo.requires);
  const isWangZha = comboId === "WangZha" || (
    combo.displayName === "王炸"
    && requiredIds.length === 2
    && combo.requires.Acid === 1
    && combo.requires.Alkali === 1
  );
  return !isWangZha;
}

function customCounterAnyFollowEnabled(def: { counterAnyFollow?: boolean; counter?: CustomStep[] }): boolean {
  return def.counterAnyFollow ?? Boolean(def.counter?.length);
}

function customPendingFollowAllowed(pending: PendingDrawState, source: { follow?: boolean }): boolean {
  // Persisted legacy pending flows do not have customFollowAllowed; retain their
  // old card/combo-level behavior. Newly created flows always store the exact step result.
  return pending.customFollowAllowed ?? source.follow ?? false;
}

function comboInstancesFromHand(player: CustomPlayerState, combo: CustomComboDef): string[] | undefined {
  const instanceIds: string[] = [];
  for (const [cardId, count] of Object.entries(combo.requires)) {
    const matches = player.hand.filter((item) => item.cardId === cardId).slice(0, count);
    if (matches.length !== count) return undefined;
    instanceIds.push(...matches.map((item) => item.instanceId));
  }
  return instanceIds;
}

function isOperationPlayable(game: CustomGameState, registry: CustomCardRegistry, player: CustomPlayerState, cardId: CardId, def: CustomCardDef): boolean {
  if (def.type !== "operation" && def.type !== "generic") return false;
  const steps = "steps" in def ? def.steps : undefined;
  if (!steps || steps.length === 0) return true;
  // simulate on a clone: the operation is playable unless it immediately fails or an
  // empty:"illegal" choose has no options
  try {
    const clone = cloneCustomGame(game);
    const cloneRegistry = customRegistryOf(clone);
    const clonePlayer = clone.players.find((item) => item.seat === player.seat);
    if (!clonePlayer) return false;
    const instance = clonePlayer.hand.find((item) => item.cardId === cardId);
    if (!instance) return false;
    removeHandInstances(clonePlayer, [instance.instanceId]);
    if (!("consume" in def) || def.consume !== "hold") clone.zones.discard.push(instance);
    const exec: ExecContext = {
      game: clone,
      registry: cloneRegistry,
      actor: player.id,
      sourceCard: cardId,
      heldInstanceId: "consume" in def && def.consume === "hold" ? instance.instanceId : undefined,
      vars: {},
      batchId: nextBatchId(clone),
      deferred: [],
      steps,
      pc: 0,
      depth: 0,
      spendOnFinish: true,
    };
    runSteps(exec);
    return true;
  } catch {
    return false;
  }
}

function customActionId(parts: {
  kind: CustomLegalAction["kind"];
  cardIds?: CardId[];
  count?: number;
  targetId?: string;
  comboId?: string;
  choiceId?: string;
  choiceValue?: unknown;
}): string {
  return stableStringify({
    k: parts.kind,
    c: parts.cardIds,
    n: parts.count,
    t: parts.targetId,
    cb: parts.comboId,
    ch: parts.choiceId,
    v: parts.choiceValue,
  });
}

export function customActionIdFromIntent(intent: CustomActionIntent, game: CustomGameState): string | undefined {
  if (intent.actionId) return intent.actionId;
  if (intent.choiceId) {
    const value = intent.cardInstanceIds?.length
      ? { instanceIds: intent.cardInstanceIds }
      : intent.selectedPlayerIds?.length
        ? intent.selectedPlayerIds[0]
        : intent.selectedCount !== undefined && intent.cardId
          ? { cardId: intent.cardId, count: intent.selectedCount }
          : intent.selectedGroupIds?.length
            ? { targetId: intent.selectedGroupIds[0] }
            : undefined;
    if (value === undefined) return undefined;
    return customActionId({ kind: "choice", choiceId: intent.choiceId, choiceValue: value });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// action application
// ---------------------------------------------------------------------------

export interface CustomResolvedAction {
  ok: boolean;
  message: string;
  game: CustomGameState;
}

export function applyCustomAction(input: CustomGameState, playerId: PlayerId, intent: CustomActionIntent, source: "normal" | "timeout" = "normal"): CustomResolvedAction {
  const game = cloneCustomGame(input);
  const registry = customRegistryOf(game);
  if (game.status === "opening-exchange") {
    return resolveCustomOpening(game, registry, playerId, intent);
  }
  if (game.status !== "playing") return { ok: false, message: "游戏已经结束", game };
  const player = currentCustomPlayer(game);
  if (player.id !== playerId) return { ok: false, message: "还没有轮到该玩家", game };

  const legal = enumerateCustomActions(game, playerId);
  const wantedId = customActionIdFromIntent(intent, game);
  const action = legal.find((candidate) => candidate.id === wantedId) ?? legal.find((candidate) => matchCustomIntent(candidate, intent));
  if (!action) return { ok: false, message: "非法操作或缺少所需手牌", game };

  if (source === "timeout") {
    player.timeoutStreak += 1;
    player.normalStreak = 0;
    player.timeoutLimitMs = game.turnTimeLimitMs ?? TURN_MS;
  } else {
    player.timeoutStreak = 0;
    player.normalStreak = 0;
    player.timeoutLimitMs = game.turnTimeLimitMs ?? TURN_MS;
  }

  const actionMeta = CUSTOM_ACTION_EVENT[action.kind];
  const logLengthBefore = game.log.length;
  const actionCards = action.instanceIds
    .map((id) => player.hand.find((instance) => instance.instanceId === id)?.cardId)
    .filter((cardId): cardId is CardId => Boolean(cardId));

  switch (action.kind) {
    case "accept-draw":
      resolveCustomAcceptDraw(game, registry, player);
      break;
    case "follow":
      resolveCustomFollow(game, registry, player, action);
      break;
    case "counter":
      resolveCustomCounter(game, registry, player, action);
      break;
    case "choice":
      resolveCustomChoice(game, registry, action);
      break;
    case "pass":
      game.log.unshift(`${player.nickname} 跳过了出牌机会`);
      spendCustomActionPoint(game, registry);
      break;
    case "play-ion":
      resolveCustomIonPlay(game, registry, player, action);
      break;
    case "play-special":
      resolveCustomSpecialPlay(game, registry, player, action);
      break;
    case "play-operation":
      resolveCustomOperationPlay(game, registry, player, action);
      break;
    case "play-combo":
      resolveCustomComboPlay(game, registry, player, action);
      break;
  }

  game.revision += 1;
  const newLogLines = game.log.slice(0, Math.max(0, game.log.length - logLengthBefore));
  appendCustomEvent(game, player, {
    category: actionMeta.category,
    operation: actionMeta.operation,
    quantity: actionCards.length > 0 ? actionCards.length : undefined,
    cards: actionCards,
    result: `${[...newLogLines].reverse().join("；") || action.description}${source === "timeout" ? "（超时自动）" : ""}`,
  });
  if (player.hand.length === 0 && game.status === "playing") {
    game.status = "ended";
    game.winnerId = player.id;
    game.log.unshift(`${player.nickname} 获胜`);
    logCustomSettlementSummary(game);
    appendCustomEvent(game, player, {
      category: "终局",
      operation: "获胜",
      result: `${player.nickname} 获胜；累计积分 ${game.scoring?.total ?? 0}`,
    });
  }
  game.log = game.log.slice(0, 120);
  return { ok: true, message: "ok", game };
}

function matchCustomIntent(action: CustomLegalAction, intent: CustomActionIntent): boolean {
  if (intent.cardInstanceIds?.length) {
    if (action.kind !== "play-ion" && action.kind !== "play-special" && action.kind !== "play-operation" && action.kind !== "play-combo") return false;
    return intent.cardInstanceIds.every((id) => action.instanceIds.includes(id));
  }
  return false;
}

function resolveCustomChoice(game: CustomGameState, registry: CustomCardRegistry, action: CustomLegalAction): void {
  const pending = game.pendingChoice;
  if (!pending || pending.kind !== "custom-choice") return;
  const ctx = deserializeExec(game, registry, pending.continuation);
  const step = ctx.pendingChoiceStep as Extract<CustomStep, { op: "choose" | "inspect" }> | undefined;
  if (!step) return;
  game.pendingChoice = undefined;
  const value = action.choiceValue;
  if (step.op === "inspect") {
    ctx.vars.__inspectPlayer = value as PlayerId;
  } else if (step.from === "players.other") {
    ctx.vars[step.as] = value as PlayerId;
  } else if (step.as === "__reactionTarget") {
    const targetId = (value as { targetId?: string })?.targetId;
    const instanceId = ctx.vars.__reactionInstance as string | undefined;
    // detach the entering instance before recomputing targets so it is not double-counted
    // in the solution pool (mirrors the regular ion-play flow)
    const detached = instanceId ? detachInstance(game, instanceId) : undefined;
    const instance = detached ?? (instanceId ? findInstanceById(game, instanceId) : undefined);
    if (instance && targetId) {
      const target = findCustomReactionTargets(game, registry, instance.cardId, 1).find((item) => item.id === targetId);
      if (target) resolveCustomReactionTarget(game, registry, ctx.actor, instance.cardId, [instance], target, ctx.batchId);
      else if (detached) game.zones.solution.push(instance);
    }
    stabilizeCustomTable(game, registry, ctx.actor, ctx.batchId);
  } else if (step.mode === "kind+count") {
    const { cardId, count } = value as { cardId: CardId; count: number };
    const player = game.players.find((item) => item.id === ctx.actor);
    if (player) {
      const ids = player.hand.filter((item) => item.cardId === cardId).slice(0, count).map((item) => item.instanceId);
      ctx.vars[step.as] = ids;
    }
  } else {
    ctx.vars[step.as] = (value as { instanceIds?: string[] })?.instanceIds ?? [];
  }
  runSteps(ctx);
  finishOperation(ctx);
}

function resolveCustomIonPlay(game: CustomGameState, registry: CustomCardRegistry, player: CustomPlayerState, action: CustomLegalAction): void {
  const cardId = action.cardIds[0];
  const count = action.count ?? action.instanceIds.length;
  const instances = removeHandInstances(player, action.instanceIds);
  game.log.unshift(`${player.nickname} 打出 ${instances.length} 张 ${registry.displayName(cardId)}`);
  const batchEntries = [{ cardId, count: instances.length }];
  const batchId = dispatchPlayedBatch(game, registry, player.id, batchEntries);
  const targets = findCustomReactionTargets(game, registry, cardId, count);
  const target = action.targetId ? targets.find((item) => item.id === action.targetId) : targets[0];
  if (!target) {
    game.zones.solution.push(...instances);
    game.log.unshift(`${player.nickname} 将 ${instances.length} 张 ${registry.displayName(cardId)} 加入溶液区`);
  } else {
    resolveCustomReactionTarget(game, registry, player.id, cardId, instances, target, batchId);
  }
  stabilizeCustomTable(game, registry, player.id, batchId);
  spendCustomActionPoint(game, registry);
}

function resolveCustomSpecialPlay(game: CustomGameState, registry: CustomCardRegistry, player: CustomPlayerState, action: CustomLegalAction): void {
  const [instance] = removeHandInstances(player, action.instanceIds);
  if (!instance) return;
  const def = registry.get(instance.cardId);
  const batchId = dispatchPlayedBatch(game, registry, player.id, [{ cardId: instance.cardId, count: 1 }]);
  instance.ownerPlayerId = player.id;
  if (def?.type === "special" && def.play?.counter) {
    instance.counters[def.play.counter.name] = def.play.counter.value;
  }
  game.zones.products.push(makeCustomProduct(game, registry, "special", [instance], def ? registry.displayName(instance.cardId) : undefined, player.id));
  game.log.unshift(`${player.nickname} 打出 ${registry.displayName(instance.cardId)}`);
  void batchId;
  spendCustomActionPoint(game, registry);
}

function resolveCustomOperationPlay(game: CustomGameState, registry: CustomCardRegistry, player: CustomPlayerState, action: CustomLegalAction): void {
  const cardId = action.cardIds[0];
  const def = registry.get(cardId);
  if (!def || (def.type !== "operation" && def.type !== "generic")) return;
  const [instance] = removeHandInstances(player, action.instanceIds);
  if (!instance) return;
  game.log.unshift(`${player.nickname} 打出 ${registry.displayName(cardId)}`);
  const batchId = dispatchPlayedBatch(game, registry, player.id, [{ cardId, count: 1 }]);
  const hold = "consume" in def && def.consume === "hold";
  if (!hold) game.zones.discard.push(instance);
  const exec: ExecContext = {
    game,
    registry,
    actor: player.id,
    sourceCard: cardId,
    heldInstanceId: hold ? instance.instanceId : undefined,
    heldInstance: hold ? instance : undefined,
    vars: {},
    batchId,
    deferred: [],
    steps: ("steps" in def ? def.steps : undefined) ?? [],
    pc: 0,
    depth: 0,
    spendOnFinish: true,
  };
  runSteps(exec);
  finishOperation(exec);
}

function resolveCustomComboPlay(game: CustomGameState, registry: CustomCardRegistry, player: CustomPlayerState, action: CustomLegalAction): void {
  const rules = game.custom.rules as ResolvedCustomRules;
  const combo = action.comboId ? rules.combos[action.comboId] : undefined;
  if (!combo) return;
  const instances = removeHandInstances(player, action.instanceIds);
  game.log.unshift(`${player.nickname} 打出组合 ${instances.map((instance) => registry.displayName(instance.cardId)).join(" + ")}`);
  const entries = Object.entries(combo.requires).map(([cardId, count]) => ({ cardId, count }));
  const batchId = dispatchPlayedBatch(game, registry, player.id, entries);
  for (const instance of instances) game.zones.discard.push(instance);
  const exec: ExecContext = {
    game,
    registry,
    actor: player.id,
    sourceCard: action.cardIds[0],
    sourceComboId: action.comboId,
    vars: {},
    batchId,
    deferred: [],
    steps: combo.steps ?? [],
    pc: 0,
    depth: 0,
    spendOnFinish: true,
  };
  runSteps(exec);
  finishOperation(exec);
}

function finishOperation(exec: ExecContext): void {
  const game = exec.game;
  if (game.pendingChoice) return; // suspended: finish happens after the choice resolves
  if (game.pendingDraw?.customContinuation) return; // suspended: finish happens after the draw flow completes
  // consume:"hold" cards move to discard once the operation completes
  if (exec.heldInstanceId) {
    const held = exec.heldInstance ?? findInstanceById(game, exec.heldInstanceId);
    if (held) {
      detachInstance(game, held.instanceId);
      game.zones.discard.push(held);
    }
    exec.heldInstanceId = undefined;
    exec.heldInstance = undefined;
  }
  flushExecDeferred(exec);
  if (exec.spendOnFinish && !game.pendingDraw && game.status === "playing") {
    spendCustomActionPoint(game, exec.registry);
  }
}

function resolveCustomOpening(game: CustomGameState, registry: CustomCardRegistry, playerId: PlayerId, intent: CustomActionIntent): CustomResolvedAction {
  const opening = game.openingExchange;
  const player = game.players.find((item) => item.id === playerId);
  if (!opening || !player || !opening.eligiblePlayerIds.includes(playerId)) return { ok: false, message: "该玩家不在开局选择阶段", game };
  if (intent.choiceId === "opening-double") {
    opening.doubleCompletedPlayerIds ??= [];
    if (!opening.doubleCompletedPlayerIds.includes(playerId)) {
      if (intent.selectedCount === 2 && game.scoring && game.scoring.baseBet > 0 && !game.scoring.openingDoublePlayerIds.includes(playerId)) {
        game.scoring.openingDoublePlayerIds.push(playerId);
        game.scoring.multiplier *= 2;
        game.scoring.stake = game.scoring.baseBet * game.scoring.multiplier;
        game.scoring.total = game.scoring.stake;
        game.log.unshift(`${player.nickname} 开局加倍，本局积分倍率 x${game.scoring.multiplier}`);
        appendCustomEvent(game, player, {
          category: "开局",
          operation: "开局加倍",
          result: `${player.nickname} 开局加倍，本局积分倍率 x${game.scoring.multiplier}`,
          pointsOperation: "开局加倍",
          normalizedPointsOperation: "×2",
        });
      }
      opening.doubleCompletedPlayerIds.push(playerId);
    }
  } else if (intent.choiceId === "opening-exchange" || intent.cardInstanceIds) {
    if (!player.canOpeningExchange) return { ok: false, message: "本局规则已禁止换牌", game };
    if (!opening.completedPlayerIds.includes(playerId)) {
      const limit = player.openingExchangeMax === undefined ? 3 : player.openingExchangeMax;
      const minimum = player.openingExchangeMin ?? 0;
      const ids = intent.cardInstanceIds ?? [];
      if (ids.length < minimum) return { ok: false, message: `至少需要弃置 ${minimum} 张牌`, game };
      if (limit !== null && ids.length > limit) return { ok: false, message: `最多只能弃置 ${limit} 张牌`, game };
      const instances = removeHandInstances(player, ids);
      if (instances.length !== ids.length) return { ok: false, message: "换牌选择中包含不在手牌中的牌", game };
      game.zones.discard.push(...instances);
      opening.exchangeDrawCounts ??= {};
      opening.exchangeDrawCounts[playerId] = instances.length;
      opening.completedPlayerIds.push(playerId);
      game.log.unshift(`${player.nickname} 完成开局换牌${instances.length ? `，弃置 ${instances.length} 张` : ""}`);
      appendCustomEvent(game, player, {
        category: "开局",
        operation: "开局换牌",
        quantity: instances.length,
        cards: instances.map((instance) => instance.cardId),
        result: `${player.nickname} 完成开局换牌${instances.length ? `，弃置 ${instances.length} 张` : ""}`,
      });
    }
  } else {
    return { ok: false, message: "未知的开局选择", game };
  }
  finalizeCustomOpeningIfReady(game);
  game.revision += 1;
  return { ok: true, message: "ok", game };
}

function finalizeCustomOpeningIfReady(game: CustomGameState): void {
  const opening = game.openingExchange;
  if (!opening) return;
  const allExchanged = opening.eligiblePlayerIds.every((id) => opening.completedPlayerIds.includes(id));
  const allDoubled = opening.eligiblePlayerIds.every((id) => (opening.doubleCompletedPlayerIds ?? []).includes(id));
  if (allExchanged && allDoubled) {
    for (const id of opening.eligiblePlayerIds) {
      const p = game.players.find((item) => item.id === id);
      if (p) p.openingExchangeDone = true;
    }
    const counts = opening.exchangeDrawCounts ?? {};
    const entries = opening.eligiblePlayerIds
      .map((id) => ({ player: game.players.find((item) => item.id === id), count: counts[id] ?? 0 }))
      .filter((entry): entry is { player: CustomPlayerState; count: number } => Boolean(entry.player) && entry.count > 0)
      .sort((a, b) => a.player.seat - b.player.seat);
    for (const entry of entries) {
      drawInstances(game, entry.player.seat, entry.count, undefined, { reason: "开局换牌补牌", operation: "开局换牌补牌" });
    }
    game.openingExchange = undefined;
    game.status = "playing";
    game.actionPoints = 1;
    game.turnStartedAt = Date.now();
    game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentCustomPlayer(game).timeoutLimitMs : undefined;
    game.log.unshift((game.custom.rules as ResolvedCustomRules).setup.disableOpeningExchange === true ? "开局选择结束" : "开局换牌结束");
    triggerCustomTurnStart(game, customRegistryOf(game));
  } else if (game.mode === "local") {
    const nextId = opening.eligiblePlayerIds.find((id) => !opening.completedPlayerIds.includes(id) || !(opening.doubleCompletedPlayerIds ?? []).includes(id));
    if (nextId) {
      opening.deadlineByPlayerId[nextId] = 0;
      opening.deadlineAt = 0;
    }
  }
}

export function applyCustomOpeningTimeout(input: CustomGameState): CustomGameState {
  let game = cloneCustomGame(input);
  for (let guard = 0; guard < 10 && game.status === "opening-exchange"; guard++) {
    const opening = game.openingExchange;
    if (!opening) break;
    const pendingId = opening.eligiblePlayerIds.find(
      (id) => !opening.completedPlayerIds.includes(id) || !(opening.doubleCompletedPlayerIds ?? []).includes(id),
    );
    if (!pendingId) break;
    if (!opening.completedPlayerIds.includes(pendingId)) {
      const player = game.players.find((item) => item.id === pendingId);
      const minimum = Math.max(0, player?.openingExchangeMin ?? 0);
      const maximum = player?.openingExchangeMax === undefined ? 3 : player.openingExchangeMax;
      const hand = player?.hand ?? [];
      const count = Math.max(0, Math.min(minimum, hand.length, maximum ?? hand.length));
      const ids = hand.slice(0, count).map((instance) => instance.instanceId);
      const result = applyCustomAction(game, pendingId, { type: "custom", choiceId: "opening-exchange", cardInstanceIds: ids }, "timeout");
      if (result.ok) {
        game = result.game;
      } else {
        // 手牌数不足以满足最小弃置：强制按 0 张完成，避免超时重试形成热循环
        const fallback = game.openingExchange;
        if (fallback && !fallback.completedPlayerIds.includes(pendingId)) {
          fallback.exchangeDrawCounts ??= {};
          fallback.exchangeDrawCounts[pendingId] = 0;
          fallback.completedPlayerIds.push(pendingId);
          game.log.unshift(`${player?.nickname ?? pendingId} 超时未完成开局换牌，按弃置 0 张处理`);
          finalizeCustomOpeningIfReady(game);
          game.revision += 1;
        }
      }
    }
    const latest = game.status === "opening-exchange" ? game.openingExchange : undefined;
    if (game.status === "opening-exchange" && latest && !(latest.doubleCompletedPlayerIds ?? []).includes(pendingId)) {
      const result = applyCustomAction(game, pendingId, { type: "custom", choiceId: "opening-double", selectedCount: 0 }, "timeout");
      if (result.ok) {
        game = result.game;
      } else {
        const fallback = game.openingExchange;
        if (fallback) {
          fallback.doubleCompletedPlayerIds ??= [];
          if (!fallback.doubleCompletedPlayerIds.includes(pendingId)) fallback.doubleCompletedPlayerIds.push(pendingId);
          finalizeCustomOpeningIfReady(game);
          game.revision += 1;
        }
      }
    }
  }
  return game;
}

function logCustomSettlementSummary(game: CustomGameState): void {
  const scoring = game.scoring;
  if (!scoring) return;
  game.log.unshift(
    `终局：底注 ${scoring.baseBet}，倍率 x${scoring.multiplier}，stake ${scoring.stake}，累计积分 ${scoring.total}${game.mode === "local" ? "（本地模式仅记录规则积分，不结算账户）" : ""}`,
  );
}

// ---------------------------------------------------------------------------
// public view / timeout
// ---------------------------------------------------------------------------

export function publicCustomGame(game: CustomGameState, viewerId?: PlayerId): CustomGameState {
  const copy = cloneCustomGame(game);
  copy.custom.rules = undefined; // rules are fetched on demand by hash
  if (copy.mode === "online") {
    for (const player of copy.players) {
      if (copy.status !== "ended" && player.id !== viewerId) {
        player.hand = player.hand.map(() => ({ instanceId: "__hidden__", cardId: "__hidden__", marks: [], counters: {} }));
      }
    }
    if (copy.status !== "ended") {
      copy.zones.drawPile = copy.zones.drawPile.map(() => ({ instanceId: "__hidden__", cardId: "__hidden__", marks: [], counters: {} }));
      copy.eventLog = [];
    }
    copy.custom.inspectReveals = copy.custom.inspectReveals.filter((reveal) => reveal.playerId === viewerId);
    if (copy.pendingChoice && copy.pendingChoice.playerId !== viewerId) {
      copy.pendingChoice = { ...copy.pendingChoice, continuation: undefined };
    }
  }
  return copy;
}

export function randomCustomTimeoutAction(game: CustomGameState, playerId: PlayerId): CustomLegalAction | undefined {
  const legal = enumerateCustomActions(game, playerId);
  const playable = legal.filter((action) => action.kind === "play-ion" || action.kind === "play-special" || action.kind === "play-operation" || action.kind === "play-combo");
  if (playable.length === 0) return undefined;
  const index = Math.floor(rngNext(game) * playable.length);
  return playable[index];
}

// 已掉线玩家的回合跳过动作：优先接受摸牌，其次默认选项，最后跳过出牌，避免对局停滞
export function customOfflineFallbackAction(game: CustomGameState, playerId: PlayerId): CustomLegalAction | undefined {
  const legal = enumerateCustomActions(game, playerId);
  return (
    legal.find((action) => action.kind === "accept-draw") ??
    legal.find((action) => action.kind === "choice") ??
    legal.find((action) => action.kind === "pass")
  );
}

export function createLocalCustomRematch(previous: CustomGameState): CustomGameState {
  if (previous.mode !== "local") throw new Error("只有本地游戏可以直接重新开始");
  const rules = previous.custom.rules as ResolvedCustomRules | undefined;
  if (!rules) throw new Error("缺少自定义规则快照，无法重新开始");
  return createCustomGame({
    mode: "local",
    rules,
    players: previous.players.map((player) => ({ nickname: player.nickname, accountId: player.accountId, profile: player.profile, canOpeningExchange: true })),
    baseBet: previous.scoring?.baseBet,
  });
}
