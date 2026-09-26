import { CARDS, isFunction, isIon, isSpecial } from "./cards.js";
import { applyAction, currentPlayer, enumerateActions, findReactionTargets } from "./engine.js";
import type { ActionIntent, CardId, GameState, PlayerState } from "./types.js";
import { getAdvancedAiMultipliers, type AdvancedAiMultipliers } from "./advanced-ai-weights.js";

export interface AdvancedAiOptions {
  timeBudgetMs?: number;
  maxIterations?: number;
  rolloutDepth?: number;
  seed?: number;
  level?: AdvancedAiLevel;
}

export type AdvancedAiLevel = "none" | "low" | "medium" | "high" | "xhigh";

export const ADVANCED_AI_PRESETS: Record<AdvancedAiLevel, Required<Omit<AdvancedAiOptions, "seed" | "level">>> = {
  none: { timeBudgetMs: 0, maxIterations: 0, rolloutDepth: 0 },
  low: { timeBudgetMs: 2_400, maxIterations: 1_200, rolloutDepth: 10 },
  medium: { timeBudgetMs: 4_800, maxIterations: 3_200, rolloutDepth: 16 },
  high: { timeBudgetMs: 8_800, maxIterations: 7_000, rolloutDepth: 22 },
  xhigh: { timeBudgetMs: 13_800, maxIterations: 14_000, rolloutDepth: 28 },
};

export interface AdvancedAiRecommendation {
  action: ActionIntent;
  simulations: number;
  elapsedMs: number;
  depth: number;
  winProbability?: number;
}

type SearchEdge = {
  action: ActionIntent;
  visits: number;
  values: Record<string, number>;
  winProbabilities: Record<string, number>;
  prior: number;
};

type SearchNode = {
  visits: number;
  edges: Map<string, SearchEdge>;
};

export function recommendAdvancedAction(
  input: GameState,
  playerId: string,
  options: AdvancedAiOptions = {},
): AdvancedAiRecommendation {
  const startedAt = monotonicNow();
  const requestedTimeBudgetMs = Math.floor(options.timeBudgetMs ?? ADVANCED_AI_PRESETS.medium.timeBudgetMs);
  const requestedMaxIterations = Math.floor(options.maxIterations ?? 4_000);
  const requestedRolloutDepth = Math.floor(options.rolloutDepth ?? 18);
  const directOnly =
    options.level === "none" || requestedTimeBudgetMs <= 0 || requestedMaxIterations <= 0 || requestedRolloutDepth <= 0;
  const timeBudgetMs = directOnly ? 0 : clamp(requestedTimeBudgetMs, 25, 13_800);
  const maxIterations = directOnly ? 0 : clamp(requestedMaxIterations, 1, 20_000);
  const rolloutDepth = directOnly ? 0 : clamp(requestedRolloutDepth, 2, 32);
  const seed = (options.seed ?? input.rngSeed ?? 1) >>> 0;
  const level = options.level ?? (directOnly ? "none" : "medium");
  const weights = getAdvancedAiMultipliers(input.players.length, level);

  if (input.status === "opening-exchange") {
    const player = input.players.find((item) => item.id === playerId);
    if (!player) throw new Error("玩家不存在");
    const exchangeComplete = input.openingExchange?.completedPlayerIds.includes(playerId);
    const doubleComplete = input.openingExchange?.doubleCompletedPlayerIds.includes(playerId);
    if (exchangeComplete && !doubleComplete) {
      const weakestOpponent = Math.min(
        ...input.players.filter((item) => item.id !== playerId).map((item) => item.hand.length),
      );
      const enabled = handUtility(player.hand, weights) > -player.hand.length * 165 && weakestOpponent > 2;
      return {
        action: { type: "opening-double", enabled },
        simulations: 1,
        elapsedMs: monotonicNow() - startedAt,
        depth: 1,
      };
    }
    const action = directOnly
      ? recommendOpeningExchangeDirect(input, playerId, weights)
      : recommendOpeningExchange(input, playerId, seed, timeBudgetMs, maxIterations, startedAt, weights);
    return {
      action,
      simulations: openingSampleCount(input, playerId, maxIterations),
      elapsedMs: monotonicNow() - startedAt,
      depth: 1,
    };
  }

  const rootActions = enumerateActions(input, playerId);
  if (rootActions.length === 0) throw new Error("当前没有可建议的合法操作");
  if (rootActions.length === 1) {
    return { action: rootActions[0], simulations: 1, elapsedMs: monotonicNow() - startedAt, depth: 1 };
  }
  if (directOnly) {
    return recommendDirectAction(input, playerId, rootActions, startedAt, weights);
  }

  const tree = new Map<string, SearchNode>();
  const rootNode = getSearchNode(tree, informationSetKey(input, playerId));
  initializeEdges(rootNode, input, playerId, rootActions, weights);
  let simulations = 0;
  while (simulations < maxIterations && monotonicNow() - startedAt < timeBudgetMs) {
    const random = createRandom(seed ^ Math.imul(simulations + 1, 0x9e3779b1));
    const game = determinizeGame(input, playerId, random);
    runInformationSetSimulation(game, tree, rolloutDepth, random, weights);
    simulations += 1;
  }

  const best = [...rootNode.edges.values()].sort((a, b) => {
    const winRateA = a.visits ? (a.winProbabilities[playerId] ?? 0) / a.visits : Number.NEGATIVE_INFINITY;
    const winRateB = b.visits ? (b.winProbabilities[playerId] ?? 0) / b.visits : Number.NEGATIVE_INFINITY;
    const averageA = a.visits ? (a.values[playerId] ?? 0) / a.visits : Number.NEGATIVE_INFINITY;
    const averageB = b.visits ? (b.values[playerId] ?? 0) / b.visits : Number.NEGATIVE_INFINITY;
    return winRateB - winRateA || averageB - averageA || b.visits - a.visits || actionKey(a.action).localeCompare(actionKey(b.action));
  })[0];
  return {
    action: best.action,
    simulations,
    elapsedMs: monotonicNow() - startedAt,
    depth: rolloutDepth,
    winProbability: best.visits ? (best.winProbabilities[playerId] ?? 0) / best.visits : undefined,
  };
}

