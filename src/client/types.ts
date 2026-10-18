/**
 * app.ts 的全部本地类型（S0 地基的最后一块）。
 *
 * 这个文件只有类型，编译后不产出任何运行时代码（`import type` 会被完全擦除），
 * 所以拆出去的模块可以放心 import 它，不会和 app.ts 形成运行时循环依赖。
 * 留在 app.ts 的只有两个「依赖运行时值」的类型：
 *   - SeatView     = ReturnType<typeof currentSeats>[number]（依赖函数）
 *   - NewCardCategory = (typeof NEW_CARD_CATEGORIES)[number]（依赖常量数组）
 */
import type { AnyGameState, CardId, CardInstance, PlayerProfile, UserRole } from "../shared/types.js";
import type { CustomCardDef, CustomComboDef, CustomDealSeatRule, CustomDisplay, ResolvedCustomRules } from "../shared/custom-rules-types.js";
import type { CustomModeLimitGrant, CustomModeLimits } from "../shared/custom-limits.js";
import type { RulesetAction } from "../shared/ruleset.js";

export type ClientGame = AnyGameState;

// ---------------------------------------------------------------------------
// 账号 / 权限 / 房间
// ---------------------------------------------------------------------------

export type PublicUser = {
  id: string;
  username: string;
  nickname: string;
  role: UserRole;
  color: string;
  nicknameColor: string;
  title?: string;
  subtitle?: string;
  hasAdvancedPerk: boolean;
  superAdmin: boolean;
  adminPermanent: boolean;
  advancedPermanent: boolean;
  adminExpiresAt?: string;
  advancedExpiresAt?: string;
  advancedAiAccess?: boolean;
  advancedAiPermanent?: boolean;
  advancedAiExpiresAt?: string;
  taxRatePercent?: number;
  gamesPlayed: number;
  gamesWon: number;
  todayGamesPlayed: number;
  todayGamesWon: number;
  todayGamePointsDelta: number;
  inviteCodeUsed?: string;
  lastLoginAt?: number;
  points: number;
  disabledUntil?: string;
  disabledPermanent: boolean;
  disabled: boolean;
  hideFromLeaderboardWhileDisabled: boolean;
  leaderboardHiddenUntil?: string;
  leaderboardHiddenPermanent: boolean;
  hiddenFromLeaderboard: boolean;
  nicknameChangeDisabled: boolean;
  permissions: PermissionRule;
  permissionOverride?: Partial<PermissionRule>;
  permissionOverrideExpiresAt?: string;
  permissionOverridePermanent?: boolean;
  customModeLimits: CustomModeLimits;
  customModeLimitOverride?: CustomModeLimitGrant;
  customModeLimitOverrideExpiresAt?: string;
  customModeLimitOverridePermanent?: boolean;
  hasWinMusic: boolean;
  /** Only exposed for the account itself and authorized managers. */
  reservedRoomCodes?: string[];
  createdAt: number;
  updatedAt: number;
};

export type DuelLimitPeriod = "none" | "hour" | "day" | "week" | "unlimited";
export type DuelLimitRule = { period: DuelLimitPeriod; count: number | null };

export type PermissionRule = {
  exchangeMin: number;
  exchangeMax: number | null;
  canCreateZeroBaseBet: boolean;
  maxBaseBet: number | null;
  duelLimit: DuelLimitRule;
};

export type RoomSummary = {
  code: string;
  revision?: number;
  status: string;
  baseBet?: number;
  rulesetMode?: "classic" | "custom";
  customRulesHash?: string | null;
  customPresetId?: string | null;
  customPresetRevision?: number | null;
  roomCodeMode?: "custom" | "reserved";
  roomCodeKind?: "custom" | "reserved";
  codeKind?: "custom" | "reserved";
  isReservedRoomCode?: boolean;
  initialHandSize?: number | null;
  turnTimeLimitSec?: number | null;
  openingExchangeSec?: number | null;
  duelMode?: boolean;
  duelKeepAvailable?: boolean;
  capacity: number;
  creatorAccountId: string;
  bankerPlayerId?: string;
  roomGamesPlayed?: Record<string, number>;
  roomGamesWon?: Record<string, number>;
  editNotice?: RoomEditNotice;
  players: Array<{
    id: string;
    nickname: string;
    accountId?: string;
    profile?: PlayerProfile;
    online: boolean;
    bot?: boolean;
    botOwnerId?: string;
    seat: number;
    handCount: number;
    timeoutLimitMs: number;
    timeoutStreak: number;
    forcedAutoplay: boolean;
    canOpeningExchange?: boolean;
    openingExchangeDone?: boolean;
    openingExchangeMin?: number;
    openingExchangeMax?: number | null;
    openingExchangeWindowMs?: number;
    readyToStart?: boolean;
  }>;
};
export type RoomEditNotice = {
  id: string;
  capacity: number;
  baseBet: number;
  initialHandSize?: number | null;
  turnTimeLimitSec?: number | null;
  openingExchangeSec?: number | null;
  updatedByNickname: string;
  updatedAt: number;
  recipientPlayerIds: string[];
  problems?: string[];
};

