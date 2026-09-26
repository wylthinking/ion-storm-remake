export type CardId = string;
export type PlayerId = string;
export type RoomCode = string;
export type UserRole = "super-admin" | "admin-advanced" | "admin" | "advanced" | "normal";

export type RulesetMode = "classic" | "custom";

export function normalizeRulesetMode(value: unknown): RulesetMode {
  return value === "custom" ? "custom" : "classic";
}

export type CardKind = "cation" | "anion" | "special" | "function";
export type ProductKind = "solid" | "gas" | "weak" | "nonexistent" | "micro" | "special";

export interface CardDef {
  id: CardId;
  label: string;
  kind: CardKind;
  charge?: number;
  count: number;
}

export interface ProductGroup {
  id: string;
  kind: ProductKind;
  cards: CardId[];
  label: string;
  inert?: boolean;
  radiationLeft?: number;
  ownerPlayerId?: PlayerId;
}

export interface PlayerProfile {
  accountId?: string;
  username: string;
  nickname?: string;
  role: UserRole;
  color: string;
  nicknameColor?: string;
  permissions?: {
    exchangeMin: number;
    exchangeMax: number | null;
    canCreateZeroBaseBet: boolean;
    maxBaseBet: number | null;
  };
  title?: string;
  subtitle?: string;
  hasAdvancedPerk: boolean;
  points?: number;
  guest?: boolean;
}

export interface PlayerState {
  id: PlayerId;
  nickname: string;
  accountId?: string;
  profile?: PlayerProfile;
  hand: CardId[];
  online: boolean;
  lastSeenAt?: number;
  bot?: boolean;
  botOwnerId?: PlayerId;
  seat: number;
  timeoutLimitMs: number;
  timeoutStreak: number;
  normalStreak: number;
  forcedAutoplay: boolean;
  canOpeningExchange?: boolean;
  openingExchangeMin?: number;
  openingExchangeMax?: number | null;
  openingExchangeWindowMs?: number;
  openingExchangeDone?: boolean;
  skipped?: boolean;
  followSkip?: boolean;
}

export interface ZoneState {
  solution: CardId[];
  products: ProductGroup[];
  discard: CardId[];
  drawPile: CardId[];
}

export interface GameState {
  id: string;
  status: "lobby" | "opening-exchange" | "playing" | "ended";
  mode: "local" | "online";
  rulesetMode?: RulesetMode;
  revision: number;
  players: PlayerState[];
  zones: ZoneState;
  currentPlayer: number;
  startingSeat: number;
  direction: 1 | -1;
  actionPoints: number;
  turnStartedAt: number;
  turnDeadlineAt?: number;
  turnTimeLimitMs?: number;
  openingExchangeWindowMs?: number;
  winnerId?: PlayerId;
  pendingDraw?: PendingDrawState;
  pendingChoice?: PendingChoiceState;
  openingExchange?: OpeningExchangeState;
  scoring?: GameScoringState;
  log: string[];
  eventLog?: GameEventLogEntry[];
  /** 假设底注为 1 且无人开局加倍时，积分引擎当前应有的累计积分。 */
  logScoreMultiplier?: number;
  rngSeed: number;
}

export interface GameEventLogEntry {
  sequence: number;
  timestamp: number;
  category: "开局" | "玩家信息" | "发牌" | "操作" | "摸牌" | "反应" | "终局";
  playerId?: PlayerId;
  username?: string;
  nickname?: string;
  role?: UserRole;
  operation: string;
  quantity?: number;
  cards: CardId[];
  result: string;
  remainingCards: CardId[];
  solutionCards?: CardId[];
  productGroups?: CardId[][];
  pointsOperation?: string;
  normalizedPointsOperation?: string;
  cumulativePoints?: number;
  scoreMultiplier?: number;
  remainingActionPoints?: number;
}

export interface GameScoringState {
  baseBet: number;
  multiplier: number;
  stake: number;
  total: number;
  pendingByPlayerId: Record<PlayerId, number>;
  openingDoublePlayerIds: PlayerId[];
  winnerTax?: number;
  winnerGrossPoints?: number;
  taxRatePercent?: number;
  taxWinnerPointsThreshold?: number;
  winnerPreTaxPoints?: number;
  settlesPoints?: boolean;
  customCapScale?: number;
  settlementAmountPerLoser?: number;
}

export interface OpeningExchangeState {
  deadlineAt: number;
  deadlineByPlayerId: Record<PlayerId, number>;
  eligiblePlayerIds: PlayerId[];
  completedPlayerIds: PlayerId[];
  doubleCompletedPlayerIds: PlayerId[];
  exchangeDrawCounts?: Record<PlayerId, number>;
}

export interface PendingDrawState {
  sourceSeat: number;
  sourceActionPoints?: number;
  turnSeat?: number;
  turnActionPoints?: number;
  turnExhausted?: boolean;
  targetSeat: number;
  remaining: number;
  perPlayerCap: number;
  reason: string;
  functionCard?: CardId;
  /** Custom-mode combo identity when the draw flow was started by a combo. */
  customFunctionComboId?: string;
  /** Whether the exact custom drawFlow step that created this pending flow allows same-source follow. */
  customFollowAllowed?: boolean;
  followedPlayerIds?: PlayerId[];
  drawnByPlayerId?: Record<PlayerId, number>;
  postEffects?: PostDrawEffect[];
  scorePlayerId?: PlayerId;
  counterSourceCard?: CardId;
  customContinuation?: unknown;
}