function recommendDirectAction(
  game: GameState,
  playerId: string,
  actions: ActionIntent[],
  startedAt: number,
  weights: AdvancedAiMultipliers,
): AdvancedAiRecommendation {
  const best = actions
    .map((action) => ({ action, score: tacticalActionScore(game, playerId, action, weights) }))
    .sort((a, b) => b.score - a.score || actionKey(a.action).localeCompare(actionKey(b.action)))[0];
  return {
    action: best.action,
    simulations: 0,
    elapsedMs: monotonicNow() - startedAt,
    depth: 0,
  };
}

function recommendOpeningExchangeDirect(game: GameState, playerId: string, weights: AdvancedAiMultipliers): ActionIntent {
  const player = game.players.find((item) => item.id === playerId);
  if (!player) throw new Error("玩家不存在");
  const candidates = openingCandidates(player, weights);
  if (candidates.length === 0) return { type: "opening-exchange", discard: [] };
  const currentUtility = handUtility(player.hand, weights);
  const best = candidates
    .map((discard) => ({
      discard,
      score: currentUtility - discardPriority(discard, player.hand, weights),
    }))
    .sort((a, b) => b.score - a.score || a.discard.length - b.discard.length || a.discard.join(",").localeCompare(b.discard.join(",")))[0];
  return { type: "opening-exchange", discard: best.discard };
}

