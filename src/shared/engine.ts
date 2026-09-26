import {
  CARDS,
  COLOR_IONS,
  INIT_CARD,
  LABELS,
  balance,
  cardText,
  isFunction,
  isIon,
  isSpecial,
  reactionKind,
  totalCards,
} from "./cards.js";
import type {
  ActionIntent,
  CardId,
  GameEventLogEntry,
  GameState,
  PlayerId,
  PlayerProfile,
  PlayerState,
  PostDrawEffect,
  ProductGroup,
  ReactionGroup,
} from "./types.js";
import { addGameLogMultiplier, currentGameLogMultiplier, multiplyGameLogMultiplier } from "./game-log-score.js";

export const TURN_MS = 60_000;
export const OPENING_EXCHANGE_MS = 15_000;
export const AUTOMATED_ACTION_DELAY_MS = 1_000;
const WEAK_ACID_ANIONS = new Set<CardId>(["S^{2-}", "SO_3^{2-}", "CO_3^{2-}", "SiO_3^{2-}", "PO_4^{3-}", "Ac^-"]);
// 强酸制弱酸顺序：H2SO3 > H3PO4 > HAc > H2CO3 > H2S > H2SiO3（数值越小酸性越强）
const WEAK_ACID_STRENGTH: Record<CardId, number> = {
  "SO_3^{2-}": 0,
  "PO_4^{3-}": 1,
  "Ac^-": 2,
  "CO_3^{2-}": 3,
  "S^{2-}": 4,
  "SiO_3^{2-}": 5,
};

export const CHEMISTRY_WEAK_ACID_ANIONS: ReadonlySet<CardId> = WEAK_ACID_ANIONS;
export const CHEMISTRY_WEAK_ACID_STRENGTH: Readonly<Record<CardId, number>> = WEAK_ACID_STRENGTH;
// 生成物区中 NH4OH（氨水）的 OH- 被 H+ 置换时的优先级：必须低于溶液区 H+ + OH- -> 水（0）
const NH4OH_DISPLACEMENT_PRIORITY = 5;

