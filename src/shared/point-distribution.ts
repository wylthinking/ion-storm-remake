export function randomPointRewardUpperBound(remainingPoints: number, remainingUses: number): number {
  if (!Number.isInteger(remainingPoints) || !Number.isInteger(remainingUses) || remainingPoints < remainingUses || remainingUses <= 1) {
    throw new Error("Random point reward bounds require at least two funded redemptions");
  }
  const doubledRemainingAverage = Math.floor((remainingPoints / remainingUses) * 2);
  const maximumAfterReservingOnePerLaterUse = remainingPoints - remainingUses + 1;
  return Math.max(1, Math.min(doubledRemainingAverage, maximumAfterReservingOnePerLaterUse));
}