function runInformationSetSimulation(
  input: GameState,
  tree: Map<string, SearchNode>,
  depth: number,
  random: () => number,
  weights: AdvancedAiMultipliers,
): void {
  let game = input;
  const path: Array<{ node: SearchNode; edge: SearchEdge }> = [];
  let expanded = false;
  let ply = 0;

  while (ply < depth && game.status === "playing") {
    const actor = currentPlayer(game);
    const actions = enumerateActions(game, actor.id);
    if (actions.length === 0) break;
    const node = getSearchNode(tree, informationSetKey(game, actor.id));
    const wasExpanded = initializeEdges(node, game, actor.id, actions, weights);
    const edge = selectTreeEdge(node, actor.id, wasExpanded, random, ply === 0);
    path.push({ node, edge });
    const result = applyAction(game, actor.id, edge.action, "normal");
    if (!result.ok) break;
    game = result.game;
    ply += 1;
    if (edge.visits === 0) {
      expanded = true;
      break;
    }
  }

  if (expanded && ply < depth && game.status === "playing") {
    game = rolloutState(game, depth - ply, random, weights);
  }
  const utilities = Object.fromEntries(game.players.map((player) => [player.id, stateUtility(game, player.id, ply, weights)]));
  const winProbabilities = stateWinProbabilities(game, utilities);
  for (const { node, edge } of path) {
    node.visits += 1;
    edge.visits += 1;
    for (const [playerId, utility] of Object.entries(utilities)) {
      edge.values[playerId] = (edge.values[playerId] ?? 0) + utility;
      edge.winProbabilities[playerId] = (edge.winProbabilities[playerId] ?? 0) + (winProbabilities[playerId] ?? 0);
    }
  }
}

function getSearchNode(tree: Map<string, SearchNode>, key: string): SearchNode {
  let node = tree.get(key);
  if (!node) {
    node = { visits: 0, edges: new Map() };
    tree.set(key, node);
  }
  return node;
}

function initializeEdges(
  node: SearchNode,
  game: GameState,
  actorId: string,
  actions: ActionIntent[],
  weights: AdvancedAiMultipliers,
): boolean {
  let added = false;
  const rawPriors = actions.map((action) => Math.max(1, tacticalActionScore(game, actorId, action, weights) + 2_500));
  const priorTotal = rawPriors.reduce((sum, value) => sum + value, 0);
  actions.forEach((action, index) => {
    const key = actionKey(action);
    if (node.edges.has(key)) return;
    node.edges.set(key, {
      action,
      visits: 0,
      values: {},
      winProbabilities: {},
      prior: rawPriors[index] / priorTotal,
    });
    added = true;
  });
  return added;
}

function selectTreeEdge(
  node: SearchNode,
  actorId: string,
  newlyExpanded: boolean,
  random: () => number,
  forceAll: boolean,
): SearchEdge {
  const edges = [...node.edges.values()];
  const progressiveLimit = Math.min(edges.length, Math.max(2, 2 + Math.floor(Math.sqrt(node.visits + 1))));
  const candidates = edges
    .sort((a, b) => b.prior - a.prior || actionKey(a.action).localeCompare(actionKey(b.action)))
    .slice(0, forceAll || (newlyExpanded && node.visits === 0) ? edges.length : progressiveLimit);
  const unvisited = candidates.filter((edge) => edge.visits === 0);
  if (unvisited.length > 0) return unvisited[Math.floor(random() * unvisited.length)];
  const exploration = 1.35;
  return candidates.sort((a, b) => {
    const averageA = (a.winProbabilities[actorId] ?? 0) / a.visits;
    const averageB = (b.winProbabilities[actorId] ?? 0) / b.visits;
    const puctA = averageA + exploration * a.prior * Math.sqrt(node.visits + 1) / (1 + a.visits);
    const puctB = averageB + exploration * b.prior * Math.sqrt(node.visits + 1) / (1 + b.visits);
    return puctB - puctA;
  })[0];
}