export interface CreateGameOptions {
  mode: "local" | "online";
  players: Array<{
    nickname: string;
    bot?: boolean;
    botOwnerId?: string;
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
}

export const MIN_INITIAL_HAND_SIZE = 2;

export function maxInitialHandSize(players: number): number {
  return Math.max(MIN_INITIAL_HAND_SIZE, Math.floor(totalCards() / Math.max(1, players)));
}

export function createGame(options: CreateGameOptions): GameState {
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
  const drawPile = shuffle(createDeck(), seed);
  const handSize =
    options.handSize === undefined
      ? recommendedHandSize(options.players.length)
      : Math.max(MIN_INITIAL_HAND_SIZE, Math.min(maxInitialHandSize(options.players.length), Math.floor(options.handSize)));
  const players: PlayerState[] = options.players.map((player, seat) => ({
    id: `p_${seat}_${Math.random().toString(36).slice(2, 8)}`,
    nickname: player.nickname.trim() || `玩家${seat + 1}`,
    accountId: player.accountId,
    profile: player.profile,
    hand: [],
    online: true,
    lastSeenAt: Date.now(),
    bot: player.bot,
    botOwnerId: player.botOwnerId,
    seat,
    timeoutLimitMs: player.bot ? AUTOMATED_ACTION_DELAY_MS : (options.turnTimeLimitMs ?? TURN_MS),
    timeoutStreak: 0,
    normalStreak: 0,
    forcedAutoplay: false,
    canOpeningExchange: Boolean(player.canOpeningExchange && !player.bot),
    openingExchangeMin: player.profile?.permissions?.exchangeMin ?? 0,
    openingExchangeMax: player.profile?.permissions ? player.profile.permissions.exchangeMax : 3,
    openingExchangeWindowMs: options.openingExchangeWindowMs ?? OPENING_EXCHANGE_MS,
  }));
  const eligibleOpeningPlayers = players.filter((player) => player.canOpeningExchange && !player.bot).map((player) => player.id);
  const startingSeat = Number.isInteger(options.startingSeat)
    ? Math.max(0, Math.min(players.length - 1, options.startingSeat as number))
    : 0;
  const openingStartedAt = Date.now();
  const openingDoublingEnabled = options.mode === "online" && (options.baseBet ?? 5) > 0;
  const openingDeadlines = Object.fromEntries(
    players
      .filter((player) => eligibleOpeningPlayers.includes(player.id))
      .map((player) => [
        player.id,
        options.mode === "local"
          ? 0
          : openingStartedAt + Math.max(0, player.openingExchangeWindowMs ?? OPENING_EXCHANGE_MS),
      ]),
  );
  const openingDeadline =
    options.mode === "local" ? 0 : Math.max(openingStartedAt, ...Object.values(openingDeadlines).filter((deadline) => deadline > 0));
  const game: GameState = {
    id: `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: eligibleOpeningPlayers.length > 0 ? "opening-exchange" : "playing",
    mode: options.mode,
    revision: 0,
    players,
    zones: { solution: [], products: [], discard: [], drawPile },
    currentPlayer: startingSeat,
    startingSeat,
    direction: 1,
    actionPoints: 1,
    turnStartedAt: Date.now(),
    turnDeadlineAt:
      eligibleOpeningPlayers.length > 0
        ? options.mode === "online"
          ? openingDeadline
          : undefined
        : options.mode === "online"
          ? Date.now() + players[startingSeat].timeoutLimitMs
          : undefined,
    log: ["游戏开始"],
    eventLog: [],
    logScoreMultiplier: 1,
    rngSeed: seed,
    turnTimeLimitMs: options.turnTimeLimitMs ?? TURN_MS,
    openingExchangeWindowMs: options.openingExchangeWindowMs ?? OPENING_EXCHANGE_MS,
    openingExchange:
      eligibleOpeningPlayers.length > 0
        ? {
            deadlineAt: openingDeadline,
            deadlineByPlayerId: openingDeadlines,
            eligiblePlayerIds: eligibleOpeningPlayers,
            completedPlayerIds: [],
            doubleCompletedPlayerIds: openingDoublingEnabled ? [] : [...eligibleOpeningPlayers],
          }
        : undefined,
    scoring:
      options.mode === "online"
        ? {
            baseBet: Math.max(0, Math.floor(options.baseBet ?? 5)),
            multiplier: 1,
            stake: Math.max(0, Math.floor(options.baseBet ?? 5)),
            total: Math.max(0, Math.floor(options.baseBet ?? 5)),
            pendingByPlayerId: {},
            openingDoublePlayerIds: [],
          }
        : undefined,
  };
  appendGameEvent(game, undefined, {
    category: "开局",
    operation: "创建对局",
    result: `对局 ${game.id}；模式 ${options.mode === "online" ? "联机" : "本地"}；玩家 ${players.length} 人；底注 ${game.scoring?.baseBet ?? 0}`,
  });
  for (const player of players) {
    appendGameEvent(game, player, {
      category: "玩家信息",
      operation: "加入对局",
      result: `席位 ${player.seat + 1}；账号 ${player.accountId ?? "本地/访客"}；身份 ${player.profile?.role ?? "normal"}；初始账户积分 ${player.profile?.points ?? 0}`,
    });
    drawCards(game, player.seat, handSize, { suppressLog: true });
    appendGameEvent(game, player, {
      category: "发牌",
      operation: "初始发牌",
      quantity: player.hand.length,
      cards: player.hand,
      result: `${player.profile?.username ? `@${player.profile.username}` : player.nickname} 获得初始手牌`,
    });
  }
  if (game.status === "playing") triggerTurnStart(game);
  return game;
}

export function cloneGame(game: GameState): GameState {
  return structuredClone(game);
}

export function createLocalRematch(previous: GameState): GameState {
  if (previous.mode !== "local") throw new Error("只有本地游戏可以直接重新开始");
  return createGame({
    mode: "local",
    players: previous.players.map((player) => ({
      nickname: player.nickname,
      bot: player.bot,
      botOwnerId: player.botOwnerId,
      accountId: player.accountId,
      profile: player.profile,
      canOpeningExchange: !player.bot,
    })),
  });
}

export function finishOpeningExchange(input: GameState): GameState {
  const game = cloneGame(input);
  if (game.status !== "opening-exchange") return game;
  completeOpeningExchange(game);
  game.revision += 1;
  trimLog(game);
  return game;
}

export function enumerateActions(game: GameState, playerId = currentPlayer(game).id): ActionIntent[] {
  if (game.status !== "playing") return [];
  const player = game.players.find((p) => p.id === playerId);
  if (!player || player.id !== currentPlayer(game).id) return [];
  const actions: ActionIntent[] = [];
  const counts = countCards(player.hand);
  if (game.pendingChoice) {
    if (game.pendingChoice.playerId !== playerId) return [];
    if (game.pendingChoice.kind === "impurity-reaction") {
      return game.pendingChoice.targetIds.map((targetId) => ({ type: "resolve-impurity", targetId }));
    }
    return game.pendingChoice.choices.flatMap(({ card, maxCount }) =>
      Array.from({ length: maxCount }, (_, index) => ({ type: "resolve-enough" as const, card, count: index + 1 })),
    );
  }
  if (game.pendingDraw) {
    actions.push({ type: "accept-draw" });
    const followCard = game.pendingDraw.functionCard;
    if (followCard && (counts[followCard] ?? 0) > 0) {
      actions.push({ type: "follow-function", card: followCard });
    }
    if ((counts.AddSodium ?? 0) > 0) actions.push({ type: "counter-draw", method: "AddSodium" });
    if ((counts.Acid ?? 0) > 0 && (counts.Alkali ?? 0) > 0) actions.push({ type: "counter-draw", method: "WangZha" });
    return actions;
  }
  for (const [card, count] of Object.entries(counts)) {
    if (isIon(card)) {
      for (let n = 1; n <= count; n++) {
        const targets = findReactionTargets(game, card, n);
        if (targets.length === 0) actions.push({ type: "play-ion", card, count: n });
        for (const target of targets) actions.push({ type: "play-ion", card, count: n, targetId: target.id });
      }
    } else if (isSpecial(card)) {
      actions.push({ type: "play-special", card });
    } else if (isFunction(card)) {
      actions.push({ type: "play-function", card });
    }
  }
  if ((counts.Acid ?? 0) > 0 && (counts.Alkali ?? 0) > 0) actions.push({ type: "wang-zha" });
  if (!player.bot) actions.push({ type: "pass" });
  return actions;
}

export function applyAction(input: GameState, playerId: string, action: ActionIntent, source: "normal" | "timeout" = "normal") {
  const game = cloneGame(input);
  if (game.status === "opening-exchange") {
    expireOpeningDecisions(game);
    if (game.status !== "opening-exchange") return { ok: false, message: "开局选择阶段已经结束", game };
    if (action.type === "opening-double") {
      const player = game.players.find((p) => p.id === playerId);
      if (!player) return { ok: false, message: "玩家不存在", game };
      const opening = game.openingExchange;
      if (!opening?.eligiblePlayerIds.includes(player.id)) return { ok: false, message: "该玩家不在开局选择阶段", game };
      const beforeTotal = game.scoring?.total ?? 0;
      const beforeLogHead = game.log[0];
      const event = beginActionEvent(game, player, action, source);
      opening.doubleCompletedPlayerIds ??= [];
      if (!opening.doubleCompletedPlayerIds.includes(player.id)) {
        if (action.enabled) applyOpeningDouble(game, player);
        opening.doubleCompletedPlayerIds.push(player.id);
      }
      activateNextLocalOpeningPlayer(game);
      completeOpeningIfReady(game);
      finalizeActionEvent(game, event, action, beforeTotal, beforeLogHead, source);
      game.revision += 1;
      return { ok: true, message: "ok", game };
    }
    if (action.type !== "opening-exchange") return { ok: false, message: "开局换牌阶段只能提交换牌选择", game };
    const player = game.players.find((p) => p.id === playerId);
    if (!player) return { ok: false, message: "玩家不存在", game };
    const beforeTotal = game.scoring?.total ?? 0;
    const beforeLogHead = game.log[0];
    const event = beginActionEvent(game, player, action, source);
    const exchange = resolveOpeningExchange(game, player, action.discard);
    if (!exchange.ok) {
      event.result = `失败：${exchange.message}`;
      event.remainingCards = [...player.hand];
      return { ok: false, message: exchange.message, game };
    }
    finalizeActionEvent(game, event, action, beforeTotal, beforeLogHead, source);
    game.revision += 1;
    trimLog(game);
    return { ok: true, message: "ok", game };
  }
  if (game.status !== "playing") return { ok: false, message: "游戏已经结束", game };
  const player = currentPlayer(game);
  if (player.id !== playerId) return { ok: false, message: "还没有轮到该玩家", game };
  const requestedAction = normalizeActionTarget(game, action);
  const legal = enumerateActions(game, playerId).some((candidate) => sameAction(candidate, requestedAction));
  if (!legal) return { ok: false, message: "非法操作或缺少所需手牌", game };

  if (source === "timeout") markTimeout(game, player);
  else markNormal(game, player);
  const beforeTotal = game.scoring?.total ?? 0;
  const beforeLogHead = game.log[0];
  const event = beginActionEvent(game, player, requestedAction, source);

  switch (requestedAction.type) {
    case "accept-draw":
      resolveAcceptDraw(game, player);
      break;
    case "counter-draw":
      resolveCounterDraw(game, player, requestedAction.method);
      break;
    case "follow-function":
      resolveFollowFunction(game, player, requestedAction.card);
      break;
    case "resolve-impurity":
      resolveImpurityChoice(game, player, requestedAction.targetId);
      break;
    case "resolve-enough":
      resolveEnoughChoice(game, player, requestedAction.card, requestedAction.count);
      break;
    case "play-ion":
      resolveIon(game, player, requestedAction.card, requestedAction.count, requestedAction.targetId);
      break;
    case "play-special":
      removeFromHand(player, requestedAction.card, 1);
      game.zones.products.push({
        id: uid("prod"),
        kind: "special",
        cards: [requestedAction.card],
        label: LABELS[requestedAction.card],
        inert: true,
        radiationLeft: requestedAction.card === "U" ? 3 : undefined,
        ownerPlayerId: requestedAction.card === "U" ? player.id : undefined,
      });
      game.log.unshift(`${player.nickname} 打出 ${LABELS[requestedAction.card]}`);
      spendActionPoint(game);
      break;
    case "play-function":
      resolveFunction(game, player, requestedAction.card);
      break;
    case "wang-zha":
      removeFromHand(player, "Acid", 1);
      removeFromHand(player, "Alkali", 1);
      game.zones.discard.push("Acid", "Alkali");
      resolveAddSodium(game, player, "王炸");
      break;
    case "pass":
      game.log.unshift(`${player.nickname} 跳过了出牌机会`);
      spendActionPoint(game);
      break;
  }

  finalizeActionEvent(game, event, requestedAction, beforeTotal, beforeLogHead, source);
  game.revision += 1;
  if (player.hand.length === 0) {
    game.status = "ended";
    game.winnerId = player.id;
    game.log.unshift(`${player.nickname} 获胜`);
    appendGameEvent(game, player, {
      category: "终局",
      operation: "对局结束",
      result: game.mode === "online" ? `${player.nickname} 获胜；累计积分 ${game.scoring?.total ?? 0}` : `${player.nickname} 获胜`,
    });
  }
  trimLog(game);
  return { ok: true, message: "ok", game };
}

export function autoplay(game: GameState): ActionIntent {
  const player = currentPlayer(game);
  const actions = enumerateActions(game, player.id);
  const playable = actions.filter((action) => action.type !== "pass").sort((a, b) => scoreAction(game, b) - scoreAction(game, a));
  if (!playable[0]) throw new Error("AI 当前没有可执行的合法操作");
  return playable[0];
}

export function autoplayBotTurns(input: GameState, maximumActions = 512): { game: GameState; actionCount: number } {
  let game = input;
  let actionCount = 0;
  while (game.status === "playing" && currentPlayer(game).bot) {
    if (actionCount >= maximumActions) throw new Error("AI 连续操作次数异常，请检查牌局状态");
    const player = currentPlayer(game);
    const result = applyAction(game, player.id, autoplay(game), "normal");
    if (!result.ok || result.game.revision <= game.revision) throw new Error(`AI 操作失败：${result.message}`);
    game = result.game;
    actionCount += 1;
  }
  return { game, actionCount };
}

export function findReactionTargets(game: GameState, card: CardId, playedCount: number): ReactionGroup[] {
  if (!isIon(card)) return [];
  const targets: ReactionGroup[] = [];
  const solutionCounts = countCards(game.zones.solution);
  for (const [other, available] of Object.entries(solutionCounts)) {
    const group = buildReaction(card, playedCount, other, available, "solution", undefined, solutionCounts[card] ?? 0);
    if (group) targets.push(group);
  }
  for (const product of game.zones.products) {
    if (product.inert) continue;
    const productCounts = countCards(product.cards);
    for (const [other, available] of Object.entries(productCounts)) {
      if (!canDisplaceProduct(card, other, product)) continue;
      const otherInSolution = other === "H^+" && WEAK_ACID_ANIONS.has(card) ? solutionCounts["H^+"] ?? 0 : 0;
      const group = buildReaction(card, playedCount, other, available, "product", product.id, solutionCounts[card] ?? 0, product.cards, otherInSolution);
      if (group && recreatesSameProduct(product.cards, card, group.playedNeeded, other, group.tableNeeded)) continue;
      if (group) targets.push(group);
    }
  }
  const sorted = targets.sort((a, b) => a.priority - b.priority || b.score - a.score);
  const bestPriority = sorted[0]?.priority;
  return bestPriority === undefined ? [] : sorted.filter((target) => target.priority === bestPriority);
}

function appendGameEvent(
  game: GameState,
  player: PlayerState | undefined,
  input: {
    category: GameEventLogEntry["category"];
    operation: string;
    quantity?: number;
    cards?: CardId[];
    result: string;
    pointsOperation?: string;
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
    remainingCards: [...(player?.hand ?? [])],
    solutionCards: [...game.zones.solution],
    productGroups: game.zones.products.map((product) => [...product.cards]),
    pointsOperation: game.mode === "online" ? input.pointsOperation : undefined,
    cumulativePoints: game.mode === "online" ? game.scoring?.total ?? 0 : undefined,
    scoreMultiplier: currentGameLogMultiplier(game),
    remainingActionPoints: logRemainingActionPoints(game, player),
  };
  game.eventLog.push(entry);
  return entry;
}

function beginActionEvent(game: GameState, player: PlayerState, action: ActionIntent, source: "normal" | "timeout"): GameEventLogEntry {
  const details = actionEventDetails(action);
  return appendGameEvent(game, player, {
    category: "操作",
    operation: details.operation,
    quantity: details.quantity,
    cards: details.cards,
    result: source === "timeout" ? "超时托管执行中" : "执行中",
  });
}

function finalizeActionEvent(
  game: GameState,
  event: GameEventLogEntry,
  action: ActionIntent,
  beforeTotal: number,
  beforeLogHead: string | undefined,
  source: "normal" | "timeout",
): void {
  const player = event.playerId ? game.players.find((item) => item.id === event.playerId) : undefined;
  const messages = newLogMessages(game.log, beforeLogHead);
  const afterTotal = game.scoring?.total ?? 0;
  const operationMessages = messages.filter((line) => !isReactionLogMessage(line));
  event.result = `${source === "timeout" ? "超时托管；" : ""}${operationMessages.join("；") || "操作完成"}`;
  event.remainingCards = [...(player?.hand ?? [])];
  event.solutionCards = [...game.zones.solution];
  event.productGroups = game.zones.products.map((product) => [...product.cards]);
  if (game.mode === "online") {
    const doubled =
      beforeTotal > 0 &&
      (action.type === "wang-zha" ||
        (action.type === "play-function" && action.card === "AddSodium") ||
        action.type === "counter-draw");
    event.pointsOperation = doubled ? "×2" : undefined;
    event.cumulativePoints = doubled ? beforeTotal * 2 : messages.some(isReactionLogMessage) ? beforeTotal : afterTotal;
  }
  event.scoreMultiplier = currentGameLogMultiplier(game);
  event.remainingActionPoints = logRemainingActionPoints(game, player);
}

function logRemainingActionPoints(game: GameState, player: PlayerState | undefined): number {
  if (!player) return game.actionPoints;
  return game.players[game.currentPlayer]?.id === player.id ? game.actionPoints : 0;
}

function isReactionLogMessage(message: string): boolean {
  return /触发|发生反应|反应并|命中|中和|生成物不能/.test(message);
}

function newLogMessages(log: string[], previousHead: string | undefined): string[] {
  const added: string[] = [];
  for (const line of log) {
    if (previousHead !== undefined && line === previousHead) break;
    added.push(line);
  }
  return added.reverse();
}

function actionEventDetails(action: ActionIntent): { operation: string; quantity?: number; cards: CardId[] } {
  switch (action.type) {
    case "opening-exchange":
      return { operation: "开局换牌", quantity: action.discard.length, cards: action.discard };
    case "opening-double":
      return { operation: action.enabled ? "开局加倍" : "不加倍", quantity: action.enabled ? 2 : 0, cards: [] };
    case "play-ion":
      return { operation: "打出离子牌", quantity: action.count, cards: Array(action.count).fill(action.card) };
    case "play-special":
      return { operation: "打出特殊牌", quantity: 1, cards: [action.card] };
    case "play-function":
      return { operation: "打出功能牌", quantity: 1, cards: [action.card] };
    case "follow-function":
      return { operation: "跟出功能牌", quantity: 1, cards: [action.card] };
    case "resolve-impurity":
      return { operation: "选择杂质反应", cards: [] };
    case "resolve-enough":
      return { operation: "选择足量离子", quantity: action.count, cards: Array(action.count).fill(action.card) };
    case "wang-zha":
      return { operation: "打出王炸", quantity: 2, cards: ["Acid", "Alkali"] };
    case "accept-draw":
      return { operation: "接受摸牌", cards: [] };
    case "counter-draw":
      return {
        operation: "抵挡摸牌",
        quantity: action.method === "WangZha" ? 2 : 1,
        cards: action.method === "WangZha" ? ["Acid", "Alkali"] : ["AddSodium"],
      };
    case "pass":
      return { operation: "跳过回合", cards: [] };
  }
}

export function drawCards(
  game: GameState,
  seat: number,
  count: number,
  context: {
    category?: GameEventLogEntry["category"];
    operation?: string;
    result?: string;
    suppressLog?: boolean;
    scorePlayer?: PlayerState;
  } = {},
): CardId[] {
  const player = game.players[seat];
  const drawn: CardId[] = [];
  for (let i = 0; i < count; i++) {
    if (game.zones.drawPile.length === 0) recycleDiscard(game);
    const card = game.zones.drawPile.pop();
    if (!card) break;
    player.hand.push(card);
    drawn.push(card);
    const points = context.scorePlayer ? addScore(game, context.scorePlayer, 1) : 0;
    if (!context.suppressLog) {
      appendGameEvent(game, player, {
        category: context.category ?? "摸牌",
        operation: context.operation ?? "摸牌",
        quantity: 1,
        cards: [card],
        result: context.result ?? "加入手牌",
        pointsOperation: points > 0 ? `+${points}` : undefined,
      });
    }
  }
  return drawn;
}

export function currentPlayer(game: GameState): PlayerState {
  return game.players[game.currentPlayer];
}

export function publicGame(game: GameState, viewerId?: string): GameState {
  const copy = cloneGame(game);
  for (const player of copy.players) {
    if (copy.status !== "ended" && (player.id !== viewerId || player.bot) && copy.mode === "online") {
      player.hand = player.hand.map(() => "__hidden__");
    }
  }
  if (copy.pendingChoice?.kind === "enough-selection" && copy.pendingChoice.playerId !== viewerId && copy.mode === "online") {
    copy.pendingChoice.choices = [];
  }
  if (copy.mode === "online" && copy.status !== "ended") {
    copy.zones.drawPile = copy.zones.drawPile.map(() => "__hidden__");
    copy.eventLog = [];
  }
  return copy;
}

function resolveOpeningExchange(game: GameState, player: PlayerState, discard: CardId[]): { ok: boolean; message: string } {
  const opening = game.openingExchange;
  if (!opening || game.status !== "opening-exchange") return { ok: false, message: "当前不在开局换牌阶段" };
  if (!opening.eligiblePlayerIds.includes(player.id) || !player.canOpeningExchange) return { ok: false, message: "该玩家没有开局换牌权限" };
  if (opening.completedPlayerIds.includes(player.id)) return { ok: true, message: "ok" };
  const minimum = player.openingExchangeMin ?? 0;
  const limit = player.openingExchangeMax === undefined ? 3 : player.openingExchangeMax;
  if (!Array.isArray(discard) || discard.length < minimum) return { ok: false, message: `至少需要弃置 ${minimum} 张牌` };
  if (limit !== null && discard.length > limit) return { ok: false, message: `最多只能弃置 ${limit} 张牌` };
  if (!hasCards(player.hand, discard)) return { ok: false, message: "换牌选择中包含不在手牌中的牌" };
  for (const card of discard) {
    removeFromHand(player, card, 1);
    game.zones.discard.push(card);
  }
  opening.exchangeDrawCounts ??= {};
  opening.exchangeDrawCounts[player.id] = discard.length;
  player.openingExchangeDone = true;
  opening.completedPlayerIds.push(player.id);
  game.log.unshift(`${player.nickname} 完成开局换牌${discard.length ? `，弃置 ${discard.length} 张` : ""}`);
  activateNextLocalOpeningPlayer(game);
  completeOpeningIfReady(game);
  return { ok: true, message: "ok" };
}

function expireOpeningDecisions(game: GameState, now = Date.now()): void {
  const opening = game.openingExchange;
  if (!opening || game.status !== "opening-exchange") return;
  opening.doubleCompletedPlayerIds ??= [];
  opening.deadlineByPlayerId ??= Object.fromEntries(opening.eligiblePlayerIds.map((id) => [id, opening.deadlineAt]));
  if (game.mode === "local") return;
  for (const id of opening.eligiblePlayerIds) {
    if (now < (opening.deadlineByPlayerId[id] ?? opening.deadlineAt)) continue;
    const player = game.players.find((item) => item.id === id);
    if (player) player.openingExchangeDone = true;
    if (!opening.completedPlayerIds.includes(id)) opening.completedPlayerIds.push(id);
    if (!opening.doubleCompletedPlayerIds.includes(id)) opening.doubleCompletedPlayerIds.push(id);
  }
  completeOpeningIfReady(game);
}

function activateNextLocalOpeningPlayer(game: GameState): void {
  const opening = game.openingExchange;
  if (!opening || game.mode !== "local") return;
  const nextId = opening.eligiblePlayerIds.find((id) => hasPendingOpeningDecision(opening, id));
  if (!nextId) return;
  opening.deadlineByPlayerId[nextId] = 0;
  opening.deadlineAt = 0;
}

function hasPendingOpeningDecision(opening: NonNullable<GameState["openingExchange"]>, playerId: PlayerId): boolean {
  return !opening.completedPlayerIds.includes(playerId) || !(opening.doubleCompletedPlayerIds ?? []).includes(playerId);
}

function completeOpeningIfReady(game: GameState): void {
  const opening = game.openingExchange;
  if (!opening) return;
  opening.doubleCompletedPlayerIds ??= [];
  const allExchanged = opening.eligiblePlayerIds.every((id) => opening.completedPlayerIds.includes(id));
  const allDoubled = opening.eligiblePlayerIds.every((id) => opening.doubleCompletedPlayerIds.includes(id));
  if (allExchanged && allDoubled) completeOpeningExchange(game);
}

function applyOpeningDouble(game: GameState, player: PlayerState): void {
  const scoring = game.scoring;
  if (!scoring || scoring.baseBet <= 0 || scoring.openingDoublePlayerIds.includes(player.id)) return;
  scoring.openingDoublePlayerIds.push(player.id);
  scoring.multiplier *= 2;
  scoring.stake = scoring.baseBet * scoring.multiplier;
  scoring.total = scoring.stake;
  game.log.unshift(`${player.nickname} 开局加倍，本局积分倍率 x${scoring.multiplier}`);
}

function completeOpeningExchange(game: GameState): void {
  if (game.status !== "opening-exchange") return;
  const opening = game.openingExchange;
  if (opening) {
    opening.doubleCompletedPlayerIds ??= [];
    for (const id of opening.eligiblePlayerIds) {
      const player = game.players.find((p) => p.id === id);
      if (player) player.openingExchangeDone = true;
      if (!opening.completedPlayerIds.includes(id)) opening.completedPlayerIds.push(id);
      if (!opening.doubleCompletedPlayerIds.includes(id)) opening.doubleCompletedPlayerIds.push(id);
    }
    dealOpeningExchangeDraws(game, opening);
  }
  game.openingExchange = undefined;
  game.status = "playing";
  game.actionPoints = 1;
  game.turnStartedAt = Date.now();
  game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentPlayer(game).timeoutLimitMs : undefined;
  game.log.unshift("开局换牌结束");
  appendGameEvent(game, undefined, {
    category: "开局",
    operation: "开局选择结束",
    result:
      game.mode === "online"
        ? `底注 ${game.scoring?.baseBet ?? 0}；开局倍率 ${game.scoring?.multiplier ?? 1}；当前累计积分 ${game.scoring?.total ?? 0}`
        : "本地开局选择已完成",
  });
  triggerTurnStart(game);
}

function dealOpeningExchangeDraws(game: GameState, opening: NonNullable<GameState["openingExchange"]>): void {
  const counts = opening.exchangeDrawCounts ?? {};
  const entries = opening.eligiblePlayerIds
    .map((id) => ({ player: game.players.find((p) => p.id === id), count: counts[id] ?? 0 }))
    .filter((entry): entry is { player: PlayerState; count: number } => Boolean(entry.player) && entry.count > 0)
    .sort((a, b) => a.player.seat - b.player.seat);
  const totalNeeded = entries.reduce((sum, entry) => sum + entry.count, 0);
  if (totalNeeded <= 0) return;
  if (totalNeeded > game.zones.drawPile.length) recycleDiscard(game, true);
  for (const entry of entries) {
    drawCards(game, entry.player.seat, entry.count, { operation: "换牌补牌", result: "补充开局换出的手牌" });
  }
}

function hasCards(hand: CardId[], cards: CardId[]): boolean {
  const owned = countCards(hand);
  const requested = countCards(cards);
  return Object.entries(requested).every(([card, count]) => (owned[card] ?? 0) >= count);
}

function recreatesSameProduct(productCards: CardId[], played: CardId, playedNeeded: number, other: CardId, otherNeeded: number): boolean {
  const next = [...Array(playedNeeded).fill(played), ...Array(otherNeeded).fill(other)];
  const currentCounts = countCards(productCards);
  const nextCounts = countCards(next);
  const keys = new Set([...Object.keys(currentCounts), ...Object.keys(nextCounts)]);
  return [...keys].every((card) => (currentCounts[card] ?? 0) === (nextCounts[card] ?? 0));
}

function resolveIon(game: GameState, player: PlayerState, card: CardId, count: number, targetId?: string): void {
  removeFromHand(player, card, count);
  const targets = findReactionTargets(game, card, count);
  const target = targetId ? targets.find((item) => item.id === targetId) : targets[0];
  if (!target) {
    game.zones.solution.push(...Array(count).fill(card));
    game.log.unshift(`${player.nickname} 将 ${count} 张 ${LABELS[card]} 加入溶液区`);
  } else {
    resolveReactionTarget(game, player, card, count, target);
  }
  stabilizeTableReactions(game, player);
  spendActionPoint(game);
}

function resolveReactionTarget(
  game: GameState,
  player: PlayerState,
  card: CardId,
  count: number,
  target: ReactionGroup,
): void {
  const usedPlayed = target.playedNeeded - (target.solutionPlayedNeeded ?? 0);
  const leftover = count - usedPlayed;
  if (target.solutionPlayedNeeded) removeCards(game.zones.solution, card, target.solutionPlayedNeeded);
  if (target.source === "solution") {
    removeCards(game.zones.solution, target.tableCard, target.tableNeeded);
  } else {
    const product = game.zones.products.find((item) => item.id === target.productId);
    if (product) {
      if (target.solutionTableNeeded) removeCards(game.zones.solution, target.tableCard, target.solutionTableNeeded);
      removeCards(product.cards, target.tableCard, target.tableNeeded - (target.solutionTableNeeded ?? 0));
      for (const free of product.cards.splice(0)) {
        if (isIon(free)) game.zones.solution.push(free);
        else game.zones.discard.push(free);
      }
      game.zones.products = game.zones.products.filter((item) => item.cards.length > 0);
    }
  }
  const cards = [...Array(usedPlayed).fill(card), ...Array(target.solutionPlayedNeeded ?? 0).fill(card), ...Array(target.tableNeeded).fill(target.tableCard)];
  if (target.kind === "nonexistent" || isWaterCards(cards)) {
    game.zones.discard.push(...cards);
    game.log.unshift(`${player.nickname} 触发 ${target.label}，生成物不能在水中存在，参与反应的牌进入弃牌堆`);
  } else if ((target.groupCount ?? 1) > 1) {
    const groups = target.groupCount ?? 1;
    const playedPerGroup = target.playedNeeded / groups;
    const tablePerGroup = target.tableNeeded / groups;
    for (let i = 0; i < groups; i++) {
      game.zones.products.push(
        makeProduct(
          target.kind,
          [...Array(playedPerGroup).fill(card), ...Array(tablePerGroup).fill(target.tableCard)],
          target.label,
        ),
      );
    }
  } else {
    game.zones.products.push(makeProduct(target.kind, cards, target.label));
  }
  if (leftover > 0) game.zones.solution.push(...Array(leftover).fill(card));
  const bonus = Math.ceil(cards.length / 2);
  game.actionPoints += bonus;
  const points = addScore(game, player, bonus);
  const result = `${formatCardList(cards)} 发生反应，生成${kindLabel(target.kind)}，额外获得 ${bonus} 次出牌机会`;
  game.log.unshift(`${player.nickname}：${result}`);
  appendGameEvent(game, player, {
    category: "反应",
    operation: "离子反应",
    quantity: cards.length,
    cards,
    result,
    pointsOperation: points > 0 ? `+${points}` : undefined,
  });
}

function stabilizeTableReactions(game: GameState, player: PlayerState): boolean {
  let changed = false;
  for (let guard = 0; guard < 260; guard++) {
    const dissolved = rebalanceMicroProducts(game);
    if (dissolved) changed = true;
    const target = findNextTableReaction(game);
    if (!target) {
      if (!dissolved) return changed;
      continue;
    }
    changed = true;
    resolveReactionTarget(game, player, target.playedCard, 0, target);
  }
  game.log.unshift("连续反应达到安全上限，请检查当前牌面");
  return changed;
}

function findNextTableReaction(game: GameState): ReactionGroup | undefined {
  const counts = countCards(game.zones.solution);
  const cards = Object.keys(counts);
  const targets: ReactionGroup[] = [];
  for (let left = 0; left < cards.length; left++) {
    for (let right = left + 1; right < cards.length; right++) {
      const played = cards[left];
      const other = cards[right];
      const group = buildReaction(played, 0, other, counts[other] ?? 0, "solution", undefined, counts[played] ?? 0);
      if (group) targets.push(group);
    }
  }
  for (const played of cards) {
    for (const product of game.zones.products) {
      if (product.inert) continue;
      for (const [other, available] of Object.entries(countCards(product.cards))) {
        if (!canDisplaceProduct(played, other, product)) continue;
        const otherInSolution = other === "H^+" && WEAK_ACID_ANIONS.has(played) ? counts["H^+"] ?? 0 : 0;
        const group = buildReaction(played, 0, other, available, "product", product.id, counts[played] ?? 0, product.cards, otherInSolution);
        if (group && !recreatesSameProduct(product.cards, played, group.playedNeeded, other, group.tableNeeded)) targets.push(group);
      }
    }
  }
  return targets.sort((a, b) => a.priority - b.priority || b.score - a.score || a.id.localeCompare(b.id))[0];
}

function resolveFunction(game: GameState, player: PlayerState, card: CardId): void {
  removeFromHand(player, card, 1);
  game.zones.discard.push(card);
  switch (card) {
    case "Acid":
      resolveStrongReagent(game, player, "H^+", "强酸", card);
      break;
    case "Alkali":
      resolveStrongReagent(game, player, "OH^-", "强碱", card);
      break;
    case "Enough":
      drawCards(game, player.seat, 1, { operation: "足量摸牌", result: "使用足量后摸牌", scorePlayer: player });
      beginEnoughSelection(game, player);
      break;
    case "Impurity":
      resolveImpurity(game, player);
      break;
    case "Filter":
      removeProductsBy(
        game,
        player,
        (p) => p.kind === "solid" || p.kind === "micro" || p.cards.includes("Au") || p.cards.includes("U"),
        "过滤",
        card,
      );
      break;
    case "AirWashing":
      removeProductsBy(game, player, (p) => p.kind === "gas", "洗气", card, 2);
      break;
    case "Fade": {
      const removed = game.zones.solution.filter((ion) => COLOR_IONS.has(ion));
      const n = removed.length;
      game.zones.discard.push(...removed);
      game.zones.solution = game.zones.solution.filter((ion) => !COLOR_IONS.has(ion));
      game.log.unshift(`${player.nickname} 使用褪色，移除 ${formatCardList(removed)}`);
      queueDrawOrSpend(game, player, nextSeat(game, player.seat), 2 * n, "褪色", card);
      break;
    }
    case "Distill": {
      const blocked = game.zones.products.some(isDistillBlockingProduct);
      if (!blocked) {
        const removed = [...game.zones.solution];
        const n = removed.length;
        game.zones.discard.push(...game.zones.solution.splice(0));
        game.log.unshift(`${player.nickname} 使用蒸馏，移除 ${formatCardList(removed)}`);
        queueDrawOrSpend(game, player, nextSeat(game, player.seat), n, "蒸馏", card);
      } else {
        game.log.unshift(`${player.nickname} 蒸馏无效：场上存在沉淀/气体/特殊物质`);
        spendActionPoint(game);
      }
      break;
    }
    case "AddSodium":
      resolveAddSodium(game, player, "加钠");
      break;
    case "Ban": {
      const target = game.players[nextSeat(game, player.seat)];
      target.skipped = true;
      game.log.unshift(`${player.nickname} 使用禁，跳过 ${target.nickname}`);
      spendActionPoint(game);
      break;
    }
    case "Reverse":
      if (game.players.length === 2) {
        game.players[nextSeat(game, player.seat)].skipped = true;
        game.log.unshift(`${player.nickname} 使用逆转，双人局视为禁`);
      } else {
        game.direction = game.direction === 1 ? -1 : 1;
        game.log.unshift(`${player.nickname} 逆转了出牌顺序`);
      }
      spendActionPoint(game);
      break;
  }
}

function resolveStrongReagent(game: GameState, player: PlayerState, reagent: CardId, label: string, functionCard: CardId): void {
  const reacting = removeAllReactiveIons(game, reagent);
  // 区域一旦变动就必须立即检查：连锁反应释放出的离子若仍能与虚拟试剂反应，也要一并中和
  // （例如强酸溶掉 BaCO3 后，释放的 Ba2+ 要立即与溶液区的 SO4 2- 沉淀）
  for (let guard = 0; guard < 130; guard++) {
    const changed = stabilizeTableReactions(game, player);
    const extra = removeAllReactiveIons(game, reagent);
    if (extra.length > 0) reacting.push(...extra);
    if (!changed && extra.length === 0) break;
  }
  game.zones.discard.push(...reacting);
  const result = `${label}与 ${formatCardList(reacting)} 反应并弃置这些牌`;
  game.log.unshift(`${player.nickname} 使用${result}`);
  appendGameEvent(game, player, {
    category: "反应",
    operation: `${label}反应`,
    quantity: reacting.length,
    cards: reacting,
    result,
  });
  queueDrawOrSpend(game, player, nextSeat(game, player.seat), reacting.length, label, functionCard, [], 3);
}

function beginEnoughSelection(game: GameState, player: PlayerState): void {
  const choices = Object.entries(countCards(player.hand))
    .filter(([card]) => isIon(card))
    .map(([card, maxCount]) => ({ card, maxCount }));
  if (choices.length === 0) {
    game.log.unshift(`${player.nickname} 使用足量，但没有可连锁反应的离子`);
    spendActionPoint(game);
    return;
  }
  game.pendingChoice = { kind: "enough-selection", playerId: player.id, choices };
  game.log.unshift(`${player.nickname} 使用足量并摸 1 张牌，正在选择足量离子`);
}

function resolveEnoughChoice(game: GameState, player: PlayerState, selectedCard: CardId, selectedCount: number): void {
  const pending = game.pendingChoice;
  if (pending?.kind !== "enough-selection" || pending.playerId !== player.id) return;
  const choice = pending.choices.find((item) => item.card === selectedCard);
  if (!choice || !Number.isInteger(selectedCount) || selectedCount < 1 || selectedCount > choice.maxCount) return;
  game.pendingChoice = undefined;
  removeFromHand(player, selectedCard, selectedCount);
  game.zones.solution.push(...Array(selectedCount).fill(selectedCard));
  const reacting = removeEnoughTargets(game, selectedCard);
  // 足量清除后溶液区/生成物区已变动，立即检查连锁反应；新释放的可反应离子同样按足量清除
  for (let guard = 0; guard < 130; guard++) {
    const changed = stabilizeTableReactions(game, player);
    const extra = removeEnoughTargets(game, selectedCard);
    if (extra.length > 0) reacting.push(...extra);
    if (!changed && extra.length === 0) break;
  }
  game.zones.discard.push(...reacting);
  game.actionPoints += reacting.length;
  const points = addScore(game, player, reacting.length);
  const reactionResult = `足量 ${cardText(selectedCard)} 与 ${formatCardList(reacting)} 反应，反应牌全部弃置`;
  appendGameEvent(game, player, {
    category: "反应",
    operation: "足量反应",
    quantity: reacting.length,
    cards: reacting,
    result: reactionResult,
    pointsOperation: points > 0 ? `+${points}` : undefined,
  });
  game.log.unshift(
    `${player.nickname} 使用足量 ${cardText(selectedCard)}，将 ${selectedCount} 张所选离子放入溶液区，与 ${formatCardList(reacting)} 反应并获得 ${reacting.length} 次出牌机会`,
  );
  spendActionPoint(game);
}

function resolveImpurity(game: GameState, player: PlayerState): void {
  // Keep the played Impurity out of the recyclable discard pile until its
  // result is known. Impurity may only reveal an ion card.
  removeCards(game.zones.discard, "Impurity", 1);
  if (!game.zones.drawPile.some((card) => isIon(card))) recycleDiscard(game, true);
  const ionIndexes = game.zones.drawPile.reduce<number[]>((indexes, card, index) => {
    if (isIon(card)) indexes.push(index);
    return indexes;
  }, []);
  if (ionIndexes.length === 0) {
    game.zones.discard.push("Impurity");
    game.log.unshift(`${player.nickname} 的杂质未能翻出离子牌`);
    spendActionPoint(game);
    return;
  }

  const ionIndex = ionIndexes[Math.floor(Math.random() * ionIndexes.length)];
  const drawn = game.zones.drawPile.splice(ionIndex, 1)[0];
  player.hand.push(drawn);
  const points = addScore(game, player, 1);
  appendGameEvent(game, player, {
    category: "摸牌",
    operation: "杂质翻牌",
    quantity: 1,
    cards: [drawn],
    result: "杂质翻出离子牌并加入手牌",
    pointsOperation: points > 0 ? `+${points}` : undefined,
  });
  const targets = findReactionTargets(game, drawn, 1);
  game.log.unshift(`${player.nickname} 的杂质翻出 ${LABELS[drawn]}`);
  game.zones.discard.push("Impurity");
  if (targets.length > 1) {
    game.pendingChoice = { kind: "impurity-reaction", playerId: player.id, card: drawn, targetIds: targets.map((target) => target.id) };
    return;
  }
  resolveIon(game, player, drawn, 1, targets[0]?.id);
}

function resolveImpurityChoice(game: GameState, player: PlayerState, targetId?: string): void {
  const pending = game.pendingChoice;
  if (!pending || pending.kind !== "impurity-reaction" || pending.playerId !== player.id || !targetId || !pending.targetIds.includes(targetId)) return;
  game.pendingChoice = undefined;
  resolveIon(game, player, pending.card, 1, targetId);
}

function removeProductsBy(
  game: GameState,
  player: PlayerState,
  predicate: (product: ProductGroup) => boolean,
  label: string,
  functionCard: CardId,
  drawMultiplier = 1,
): void {
  const removed = game.zones.products.filter(predicate);
  const kept = game.zones.products.filter((p) => !predicate(p));
  game.zones.products = kept;
  let score = 0;
  let goldCount = 0;
  let uraniumCount = 0;
  for (const product of removed) {
    goldCount += product.cards.filter((card) => card === "Au").length;
    uraniumCount += product.cards.filter((card) => card === "U").length;
    if (!product.cards.includes("Au") && !product.cards.includes("U")) {
      score += 1;
    }
    game.zones.discard.push(...product.cards);
  }
  const postEffects: PostDrawEffect[] = [];
  if (goldCount > 0) postEffects.push({ type: "draw-all", count: goldCount, extraMinHand: goldCount, reason: "共同富裕" });
  if (uraniumCount > 0) postEffects.push({ type: "draw-all", count: uraniumCount, extraMinHand: 0, reason: "核泄漏" });
  game.log.unshift(`${player.nickname} 使用${label}，清除 ${formatProductCardGroups(removed)}`);
  queueDrawOrSpend(game, player, nextSeat(game, player.seat), score * drawMultiplier, label, functionCard, postEffects);
}

function removeAllReactiveIons(game: GameState, reagent: CardId): CardId[] {
  const removed: CardId[] = [];
  for (let guard = 0; guard < 130; guard++) {
    const dissolved = rebalanceMicroProducts(game);
    const before = removed.length;
    for (const [ion, available] of Object.entries(countCards(game.zones.solution))) {
      if (!isIon(ion)) continue;
      const kind = reactionKind(reagent, ion);
      if (!kind) continue;
      const [, otherNeeded] = balance(reagent, ion);
      const groups = Math.floor(available / otherNeeded);
      const count = groups * otherNeeded;
      removeCards(game.zones.solution, ion, count);
      removed.push(...Array(count).fill(ion));
    }
    for (const product of [...game.zones.products]) {
      if (product.inert) continue;
      const productCounts = countCards(product.cards);
      let touched = false;
      for (const [ion, available] of Object.entries(productCounts)) {
        if (!isIon(ion) || !canDisplaceProduct(reagent, ion, product)) continue;
        const kind = reactionKind(reagent, ion);
        if (!kind || reagentRecreatesProduct(product.cards, reagent, ion)) continue;
        const [, otherNeeded] = balance(reagent, ion);
        const groups = Math.floor(available / otherNeeded);
        const count = groups * otherNeeded;
        if (count <= 0) continue;
        removeCards(product.cards, ion, count);
        removed.push(...Array(count).fill(ion));
        touched = true;
      }
      if (touched) releaseProductRemainder(game, product);
    }
    if (removed.length === before && !dissolved) break;
  }
  return removed;
}

function removeEnoughTargets(game: GameState, selectedCard: CardId): CardId[] {
  const removed: CardId[] = [];
  for (let guard = 0; guard < 130; guard++) {
    const dissolved = rebalanceMicroProducts(game);
    const before = removed.length;
    for (const [other, available] of Object.entries(countCards(game.zones.solution))) {
      if (!isIon(other)) continue;
      const kind = reactionKind(selectedCard, other);
      if (!kind) continue;
      const [, otherNeeded] = balance(selectedCard, other);
      const count = Math.floor(available / otherNeeded) * otherNeeded;
      if (count <= 0) continue;
      removeCards(game.zones.solution, other, count);
      removed.push(...Array(count).fill(other));
    }
    for (const product of [...game.zones.products]) {
      if (product.inert) continue;
      const productCounts = countCards(product.cards);
      let touched = false;
      for (const [other, available] of Object.entries(productCounts)) {
        if (!isIon(other) || !canDisplaceProduct(selectedCard, other, product)) continue;
        const kind = reactionKind(selectedCard, other);
        if (!kind || reagentRecreatesProduct(product.cards, selectedCard, other)) continue;
        const [, otherNeeded] = balance(selectedCard, other);
        const count = Math.floor(available / otherNeeded) * otherNeeded;
        if (count <= 0) continue;
        removeCards(product.cards, other, count);
        removed.push(...Array(count).fill(other));
        touched = true;
      }
      if (touched) releaseProductRemainder(game, product);
    }
    if (removed.length === before && !dissolved) break;
  }
  return removed;
}

export function previewEnoughReactionCount(game: GameState, selectedCard: CardId): number {
  return removeEnoughTargets(cloneGame(game), selectedCard).length;
}

export function previewFunctionCardEffect(game: GameState, card: CardId): { count: number; unit: "cards" | "groups" } | undefined {
  switch (card) {
    case "Acid":
      return { count: previewStrongReagentRemoval(game, "H^+"), unit: "cards" };
    case "Alkali":
      return { count: previewStrongReagentRemoval(game, "OH^-"), unit: "cards" };
    case "Filter":
      return {
        count: game.zones.products.filter((p) => p.kind === "solid" || p.kind === "micro" || p.cards.includes("Au") || p.cards.includes("U")).length,
        unit: "groups",
      };
    case "AirWashing":
      return { count: game.zones.products.filter((p) => p.kind === "gas").length, unit: "groups" };
    case "Fade":
      return { count: game.zones.solution.filter((ion) => COLOR_IONS.has(ion)).length, unit: "cards" };
    case "Distill":
      return { count: game.zones.products.some(isDistillBlockingProduct) ? 0 : game.zones.solution.length, unit: "cards" };
    case "AddSodium":
      return { count: game.zones.solution.length + game.zones.products.reduce((sum, product) => sum + product.cards.length, 0), unit: "cards" };
    default:
      return undefined;
  }
}

function previewStrongReagentRemoval(game: GameState, reagent: CardId): number {
  const clone = cloneGame(game);
  const player = clone.players[clone.currentPlayer];
  let total = removeAllReactiveIons(clone, reagent).length;
  for (let guard = 0; guard < 130; guard++) {
    const changed = stabilizeTableReactions(clone, player);
    const extra = removeAllReactiveIons(clone, reagent).length;
    total += extra;
    if (!changed && extra === 0) break;
  }
  return total;
}

function releaseProductRemainder(game: GameState, product: ProductGroup): void {
  for (const card of product.cards.splice(0)) {
    if (isIon(card)) game.zones.solution.push(card);
    else game.zones.discard.push(card);
  }
  game.zones.products = game.zones.products.filter((item) => item.id !== product.id);
}

function rebalanceMicroProducts(game: GameState): boolean {
  const byFormula = new Map<string, ProductGroup[]>();
  for (const product of game.zones.products.filter((item) => item.kind === "micro")) {
    const key = microFormulaKey(product.cards);
    const products = byFormula.get(key) ?? [];
    products.push(product);
    byFormula.set(key, products);
  }
  if (byFormula.size === 0) return false;

  let changed = false;
  const available = countCards(game.zones.solution);
  for (const products of byFormula.values()) {
    const needed = countCards(products[0].cards);
    if (!hasCountedCards(available, needed)) {
      const dissolved = products[0];
      game.zones.products = game.zones.products.filter((item) => item.id !== dissolved.id);
      game.zones.solution.push(...dissolved.cards);
      for (const card of dissolved.cards) available[card] = (available[card] ?? 0) + 1;
      game.log.unshift(`${dissolved.label} 溶回溶液区，以保留一组微溶物离子`);
      changed = true;
    }
    if (hasCountedCards(available, needed)) {
      for (const [card, count] of Object.entries(needed)) available[card] = (available[card] ?? 0) - count;
    }
  }
  return changed;
}

function microFormulaKey(cards: CardId[]): string {
  return Object.entries(countCards(cards))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([card, count]) => `${card}:${count}`)
    .join("|");
}

function hasCountedCards(available: Record<CardId, number>, needed: Record<CardId, number>): boolean {
  return Object.entries(needed).every(([card, count]) => (available[card] ?? 0) >= count);
}

function reagentRecreatesProduct(productCards: CardId[], reagent: CardId, other: CardId): boolean {
  const [reagentNeeded, otherNeeded] = balance(reagent, other);
  return recreatesSameProduct(productCards, reagent, reagentNeeded, other, otherNeeded);
}

function canDisplaceProduct(reagent: CardId, targetIon: CardId, product: ProductGroup): boolean {
  if (product.kind === "micro") return Boolean(reactionKind(reagent, targetIon));
  if (reagent === "H^+") {
    if (targetIon === "OH^-") return true;
    if (!WEAK_ACID_ANIONS.has(targetIon)) return false;
    return !(targetIon === "S^{2-}" && product.cards.includes("Cu^{2+}"));
  }
  if (reagent === "OH^-" && targetIon === "H^+") {
    return product.cards.some((card) => WEAK_ACID_ANIONS.has(card));
  }
  // 强酸制弱酸：溶液区的弱酸根 B 可以夺走产物中更强酸（酸性 H?A > H?B）的 H+，
  // 生成更弱的酸并释放原酸根。酸性顺序：H2SO3 > H3PO4 > HAc > H2CO3 > H2S > H2SiO3。
  if (targetIon === "H^+" && WEAK_ACID_ANIONS.has(reagent)) {
    const productAnion = product.cards.find((card) => WEAK_ACID_ANIONS.has(card));
    if (!productAnion) return false;
    return (WEAK_ACID_STRENGTH[productAnion] ?? 0) < (WEAK_ACID_STRENGTH[reagent] ?? 0);
  }
  return false;
}

function isDistillBlockingProduct(product: ProductGroup): boolean {
  return (
    product.kind === "solid" ||
    product.kind === "micro" ||
    product.kind === "gas" ||
    product.kind === "special" ||
    product.cards.includes("Au") ||
    product.cards.includes("U")
  );
}

function specialRemovalEffects(products: ProductGroup[]): PostDrawEffect[] {
  const goldCount = products.flatMap((product) => product.cards).filter((card) => card === "Au").length;
  const uraniumCount = products.flatMap((product) => product.cards).filter((card) => card === "U").length;
  const effects: PostDrawEffect[] = [];
  if (goldCount > 0) effects.push({ type: "draw-all", count: goldCount, extraMinHand: goldCount, reason: "共同富裕" });
  if (uraniumCount > 0) effects.push({ type: "draw-all", count: uraniumCount, extraMinHand: 0, reason: "核泄漏" });
  return effects;
}

function resolveAddSodium(game: GameState, player: PlayerState, label: string): void {
  doubleScore(game, player);
  const removedSolution = [...game.zones.solution];
  const removedProducts = game.zones.products.splice(0);
  const postEffects = specialRemovalEffects(removedProducts);
  game.zones.discard.push(...game.zones.solution.splice(0));
  for (const product of removedProducts) game.zones.discard.push(...product.cards);
  drawAllPlayersScored(game, 1, player.seat, player, label);
  applyPostDrawEffectsScored(game, postEffects, player.seat, player, label);
  game.log.unshift(
    `${player.nickname} 使用${label}，清除溶液区 ${formatCardList(removedSolution)} 和生成物区 ${formatProductCardGroups(removedProducts)}，所有玩家各摸 1 张`,
  );
  spendActionPoint(game);
}

function triggerTurnStart(game: GameState): void {
  let guard = 0;
  while (guard++ < game.players.length) {
    const current = currentPlayer(game);
    const banSkipped = current.skipped === true;
    if (!banSkipped) break;
    current.skipped = false;
    game.log.unshift(`${current.nickname} 的回合被跳过`);
    advanceToNextPlayer(game, false);
  }
  applyTurnStartRadiation(game);
}
function applyTurnStartRadiation(game: GameState, seat = game.currentPlayer): void {
  const player = game.players[seat];
  const uranium = game.zones.products.filter((p) => p.cards.includes("U") && (p.radiationLeft ?? 0) > 0);
  for (const product of uranium) {
    product.radiationLeft = (product.radiationLeft ?? 1) - 1;
    const scorePlayer = game.players.find((candidate) => candidate.id === product.ownerPlayerId) ?? player;
    const drawn = drawCards(game, player.seat, 1, {
      operation: "辐射摸牌",
      result: `受到铀辐射；铀剩余寿命 ${product.radiationLeft}`,
      scorePlayer,
    }).length;
    game.log.unshift(`${player.nickname} 受到辐射摸 ${drawn} 张，铀剩余寿命 ${product.radiationLeft}`);
  }
  for (const product of uranium.filter((p) => (p.radiationLeft ?? 0) <= 0)) {
    game.zones.discard.push(...product.cards);
  }
  game.zones.products = game.zones.products.filter((p) => !p.cards.includes("U") || (p.radiationLeft ?? 0) > 0);
}

function spendActionPoint(game: GameState): void {
  if (game.pendingDraw || game.pendingChoice) return;
  game.actionPoints -= 1;
  if (game.actionPoints > 0) {
    game.turnStartedAt = Date.now();
    game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentPlayer(game).timeoutLimitMs : undefined;
    return;
  }
  if (game.status !== "playing") return;
  advanceToNextPlayer(game, true);
}

function advanceToNextPlayer(game: GameState, triggerStart: boolean): void {
  game.currentPlayer = nextSeat(game, game.currentPlayer);
  game.actionPoints = 1;
  game.turnStartedAt = Date.now();
  game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentPlayer(game).timeoutLimitMs : undefined;
  if (triggerStart) triggerTurnStart(game);
}

function nextSeat(game: GameState, from: number): number {
  return (from + game.direction + game.players.length) % game.players.length;
}

function queueDrawOrSpend(
  game: GameState,
  source: PlayerState,
  startSeat: number,
  count: number,
  reason: string,
  functionCard?: CardId,
  postEffects: PostDrawEffect[] = [],
  perPlayerCap = 3,
): void {
  if (count <= 0) {
    applyPostDrawEffects(game, postEffects, source.seat, source);
    spendActionPoint(game);
    return;
  }
  game.pendingDraw = {
    sourceSeat: source.seat,
    sourceActionPoints: game.actionPoints,
    turnSeat: source.seat,
    turnActionPoints: game.actionPoints,
    targetSeat: startSeat,
    remaining: count,
    perPlayerCap,
    reason,
    functionCard,
    followedPlayerIds: [],
    drawnByPlayerId: {},
    postEffects,
  };
  enterPendingDrawTurn(game, game.pendingDraw, startSeat);
  game.log.unshift(`${currentPlayer(game).nickname} 需要因${reason}加牌 ${count} 张`);
}

function resolveFollowFunction(game: GameState, player: PlayerState, card: CardId): void {
  const pending = game.pendingDraw;
  if (!pending || pending.functionCard !== card) return;
  applyTurnStartRadiation(game, player.seat);
  removeFromHand(player, card, 1);
  game.zones.discard.push(card);
  drawCards(game, player.seat, 1, {
    operation: "跟牌摸牌",
    result: "跟牌后摸 1 张牌",
  });
  pending.sourceSeat = player.seat;
  pending.targetSeat = nextSeat(game, player.seat);
  pending.followedPlayerIds ??= [];
  pending.followedPlayerIds.push(player.id);
  enterPendingDrawTurn(game, pending, pending.targetSeat);
  game.log.unshift(`${player.nickname} 跟出 ${LABELS[card]}，将加牌效果传给 ${currentPlayer(game).nickname}`);
}
function resolveAcceptDraw(game: GameState, player: PlayerState): void {
  const pending = game.pendingDraw;
  if (!pending) return;
  const amount = Math.min(pending.perPlayerCap, pending.remaining);
  const actual = drawCards(game, player.seat, amount, {
    operation: "接受摸牌",
    result: "因加牌而摸牌",
    scorePlayer: game.players[pending.sourceSeat],
  }).length;
  pending.drawnByPlayerId ??= {};
  pending.drawnByPlayerId[player.id] = (pending.drawnByPlayerId[player.id] ?? 0) + amount;
  pending.remaining -= amount;
  game.log.unshift(
    actual === amount ? `${player.nickname} 摸 ${actual} 张牌` : `${player.nickname} 应摸 ${amount} 张牌，牌堆仅剩 ${actual} 张`,
  );
  if (pending.remaining > 0) {
    const next = nextPendingDrawSeat(game, pending, player.seat);
    if (next !== undefined) {
      pending.targetSeat = next;
      enterPendingDrawTurn(game, pending, next);
      return;
    }
  }
  completePendingDraw(game, pending);
}

function resolveCounterDraw(game: GameState, player: PlayerState, method: "AddSodium" | "WangZha"): void {
  const pending = game.pendingDraw;
  if (!pending) return;
  applyTurnStartRadiation(game, player.seat);
  if (method === "AddSodium") {
    removeFromHand(player, "AddSodium", 1);
    game.zones.discard.push("AddSodium");
  } else {
    removeFromHand(player, "Acid", 1);
    removeFromHand(player, "Alkali", 1);
    game.zones.discard.push("Acid", "Alkali");
  }
  doubleScore(game, player);
  const removedSolution = [...game.zones.solution];
  const removedProducts = game.zones.products.splice(0);
  const postEffects = [...(pending.postEffects ?? []), ...specialRemovalEffects(removedProducts)];
  game.zones.discard.push(...game.zones.solution.splice(0));
  for (const product of removedProducts) game.zones.discard.push(...product.cards);
  const label = method === "AddSodium" ? "加钠" : "王炸";
  drawAllPlayersScored(game, 1, player.seat, player, label);
  if (nextSeat(game, pending.sourceSeat) !== player.seat) {
    drawCards(game, player.seat, 1, {
      operation: `${label}摸牌`,
      result: `${label}抵挡加牌后摸牌`,
      scorePlayer: player,
    });
  }
  applyPostDrawEffectsScored(game, postEffects, player.seat, player, label);
  game.log.unshift(
    `${player.nickname} 用${label}抵挡加牌，清除溶液区 ${formatCardList(removedSolution)} 和生成物区 ${formatProductCardGroups(removedProducts)}`,
  );
  const sourceNext = nextSeat(game, pending.sourceSeat);
  const next = sourceNext === player.seat ? nextSeat(game, player.seat) : sourceNext;
  game.pendingDraw = undefined;
  game.currentPlayer = next;
  game.actionPoints = 1;
  game.turnStartedAt = Date.now();
  game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentPlayer(game).timeoutLimitMs : undefined;
  triggerTurnStart(game);
}

function enterPendingDrawTurn(game: GameState, pending: NonNullable<GameState["pendingDraw"]>, seat: number): void {
  game.currentPlayer = seat;
  game.actionPoints = 1;
  game.turnStartedAt = Date.now();
  game.turnDeadlineAt = game.mode === "online" ? Date.now() + currentPlayer(game).timeoutLimitMs : undefined;
  pending.targetSeat = game.currentPlayer;
}

function nextPendingDrawSeat(
  game: GameState,
  pending: NonNullable<GameState["pendingDraw"]>,
  fromSeat: number,
): number | undefined {
  let seat = nextSeat(game, fromSeat);
  for (let i = 0; i < game.players.length; i++) {
    if (seat !== pending.sourceSeat) return seat;
    seat = nextSeat(game, seat);
  }
  return undefined;
}

function completePendingDraw(game: GameState, pending: NonNullable<GameState["pendingDraw"]>): void {
  const sourceSeat = pending.sourceSeat;
  const postEffects = pending.postEffects ?? [];
  pending.remaining = 0;
  game.pendingDraw = undefined;
  applyPostDrawEffects(game, postEffects, sourceSeat, game.players[sourceSeat]);
  game.currentPlayer = pending.turnSeat ?? sourceSeat;
  game.actionPoints = Math.max(1, pending.turnActionPoints ?? pending.sourceActionPoints ?? 1);
  spendActionPoint(game);
}
function drawAllPlayersScored(
  game: GameState,
  count: number,
  startSeat: number,
  scorePlayer: PlayerState,
  label: string,
): number {
  let seat = startSeat;
  let total = 0;
  for (let i = 0; i < game.players.length; i++) {
    total += drawCards(game, seat, count, {
      operation: `${label}摸牌`,
      result: `使用${label}后摸牌`,
      scorePlayer,
    }).length;
    seat = nextSeat(game, seat);
  }
  return total;
}

function applyPostDrawEffects(game: GameState, effects: PostDrawEffect[], startSeat: number, scorePlayer?: PlayerState): number {
  let drawn = 0;
  for (const effect of effects) {
    if (effect.type !== "draw-all") continue;
    let seat = startSeat;
    for (let playerIndex = 0; playerIndex < game.players.length; playerIndex++) {
      drawn += drawCards(game, seat, effect.count, {
        operation: "后效摸牌",
        result: effect.reason,
        scorePlayer,
      }).length;
      seat = nextSeat(game, seat);
    }
    for (let extra = 0; extra < effect.extraMinHand; extra++) {
      const minimumHandSeats = minHandSeatsFrom(game, startSeat);
      for (const minimumHandSeat of minimumHandSeats) {
        drawn += drawCards(game, minimumHandSeat, 1, {
          operation: "后效摸牌",
          result: `${effect.reason}：所有手牌数最少者额外摸牌`,
          scorePlayer,
        }).length;
      }
    }
    game.log.unshift(
      `${effect.reason}：所有玩家摸 ${effect.count} 张${effect.extraMinHand ? `，每轮所有当前手牌数最少者各额外摸 1 张，共 ${effect.extraMinHand} 轮` : ""}`,
    );
  }
  return drawn;
}

function applyPostDrawEffectsScored(
  game: GameState,
  effects: PostDrawEffect[],
  startSeat: number,
  scorePlayer: PlayerState,
  label: string,
): number {
  let drawn = 0;
  for (const effect of effects) {
    if (effect.type !== "draw-all") continue;
    let seat = startSeat;
    for (let playerIndex = 0; playerIndex < game.players.length; playerIndex++) {
      drawn += drawCards(game, seat, effect.count, {
        operation: `${label}摸牌`,
        result: effect.reason,
        scorePlayer,
      }).length;
      seat = nextSeat(game, seat);
    }
    for (let extra = 0; extra < effect.extraMinHand; extra++) {
      const minimumHandSeats = minHandSeatsFrom(game, startSeat);
      for (const minimumHandSeat of minimumHandSeats) {
        drawn += drawCards(game, minimumHandSeat, 1, {
          operation: `${label}摸牌`,
          result: `${effect.reason}：所有手牌数最少者额外摸牌`,
          scorePlayer,
        }).length;
      }
    }
    game.log.unshift(
      `${effect.reason}：所有玩家摸 ${effect.count} 张${effect.extraMinHand ? `，每轮所有当前手牌数最少者各额外摸 1 张，共 ${effect.extraMinHand} 轮` : ""}`,
    );
  }
  return drawn;
}

function buildReaction(
  played: CardId,
  playedCount: number,
  other: CardId,
  availableOther: number,
  source: "solution" | "product",
  productId?: string,
  availablePlayedInSolution = 0,
  productCards?: CardId[],
  availableOtherInSolution = 0,
): ReactionGroup | undefined {
  if (!isIon(other) || Math.sign(CARDS[played].charge ?? 0) === Math.sign(CARDS[other].charge ?? 0)) return undefined;
  const kind = reactionKind(played, other);
  if (!kind) return undefined;
  const [playedPerGroup, tablePerGroup] = balance(played, other);
  const availablePlayed = playedCount + availablePlayedInSolution;
  const possibleGroups = Math.min(
    Math.floor(availablePlayed / playedPerGroup),
    Math.floor((availableOther + Math.max(0, availableOtherInSolution)) / tablePerGroup),
  );
  const groupCount = kind === "micro" ? possibleGroups - 1 : possibleGroups;
  if (groupCount < 1) return undefined;
  const playedNeeded = playedPerGroup * groupCount;
  const tableNeeded = tablePerGroup * groupCount;
  const solutionPlayedNeeded = Math.max(0, playedNeeded - playedCount);
  const solutionTableNeeded = Math.min(Math.max(0, availableOtherInSolution), Math.max(0, tableNeeded - availableOther));
  if (
    playedCount + solutionPlayedNeeded < playedNeeded ||
    solutionPlayedNeeded > availablePlayedInSolution ||
    availableOther + solutionTableNeeded < tableNeeded
  ) {
    return undefined;
  }
  let priority = reactionPriority(played, other, kind);
  // 出 H+ 时若溶液区有 OH-，必须先与 OH- 中和生成水；从 NH4OH（氨水）产物中置换 OH- 排在其后
  if (
    source === "product" &&
    productCards?.includes("NH_4^+") &&
    ((played === "H^+" && other === "OH^-") || (played === "OH^-" && other === "H^+"))
  ) {
    priority = Math.max(priority, NH4OH_DISPLACEMENT_PRIORITY);
  }
  const label = `${LABELS[played]} + ${LABELS[other]} -> ${kindLabel(kind)}`;
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
    score: playedNeeded + tableNeeded + kindScore(kind),
    label,
    groupCount,
  };
}

function makeProduct(kind: ProductGroup["kind"], cards: CardId[], label?: string, ownerPlayerId?: PlayerId): ProductGroup {
  return {
    id: uid("prod"),
    kind,
    cards,
    label: label ?? `${cards.map((card) => LABELS[card]).join(" + ")} -> ${kindLabel(kind)}`,
    inert: cards.includes("Au") || cards.includes("U"),
    radiationLeft: cards.includes("U") ? 3 : undefined,
    ownerPlayerId: cards.includes("U") ? ownerPlayerId : undefined,
  };
}

function isWaterCards(cards: CardId[]): boolean {
  const counts = countCards(cards);
  return Object.keys(counts).length === 2 && (counts["H^+"] ?? 0) === (counts["OH^-"] ?? 0) && (counts["H^+"] ?? 0) > 0;
}

function createDeck(): CardId[] {
  return Object.entries(INIT_CARD).flatMap(([card, count]) => Array(count).fill(card));
}

function shuffle(deck: CardId[], seed: number): CardId[] {
  let x = seed || 123456789;
  const rand = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function recycleDiscard(game: GameState, keepExistingPile = false): void {
  if (game.zones.discard.length === 0) return;
  const recycled = game.zones.discard.splice(0);
  game.zones.drawPile = shuffle(keepExistingPile ? [...game.zones.drawPile, ...recycled] : recycled, game.rngSeed + Date.now());
}

function countCards(cards: CardId[]): Record<CardId, number> {
  return cards.reduce<Record<CardId, number>>((acc, card) => {
    acc[card] = (acc[card] ?? 0) + 1;
    return acc;
  }, {});
}

function removeFromHand(player: PlayerState, card: CardId, count: number): void {
  removeCards(player.hand, card, count);
}

function removeCards(cards: CardId[], card: CardId, count: number): void {
  for (let i = 0; i < count; i++) {
    const index = cards.indexOf(card);
    if (index >= 0) cards.splice(index, 1);
  }
}

function normalizeActionTarget(game: GameState, action: ActionIntent): ActionIntent {
  if (action.type !== "play-ion" || action.targetId) return action;
  const targets = findReactionTargets(game, action.card, action.count);
  return targets.length === 1 ? { ...action, targetId: targets[0].id } : action;
}

function sameAction(a: ActionIntent, b: ActionIntent): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "play-ion" && b.type === "play-ion") {
    return a.card === b.card && a.count === b.count && (b.targetId ? a.targetId === b.targetId : !a.targetId);
  }
  if (a.type === "play-special" && b.type === "play-special") return a.card === b.card;
  if (a.type === "play-function" && b.type === "play-function") {
    return a.card === b.card && a.payload?.enoughCard === b.payload?.enoughCard && a.payload?.enoughCount === b.payload?.enoughCount;
  }
  if (a.type === "follow-function" && b.type === "follow-function") return a.card === b.card;
  if (a.type === "resolve-impurity" && b.type === "resolve-impurity") return a.targetId === b.targetId;
  if (a.type === "resolve-enough" && b.type === "resolve-enough") return a.card === b.card && a.count === b.count;
  if (a.type === "counter-draw" && b.type === "counter-draw") return a.method === b.method;
  return a.type === b.type;
}

function scoreAction(game: GameState, action: ActionIntent): number {
  if (action.type === "accept-draw") return 100;
  if (action.type === "counter-draw") return game.pendingDraw && game.pendingDraw.remaining >= 4 ? 80 : 10;
  if (action.type === "follow-function") return 70;
  if (action.type === "resolve-impurity") return 60;
  if (action.type === "resolve-enough") return action.count * 5;
  if (action.type === "play-ion") {
    const targetScore = action.targetId ? findReactionTargets(game, action.card, action.count).find((t) => t.id === action.targetId)?.score ?? 0 : 0;
    return action.count * 4 + targetScore * 6;
  }
  if (action.type === "wang-zha") return 28;
  if (action.type === "play-special") return 18;
  if (action.type === "play-function") {
    const values: Record<string, number> = { Filter: 24, AirWashing: 22, Fade: 20, Distill: 16, Ban: 15, Reverse: 12, AddSodium: 10, Acid: 14, Alkali: 14, Enough: 18, Impurity: 8 };
    return values[action.card] ?? 5;
  }
  return -1;
}

function markTimeout(game: GameState, player: PlayerState): void {
  player.timeoutStreak = (player.timeoutStreak ?? 0) + 1;
  player.normalStreak = 0;
  if (player.bot) {
    player.timeoutLimitMs = AUTOMATED_ACTION_DELAY_MS;
    return;
  }
  if (player.timeoutStreak >= 3) {
    player.forcedAutoplay = true;
    player.timeoutLimitMs = AUTOMATED_ACTION_DELAY_MS;
    return;
  }
  player.forcedAutoplay = false;
  player.timeoutLimitMs = game.turnTimeLimitMs ?? TURN_MS;
}

function markNormal(game: GameState, player: PlayerState): void {
  if (player.bot) {
    player.timeoutLimitMs = AUTOMATED_ACTION_DELAY_MS;
    return;
  }
  if (player.forcedAutoplay) {
    player.timeoutLimitMs = AUTOMATED_ACTION_DELAY_MS;
    player.normalStreak = 0;
    return;
  }
  player.timeoutStreak = 0;
  player.normalStreak = 0;
  player.timeoutLimitMs = game.turnTimeLimitMs ?? TURN_MS;
}

function minHandSeatsFrom(game: GameState, startSeat: number): number[] {
  const min = Math.min(...game.players.map((player) => player.hand.length));
  const seats: number[] = [];
  let seat = startSeat;
  for (let i = 0; i < game.players.length; i++) {
    if (game.players[seat].hand.length === min) seats.push(seat);
    seat = nextSeat(game, seat);
  }
  return seats;
}

function addScore(game: GameState, player: PlayerState, units: number): number {
  addGameLogMultiplier(game, units);
  const scoring = game.scoring;
  if (!scoring || scoring.baseBet <= 0 || units <= 0) return 0;
  const points = units * scoring.stake;
  scoring.total = (scoring.total ?? scoring.stake) + points;
  if (!player.bot) scoring.pendingByPlayerId[player.id] = (scoring.pendingByPlayerId[player.id] ?? 0) + points;
  return points;
}

function doubleScore(game: GameState, player: PlayerState): void {
  multiplyGameLogMultiplier(game, 2);
  const scoring = game.scoring;
  if (!scoring || scoring.baseBet <= 0) return;
  const current = scoring.total ?? scoring.stake;
  scoring.total = current * 2;
  if (!player.bot) scoring.pendingByPlayerId[player.id] = (scoring.pendingByPlayerId[player.id] ?? 0) + current;
}

export function recommendedHandSize(players: number): number {
  if (players <= 2) return 10;
  if (players <= 4) return 7;
  if (players <= 7) return 6;
  return 5;
}

function kindLabel(kind: ProductGroup["kind"]): string {
  return ({ solid: "沉淀", gas: "气体", weak: "弱电解质", nonexistent: "不存在物", micro: "微溶物", special: "特殊物质" } as const)[kind];
}

function formatCardList(cards: CardId[]): string {
  return cards.length > 0 ? cards.map(cardText).join(" ") : "无";
}

function formatProductCardGroups(products: ProductGroup[]): string {
  return products.length > 0 ? products.map((product) => `(${formatCardList(product.cards)})`).join(" ") : "无";
}

function kindScore(kind: ProductGroup["kind"]): number {
  return ({ gas: 5, solid: 4, weak: 3, nonexistent: 2, micro: 2, special: 1 } as const)[kind];
}

function reactionPriority(played: CardId, other: CardId, kind: ProductGroup["kind"]): number {
  const acidBasePriority: Record<CardId, number> = {
    "OH^-": 0,
    "S^{2-}": 10,
    "SO_3^{2-}": 10,
    "CO_3^{2-}": 10,
    "SiO_3^{2-}": 20,
    "PO_4^{3-}": 30,
    "Ac^-": 30,
  };
  if (played === "H^+" && acidBasePriority[other] !== undefined) return acidBasePriority[other];
  if (other === "H^+" && acidBasePriority[played] !== undefined) return acidBasePriority[played];

  if ((played === "OH^-" && other === "NH_4^+") || (played === "NH_4^+" && other === "OH^-")) return 40;

  const hydroxidePriority: Record<CardId, number> = {
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

  const kindPriority: Record<ProductGroup["kind"], number> = {
    gas: 100,
    solid: 200,
    micro: 210,
    weak: 300,
    nonexistent: 400,
    special: 500,
  };
  return kindPriority[kind];
}

function trimLog(game: GameState): void {
  game.log = game.log.slice(0, 80);
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