/**
 * 服务端回包：WS 消息与 REST 响应共用的一套可选字段。
 * 原本是 app.ts 里 applyServerPayload() 的内联参数类型；S4 批次二之后 online.ts（轮询 / HTTP 兼容模式）
 * 也要把回包递给 app.ts，所以提到这里由 app.ts / context.ts / online.ts 三方共用。
 */
export type ServerPayload = {
  room?: RoomSummary;
  game?: AnyGameState;
  message?: string;
  error?: string;
  serverNow?: number;
  duelDissolved?: boolean;
};

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------

export type SetupModal = {
  kind: "local" | "online";
  ruleset: "classic" | "custom";
  playerCount: number;
  botCount: number;
  baseBet: number;
  initialHandSize: string;
  turnTimeLimit: string;
  openingExchangeTime: string;
  roomCodeMode?: "custom" | "reserved";
  roomCode?: string;
  customRules?: ResolvedCustomRules;
  customPresetId?: string;
  /** A selected server preset was opened in the local editor. Submit its edited snapshot, not the preset id. */
  customPresetEdited?: boolean;
  customBlank?: boolean;
  customPresetLoading?: boolean;
  error?: string;
};
export type JoinModal = { kind: "join"; code: string; error?: string };
export type AuthModal = { kind: "auth"; mode: "login" | "register"; username: string; inviteCode?: string; reservedRoomCode?: string; error?: string };
export type ActionChoiceModal = {
  kind: "actions";
  title: string;
  titleHtml?: string;
  actions: RulesetAction[];
  forced?: boolean;
  drawPrompt?: boolean;
  submitting?: boolean;
  stateRevision?: number;
};
export type CreditsModal = { kind: "credits"; fromSettings?: boolean };
export type LuckyModal = { kind: "lucky"; value: number };
export type SettingsModal = { kind: "settings" };
export type LeaderboardModal = { kind: "leaderboard" };
/** 个人中心弹窗：点用户名 → 下拉菜单 →「个人中心」。这里放账号自己的功能，管理员后台（设置 → 用户管理）只管别人。 */
export type ProfileModal = { kind: "profile" };
/**
 * 邀请码管理弹窗。原来是占一个路由的独立页面（renderInvitePage + renderPageShell + /invite），现在和排行榜一样改成弹窗。
 * fromSettings：从「设置 → 用户管理」工具条点进来时为 true——它是覆盖掉设置弹窗打开的，关闭时得自己记住来路，
 * 退回设置弹窗而不是一路退到主界面（和 CreditsModal 同一套做法）。
 */
export type InviteModal = { kind: "invite"; fromSettings?: boolean };
/** 激活码管理弹窗。原来是独立页面（renderActivationPage + /activation），和邀请码一起改成弹窗；fromSettings 同 InviteModal。 */
export type ActivationModal = { kind: "activation"; fromSettings?: boolean };
export type SettingsTab = "general" | "users" | "tickets";
export type ModalState = SetupModal | JoinModal | AuthModal | ActionChoiceModal | CreditsModal | LuckyModal | SettingsModal | LeaderboardModal | ProfileModal | InviteModal | ActivationModal | null;

// ---------------------------------------------------------------------------
// 邀请码 / 激活码 / 工单 / 音乐
// ---------------------------------------------------------------------------

