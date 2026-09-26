import { LABELS, cardText } from "./cards.js";
import type { AnyGameState, GameEventLogEntry, UserRole } from "./types.js";
import { currentGameLogMultiplier, formatGameLogMultiplier } from "./game-log-score.js";
import { spreadsheetCsvCell } from "./spreadsheet-safety.js";

const ROLE_LABELS: Record<UserRole, string> = {
  "super-admin": "超级管理员",
  "admin-advanced": "管理员+高级用户",
  admin: "管理员",
  advanced: "高级用户",
  normal: "普通用户",
};

export function buildGameLogCsv(game: AnyGameState, roomCode = ""): string {
  const online = game.mode === "online";
  const custom = game.rulesetMode === "custom";
  const includePointColumns = online || custom;
  const headers = [
    "序号",
    "记录类型",
    "时间(UTC+8)",
    "对局ID",
    "模式",
    "房间号",
    "用户",
    "昵称",
    "身份组",
    "操作",
    "数量",
    "卡牌",
    "操作结果",
    "剩余卡牌",
    "溶液区",
    "生成物区",
    ...(includePointColumns ? ["积分操作", "当前累计积分"] : []),
    "剩余出牌数",
    "倍率",
    ...(custom
      ? ["归一化积分变化", "底注", "当前 stake", "最终 raw delta（每名败者）", "cap 缩放系数", "最终 delta（每名败者）", "赢家最终 delta", "是否实际结算账户积分"]
      : []),
  ];
  const events = normalizedEvents(game);
  const rows = events.map((event) => [
    String(event.sequence),
    event.category,
    formatUtc8Iso(event.timestamp),
    game.id,
    online ? "联机" : "本地",
    online ? roomCode : "",
    event.username ? `@${event.username}` : event.nickname ?? "系统",
    event.nickname ?? "",
    event.role ? ROLE_LABELS[event.role] : "",
    formatLogText(event.operation),
    event.quantity === undefined ? "" : String(event.quantity),
    event.cards.map(cardLabel).join(" "),
    formatLogText(event.result),
    event.remainingCards.map(cardLabel).join(" "),
    formatSolution(event.solutionCards ?? []),
    formatProductGroups(event.productGroups ?? []),
    ...(includePointColumns ? [event.pointsOperation ?? "", String(event.cumulativePoints ?? game.scoring?.total ?? 0)] : []),
    String(event.remainingActionPoints ?? game.actionPoints ?? 0),
    formatGameLogMultiplier(event.scoreMultiplier ?? fallbackEventMultiplier(game, event)),
    ...(custom
      ? [
          event.normalizedPointsOperation ?? "",
          String(game.scoring?.baseBet ?? 0),
          String(game.scoring?.stake ?? 0),
          String(game.scoring?.total ?? 0),
          game.scoring?.customCapScale === undefined ? "" : String(game.scoring.customCapScale),
          game.scoring?.settlementAmountPerLoser === undefined ? "" : String(game.scoring.settlementAmountPerLoser),
          game.scoring?.winnerGrossPoints === undefined ? "" : String(game.scoring.winnerGrossPoints),
          game.scoring?.settlesPoints === true ? "是" : "否",
        ]
      : []),
  ]);
  return [headers, ...rows].map((row) => row.map(spreadsheetCsvCell).join(",")).join("\r\n");
}

export function gameLogFileName(game: AnyGameState, roomCode = ""): string {
  return `ion-storm-${game.mode === "online" ? roomCode || "online" : "local"}-${game.id}-log.csv`;
}

function normalizedEvents(game: AnyGameState): GameEventLogEntry[] {
  if (game.eventLog?.length) return game.eventLog;
  return [...game.log].reverse().map((result, index) => ({
    sequence: index + 1,
    timestamp: Date.now(),
    category: index === game.log.length - 1 ? "终局" : "操作",
    operation: "历史日志",
    cards: [],
    result,
    remainingCards: [],
    solutionCards: game.zones.solution.map(logCardId),
    productGroups: game.zones.products.map((product) => product.cards.map(logCardId)),
    pointsOperation: undefined,
    cumulativePoints: game.mode === "online" ? game.scoring?.total ?? 0 : undefined,
    scoreMultiplier: currentGameLogMultiplier(game),
    remainingActionPoints: game.actionPoints,
  }));
}

function fallbackEventMultiplier(game: AnyGameState, event: GameEventLogEntry): number {
  if (game.mode === "online" && event.cumulativePoints !== undefined && game.scoring) {
    const openingScale = game.scoring.baseBet * Math.pow(2, game.scoring.openingDoublePlayerIds?.length ?? 0);
    if (openingScale > 0) return event.cumulativePoints / openingScale;
  }
  return currentGameLogMultiplier(game);
}

function logCardId(card: string | { cardId: string }): string {
  return typeof card === "string" ? card : card.cardId;
}

function cardLabel(card: string): string {
  return cardText(card);
}

function formatSolution(cards: string[]): string {
  return cards.length > 0 ? `(${cards.map(cardLabel).join(" ")})` : "";
}

function formatProductGroups(groups: string[][]): string {
  return groups.map((cards) => `(${cards.map(cardLabel).join(" ")})`).join(" ");
}

function formatLogText(value: string): string {
  const replacements = new Map<string, string>();
  for (const [card, label] of Object.entries(LABELS)) {
    const formatted = cardText(card);
    replacements.set(card, formatted);
    replacements.set(label, formatted);
  }
  let result = value;
  for (const [source, replacement] of [...replacements].sort(([left], [right]) => right.length - left.length)) {
    if (source === replacement) continue;
    result = result.replace(new RegExp(escapeRegExp(source), "g"), replacement);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatUtc8Iso(timestamp: number): string {
  return new Date(timestamp + 8 * 3_600_000).toISOString().replace("Z", "+08:00");
}
