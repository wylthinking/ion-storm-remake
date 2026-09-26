import { OPENING_EXCHANGE_MS, TURN_MS, maxInitialHandSize, recommendedHandSize } from "./engine.js";
import { customDealHasAnyFill, customDealMinimumGlobalFill, customDeckForPlayerCount, customUniformDealTemplate, type CustomDeck, type CustomSetup } from "./custom-rules-types.js";

export const MIN_ROOM_TIME_LIMIT_SEC = 10;
export const MAX_ROOM_TIME_LIMIT_SEC = 600;
export const DEFAULT_TURN_TIME_LIMIT_SEC = TURN_MS / 1000;
export const DEFAULT_OPENING_EXCHANGE_SEC = OPENING_EXCHANGE_MS / 1000;

export function cleanRoomTimeLimitSec(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_ROOM_TIME_LIMIT_SEC || parsed > MAX_ROOM_TIME_LIMIT_SEC) {
    throw new Error(`${label}必须为 ${MIN_ROOM_TIME_LIMIT_SEC}-${MAX_ROOM_TIME_LIMIT_SEC} 的整数秒，留空则使用默认值`);
  }
  return parsed;
}

export function effectiveInitialHandSize(handSize: number | null | undefined, players: number): number {
  return handSize ?? recommendedHandSize(players);
}

export function totalDealtCards(capacity: number, handSize: number | null | undefined): number {
  return capacity * effectiveInitialHandSize(handSize, capacity);
}

export function normalMaxBaseBet(maximum: number, totalDealt: number): number {
  if (totalDealt < 101) return maximum;
  return Math.floor((maximum * ((131 - totalDealt) * 3 + 7)) / 100 + 1e-9);
}

// 经典两人决斗底注上限：M = 开房用户经典非决斗最大底注，h = 初始手牌。
// h=2..9 保持 100M；h=10..50 为 floor(M*(1125/h-12.5))（h=10→100M，h=50→10M）；
// h=50..65 为 floor(M*(40-0.6h))（h=50→10M，h=65→1M）；h>65 不允许。
export function duelMaxBaseBet(maximum: number, initialHandSize: number): number | null {
  if (initialHandSize > 65) return null;
  if (initialHandSize >= 50) return Math.floor(maximum * (40 - 0.6 * initialHandSize) + 1e-9);
  if (initialHandSize >= 10) return Math.floor(maximum * (1125 / initialHandSize - 12.5) + 1e-9);
  return maximum * 100;
}

export interface RoomBaseBetRuleInput {
  value: unknown;
  maximum: number | null;
  canCreateZeroBaseBet: boolean;
  allowDuel: boolean;
  capacity: number;
  initialHandSize?: number;
}

export function cleanRoomBaseBet(input: RoomBaseBetRuleInput): { baseBet: number; duel: boolean } {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 0) throw new Error("底注必须是非负整数");
  if (value === 0 && !input.canCreateZeroBaseBet) throw new Error("普通用户不能创建不结算积分房间");
  const maximum = input.maximum;
  if (maximum === null) return { baseBet: value, duel: false };
  if (value <= maximum) {
    const total = totalDealtCards(input.capacity, input.initialHandSize);
    const cap = normalMaxBaseBet(maximum, total);
    if (value > cap) throw new Error(`总发牌数达到 ${total} 张时底注不能超过 ${cap}`);
    return { baseBet: value, duel: false };
  }
  if (!input.allowDuel) throw new Error(`编辑房间底注不能超过该账号底注上限（${maximum}）`);
  const handSize = effectiveInitialHandSize(input.initialHandSize, 2);
  const cap = duelMaxBaseBet(maximum, handSize);
  if (cap === null) throw new Error("初始手牌数量超过 65 张时不能开设决斗模式房间");
  if (value > cap) throw new Error(`初始手牌 ${handSize} 张时决斗底注不能超过 ${cap}`);
  return { baseBet: value, duel: true };
}

export interface RoomConfigPermissionCheckInput {
  capacity: number;
  baseBet: number;
  initialHandSize?: number;
  duelMode?: boolean;
  maximum: number | null;
  canCreateZeroBaseBet: boolean;
}

