import type { PlayerState } from "./types.js";

/** Returns the first player in the fixed seat order. */
export function firstBankerPlayerId(players: Pick<PlayerState, "id" | "seat">[]): string | undefined {
  return [...players].sort((a, b) => a.seat - b.seat)[0]?.id;
}

/** Finds the next banker without consulting the game's direction. */
export function nextBankerPlayerId(
  players: Pick<PlayerState, "id" | "seat">[],
  currentBankerId: string | undefined,
  availableIds: ReadonlySet<string> = new Set(players.map((player) => player.id)),
): string | undefined {
  const ordered = [...players].sort((a, b) => a.seat - b.seat);
  if (ordered.length === 0) return undefined;
  const currentIndex = ordered.findIndex((player) => player.id === currentBankerId);
  const baseIndex = currentIndex >= 0 ? currentIndex : ordered.length - 1;
  for (let offset = 1; offset <= ordered.length; offset += 1) {
    const candidate = ordered[(baseIndex + offset) % ordered.length];
    if (candidate && availableIds.has(candidate.id)) return candidate.id;
  }
  return ordered.find((player) => availableIds.has(player.id))?.id;
}

export function ensureBankerPlayerId(
  players: Pick<PlayerState, "id" | "seat">[],
  bankerId: string | undefined,
): string | undefined {
  if (bankerId && players.some((player) => player.id === bankerId)) return bankerId;
  return firstBankerPlayerId(players);
}