function informationSetKey(game: GameState, actorId: string): string {
  const actor = game.players.find((player) => player.id === actorId);
  return JSON.stringify({
    status: game.status,
    actorId,
    actorHand: [...(actor?.hand ?? [])].sort(),
    handCounts: game.players.map((player) => player.hand.length),
    currentPlayer: currentPlayer(game).id,
    direction: game.direction,
    actionPoints: game.actionPoints,
    solution: game.zones.solution,
    products: game.zones.products.map((product) => ({
      id: product.id,
      kind: product.kind,
      cards: product.cards,
      radiationLeft: product.radiationLeft,
    })),
    discard: countCards(game.zones.discard),
    drawPileCount: game.zones.drawPile.length,
    pendingDraw: game.pendingDraw
      ? {
          sourceSeat: game.pendingDraw.sourceSeat,
          targetSeat: game.pendingDraw.targetSeat,
          remaining: game.pendingDraw.remaining,
          perPlayerCap: game.pendingDraw.perPlayerCap,
          functionCard: game.pendingDraw.functionCard,
        }
      : undefined,
    pendingChoice: game.pendingChoice,
    scoring: game.scoring
      ? {
          multiplier: game.scoring.multiplier,
          total: game.scoring.total,
          pendingByPlayerId: game.scoring.pendingByPlayerId,
        }
      : undefined,
  });
}

function recommendOpeningExchange(
  game: GameState,
  playerId: string,
  seed: number,
  timeBudgetMs: number,
  maxIterations: number,
  startedAt: number,
  weights: AdvancedAiMultipliers,
): ActionIntent {
  const player = game.players.find((item) => item.id === playerId);
  if (!player) throw new Error("玩家不存在");
  const candidates = openingCandidates(player, weights);
  if (candidates.length === 0) return { type: "opening-exchange", discard: [] };
  const remainingDeck = unknownDeck(game, playerId);
  let sample = 0;
  const totals = candidates.map(() => 0);
  const visits = candidates.map(() => 0);

  while (sample < maxIterations && monotonicNow() - startedAt < Math.min(timeBudgetMs, 2_500)) {
    const index = sample % candidates.length;
    const random = createRandom(seed ^ Math.imul(sample + 1, 0x85ebca6b));
    const drawPool = shuffleCopy(remainingDeck, random);
    const discard = candidates[index];
    const nextHand = removeCards([...player.hand], discard);
    nextHand.push(...drawPool.slice(0, discard.length));
    totals[index] += handUtility(nextHand, weights);
    visits[index] += 1;
    sample += 1;
  }

  const bestIndex = candidates
    .map((discard, index) => ({
      discard,
      score: visits[index] ? totals[index] / visits[index] : handUtility(removeCards([...player.hand], discard), weights),
    }))
    .sort((a, b) => b.score - a.score || a.discard.length - b.discard.length || a.discard.join(",").localeCompare(b.discard.join(",")))[0];
  return { type: "opening-exchange", discard: bestIndex.discard };
}

function openingSampleCount(game: GameState, playerId: string, maximum: number): number {
  const player = game.players.find((item) => item.id === playerId);
  return player ? Math.min(maximum, openingCandidates(player, getAdvancedAiMultipliers(game.players.length)).length * 32) : 0;
}

function openingCandidates(player: PlayerState, weights: AdvancedAiMultipliers): CardId[][] {
  const minimum = clamp(player.openingExchangeMin ?? 0, 0, player.hand.length);
  const maximum = clamp(player.openingExchangeMax ?? Math.min(3, player.hand.length), minimum, player.hand.length);
  const counts = countCards(player.hand);
  let candidates: CardId[][] = [[]];
  for (const [card, count] of Object.entries(counts)) {
    const next: CardId[][] = [];
    for (const candidate of candidates) {
      for (let amount = 0; amount <= Math.min(count, maximum - candidate.length); amount++) {
        next.push([...candidate, ...Array<CardId>(amount).fill(card)]);
      }
    }
    candidates = next
      .filter((candidate) => candidate.length <= maximum)
      .sort((a, b) => discardPriority(b, player.hand, weights) - discardPriority(a, player.hand, weights))
      .slice(0, 192);
  }
  return candidates.filter((candidate) => candidate.length >= minimum && candidate.length <= maximum);
}

function discardPriority(discard: CardId[], hand: CardId[], weights: AdvancedAiMultipliers): number {
  return handUtility(hand, weights) - handUtility(removeCards([...hand], discard), weights);
}

