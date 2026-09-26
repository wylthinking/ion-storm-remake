import { ADVANCED_AI_TUNING_PAYLOAD } from "./advanced-ai-weights.generated.js";

export const ADVANCED_AI_WEIGHT_KEYS = [
  "spent",
  "reaction",
  "product",
  "drawPenalty",
  "response",
  "prevention",
  "strong",
  "addSodium",
  "pass",
  "stateHandDelta",
  "stateThreat",
  "stateHandShape",
  "stateScoringRisk",
  "handShape",
] as const;

export type AdvancedAiWeightKey = (typeof ADVANCED_AI_WEIGHT_KEYS)[number];
export type AdvancedAiMultipliers = Record<AdvancedAiWeightKey, number>;
export type AdvancedAiWeightMode = "none" | "low" | "medium" | "high" | "xhigh";

type AdvancedAiWeightEntry = {
  multipliers: unknown;
};

export const DEFAULT_ADVANCED_AI_MULTIPLIERS: AdvancedAiMultipliers = Object.fromEntries(
  ADVANCED_AI_WEIGHT_KEYS.map((key) => [key, 1]),
) as AdvancedAiMultipliers;

export function getAdvancedAiMultipliers(
  playerCount: number,
  mode: AdvancedAiWeightMode = "medium",
): AdvancedAiMultipliers {
  if (!Number.isFinite(playerCount)) return DEFAULT_ADVANCED_AI_MULTIPLIERS;

  const byPlayerCount = getSafeByPlayerCount(mode);
  const entry = findPlayerCountEntry(byPlayerCount, playerCount);
  if (entry) return mergeAdvancedAiMultipliers(entry.multipliers);

  // none 专用参数还没训练/同步时，回退到原 byPlayerCount，避免新增 none 模式后直接退化为全 1。
  if (mode === "none") {
    const legacyEntry = findPlayerCountEntry(getSafeLegacyByPlayerCount(), playerCount);
    if (legacyEntry) return mergeAdvancedAiMultipliers(legacyEntry.multipliers);
  }

  return DEFAULT_ADVANCED_AI_MULTIPLIERS;
}

export function mergeAdvancedAiMultipliers(input: unknown): AdvancedAiMultipliers {
  const output: AdvancedAiMultipliers = { ...DEFAULT_ADVANCED_AI_MULTIPLIERS };
  if (!input || typeof input !== "object" || Array.isArray(input)) return output;

  const record = input as Record<string, unknown>;
  for (const key of ADVANCED_AI_WEIGHT_KEYS) {
    const value = record[key];
    output[key] = normalizeMultiplier(value);
  }
  return output;
}

function findPlayerCountEntry(byPlayerCount: unknown, playerCount: number): AdvancedAiWeightEntry | null {
  const normalizedPlayerCount = Math.floor(playerCount);

  if (normalizedPlayerCount === 2) {
    return getEntry(byPlayerCount, 2);
  }

  if (normalizedPlayerCount >= 3) {
    const exactEntry = getEntry(byPlayerCount, normalizedPlayerCount);
    if (exactEntry) return exactEntry;
    return findHighestMultiplayerEntry(byPlayerCount);
  }

  return null;
}

function getSafeByPlayerCount(mode: AdvancedAiWeightMode): unknown {
  if (mode === "none") return getSafeModeByPlayerCount("none");
  return getSafeLegacyByPlayerCount();
}

function getSafeLegacyByPlayerCount(): unknown {
  const payload = ADVANCED_AI_TUNING_PAYLOAD as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return (payload as { byPlayerCount?: unknown }).byPlayerCount ?? null;
}

function getSafeModeByPlayerCount(mode: AdvancedAiWeightMode): unknown {
  const payload = ADVANCED_AI_TUNING_PAYLOAD as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const byMode = (payload as { byMode?: unknown }).byMode;
  if (!byMode || typeof byMode !== "object" || Array.isArray(byMode)) return null;
  const modeEntry = (byMode as Record<string, unknown>)[mode];
  if (!modeEntry || typeof modeEntry !== "object" || Array.isArray(modeEntry)) return null;
  return (modeEntry as { byPlayerCount?: unknown }).byPlayerCount ?? null;
}

function getEntry(byPlayerCount: unknown, playerCount: number): AdvancedAiWeightEntry | null {
  if (!byPlayerCount || typeof byPlayerCount !== "object" || Array.isArray(byPlayerCount)) return null;
  const raw = (byPlayerCount as Record<string, unknown>)[String(playerCount)];
  return normalizeEntry(raw);
}

function findHighestMultiplayerEntry(byPlayerCount: unknown): AdvancedAiWeightEntry | null {
  if (!byPlayerCount || typeof byPlayerCount !== "object" || Array.isArray(byPlayerCount)) return null;

  let bestCount = -1;
  let bestEntry: AdvancedAiWeightEntry | null = null;

  for (const [key, value] of Object.entries(byPlayerCount as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue;
    const count = Number.parseInt(key, 10);
    if (!Number.isInteger(count) || count < 3) continue;

    const entry = normalizeEntry(value);
    if (!entry) continue;

    if (count > bestCount) {
      bestCount = count;
      bestEntry = entry;
    }
  }

  return bestEntry;
}

function normalizeEntry(value: unknown): AdvancedAiWeightEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const multipliers = (value as { multipliers?: unknown }).multipliers;
  if (!multipliers || typeof multipliers !== "object" || Array.isArray(multipliers)) return null;
  return { multipliers };
}

function normalizeMultiplier(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return clamp(numeric, 0.05, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
