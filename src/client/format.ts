/**
 * 纯格式化 / 展示辅助（S0 地基）。
 *
 * 分三类：
 *   1. 纯函数：日期、数字、百分比、角色名、卡牌种类名 —— 不碰任何状态；
 *   2. 只读 shared 里的静态表：LABELS / FORMULA_HTML / compoundFormulaHtml；
 *   3. 需要「当前对局的自定义规则」的几个（cardDisplayName / formulaHtml / formatIon*）：
 *      通过 context 的 getBridge().customRules() 取，等价于原来直接调 customRulesOf(game)，
 *      这样它们才能离开 app.ts —— 这是 context 通道的第一个真实使用者。
 */
import { FORMULA_HTML, LABELS } from "../shared/cards.js";
import { defaultCustomModeLimits, resolveCustomMaxBaseBet } from "../shared/custom-limits.js";
import type { ResolvedCustomRules } from "../shared/custom-rules-types.js";
import { compoundFormulaHtml } from "../shared/formula.js";
import { customInitialHandSizeMaximum, effectiveInitialHandSize, normalMaxBaseBet } from "../shared/room-limits.js";
import type { CardId, UserRole } from "../shared/types.js";
import { getBridge } from "./context.js";
import { escapeHtml } from "./dom.js";
import type { PublicUser, RoomBetHintContent, UserRequestView } from "./types.js";

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDate(value: number): string {
  if (!Number.isFinite(value)) return "";
  const date = new Date(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatWinRate(rate: number): string {
  const percent = Math.max(0, Math.min(1, Number.isFinite(rate) ? rate : 0)) * 100;
  return `${percent.toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function formatAverage(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function formatSignedInteger(value: number): string {
  const clean = Number.isFinite(value) ? Math.trunc(value) : 0;
  return clean > 0 ? `+${clean}` : String(clean);
}

export function pointDeltaClass(value: number): string {
  const clean = Number.isFinite(value) ? Math.trunc(value) : 0;
  if (clean > 0) return "point-delta-positive";
  if (clean < 0) return "point-delta-negative";
  return "point-delta-zero";
}

/** 胜率 = 胜场 / 总场；一局没打时按 0 算。参数是结构化的，不依赖 PublicUser 定义在哪。 */
export function winRateFromUser(user: { gamesWon: number; gamesPlayed: number }): number {
  return user.gamesPlayed > 0 ? user.gamesWon / user.gamesPlayed : 0;
}

export function rolePriority(role: UserRole): number {
  return { "super-admin": 5, "admin-advanced": 4, admin: 3, advanced: 2, normal: 1 }[role];
}

export function roleLabel(role: UserRole): string {
  return (
    {
      "super-admin": "超级管理员",
      "admin-advanced": "管理员+高级用户",
      admin: "管理员",
      advanced: "高级用户",
      normal: "普通用户",
    } as Record<UserRole, string>
  )[role];
}

export function roleOptions(selected: UserRole, includeSuperAdmin: boolean): string {
  const roles: UserRole[] = includeSuperAdmin ? ["normal", "advanced", "admin", "admin-advanced", "super-admin"] : ["normal", "advanced", "admin", "admin-advanced"];
  return roles.map((role) => `<option value="${role}" ${role === selected ? "selected" : ""}>${escapeHtml(roleLabel(role))}</option>`).join("");
}

export function kindName(kind?: string): string {
  return ({ cation: "阳离子", anion: "阴离子", function: "操作牌", special: "特殊物质" } as Record<string, string>)[kind ?? ""] ?? "卡牌";
}

export function productKindName(kind: string): string {
  return ({ solid: "沉淀", gas: "气体", weak: "弱电解质", nonexistent: "不存在物", micro: "微溶物", special: "特殊物质" } as Record<string, string>)[kind] ?? "生成物";
}

/** 三个带颜色的铁/铜离子在记录与牌面里要单独上色。 */
export function coloredIonStyle(card: CardId): string {
  const color = (
    {
      "Fe^{2+}": "#5F8A62",
      "Fe^{3+}": "#A64B2A",
      "Cu^{2+}": "#1677B8",
    } as Record<CardId, string>
  )[card];
  return color ? ` style="color:${color}"` : "";
}

export function compoundFormulaFromCards(cards: CardId[]): string {
  const entries = Object.entries(
    cards.reduce<Record<CardId, number>>((acc, card) => {
      acc[card] = (acc[card] ?? 0) + 1;
      return acc;
    }, {}),
  ).map(([card, count]) => ({ card, count }));
  return compoundFormulaHtml(entries);
}

/** 就地扣掉 N 张同名牌（只用于「展示前的副本」，不影响真实手牌）。 */
export function removeCardsForDisplay(cards: CardId[], card: CardId, count: number): void {
  for (let i = 0; i < count; i++) {
    const index = cards.indexOf(card);
    if (index >= 0) cards.splice(index, 1);
  }
}

/** ISO 时间串 → 北京时间 yyyy-mm-ddThh:mm，供 <input type="datetime-local"> 使用。 */
export function toLocalDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().slice(0, 16);
}

export function isHexColor(value?: string): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function durationLabel(duration?: number | null): string {
  if (duration === null) return "永久";
  if (duration === undefined) return "";
  return `${Math.round(duration / 86_400_000)} 日`;
}

/** 牌名：自定义规则里改过名就用自定义名，否则用 shared 的 LABELS。 */
export function cardDisplayName(card: CardId): string {
  const customDef = getBridge().customRules()?.cards[card];
  if (customDef) return customDef.displayName;
  return LABELS[card] ?? card;
}

/** 牌面公式：自定义牌用自定义名，经典牌用带上标下标的 FORMULA_HTML。 */
export function formulaHtml(card: CardId): string {
  const customDef = getBridge().customRules()?.cards[card];
  if (customDef) return escapeHtml(customDef.displayName);
  return FORMULA_HTML[card] ?? escapeHtml(LABELS[card] ?? card);
}

export function formatIonTerm(count: number, card: CardId): string {
  return count > 1 ? `${count} x ${formulaHtml(card)}` : formulaHtml(card);
}

export function formatIonList(cards: CardId[]): string {
  const counts = cards.reduce<Record<CardId, number>>((acc, card) => {
    acc[card] = (acc[card] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([card, count]) => formatIonTerm(count, card)).join(" + ");
}

// ---------------------------------------------------------------------------
// 账号 / 权限 / 工单的展示辅助（S2 从 app.ts 搬来）
//
// 这几个都是纯函数，但被好几处共用（设置弹窗、用户表格、工单表格、账号控件），
// 所以只能放在这一层：拆出去的 settings.ts 能直接 import，app.ts 继续用同一份实现。
// ---------------------------------------------------------------------------

/** 主题色默认值。applyThemeColor 与设置弹窗共用，避免两处写死不同颜色。 */
export const DEFAULT_THEME_COLOR = "#226b70";

/** 身份/禁用/权限等各类到期时间的摘要，用户表格里一行显示完。 */
export function expirySummary(user: PublicUser): string {
  const parts = [
    user.adminPermanent ? "管理员永久" : user.adminExpiresAt ? `管理员至 ${formatDate(Date.parse(user.adminExpiresAt))}` : "",
    user.advancedPermanent ? "高级永久" : user.advancedExpiresAt ? `高级至 ${formatDate(Date.parse(user.advancedExpiresAt))}` : "",
    user.disabledUntil ? `禁用至 ${formatDate(Date.parse(user.disabledUntil))}` : "",
    user.leaderboardHiddenUntil ? `排行榜隐藏至 ${formatDate(Date.parse(user.leaderboardHiddenUntil))}` : "",
    user.permissionOverride ? (user.permissionOverridePermanent ?? true) ? "权限覆盖永久" : user.permissionOverrideExpiresAt ? `权限覆盖至 ${formatDate(Date.parse(user.permissionOverrideExpiresAt))}` : "" : "",
    user.customModeLimitOverride ? (user.customModeLimitOverridePermanent ?? true) ? "自定义模式额度永久" : user.customModeLimitOverrideExpiresAt ? `自定义模式额度至 ${formatDate(Date.parse(user.customModeLimitOverrideExpiresAt))}` : "" : "",
  ].filter(Boolean);
  return parts.join(" / ");
}

/** 管理员判定：admin / admin-advanced / super-admin 都算。 */
export function isAdminUser(user?: PublicUser): boolean {
  return Boolean(user && (user.role === "admin" || user.role === "admin-advanced" || user.role === "super-admin"));
}

/** 专属房间号排序：短的在前，等长按字典序。app.ts 与 dialogs.ts 共用。 */
export function sortReservedRoomCodes(codes: readonly string[]): string[] {
  return [...codes].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

export function requestKindLabel(kind: UserRequestView["kind"]): string {
  return ({ ticket: "工单", unban: "解封申请", nickname: "昵称修改", security: "安全审计" } as const)[kind];
}

export function requestStatusLabel(status: UserRequestView["status"]): string {
  return ({ open: "待处理", approved: "已通过", replied: "已回复", ignored: "已忽略" } as const)[status];
}

// ---------------------------------------------------------------------------
// 用户排序 / 房间额度上限（S2 从 app.ts 搬来）
//
// 「编辑房间」弹窗搬进 dialogs.ts 之后，这些上限算法与排序链两边都要用；
// 放在这一层只留一份实现，app.ts 与 dialogs.ts 共用。逻辑与原 app.ts 逐字一致，
// 唯一的改动是 editRoomBetHintText 把「当前用户」从闭包读改成显式入参。
// ---------------------------------------------------------------------------

/** 排行榜排序：积分 > 胜率 > 场次 > 角色权重 > 注册时间 > 昵称 > id。 */
export function sortUsersForLeaderboard(users: readonly PublicUser[]): PublicUser[] {
  return [...users].sort(
    (left, right) =>
      right.points - left.points ||
      winRateFromUser(right) - winRateFromUser(left) ||
      right.gamesPlayed - left.gamesPlayed ||
      rolePriority(right.role) - rolePriority(left.role) ||
      left.createdAt - right.createdAt ||
      left.username.localeCompare(right.username, "zh-Hans-CN") ||
      left.id.localeCompare(right.id),
  );
}

/** 用户列表的积分总和（批量发放积分弹窗顶部那行）。 */
export function usersTotalPoints(users: readonly PublicUser[]): number {
  return users.reduce((sum, user) => sum + user.points, 0);
}

/** 自定义规则里是否按人数写了不同的牌堆/发牌（写了就把房间人数锁死）。 */
export function hasPlayerCountDeckOverrides(rules: { deck?: { byPlayers?: unknown } } | undefined): boolean {
  const overrides = rules?.deck?.byPlayers;
  return Boolean(overrides && typeof overrides === "object" && !Array.isArray(overrides) && Object.keys(overrides).length > 0);
}

/** 经典模式的底注上限：没登录按 100 算。 */
export function effectiveMaxBaseBet(user?: PublicUser): number | null {
  if (!user) return 100;
  return user.permissions.maxBaseBet;
}

/** 自定义模式的底注上限：用户额度与权限上限取更严的那个。 */
export function effectiveCustomMaxBaseBet(user?: PublicUser): number | null {
  if (!user) return resolveCustomMaxBaseBet(defaultCustomModeLimits().maxBaseBet, 100);
  return resolveCustomMaxBaseBet(user.customModeLimits?.maxBaseBet ?? defaultCustomModeLimits().maxBaseBet, user.permissions.maxBaseBet);
}

/** 自定义规则下「全局补足手牌数」的上限。 */
export function customInitialHandSizeMax(rules: ResolvedCustomRules | undefined, players: number): number {
  return customInitialHandSizeMaximum(rules ?? { deck: { cards: {} } }, players);
}

/** 邀请码/激活码的「这个身份是否包含该档位」判定（super-admin 恒真）。 */
export function invitationRoleIncludes(role: UserRole, kind: "admin" | "advanced"): boolean {
  return kind === "admin" ? role === "admin" || role === "admin-advanced" : role === "advanced" || role === "admin-advanced";
}

/** 「编辑房间」里的底注提示：总发牌数超过 100 张就提示会进入算牌大战。 */
export function editRoomBetHintText(user: PublicUser | undefined, capacity: number, initialHandSize?: number): RoomBetHintContent {
  const seats = Number.isInteger(capacity) && capacity >= 2 ? capacity : 2;
  const handSize = effectiveInitialHandSize(initialHandSize, seats);
  const total = seats * handSize;
  const maximum = effectiveMaxBaseBet(user);
  const minimumBet = user?.permissions.canCreateZeroBaseBet ? 0 : 1;
  if (total > 100) {
    const cap = maximum === null ? null : normalMaxBaseBet(maximum, total);
    return {
      className: "duel-hint card-war-hint",
      text: `算牌大战：总发牌数 ${total} 张（${seats} 人 × 初始手牌 ${handSize} 张），底注上限同步降为 ${cap ?? "不限"}；当牌堆和弃牌堆较少时可能会出现预期之外的结果。`,
    };
  }
  return {
    className: "muted room-bet-hint",
    text: `底注允许范围 ${minimumBet}-${maximum ?? "不限"}；当前总发牌数 ${total} 张，超过 100 张将进入算牌大战并降低底注上限。`,
  };
}