function rolloutState(game: GameState, depth: number, random: () => number, weights: AdvancedAiMultipliers): GameState {
  let state = game;
  let ply = 0;
  while (ply < depth && state.status === "playing") {
    const actor = currentPlayer(state);
    const actions = enumerateActions(state, actor.id);
    if (actions.length === 0) break;
    const action = chooseRolloutAction(state, actor.id, actions, random, weights);
    const result = applyAction(state, actor.id, action, "normal");
    if (!result.ok) break;
    state = result.game;
    ply += 1;
  }
  return state;
}

function chooseRolloutAction(
  game: GameState,
  actorId: string,
  actions: ActionIntent[],
  random: () => number,
  weights: AdvancedAiMultipliers,
): ActionIntent {
  if (actions.length === 1) return actions[0];
  const ranked = actions
    .map((action) => ({ action, score: tacticalActionScore(game, actorId, action, weights) }))
    .sort((a, b) => b.score - a.score);
  if (random() < 0.12) return ranked[Math.floor(random() * Math.min(4, ranked.length))].action;
  return ranked[0].action;
}

function tacticalActionScore(
  game: GameState,
  actorId: string,
  action: ActionIntent,
  weights: AdvancedAiMultipliers,
): number {
  const actor = game.players.find((player) => player.id === actorId);
  if (!actor) return -10_000;
  let score = cardsSpent(action) * 170 * weights.spent;
  const threats = threatProfile(game, actor);

  if (action.type === "play-ion") {
    const reaction = action.targetId
      ? findReactionTargets(game, action.card, action.count).find((target) => target.id === action.targetId)
      : undefined;
    score += (reaction?.score ?? 0) * 320 * weights.reaction;
    if (reaction?.source === "product") score += (threats.anyOpponentThreat ? 260 : 90) * weights.product;
  }
  if (action.type === "resolve-impurity" && game.pendingChoice?.kind === "impurity-reaction") {
    const reaction = findReactionTargets(game, game.pendingChoice.card, 1).find(
      (target) => target.id === action.targetId,
    );
    score += (reaction?.score ?? 0) * 260 * weights.reaction;
  }
  if (action.type === "resolve-enough") score += action.count * 190 * weights.spent;
  if (action.type === "accept-draw") score -= (600 + (game.pendingDraw?.remaining ?? 0) * 90) * weights.drawPenalty;
  if (action.type === "follow-function") {
    score += threats.duel
      ? (threats.nextThreat ? 1_300 : 480) * weights.response
      : threats.nextThreat
        ? 1_080 * weights.response
        : threats.nextNextThreat
          ? 560 * weights.response
          : 480 * weights.response;
  }
  if (action.type === "counter-draw") {
    score += (threats.anyOpponentThreat ? (threats.duel ? 1_200 : 1_020) : 520) * weights.response;
  }
  if (action.type === "wang-zha") score += (threats.anyOpponentThreat ? (threats.duel ? 960 : 820) : 180) * weights.response;
  if (action.type === "play-function") {
    if (action.card === "Ban") score += weightedPreventionBonus(banThreatBonus(threats), threats, weights.prevention);
    if (action.card === "Reverse") score += weightedPreventionBonus(reverseThreatBonus(threats), threats, weights.prevention);
    if (action.card === "StrongAcid" || action.card === "StrongBase") {
      score += (threats.anyOpponentThreat ? 900 : 300) * weights.strong;
    }
    if (action.card === "AddSodium") score += (threats.anyOpponentThreat ? -350 : 220) * weights.addSodium;
  }
  if (action.type === "pass") {
    score -= 400 * weights.pass;
    if (threats.anyOpponentThreat && (game.scoring?.total ?? 0) > 0) score += 250 * weights.pass;
  }
  return score;
}

type ThreatProfile = {
  duel: boolean;
  nextThreat: boolean;
  nextNextThreat: boolean;
  previousThreat: boolean;
  anyOpponentThreat: boolean;
};

export function seatAtOffset(game: GameState, fromSeat: number, offset: number): PlayerState {
  const length = game.players.length;
  const index = ((fromSeat + offset * game.direction) % length + length) % length;
  return game.players[index];
}

