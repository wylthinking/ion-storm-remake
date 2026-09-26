import type { AnyGameState } from "./types.js";

export function currentGameLogMultiplier(game: AnyGameState): number {
  const scoring = game.scoring;
  if (game.mode === "online" && scoring) {
    const openingScale = scoring.baseBet * Math.pow(2, scoring.openingDoublePlayerIds?.length ?? 0);
    if (openingScale > 0 && Number.isFinite(scoring.total)) return cleanMultiplier(scoring.total / openingScale);
  }
  return cleanMultiplier(game.logScoreMultiplier ?? 1);
}

export function addGameLogMultiplier(game: AnyGameState, amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  game.logScoreMultiplier = cleanMultiplier((game.logScoreMultiplier ?? 1) + amount);
}

export function multiplyGameLogMultiplier(game: AnyGameState, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  game.logScoreMultiplier = cleanMultiplier((game.logScoreMultiplier ?? 1) * factor);
}

export function formatGameLogMultiplier(value: number | undefined): string {
  const clean = cleanMultiplier(value ?? 1);
  return Number.isInteger(clean) ? String(clean) : String(Number(clean.toFixed(8)));
}

function cleanMultiplier(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}
