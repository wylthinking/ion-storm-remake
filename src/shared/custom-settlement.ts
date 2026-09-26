export interface CustomSettlementResult {
  amountPerLoser: number;
  winnerGrossPoints: number;
  capScale: number;
}

/**
 * 自定义模式按开房者额度限制每名输家的扣分；赢家获得全部实际扣分，始终保持零和。
 * `creatorLoserCap` 为 null/undefined 时表示不限制。
 */
export function calculateCustomSettlement(
  rawAmountPerLoser: number,
  loserCount: number,
  creatorLoserCap: number | null | undefined,
): CustomSettlementResult {
  const raw = Math.max(0, Math.floor(Number.isFinite(rawAmountPerLoser) ? rawAmountPerLoser : 0));
  const count = Math.max(0, Math.floor(Number.isFinite(loserCount) ? loserCount : 0));
  const cap = creatorLoserCap === null || creatorLoserCap === undefined
    ? null
    : Math.max(0, Math.floor(Number.isFinite(creatorLoserCap) ? creatorLoserCap : 0));
  const amountPerLoser = cap === null ? raw : Math.min(raw, cap);
  return {
    amountPerLoser,
    winnerGrossPoints: amountPerLoser * count,
    capScale: raw > 0 ? amountPerLoser / raw : 1,
  };
}