export type InvitationCode = {
  code: string;
  remainingUses: number | null;
  expiresAt?: string;
  role: UserRole;
  initialPoints: number;
  initialTitle?: string;
  initialNicknameColor?: string;
  permissions?: Partial<PermissionRule>;
  customModeLimits?: CustomModeLimitGrant;
  reservedRoomCodeMode?: "user-input" | "random";
  adminDurationMs?: number | null;
  advancedDurationMs?: number | null;
  adminExpiresAt?: string;
  advancedExpiresAt?: string;
  adminPermanent?: boolean;
  advancedPermanent?: boolean;
  advancedAiDurationMs?: number | null;
  advancedAiExpiresAt?: string;
  taxRatePercent?: number | null;
  usePolicy?: "unlimited" | "global-total" | "global-window";
  maxUses?: number;
  windowMs?: number;
  registrations?: Array<{ userId: string; usedAt: number }>;
  createdAt: number;
  updatedAt: number;
};
export type ActivationUsePolicy = "unlimited" | "global-total" | "per-user-total" | "global-window" | "per-user-window";
export type ActivationTitleMode = "default" | "fixed" | "user-custom";
export type ActivationNicknameColorMode = ActivationTitleMode;
export type ActivationCode = {
  code: string;
  kind?: "standard" | "point-distribution";
  usePolicy: ActivationUsePolicy;
  maxUses: number;
  distributionMode?: "random" | "equal";
  totalPoints?: number;
  windowMs?: number;
  expiresAt?: string;
  points: number;
  requireNonNegativeBalance?: boolean;
  titleMode?: ActivationTitleMode;
  title?: string;
  nicknameColorMode?: ActivationNicknameColorMode;
  nicknameColor?: string;
  adminDurationMs?: number | null;
  advancedDurationMs?: number | null;
  adminExpiresAt?: string;
  advancedExpiresAt?: string;
  advancedAiDurationMs?: number | null;
  advancedAiExpiresAt?: string;
  taxRatePercent?: number | null;
  permissionDurationMs?: number | null;
  permissions?: Partial<PermissionRule>;
  customModeLimitDurationMs?: number | null;
  customModeLimits?: CustomModeLimitGrant;
  reservedRoomCodeMode?: "user-input" | "random";
  redemptions: Array<{ userId: string; usedAt: number; points?: number }>;
  createdAt: number;
  updatedAt: number;
};
export type UserRequestView = {
  id: string;
  kind: "ticket" | "unban" | "nickname" | "security";
  fromUserId: string;
  text: string;
  privateToSuperAdmin: boolean;
  requestedNickname?: string;
  status: "open" | "approved" | "replied" | "ignored";
  reply?: string;
  replyUserId?: string;
  createdAt: number;
  repliedAt?: number;
  securityLogId?: string;
  securitySubject?: string;
  banSnapshot?: {
    disabledAt?: number;
    disabledUntil?: string;
    disabledPermanent?: boolean;
    disabledBy?: string;
  };
};
export type WinMusicManifestEntry = {
  userId: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha1: string;
  sha256: string;
};

/** 需要二次输入密码才执行的管理动作。 */
export type ProtectedAction =
  | { kind: "update-user"; userId: string; patch: Record<string, unknown> }
  | { kind: "delete-user"; userId: string }
  | { kind: "upload-music"; userId: string; file: File; durationSeconds: number }
  | { kind: "delete-music"; userId: string };

// ---------------------------------------------------------------------------
// 自定义规则编辑器
// ---------------------------------------------------------------------------

export type RulesEditorTab = "cards" | "deck" | "deal" | "display" | "basic" | "json";
export type PlayerDeckOverride = {
  cards?: Record<string, number>;
  deal?: CustomDealSeatRule[];
};
export type RulesDraft = {
  version: 4;
  name: string;
  displayName?: string;
  description?: string;
  setup: Record<string, unknown>;
  cards: Record<string, CustomCardDef>;
  combos: Record<string, CustomComboDef>;
  deck: { cards: Record<string, number>; deal?: CustomDealSeatRule[]; byPlayers?: Record<string, PlayerDeckOverride> };
  display?: CustomDisplay;
};

// ---------------------------------------------------------------------------
// 对话框
// ---------------------------------------------------------------------------