export type PendingChoiceState =
  | {
      kind: "impurity-reaction";
      playerId: PlayerId;
      card: CardId;
      targetIds: string[];
    }
  | {
      kind: "enough-selection";
      playerId: PlayerId;
      choices: Array<{ card: CardId; maxCount: number }>;
    };

export interface PostDrawEffect {
  type: "draw-all";
  count: number;
  extraMinHand: number;
  reason: string;
}

export type ActionIntent =
  | { type: "opening-exchange"; discard: CardId[] }
  | { type: "opening-double"; enabled: boolean }
  | { type: "play-ion"; card: CardId; count: number; targetId?: string }
  | { type: "play-special"; card: "Au" | "U" }
  | { type: "play-function"; card: CardId; payload?: { enoughCard?: CardId; enoughCount?: number } }
  | { type: "follow-function"; card: CardId }
  | { type: "resolve-impurity"; targetId?: string }
  | { type: "resolve-enough"; card: CardId; count: number }
  | { type: "wang-zha" }
  | { type: "accept-draw" }
  | { type: "counter-draw"; method: "AddSodium" | "WangZha" }
  | { type: "pass" };

export interface ResolvedAction {
  ok: boolean;
  message: string;
  game: GameState;
}

export interface ReactionGroup {
  id: string;
  kind: ProductKind;
  playedCard: CardId;
  playedNeeded: number;
  solutionPlayedNeeded?: number;
  tableCard: CardId;
  tableNeeded: number;
  solutionTableNeeded?: number;
  source: "solution" | "product";
  productId?: string;
  priority: number;
  score: number;
  label: string;
  groupCount?: number;
}

export interface BotProfile {
  id: string;
  name: string;
  level: "fast" | "balanced";
}

// ---------------------------------------------------------------------------
// Custom ruleset (v4 JSON) shared types
// ---------------------------------------------------------------------------

export interface CardBadge {
  text: string;
  source?: string;
}

export interface CardMark {
  name: string;
  ownerId?: PlayerId;
  badge?: string;
  reactionPriority?: number;
  listeners: CustomEventListenerDef[];
}

export interface CardInstance {
  instanceId: string;
  cardId: CardId;
  marks: CardMark[];
  counters: Record<string, number>;
  ownerPlayerId?: PlayerId;
  source?: string;
}

export type { CustomRemoveCause } from "./custom-rules-types.js";
import type { CustomEventListenerRule, CustomRemoveCause, CustomStep } from "./custom-rules-types.js";

export type CustomEventListenerDef = CustomEventListenerRule;
export type CustomStepDef = CustomStep;

export interface CustomEventFilter {
  cause?: CustomRemoveCause | CustomRemoveCause[];
  reactionResult?: string | string[];
  name?: string;
  [key: string]: unknown;
}

export interface CustomCardInstanceGroup {
  id: string;
  kind: ProductKind;
  cards: CardInstance[];
  label: string;
  inert?: boolean;
  ownerPlayerId?: PlayerId;
}

export interface CustomPlayerState extends Omit<PlayerState, "hand"> {
  hand: CardInstance[];
}

export interface CustomZoneState {
  solution: CardInstance[];
  products: CustomCardInstanceGroup[];
  discard: CardInstance[];
  drawPile: CardInstance[];
}

export interface CustomAudioEvent {
  id: string;
  cardId: CardId;
  audioKey: string;
  to: "all" | PlayerId;
  batchId?: string;
}

export interface CustomRemoveEvent {
  actor?: PlayerId;
  cause: CustomRemoveCause;
  sourceCard?: CardId;
  reactionResult?: string;
  batchId?: string;
  removed: CardInstance[];
}

export type CustomPendingChoiceState = {
  kind: "custom-choice";
  choiceId: string;
  playerId: PlayerId;
  prompt?: string;
  sourceActionId?: string;
  continuation: unknown;
};

export interface CustomInspectReveal {
  id: string;
  playerId: PlayerId;
  text: string;
  line?: string;
  cardName?: string;
}

export interface CustomRuntimeState {
  rulesHash: string;
  rulesRevision?: number;
  rules?: unknown;
  instanceSeq: number;
  batchSeq: number;
  rngState: number;
  deferredTriggers: unknown[];
  audioEvents: CustomAudioEvent[];
  inspectReveals: CustomInspectReveal[];
  playedListenerSeq: number;
  settlementLoserCap?: number | null;
  /** 兼容尚未结束的旧房间；新对局只写入 settlementLoserCap。 */
  settlementCapByPlayerId?: Record<PlayerId, number | null>;
  timeoutDisconnect?: Record<PlayerId, string>;
}

export interface CustomGameState extends Omit<GameState, "rulesetMode" | "players" | "zones" | "pendingChoice"> {
  rulesetMode: "custom";
  players: CustomPlayerState[];
  zones: CustomZoneState;
  pendingChoice?: CustomPendingChoiceState;
  custom: CustomRuntimeState;
}

export type AnyGameState = GameState | CustomGameState;

export function isCustomGame(game: AnyGameState): game is CustomGameState {
  return game.rulesetMode === "custom";
}

export interface CustomActionIntent {
  type: "custom";
  actionId?: string;
  cardId?: CardId;
  cardInstanceIds?: string[];
  selectedPlayerIds?: PlayerId[];
  selectedGroupIds?: string[];
  selectedCount?: number;
  choiceId?: string;
}

export type AnyActionIntent = ActionIntent | CustomActionIntent;