function threatProfile(game: GameState, actor: PlayerState): ThreatProfile {
  const opponents = game.players.filter((player) => player.id !== actor.id);
  const duel = opponents.length === 1;
  const next = opponents.length > 0 ? seatAtOffset(game, actor.seat, 1) : undefined;
  const nextNext = game.players.length > 2 ? seatAtOffset(game, actor.seat, 2) : undefined;
  const previous = game.players.length > 2 ? seatAtOffset(game, actor.seat, -1) : duel ? next : undefined;
  return {
    duel,
    nextThreat: Boolean(next && next.id !== actor.id && next.hand.length <= 2),
    nextNextThreat: Boolean(nextNext && nextNext.id !== actor.id && nextNext.hand.length <= 2),
    previousThreat: Boolean(previous && previous.id !== actor.id && previous.hand.length <= 2),
    anyOpponentThreat: opponents.some((player) => player.hand.length <= 2),
  };
}

// Keep these bonuses in the same rough range as the previous ~1500 prior so search
// still dominates, while seat order meaningfully reshapes Ban / Reverse preferences.
function weightedPreventionBonus(bonus: number, threats: ThreatProfile, weight: number): number {
  if (!threats.duel || !threats.nextThreat) return bonus * weight;
  const emergencyFloor = 1_320;
  return emergencyFloor + (bonus - emergencyFloor) * weight;
}

function banThreatBonus(threats: ThreatProfile): number {
  if (threats.duel) return threats.nextThreat ? 1_500 : 180;
  let bonus = 180;
  if (threats.nextThreat) bonus += 1_260;
  if (threats.nextNextThreat) bonus -= 1_050;
  if (threats.previousThreat) bonus -= 90;
  if (!threats.nextThreat && threats.anyOpponentThreat) bonus += 40;
  return bonus;
}

function reverseThreatBonus(threats: ThreatProfile): number {
  if (threats.duel) return threats.nextThreat ? 1_500 : 180;
  let bonus = 180;
  if (threats.nextThreat) bonus += 1_220;
  if (threats.previousThreat) bonus -= 1_120;
  if (threats.nextNextThreat) bonus += 140;
  return bonus;
}

function stateUtility(game: GameState, rootPlayerId: string, ply: number, weights: AdvancedAiMultipliers): number {
  const root = game.players.find((player) => player.id === rootPlayerId);
  if (!root) return -2_000_000;
  if (game.status === "ended") {
    const scoreRisk = game.scoring?.total ?? 0;
    return game.winnerId === rootPlayerId
      ? 2_000_000 - ply * 2_000 + scoreRisk * 30 * weights.stateScoringRisk
      : -2_000_000 - scoreRisk * 55 * weights.stateScoringRisk + ply * 500;
  }

  const opponents = game.players.filter((player) => player.id !== rootPlayerId);
  const averageOpponentHand = opponents.reduce((sum, player) => sum + player.hand.length, 0) / Math.max(1, opponents.length);
  const minimumOpponentHand = Math.min(...opponents.map((player) => player.hand.length));
  const imminentThreat = game.players.length > 2 && minimumOpponentHand <= 2;
  let utility = (averageOpponentHand - root.hand.length) * 420 * weights.stateHandDelta;
  utility += handUtility(root.hand, weights) * 0.8 * weights.stateHandShape;
  utility -= imminentThreat ? (3 - minimumOpponentHand) * 2_400 * weights.stateThreat : 0;
  utility -= (game.scoring?.total ?? 0) * (imminentThreat ? 24 : 5) * weights.stateScoringRisk;
  if (currentPlayer(game).id === rootPlayerId) utility += 120;
  if (game.pendingDraw?.targetSeat === root.seat) utility -= game.pendingDraw.remaining * 160 * weights.drawPenalty;
  return utility;
}