export type DialogState =
  | { kind: "edit-user"; userId: string; error?: string }
  | { kind: "disable-user"; userId: string; error?: string }
  | { kind: "delete-user"; userId: string; error?: string }
  | { kind: "edit-invite"; code?: string; error?: string }
  | { kind: "delete-invite"; code: string; error?: string }
  | { kind: "edit-activation"; code?: string; error?: string }
  | { kind: "edit-point-distribution"; code?: string; error?: string }
  | { kind: "bulk-grant-points"; selectedUserIds?: string[]; error?: string }
  | { kind: "delete-activation"; code: string; error?: string }
  | { kind: "redeem-activation"; error?: string }
  | {
    kind: "redeem-activation-custom";
    code: string;
    titleMode: ActivationTitleMode;
    nicknameColorMode: ActivationNicknameColorMode;
    reservedRoomCodeMode?: "user-input" | "random";
    error?: string;
  }
  | { kind: "permissions"; error?: string }
  | { kind: "tax-settings"; error?: string }
  | { kind: "request"; error?: string }
  | { kind: "review-ticket"; requestId: string; error?: string }
  | { kind: "kick-player"; playerId: string; error?: string }
  | { kind: "leave-room"; local: boolean; error?: string; disband?: boolean }
  | { kind: "edit-room"; error?: string }
  | { kind: "view-room-rules"; selectedCardId?: string }
  | {
    kind: "rules-editor";
    target: "create" | "edit-room";
    tab: RulesEditorTab;
    draft: RulesDraft;
    deckFilter: "all" | CustomCardDef["type"];
    selectedCardId?: string;
    jsonRevision?: number;
    error?: string;
  }
  | { kind: "rules-display-order"; editor: Extract<DialogState, { kind: "rules-editor" }>; order: string[] }
  | { kind: "rules-card-create"; editor: Extract<DialogState, { kind: "rules-editor" }>; error?: string }
  | { kind: "room-edit-notice"; notice: RoomEditNotice }
  | { kind: "reserved-room-codes"; userId: string; codes?: string[]; editingCode?: string; error?: string }
  | { kind: "custom-presets"; error?: string; form?: { id?: string; displayName: string; source: string }; previewResult?: string }
  | { kind: "win-music"; userId: string }
  | { kind: "profile-edit"; error?: string }
  | { kind: "confirm-logout" }
  | null;

// ---------------------------------------------------------------------------
// 发牌动画 / 交互快照
// ---------------------------------------------------------------------------

export type DrawAnimation = {
  id: string;
  seatId: string;
  count: number;
  opening: boolean;
  startedAt: number;
  duration: number;
};
// 飞牌动画的终点：不再用写死的偏移，改成在 DOM 落地后量真实矩形再回填给 @keyframes drawCardFly。
// 每一张 .draw-fx-card 都挂一个 data-deal-key，渲染时记下「哪个 key 飞哪个席位」，量完照着 key 回填；
// 渲染与量取不在同一拍（renderDrawAnimations 是在 app.innerHTML 之前拼字符串的），所以要这张映射表。
export type DealFlyMeasurement = { seatId: string; count: number; opening: boolean };
export type DealTargetPoint = { x: number; y: number };
export type InteractiveElementState = {
  key: string;
  value?: string;
  checked?: boolean;
  open?: boolean;
  scrollTop?: number;
  scrollLeft?: number;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  selectionDirection?: "forward" | "backward" | "none" | null;
};
export type InteractionSnapshot = {
  scope: string;
  elements: InteractiveElementState[];
  activeKey?: string;
  windowX: number;
  windowY: number;
};

// ---------------------------------------------------------------------------
// 其它零散类型
// ---------------------------------------------------------------------------

export type CustomPresetMeta = { id: string; displayName: string; enabled: boolean; updatedAt: number };
export type CustomPresetFull = CustomPresetMeta & { sourceDocument: unknown; createdAt: number };
export type CardVisual = { cls: string; formula: string; kind: string; topColor?: string; ionColor?: string };
export type StartScreenMosaicCard = {
  html: string;
  x: number;
  y: number;
  scale: number;
  rotate: number;
  opacity: number;
  z: number;
};
export type HandDisplayGroup = { card: CardId; indices: number[]; sample: CardId | CardInstance };
export type CustomLimitKind = "customMaxBaseBet" | "customSettlementCap";
export type RoomBetHintContent = { className: string; text: string };

// ---------------------------------------------------------------------------
// 权限 / 税收快照（S2：dialogs.ts 的「权限设置」「税收管理」要读，改用命名类型）
// ---------------------------------------------------------------------------

/** 服务端下发的权限快照：各身份组的规则 + 个别用户的覆盖。 */
export type PermissionsSnapshot = {
  rolePermissions: Record<UserRole, PermissionRule>;
  userPermissions: Record<string, Partial<PermissionRule>>;
};

/** 全局税收设置（税率 + 起征门槛）。 */
export type TaxSettings = { taxRatePercent: number; taxWinnerPointsThreshold?: number };
