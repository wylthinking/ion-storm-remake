export type CustomMaxBaseBetRule =
  | { mode: "absolute"; value: number }
  | { mode: "classic-multiple"; factor: number }
  | { mode: "unlimited" };

export type CustomSettlementCapRule =
  | { mode: "absolute"; value: number }
  | { mode: "base-bet-multiple"; factor: number }
  | { mode: "unlimited" };

export interface CustomModeLimits {
  maxBaseBet: CustomMaxBaseBetRule;
  settlementCap: CustomSettlementCapRule;
}

export type CustomModeLimitGrant = Partial<CustomModeLimits>;

export const CUSTOM_MAX_BASE_BET_MODES = ["absolute", "classic-multiple", "unlimited"] as const;
export const CUSTOM_SETTLEMENT_CAP_MODES = ["absolute", "base-bet-multiple", "unlimited"] as const;

export function defaultCustomMaxBaseBet(): CustomMaxBaseBetRule {
  return { mode: "classic-multiple", factor: 1 };
}

export function defaultCustomSettlementCap(): CustomSettlementCapRule {
  return { mode: "base-bet-multiple", factor: 1 };
}

export function defaultCustomModeLimits(): CustomModeLimits {
  return {
    maxBaseBet: defaultCustomMaxBaseBet(),
    settlementCap: defaultCustomSettlementCap(),
  };
}

export function unlimitedCustomMaxBaseBet(): CustomMaxBaseBetRule {
  return { mode: "unlimited" };
}

export function unlimitedCustomSettlementCap(): CustomSettlementCapRule {
  return { mode: "unlimited" };
}

function cleanFactor(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1000) {
    throw new Error(`${label}必须是 0-1000 之间的正数`);
  }
  return value;
}

function cleanAbsolute(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label}必须是非负整数`);
  }
  return value as number;
}

export function normalizeCustomMaxBaseBet(rule: CustomMaxBaseBetRule | undefined, fallback: CustomMaxBaseBetRule = defaultCustomMaxBaseBet()): CustomMaxBaseBetRule {
  if (rule === undefined || rule === null) return { ...fallback };
  if (rule.mode === "unlimited") return { mode: "unlimited" };
  if (rule.mode === "absolute") return { mode: "absolute", value: cleanAbsolute(rule.value, "自定义最大底注") };
  if (rule.mode === "classic-multiple") return { mode: "classic-multiple", factor: cleanFactor(rule.factor, "自定义最大底注倍率") };
  throw new Error("自定义最大底注限制方式不正确");
}

export function normalizeCustomSettlementCap(rule: CustomSettlementCapRule | undefined, fallback: CustomSettlementCapRule = defaultCustomSettlementCap()): CustomSettlementCapRule {
  if (rule === undefined || rule === null) return { ...fallback };
  if (rule.mode === "unlimited") return { mode: "unlimited" };
  if (rule.mode === "absolute") return { mode: "absolute", value: cleanAbsolute(rule.value, "自定义模式每名输家扣分上限") };
  if (rule.mode === "base-bet-multiple") return { mode: "base-bet-multiple", factor: cleanFactor(rule.factor, "自定义模式每名输家扣分上限倍率") };
  throw new Error("自定义模式每名输家扣分上限限制方式不正确");
}

export function normalizeCustomMaxBaseBetPatch(rule: CustomMaxBaseBetRule | undefined): CustomMaxBaseBetRule | undefined {
  return rule === undefined ? undefined : normalizeCustomMaxBaseBet(rule);
}

export function normalizeCustomSettlementCapPatch(rule: CustomSettlementCapRule | undefined): CustomSettlementCapRule | undefined {
  return rule === undefined ? undefined : normalizeCustomSettlementCap(rule);
}

export function normalizeCustomModeLimits(
  limits: CustomModeLimitGrant | undefined,
  fallback: CustomModeLimits = defaultCustomModeLimits(),
): CustomModeLimits {
  return {
    maxBaseBet: normalizeCustomMaxBaseBet(limits?.maxBaseBet, fallback.maxBaseBet),
    settlementCap: normalizeCustomSettlementCap(limits?.settlementCap, fallback.settlementCap),
  };
}

export function normalizeCustomModeLimitGrant(limits: CustomModeLimitGrant | undefined): CustomModeLimitGrant {
  const result: CustomModeLimitGrant = {};
  if (limits?.maxBaseBet !== undefined) result.maxBaseBet = normalizeCustomMaxBaseBet(limits.maxBaseBet);
  if (limits?.settlementCap !== undefined) result.settlementCap = normalizeCustomSettlementCap(limits.settlementCap);
  return result;
}

// 解析自定义底注上限：null 表示不限。classic-multiple 以经典非决斗 maxBaseBet 为基准；
// 经典 maxBaseBet=null（不限）时相对结果同样不限。
export function resolveCustomMaxBaseBet(rule: CustomMaxBaseBetRule, classicMaxBaseBet: number | null): number | null {
  if (rule.mode === "unlimited") return null;
  if (rule.mode === "absolute") return rule.value;
  if (classicMaxBaseBet === null) return null;
  return Math.max(0, Math.floor(classicMaxBaseBet * rule.factor));
}

// 解析开房者的“每名输家扣分上限”（绝对积分）：null 表示不限
export function resolveCustomSettlementCap(rule: CustomSettlementCapRule, baseBet: number): number | null {
  if (rule.mode === "unlimited") return null;
  if (rule.mode === "absolute") return rule.value;
  return Math.max(0, Math.floor(Math.max(0, baseBet) * rule.factor));
}

export function customMaxBaseBetSummary(rule: CustomMaxBaseBetRule): string {
  if (rule.mode === "unlimited") return "不限";
  if (rule.mode === "absolute") return `≤${rule.value}`;
  return `经典最大底注×${rule.factor}`;
}

export function customSettlementCapSummary(rule: CustomSettlementCapRule): string {
  if (rule.mode === "unlimited") return "不限";
  if (rule.mode === "absolute") return `≤${rule.value}`;
  return `底注×${rule.factor}`;
}

export function setupPlayersRange(players: number | [number, number] | undefined): [number, number] {
  if (Array.isArray(players) && players.length === 2) return [players[0], players[1]];
  if (typeof players === "number" && Number.isInteger(players)) return [players, players];
  return [2, 10];
}