export function checkRoomConfigAgainstPermissions(input: RoomConfigPermissionCheckInput): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(input.capacity) || input.capacity < 2 || input.capacity > 10) {
    problems.push(`人数 ${input.capacity} 不在 2-10 人之间`);
  }
  const capacity = Number.isInteger(input.capacity) ? Math.min(Math.max(input.capacity, 2), 10) : 2;
  if (input.initialHandSize !== undefined && input.initialHandSize !== null) {
    const maximum = maxInitialHandSize(capacity);
    if (!Number.isInteger(input.initialHandSize) || input.initialHandSize < 2 || input.initialHandSize > maximum) {
      problems.push(`初始手牌数 ${input.initialHandSize} 超出 2-${maximum} 张的允许范围`);
    }
  }
  const total = totalDealtCards(capacity, input.initialHandSize);
  if (total > 130) problems.push(`初始发牌总数 ${total} 张超过 130 张`);
  if (input.duelMode) {
    if (input.capacity !== 2) problems.push(`决斗模式房间人数必须为 2 人，当前为 ${input.capacity} 人`);
    if (input.maximum !== null && Number.isInteger(input.baseBet) && input.baseBet <= input.maximum) {
      problems.push(`底注 ${input.baseBet} 已不高于开房者当前底注上限（${input.maximum}），决斗模式房间已不符合条件，请先调整底注`);
    }
  }
  try {
    cleanRoomBaseBet({
      value: input.baseBet,
      maximum: input.maximum,
      canCreateZeroBaseBet: input.canCreateZeroBaseBet,
      allowDuel: input.duelMode === true,
      capacity,
      initialHandSize: input.initialHandSize,
    });
  } catch (error) {
    problems.push(`底注不在允许的范围内：${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}

export interface CustomRoomBaseBetInput {
  value: unknown;
  setupBaseBet?: number | [number, number];
  maximum: number | null;
  canCreateZeroBaseBet: boolean;
}

export function cleanCustomRoomBaseBet(input: CustomRoomBaseBetInput): number {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 0) throw new Error("底注必须是非负整数");
  const setup = input.setupBaseBet;
  if (typeof setup === "number" && value !== setup) throw new Error(`该自定义规则底注固定为 ${setup}`);
  if (Array.isArray(setup)) {
    const [min, max] = setup as [number, number];
    if (value < min || value > max) throw new Error(`该自定义规则底注必须在 ${min}-${max} 之间`);
  }
  if (value === 0) {
    if (!input.canCreateZeroBaseBet) throw new Error("当前账号不允许创建 0 底注房间");
    return 0;
  }
  if (input.maximum !== null && value > input.maximum) throw new Error(`自定义模式底注最大为 ${input.maximum}`);
  return value;
}

export function customInitialHandSizeMaximum(
  rules: { setup?: CustomSetup; deck?: CustomDeck },
  players: number,
): number {
  const active = customDeckForPlayerCount(rules, players);
  if (customUniformDealTemplate(rules)) {
    return Math.max(2, Math.floor(1000 / Math.max(1, players)));
  }
  const deckSize = Object.values(active.cards).reduce(
    (sum, count) => sum + (Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0),
    0,
  );
  return Math.max(2, Math.floor(deckSize / Math.max(1, players)));
}

export function cleanCustomInitialHandSize(
  value: unknown,
  rules: { setup?: CustomSetup; deck?: CustomDeck },
  players: number,
  _hasSeatDeal?: boolean,
): number | undefined {
  const deal = customDeckForPlayerCount(rules, players).deal;
  if (customDealHasAnyFill(deal)) return undefined;
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  const minimum = customDealMinimumGlobalFill(deal);
  const maximum = customInitialHandSizeMaximum(rules, players);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`自定义模式初始手牌必须为 ${minimum}-${maximum} 的整数，且不能小于固定发牌或席位补足数；留空则使用 JSON 默认值`);
  }
  return parsed;
}

export interface CustomRoomConfigPermissionCheckInput {
  capacity: number;
  baseBet: number;
  setupPlayers?: [number, number];
  setupBaseBet?: number | [number, number];
  requiredPlayers?: number | null;
  initialHandSize?: number;
  rules?: { deck?: CustomDeck; setup?: CustomSetup };
  maximum: number | null;
  canCreateZeroBaseBet: boolean;
}

export function checkCustomRoomConfigAgainstPermissions(input: CustomRoomConfigPermissionCheckInput): string[] {
  const problems: string[] = [];
  const [minPlayers, maxPlayers] = input.setupPlayers ?? [2, 10];
  if (!Number.isInteger(input.capacity) || input.capacity < minPlayers || input.capacity > maxPlayers) {
    problems.push(`人数 ${input.capacity} 不在规则允许的 ${minPlayers}-${maxPlayers} 人之间`);
  }
  if (input.requiredPlayers !== undefined && input.requiredPlayers !== null && input.capacity !== input.requiredPlayers) {
    problems.push(`该规则按 ${input.requiredPlayers} 个座位规定了初始发牌，房间人数必须为 ${input.requiredPlayers} 人`);
  }
  if (input.rules) {
    try {
      cleanCustomInitialHandSize(
        input.initialHandSize,
        input.rules,
        Number.isInteger(input.capacity) ? input.capacity : 1,
        input.requiredPlayers !== undefined && input.requiredPlayers !== null,
      );
    } catch (error) {
      problems.push(`初始手牌不在允许的范围内：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    cleanCustomRoomBaseBet({
      value: input.baseBet,
      setupBaseBet: input.setupBaseBet,
      maximum: input.maximum,
      canCreateZeroBaseBet: input.canCreateZeroBaseBet,
    });
  } catch (error) {
    problems.push(`底注不在允许的范围内：${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}