function stateWinProbabilities(game: GameState, utilities: Record<string, number>): Record<string, number> {
  if (game.status === "ended") {
    return Object.fromEntries(game.players.map((player) => [player.id, player.id === game.winnerId ? 1 : 0]));
  }
  const scaled = game.players.map((player) => ({
    id: player.id,
    value: clamp((utilities[player.id] ?? 0) / 2_600, -12, 12),
  }));
  const maximum = Math.max(...scaled.map((entry) => entry.value));
  const weights = scaled.map((entry) => ({ id: entry.id, value: Math.exp(entry.value - maximum) }));
  const total = weights.reduce((sum, entry) => sum + entry.value, 0) || 1;
  return Object.fromEntries(weights.map((entry) => [entry.id, entry.value / total]));
}

function handUtility(hand: CardId[], weights: AdvancedAiMultipliers): number {
  const counts = countCards(hand);
  let value = -hand.length * 210 * weights.handShape;
  for (const [card, count] of Object.entries(counts)) {
    if (isIon(card)) value += Math.min(count, 3) * 24 * weights.handShape;
    else if (isSpecial(card)) value += (card === "U" ? 90 : 55) * weights.handShape;
    else if (isFunction(card)) value += 80 * weights.handShape;
  }
  value += Math.min(counts.Acid ?? 0, counts.Alkali ?? 0) * 260 * weights.handShape;
  value += (counts.AddSodium ?? 0) * 90 * weights.addSodium;
  value += (counts.Ban ?? 0) * 75 * weights.prevention;
  value += (counts.Reverse ?? 0) * 50 * weights.prevention;
  return value;
}

function determinizeGame(input: GameState, viewerId: string, random: () => number): GameState {
  const game = structuredClone(input);
  game.log = [];
  game.eventLog = [];
  game.turnDeadlineAt = undefined;
  const pool = shuffleCopy(unknownDeck(game, viewerId), random);
  let cursor = 0;
  for (const player of game.players) {
    if (player.id === viewerId) continue;
    player.hand = player.hand.map(() => pool[cursor++] ?? fallbackCard());
  }
  game.zones.drawPile = game.zones.drawPile.map(() => pool[cursor++] ?? fallbackCard());
  return game;
}

function unknownDeck(game: GameState, viewerId: string): CardId[] {
  const remaining = new Map<CardId, number>(Object.values(CARDS).map((card) => [card.id, card.count]));
  const knownCards = [
    ...game.zones.solution,
    ...game.zones.discard,
    ...game.zones.products.flatMap((product) => product.cards),
    ...game.players.flatMap((player) => (player.id === viewerId ? player.hand.filter((card) => card !== "__hidden__") : [])),
  ];
  for (const card of knownCards) {
    const count = remaining.get(card);
    if (count !== undefined) remaining.set(card, Math.max(0, count - 1));
  }
  return [...remaining.entries()].flatMap(([card, count]) => Array<CardId>(count).fill(card));
}

function cardsSpent(action: ActionIntent): number {
  if (action.type === "play-ion" || action.type === "resolve-enough") return action.count;
  if (action.type === "wang-zha" || (action.type === "counter-draw" && action.method === "WangZha")) return 2;
  if (
    action.type === "play-special" ||
    action.type === "play-function" ||
    action.type === "follow-function" ||
    action.type === "counter-draw"
  ) {
    return 1;
  }
  return 0;
}

function countCards(cards: CardId[]): Record<CardId, number> {
  return cards.reduce<Record<CardId, number>>((counts, card) => {
    if (card !== "__hidden__") counts[card] = (counts[card] ?? 0) + 1;
    return counts;
  }, {});
}

function removeCards(hand: CardId[], discard: CardId[]): CardId[] {
  for (const card of discard) {
    const index = hand.indexOf(card);
    if (index >= 0) hand.splice(index, 1);
  }
  return hand;
}

function shuffleCopy<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function createRandom(seed: number): () => number {
  let value = seed || 0x6d2b79f5;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function actionKey(action: ActionIntent): string {
  return JSON.stringify(action);
}

function fallbackCard(): CardId {
  return Object.keys(CARDS)[0];
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export const advancedAiTestHelpers = {
  seatAtOffset,
  tacticalActionScore,
  unknownDeck,
};
