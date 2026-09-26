import type { UserRole } from "./types.js";

export interface LeaderboardSource {
  id: string;
  nickname: string;
  nicknameColor: string;
  username: string;
  points: number;
  gamesWon: number;
  gamesPlayed: number;
  role: UserRole;
  createdAt: number;
  excluded?: boolean;
}

export interface LeaderboardEntry {
  id: string;
  nickname: string;
  nicknameColor: string;
  username: string;
  points: number;
  gamesWon: number;
  gamesPlayed: number;
  rank: number;
  winRate: number;
}

export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  current?: LeaderboardEntry;
  totalUsers: number;
  totalPoints: number;
}

export function buildLeaderboard(sources: LeaderboardSource[], currentUserId: string, limit = 100): LeaderboardResult {
  const totalPoints = sources.reduce((sum, source) => sum + source.points, 0);
  const sorted = sources
    .filter((source) => !source.excluded && (source.points !== 0 || source.gamesPlayed !== 0 || source.gamesWon !== 0))
    .sort(
      (left, right) =>
        right.points - left.points ||
        winRate(right) - winRate(left) ||
        right.gamesPlayed - left.gamesPlayed ||
        rolePriority(right.role) - rolePriority(left.role) ||
        left.createdAt - right.createdAt ||
        left.username.localeCompare(right.username, "zh-Hans-CN") ||
        left.id.localeCompare(right.id),
    );
  let previousPoints: number | undefined;
  let currentRank = 0;
  const ranked = sorted.map<LeaderboardEntry>((source, index) => {
    if (previousPoints === undefined || source.points !== previousPoints) currentRank = index + 1;
    previousPoints = source.points;
    return {
      id: source.id,
      nickname: source.nickname,
      nicknameColor: source.nicknameColor,
      username: source.username,
      points: source.points,
      gamesWon: source.gamesWon,
      gamesPlayed: source.gamesPlayed,
      rank: currentRank,
      winRate: winRate(source),
    };
  });
  const current = ranked.find((entry) => entry.id === currentUserId);
  return {
    entries: ranked.slice(0, limit),
    current,
    totalUsers: ranked.length,
    totalPoints,
  };
}

function winRate(source: Pick<LeaderboardSource, "gamesWon" | "gamesPlayed">): number {
  return source.gamesPlayed > 0 ? source.gamesWon / source.gamesPlayed : 0;
}

function rolePriority(role: UserRole): number {
  return {
    "super-admin": 5,
    "admin-advanced": 4,
    admin: 3,
    advanced: 2,
    normal: 1,
  }[role];
}
