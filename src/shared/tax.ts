export const DEFAULT_TAX_RATE_PERCENT = 10;
export const DISABLE_TAX_RATE_PERCENT = -1;
export const MIN_TAX_RATE_PERCENT = -1;
export const MAX_TAX_RATE_PERCENT = 100;

export type TaxWinnerPointsThreshold = number | undefined;

export function cleanTaxRatePercent(value: unknown, label = "最低征税比例"): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) throw new Error(`${label}必须是整数`);
  if (numeric < MIN_TAX_RATE_PERCENT || numeric > MAX_TAX_RATE_PERCENT) {
    throw new Error(`${label}必须在 -1 到 100 之间`);
  }
  return numeric;
}

export function normalizeTaxRatePercent(value: unknown, fallback = DEFAULT_TAX_RATE_PERCENT): number {
  if (value === undefined || value === null || value === "") return cleanTaxRatePercent(fallback);
  return cleanTaxRatePercent(value);
}

export function cleanTaxWinnerPointsThreshold(value: unknown): TaxWinnerPointsThreshold {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) throw new Error("征税积分门槛必须是整数");
  return numeric;
}

export function normalizeTaxWinnerPointsThreshold(value: unknown, fallback?: number): TaxWinnerPointsThreshold {
  if (value === undefined) return fallback;
  return cleanTaxWinnerPointsThreshold(value);
}

export function winnerGrossPoints(amountPerLoser: number, humanAccountIds: string[], winnerAccountId?: string): number {
  if (!winnerAccountId) return 0;
  const cleanAmount = Math.max(0, Math.floor(Number(amountPerLoser ?? 0)));
  if (cleanAmount <= 0) return 0;
  const loserCount = [...new Set(humanAccountIds)].filter((id) => id && id !== winnerAccountId).length;
  return cleanAmount * loserCount;
}

export function calculateWinnerTax(
  rawTax: number,
  grossWinnerPoints: number,
  taxRatePercent: number,
  options: { winnerPointsBeforeSettlement?: number; taxWinnerPointsThreshold?: number } = {},
): number {
  const cleanRate = cleanTaxRatePercent(taxRatePercent);
  if (cleanRate === DISABLE_TAX_RATE_PERCENT) return 0;
  const cleanRawTax = Math.max(0, Math.floor(Number(rawTax ?? 0)));
  const cleanGross = Math.max(0, Math.floor(Number(grossWinnerPoints ?? 0)));
  if (cleanRawTax <= 0 || cleanGross <= 0) return 0;

  const threshold = cleanTaxWinnerPointsThreshold(options.taxWinnerPointsThreshold);
  if (threshold !== undefined) {
    const beforeSettlement = Math.floor(Number(options.winnerPointsBeforeSettlement ?? 0));
    const preTaxPoints = beforeSettlement + cleanGross;
    if (preTaxPoints <= threshold) return 0;
  }

  const cappedTax = Math.floor((cleanGross * cleanRate) / 100);
  return Math.max(0, Math.min(cleanRawTax, cappedTax));
}

export function winnerPreTaxPoints(pointsBeforeSettlement: unknown, grossWinnerPoints: number): number {
  return Math.floor(Number(pointsBeforeSettlement ?? 0)) + Math.max(0, Math.floor(Number(grossWinnerPoints ?? 0)));
}
