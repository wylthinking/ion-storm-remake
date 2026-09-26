import "./styles.css";
import { rankLegalActions } from "../shared/action-ranking.js";
import { CARDS, FORMULA_HTML, LABELS, compareHandCards, isIon, totalCards } from "../shared/cards.js";
import { AUTOMATED_ACTION_DELAY_MS, OPENING_EXCHANGE_MS, applyAction, createGame, createLocalRematch, currentPlayer, enumerateActions, findReactionTargets, maxInitialHandSize, previewEnoughReactionCount, previewFunctionCardEffect } from "../shared/engine.js";
import { chooseBotAction } from "../shared/bot.js";
import { compoundFormulaHtml } from "../shared/formula.js";
import { buildGameLogCsv, gameLogFileName } from "../shared/game-log.js";
import type { LeaderboardEntry, LeaderboardResult } from "../shared/leaderboard.js";
import { canDownloadWinMusic, canManageWinMusic, canPlayDownloadedWinMusic, canPlayWinMusic } from "../shared/music-access.js";
import {
  DEFAULT_OPENING_EXCHANGE_SEC,
  DEFAULT_TURN_TIME_LIMIT_SEC,
  MAX_ROOM_TIME_LIMIT_SEC,
  MIN_ROOM_TIME_LIMIT_SEC,
  cleanCustomRoomBaseBet,
  customInitialHandSizeMaximum,
  cleanRoomBaseBet,
  cleanRoomTimeLimitSec,
  duelMaxBaseBet,
  effectiveInitialHandSize,
  normalMaxBaseBet,
  totalDealtCards,
} from "../shared/room-limits.js";
import {
  ADVANCED_AI_PRESETS,
  type AdvancedAiLevel,
  type AdvancedAiRecommendation,
} from "../shared/advanced-ai.js";
import type { ActionIntent, AnyGameState, CardId, CardInstance, CustomActionIntent, GameState, PlayerProfile, UserRole } from "../shared/types.js";
import { isCustomGame } from "../shared/types.js";
import { applyRulesetAction, createRulesetGame, createRulesetRematch, enumerateRulesetActions, isCustomLegalAction, rulesetCurrentPlayer, type RulesetAction } from "../shared/ruleset.js";
import { PLATFORM_PRESET } from "../shared/generated/custom-json.generated.js";
import { canonicalCustomRulesHash, customDealHasAnyFill, customDealMinimumGlobalFill, customDeckForPlayerCount, customInitialHandForPlayerCount, customRulesSourceForRoom, customRulesSourceFromResolved, customUniformDealTemplate, defaultTopColor, defaultDisplayOrder, displayOrderComparator, effectiveDisplayOrder, materializeCustomCardFollowRules, requiredPlayersFromDeal, type CustomCardDef, type CustomComboDef, type CustomDealSeatRule, type CustomDisplay, type ResolvedCustomRules } from "../shared/custom-rules-types.js";
import {
  customMaxBaseBetSummary,
  customSettlementCapSummary,
  defaultCustomModeLimits,
  resolveCustomMaxBaseBet,
  setupPlayersRange,
  type CustomModeLimitGrant,
  type CustomModeLimits,
  type CustomMaxBaseBetRule,
  type CustomSettlementCapRule,
} from "../shared/custom-limits.js";
import { parseCustomRules } from "../shared/custom-rules-parser.js";
import { stableStringify } from "../shared/stable-json.js";
import rulesSpecMarkdown from "../../json/CUSTOM_GAME_JSON_SPEC.md?raw";
import rulesTemplateJson from "../../json/custom-game-template.json?raw";

type ClientGame = AnyGameState;

function cardIdOf(card: CardId | CardInstance): CardId {
  return typeof card === "string" ? card : card.cardId;
}

function activeSeat() {
  return game ? rulesetCurrentPlayer(game) : undefined;
}

const CUSTOM_CARD_TYPE_LABELS: Record<CustomCardDef["type"], string> = {
  ion: "离子",
  operation: "操作",
  special: "特殊",
  generic: "通用",
};

const customRulesCache = new Map<string, ResolvedCustomRules>();
const customRulesLoadRequests = new Map<string, Promise<ResolvedCustomRules>>();
const preparedCustomRulesHashes = new Set<string>();
const customRulesPrepareRequests = new Map<string, Promise<void>>();
const customRuleAudioPreloads = new Map<string, Map<string, HTMLAudioElement>>();
const CUSTOM_RULES_BROWSER_CACHE = "ion-storm-custom-rules-v1";

function sortReservedRoomCodes(codes: readonly string[]): string[] {
  return [...codes].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

type CustomPresetMeta = { id: string; displayName: string; enabled: boolean; updatedAt: number };
type CustomPresetFull = CustomPresetMeta & { sourceDocument: unknown; createdAt: number };
let customPresetsSnapshot: CustomPresetFull[] | undefined;
let enabledCustomPresets: CustomPresetMeta[] = [];
let enabledCustomPresetsLoading = false;
const enabledCustomPresetRules = new Map<string, ResolvedCustomRules>();

async function loadEnabledCustomPresets(force = false): Promise<void> {
  if (!currentUser || (enabledCustomPresetsLoading && !force)) return;
  enabledCustomPresetsLoading = true;
  try {
    const response = await fetch("/api/custom-presets/enabled", { headers: authHeaders(false) });
    if (response.ok) {
      const data = (await response.json()) as { presets?: CustomPresetMeta[] };
      enabledCustomPresets = Array.isArray(data.presets) ? data.presets : [];
      if (force) enabledCustomPresetRules.clear();
    }
  } catch {
    // 忽略网络错误，预设选择器按空列表渲染
  } finally {
    enabledCustomPresetsLoading = false;
  }
  render();
}

async function loadEnabledCustomPresetRules(id: string): Promise<ResolvedCustomRules> {
  const cached = enabledCustomPresetRules.get(id);
  if (cached) return cached;
  const response = await fetch(`/api/custom-presets/enabled/${encodeURIComponent(id)}`, { headers: authHeaders(false) });
  const data = await response.json().catch(() => ({})) as {
    error?: string;
    rules?: ResolvedCustomRules;
  };
  if (!response.ok || !data.rules) throw new Error(data.error ?? "加载预设规则失败");
  const hash = canonicalCustomRulesHash(data.rules);
  enabledCustomPresetRules.set(id, data.rules);
  customRulesCache.set(hash, data.rules);
  return data.rules;
}
function customRulesOf(target: AnyGameState | undefined | null): ResolvedCustomRules | undefined {
  if (!target || !isCustomGame(target)) return undefined;
  return (target.custom as { rules?: ResolvedCustomRules }).rules;
}

function hasPlayerCountDeckOverrides(rules: { deck?: { byPlayers?: unknown } } | undefined): boolean {
  const overrides = rules?.deck?.byPlayers;
  return Boolean(overrides && typeof overrides === "object" && !Array.isArray(overrides) && Object.keys(overrides).length > 0);
}

function currentRoomCustomRules(): ResolvedCustomRules | undefined {
  return customRulesOf(game) ?? (room?.customRulesHash ? customRulesCache.get(room.customRulesHash) : undefined);
}

function attachCustomRules(target: AnyGameState | undefined | null): void {
  if (!target || !isCustomGame(target)) return;
  const custom = target.custom as { rules?: ResolvedCustomRules; rulesHash?: string };
  if (custom.rules) return;
  const cached = custom.rulesHash ? customRulesCache.get(custom.rulesHash) : undefined;
  if (cached) custom.rules = cached;
}

function ensureCustomRulesLoaded(code: string, snapshot: AnyGameState): void {
  if (!isCustomGame(snapshot)) return;
  const hash = snapshot.custom.rulesHash;
  if (!hash) return;
  attachCustomRules(snapshot);
  if (customRulesOf(snapshot)) return;
  void (async () => {
    try {
      await loadRoomCustomRules(code, hash);
      if (isCustomGame(snapshot) && snapshot.custom.rulesHash === hash && !customRulesOf(snapshot)) {
        attachCustomRules(snapshot);
        playCustomAudioEvents(snapshot);
        if (game === snapshot) render();
      }
    } catch {
      // 拉取失败时保持现状，后续同步会重试
    }
  })();
}

type CardVisual = { cls: string; formula: string; kind: string; topColor?: string; ionColor?: string };

function cardVisual(id: CardId): CardVisual {
  const rules = customRulesOf(game);
  if (rules) {
    const def = rules.cards[id];
    if (def) {
      const charge = def.type === "ion" && def.charge ? ` · ${def.charge > 0 ? "+" : ""}${def.charge}` : "";
      return {
        cls: `custom-${def.type}`,
        formula: escapeHtml(def.displayName),
        kind: `${CUSTOM_CARD_TYPE_LABELS[def.type]}${charge}`,
        topColor: defaultTopColor(def),
        ionColor: def.type === "ion" ? def.color : undefined,
      };
    }
    return { cls: "custom-generic", formula: escapeHtml(id), kind: "未知" };
  }
  const def = CARDS[id];
  return {
    cls: def?.kind ?? "function",
    formula: formulaHtml(id),
    kind: `${kindName(def?.kind)}${def?.charge ? ` · ${def.charge > 0 ? "+" : ""}${def.charge}` : ""}`,
  };
}

function cardVisualStyle(visual: CardVisual): string {
  const parts: string[] = [];
  if (visual.topColor) parts.push(`--card-top-color:${visual.topColor}`);
  return parts.length ? ` style="${parts.join(";")}"` : "";
}

function cardFormulaStyle(id: CardId, visual: CardVisual): string {
  if (visual.ionColor) return ` style="color:${escapeAttr(visual.ionColor)}"`;
  return game && isCustomGame(game) ? "" : coloredIonStyle(id);
}

function customCardDescription(id: CardId): string | undefined {
  const rules = customRulesOf(game);
  if (!rules || Object.prototype.hasOwnProperty.call(CARDS, id)) return undefined;
  const def = rules.cards[id];
  if (!def || def.type === "ion" || !def.description?.trim()) return undefined;
  return def.description.trim();
}

function cardDescriptionAttributes(id: CardId, key: string): string {
  const description = customCardDescription(id);
  return description
    ? ` data-card-description="${escapeAttr(description)}" data-card-description-key="${escapeAttr(key)}"`
    : "";
}

function isTouchInputDevice(): boolean {
  return navigator.maxTouchPoints > 0 || window.matchMedia("(hover: none), (pointer: coarse)").matches;
}

function hideCardDescriptionBubble(): void {
  const bubble = document.querySelector<HTMLElement>("#cardDescriptionBubble");
  if (bubble) bubble.hidden = true;
}

function showCardDescriptionBubble(anchor: HTMLElement): void {
  const description = anchor.dataset.cardDescription;
  const bubble = document.querySelector<HTMLElement>("#cardDescriptionBubble");
  if (!description || !bubble) return;
  bubble.textContent = description;
  bubble.hidden = false;
  bubble.style.left = "0px";
  bubble.style.top = "0px";
  const anchorRect = anchor.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(
    window.innerWidth - bubbleRect.width - margin,
    Math.max(margin, anchorRect.left + anchorRect.width / 2 - bubbleRect.width / 2),
  );
  const fitsAbove = anchorRect.top >= bubbleRect.height + margin * 2;
  const top = fitsAbove
    ? anchorRect.top - bubbleRect.height - margin
    : Math.min(window.innerHeight - bubbleRect.height - margin, anchorRect.bottom + margin);
  bubble.style.left = `${Math.max(margin, left)}px`;
  bubble.style.top = `${Math.max(margin, top)}px`;
}

function bindCardDescriptionBubbles(): void {
  const anchors = Array.from(document.querySelectorAll<HTMLElement>("[data-card-description]"));
  if (anchors.length === 0) {
    activeTouchCardDescriptionKey = "";
    hideCardDescriptionBubble();
    return;
  }
  const touch = isTouchInputDevice();
  for (const anchor of anchors) {
    if (touch) {
      anchor.addEventListener("click", () => {
        activeTouchCardDescriptionKey = anchor.dataset.cardDescriptionKey ?? "";
        showCardDescriptionBubble(anchor);
      });
    } else {
      anchor.addEventListener("pointerenter", () => showCardDescriptionBubble(anchor));
      anchor.addEventListener("pointerleave", hideCardDescriptionBubble);
      anchor.addEventListener("focus", () => showCardDescriptionBubble(anchor));
      anchor.addEventListener("blur", hideCardDescriptionBubble);
    }
  }
  const shell = document.querySelector<HTMLElement>(".shell");
  if (touch) {
    shell?.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-card-description]") : null;
      if (target) return;
      activeTouchCardDescriptionKey = "";
      hideCardDescriptionBubble();
    });
    if (activeTouchCardDescriptionKey) {
      const active = anchors.find((anchor) => anchor.dataset.cardDescriptionKey === activeTouchCardDescriptionKey);
      if (active) requestAnimationFrame(() => showCardDescriptionBubble(active));
      else activeTouchCardDescriptionKey = "";
    }
  }
}

function rulesDraftFromResolved(rules: ResolvedCustomRules): RulesDraft {
  return customRulesSourceFromResolved(rules) as RulesDraft;
}

function resolvedFromDraft(draft: RulesDraft): ResolvedCustomRules {
  return parseCustomRules(JSON.parse(JSON.stringify(draft)));
}

async function loadRoomCustomRules(code: string, expectedHash?: string | null): Promise<ResolvedCustomRules> {
  if (expectedHash) {
    const cached = customRulesCache.get(expectedHash);
    if (cached) {
      await prepareCustomRulesForPlay(cached);
      return cached;
    }
    const browserCached = await readBrowserCachedCustomRules(expectedHash);
    if (browserCached) {
      await prepareCustomRulesForPlay(browserCached);
      return browserCached;
    }
  }
  const requestKey = expectedHash ?? `room:${code}`;
  const existing = customRulesLoadRequests.get(requestKey);
  if (existing) return existing;
  const request = (async () => {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/rules`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? "加载房间规则失败");
    const rules = data?.rules as ResolvedCustomRules | undefined;
    if (!rules) throw new Error("该房间没有自定义规则快照");
    const hash = typeof data?.hash === "string" ? data.hash : canonicalCustomRulesHash(rules);
    if ((expectedHash && hash !== expectedHash) || rules.hash !== hash || canonicalCustomRulesHash(rules) !== hash) {
      throw new Error("规则快照校验失败");
    }
    await prepareCustomRulesForPlay(rules);
    return rules;
  })();
  customRulesLoadRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (customRulesLoadRequests.get(requestKey) === request) customRulesLoadRequests.delete(requestKey);
  }
}

function customRulesBrowserCacheKey(hash: string): Request {
  return new Request(`${location.origin}/__ion-storm_custom_rules__/${encodeURIComponent(hash)}`);
}

async function readBrowserCachedCustomRules(hash: string): Promise<ResolvedCustomRules | undefined> {
  if (!("caches" in window)) return undefined;
  try {
    const response = await (await caches.open(CUSTOM_RULES_BROWSER_CACHE)).match(customRulesBrowserCacheKey(hash));
    if (!response) return undefined;
    const rules = await response.json() as ResolvedCustomRules;
    if (rules.hash !== hash || canonicalCustomRulesHash(rules) !== hash) return undefined;
    return rules;
  } catch {
    return undefined;
  }
}

async function writeBrowserCachedCustomRules(rules: ResolvedCustomRules): Promise<void> {
  if (!("caches" in window)) return;
  try {
    const cache = await caches.open(CUSTOM_RULES_BROWSER_CACHE);
    await cache.put(customRulesBrowserCacheKey(rules.hash), new Response(JSON.stringify(rules), { headers: { "content-type": "application/json" } }));
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - 12)).map((key) => cache.delete(key)));
  } catch {
    // Memory caching still guarantees the current pre-game session is ready.
  }
}

function preloadCustomRuleAudio(rules: ResolvedCustomRules): Promise<void> {
  const sources = [...new Set(Object.values(rules.cards).flatMap((def) => Object.values(def.audio ?? {})).filter(Boolean))];
  const preloads = new Map<string, HTMLAudioElement>();
  customRuleAudioPreloads.set(rules.hash, preloads);
  if (customRuleAudioPreloads.size > 12) {
    const oldest = customRuleAudioPreloads.keys().next().value as string | undefined;
    if (oldest && oldest !== rules.hash) customRuleAudioPreloads.delete(oldest);
  }
  return Promise.all(sources.map((src) => new Promise<void>((resolve) => {
    const player = new Audio();
    player.preload = "auto";
    preloads.set(src, player);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      player.removeEventListener("canplaythrough", done);
      player.removeEventListener("loadeddata", done);
      player.removeEventListener("error", done);
      resolve();
    };
    const timeout = window.setTimeout(done, 5_000);
    player.addEventListener("canplaythrough", done, { once: true });
    player.addEventListener("loadeddata", done, { once: true });
    player.addEventListener("error", done, { once: true });
    player.src = src;
    player.load();
    if (player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) done();
  }))).then(() => undefined);
}

async function prepareCustomRulesForPlay(rules: ResolvedCustomRules): Promise<void> {
  customRulesCache.set(rules.hash, rules);
  if (preparedCustomRulesHashes.has(rules.hash)) return;
  const existing = customRulesPrepareRequests.get(rules.hash);
  if (existing) return existing;
  const request = Promise.all([writeBrowserCachedCustomRules(rules), preloadCustomRuleAudio(rules)]).then(() => {
    preparedCustomRulesHashes.add(rules.hash);
  });
  customRulesPrepareRequests.set(rules.hash, request);
  try {
    await request;
  } finally {
    if (customRulesPrepareRequests.get(rules.hash) === request) customRulesPrepareRequests.delete(rules.hash);
  }
}

function prefetchRoomCustomRules(target: RoomSummary): void {
  if (target.rulesetMode !== "custom" || !target.customRulesHash || preparedCustomRulesHashes.has(target.customRulesHash)) return;
  const expectedHash = target.customRulesHash;
  void loadRoomCustomRules(target.code, expectedHash).then(() => {
    if (room?.code === target.code && room.customRulesHash === expectedHash) render();
  }).catch(() => {
    // A later room sync or manual refresh retries before confirmation is allowed.
  });
}

function currentViewableRules(): ResolvedCustomRules | undefined {
  const fromGame = customRulesOf(game);
  if (fromGame) return fromGame;
  if (room?.customRulesHash) return customRulesCache.get(room.customRulesHash);
  return undefined;
}

function downloadTextFile(name: string, text: string, type = "application/json;charset=utf-8"): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function rulesDraftFromImportedSource(source: unknown): RulesDraft {
  const resolved = parseCustomRules(source, {
    presets: {
      get(id) {
        if (id !== PLATFORM_PRESET.name) return undefined;
        return { source: rulesDraftFromResolved(PLATFORM_PRESET) };
      },
    },
  });
  return rulesDraftFromResolved(resolved);
}

function blankRulesDraft(): RulesDraft {
  return {
    version: 4,
    name: `Blank_${Date.now().toString(36)}`,
    displayName: "空白规则",
    setup: {},
    cards: JSON.parse(JSON.stringify(PLATFORM_PRESET.cards)) as Record<string, CustomCardDef>,
    combos: {},
    deck: { cards: {} },
  };
}

function draftOrderCompare(draft: RulesDraft): (a: string, b: string) => number {
  return displayOrderComparator({ cards: draft.cards, display: draft.display });
}

function draftDisplayOrder(draft: RulesDraft): string[] {
  return effectiveDisplayOrder({ cards: draft.cards, display: draft.display });
}

function customCardCategoryKey(def: CustomCardDef): string {
  return def.type === "ion" ? (def.charge < 0 ? "anion" : "cation") : def.type;
}

function customCardCategoryLabel(def: CustomCardDef): string {
  if (def.type === "ion") return def.charge < 0 ? "阴离子" : "阳离子";
  return CUSTOM_CARD_TYPE_LABELS[def.type];
}

const NEW_CARD_CATEGORIES = ["cation", "anion", "operation", "special", "generic"] as const;
type NewCardCategory = (typeof NEW_CARD_CATEGORIES)[number];
const NEW_CARD_CATEGORY_LABELS: Record<NewCardCategory, string> = {
  cation: "阳离子",
  anion: "阴离子",
  operation: CUSTOM_CARD_TYPE_LABELS.operation,
  special: CUSTOM_CARD_TYPE_LABELS.special,
  generic: CUSTOM_CARD_TYPE_LABELS.generic,
};

function newCardCategoryDefaults(category: NewCardCategory): { type: CustomCardDef["type"]; charge?: number; color: string } {
  const base = category === "cation"
    ? ({ type: "ion", charge: 1 } as CustomCardDef)
    : category === "anion"
      ? ({ type: "ion", charge: -1 } as CustomCardDef)
      : ({ type: category } as CustomCardDef);
  return { type: base.type, charge: base.type === "ion" ? base.charge : undefined, color: defaultTopColor(base) };
}

function renderDisplayOrderItem(def: CustomCardDef | undefined, id: string, index: number, options: { draggable?: boolean } = {}): string {
  const color = def ? defaultTopColor(def) : "#c3cad1";
  const category = def ? customCardCategoryKey(def) : "unknown";
  const draggable = Boolean(options.draggable);
  return `<div class="display-order-item ${draggable ? "" : "readonly"}" ${draggable ? `draggable="true" data-card-id="${escapeAttr(id)}"` : ""}><span class="order-color" style="background:${escapeAttr(color)}"></span>${draggable ? `<span class="drag-handle">☰</span>` : ""}<span class="order-index">${index + 1}</span><span class="order-name">${escapeHtml(def?.displayName ?? id)}</span><small class="order-cat cat-${escapeAttr(category)}">${escapeHtml(def ? customCardCategoryLabel(def) : "未定义")}</small></div>`;
}

const LOG_ION_FORMATS = Object.keys(FORMULA_HTML)
  .filter((card) => isIon(card))
  .map((card) => ({ label: LABELS[card], html: FORMULA_HTML[card] }))
  .sort((a, b) => b.label.length - a.label.length);

const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2_000;
const WEBSOCKET_RECONCILE_INTERVAL_MS = 5_000;
const WEBSOCKET_RETRY_INTERVAL_MS = 10_000;
const HTTP_FALLBACK_POLL_INTERVAL_MS = 6_000;
const HTTP_POLL_HIDDEN_MIN_DELAY_MS = 20_000;
const HTTP_POLL_PLAYING_MIN_DELAY_MS = 5_000;
const HTTP_POLL_LOBBY_MIN_DELAY_MS = 10_000;
const HTTP_PRESENCE_SYNC_INTERVAL_MS = 20_000;

type PublicUser = {
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

type DuelLimitPeriod = "none" | "hour" | "day" | "week" | "unlimited";
type DuelLimitRule = { period: DuelLimitPeriod; count: number | null };

type PermissionRule = {
  exchangeMin: number;
  exchangeMax: number | null;
  canCreateZeroBaseBet: boolean;
  maxBaseBet: number | null;
  duelLimit: DuelLimitRule;
};

type RoomSummary = {
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
type RoomEditNotice = {
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

type SetupModal = {
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
type JoinModal = { kind: "join"; code: string; error?: string };
type AuthModal = { kind: "auth"; mode: "login" | "register"; username: string; inviteCode?: string; reservedRoomCode?: string; error?: string };
type ActionChoiceModal = {
  kind: "actions";
  title: string;
  titleHtml?: string;
  actions: RulesetAction[];
  forced?: boolean;
  drawPrompt?: boolean;
  submitting?: boolean;
  stateRevision?: number;
};
type CreditsModal = { kind: "credits" };
type ModalState = SetupModal | JoinModal | AuthModal | ActionChoiceModal | CreditsModal | null;
type InvitationCode = {
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
type ActivationUsePolicy = "unlimited" | "global-total" | "per-user-total" | "global-window" | "per-user-window";
type ActivationTitleMode = "default" | "fixed" | "user-custom";
type ActivationNicknameColorMode = ActivationTitleMode;
type ActivationCode = {
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
type UserRequestView = {
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
type WinMusicManifestEntry = {
  userId: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha1: string;
  sha256: string;
};
type ProtectedAction =
  | { kind: "update-user"; userId: string; patch: Record<string, unknown> }
  | { kind: "delete-user"; userId: string }
  | { kind: "upload-music"; userId: string; file: File; durationSeconds: number }
  | { kind: "delete-music"; userId: string };
type RulesEditorTab = "cards" | "deck" | "deal" | "display" | "basic" | "json";
type PlayerDeckOverride = {
  cards?: Record<string, number>;
  deal?: CustomDealSeatRule[];
};
type RulesDraft = {
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
type DialogState =
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
  | { kind: "leave-room"; local: boolean; error?: string }
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
  | { kind: "confirm-logout" }
  | null;
type DrawAnimation = {
  id: string;
  seatId: string;
  count: number;
  opening: boolean;
  startedAt: number;
  duration: number;
};
type InteractiveElementState = {
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
type InteractionSnapshot = {
  scope: string;
  elements: InteractiveElementState[];
  activeKey?: string;
  windowX: number;
  windowY: number;
};

const app = document.querySelector<HTMLDivElement>("#app")!;
const audio = createAudio();
const WIN_MUSIC_CACHE_NAME = "ion-storm-win-music-v1";
const DEVICE_ID_KEY = "ionStormDeviceId";
const deviceId = ensureDeviceId();
const browserFingerprint = buildBrowserFingerprint();
let game: ClientGame | undefined;
let room: RoomSummary | undefined;
let duelCooldownUntil = 0;
let socket: WebSocket | undefined;
let selfId = localStorage.getItem("ionStormPlayerId") ?? "";
let authToken = localStorage.getItem("ionStormAuthToken") ?? "";
let currentUser: PublicUser | undefined;
let selectedCard: CardId | "all" = "all";
let selectedHandIndex: number | null = null;
let mode: "local" | "online" = "local";
let timerInterval = 0;
let lastBotTurn = "";
let modal: ModalState = null;
let dialog: DialogState = null;
let managedUsers: PublicUser[] = [];
let userPageError = "";
let invitations: InvitationCode[] = [];
let invitePageError = "";
let permissionsSnapshot: { rolePermissions: Record<UserRole, PermissionRule>; userPermissions: Record<string, Partial<PermissionRule>> } | undefined;
let customModeLimitsSnapshot: CustomModeLimits | undefined;
const reservedRoomCodesByUser = new Map<string, string[]>();
let taxSettings: { taxRatePercent: number; taxWinnerPointsThreshold?: number } | undefined;
let activationCodes: ActivationCode[] = [];
let activationRegisteredUserCount = 0;
let activationPageError = "";
let requests: UserRequestView[] = [];
let requestSeenThrough = 0;
let ticketPageError = "";
let leaderboard: LeaderboardResult | undefined;
let leaderboardError = "";
let passwordConfirm: { action: ProtectedAction; error?: string } | null = null;
let accountMenuOpen = false;
let pendingOnlineBots = 0;
let dismissedWinnerId = "";
let waitingForOnlineRematch = false;
let watchedSeatId = "";
let animatedSeatIds = new Set<string>();
let animatedDrawCounts = new Map<string, number>();
let dealAnimationUntil = 0;
let landingAnimationUntil = 0;
let drawAnimations: DrawAnimation[] = [];
let pollInterval = 0;
let reconcileInterval = 0;
let heartbeatInterval = 0;
let httpFallback = false;
let websocketFallbackTimer = 0;
let websocketRetryTimer = 0;
let roomStatePollPromise: Promise<void> | undefined;
let refreshPending = false;
let lastRefreshRequestId = "";
let lastRoomStatePollAt = 0;
let lastPresenceSyncAt = 0;
let localBotTimer = 0;
let localBotDeadline = 0;
let dealAnimationTimer = 0;
let gameContextVersion = 0;
let roomJoinVersion = 0;
let serverClock: { serverNow: number; clientNow: number } | undefined;
let lastSoundKey = "";
let lastTickKey = "";
let lastRoomEditNoticeId = "";
let roomExitInFlight = false;
let lastWinMusicGameId = "";
let activeWinMusic: HTMLAudioElement | undefined;
let activeWinMusicUrl = "";
const winMusicPrefetches = new Map<string, Promise<void>>();
let storagePersistenceRequested = false;
let openingExchangeTimer = 0;
let cardClickTimer = 0;
let activeTouchCardDescriptionKey = "";
let modalActionSubmissionTimer = 0;
let openingSelectionKey = "";
let openingExchangeSelection = new Set<number>();
let advancedAiEnabled = false;
let advancedAiStatus: "idle" | "computing" | "complete" = "idle";
let advancedAiSuggestion:
  | {
    gameId: string;
    revision: number;
    playerId: string;
    action: ActionIntent;
    recommendation: AdvancedAiRecommendation;
  }
  | undefined;
let advancedAiWorker: Worker | undefined;
let advancedAiRequestId = 0;
let advancedAiCalculationKey = "";
let advancedAiLevel: AdvancedAiLevel = readAdvancedAiLevel();

function roomCodeFromLocation(): string | undefined {
  const match = /^\/room\/(\d+)\/?$/.exec(location.pathname);
  return match?.[1];
}

function moveToRoomUrl(code: string, replace = false): void {
  const target = `/room/${encodeURIComponent(code)}`;
  if (location.pathname === target) return;
  history[replace ? "replaceState" : "pushState"]({}, "", target);
}

/** Joins deep links only after auth is known, so anonymous visitors never enter a room as guests. */
async function joinRoomFromLocation(): Promise<void> {
  const code = roomCodeFromLocation();
  if (!code || !currentUser) return;
  if (mode === "online" && room?.code === code) return;
  if (modal?.kind === "auth") modal = null;
  await joinRoom(code);
}

if (!authToken && roomCodeFromLocation()) {
  modal = { kind: "auth", mode: "login", username: "", error: "请先登录后加入联机房间" };
} else if (!authToken && localStorage.getItem("ionStormGuestOk") !== "1") modal = { kind: "auth", mode: "login", username: "" };
render();
void refreshAuth();
window.addEventListener("popstate", () => {
  const requested = roomCodeFromLocation();
  if (mode === "online" && room && requested !== room.code) {
    moveToRoomUrl(room.code, true);
    toast("请先退出当前房间，再加入其他房间");
    render();
    return;
  }
  if (requested && !currentUser) modal = { kind: "auth", mode: "login", username: "", error: "请先登录后加入联机房间" };
  render();
  void joinRoomFromLocation();
});

window.render_game_to_text = () =>
  JSON.stringify({
    mode,
    room: room?.code,
    banker: room?.bankerPlayerId,
    gameId: game?.id,
    revision: game?.revision,
    status: game?.status,
    selfId,
    currentPlayer: game ? activeSeat()?.id : undefined,
    currentSeat: game ? activeSeat()?.nickname : undefined,
    actionPoints: game?.actionPoints,
    deck: game?.zones.drawPile.length,
    solutionCount: game?.zones.solution.length,
    productCount: game?.zones.products.length,
    zones: game
      ? {
        solution: game.zones.solution.map(cardIdOf),
        products: game.zones.products.map((product) => ({ kind: product.kind, cards: product.cards.map(cardIdOf) })),
        discardCount: game.zones.discard.length,
        drawPileCount: game.zones.drawPile.length,
      }
      : undefined,
    seats: game?.players.map((p) => ({
      name: p.nickname,
      hand: p.hand.length,
      online: p.online,
      automatic: Boolean(p.bot),
      active: game ? p.id === activeSeat()?.id : false,
    })),
  });
window.advanceTime = () => renderTimer();

function render(): void {
  if (location.pathname === "/user") {
    renderUserPage();
    return;
  }
  if (location.pathname === "/invite") {
    renderInvitePage();
    return;
  }
  if (location.pathname === "/activation") {
    renderActivationPage();
    return;
  }
  if (location.pathname === "/ticket") {
    renderTicketPage();
    return;
  }
  if (location.pathname === "/leaderboard") {
    renderLeaderboardPage();
    return;
  }
  syncDrawModal();
  const requestNotice = renderRequestNotice();
  const interaction = captureInteractionSnapshot();
  app.innerHTML = `
    <div class="shell ${requestNotice ? "has-request-notice" : ""}">
      <header class="topbar">
        <div class="brand">
          <button class="mark" type="button" data-act="open-credits" aria-label="查看项目信息">Ion</button>
          <div><h1>离子风暴</h1><span>130 张化学反应牌 · 本地与联机</span></div>
        </div>
        <div id="timer" class="timer"><strong>--</strong><span>当前回合</span></div>
        <div class="top-actions">
          ${renderAccountControls()}
          <button class="btn" data-act="sound">${audio.enabled ? "音效开" : "音效关"}</button>
          <button class="btn" data-act="open-local">本地游戏</button>
          <button class="btn primary" data-act="open-online">联机游戏</button>
          <button class="btn" data-act="open-join">加入房间</button>
        </div>
      </header>
      ${requestNotice}
      <main class="layout">
        ${renderSidebar()}
        <section class="main">
          ${renderRoomPanel()}
          <div class="play-wrap">
            ${renderBoard()}
            ${renderHandbar()}
          </div>
        </section>
      </main>
      ${renderDrawAnimations()}
      <div id="cardDescriptionBubble" class="card-description-bubble" role="tooltip" hidden></div>
      ${renderModal()}
      ${renderDialog()}
      ${renderPasswordConfirm()}
      ${renderOpeningExchangeModal()}
      ${renderWinModal()}
    </div>
  `;
  scheduleLocalOpeningExchange();
  bind();
  renderTimer();
  restoreInteractionSnapshot(interaction);
  maybeRunBot();
  scheduleAdvancedAiCalculation();
}

function renderRulesEditorPreservingScroll(): void {
  const selectors = [".rules-editor-dialog", ".rules-table-wrap", ".rules-card-list"];
  const positions = selectors.map((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    return element ? { selector, top: element.scrollTop, left: element.scrollLeft } : undefined;
  });
  render();
  for (const position of positions) {
    if (!position) continue;
    const element = document.querySelector<HTMLElement>(position.selector);
    if (!element) continue;
    element.scrollTop = position.top;
    element.scrollLeft = position.left;
  }
}

function renderRoomRulesPreservingScroll(): void {
  const selectors = [".rules-view-dialog", ".rules-card-list"];
  const positions = selectors.map((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    return element ? { selector, top: element.scrollTop, left: element.scrollLeft } : undefined;
  });
  const windowPosition = { x: window.scrollX, y: window.scrollY };
  render();
  for (const position of positions) {
    if (!position) continue;
    const element = document.querySelector<HTMLElement>(position.selector);
    if (!element) continue;
    element.scrollTop = position.top;
    element.scrollLeft = position.left;
  }
  window.scrollTo(windowPosition.x, windowPosition.y);
}

function renderSetupModalPreservingScroll(): void {
  const selectors = [".modal-backdrop", ".modal"];
  const positions = selectors.map((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    return element ? { selector, top: element.scrollTop, left: element.scrollLeft } : undefined;
  });
  const windowPosition = { x: window.scrollX, y: window.scrollY };
  render();
  for (const position of positions) {
    if (!position) continue;
    const element = document.querySelector<HTMLElement>(position.selector);
    if (!element) continue;
    element.scrollTop = position.top;
    element.scrollLeft = position.left;
  }
  window.scrollTo(windowPosition.x, windowPosition.y);
}

function renderScopeKey(): string {
  const modalKey = modal
    ? modal.kind === "auth"
      ? `auth:${modal.mode}`
      : modal.kind === "local" || modal.kind === "online"
        ? `${modal.kind}:${modal.ruleset}:${modal.customPresetId ?? (modal.customBlank ? "blank" : "classic")}`
        : modal.kind === "actions"
          ? `actions:${modal.title}:${Boolean(modal.drawPrompt)}`
          : modal.kind
    : "";
  const dialogKey = dialog
    ? dialog.kind === "rules-editor"
      ? `${dialog.kind}:${dialog.target}:${dialog.tab}:${dialog.selectedCardId ?? "none"}:${dialog.jsonRevision ?? 0}`
      : dialog.kind === "view-room-rules"
        ? `${dialog.kind}:${dialog.selectedCardId ?? "none"}`
        : "userId" in dialog
          ? `${dialog.kind}:${dialog.userId}`
          : "code" in dialog
            ? `${dialog.kind}:${dialog.code ?? "new"}`
            : "requestId" in dialog
              ? `${dialog.kind}:${dialog.requestId}`
              : "playerId" in dialog
                ? `${dialog.kind}:${dialog.playerId}`
                : dialog.kind
    : "";
  const passwordKey = passwordConfirm ? passwordConfirm.action.kind : "";
  const openingKey = game?.status === "opening-exchange" ? `${game.id}:${openingExchangePlayer()?.id ?? "waiting"}` : "";
  const winKey = game?.status === "ended" && game.winnerId && dismissedWinnerId !== game.winnerId ? `${game.id}:${game.winnerId}` : "";
  return [location.pathname, modalKey, dialogKey, passwordKey, openingKey, winKey].join("|");
}

function captureInteractionSnapshot(): InteractionSnapshot | undefined {
  const scope = renderScopeKey();
  if (app.dataset.renderScope !== scope) return undefined;
  const active = document.activeElement instanceof HTMLElement && app.contains(document.activeElement) ? document.activeElement : undefined;
  const elements: InteractiveElementState[] = [];
  app.querySelectorAll<HTMLElement>("input, select, textarea, [contenteditable], details, *").forEach((element) => {
    const isControl =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement ||
      element.isContentEditable ||
      element instanceof HTMLDetailsElement;
    const hasScroll = element.scrollTop !== 0 || element.scrollLeft !== 0;
    if (!isControl && !hasScroll) return;
    const key = interactionElementKey(element);
    const state: InteractiveElementState = { key };
    if (element instanceof HTMLInputElement) {
      if (element.type !== "file") state.value = element.value;
      if (element.type === "checkbox" || element.type === "radio") state.checked = element.checked;
      if (supportsTextSelection(element)) {
        state.selectionStart = element.selectionStart;
        state.selectionEnd = element.selectionEnd;
        state.selectionDirection = element.selectionDirection;
      }
    } else if (element instanceof HTMLSelectElement) {
      state.value = element.value;
    } else if (element instanceof HTMLTextAreaElement) {
      state.value = element.value;
      state.selectionStart = element.selectionStart;
      state.selectionEnd = element.selectionEnd;
      state.selectionDirection = element.selectionDirection;
    } else if (element instanceof HTMLDetailsElement) {
      state.open = element.open;
    } else if (element.isContentEditable) {
      state.value = element.innerHTML;
    }
    if (hasScroll) {
      state.scrollTop = element.scrollTop;
      state.scrollLeft = element.scrollLeft;
    }
    elements.push(state);
  });
  return {
    scope,
    elements,
    activeKey: active ? interactionElementKey(active) : undefined,
    windowX: window.scrollX,
    windowY: window.scrollY,
  };
}

function restoreInteractionSnapshot(snapshot?: InteractionSnapshot): void {
  const scope = renderScopeKey();
  app.dataset.renderScope = scope;
  if (!snapshot || snapshot.scope !== scope) return;
  const byKey = new Map<string, HTMLElement>();
  app.querySelectorAll<HTMLElement>("*").forEach((element) => byKey.set(interactionElementKey(element), element));
  for (const state of snapshot.elements) {
    const element = byKey.get(state.key);
    if (!element) continue;
    if (element instanceof HTMLInputElement) {
      if (state.value !== undefined && element.type !== "file" && !element.hasAttribute("data-state-value")) element.value = state.value;
      if (state.checked !== undefined) element.checked = state.checked;
    } else if (element instanceof HTMLSelectElement) {
      if (
        state.value !== undefined &&
        !element.hasAttribute("data-state-value") &&
        Array.from(element.options).some((option) => option.value === state.value)
      ) element.value = state.value;
    } else if (element instanceof HTMLTextAreaElement) {
      if (state.value !== undefined && !element.hasAttribute("data-state-value")) element.value = state.value;
    } else if (element instanceof HTMLDetailsElement && state.open !== undefined) {
      element.open = state.open;
    } else if (element.isContentEditable && state.value !== undefined) {
      element.innerHTML = state.value;
    }
  }
  syncConditionalFieldVisibility();
  for (const state of snapshot.elements) {
    const element = byKey.get(state.key);
    if (!element) continue;
    if (state.scrollTop !== undefined) element.scrollTop = state.scrollTop;
    if (state.scrollLeft !== undefined) element.scrollLeft = state.scrollLeft;
  }
  const active = snapshot.activeKey ? byKey.get(snapshot.activeKey) : undefined;
  if (active) {
    active.focus({ preventScroll: true });
    const state = snapshot.elements.find((item) => item.key === snapshot.activeKey);
    if (
      state?.selectionStart !== undefined &&
      state.selectionEnd !== undefined &&
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
    ) {
      active.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection ?? undefined);
    }
  }
  window.scrollTo(snapshot.windowX, snapshot.windowY);
}

function syncConditionalFieldVisibility(): void {
  if (document.getElementById("requestKind")) updateRequestFields(selectValue("requestKind") ?? "ticket");
  if (document.getElementById("editPermissionMode")) updateEditUserFields();
  if (document.getElementById("banAccountMode")) updateBanFields();
  if (document.getElementById("inviteUsePolicy")) updateInvitationUsageFields();
  if (document.getElementById("inviteRole")) updateInvitationGrantFields();
  if (document.getElementById("invitePermissionMode")) updateInvitationPermissionFields();
  if (document.getElementById("inviteAdvancedAiGrant")) updateAdvancedAiGrantFields("invite");
  if (document.getElementById("activationPolicy")) {
    updateActivationFields();
    updateActivationGrantFields("Admin");
    updateActivationGrantFields("Advanced");
    updateAdvancedAiGrantFields("activation");
  }
  if (document.getElementById("inviteTaxRateMode")) updateInvitationTaxFields();
  if (document.getElementById("activationTaxRateMode")) updateActivationTaxFields();
  ["edit", "invite", "activation", "perm"].forEach((prefix) => {
    updateDuelLimitFields(prefix);
    updateCustomLimitFields(prefix);
  });
  updatePartialPermissionFields("activation");
  if (document.getElementById("pointDistributionExpiryMode")) updatePointDistributionFields();
  if (document.getElementById("bulkGrantMode")) updateBulkGrantHints();
}

function interactionElementKey(element: HTMLElement): string {
  if (element.id) return `id:${element.id}`;
  if (element.dataset.uiKey) return `ui:${element.dataset.uiKey}`;
  const named = element.getAttribute("name");
  if (named) return `name:${named}`;
  const parts: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== app) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) break;
    const index = Array.from(parent.children).indexOf(current);
    parts.push(`${current.tagName.toLowerCase()}:${index}`);
    current = parent;
  }
  return `path:${parts.reverse().join("/")}`;
}

function supportsTextSelection(input: HTMLInputElement): boolean {
  return ["text", "search", "url", "tel", "password"].includes(input.type);
}

function renderRequestNotice(): string {
  if (!currentUser || requests.length === 0) return "";
  if (isAdminUser(currentUser)) {
    const openCount = requests.filter((request) => request.status === "open" && request.createdAt > requestSeenThrough).length;
    const reviewedCount = currentUser.superAdmin
      ? requests.filter((request) => request.status !== "open" && (request.repliedAt ?? 0) > requestSeenThrough).length
      : 0;
    if (openCount === 0 && reviewedCount === 0) return "";
    return `<div class="request-notice"><strong>${openCount ? `${openCount} 个待处理申请` : "暂无待处理申请"}</strong>${reviewedCount ? `<span>${reviewedCount} 个申请已有批复记录</span>` : ""
      }<button class="btn primary" data-act="go-ticket">查看工单</button></div>`;
  }
  const latest = [...requests]
    .filter((request) => request.status !== "open" && (request.repliedAt ?? 0) > requestSeenThrough)
    .sort((a, b) => (b.repliedAt ?? 0) - (a.repliedAt ?? 0))[0];
  if (!latest) return "";
  return `<div class="request-notice"><strong>${escapeHtml(requestKindLabel(latest.kind))}已处理</strong><span>${escapeHtml(
    latest.reply || requestStatusLabel(latest.status),
  )}</span><button class="btn primary" data-act="ack-request-notice">已查看</button></div>`;
}

function renderAccountControls(): string {
  if (!currentUser) return `<button class="btn" data-act="open-auth">注册/登录</button>`;
  const hideExit = isOnlineGameRunning();
  return `
    <div class="account-menu">
      <button class="btn account-chip" data-act="toggle-account-menu" aria-expanded="${accountMenuOpen}">
        <span style="color:${escapeAttr(currentUser.nicknameColor)}">${escapeHtml(currentUser.nickname)}</span>
      </button>
      ${accountMenuOpen
      ? `<div class="account-menu-popover">
              <button class="btn" data-act="open-users">用户管理</button>
              <button class="btn" data-act="go-ticket">工单管理</button>
              ${hideExit ? "" : `<button class="btn danger" data-act="request-logout">退出登录</button>`}
            </div>`
      : ""
    }
    </div>
    <button class="btn" data-act="open-leaderboard">排行榜</button>
  `;
}

function renderSidebar(): string {
  const seats = game?.players ?? room?.players ?? [];
  const deckCount = game ? game.zones.drawPile.length : totalCards();
  const discardCount = game ? game.zones.discard.length : 0;
  const inspectRender = (() => {
    if (!game || !isCustomGame(game)) return { queueByLine: new Map<string, string[]>(), legacyHtml: "" };
    const viewerId = game.mode === "online" ? selfId : rulesetCurrentPlayer(game).id;
    const visible = game.custom.inspectReveals.filter((reveal) => reveal.playerId === viewerId);
    const queueByLine = new Map<string, string[]>();
    const legacy: string[] = [];
    // 新揭示按时间倒序依次贴到日志中从上往下每条“使用X”行的下一条
    for (let index = visible.length - 1; index >= 0; index--) {
      const reveal = visible[index];
      const html = `<div class="inspect-reveal">${escapeHtml(reveal.cardName ?? "焰色")}结果（仅你可见）：${escapeHtml(reveal.text)}</div>`;
      if (!reveal.line) {
        legacy.push(html);
        continue;
      }
      const queue = queueByLine.get(reveal.line) ?? [];
      queue.push(html);
      queueByLine.set(reveal.line, queue);
    }
    return { queueByLine, legacyHtml: legacy.slice(-5).join("") };
  })();
  const logHtml = (game?.log ?? ["等待开始"])
    .map((line) => {
      const queue = inspectRender.queueByLine.get(line);
      const attached = queue && queue.length > 0 ? queue.shift()! : "";
      return `<div>${renderGameLog(line)}</div>${attached}`;
    })
    .join("");
  return `
    <aside class="sidebar panel">
      <div class="section-title"><span>席位</span><span>${seats.length || 0}/10</span></div>
      <div class="player-list">
        ${seats.length
      ? seats
        .map((p, index) => {
          const terminal = game?.status === "ended";
          const viewedSeat = terminal ? visibleSeat() : undefined;
          const active = terminal ? viewedSeat?.id === p.id : game && index === game.currentPlayer;
          const handCount = "hand" in p ? p.hand.length : p.handCount;
          const automatic = Boolean(p.bot);
          const status = automatic ? "机器人" : p.online ? "在线" : "离线";
          const readyToStart =
            ("readyToStart" in p && Boolean(p.readyToStart)) ||
            Boolean(room?.players.find((member) => member.id === p.id)?.readyToStart);
          const showReady = room?.status === "lobby" || room?.status === "ended";
          const ready = mode === "online" && showReady && !automatic ? ` · ${readyToStart ? "已确认" : "未确认"}` : "";
          const subtitle = p.profile?.subtitle;
          const showPoints =
            typeof p.profile?.points === "number" &&
            (mode === "online" ? Boolean(p.accountId) && !automatic : Boolean(currentUser && p.accountId === currentUser.id));
          const points = showPoints ? ` · 积分 ${p.profile!.points}` : "";
          const isCreator = Boolean(room && p.accountId && p.accountId === room.creatorAccountId);
          const isBanker = Boolean(mode === "online" && room?.bankerPlayerId === p.id);
          const roleBadges = `${isCreator ? `<span class="owner-badge">房主</span>` : ""}${isBanker ? `<span class="banker-badge">庄家</span>` : ""}`;
          const roleBadgeClass = "role-badges";
          const isRoomMember = Boolean(room?.players.some((member) => member.id === p.id));
          const canKick = Boolean(
            room &&
            currentUser?.id === room.creatorAccountId &&
            (room.status === "lobby" || room.status === "ended") &&
            isRoomMember &&
            p.id !== selfId,
          );
          const canLeave = Boolean(room && !isOnlineGameRunning() && currentUser?.id !== room.creatorAccountId && isRoomMember && p.id === selfId);
          const canCancelAutoplay = Boolean(mode === "online" && p.id === selfId && !automatic && p.forcedAutoplay);
          return `<div class="player ${active ? "active" : ""} ${terminal ? "selectable" : ""} ${isSeatAnimating(p.id) ? "drawing" : ""}" ${terminal ? `data-seat-id="${escapeAttr(p.id)}"` : ""}>
                    <div class="player-main">${renderPlayerName(p)}${roleBadges ? `<span class="${roleBadgeClass}">${roleBadges}</span>` : ""}${subtitle ? `<br><small class="user-title">${escapeHtml(subtitle)}</small>` : ""}<br><small>${status}${ready} · 手牌 ${handCount}${points}${p.forcedAutoplay ? " · 托管" : ""}</small></div>
                    <div class="player-tools"><span class="status-dot ${p.online || automatic ? "online" : ""}"></span>${canCancelAutoplay ? `<button class="player-kick" data-act="cancel-autoplay">取消托管</button>` : ""}${canKick ? `<button class="player-kick" data-act="kick-room-player" data-player-id="${escapeAttr(p.id)}" aria-label="移出 ${escapeAttr(p.nickname)}">移出</button>` : ""}${canLeave ? `<button class="player-kick" data-act="leave-room" aria-label="退出房间">退出</button>` : ""}</div>
                  </div>`;
        })
        .join("")
      : `<div class="player"><div><strong>空席位</strong><br><small>从顶部选择游戏模式</small></div><span class="status-dot"></span></div>`
    }
      </div>
      <hr>
      <div class="section-title"><span>牌库</span><span>${deckCount} 张</span></div>
      <div class="section-title"><span>弃牌堆</span><span>${discardCount} 张</span></div>
      <div class="log">${inspectRender.legacyHtml}${logHtml}</div>
    </aside>
  `;
}

function renderRoomPanel(): string {
  if (!room) {
    const localStatus = game?.mode === "local" && game.status === "playing";
    const active = game ? activeSeat() : undefined;
    return `
      <section class="room-panel panel">
        <div>
          <div class="section-title"><span>${localStatus ? "本地对局" : "对局入口"}</span><span>${localStatus ? "进行中" : "待开始"}</span></div>
          <div class="room-stats">
            <span>当前：${active ? renderPlayerName(active) : "无"}</span>
            <span>出牌机会：${game?.actionPoints ?? 0}</span>
            <span>牌库：${game?.zones.drawPile.length ?? totalCards()}</span>
            <span>生成物：${game?.zones.products.length ?? 0}</span>
            ${game?.pendingDraw ? `<span>待拿牌：${game.pendingDraw.remaining}</span>` : ""}
          </div>
        </div>
        ${game ? `<div class="top-actions"><button class="player-kick room-exit" data-act="leave-room">退出</button>${game && isCustomGame(game) ? `<button class="btn" data-act="view-room-rules">查看规则设置</button>` : ""}${renderAdvancedAiButton()}${game.status === "ended" ? `<button class="btn" data-act="export-game-log">导出日志</button>` : ""}</div>` : ""}
      </section>
    `;
  }
  const humanCount = room.players.filter((p) => !p.bot).length;
  const readyPlayers = room.players.filter((p) => !p.bot && p.readyToStart).length;
  const canConfirm = room.players.length === room.capacity && room.players.length >= 2 && (room.status === "lobby" || room.status === "ended");
  const selfReady = Boolean(room.players.find((p) => p.id === selfId)?.readyToStart);
  const customRulesLocallyReady = room.rulesetMode !== "custom"
    || Boolean(room.customRulesHash && preparedCustomRulesHashes.has(room.customRulesHash));
  const active = game ? activeSeat() : undefined;
  const duelRematchBlocked = Boolean(room.duelMode && room.status === "ended" && !room.duelKeepAvailable);
  const startButtonLabel =
    room.status === "playing" || room.status === "opening-exchange"
      ? "游戏已开始"
      : !customRulesLocallyReady
        ? "正在下载规则…"
      : selfReady
        ? "已确认，等待其他人"
        : room.status === "ended"
          ? "再来一局"
          : "确认开始";
  const startButtonEnabled = canConfirm && customRulesLocallyReady && !selfReady && !duelRematchBlocked;
  const roomPresetId = room.rulesetMode === "custom" ? room.customPresetId : undefined;
  const roomPresetLabel = roomPresetId
    ? `预设 ${enabledCustomPresets.find((preset) => preset.id === roomPresetId)?.displayName ?? roomPresetId}`
    : "";
  return `
    <section class="room-panel panel">
      <div>
        <div class="section-title"><span>联机房间</span><span>${room.status === "opening-exchange" ? "换牌中" : room.status === "playing" ? "进行中" : room.status === "ended" ? "已结束" : "等待中"}</span></div>
        <div class="room-identity-row">
          <strong class="room-code ${(room.codeKind === "reserved" || room.roomCodeKind === "reserved" || room.isReservedRoomCode) ? "reserved-room-code" : ""}">${room.code}</strong>
          ${room.rulesetMode === "custom" ? `<span class="duel-badge custom-mode-badge">自定义模式</span>` : ""}
          ${roomPresetLabel ? `<span class="duel-badge custom-preset-badge">${escapeHtml(roomPresetLabel)}</span>` : ""}
          ${room.duelMode ? `<span class="duel-badge">决斗模式</span>` : ""}
          ${isCardWarRoom(room) ? `<span class="duel-badge card-war-badge">算牌大战</span>` : ""}
        </div>
        <div class="room-stats">
          <span>真人 ${humanCount}</span>
          <span>底注 ${room.baseBet ?? 5}</span>
          ${room.rulesetMode === "custom" ? `<span>初始手牌 ${room.initialHandSize ?? "由规则决定"}</span>` : room.initialHandSize ? `<span>初始手牌 ${room.initialHandSize}</span>` : ""}
          ${room.rulesetMode === "custom" ? `<span>规则 ${customRulesLocallyReady ? "已缓存" : "下载中"}</span>` : ""}
          <span>出牌 ${room.turnTimeLimitSec ?? DEFAULT_TURN_TIME_LIMIT_SEC}秒</span>
          <span>换牌 ${room.openingExchangeSec ?? DEFAULT_OPENING_EXCHANGE_SEC}秒</span>
          ${game?.scoring ? `<span>累计积分 ${game.scoring.total ?? game.scoring.stake}</span>` : ""}
          <span>确认 ${readyPlayers}/${humanCount}</span>
          <span>席位 ${room.players.length}/${room.capacity}</span>
          <span>当前：${active ? renderPlayerName(active) : "无"}</span>
          <span>出牌机会：${game?.actionPoints ?? 0}</span>
          <span>牌库：${game?.zones.drawPile.length ?? totalCards()}</span>
          ${game?.pendingDraw ? `<span>待拿牌：${game.pendingDraw.remaining}</span>` : ""}
        </div>
      </div>
      <div class="top-actions">
        ${renderRefreshButton()}
        <button class="btn" data-act="copy-room-link">复制链接</button>
        ${room.rulesetMode === "custom" ? `<button class="btn" data-act="view-room-rules">查看房间设置</button>` : ""}
        ${room.duelMode || room.rulesetMode === "custom" ? "" : `<button class="btn" data-act="add-online-bot" ${currentUser && (room.status === "lobby" || room.status === "ended") && room.players.length < room.capacity ? "" : "disabled"}>添加机器人</button>`}
        ${currentUser?.id === room.creatorAccountId && !room.duelMode ? `<button class="btn room-edit-trigger" data-act="edit-room">编辑房间</button>` : ""}
        ${renderAdvancedAiButton()}
        ${game?.status === "ended" ? `<button class="btn" data-act="export-game-log">导出日志</button>` : ""}
        ${duelRematchBlocked ? `<span class="muted">房主当前没有决斗额度，无法再来一局</span>` : `<button class="btn primary" data-act="start-online" ${startButtonEnabled ? "" : "disabled"}>${startButtonLabel}</button>`}
      </div>
    </section>
  `;
}

function renderRefreshButton(): string {
  if (mode !== "online" || !room) return "";
  return `<button class="btn" data-act="refresh-state" ${refreshPending ? "disabled" : ""}>${refreshPending ? "同步中…" : "刷新"}</button>`;
}

function isCardWarRoom(target: RoomSummary): boolean {
  const seats = Number.isInteger(target.capacity) && target.capacity >= 2 ? target.capacity : Math.max(2, target.players.length);
  return totalDealtCards(seats, target.initialHandSize ?? undefined) > 100;
}

function isOnlineGameRunning(): boolean {
  return mode === "online" && Boolean(room) && (room!.status === "playing" || room!.status === "opening-exchange");
}

function canExitCurrentRoom(): boolean {
  if (!game) return false;
  if (mode === "online") return false;
  return mode === "local";
}

function renderBoard(): string {
  return `
    <section class="board">
      <div class="zone panel">
        <div class="zone-head"><h2>溶液区</h2><span>${game?.zones.solution.length ?? 0} 张离子</span></div>
        <div class="card-grid">${(game?.zones.solution ?? []).map((card) => renderCard(card)).join("")}</div>
      </div>
      <div class="zone panel">
        <div class="zone-head"><h2>生成物区</h2><span>${game?.zones.products.length ?? 0} 组</span></div>
        <div class="card-grid">${(game?.zones.products ?? []).map(renderProduct).join("")}</div>
      </div>
    </section>
  `;
}

function renderHandbar(): string {
  const player = game ? visibleSeat() : undefined;
  const terminal = game?.status === "ended";
  const hideHand = Boolean(player?.bot && !terminal);
  const actions =
    game && game.status === "playing" && player && player.id === activeSeat()?.id && !hideHand
      ? actionsForDisplay(
        player.id,
        actionsForPlayer(player.id).filter(
          (a) =>
            !isDrawResponse(a) &&
            (game?.pendingDraw ||
              selectedCard === "all" ||
              actionMatchesCard(a, selectedCard) ||
              isAdvancedAiSuggestedAction(a, player.id)),
        ),
      )
      : [];
  const handCards = hideHand ? Array(player?.hand.length ?? 0).fill("__hidden__") : player?.hand ?? [];
  const animatedDrawCount = player && isLandingAnimating(player.id) ? animatedDrawCounts.get(player.id) ?? 0 : 0;
  const stackGroups = !hideHand && player && (game?.status === "playing" || game?.status === "ended") ? buildHandDisplayGroups(player.hand) : undefined;
  return `
    <footer class="handbar ${player && isSeatAnimating(player.id) ? "dealing" : ""}">
      <div class="hand-layout">
        <div>
          <div class="section-title">
            <span>${player ? `${renderPlayerName(player)} ${hideHand ? "正在自动计算" : "的手牌"}` : "手牌"}</span>
            <span>${terminal ? "终局查看" : player?.hand.length ?? 0}</span>
          </div>
          <div class="card-grid">
            ${hideHand ? "" : `<button class="card filter-card ${selectedCard === "all" ? "selected" : ""}" data-card="all"><span class="formula">全部</span><span class="kind">动作筛选</span></button>`}
            ${stackGroups
      ? stackGroups.map((group) => renderHandStack(group, animatedDrawCount, player!.hand.length)).join("")
      : handCards.map((card, index) => renderCard(card, !hideHand, index >= handCards.length - animatedDrawCount ? "dealing-card" : "", index)).join("")}
          </div>
        </div>
        <div class="actions">
          <div class="section-title"><span>${terminal ? "终局信息" : legalActionHeading(player?.id)}</span><span>${terminal ? "" : actions.length}</span></div>
          ${terminal
      ? `<div class="muted">本局已结束，点击左侧任意席位查看该玩家的手牌。</div>`
      : hideHand
        ? `<div class="muted">机器人的手牌已隐藏。</div>`
        : game?.pendingDraw && player?.id === activeSeat()?.id
          ? `<div class="muted">请在弹窗中处理拿牌。</div>`
          : actions.map((action, index) => `<button class="action-btn ${isAdvancedAiSuggestedAction(action, player?.id) ? "ai-recommended" : ""}" data-action-index="${index}">${isAdvancedAiSuggestedAction(action, player?.id) ? "<strong>AI 建议</strong>" : ""}${describeAction(action)}</button>`).join("")
    }
        </div>
      </div>
    </footer>`;
}

function renderTerminalHandPicker(activeId?: string): string {
  if (!game) return "";
  const selected = activeId ?? watchedSeatId;
  return `
    <label class="watch-picker">
      <span>查看席位</span>
      <select id="watchSeat">
        ${game.players
      .map((seat) => `<option value="${escapeAttr(seat.id)}" ${seat.id === selected ? "selected" : ""}>${escapeHtml(seat.nickname)} · ${seat.hand.length} 张</option>`)
      .join("")}
      </select>
    </label>
  `;
}

function renderCard(card: CardId | CardInstance, clickable = false, extraClass = "", handIndex?: number, badge?: string): string {
  if (card === "__hidden__" || (typeof card !== "string" && card.cardId === "__hidden__")) return `<div class="card hidden"><span class="formula">?</span><span class="kind">牌背</span></div>`;
  const id = cardIdOf(card);
  const visual = cardVisual(id);
  const selected = clickable && selectedHandIndex === handIndex ? "selected" : "";
  const sameHint = clickable && selectedHandIndex !== null && selectedHandIndex !== handIndex && selectedCard === id ? "same-card-hint" : "";
  const indexAttr = handIndex !== undefined ? ` data-card-index="${handIndex}"` : "";
  const instance = typeof card === "string" ? undefined : card;
  const descriptionKey = handIndex !== undefined ? `hand:${handIndex}` : instance?.instanceId ?? `card:${id}`;
  const description = customCardDescription(id);
  const descriptionAttrs = cardDescriptionAttributes(id, descriptionKey);
  const interactionAttrs = clickable
    ? `data-card="${escapeAttr(id)}"${indexAttr}`
    : description
      ? `aria-disabled="true"`
      : "disabled";
  const markBadge = instance?.marks.length
    ? instance.marks
      .map((mark) => `<span class="card-badge card-mark-badge" title="${escapeAttr(mark.name)}">${escapeHtml(mark.badge ?? `印：${mark.name}`)}</span>`)
      .join("")
    : "";
  const life = instance?.counters.life;
  const lifeBadge = badge ?? (typeof life === "number" ? `寿命 ${life}` : undefined);
  return `<button class="card ${visual.cls} ${selected} ${sameHint} ${extraClass} ${lifeBadge ? "has-uranium-life" : ""} ${description ? "has-description" : ""}"${cardVisualStyle(visual)} ${interactionAttrs}${descriptionAttrs}>
    <span class="card-badges">
    ${lifeBadge ? `<span class="card-badge uranium-life" title="还能触发 ${escapeAttr(lifeBadge.replace(/\D/g, ""))} 次辐射摸牌">${escapeHtml(lifeBadge)}</span>` : ""}
    ${markBadge}
    </span>
    <span class="formula"${cardFormulaStyle(id, visual)}>${visual.formula}</span>
    <span class="kind">${visual.kind}</span>
  </button>`;
}

function handDisplayCompare(): (a: CardId, b: CardId) => number {
  const rules = customRulesOf(game);
  return rules ? displayOrderComparator(rules) : compareHandCards;
}

type HandDisplayGroup = { card: CardId; indices: number[]; sample: CardId | CardInstance };

function buildHandDisplayGroups(hand: readonly (CardId | CardInstance)[]): HandDisplayGroup[] {
  const rules = customRulesOf(game);
  const ordered = hand.map((entry, index) => ({ card: cardIdOf(entry), index, raw: entry })).sort((a, b) => handDisplayCompare()(a.card, b.card) || a.index - b.index);
  if (rules?.display?.autoStack === false) {
    return ordered.map((entry) => ({ card: entry.card, indices: [entry.index], sample: entry.raw }));
  }
  const maxStack = rules?.display?.maxStack ?? 0;
  const groups: HandDisplayGroup[] = [];
  for (const entry of ordered) {
    const last = groups[groups.length - 1];
    if (last && last.card === entry.card && (maxStack === 0 || last.indices.length < maxStack)) last.indices.push(entry.index);
    else groups.push({ card: entry.card, indices: [entry.index], sample: entry.raw });
  }
  return groups;
}

function renderHandStack(group: HandDisplayGroup, animatedDrawCount: number, handLength: number): string {
  const { card, indices } = group;
  if (indices.length === 1) {
    const index = indices[0];
    return renderCard(group.sample, true, index >= handLength - animatedDrawCount ? "dealing-card" : "", index);
  }
  const count = indices.length;
  const visual = cardVisual(card);
  const selected = selectedHandIndex !== null && indices.includes(selectedHandIndex) ? "selected" : "";
  const toggleIndex = selectedHandIndex !== null && indices.includes(selectedHandIndex) ? selectedHandIndex : indices[0];
  const dealing = indices.some((index) => index >= handLength - animatedDrawCount) ? "dealing-card" : "";
  const layers = Array.from({ length: count - 1 }, (_, layer) => `<span class="stack-layer" style="--layer:${layer + 1}"></span>`).join("");
  const sampleInstance = typeof group.sample === "string" ? undefined : group.sample;
  const markBadge = sampleInstance?.marks.length
    ? sampleInstance.marks.map((mark) => `<span class="card-badge card-mark-badge" title="${escapeAttr(mark.name)}">${escapeHtml(mark.badge ?? `印：${mark.name}`)}</span>`).join("")
    : "";
  const description = customCardDescription(card);
  const descriptionAttrs = cardDescriptionAttributes(card, `hand:${toggleIndex}`);
  return `<button class="card-stack ${visual.cls} ${description ? "has-description" : ""}" style="--stack-size:${count}${visual.topColor ? `;--card-top-color:${visual.topColor}` : ""}" data-card="${escapeAttr(card)}" data-card-index="${toggleIndex}"${descriptionAttrs}>
    ${layers}
    <span class="card ${visual.cls} ${selected} ${dealing} stack-top">
      <span class="card-badges">${markBadge}</span>
      <span class="stack-count">${count}×</span>
      <span class="formula"${cardFormulaStyle(card, visual)}>${visual.formula}</span>
      <span class="kind">${visual.kind}</span>
    </span>
  </button>`;
}

function renderDrawAnimations(): string {
  const now = Date.now();
  drawAnimations = drawAnimations.filter((animation) => now - animation.startedAt < animation.duration + 120);
  if (drawAnimations.length === 0) return "";
  return `
    <div class="draw-fx-layer" aria-hidden="true">
      ${drawAnimations
      .map((animation) => {
        const player = game?.players.find((seat) => seat.id === animation.seatId);
        const visibleCount = Math.min(animation.count, animation.opening ? 6 : 4);
        const elapsed = now - animation.startedAt;
        const label = animation.opening ? "发牌" : `摸牌 x${animation.count}`;
        return Array.from({ length: visibleCount }, (_, index) => {
          const target = drawAnimationTarget(animation.seatId);
          const delay = Math.min(index * 70, 360);
          const duration = Math.max(640, animation.duration - delay);
          const playheadDelay = Math.min(delay - elapsed, delay);
          return `<div class="draw-fx-card ${animation.opening ? "opening" : ""}" style="--i:${index}; --dx:${target.dx}; --dy:${target.dy}; animation-delay:${playheadDelay}ms; animation-duration:${duration}ms;">
              <span>${label}</span>
              <small>${escapeHtml(player?.nickname ?? "")}</small>
            </div>`;
        }).join("");
      })
      .join("")}
    </div>
  `;
}

function drawAnimationTarget(seatId: string): { dx: string; dy: string } {
  const visible = visibleSeat();
  if (visible?.id === seatId) return { dx: "calc(50vw - 250px)", dy: "calc(100vh - 410px)" };
  const index = game?.players.findIndex((seat) => seat.id === seatId) ?? 0;
  return { dx: "calc(-120px)", dy: `${-164 + index * 74}px` };
}

function renderProduct(product: ClientGame["zones"]["products"][number]): string {
  return `<div class="product">
    <strong>${productTitleHtml(product)}</strong>
    <div class="card-grid">${product.cards
      .map((card) => {
        const id = cardIdOf(card);
        const life = typeof card === "string" ? ("radiationLeft" in product ? product.radiationLeft : undefined) : (card.counters.life as number | undefined);
        return renderCard(card, false, "", undefined, id === "U" && life !== undefined ? `寿命 ${life}` : undefined);
      })
      .join("")}</div>
  </div>`;
}

function renderModal(): string {
  if (!modal) return "";
  if (modal.kind === "credits") {
    return `
      <div class="modal-backdrop">
        <section class="modal panel credits-dialog" role="dialog" aria-modal="true" aria-labelledby="creditsTitle">
          <div class="modal-head"><h2 id="creditsTitle">项目信息</h2><button class="btn ghost" data-act="modal-close">关闭</button></div>
          <div class="credits-list">
            <div class="credits-row"><strong>项目版本</strong><span>离子风暴开源版</span></div>
            <div class="credits-row"><strong>技术栈</strong><span>TypeScript、Vite、Node.js、Cloudflare Workers</span></div>
            <strong class="credits-signature">最后更新日期（UTC+8）：2026-08-29</strong>
          </div>
        </section>
      </div>
    `;
  }
  if (modal.kind === "local" || modal.kind === "online") {
    const setupModal = modal;
    const title = modal.kind === "local" ? "本地游戏" : "联机游戏";
    const accountNote = modal.kind === "online" ? "创建或加入联机房间都需要登录。" : "未登录玩家将以“未登录用户”显示。";
    const customMode = modal.ruleset === "custom";
    const selectedPresetId = modal.customPresetId;
    const blankSelected = Boolean(modal.customBlank && !selectedPresetId);
    const customSourceField = customMode
      ? `<div class="field wide"><label>规则来源</label><select id="modalCustomSource"><option value="" ${!selectedPresetId && !blankSelected ? "selected" : ""}>经典模式预设</option><option value="__blank__" ${blankSelected ? "selected" : ""}>从空白创建</option>${enabledCustomPresets.map((preset) => `<option value="${escapeAttr(preset.id)}" ${selectedPresetId === preset.id ? "selected" : ""}>${escapeHtml(preset.displayName)}</option>`).join("")}</select><small>平台和服务器预设在本地、联机模式均可选择；从空白创建会载入全部内置卡牌定义，但牌堆保持为空</small></div>`
      : "";
    const customRulesForModal = blankSelected ? (modal.customRules ?? undefined) : (modal.customRules ?? PLATFORM_PRESET);
    const [customMinPlayers, customMaxPlayers] = setupPlayersRange(customRulesForModal?.setup.players);
    const hasPlayerCountDeckRules = hasPlayerCountDeckOverrides(customRulesForModal);
    const dealRequiredPlayers = customMode ? requiredPlayersFromDeal(customRulesForModal ?? { deck: {} }, modal.playerCount) : null;
    const playerCountLockedByDeal = dealRequiredPlayers !== null && !hasPlayerCountDeckRules;
    const activeCustomDeal = customMode ? customDeckForPlayerCount(customRulesForModal ?? { deck: {} }, modal.playerCount).deal : undefined;
    const customHandSizeEditable = customMode && !customDealHasAnyFill(activeCustomDeal);
    const customHandSizeMin = customMode ? customDealMinimumGlobalFill(activeCustomDeal) : 2;
    const customHandSizeMax = customMode ? customInitialHandSizeMax(customRulesForModal, modal.playerCount) : 0;
    const duelInfo = modal.kind === "online" && !customMode ? renderRoomBetHint(modal) : "";
    const duelActive = modal.kind === "online" && !customMode && isDuelBaseBet(modal.baseBet, currentUser);
    const handSizeSeats = modal.kind === "online" ? (duelActive ? 2 : modal.playerCount) : modal.playerCount + modal.botCount;
    const handSizeMax = maxInitialHandSize(handSizeSeats);
    const reservedCodes = sortReservedRoomCodes(currentUser?.reservedRoomCodes ?? []);
    const roomCodeMode = setupModal.roomCodeMode === "reserved" && reservedCodes.length ? "reserved" : "custom";
    const roomCodeFields = modal.kind !== "online"
      ? ""
      : reservedCodes.length
        ? `<div class="room-code-controls wide">
            <div class="field"><label>房间号方式</label><select id="modalRoomCodeMode"><option value="custom" ${roomCodeMode === "custom" ? "selected" : ""}>自定义房间号</option><option value="reserved" ${roomCodeMode === "reserved" ? "selected" : ""}>专属房间号</option></select></div>
            <div class="field"><label>${roomCodeMode === "reserved" ? "选择专属房间号" : "自定义房间号"}</label>${roomCodeMode === "reserved" ? `<select id="modalRoomCode">${reservedCodes.map((code) => `<option value="${escapeAttr(code)}" ${setupModal.roomCode === code ? "selected" : ""}>${escapeHtml(code)}</option>`).join("")}</select>` : `<input id="modalRoomCode" inputmode="numeric" maxlength="6" pattern="[1-9][0-9]{5}" placeholder="留空随机生成" value="${escapeAttr(setupModal.roomCode ?? "")}" /><small>仅允许首位非 0 的六位数字；留空则随机生成。</small>`}</div>
          </div>`
        : `<div class="field wide room-code-single"><label>自定义房间号</label><input id="modalRoomCode" inputmode="numeric" maxlength="6" pattern="[1-9][0-9]{5}" placeholder="留空随机生成" value="${escapeAttr(setupModal.roomCode ?? "")}" /><small>仅允许首位非 0 的六位数字；留空则随机生成。</small></div>`;
    return `
      <div class="modal-backdrop">
        <section class="modal panel">
          <div class="modal-head"><h2>${title}</h2><button class="btn ghost" data-act="modal-close">关闭</button></div>
          ${modal.error ? `<div class="form-error">${escapeHtml(modal.error)}</div>` : ""}
          <div class="setup-grid modal-grid">
            <div class="field"><label>规则模式</label><select id="modalRuleset"><option value="classic" ${modal.ruleset === "classic" ? "selected" : ""}>经典模式</option><option value="custom" ${customMode ? "selected" : ""}>自定义模式（JSON 牌库）</option></select></div>
            <div class="field"><label>${modal.kind === "online" && !customMode ? "玩家数量（含 AI）" : "玩家数量"}</label><input id="modalPlayers" type="number" min="${modal.kind === "online" && !customMode ? 2 : 1}" max="10" step="1" value="${duelActive ? 2 : playerCountLockedByDeal ? dealRequiredPlayers : modal.playerCount}" ${duelActive || playerCountLockedByDeal ? "disabled" : ""} />${modal.kind === "online" && customMode ? `<small>自定义模式不支持 AI/机器人；${playerCountLockedByDeal ? `规则按 ${dealRequiredPlayers} 个座位规定了初始发牌，人数固定为 ${dealRequiredPlayers} 人` : hasPlayerCountDeckRules ? "不同人数可使用 JSON 中对应的牌堆与初始发牌设置。" : `人数需在规则允许范围${modal.customPresetId ? "（由所选预设决定）" : `（${customMinPlayers}-${customMaxPlayers}）`}内`}</small>` : ""}</div>
            ${modal.kind === "local" ? `<div class="field"><label>机器人数量</label><input id="modalBots" type="number" min="0" max="9" step="1" value="${customMode ? 0 : modal.botCount}" ${customMode ? "disabled" : ""} />${customMode ? "<small>自定义模式不支持 AI/机器人</small>" : ""}</div>` : ""}
            ${modal.kind === "online"
        ? `<div class="field"><label>底注</label><input id="modalBaseBet" type="number" min="${currentUser?.permissions.canCreateZeroBaseBet ? 0 : 1}" ${effectiveRoomMaximumBaseBet(currentUser, customMode) === null ? "" : `max="${effectiveRoomMaximumBaseBet(currentUser, customMode)}"`} step="1" value="${modal.baseBet}" />${customMode ? `<small>自定义模式最高 ${effectiveCustomMaxBaseBet(currentUser) ?? "不限"}，不进入决斗模式。</small>` : ""}</div>`
        : ""
      }
            ${customMode
        ? customHandSizeEditable
          ? `<div class="field"><label>全局补足手牌数</label><input id="modalInitialHandSize" type="number" inputmode="numeric" min="${customHandSizeMin}" max="${customHandSizeMax}" step="1" placeholder="规则默认" value="${escapeAttr(modal.initialHandSize)}" /><small id="modalInitialHandSizeHint">规则未设置席位补足数，可设 ${customHandSizeMin}-${customHandSizeMax}；该值会成为本局所有玩家的全局补足数。</small></div>`
          : `<div class="field"><label>全局补足手牌数</label><input type="text" value="由 JSON 规则的席位补足数决定" disabled /><small>至少一个席位已设置补足数，开房时不再覆盖。</small></div>`
        : `<div class="field"><label>初始手牌数量</label><input id="modalInitialHandSize" type="number" inputmode="numeric" min="2" max="${handSizeMax}" step="1" placeholder="默认" value="${escapeAttr(modal.initialHandSize)}" /><small id="modalInitialHandSizeHint">留空使用规则默认；${modal.kind === "local" ? "按总人数（含机器人）" : "按玩家数量"}可设 2-${handSizeMax}</small></div>`
      }
            ${modal.kind === "online"
        ? `<div class="field"><label>出牌时间（秒）</label><input id="modalTurnTimeLimit" type="number" inputmode="numeric" min="${MIN_ROOM_TIME_LIMIT_SEC}" max="${MAX_ROOM_TIME_LIMIT_SEC}" step="1" placeholder="默认 ${DEFAULT_TURN_TIME_LIMIT_SEC}" value="${escapeAttr(modal.turnTimeLimit)}" /><small>留空使用默认 ${DEFAULT_TURN_TIME_LIMIT_SEC} 秒；可设 ${MIN_ROOM_TIME_LIMIT_SEC}-${MAX_ROOM_TIME_LIMIT_SEC}</small></div>
            <div class="field"><label>换牌时间（秒）</label><input id="modalOpeningExchangeTime" type="number" inputmode="numeric" min="${MIN_ROOM_TIME_LIMIT_SEC}" max="${MAX_ROOM_TIME_LIMIT_SEC}" step="1" placeholder="默认 ${DEFAULT_OPENING_EXCHANGE_SEC}" value="${escapeAttr(modal.openingExchangeTime)}" /><small>留空使用默认 ${DEFAULT_OPENING_EXCHANGE_SEC} 秒；可设 ${MIN_ROOM_TIME_LIMIT_SEC}-${MAX_ROOM_TIME_LIMIT_SEC}</small></div>`
        : ""
      }
            ${roomCodeFields}
            ${customSourceField}
            ${customMode ? `<div class="field wide"><label>自定义规则</label><div class="rules-picker"><span>${modal.customPresetLoading ? "正在加载所选预设…" : modal.customPresetEdited ? "已从所选预设创建可编辑副本" : selectedPresetId ? `所选预设：${escapeHtml(enabledCustomPresets.find((preset) => preset.id === selectedPresetId)?.displayName ?? selectedPresetId)}` : modal.customRules ? "已修改的自定义规则" : blankSelected ? "空白牌堆（已载入内置卡牌库）" : `经典模式预设（${escapeHtml(PLATFORM_PRESET.name)}）`}</span><button class="btn" type="button" data-act="open-rules-editor" ${modal.customPresetLoading ? "disabled" : ""}>编辑规则</button></div><small>${modal.customPresetEdited ? "编辑只应用到这次创建的对局，不会修改服务器预设。" : "选择任意预设后仍可编辑；联机创建后规则快照冻结，本局不变。"}</small></div>` : ""}
          </div>
          <p class="muted">${modal.kind === "online" ? (customMode ? (selectedPresetId ? "自定义模式人数范围由所选预设决定，达到人数后拒绝新成员加入。" : `自定义模式人数范围为 ${customMinPlayers}-${customMaxPlayers}，达到人数后拒绝新成员加入。`) : "玩家数量包含真人和 AI，范围为 2-10；达到该人数后将拒绝新成员和 AI 加入。") : "无机器人时，玩家数量必须为 2-10；有机器人时，玩家数量必须为 1 到 10 减机器人数量。"}${accountNote}</p>
          ${duelInfo}
          <div class="top-actions"><button class="btn primary" data-act="modal-submit" ${modal.customPresetLoading ? "disabled" : ""}>确认</button></div>
        </section>
      </div>
    `;
  }
  if (modal.kind === "join") {
    return `
      <div class="modal-backdrop">
        <section class="modal panel">
          <div class="modal-head"><h2>加入房间</h2><button class="btn ghost" data-act="modal-close">关闭</button></div>
          ${modal.error ? `<div class="form-error">${escapeHtml(modal.error)}</div>` : ""}
          <div class="setup-grid modal-grid">
            <div class="field"><label>房间号</label><input id="joinCode" inputmode="numeric" pattern="[0-9]+" value="${escapeAttr(modal.code)}" /><small>请输入纯数字房间号；普通房间号为六位，专属房间号可使用其原始位数。</small></div>
          </div>
          <p class="muted">${currentUser ? "将使用你的昵称加入，并在昵称下显示用户名。" : "请先登录账号后加入联机房间。"}</p>
          <div class="top-actions"><button class="btn primary" data-act="modal-submit">加入</button></div>
        </section>
      </div>
    `;
  }
  if (modal.kind === "auth") {
    if (currentUser) return "";
    const title = modal.mode === "login" ? "登录账号" : "注册账号";
    return `
      <div class="modal-backdrop">
        <section class="modal panel">
          <div class="modal-head"><h2>${title}</h2><button class="btn ghost" data-act="guest-continue">游客继续</button></div>
          ${modal.error ? `<div class="form-error">${escapeHtml(modal.error)}</div>` : ""}
          <div class="setup-grid modal-grid">
            ${modal.mode === "register"
        ? `<div class="field wide"><label>昵称</label><input id="authNickname" maxlength="24" value="${escapeAttr(modal.username)}" /></div>`
        : ""
      }
            <div class="field wide"><label>用户名</label><input id="authUsername" maxlength="24" value="${escapeAttr(modal.username)}" /></div>
            ${modal.mode === "register" ? `<div class="field wide"><label>邀请码（必填）</label><input id="authInviteCode" maxlength="32" required value="${escapeAttr(modal.inviteCode ?? "")}" /></div>` : ""}
            ${modal.mode === "register" ? `<div class="field wide"><label>邀请码赠送的专属房间号（如邀请码要求）</label><input id="authReservedRoomCode" inputmode="numeric" maxlength="6" placeholder="仅数字，最多 6 位；可保留前导 0" value="${escapeAttr(modal.reservedRoomCode ?? "")}" /><small>仅当邀请码配置为“用户输入专属房间号”时必填。</small></div>` : ""}
            <div class="field wide"><label>密码</label><input id="authPassword" type="password" maxlength="72" /></div>
          </div>
          <div class="top-actions">
            <button class="btn" data-act="${modal.mode === "login" ? "switch-register" : "switch-login"}">${modal.mode === "login" ? "注册新账号" : "返回登录"}</button>
            <button class="btn primary" data-act="auth-submit">${modal.mode === "login" ? "登录" : "注册"}</button>
          </div>
        </section>
      </div>
    `;
  }
  if (modal.kind === "actions") {
    const actionModal = modal;
    return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>${actionModal.titleHtml ?? escapeHtml(actionModal.title)}</h2>${actionModal.forced && canExitCurrentRoom() ? `<button class="player-kick room-exit" data-act="leave-room">退出</button>` : actionModal.forced ? "" : `<button class="btn ghost" data-act="modal-close">关闭</button>`}</div>
        <div class="actions modal-actions ${actionModal.submitting ? "submitting" : ""}" aria-busy="${actionModal.submitting ? "true" : "false"}">
          ${actionModal.actions.map((action, index) => `<button class="action-btn ${isAdvancedAiSuggestedAction(action, activeSeat()?.id) ? "ai-recommended" : ""}" data-modal-action-index="${index}" ${actionModal.submitting ? "disabled" : ""}>${isAdvancedAiSuggestedAction(action, activeSeat()?.id) ? "<strong>AI 建议</strong>" : ""}${describeAction(action)}</button>`).join("")}
          ${actionModal.submitting ? `<p class="modal-submit-status">正在提交选择…</p>` : ""}
        </div>
      </section>
    </div>
  `;
  }
  return "";
}

function renderPageShell(title: string, body: string, actions = ""): void {
  const interaction = captureInteractionSnapshot();
  app.innerHTML = `
    <div class="shell management-shell">
      <header class="topbar">
        <div class="brand">
          <button class="mark" type="button" data-act="open-credits" aria-label="查看项目信息">Ion</button>
          <div><h1>${title}</h1><span>离子风暴管理中心</span></div>
        </div>
        <div id="timer" class="timer"><strong>--</strong><span>管理</span></div>
        <div class="top-actions">
          ${actions}
          <button class="btn" data-act="go-home">返回主界面</button>
        </div>
      </header>
      <main class="management-page">
        ${body}
      </main>
      ${renderDialog()}
      ${renderPasswordConfirm()}
      ${renderModal()}
    </div>
  `;
  bind();
  restoreInteractionSnapshot(interaction);
}

function renderUserPage(): void {
  const self = currentUser;
  const superAdmin = Boolean(self?.superAdmin);
  const body = `
        ${userPageError ? `<div class="form-error">${escapeHtml(userPageError)}</div>` : ""}
        <div class="user-table-wrap">
          <table class="user-table user-management-table">
            <thead>
              <tr>
                <th>昵称</th><th>用户名</th><th>总局</th><th>胜局</th><th>今日</th><th>积分</th><th>注册使用的邀请码</th><th>账号状态</th><th>身份</th><th>颜色</th><th class="management-expiry-column">到期</th><th>最后登录</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${managedUsers.map((user) => renderUserRow(user, self)).join("")}
            </tbody>
          </table>
        </div>
  `;
  renderPageShell(
    "用户管理",
    body,
    `
      ${superAdmin ? `<button class="btn" data-act="download-users-csv">下载 CSV</button>` : ""}
      ${superAdmin ? `<button class="btn" data-act="go-invite">邀请码</button>` : ""}
      ${superAdmin ? `<button class="btn" data-act="go-activation">激活码</button>` : ""}
      ${superAdmin ? `<button class="btn" data-act="edit-permissions">权限</button>` : ""}
      ${superAdmin ? `<button class="btn" data-act="edit-custom-presets">自定义模式</button>` : ""}
      ${superAdmin ? `<button class="btn" data-act="edit-tax-settings">税收管理</button>` : ""}
      <button class="btn" data-act="redeem-activation">兑换激活码</button>
      <button class="btn" data-act="submit-ticket">工单/申请</button>
    `,
  );
}

function renderUserRow(user: PublicUser, self?: PublicUser): string {
  const isSelf = self?.id === user.id;
  const canSuperManage = Boolean(self?.superAdmin && !user.superAdmin);
  const canSelfLeaderboardManage = Boolean(self?.superAdmin && isSelf);
  const canAdminManage = Boolean(self && (self.role === "admin" || self.role === "admin-advanced") && user.role !== "admin" && user.role !== "admin-advanced" && !user.superAdmin);
  const musicAccess = winMusicControlAccess(user, self);
  const musicControls = musicAccess.canManage || musicAccess.canDownload
    ? `<button class="btn" data-act="open-win-music" data-user-id="${escapeAttr(user.id)}">胜利音效</button>`
    : "";
  const canManageReservedCodes = Boolean(
    isSelf || self?.superAdmin || (self && (self.role === "admin" || self.role === "admin-advanced") &&
      (user.role === "advanced" || user.role === "normal") && !user.superAdmin),
  );
  return `
    <tr class="user-row" data-user-id="${escapeAttr(user.id)}">
      <td><strong style="color:${escapeAttr(user.nicknameColor)}">${escapeHtml(user.nickname)}</strong></td>
      <td><span class="username-text">@${escapeHtml(user.username)}</span></td>
      <td>${user.gamesPlayed}</td>
      <td>${user.gamesWon}</td>
      <td>${user.todayGamesWon}/${user.todayGamesPlayed}</td>
      <td>${user.points}</td>
      <td>${escapeHtml(user.inviteCodeUsed ?? "")}</td>
      <td>${user.disabled ? "账号已禁用" : user.hiddenFromLeaderboard ? "仅排行榜隐藏" : "正常"}${user.disabledPermanent || user.leaderboardHiddenPermanent ? " / 永久" : ""}${user.hideFromLeaderboardWhileDisabled && user.disabled ? " / 同步移出排行榜" : ""}${user.nicknameChangeDisabled ? " / 禁止自改昵称" : ""}</td>
      <td>${escapeHtml(roleLabel(user.role))}${user.subtitle ? ` / ${escapeHtml(user.subtitle)}` : ""}</td>
      <td>${escapeHtml(user.nicknameColor)}</td>
      <td class="management-expiry-column">${escapeHtml(expirySummary(user))}</td>
      <td>${user.lastLoginAt ? escapeHtml(formatDate(user.lastLoginAt)) : ""}</td>
      <td>
        <button class="btn primary" data-act="open-user-edit" data-user-id="${escapeAttr(user.id)}">编辑</button>
        ${canSuperManage || canAdminManage || canSelfLeaderboardManage ? `<button class="btn warn" data-act="open-user-disable" data-user-id="${escapeAttr(user.id)}">${user.disabled || user.hiddenFromLeaderboard ? "解禁/禁用" : "禁用"}</button>` : ""}
        ${canSuperManage ? `<button class="btn warn" data-act="delete-user" data-user-id="${escapeAttr(user.id)}">删除</button>` : ""}
        ${canManageReservedCodes ? `<button class="btn" data-act="open-reserved-room-codes" data-user-id="${escapeAttr(user.id)}">专属房间号</button>` : ""}
        ${musicControls}
      </td>
    </tr>
  `;
}

function renderInvitePage(): void {
  const allowed = Boolean(currentUser?.superAdmin);
  const body = !allowed
    ? `<div class="panel management-denied">只有超级管理员可以访问邀请码管理。</div>`
    : `
      ${invitePageError ? `<div class="form-error">${escapeHtml(invitePageError)}</div>` : ""}
      <div class="user-table-wrap">
        <table class="user-table">
          <thead>
            <tr><th>邀请码</th><th>注册额度</th><th>已注册</th><th>失效时间</th><th>注册身份</th><th>初始积分</th><th>初始头衔</th><th>昵称颜色</th><th>专属房间号</th><th>初始权限</th><th>自定义模式额度</th><th>管理员期限</th><th>高级期限</th><th>高级 AI</th><th>创建时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${invitations.map(renderInviteRow).join("")}
          </tbody>
        </table>
      </div>
    `;
  renderPageShell("邀请码管理", body, allowed ? `<button class="btn primary" data-act="new-invite">新邀请码</button>` : "");
}

function renderInviteRow(invite: InvitationCode): string {
  return `
    <tr>
      <td>${escapeHtml(invite.code)}</td>
      <td>${escapeHtml(invitationUseSummary(invite))}</td>
      <td>${invite.registrations?.length ?? 0}</td>
      <td>${invite.expiresAt ? escapeHtml(formatDate(Date.parse(invite.expiresAt))) : "永久"}</td>
      <td>${escapeHtml(roleLabel(invite.role))}</td>
      <td>${invite.initialPoints}</td>
      <td>${escapeHtml(invite.initialTitle ?? "")}</td>
      <td>${escapeHtml(invite.initialNicknameColor ?? "")}</td>
      <td>${escapeHtml(reservedRoomCodeGrantSummary(invite.reservedRoomCodeMode))}</td>
      <td>${escapeHtml(invitationPermissionSummary(invite.permissions))}</td>
      <td>${escapeHtml(customModeLimitGrantSummary(invite.customModeLimits))}</td>
      <td>${escapeHtml(invitationGrantSummary(invite, "admin"))}</td>
      <td>${escapeHtml(invitationGrantSummary(invite, "advanced"))}</td>
      <td>${escapeHtml(advancedAiGrantSummary(invite))}</td>
      <td>${escapeHtml(formatDate(invite.createdAt))}</td>
      <td><button class="btn primary" data-act="edit-invite" data-code="${escapeAttr(invite.code)}">编辑</button><button class="btn danger" data-act="delete-invite" data-code="${escapeAttr(invite.code)}">删除</button></td>
    </tr>
  `;
}

function renderActivationPage(): void {
  const allowed = Boolean(currentUser?.superAdmin);
  const body = !allowed
    ? `<div class="panel management-denied">只有超级管理员可以访问激活码管理。</div>`
    : `
      ${activationPageError ? `<div class="form-error">${escapeHtml(activationPageError)}</div>` : ""}
      <div class="user-table-wrap">
        <table class="user-table activation-management-table">
          <thead><tr><th>激活码</th><th>类型/策略</th><th>次数</th><th>滚动周期</th><th>失效时间</th><th>积分</th><th>头衔</th><th>昵称颜色</th><th>专属房间号</th><th>管理员</th><th>高级用户</th><th>高级 AI</th><th class="management-permission-column">权限</th><th>自定义模式额度</th><th>已使用</th><th>操作</th></tr></thead>
          <tbody>${activationCodes.map(renderActivationRow).join("")}</tbody>
        </table>
      </div>
    `;
  renderPageShell(
    "激活码管理",
    body,
    allowed
      ? `<button class="btn primary" data-act="new-activation">新激活码</button><button class="btn" data-act="grant-points">发送激活码红包</button><button class="btn" data-act="bulk-grant-points">一键发放积分</button>`
      : "",
  );
}

function renderActivationRow(code: ActivationCode): string {
  const pointDistribution = code.kind === "point-distribution";
  const distributedPoints = code.redemptions.reduce((sum, redemption) => sum + (redemption.points ?? 0), 0);
  const points = pointDistribution ? `总 ${code.totalPoints ?? 0} / 剩 ${(code.totalPoints ?? 0) - distributedPoints}` : String(code.points);
  return `
    <tr>
      <td>${escapeHtml(code.code)}</td>
      <td>${pointDistribution ? (code.distributionMode === "equal" ? "积分均分" : "积分瓜分") : escapeHtml(activationPolicyLabel(code.usePolicy))}</td>
      <td>${code.usePolicy === "unlimited" ? "不限" : code.maxUses}</td>
      <td>${!pointDistribution && code.windowMs ? `${Math.round(code.windowMs / 86_400_000)} 日` : ""}</td>
      <td>${code.expiresAt ? escapeHtml(formatDate(Date.parse(code.expiresAt))) : "永久"}</td>
      <td>${escapeHtml(points)}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(activationTitleSummary(code))}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(activationNicknameColorSummary(code))}</td>
      <td>${pointDistribution ? "不赠送" : escapeHtml(reservedRoomCodeGrantSummary(code.reservedRoomCodeMode))}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(activationGrantSummary(code, "admin"))}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(activationGrantSummary(code, "advanced"))}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(advancedAiGrantSummary(code))}</td>
      <td class="management-permission-column">${pointDistribution ? "不改变" : escapeHtml(invitationPermissionSummary(code.permissions))}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(customModeLimitGrantSummary(code.customModeLimits, code.customModeLimitDurationMs))}</td>
      <td>${code.redemptions.length}</td>
      <td><button class="btn primary" data-act="${pointDistribution ? "edit-point-distribution" : "edit-activation"}" data-code="${escapeAttr(code.code)}">编辑</button><button class="btn danger" data-act="delete-activation" data-code="${escapeAttr(code.code)}">删除</button></td>
    </tr>
  `;
}

function renderTicketPage(): void {
  const allowed = Boolean(currentUser);
  const admin = isAdminUser(currentUser);
  const body = !allowed
    ? `<div class="panel management-denied">请先登录后查看工单。</div>`
    : `
      ${ticketPageError ? `<div class="form-error">${escapeHtml(ticketPageError)}</div>` : ""}
      <div class="user-table-wrap">
        <table class="user-table">
          <thead><tr>${admin
      ? "<th>类型</th><th>提交用户</th><th>内容</th><th>范围</th><th>状态</th><th>提交时间</th><th>封禁时间</th><th>封禁截止</th><th>封禁执行者</th><th>回复时间</th><th>回复者</th><th>回复</th><th>操作</th>"
      : "<th>类型</th><th>内容</th><th>状态</th><th>提交时间</th><th>回复时间</th><th>回复</th>"
    }</tr></thead>
          <tbody>${requests.map((request) => renderTicketRow(request, admin)).join("")}</tbody>
        </table>
      </div>
    `;
  renderPageShell("工单管理", body, allowed ? `<button class="btn primary" data-act="submit-ticket">提交工单/申请</button>` : "");
}

function renderLeaderboardPage(): void {
  const currentOutsideList = Boolean(
    leaderboard?.current && !leaderboard.entries.some((entry) => entry.id === leaderboard!.current!.id),
  );
  const body = !currentUser
    ? `<div class="panel management-denied">请先登录后查看排行榜。</div>`
    : `
      ${leaderboardError ? `<div class="form-error">${escapeHtml(leaderboardError)}</div>` : ""}
      <div class="leaderboard-summary">
        <strong class="leaderboard-title">积分排行榜</strong>
        <div class="leaderboard-stats">
          <span>${leaderboard ? `共 ${leaderboard.totalUsers} 名上榜用户` : "正在加载"}</span>
          ${leaderboard ? `<span>玩家总积分数：${leaderboard.totalPoints}</span>` : ""}
        </div>
      </div>
      <div class="user-table-wrap">
        <table class="user-table leaderboard-table">
          <thead><tr><th>排名</th><th>昵称</th><th>用户名</th><th>积分</th><th>胜局/总局</th><th>胜率</th></tr></thead>
          <tbody>
            ${(leaderboard?.entries ?? []).map((entry) => renderLeaderboardRow(entry, entry.id === currentUser?.id)).join("")}
          </tbody>
        </table>
      </div>
      ${leaderboard?.current && currentOutsideList
      ? `<div class="leaderboard-current">
              <div class="section-title"><span>我的排名</span><span>第 ${leaderboard.current.rank} 名</span></div>
              <div class="user-table-wrap">
                <table class="user-table leaderboard-table"><tbody>${renderLeaderboardRow(leaderboard.current, true)}</tbody></table>
              </div>
            </div>`
      : ""
    }
    `;
  renderPageShell("排行榜", body);
}

function renderLeaderboardRow(entry: LeaderboardEntry, current: boolean): string {
  return `
    <tr class="${current ? "leaderboard-self" : ""}">
      <td><strong>${entry.rank}</strong></td>
      <td><strong style="color:${escapeAttr(entry.nicknameColor)}">${escapeHtml(entry.nickname)}</strong></td>
      <td><span class="username-text">@${escapeHtml(entry.username)}</span></td>
      <td>${entry.points}</td>
      <td>${entry.gamesWon}/${entry.gamesPlayed}</td>
      <td>${formatWinRate(entry.winRate)}</td>
    </tr>
  `;
}

function renderTicketRow(request: UserRequestView, admin: boolean): string {
  const from = managedUsers.find((user) => user.id === request.fromUserId);
  const replyUser = managedUsers.find((user) => user.id === request.replyUserId);
  const banUser = managedUsers.find((user) => user.id === request.banSnapshot?.disabledBy);
  if (!admin) {
    return `
      <tr>
        <td>${escapeHtml(requestKindLabel(request.kind))}</td>
        <td>${escapeHtml(request.requestedNickname ?? request.text)}</td>
        <td>${escapeHtml(requestStatusLabel(request.status))}</td>
        <td>${escapeHtml(formatDate(request.createdAt))}</td>
        <td>${request.repliedAt ? escapeHtml(formatDate(request.repliedAt)) : ""}</td>
        <td>${escapeHtml(request.reply ?? "")}</td>
      </tr>
    `;
  }
  return `
    <tr>
      <td>${escapeHtml(requestKindLabel(request.kind))}</td>
      <td>${escapeHtml(from ? `${from.nickname} / @${from.username}` : request.fromUserId)}</td>
      <td>${escapeHtml(request.requestedNickname ?? request.text)}</td>
      <td>${request.privateToSuperAdmin ? "仅超级管理员" : "管理员可见"}</td>
      <td>${escapeHtml(requestStatusLabel(request.status))}</td>
      <td>${escapeHtml(formatDate(request.createdAt))}</td>
      <td>${request.banSnapshot?.disabledAt ? escapeHtml(formatDate(request.banSnapshot.disabledAt)) : ""}</td>
      <td>${request.banSnapshot?.disabledPermanent ? "永久" : request.banSnapshot?.disabledUntil ? escapeHtml(formatDate(Date.parse(request.banSnapshot.disabledUntil))) : ""}</td>
      <td>${escapeHtml(banUser ? `${banUser.nickname} / @${banUser.username}` : request.banSnapshot?.disabledBy ?? "")}</td>
      <td>${request.repliedAt ? escapeHtml(formatDate(request.repliedAt)) : ""}</td>
      <td>${escapeHtml(replyUser ? `${replyUser.nickname} / @${replyUser.username}` : request.replyUserId ?? "")}</td>
      <td>${escapeHtml(request.reply ?? "")}</td>
      <td>${request.securityLogId ? `<button class="btn ai" data-act="download-security-log" data-log-id="${escapeAttr(request.securityLogId)}">下载日志</button>` : ""}${request.status === "open" ? `<button class="btn primary" data-act="review-ticket" data-request-id="${escapeAttr(request.id)}">${request.kind === "security" ? "忽略" : "批复"}</button>` : ""}</td>
    </tr>
  `;
}

function renderDialog(): string {
  if (!dialog) return "";
  if (dialog.kind === "edit-user") return renderEditUserDialog(dialog);
  if (dialog.kind === "disable-user") return renderDisableUserDialog(dialog);
  if (dialog.kind === "delete-user") return renderDeleteUserDialog(dialog);
  if (dialog.kind === "edit-invite") return renderEditInviteDialog(dialog);
  if (dialog.kind === "delete-invite") return renderDeleteCodeDialog(dialog, "邀请码");
  if (dialog.kind === "edit-activation") return renderEditActivationDialog(dialog);
  if (dialog.kind === "edit-point-distribution") return renderPointDistributionDialog(dialog);
  if (dialog.kind === "bulk-grant-points") return renderBulkGrantPointsDialog(dialog);
  if (dialog.kind === "delete-activation") return renderDeleteCodeDialog(dialog, "激活码");
  if (dialog.kind === "redeem-activation") return renderRedeemActivationDialog(dialog);
  if (dialog.kind === "redeem-activation-custom") return renderRedeemActivationCustomDialog(dialog);
  if (dialog.kind === "permissions") return renderPermissionsDialog(dialog);
  if (dialog.kind === "custom-presets") return renderCustomPresetsDialog(dialog);
  if (dialog.kind === "tax-settings") return renderTaxSettingsDialog(dialog);
  if (dialog.kind === "request") return renderRequestDialog(dialog);
  if (dialog.kind === "review-ticket") return renderReviewTicketDialog(dialog);
  if (dialog.kind === "kick-player") return renderKickPlayerDialog(dialog);
  if (dialog.kind === "leave-room") return renderLeaveRoomDialog(dialog);
  if (dialog.kind === "edit-room") return renderEditRoomDialog(dialog);
  if (dialog.kind === "view-room-rules") return renderViewRoomRulesDialog(dialog);
  if (dialog.kind === "rules-editor") return renderRulesEditorDialog(dialog);
  if (dialog.kind === "rules-display-order") return renderRulesDisplayOrderDialog(dialog);
  if (dialog.kind === "rules-card-create") return renderRulesCardCreateDialog(dialog);
  if (dialog.kind === "room-edit-notice") return renderRoomEditNoticeDialog(dialog);
  if (dialog.kind === "reserved-room-codes") return renderReservedRoomCodesDialog(dialog);
  if (dialog.kind === "win-music") return renderWinMusicDialog(dialog);
  if (dialog.kind === "confirm-logout") return renderLogoutDialog();
  return "";
}

function reservedRoomCodeAccess(target: PublicUser): { canAdd: boolean; canEdit: boolean; canDelete: boolean } {
  const self = currentUser;
  const own = self?.id === target.id;
  const adminTarget = target.role === "advanced" || target.role === "normal";
  const admin = Boolean(self && (self.role === "admin" || self.role === "admin-advanced") && adminTarget && !target.superAdmin);
  return { canAdd: Boolean(self?.superAdmin), canEdit: Boolean(self?.superAdmin), canDelete: Boolean(own || self?.superAdmin || admin) };
}

function renderReservedRoomCodesDialog(state: Extract<DialogState, { kind: "reserved-room-codes" }>): string {
  const target = managedUsers.find((user) => user.id === state.userId) ?? (currentUser?.id === state.userId ? currentUser : undefined);
  if (!target) return "";
  const codes = sortReservedRoomCodes(state.codes ?? reservedRoomCodesByUser.get(target.id) ?? target.reservedRoomCodes ?? []);
  const access = reservedRoomCodeAccess(target);
  const editing = state.editingCode;
  return `
    <div class="modal-backdrop">
      <section class="modal panel reserved-codes-dialog">
        <div class="modal-head"><h2>专属房间号</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        <p class="dialog-subtitle">${escapeHtml(target.nickname)} / @${escapeHtml(target.username)}${!access.canAdd && access.canDelete ? " · 你可以删除允许范围内的专属房间号" : ""}</p>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="reserved-code-list">
          ${codes.length ? codes.map((code) => `<div class="reserved-code-item"><strong>${escapeHtml(code)}</strong>${access.canEdit && editing === code ? `<input id="reservedRoomCodeEdit" inputmode="numeric" value="${escapeAttr(code)}" aria-label="编辑专属房间号" />` : ""}<div class="reserved-code-actions">${access.canEdit ? `<button class="btn ghost" data-act="edit-reserved-room-code" data-code="${escapeAttr(code)}">${editing === code ? "取消编辑" : "编辑"}</button>${editing === code ? `<button class="btn primary" data-act="save-reserved-room-code" data-code="${escapeAttr(code)}">保存</button>` : ""}` : ""}${access.canDelete ? `<button class="btn ghost danger" data-act="delete-reserved-room-code" data-code="${escapeAttr(code)}">删除</button>` : ""}</div></div>`).join("") : `<p class="muted">暂无专属房间号。</p>`}
        </div>
        ${access.canAdd ? `<div class="reserved-code-add"><div class="field"><label>新增专属房间号</label><input id="reservedRoomCodeNew" inputmode="numeric" placeholder="输入房间号" /></div><button class="btn primary" data-act="add-reserved-room-code">添加</button></div>` : ""}
      </section>
    </div>`;
}

function renderWinMusicDialog(state: Extract<DialogState, { kind: "win-music" }>): string {
  const user = managedUsers.find((item) => item.id === state.userId);
  if (!user) return "";
  const access = winMusicControlAccess(user, currentUser);
  const uploaded = user.hasWinMusic;
  return `
    <div class="modal-backdrop">
      <section class="modal panel win-music-dialog">
        <div class="modal-head"><h2>胜利音效</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        <p class="muted">${escapeHtml(user.nickname)} / @${escapeHtml(user.username)}</p>
        <div class="win-music-actions">
          <button class="btn" data-act="play-music" data-user-id="${escapeAttr(user.id)}" ${uploaded && access.canPlay ? "" : "disabled"}>播放音效</button>
          <button class="btn primary" data-act="upload-music" data-user-id="${escapeAttr(user.id)}" ${access.canManage ? "" : "disabled"}>上传音效</button>
          <button class="btn" data-act="download-music" data-user-id="${escapeAttr(user.id)}" ${uploaded && access.canDownload ? "" : "disabled"}>下载音效</button>
          <button class="btn danger" data-act="delete-music" data-user-id="${escapeAttr(user.id)}" ${uploaded && access.canManage ? "" : "disabled"}>删除音效</button>
        </div>
        <p class="muted win-music-limit">音效不能超过15s或10MB</p>
      </section>
    </div>
  `;
}

function renderLogoutDialog(): string {
  return `
    <div class="modal-backdrop">
      <section class="modal panel password-confirm-dialog">
        <div class="modal-head"><h2>退出登录</h2><button class="btn ghost" data-act="dialog-close">取消</button></div>
        <p class="muted">确定退出当前账号并返回主界面吗？</p>
        <div class="top-actions">
          <button class="btn" data-act="dialog-close">取消</button>
          <button class="btn danger" data-act="confirm-logout">确定</button>
        </div>
      </section>
    </div>
  `;
}

function renderEditUserDialog(state: Extract<DialogState, { kind: "edit-user" }>): string {
  const user = managedUsers.find((item) => item.id === state.userId);
  if (!user) return "";
  const self = currentUser;
  const canSuperManage = Boolean(self?.superAdmin && !user.superAdmin);
  const canAdminManage = Boolean(self && (self.role === "admin" || self.role === "admin-advanced") && user.role !== "admin" && user.role !== "admin-advanced" && !user.superAdmin);
  const isSelf = self?.id === user.id;
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>编辑用户</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>昵称</label><input id="editNickname" maxlength="24" value="${escapeAttr(user.nickname)}" ${isSelf || canSuperManage || canAdminManage ? "" : "disabled"} /></div>
          <div class="field"><label>用户名</label><input value="@${escapeAttr(user.username)}" disabled /></div>
          <div class="field"><label>新密码</label><input id="editPassword" type="password" maxlength="72" ${isSelf || canSuperManage ? "" : "disabled"} /></div>
          <div class="field"><label>昵称颜色</label><input id="editNicknameColor" maxlength="7" value="${escapeAttr(user.nicknameColor)}" ${self?.superAdmin ? "" : "disabled"} /></div>
          <div class="field"><label>积分</label><input id="editPoints" type="number" step="1" value="${user.points}" ${self?.superAdmin ? "" : "disabled"} /></div>
          ${self?.superAdmin ? renderEditTaxRateFields(user) : ""}
          <div class="field"><label>头衔</label><input id="editTitle" maxlength="24" value="${escapeAttr(user.title ?? "")}" ${self?.superAdmin ? "" : "disabled"} /></div>
          ${self?.superAdmin ? renderEditAdvancedAiFields(user) : ""}
          ${self?.superAdmin
      ? `<div class="field"><label>用户权限</label><select id="editPermissionMode"><option value="default" ${user.permissionOverride ? "" : "selected"}>使用身份组默认</option><option value="custom" ${user.permissionOverride ? "selected" : ""}>自定义权限</option></select></div>
               <div id="editPermissionFields" class="invite-permission-fields ${user.permissionOverride ? "" : "is-hidden"}">
                 ${renderPermissionFields("edit", user.permissionOverride ?? user.permissions)}
                 ${renderEditPermissionExpiryFields(user)}
               </div>
               <div class="field wide"><label>自定义模式额度</label><select id="editCustomModeLimitMode"><option value="default" ${user.customModeLimitOverride ? "" : "selected"}>使用全局最高设置</option><option value="custom" ${user.customModeLimitOverride ? "selected" : ""}>单独设置</option></select><small>这项设置独立于用户权限。</small></div>
               <div id="editCustomModeLimitFields" class="invite-permission-fields ${user.customModeLimitOverride ? "" : "is-hidden"}">
                 ${renderCustomModeLimitFields("editCustomMode", user.customModeLimitOverride ?? user.customModeLimits)}
                 ${renderEditCustomModeLimitExpiryFields(user)}
               </div>`
      : ""
    }
          ${!isSelf && (canSuperManage || canAdminManage)
      ? `<div class="field"><label>允许用户自行修改昵称</label><select id="editNicknameChangeDisabled"><option value="false" ${user.nicknameChangeDisabled ? "" : "selected"}>允许</option><option value="true" ${user.nicknameChangeDisabled ? "selected" : ""}>禁止</option></select></div>`
      : ""
    }
          ${renderEditRoleFields(user, canSuperManage, canAdminManage)}
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-user-edit" data-user-id="${escapeAttr(user.id)}">保存</button></div>
      </section>
    </div>
  `;
}

function renderEditRoleFields(user: PublicUser, canSuperManage: boolean, canAdminManage: boolean): string {
  if (canSuperManage) {
    return `
      ${renderUserRoleGrantFields("Admin", "管理员", user.adminPermanent, user.adminExpiresAt)}
      ${renderUserRoleGrantFields("Advanced", "高级用户", user.advancedPermanent, user.advancedExpiresAt)}
    `;
  }
  if (canAdminManage && !user.advancedPermanent) {
    return dateTimeField("editAdvancedExpiresAt", "高级用户截止时间", user.advancedExpiresAt, { wrapperClass: "wide" });
  }
  return "";
}

function renderEditPermissionExpiryFields(user: PublicUser): string {
  const permanent = user.permissionOverridePermanent ?? true;
  const expiresAt = user.permissionOverrideExpiresAt;
  const mode = permanent ? "permanent" : expiresAt ? "absolute" : "relative";
  return `
    <div class="field"><label>权限覆盖期限方式</label><select id="editPermissionExpiryMode">
      <option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option>
      <option value="relative" ${mode === "relative" ? "selected" : ""}>相对时长</option>
      <option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option>
    </select></div>
    <div id="editPermissionExpiryRelativeField" class="field ${mode === "relative" ? "" : "is-hidden"}"><label>权限覆盖相对时长</label><div class="compound-input"><input id="editPermissionExpiryDurationAmount" type="number" min="1" step="1" value="30" /><select id="editPermissionExpiryDurationUnit"><option value="day" selected>日</option><option value="hour">小时</option></select></div></div>
    ${dateTimeField("editPermissionExpiryExpiresAt", "权限覆盖截止时间", expiresAt, { wrapperId: "editPermissionExpiryAbsoluteField", hidden: mode !== "absolute" })}
  `;
}

function renderEditCustomModeLimitExpiryFields(user: PublicUser): string {
  const permanent = user.customModeLimitOverridePermanent ?? true;
  const expiresAt = user.customModeLimitOverrideExpiresAt;
  const mode = permanent ? "permanent" : expiresAt ? "absolute" : "relative";
  return `
    <div class="field"><label>自定义模式额度期限</label><select id="editCustomModeLimitExpiryMode">
      <option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option>
      <option value="relative" ${mode === "relative" ? "selected" : ""}>相对时长</option>
      <option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option>
    </select></div>
    <div id="editCustomModeLimitExpiryRelativeField" class="field ${mode === "relative" ? "" : "is-hidden"}"><label>相对时长</label><div class="compound-input"><input id="editCustomModeLimitExpiryDurationAmount" type="number" min="1" step="1" value="30" /><select id="editCustomModeLimitExpiryDurationUnit"><option value="day" selected>日</option><option value="hour">小时</option></select></div></div>
    ${dateTimeField("editCustomModeLimitExpiryExpiresAt", "自定义模式额度截止时间", expiresAt, { wrapperId: "editCustomModeLimitExpiryAbsoluteField", hidden: mode !== "absolute" })}
  `;
}

function renderUserRoleGrantFields(id: "Admin" | "Advanced", label: string, permanent: boolean, expiresAt?: string): string {
  const mode = permanent ? "permanent" : expiresAt ? "absolute" : "default";
  return `
    <div class="field"><label>${label}身份</label><select id="edit${id}Mode">
      <option value="default" ${mode === "default" ? "selected" : ""}>不授予</option>
      <option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option>
      <option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option>
    </select></div>
    ${dateTimeField(`edit${id}ExpiresAt`, `${label}截止时间`, expiresAt, {
    wrapperId: `edit${id}AbsoluteField`,
    hidden: mode !== "absolute",
  })}
  `;
}

function renderDisableUserDialog(state: Extract<DialogState, { kind: "disable-user" }>): string {
  const user = managedUsers.find((item) => item.id === state.userId);
  if (!user) return "";
  const superAdmin = Boolean(currentUser?.superAdmin);
  const selfSuperAdmin = Boolean(currentUser?.superAdmin && currentUser.id === user.id);
  const accountMode = user.disabledPermanent ? "permanent" : user.disabledUntil ? "temporary" : "none";
  const leaderboardMode = user.leaderboardHiddenPermanent ? "permanent" : user.leaderboardHiddenUntil ? "temporary" : "none";
  const scope = selfSuperAdmin ? "leaderboard" : superAdmin && user.hiddenFromLeaderboard && !user.disabled ? "leaderboard" : "account";
  return `
    <div class="modal-backdrop">
      <section class="modal panel disable-dialog">
        <div class="modal-head"><h2>禁用设置</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div id="accountBanWarning" class="ban-warning ${scope === "account" ? "" : "is-hidden"}">账号禁用后仍可登录和进行本地游戏，但不能创建或加入联机房间。</div>
        <div id="leaderboardBanWarning" class="ban-warning leaderboard-only-warning ${scope === "leaderboard" ? "" : "is-hidden"}">${selfSuperAdmin ? "超级管理员只能将自己限期或永久从排行榜移除，不会禁用账号功能。" : "仅从排行榜移除不会限制登录、联机、游戏或其他账号功能。"}</div>
        <div class="setup-grid modal-grid">
          <div class="field"><label>用户</label><input value="${escapeAttr(user.nickname)} / @${escapeAttr(user.username)}" disabled /></div>
          ${superAdmin ? `<div class="field"><label>禁用范围</label><select id="banScope" ${selfSuperAdmin ? "disabled" : ""}>${selfSuperAdmin ? "" : `<option value="account" ${scope === "account" ? "selected" : ""}>账号禁用</option>`}<option value="leaderboard" ${scope === "leaderboard" ? "selected" : ""}>仅从排行榜上移除</option></select></div>` : ""}
          <div id="accountBanFields" class="ban-field-group ${scope === "account" ? "" : "is-hidden"}">
            <div class="field"><label>账号禁用方式</label><select id="banAccountMode"><option value="none" ${accountMode === "none" ? "selected" : ""}>不禁用</option><option value="temporary" ${accountMode === "temporary" ? "selected" : ""}>限时禁用</option><option value="permanent" ${accountMode === "permanent" ? "selected" : ""}>永久禁用</option></select></div>
            ${dateTimeField("banAccountUntil", "账号禁用截止时间", user.disabledUntil, { wrapperId: "banAccountUntilField", hidden: accountMode !== "temporary" })}
            ${superAdmin ? `<div id="banHideLeaderboardField" class="field ${accountMode === "none" ? "is-hidden" : ""}"><label>禁用期间从排行榜移除</label><select id="banHideLeaderboard"><option value="false" ${user.hideFromLeaderboardWhileDisabled ? "" : "selected"}>否</option><option value="true" ${user.hideFromLeaderboardWhileDisabled ? "selected" : ""}>是</option></select></div>` : ""}
          </div>
          ${superAdmin
      ? `<div id="leaderboardBanFields" class="ban-field-group ${scope === "leaderboard" ? "" : "is-hidden"}">
                 <div class="field"><label>排行榜移除方式</label><select id="banLeaderboardMode"><option value="none" ${leaderboardMode === "none" ? "selected" : ""}>不禁用</option><option value="temporary" ${leaderboardMode === "temporary" ? "selected" : ""}>限时禁用</option><option value="permanent" ${leaderboardMode === "permanent" ? "selected" : ""}>永久禁用</option></select></div>
                 ${dateTimeField("banLeaderboardUntil", "排行榜移除截止时间", user.leaderboardHiddenUntil, { wrapperId: "banLeaderboardUntilField", hidden: leaderboardMode !== "temporary" })}
               </div>`
      : ""
    }
        </div>
        <div class="top-actions"><button class="btn warn" data-act="submit-user-disable" data-user-id="${escapeAttr(user.id)}">保存禁用设置</button></div>
      </section>
    </div>
  `;
}

function renderDeleteUserDialog(state: Extract<DialogState, { kind: "delete-user" }>): string {
  const user = managedUsers.find((item) => item.id === state.userId);
  if (!user) return "";
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>删除用户</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <p class="muted">将删除 ${escapeHtml(user.nickname)} / @${escapeHtml(user.username)}，该操作不可撤销。</p>
        <div class="top-actions"><button class="btn warn" data-act="submit-user-delete" data-user-id="${escapeAttr(user.id)}">确认删除</button></div>
      </section>
    </div>
  `;
}

function renderEditInviteDialog(state: Extract<DialogState, { kind: "edit-invite" }>): string {
  const invite = state.code ? invitations.find((item) => item.code === state.code) : undefined;
  const usePolicy = invite?.usePolicy ?? (invite?.remainingUses === null || !invite ? "unlimited" : "global-total");
  const neverExpires = !invite?.expiresAt;
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>${invite ? "编辑邀请码" : "新邀请码"}</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>邀请码</label><input id="inviteCode" maxlength="32" value="${escapeAttr(invite?.code ?? "")}" ${invite ? "disabled" : ""} /></div>
          <div class="field"><label>注册额度</label><select id="inviteUsePolicy"><option value="unlimited" ${usePolicy === "unlimited" ? "selected" : ""}>不限次数</option><option value="global-total" ${usePolicy === "global-total" ? "selected" : ""}>总次数上限</option><option value="global-window" ${usePolicy === "global-window" ? "selected" : ""}>滚动周期上限</option></select></div>
          <div id="inviteMaxUsesField" class="field ${usePolicy === "unlimited" ? "is-hidden" : ""}"><label>最多注册次数</label><input id="inviteMaxUses" type="number" min="1" step="1" value="${invite?.maxUses ?? Math.max(1, (invite?.registrations?.length ?? 0) + (invite?.remainingUses ?? 1))}" /></div>
          <div id="inviteWindowDaysField" class="field ${usePolicy === "global-window" ? "" : "is-hidden"}"><label>滚动周期</label><div class="compound-input"><input id="inviteWindowDays" type="number" min="1" step="1" value="${Math.max(1, Math.round((invite?.windowMs ?? 7 * 86_400_000) / 86_400_000))}" /><span>日</span></div></div>
          <div class="field"><label>有效期限</label><select id="inviteExpiryMode"><option value="never" ${neverExpires ? "selected" : ""}>永久有效</option><option value="absolute" ${neverExpires ? "" : "selected"}>指定失效时间</option></select></div>
          ${dateTimeField("inviteExpiresAt", "失效时间", invite?.expiresAt, { wrapperId: "inviteExpiresAtField", hidden: neverExpires })}
          <div class="field"><label>注册身份</label><select id="inviteRole">${roleOptions(invite?.role ?? "normal", false)}</select></div>
          <div class="field"><label>初始积分</label><input id="invitePoints" type="number" step="1" value="${invite?.initialPoints ?? 0}" /></div>
          <div class="field"><label>初始头衔</label><input id="inviteTitle" maxlength="24" value="${escapeAttr(invite?.initialTitle ?? "")}" /></div>
          <div class="field"><label>昵称颜色</label><input id="inviteNicknameColor" maxlength="7" placeholder="#008F8F" value="${escapeAttr(invite?.initialNicknameColor ?? "")}" /></div>
          <div class="field"><label>初始权限</label><select id="invitePermissionMode"><option value="none" ${invite?.permissions ? "" : "selected"}>使用身份组默认</option><option value="custom" ${invite?.permissions ? "selected" : ""}>自定义权限</option></select></div>
          <div id="invitePermissionFields" class="invite-permission-fields ${invite?.permissions ? "" : "is-hidden"}">${renderPermissionFields("invite", invite?.permissions)}</div>
          <div class="field wide"><label>自定义模式额度</label><select id="inviteCustomModeLimitMode"><option value="default" ${invite?.customModeLimits ? "" : "selected"}>使用全局最高设置</option><option value="custom" ${invite?.customModeLimits ? "selected" : ""}>随邀请码永久发放特殊额度</option></select><small>注册成功后单独写入用户，不归入权限。</small></div>
          <div id="inviteCustomModeLimitFields" class="invite-permission-fields ${invite?.customModeLimits ? "" : "is-hidden"}">${renderCustomModeLimitFields("inviteCustomMode", invite?.customModeLimits, { partial: true })}</div>
          <div class="field wide"><label>专属房间号赠送</label><select id="inviteReservedRoomCodeMode"><option value="none" ${invite?.reservedRoomCodeMode ? "" : "selected"}>不赠送</option><option value="user-input" ${invite?.reservedRoomCodeMode === "user-input" ? "selected" : ""}>由用户输入</option><option value="random" ${invite?.reservedRoomCodeMode === "random" ? "selected" : ""}>随机生成</option></select><small>用户输入和随机生成均限制为最多 6 位数字；随机号可含前导 0。</small></div>
          ${renderInvitationGrantFields(invite, "admin", "管理员", invite?.role ?? "normal")}
          ${renderInvitationGrantFields(invite, "advanced", "高级用户", invite?.role ?? "normal")}
          ${renderAdvancedAiGrantFields("invite", invite?.advancedAiDurationMs, invite?.advancedAiExpiresAt)}
          ${renderInvitationTaxFields(invite)}
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-invite-edit" data-code="${escapeAttr(invite?.code ?? "")}">保存</button></div>
      </section>
    </div>
  `;
}

function renderInvitationGrantFields(
  invite: InvitationCode | undefined,
  kind: "admin" | "advanced",
  label: string,
  role: UserRole,
): string {
  const id = kind === "admin" ? "Admin" : "Advanced";
  const mode = invitationGrantMode(invite, kind);
  const duration = kind === "admin" ? invite?.adminDurationMs : invite?.advancedDurationMs;
  const expiresAt = kind === "admin" ? invite?.adminExpiresAt : invite?.advancedExpiresAt;
  const { amount, unit } = invitationDurationParts(duration);
  const enabled = invitationRoleIncludes(role, kind);
  return `
    <div id="invite${id}GrantFields" class="invite-grant-fields ${enabled ? "" : "is-hidden"}">
      <div class="field">
        <label>${label}期限方式</label>
        <select id="invite${id}Mode">
          <option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option>
          <option value="relative" ${mode === "relative" ? "selected" : ""}>注册后相对时间</option>
          <option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option>
        </select>
      </div>
      <div id="invite${id}RelativeField" class="field ${mode === "relative" ? "" : "is-hidden"}">
        <label>${label}相对时长</label>
        <div class="compound-input">
          <input id="invite${id}DurationAmount" type="number" min="1" step="1" value="${amount}" />
          <select id="invite${id}DurationUnit">
            <option value="day" ${unit === "day" ? "selected" : ""}>日</option>
            <option value="hour" ${unit === "hour" ? "selected" : ""}>小时</option>
          </select>
        </div>
      </div>
      <div id="invite${id}AbsoluteField" class="field ${mode === "absolute" ? "" : "is-hidden"}">
        <label>${label}截止时间</label>
        <div class="date-input-group"><input id="invite${id}ExpiresAt" type="datetime-local" value="${escapeAttr(toLocalDateTime(expiresAt))}" /><button class="btn" type="button" data-act="clear-date" data-target="invite${id}ExpiresAt">清空</button></div>
      </div>
    </div>
  `;
}

function renderEditActivationDialog(state: Extract<DialogState, { kind: "edit-activation" }>): string {
  const activation = state.code ? activationCodes.find((item) => item.code === state.code) : undefined;
  const policy = activation?.usePolicy ?? "global-total";
  const rolling = policy === "global-window" || policy === "per-user-window";
  const neverExpires = !activation?.expiresAt;
  const titleMode = activation?.titleMode ?? "default";
  const nicknameColorMode = activation?.nicknameColorMode ?? "default";
  const customPermissions = Boolean(activation?.permissions);
  const customModeLimits = Boolean(activation?.customModeLimits);
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>${activation ? "编辑激活码" : "新激活码"}</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>激活码</label><input id="activationCode" maxlength="32" value="${escapeAttr(activation?.code ?? "")}" ${activation ? "disabled" : ""} /></div>
          <div class="field"><label>使用策略</label><select id="activationPolicy">${activationPolicyOptions(policy)}</select></div>
          <div id="activationMaxUsesField" class="field ${policy === "unlimited" ? "is-hidden" : ""}"><label>最多使用次数</label><input id="activationMaxUses" type="number" min="1" step="1" value="${activation?.maxUses ?? 1}" /></div>
          <div id="activationWindowDaysField" class="field ${rolling ? "" : "is-hidden"}"><label>滚动周期（日）</label><input id="activationWindowDays" type="number" min="1" step="1" value="${activation?.windowMs ? Math.round(activation.windowMs / 86_400_000) : 7}" /></div>
          <div class="field"><label>有效期限</label><select id="activationExpiryMode"><option value="never" ${neverExpires ? "selected" : ""}>永久有效</option><option value="absolute" ${neverExpires ? "" : "selected"}>指定失效时间</option></select></div>
          ${dateTimeField("activationExpiresAt", "失效时间", activation?.expiresAt, { wrapperId: "activationExpiresAtField", hidden: neverExpires })}
          <div class="field"><label>增加积分</label><input id="activationPoints" type="number" step="1" value="${activation?.points ?? 0}" /></div>
          <div id="activationBalanceGuardField" class="field ${(activation?.points ?? 0) < 0 ? "" : "is-hidden"}"><label>扣分保护</label><select id="activationBalanceGuard"><option value="false" ${activation?.requireNonNegativeBalance ? "" : "selected"}>允许兑换后为负</option><option value="true" ${activation?.requireNonNegativeBalance ? "selected" : ""}>兑换后必须非负</option></select></div>
          <div class="field"><label>头衔</label><select id="activationTitleMode"><option value="default" ${titleMode === "default" ? "selected" : ""}>默认（不改变）</option><option value="fixed" ${titleMode === "fixed" ? "selected" : ""}>固定</option><option value="user-custom" ${titleMode === "user-custom" ? "selected" : ""}>用户自定义</option></select></div>
          <div id="activationFixedTitleField" class="field ${titleMode === "fixed" ? "" : "is-hidden"}"><label>固定头衔</label><input id="activationTitle" maxlength="24" value="${escapeAttr(activation?.title ?? "")}" /></div>
          <div class="field"><label>昵称颜色</label><select id="activationNicknameColorMode"><option value="default" ${nicknameColorMode === "default" ? "selected" : ""}>默认（不改变）</option><option value="fixed" ${nicknameColorMode === "fixed" ? "selected" : ""}>固定</option><option value="user-custom" ${nicknameColorMode === "user-custom" ? "selected" : ""}>用户自定义</option></select></div>
          <div id="activationFixedNicknameColorField" class="field ${nicknameColorMode === "fixed" ? "" : "is-hidden"}"><label>固定昵称颜色</label><input id="activationNicknameColor" maxlength="7" placeholder="#008F8F" value="${escapeAttr(activation?.nicknameColor ?? "")}" /></div>
          ${renderActivationGrantFields(activation, "admin", "管理员")}
          ${renderActivationGrantFields(activation, "advanced", "高级用户")}
          ${renderAdvancedAiGrantFields("activation", activation?.advancedAiDurationMs, activation?.advancedAiExpiresAt)}
          ${renderActivationTaxFields(activation)}
          <div class="field"><label>权限</label><select id="activationPermissionMode"><option value="default" ${customPermissions ? "" : "selected"}>使用身份组默认</option><option value="custom" ${customPermissions ? "selected" : ""}>自定义权限</option></select></div>
          <div id="activationPermissionFields" class="invite-permission-fields ${customPermissions ? "" : "is-hidden"}">${renderPermissionFields("activation", activation?.permissions, { partial: true })}</div>
          <div class="field wide"><label>自定义模式额度</label><select id="activationCustomModeLimitMode"><option value="default" ${customModeLimits ? "" : "selected"}>不发放（继续使用全局最高设置）</option><option value="custom" ${customModeLimits ? "selected" : ""}>发放特殊额度</option></select><small>独立于权限，可单独设置有效期。</small></div>
          <div id="activationCustomModeLimitFields" class="invite-permission-fields ${customModeLimits ? "" : "is-hidden"}">
            ${renderCustomModeLimitFields("activationCustomMode", activation?.customModeLimits, { partial: true })}
            ${renderActivationCustomModeLimitDuration(activation)}
          </div>
          <div class="field wide"><label>专属房间号赠送</label><select id="activationReservedRoomCodeMode"><option value="none" ${activation?.reservedRoomCodeMode ? "" : "selected"}>不赠送</option><option value="user-input" ${activation?.reservedRoomCodeMode === "user-input" ? "selected" : ""}>由用户输入</option><option value="random" ${activation?.reservedRoomCodeMode === "random" ? "selected" : ""}>随机生成</option></select><small>用户输入时会在兑换确认中要求填写，随机模式由系统分配。</small></div>
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-activation" data-code="${escapeAttr(activation?.code ?? "")}">保存</button></div>
      </section>
    </div>
  `;
}

function renderPointDistributionDialog(state: Extract<DialogState, { kind: "edit-point-distribution" }>): string {
  const activation = state.code ? activationCodes.find((item) => item.code === state.code) : undefined;
  const neverExpires = !activation?.expiresAt;
  const maximumUses = Math.max(1, activationRegisteredUserCount || managedUsers.length);
  const locked = Boolean(activation?.redemptions.length);
  const distributionMode = activation?.distributionMode ?? "random";
  const maxUses = activation?.maxUses ?? 1;
  const totalPoints = activation?.totalPoints ?? maxUses;
  const perUserPoints = distributionMode === "equal" ? Math.floor(totalPoints / Math.max(1, maxUses)) : 1;
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>${activation ? "编辑激活码红包" : "发送激活码红包"}</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        <p class="dialog-subtitle">玩家总积分数：${managedUsersTotalPoints()}</p>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid point-distribution-grid">
          <div class="field"><label>激活码</label><input id="pointDistributionCode" maxlength="32" value="${escapeAttr(activation?.code ?? "")}" ${activation ? "disabled" : ""} /></div>
          ${locked
      ? `<div class="field wide"><label>发放规则</label><p class="muted">${distributionMode === "equal" ? "均分" : "瓜分"}；${activation?.maxUses ?? 0} 次；总积分 ${activation?.totalPoints ?? 0}</p></div>`
      : `
              <div class="field"><label>发放模式</label><select id="pointDistributionMode"><option value="random" ${distributionMode === "random" ? "selected" : ""}>瓜分</option><option value="equal" ${distributionMode === "equal" ? "selected" : ""}>均分</option></select></div>
              <div class="field"><label>领取人数</label><input id="pointDistributionMaxUses" type="number" min="1" max="${maximumUses}" step="1" value="${maxUses}" /><small>当前注册用户共 ${maximumUses} 人</small></div>
              <div id="pointDistributionRandomField" class="field ${distributionMode === "random" ? "" : "is-hidden"}"><label>发放总积分数</label><input id="pointDistributionTotalPoints" type="number" min="1" step="1" value="${totalPoints}" /><small id="pointDistributionAverageHint" class="calculated-hint">人均获得：${formatAverage(totalPoints / Math.max(1, maxUses))}</small></div>
              <div id="pointDistributionEqualField" class="field ${distributionMode === "equal" ? "" : "is-hidden"}"><label>每个人得到的积分数</label><input id="pointDistributionPerUserPoints" type="number" min="1" step="1" value="${perUserPoints}" /><small id="pointDistributionTotalHint" class="calculated-hint">总发放积分数：${perUserPoints * maxUses}</small></div>
            `}
          <div class="field"><label>有效期限</label><select id="pointDistributionExpiryMode"><option value="never" ${neverExpires ? "selected" : ""}>永久有效</option><option value="absolute" ${neverExpires ? "" : "selected"}>指定失效时间</option></select></div>
          ${dateTimeField("pointDistributionExpiresAt", "失效时间", activation?.expiresAt, { wrapperId: "pointDistributionExpiresAtField", hidden: neverExpires })}
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-point-distribution" data-code="${escapeAttr(activation?.code ?? "")}">保存</button></div>
      </section>
    </div>
  `;
}

function renderBulkGrantPointsDialog(state: Extract<DialogState, { kind: "bulk-grant-points" }>): string {
  const users = sortedManagedUsersForLeaderboard();
  const selected = new Set(state.selectedUserIds ?? []);
  const selectedCount = selected.size;
  const mode = selectValue("bulkGrantMode") ?? "random";
  const totalPoints = Number(inputValue("bulkGrantTotalPoints") ?? 0);
  const perUserPoints = Number(inputValue("bulkGrantPerUserPoints") ?? 0);
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog bulk-grant-dialog">
        <div class="modal-head"><h2>一键发放积分</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        <p class="dialog-subtitle">玩家总积分数：${managedUsersTotalPoints()}</p>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="bulk-grant-toolbar"><label class="bulk-select-all"><input id="bulkSelectAll" type="checkbox" ${selectedCount === users.length && users.length ? "checked" : ""}/> 全选</label><span class="muted">已选择 ${selectedCount} 人</span></div>
        <div class="user-table-wrap bulk-user-select-table"><table class="user-table bulk-grant-user-table"><thead><tr><th class="select-col">选择</th><th class="numeric-col">今日对局积分变化</th><th>昵称</th><th>用户名</th><th class="numeric-col">积分</th></tr></thead><tbody>${users.map((user) => `<tr><td class="select-col"><input type="checkbox" data-bulk-user="${escapeAttr(user.id)}" ${selected.has(user.id) ? "checked" : ""}/></td><td class="numeric-col ${pointDeltaClass(user.todayGamePointsDelta ?? 0)}">${formatSignedInteger(user.todayGamePointsDelta ?? 0)}</td><td title="${escapeAttr(user.nickname)}"><strong style="color:${escapeAttr(user.nicknameColor)}">${escapeHtml(user.nickname)}</strong></td><td title="${escapeAttr(user.username)}"><span class="username-text">@${escapeHtml(user.username)}</span></td><td class="numeric-col">${user.points}</td></tr>`).join("")}</tbody></table></div>
        <div class="bulk-grant-controls">
          <div class="field"><label>发放模式</label><select id="bulkGrantMode"><option value="random" ${mode === "random" ? "selected" : ""}>瓜分</option><option value="equal" ${mode === "equal" ? "selected" : ""}>均分</option></select></div>
          <div id="bulkGrantRandomField" class="field ${mode === "random" ? "" : "is-hidden"}"><label>发放总积分数</label><input id="bulkGrantTotalPoints" type="number" step="1" value="${Number.isFinite(totalPoints) && totalPoints ? totalPoints : ""}" /><small id="bulkGrantAverageHint" class="calculated-hint">人均获得：${selectedCount ? formatAverage(totalPoints / selectedCount) : 0}</small></div>
          <div id="bulkGrantEqualField" class="field ${mode === "equal" ? "" : "is-hidden"}"><label>每个人得到的积分数</label><input id="bulkGrantPerUserPoints" type="number" step="1" value="${Number.isFinite(perUserPoints) && perUserPoints ? perUserPoints : ""}" /><small id="bulkGrantTotalHint" class="calculated-hint">总发放积分数：${selectedCount * (Number.isFinite(perUserPoints) ? perUserPoints : 0)}</small></div>
          <button class="btn primary bulk-grant-submit" data-act="submit-bulk-grant-points">发放</button>
        </div>
      </section>
    </div>`;
}

function renderEditAdvancedAiFields(user: PublicUser): string {
  const mode = user.advancedAiPermanent ? "permanent" : user.advancedAiExpiresAt ? "absolute" : "none";
  return `
    <div class="field"><label>高级 AI 权限</label><select id="editAdvancedAiMode" ${user.superAdmin ? "disabled" : ""}>
      <option value="none" ${mode === "none" ? "selected" : ""}>不授予</option>
      <option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止日期</option>
      <option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久授予</option>
    </select></div>
    ${dateTimeField("editAdvancedAiExpiresAt", "高级 AI 截止日期", user.advancedAiExpiresAt, { wrapperId: "editAdvancedAiAbsoluteField", hidden: mode !== "absolute" })}
  `;
}

function renderEditTaxRateFields(user: PublicUser): string {
  const mode = user.taxRatePercent === undefined ? "default" : "custom";
  return `
    <div class="field"><label>用户最高征税比例</label><select id="editTaxRateMode">
      <option value="default" ${mode === "default" ? "selected" : ""}>使用全局设置</option>
      <option value="custom" ${mode === "custom" ? "selected" : ""}>单独设置</option>
    </select></div>
    <div id="editTaxRateField" class="field ${mode === "custom" ? "" : "is-hidden"}"><label>最高征税比例（%）</label><input id="editTaxRatePercent" type="number" min="-1" max="100" step="1" value="${user.taxRatePercent ?? 10}" /><small class="calculated-hint">-1 表示不征税；非整数税收向下取整。</small></div>
  `;
}

function renderInvitationTaxFields(invite: InvitationCode | undefined): string {
  const mode = typeof invite?.taxRatePercent === "number" ? "custom" : "default";
  const percent = typeof invite?.taxRatePercent === "number" ? invite.taxRatePercent : 10;
  return `
    <div class="field"><label>用户最高征税比例</label><select id="inviteTaxRateMode">
      <option value="default" ${mode === "default" ? "selected" : ""}>使用全局设置</option>
      <option value="custom" ${mode === "custom" ? "selected" : ""}>单独设置</option>
    </select></div>
    <div id="inviteTaxRateField" class="field ${mode === "custom" ? "" : "is-hidden"}"><label>最高征税比例（%）</label><input id="inviteTaxRatePercent" type="number" min="-1" max="100" step="1" value="${percent}" /><small class="calculated-hint">-1 表示不征税；选择使用全局设置则注册后沿用全局税收比例。</small></div>
  `;
}

function renderActivationTaxFields(activation: ActivationCode | undefined): string {
  const mode = typeof activation?.taxRatePercent === "number" ? "custom" : "default";
  const percent = typeof activation?.taxRatePercent === "number" ? activation.taxRatePercent : 10;
  return `
    <div class="field"><label>用户最高征税比例</label><select id="activationTaxRateMode">
      <option value="default" ${mode === "default" ? "selected" : ""}>使用全局设置</option>
      <option value="custom" ${mode === "custom" ? "selected" : ""}>单独设置</option>
    </select></div>
    <div id="activationTaxRateField" class="field ${mode === "custom" ? "" : "is-hidden"}"><label>最高征税比例（%）</label><input id="activationTaxRatePercent" type="number" min="-1" max="100" step="1" value="${percent}" /><small class="calculated-hint">-1 表示不征税；选择使用全局设置则兑换后沿用全局税收比例。</small></div>
  `;
}

function renderTaxSettingsDialog(state: Extract<DialogState, { kind: "tax-settings" }>): string {
  const percent = taxSettings?.taxRatePercent ?? 10;
  const threshold = taxSettings?.taxWinnerPointsThreshold;
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>税收管理</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        <p class="dialog-subtitle">胜利者税收会先按底注公式计算，再用本比例限制为获胜者原本可得积分的对应百分比。</p>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>最高征税比例（%）</label><input id="globalTaxRatePercent" type="number" min="-1" max="100" step="1" value="${percent}" /><small class="calculated-hint">范围 -1 到 100；-1 表示不征税。默认按本次需求为 10%。</small></div>
          <div class="field"><label>仅对税前积分高于此值的赢家征税</label><input id="globalTaxWinnerPointsThreshold" type="number" step="1" value="${threshold ?? ""}" placeholder="留空则对全部用户征税" /><small class="calculated-hint">按获胜者获得结算积分后、扣税前的积分判断；必须严格大于该值才征税。</small></div>
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-tax-settings">保存税收设置</button></div>
      </section>
    </div>
  `;
}

function renderActivationGrantFields(activation: ActivationCode | undefined, kind: "admin" | "advanced", label: string): string {
  const id = kind === "admin" ? "Admin" : "Advanced";
  const duration = kind === "admin" ? activation?.adminDurationMs : activation?.advancedDurationMs;
  const expiresAt = kind === "admin" ? activation?.adminExpiresAt : activation?.advancedExpiresAt;
  const enabled = duration !== undefined || Boolean(expiresAt);
  const mode = duration === null ? "permanent" : expiresAt ? "absolute" : "relative";
  const { amount, unit } = invitationDurationParts(duration);
  return `
    <div class="field"><label>${label}身份</label><select id="activation${id}Grant"><option value="default" ${enabled ? "" : "selected"}>默认（不改变）</option><option value="grant" ${enabled ? "selected" : ""}>授予</option></select></div>
    <div id="activation${id}GrantFields" class="activation-grant-fields ${enabled ? "" : "is-hidden"}">
      <div class="field"><label>${label}期限方式</label><select id="activation${id}Mode"><option value="relative" ${mode === "relative" ? "selected" : ""}>相对截止时间</option><option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option><option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option></select></div>
      <div id="activation${id}RelativeField" class="field ${mode === "relative" ? "" : "is-hidden"}"><label>${label}相对时长</label><div class="compound-input"><input id="activation${id}DurationAmount" type="number" min="1" step="1" value="${amount}" /><select id="activation${id}DurationUnit"><option value="day" ${unit === "day" ? "selected" : ""}>日</option><option value="hour" ${unit === "hour" ? "selected" : ""}>小时</option></select></div></div>
      ${dateTimeField(`activation${id}ExpiresAt`, `${label}截止时间`, expiresAt, { wrapperId: `activation${id}AbsoluteField`, hidden: mode !== "absolute" })}
    </div>
  `;
}

function renderAdvancedAiGrantFields(
  prefix: "invite" | "activation",
  duration?: number | null,
  expiresAt?: string,
): string {
  const id = `${prefix}AdvancedAi`;
  const enabled = duration !== undefined || Boolean(expiresAt);
  const mode = duration === null ? "permanent" : expiresAt ? "absolute" : "relative";
  const { amount, unit } = invitationDurationParts(duration);
  return `
    <div class="field"><label>高级 AI 权限</label><select id="${id}Grant"><option value="default" ${enabled ? "" : "selected"}>不授予</option><option value="grant" ${enabled ? "selected" : ""}>授予</option></select></div>
    <div id="${id}GrantFields" class="activation-grant-fields ${enabled ? "" : "is-hidden"}">
      <div class="field"><label>高级 AI 期限方式</label><select id="${id}Mode"><option value="relative" ${mode === "relative" ? "selected" : ""}>相对截止时间</option><option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option><option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option></select></div>
      <div id="${id}RelativeField" class="field ${mode === "relative" ? "" : "is-hidden"}"><label>高级 AI 相对时长</label><div class="compound-input"><input id="${id}DurationAmount" type="number" min="1" step="1" value="${amount}" /><select id="${id}DurationUnit"><option value="day" ${unit === "day" ? "selected" : ""}>日</option><option value="hour" ${unit === "hour" ? "selected" : ""}>小时</option></select></div></div>
      ${dateTimeField(`${id}ExpiresAt`, "高级 AI 截止时间", expiresAt, { wrapperId: `${id}AbsoluteField`, hidden: mode !== "absolute" })}
    </div>
  `;
}

function renderActivationCustomModeLimitDuration(activation?: ActivationCode): string {
  const duration = activation?.customModeLimitDurationMs;
  const permanent = duration === null;
  const { amount, unit } = invitationDurationParts(duration);
  return `
    <div class="field"><label>特殊额度期限</label><select id="activationCustomModeLimitDurationMode"><option value="relative" ${permanent ? "" : "selected"}>兑换后相对时长</option><option value="permanent" ${permanent ? "selected" : ""}>永久</option></select></div>
    <div id="activationCustomModeLimitDurationField" class="field ${permanent ? "is-hidden" : ""}"><label>相对时长</label><div class="compound-input"><input id="activationCustomModeLimitDurationAmount" type="number" min="1" step="1" value="${amount}" /><select id="activationCustomModeLimitDurationUnit"><option value="day" ${unit === "day" ? "selected" : ""}>日</option><option value="hour" ${unit === "hour" ? "selected" : ""}>小时</option></select></div></div>
  `;
}

function defaultPermissionRule(): PermissionRule {
  return {
    exchangeMin: 0,
    exchangeMax: 3,
    canCreateZeroBaseBet: false,
    maxBaseBet: 100,
    duelLimit: { period: "hour", count: 1 },
  };
}

type CustomLimitKind = "customMaxBaseBet" | "customSettlementCap";

function customLimitModes(kind: CustomLimitKind): Array<{ value: string; label: string }> {
  return kind === "customMaxBaseBet"
    ? [
      { value: "absolute", label: "固定整数" },
      { value: "classic-multiple", label: "经典最大底注×倍率" },
      { value: "unlimited", label: "不限" },
    ]
    : [
      { value: "absolute", label: "固定积分" },
      { value: "base-bet-multiple", label: "底注×倍率" },
      { value: "unlimited", label: "不限" },
    ];
}

function renderCustomLimitFields(prefix: string, kind: CustomLimitKind, label: string, rule: CustomMaxBaseBetRule | CustomSettlementCapRule | undefined, options: { partial?: boolean } = {}): string {
  const partial = Boolean(options.partial);
  const isDefault = partial && rule === undefined;
  const mode = isDefault ? "default" : (rule?.mode ?? "unlimited");
  const rawValue = rule && "value" in rule ? rule.value : rule && "factor" in rule ? rule.factor : 1;
  const showValue = mode === "absolute" || mode === "classic-multiple" || mode === "base-bet-multiple";
  const inputId = `${prefix}${kind === "customMaxBaseBet" ? "CustomMaxBet" : "CustomCap"}`;
  return `
    <div class="field"><label>${label}</label><select id="${inputId}Mode">
      ${partial ? `<option value="default" ${isDefault ? "selected" : ""}>默认</option>` : ""}
      ${customLimitModes(kind).map((entry) => `<option value="${entry.value}" ${mode === entry.value ? "selected" : ""}>${entry.label}</option>`).join("")}
    </select></div>
    <div id="${inputId}ValueField" class="field ${showValue ? "" : "is-hidden"}"><label>数值</label><input id="${inputId}Value" type="number" min="0" step="any" value="${rawValue ?? 1}" /></div>
  `;
}

function renderCustomModeLimitFields(prefix: string, limits?: CustomModeLimitGrant, options: { partial?: boolean } = {}): string {
  return `
    ${renderCustomLimitFields(prefix, "customMaxBaseBet", "自定义模式最大底注", limits?.maxBaseBet, options)}
    ${renderCustomLimitFields(prefix, "customSettlementCap", "每名输家扣分上限（按开房者）", limits?.settlementCap, options)}
    <p class="calculated-hint">开局时冻结开房者的额度；每名输家最多扣除此额度，赢家获得全部实际扣分，积分总量保持不变。</p>
  `;
}

function duelLimitForDisplay(rule?: Partial<DuelLimitRule>): DuelLimitRule {
  const period = rule?.period ?? "hour";
  if (period === "none") return { period, count: 0 };
  if (period === "unlimited") return { period, count: null };
  if (period === "day" || period === "week" || period === "hour") {
    const count = Number(rule?.count ?? 1);
    return { period, count: Number.isInteger(count) && count > 0 ? count : 1 };
  }
  return { period: "hour", count: 1 };
}

function duelPeriodLabel(period: DuelLimitPeriod): string {
  if (period === "hour") return "每小时";
  if (period === "day") return "每天";
  if (period === "week") return "每周";
  if (period === "none") return "不允许决斗";
  return "不限";
}

function renderDuelLimitFields(prefix: string, rule?: Partial<DuelLimitRule>, options: { partial?: boolean } = {}): string {
  const partial = Boolean(options.partial);
  const normalized = duelLimitForDisplay(rule);
  const selected = partial && rule === undefined ? "default" : normalized.period;
  const count = normalized.count ?? 1;
  const showCount = selected === "hour" || selected === "day" || selected === "week";
  return `
    <div class="field"><label>决斗次数</label><select id="${prefix}DuelPolicy">
      ${partial ? `<option value="default" ${selected === "default" ? "selected" : ""}>默认</option>` : ""}
      <option value="none" ${selected === "none" ? "selected" : ""}>不允许决斗</option>
      <option value="hour" ${selected === "hour" ? "selected" : ""}>每小时</option>
      <option value="day" ${selected === "day" ? "selected" : ""}>每天</option>
      <option value="week" ${selected === "week" ? "selected" : ""}>每周</option>
      <option value="unlimited" ${selected === "unlimited" ? "selected" : ""}>不限</option>
    </select></div>
    <div id="${prefix}DuelCountField" class="field ${showCount ? "" : "is-hidden"}"><label>周期内可创建</label><div class="compound-input"><input id="${prefix}DuelCount" type="number" min="1" step="1" value="${count}" /><span>次</span></div></div>
  `;
}

function renderPermissionFields(prefix: string, permissions?: Partial<PermissionRule>, options: { partial?: boolean } = {}): string {
  const partial = Boolean(options.partial);
  const exchangeDefault = partial && permissions?.exchangeMax === undefined;
  const zeroDefault = partial && permissions?.canCreateZeroBaseBet === undefined;
  const maxBaseBetDefault = partial && permissions?.maxBaseBet === undefined;
  return `
    <div class="field"><label>最大换牌数</label><select id="${prefix}ExchangeMaxMode" class="${partial ? "" : "is-hidden"}"><option value="default" ${exchangeDefault ? "selected" : ""}>默认</option><option value="custom" ${exchangeDefault ? "" : "selected"}>指定</option></select><select id="${prefix}ExchangeMax" class="${partial && exchangeDefault ? "is-hidden" : ""}">${exchangeMaxOptions(permissions?.exchangeMax)}</select></div>
    <div class="field"><label>允许 0 底注</label><select id="${prefix}ZeroBet">${partial ? `<option value="default" ${zeroDefault ? "selected" : ""}>默认</option>` : ""}<option value="false" ${!zeroDefault && !permissions?.canCreateZeroBaseBet ? "selected" : ""}>否</option><option value="true" ${!zeroDefault && permissions?.canCreateZeroBaseBet ? "selected" : ""}>是</option></select></div>
    <div class="field"><label>最大底注</label><select id="${prefix}MaxBaseBetMode" class="${partial ? "" : "is-hidden"}"><option value="default" ${maxBaseBetDefault ? "selected" : ""}>默认</option><option value="custom" ${maxBaseBetDefault ? "" : "selected"}>指定</option></select><input id="${prefix}MaxBaseBet" class="${partial && maxBaseBetDefault ? "is-hidden" : ""}" type="number" min="0" step="1" placeholder="不限" value="${permissions?.maxBaseBet ?? ""}" /></div>
    ${renderDuelLimitFields(prefix, permissions?.duelLimit, { partial })}
  `;
}

function dateTimeField(
  inputId: string,
  label: string,
  value?: string,
  options: { wrapperId?: string; wrapperClass?: string; hidden?: boolean } = {},
): string {
  return `
    <div ${options.wrapperId ? `id="${options.wrapperId}"` : ""} class="field ${options.wrapperClass ?? ""} ${options.hidden ? "is-hidden" : ""}">
      <label>${label}</label>
      <div class="date-input-group">
        <input id="${inputId}" type="datetime-local" value="${escapeAttr(toLocalDateTime(value))}" />
        <button class="btn" type="button" data-act="clear-date" data-target="${inputId}">清空</button>
      </div>
    </div>
  `;
}

function renderRedeemActivationDialog(state: Extract<DialogState, { kind: "redeem-activation" }>): string {
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>兑换激活码</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="field"><label>激活码</label><input id="redeemActivationCode" maxlength="32" /></div>
        <div class="top-actions"><button class="btn primary" data-act="submit-activation-redeem">兑换</button></div>
      </section>
    </div>
  `;
}

function renderRedeemActivationCustomDialog(
  state: Extract<DialogState, { kind: "redeem-activation-custom" }>,
): string {
  const customTitle = state.titleMode === "user-custom";
  const customNicknameColor = state.nicknameColorMode === "user-custom";
  const customReservedRoomCode = state.reservedRoomCodeMode === "user-input";
  const customItems = [
    customTitle ? "头衔" : "",
    customNicknameColor ? "昵称颜色" : "",
    customReservedRoomCode ? "专属房间号" : "",
  ].filter(Boolean);
  const reservedRoomCodeOnly = customReservedRoomCode && customItems.length === 1;
  const dialogTitle = reservedRoomCodeOnly ? "领取专属房间号" : "填写激活码自定义内容";
  const description = reservedRoomCodeOnly
    ? "该激活码会为你的账号添加一个专属房间号，请输入要绑定的号码。取消将不会兑换激活码。"
    : `该激活码需要你填写：${customItems.join("、")}。取消将不会兑换激活码。`;
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>${dialogTitle}</h2><button class="btn ghost" data-act="dialog-close">取消</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <p class="muted">${description}</p>
        ${customTitle ? `<div class="field"><label>头衔</label><input id="redeemActivationTitle" maxlength="24" /></div>` : ""}
        ${customNicknameColor ? `<div class="field"><label>昵称颜色</label><input id="redeemActivationNicknameColor" maxlength="7" placeholder="#008F8F" /></div>` : ""}
        ${customReservedRoomCode ? `<div class="field"><label>专属房间号</label><input id="redeemActivationReservedRoomCode" inputmode="numeric" maxlength="6" placeholder="仅数字，最多 6 位；可保留前导 0" /><small>该号码将归属于你的账号。</small></div>` : ""}
        <div class="top-actions">
          <button class="btn" data-act="dialog-close">取消</button>
          <button class="btn primary" data-act="confirm-activation-custom">确认并兑换</button>
        </div>
      </section>
    </div>
  `;
}

function renderDeleteCodeDialog(
  state: Extract<DialogState, { kind: "delete-invite" | "delete-activation" }>,
  label: string,
): string {
  const action = state.kind === "delete-invite" ? "confirm-delete-invite" : "confirm-delete-activation";
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>删除${label}</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <p class="muted">确认删除 ${escapeHtml(state.code)}。已完成的注册或兑换记录不会回退。</p>
        <div class="top-actions"><button class="btn danger" data-act="${action}" data-code="${escapeAttr(state.code)}">确认删除</button></div>
      </section>
    </div>
  `;
}

function renderPermissionsDialog(state: Extract<DialogState, { kind: "permissions" }>): string {
  const rule = permissionsSnapshot?.rolePermissions.normal ?? defaultPermissionRule();
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>权限设置</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>身份组</label><select id="permRole">${roleOptions("normal", true)}</select></div>
          ${renderPermissionFields("perm", rule)}
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-permissions">保存权限</button></div>
      </section>
    </div>
  `;
}

function renderCustomPresetsDialog(state: Extract<DialogState, { kind: "custom-presets" }>): string {
  const presets = customPresetsSnapshot ?? [];
  const form = state.form;
  const limits = customModeLimitsSnapshot ?? defaultCustomModeLimits();
  return `
    <div class="modal-backdrop">
      <section class="modal panel rules-editor-dialog">
        <div class="modal-head"><h2>自定义模式设置</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        ${state.previewResult ? `<p class="muted">${escapeHtml(state.previewResult)}</p>` : ""}
        <section class="panel-section">
          <h3>全局最高设置</h3>
          <p class="muted">所有用户默认使用这里的最大底注和每名输家扣分上限；开房时采用开房者额度。用户特殊情况可在用户、邀请码或激活码中单独发放。</p>
          <div class="setup-grid modal-grid">${renderCustomModeLimitFields("globalCustomMode", limits)}</div>
          <div class="top-actions global-settings-save"><button class="btn primary" data-act="save-custom-mode-limits">保存全局设置</button></div>
        </section>
        <section class="panel-section">
          <h3>规则预设</h3>
        ${form
      ? `<div class="setup-grid modal-grid">
              <div class="field wide"><label>预设名称</label><input id="presetDisplayName" maxlength="40" value="${escapeAttr(form.displayName)}" /></div>
              <div class="field wide"><label>规则文档（JSON，可引用其他预设的 preset 字段）</label><textarea id="presetSource" rows="14" spellcheck="false">${escapeHtml(form.source)}</textarea></div>
            </div>
            <div class="top-actions preset-form-actions">
              <button class="btn" data-act="preset-preview">预览校验</button>
              <button class="btn" data-act="preset-cancel">取消</button>
              <button class="btn primary" data-act="preset-save">${form.id ? "保存修改" : "新增预设"}</button>
            </div>`
      : `<div class="preset-table-wrap"><table class="table preset-table"><thead><tr><th>名称</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>
              ${presets.length === 0 ? `<tr><td colspan="4" class="muted">暂无预设</td></tr>` : presets.map((preset) => `<tr>
                <td data-label="名称">${escapeHtml(preset.displayName)}</td>
                <td data-label="状态">${preset.enabled ? "启用" : "停用"}</td>
                <td data-label="更新时间">${escapeHtml(formatDate(preset.updatedAt))}</td>
                <td class="preset-actions" data-label="操作">
                  <button class="btn ghost" data-act="preset-edit" data-id="${escapeAttr(preset.id)}">编辑</button>
                  <button class="btn ghost" data-act="preset-toggle" data-id="${escapeAttr(preset.id)}">${preset.enabled ? "停用" : "启用"}</button>
                  <button class="btn ghost" data-act="preset-duplicate" data-id="${escapeAttr(preset.id)}">复制</button>
                  <button class="btn ghost danger" data-act="preset-delete" data-id="${escapeAttr(preset.id)}">删除</button>
                </td>
              </tr>`).join("")}
            </tbody></table></div>
            <p class="muted">房间创建时会冻结规则快照；此后修改预设不影响已创建的房间。停用后新房间不能再选用。</p>
            <div class="top-actions"><button class="btn primary" data-act="preset-new">新增预设</button></div>`
    }
        </section>
      </section>
    </div>
  `;
}

function renderRequestDialog(state: Extract<DialogState, { kind: "request" }>): string {
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>工单/申请</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>类型</label><select id="requestKind"><option value="ticket">工单</option><option value="unban">解封申请</option><option value="nickname">昵称修改</option></select></div>
          <div class="field"><label>仅超级管理员</label><select id="requestPrivate"><option value="false">否</option><option value="true">是</option></select></div>
          <div class="field wide is-hidden" id="requestNicknameField"><label>新昵称</label><input id="requestNickname" maxlength="24" /></div>
          <div class="field wide" id="requestTextField"><label>内容</label><textarea id="requestText" rows="5"></textarea></div>
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-request">提交</button></div>
      </section>
    </div>
  `;
}

function renderReviewTicketDialog(state: Extract<DialogState, { kind: "review-ticket" }>): string {
  const request = requests.find((item) => item.id === state.requestId);
  if (!request) return "";
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>批复工单</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <p class="muted">${escapeHtml(request.requestedNickname ?? request.text)}</p>
        <div class="field"><label>处理结果</label><select id="ticketStatus">${request.kind === "nickname"
      ? `<option value="approved">通过昵称修改</option>`
      : request.kind === "unban"
        ? `<option value="approved">解除禁用</option>`
        : ""
    }<option value="replied">回复</option><option value="ignored">忽略</option></select></div>
        <div class="field"><label>回复内容</label><textarea id="ticketReply" rows="5"></textarea></div>
        <div class="top-actions"><button class="btn primary" data-act="submit-ticket-review" data-request-id="${escapeAttr(request.id)}">提交批复</button></div>
      </section>
    </div>
  `;
}

function renderKickPlayerDialog(state: Extract<DialogState, { kind: "kick-player" }>): string {
  const target = room?.players.find((player) => player.id === state.playerId);
  if (!target) return "";
  return `
    <div class="modal-backdrop">
      <section class="modal panel kick-dialog">
        <div class="modal-head"><h2>移出房间</h2><button class="btn ghost" data-act="dialog-close">取消</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="kick-target">
          <span class="kick-target-mark">${target.bot ? "AI" : "员"}</span>
          <div><strong>${escapeHtml(target.nickname)}</strong><small>${target.bot ? "机器人" : "已加入成员"}</small></div>
        </div>
        <p class="muted">确认后该成员会立即返回主界面并释放席位。游戏进行过程中不能移出任何成员或机器人。</p>
        <div class="top-actions">
          <button class="btn" data-act="dialog-close">取消</button>
          <button class="btn danger" data-act="confirm-kick-player" data-player-id="${escapeAttr(target.id)}">确认移出</button>
        </div>
      </section>
    </div>
  `;
}

function renderLeaveRoomDialog(state: Extract<DialogState, { kind: "leave-room" }>): string {
  const target = state.local ? game?.players[0] : room?.players.find((player) => player.id === selfId);
  return `
    <div class="modal-backdrop">
      <section class="modal panel kick-dialog">
        <div class="modal-head"><h2>退出房间</h2><button class="btn ghost" data-act="dialog-close">取消</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="kick-target">
          <span class="kick-target-mark">退</span>
          <div><strong>${escapeHtml(target?.nickname ?? "当前玩家")}</strong><small>${state.local ? "本地游戏" : "你的房间席位"}</small></div>
        </div>
        <p class="muted">${state.local ? "退出本地游戏将刷新页面并返回主界面。" : "退出后会立即返回主界面，并由 AI 接替你当前的房间席位。"}</p>
        <div class="top-actions">
          <button class="btn" data-act="dialog-close">取消</button>
          <button class="btn danger" data-act="confirm-leave-room" data-local="${state.local ? "true" : "false"}">确认退出</button>
        </div>
      </section>
    </div>
  `;
}

function renderEditRoomDialog(state: Extract<DialogState, { kind: "edit-room" }>): string {
  if (!room) return "";
  const currentMembers = room.players.length;
  const minimum = Math.max(2, currentMembers);
  const customMode = room.rulesetMode === "custom";
  const gameActive = room.status === "playing" || room.status === "opening-exchange";
  const minimumBaseBet = currentUser?.permissions.canCreateZeroBaseBet ? 0 : 1;
  const maximumBaseBet = customMode ? effectiveCustomMaxBaseBet(currentUser) : effectiveMaxBaseBet(currentUser);
  const betHint = editRoomBetHintText(room.capacity, room.initialHandSize ?? undefined);
  const roomRules = customMode && room.customRulesHash ? customRulesCache.get(room.customRulesHash) : undefined;
  const hasPlayerCountDeckRules = hasPlayerCountDeckOverrides(roomRules);
  const dealRequired = roomRules ? requiredPlayersFromDeal(roomRules, room.capacity) : null;
  const activeRoomDeal = roomRules ? customDeckForPlayerCount(roomRules, room.capacity).deal : undefined;
  const customRoomHandEditable = Boolean(roomRules) && !customDealHasAnyFill(activeRoomDeal);
  const customRoomHandMinimum = customDealMinimumGlobalFill(activeRoomDeal);
  const capacityLocked = !hasPlayerCountDeckRules && dealRequired !== null && dealRequired >= minimum;
  const customRuleLabel = (room.customPresetId
    ? enabledCustomPresets.find((preset) => preset.id === room!.customPresetId)?.displayName
    : undefined) ?? roomRules?.displayName ?? roomRules?.name ?? "当前房间规则";
  return `
    <div class="modal-backdrop">
      <section class="modal panel room-edit-dialog">
        <div class="modal-head"><div><span class="dialog-kicker">房主设置</span><h2>编辑房间 ${escapeHtml(room.code)}</h2></div><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="room-edit-summary">
          <div><span>当前成员</span><strong>${currentMembers}</strong></div>
          <div><span>当前容量</span><strong>${room.capacity}</strong></div>
          <div><span>当前底注</span><strong>${room.baseBet ?? 5}</strong></div>
          <div><span>全局补足</span><strong>${customMode && !customRoomHandEditable ? "由席位规则决定" : room.initialHandSize ?? "规则默认"}</strong></div>
          <div><span>出牌时间</span><strong>${room.turnTimeLimitSec ?? "默认"}</strong></div>
          <div><span>换牌时间</span><strong>${room.openingExchangeSec ?? "默认"}</strong></div>
        </div>
        <div class="setup-grid room-edit-fields">
          <div class="field"><label>${customMode ? "总玩家数" : "总玩家数（含 AI）"}</label><input id="editRoomCapacity" type="number" min="${minimum}" max="10" step="1" value="${capacityLocked ? dealRequired : room.capacity}" ${capacityLocked ? "disabled" : ""} /><small>${capacityLocked ? `规则按 ${dealRequired} 个座位规定了初始发牌，人数固定为 ${dealRequired} 人` : hasPlayerCountDeckRules ? "可设置范围内的不同人数会使用 JSON 中对应的牌堆与初始发牌设置。" : `可设置范围：${minimum}-10${customMode ? "；同时必须在自定义规则允许的人数范围内" : ""}`}</small></div>
          <div class="field"><label>底注</label><input id="editRoomBaseBet" type="number" min="${minimumBaseBet}" ${maximumBaseBet === null ? "" : `max="${maximumBaseBet}"`} step="1" value="${room.baseBet ?? 5}" /><small>允许范围：${minimumBaseBet}-${maximumBaseBet ?? "不限"}${customMode ? "" : "；总发牌数达到 101 张时上限会降低"}；修改将在下一局开始时生效</small></div>
          ${customMode
      ? customRoomHandEditable && roomRules
        ? `<div class="field"><label>全局补足手牌数</label><input id="editRoomInitialHandSize" type="number" inputmode="numeric" min="${customRoomHandMinimum}" max="${customInitialHandSizeMax(roomRules, room.capacity)}" step="1" placeholder="规则默认" value="${room.initialHandSize ?? ""}" /><small id="editRoomInitialHandSizeHint">规则未设置席位补足数，可设 ${customRoomHandMinimum}-${customInitialHandSizeMax(roomRules, room.capacity)}；该值将用于所有玩家；修改将在下一局生效</small></div>`
        : `<div class="field"><label>全局补足手牌数</label><input type="text" value="${roomRules ? "由 JSON 规则的席位补足数决定" : "正在加载规则快照"}" disabled /></div>`
      : `<div class="field"><label>初始手牌数量</label><input id="editRoomInitialHandSize" type="number" inputmode="numeric" min="2" max="${maxInitialHandSize(room.capacity)}" step="1" placeholder="默认" value="${room.initialHandSize ?? ""}" /><small id="editRoomInitialHandSizeHint">留空使用规则默认；按总玩家数可设 2-${maxInitialHandSize(room.capacity)}；修改将在下一局开始时生效</small></div>`
    }
          <div class="field"><label>出牌时间（秒）</label><input id="editRoomTurnTimeLimit" type="number" inputmode="numeric" min="${MIN_ROOM_TIME_LIMIT_SEC}" max="${MAX_ROOM_TIME_LIMIT_SEC}" step="1" placeholder="默认 ${DEFAULT_TURN_TIME_LIMIT_SEC}" value="${room.turnTimeLimitSec ?? ""}" /><small>留空使用默认 ${DEFAULT_TURN_TIME_LIMIT_SEC} 秒；可设 ${MIN_ROOM_TIME_LIMIT_SEC}-${MAX_ROOM_TIME_LIMIT_SEC}；修改将在下一局开始时生效</small></div>
          <div class="field"><label>换牌时间（秒）</label><input id="editRoomOpeningExchangeTime" type="number" inputmode="numeric" min="${MIN_ROOM_TIME_LIMIT_SEC}" max="${MAX_ROOM_TIME_LIMIT_SEC}" step="1" placeholder="默认 ${DEFAULT_OPENING_EXCHANGE_SEC}" value="${room.openingExchangeSec ?? ""}" /><small>留空使用默认 ${DEFAULT_OPENING_EXCHANGE_SEC} 秒；可设 ${MIN_ROOM_TIME_LIMIT_SEC}-${MAX_ROOM_TIME_LIMIT_SEC}；修改将在下一局开始时生效</small></div>
          ${customMode
      ? `<div class="field wide"><label>自定义规则</label><div class="rules-picker"><span>${escapeHtml(customRuleLabel)}</span><button class="btn" type="button" data-act="edit-room-rules" ${gameActive ? "disabled" : ""}>编辑自定义规则</button></div><small>${gameActive ? "对局进行中不能修改规则；当前局规则设置不变" : "保存后由服务器重新解析校验，所有人需重新确认"}</small></div>`
      : ""
    }
        </div>
        ${customMode ? "" : `<p id="editRoomBetHint" class="${betHint.className}">${escapeHtml(betHint.text)}</p>`}
        <p class="room-edit-hint">保存后，当前房间内的所有真人玩家都会收到设置变更通知。</p>
        <div class="top-actions"><button class="btn" data-act="dialog-close">取消</button><button class="btn primary" data-act="submit-room-edit">保存设置</button></div>
      </section>
    </div>
  `;
}

function setupRangeText(value: unknown): string {
  if (Array.isArray(value) && value.length === 2) return `${value[0]}-${value[1]}`;
  if (typeof value === "number") return String(value);
  return "默认";
}

function comparableCustomCardDefinition(def: CustomCardDef): CustomCardDef {
  return materializeCustomCardFollowRules(def);
}

function renderRulesSummary(rules: ResolvedCustomRules, selectedCardId?: string, playerCount?: number): string {
  const roomDeck = playerCount === undefined ? rules.deck : customDeckForPlayerCount(rules, playerCount);
  const roomInitialHand = playerCount === undefined ? rules.setup.initialHand : customInitialHandForPlayerCount(rules, playerCount);
  const total = Object.values(roomDeck.cards).reduce((sum, count) => sum + count, 0);
  const orderCompare = displayOrderComparator(rules);
  const rows = Object.entries(roomDeck.cards)
    .sort(([a], [b]) => orderCompare(a, b))
    .map(([id, count]) => {
      const def = rules.cards[id];
      return `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(def?.displayName ?? "未命名")}</td><td>${count}</td></tr>`;
    })
    .join("");
  const baseCards = PLATFORM_PRESET.cards as Record<string, CustomCardDef>;
  const customOnlyCardIds = new Set(["Hat", "FlameTest", "Criticism"]);
  const changed: Array<{ id: string; def: CustomCardDef; change: "added" | "modified" | "custom-only" }> = [];
  for (const id of Object.keys(rules.cards).sort(orderCompare)) {
    const def = rules.cards[id];
    const baseline = baseCards[id];
    if (!baseline) changed.push({ id, def, change: "added" });
    else if (stableStringify(comparableCustomCardDefinition(def)) !== stableStringify(comparableCustomCardDefinition(baseline))) changed.push({ id, def, change: "modified" });
    else if (customOnlyCardIds.has(id)) changed.push({ id, def, change: "custom-only" });
  }
  const selected = selectedCardId && changed.some((entry) => entry.id === selectedCardId) ? selectedCardId : undefined;
  const changedList = changed
    .map((entry) => `<button class="rules-card-item ${entry.id === selected ? "selected" : ""}" style="--card-list-color:${escapeAttr(defaultTopColor(entry.def))}" data-act="view-rules-card-select" data-card-id="${escapeAttr(entry.id)}"><span>${escapeHtml(entry.def.displayName)}</span><small>${escapeHtml(customCardCategoryLabel(entry.def))} · ${entry.change === "added" ? "新增" : entry.change === "modified" ? "修改" : "非经典"}</small></button>`)
    .join("");
  const selectedEntry = selected ? changed.find((entry) => entry.id === selected)! : undefined;
  const changedDetail = selectedEntry
    ? `
      <div class="setup-grid modal-grid">
        <div class="field"><label>卡牌 ID</label><input value="${escapeAttr(selectedEntry.id)}" disabled /></div>
        <div class="field"><label>显示名称</label><input value="${escapeAttr(selectedEntry.def.displayName)}" disabled /></div>
        <div class="field"><label>类型</label><input value="${escapeAttr(customCardCategoryLabel(selectedEntry.def))}" disabled /></div>
        <div class="field"><label>顶部色条</label><input type="color" value="${escapeAttr(selectedEntry.def.topColor ?? defaultTopColor(selectedEntry.def))}" disabled /></div>
        <div class="field wide"><label>卡牌说明</label><textarea rows="3" disabled>${escapeHtml(selectedEntry.def.description ?? "暂无说明")}</textarea></div>
      </div>
      <p class="muted">${selectedEntry.change === "added" ? "新增自定义卡牌" : selectedEntry.change === "modified" ? "修改过的卡牌" : "非经典模式卡牌"}，行为定义如下（只读）。</p>
      <textarea class="rules-json-input" rows="12" readonly>${escapeHtml(JSON.stringify(selectedEntry.def, null, 2))}</textarea>
    `
    : `<p class="muted rules-card-selection-hint"><span class="desktop-card-selection-hint">从左侧选择一张卡牌查看具体内容。</span><span class="mobile-card-selection-hint">从上方选择一张卡牌查看具体内容。</span></p>`;
  const changedSection = changed.length
    ? `
      <section class="rules-summary-section rules-summary-changed">
        <div class="section-title"><span>变更卡牌</span><span>规则变更 ${changed.filter((entry) => entry.change !== "custom-only").length} · 非经典 ${changed.filter((entry) => entry.change === "custom-only").length}</span></div>
        <div class="rules-cards-layout readonly">
          <div class="rules-card-list">${changedList}</div>
          <div class="rules-card-detail">${changedDetail}</div>
        </div>
      </section>
    `
    : "";
  const dealSection = roomDeck.deal?.length
    ? `
      <section class="rules-summary-section rules-summary-deal">
        <div class="section-title"><span>初始发牌规则</span><span>${roomDeck.deal.length} 个席位</span></div>
        <pre class="rules-json">${escapeHtml(JSON.stringify(roomDeck.deal, null, 2))}</pre>
      </section>
    `
    : "";
  return `
    <div class="room-edit-summary">
      <div><span>玩家人数</span><strong>${setupRangeText(rules.setup.players)}</strong></div>
      <div><span>底注</span><strong>${setupRangeText(rules.setup.baseBet)}</strong></div>
      <div><span>全局补足</span><strong>${setupRangeText(roomInitialHand)}</strong></div>
      <div><span>牌堆总数</span><strong>${total}</strong></div>
      <div><span>卡牌定义</span><strong>${Object.keys(rules.cards).length}</strong></div>
      <div><span>王炸</span><strong>${rules.setup.allowWangZha === false ? "禁止" : "允许"}</strong></div>
    </div>
    ${rules.description ? `<p class="muted">${escapeHtml(rules.description)}</p>` : ""}
    <div class="section-title rules-summary-deck-head"><span>牌堆</span><span>${Object.keys(roomDeck.cards).length} 种 · ${total} 张</span></div>
    <div class="rules-table-wrap readonly-rules-table-wrap"><table class="data-table rules-readonly-deck-table"><colgroup><col /><col /><col /></colgroup><thead><tr><th>牌名</th><th>显示名</th><th>张数</th></tr></thead><tbody>${rows || `<tr><td colspan="3" class="muted">牌堆为空</td></tr>`}</tbody></table></div>
    ${dealSection}
    ${changedSection}
  `;
}

function renderViewRoomRulesDialog(state: Extract<DialogState, { kind: "view-room-rules" }>): string {
  const rules = currentViewableRules();
  return `
    <div class="modal-backdrop">
      <section class="modal panel room-edit-dialog rules-view-dialog">
        <div class="modal-head"><div><span class="dialog-kicker">自定义模式</span><h2>房间规则设置</h2></div><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${rules
      ? renderRulesSummary(rules, state.selectedCardId, room?.capacity ?? game?.players.length)
      : `<p class="muted">规则加载中…</p>`
    }
        ${rules ? `<div class="top-actions rules-view-actions"><button class="btn" data-act="export-rules-full">导出完整规则</button></div>` : ""}
      </section>
    </div>
  `;
}

const RULES_EDITOR_TABS: Array<[RulesEditorTab, string]> = [
  ["cards", "卡牌库"],
  ["deck", "牌堆"],
  ["deal", "初始发牌"],
  ["display", "显示"],
  ["basic", "基础设置"],
  ["json", "高级 JSON"],
];

const ADVANCED_PLAYER_DECK_EDITOR_NOTICE = "已在json中进行高级设定，暂不支持可视化编辑";

/** `deck.byPlayers` may repeat the common deck/deal for convenience. */
function playerOverrideResultDiffers(
  draft: RulesDraft,
  commonValue: unknown,
  valueForPlayers: (players: number) => unknown,
): boolean {
  const overrides = draft.deck.byPlayers;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return false;

  const signatures = new Set<string>([stableStringify(commonValue)]);
  const [minimum, maximum] = setupPlayersRange(draft.setup.players as number | [number, number] | undefined);
  for (let players = minimum; players <= maximum; players++) {
    signatures.add(stableStringify(valueForPlayers(players)));
  }
  return signatures.size > 1;
}

function deckOverrideForPlayers(draft: RulesDraft, players: number): PlayerDeckOverride | undefined {
  const override = draft.deck.byPlayers?.[String(players)];
  return override && typeof override === "object" && !Array.isArray(override) ? override : undefined;
}

function hasPlayerSpecificDeck(draft: RulesDraft): boolean {
  return playerOverrideResultDiffers(draft, draft.deck.cards, (players) => deckOverrideForPlayers(draft, players)?.cards ?? draft.deck.cards);
}

function hasPlayerSpecificInitialHand(draft: RulesDraft): boolean {
  const initialHandByPlayers = draft.setup.initialHandByPlayers;
  const hasInitialHandOverrides = Boolean(initialHandByPlayers && typeof initialHandByPlayers === "object" && !Array.isArray(initialHandByPlayers));
  const [minimum, maximum] = setupPlayersRange(draft.setup.players as number | [number, number] | undefined);
  if (!hasInitialHandOverrides) return false;
  const signatures = new Set<string>([stableStringify(draft.setup.initialHand ?? null)]);
  for (let players = minimum; players <= maximum; players++) {
    signatures.add(stableStringify((initialHandByPlayers as Record<string, unknown>)[String(players)] ?? draft.setup.initialHand ?? null));
  }
  return signatures.size > 1;
}

function hasPlayerSpecificDealOrInitialHand(draft: RulesDraft): boolean {
  return (!customUniformDealTemplate(draft) && playerOverrideResultDiffers(draft, draft.deck.deal ?? null, (players) => deckOverrideForPlayers(draft, players)?.deal ?? draft.deck.deal ?? null))
    || hasPlayerSpecificInitialHand(draft);
}

function setUniformDealTemplate(draft: RulesDraft, template: CustomDealSeatRule): void {
  const [minimum, maximum] = setupPlayersRange(draft.setup.players as number | [number, number] | undefined);
  delete draft.deck.deal;
  draft.deck.byPlayers ??= {};
  for (const key of Object.keys(draft.deck.byPlayers)) {
    const players = Number(key);
    const override = draft.deck.byPlayers[key];
    if (players >= minimum && players <= maximum) continue;
    if (override.cards) delete override.deal;
    else delete draft.deck.byPlayers[key];
  }
  for (let players = minimum; players <= maximum; players++) {
    const key = String(players);
    const override = draft.deck.byPlayers[key] ?? {};
    override.deal = Array.from({ length: players }, (_, seat) => ({
      seat,
      ...(template.fixed && Object.keys(template.fixed).length ? { fixed: { ...template.fixed } } : {}),
      ...(template.fill !== undefined ? { fill: template.fill } : {}),
    }));
    draft.deck.byPlayers[key] = override;
  }
}

function stopUsingUniformDeal(draft: RulesDraft): void {
  const template = customUniformDealTemplate(draft) ?? {};
  const [minimum] = setupPlayersRange(draft.setup.players as number | [number, number] | undefined);
  for (const [key, override] of Object.entries(draft.deck.byPlayers ?? {})) {
    delete override.deal;
    if (!override.cards) delete draft.deck.byPlayers?.[key];
  }
  if (draft.deck.byPlayers && Object.keys(draft.deck.byPlayers).length === 0) delete draft.deck.byPlayers;
  draft.deck.deal = Array.from({ length: minimum }, (_, seat) => ({
    seat,
    ...(template.fixed && Object.keys(template.fixed).length ? { fixed: { ...template.fixed } } : {}),
    ...(template.fill !== undefined ? { fill: template.fill } : {}),
  }));
}

function updateVisualDealRule(draft: RulesDraft, seat: number, update: (rule: CustomDealSeatRule) => void): void {
  const uniform = customUniformDealTemplate(draft);
  if (uniform) {
    update(uniform);
    setUniformDealTemplate(draft, uniform);
    return;
  }
  const rule = draft.deck.deal?.[seat];
  if (rule) update(rule);
}

function visualDeckEditorLocked(state: Extract<DialogState, { kind: "rules-editor" }>, tab: "deck" | "deal"): boolean {
  return tab === "deck" ? hasPlayerSpecificDeck(state.draft) : hasPlayerSpecificDealOrInitialHand(state.draft);
}

function draftHasWangZhaDeckPair(draft: RulesDraft): boolean {
  const commonCards = draft.deck.cards;
  const effectiveDecks = [
    commonCards,
    ...Object.values(draft.deck.byPlayers ?? {}).map((override) => override?.cards ?? commonCards),
  ];
  return effectiveDecks.some((cards) => (cards.Acid ?? 0) > 0 && (cards.Alkali ?? 0) > 0);
}

function renderRulesEditorDialog(state: Extract<DialogState, { kind: "rules-editor" }>): string {
  const { draft, tab } = state;
  const deckEditorLocked = visualDeckEditorLocked(state, "deck");
  const dealEditorLocked = visualDeckEditorLocked(state, "deal");
  const initialHandEditorLocked = hasPlayerSpecificInitialHand(draft);
  const playerBoundsEditorLocked = deckEditorLocked || dealEditorLocked;
  const players = setupPlayersRange(draft.setup.players as number | [number, number] | undefined);
  const deckTotal = Object.values(draft.deck.cards).reduce((sum, count) => sum + count, 0);
  const orderCompare = draftOrderCompare(draft);
  let body = "";
  if (tab === "basic") {
    const allowWangZha = draft.setup.allowWangZha !== false;
    const showAllowWangZha = draftHasWangZhaDeckPair(draft);
    body = `
      <div class="setup-grid modal-grid">
        <div class="field"><label>规则名称</label><input id="reName" maxlength="48" value="${escapeAttr(draft.displayName ?? draft.name)}" /></div>
        <div class="field"><label>玩家人数下限</label><input id="rePlayersMin" type="number" min="2" max="10" step="1" value="${players[0]}" ${playerBoundsEditorLocked ? "disabled" : ""} /></div>
        <div class="field"><label>玩家人数上限</label><input id="rePlayersMax" type="number" min="2" max="10" step="1" value="${players[1]}" ${playerBoundsEditorLocked ? "disabled" : ""} /></div>
        <div class="field"><label>默认底注</label><input id="reBaseBet" type="number" min="0" step="1" placeholder="默认" value="${typeof draft.setup.baseBet === "number" ? draft.setup.baseBet : ""}" /><small>留空表示由建房时选择；非负整数，不设上限</small></div>
      </div>
      ${showAllowWangZha ? `<div class="setup-grid modal-grid rules-display-settings rules-basic-options">
        <div class="field"><label class="checkbox-label rules-display-toggle rules-wangzha-toggle"><input id="reAllowWangZha" type="checkbox" ${allowWangZha ? "checked" : ""} /><span>允许王炸</span></label><small>取消勾选后，强酸与强碱不能组合为王炸打出或用于抵挡加牌；两张牌各自原有的功能不受影响</small></div>
      </div>` : ""}
      ${playerBoundsEditorLocked ? `<div class="advanced-json-notice" role="status">${ADVANCED_PLAYER_DECK_EDITOR_NOTICE}</div>` : ""}
    `;
  } else if (tab === "deck") {
    if (deckEditorLocked) {
      body = `<div class="advanced-json-notice" role="status">${ADVANCED_PLAYER_DECK_EDITOR_NOTICE}</div>`;
    } else {
      const rows = Object.entries(draft.deck.cards)
        .filter(([id]) => state.deckFilter === "all" || draft.cards[id]?.type === state.deckFilter)
        .sort(([a], [b]) => orderCompare(a, b))
        .map(([id, count]) => {
          const def = draft.cards[id];
          return `<tr>
          <td>${escapeHtml(def?.displayName ?? id)}<small class="muted"> ${escapeHtml(id)}</small></td>
          <td class="rules-deck-type-column">${escapeHtml(def ? customCardCategoryLabel(def) : "未定义")}</td>
          <td><div class="rules-count-cell"><button class="btn ghost quantity-step-btn" type="button" data-act="rules-deck-dec" data-card-id="${escapeAttr(id)}" aria-label="减少 ${escapeAttr(def?.displayName ?? id)} 数量"><span aria-hidden="true">-</span></button><input class="deck-count-input" data-card-id="${escapeAttr(id)}" data-ui-key="deck-count:${escapeAttr(id)}" data-state-value type="number" inputmode="numeric" min="1" step="1" value="${count}" aria-label="${escapeAttr(def?.displayName ?? id)} 数量" /><button class="btn ghost quantity-step-btn" type="button" data-act="rules-deck-inc" data-card-id="${escapeAttr(id)}" aria-label="增加 ${escapeAttr(def?.displayName ?? id)} 数量"><span aria-hidden="true">+</span></button></div></td>
          <td><button class="btn danger" data-act="rules-deck-remove" data-card-id="${escapeAttr(id)}">移除</button></td>
        </tr>`;
        })
        .join("");
      const addable = Object.keys(draft.cards).filter((id) => !(id in draft.deck.cards)).sort(orderCompare);
      body = `
      <div class="rules-deck-toolbar">
        <select id="reDeckFilter">
          ${(["all", "ion", "operation", "special", "generic"] as const).map((value) => `<option value="${value}" ${state.deckFilter === value ? "selected" : ""}>${value === "all" ? "全部类型" : CUSTOM_CARD_TYPE_LABELS[value]}</option>`).join("")}
        </select>
        <span id="reDeckTotal" class="muted" aria-live="polite">牌堆总数 ${deckTotal}</span>
      </div>
      <div class="rules-table-wrap"><table class="data-table rules-deck-table"><colgroup><col /><col class="rules-deck-type-column" /><col /><col /></colgroup><thead><tr><th>牌面</th><th class="rules-deck-type-column">类型</th><th>数量</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="muted">当前筛选无卡牌</td></tr>`}</tbody></table></div>
      <div class="rules-deck-add">
        <select id="reAddCardId">${addable.map((id) => `<option value="${escapeAttr(id)}">${escapeHtml(draft.cards[id]?.displayName ?? id)}（${escapeAttr(id)}）</option>`).join("")}</select>
        <button class="btn" data-act="rules-deck-add" ${addable.length ? "" : "disabled"}>加入牌堆</button>
      </div>
    `;
    }
  } else if (tab === "deal") {
    if (dealEditorLocked) {
      body = `<div class="advanced-json-notice" role="status">${ADVANCED_PLAYER_DECK_EDITOR_NOTICE}</div>`;
    } else {
      const uniformTemplate = customUniformDealTemplate(draft);
      const uniformDeal = uniformTemplate !== undefined;
      const disableOpeningExchange = draft.setup.disableOpeningExchange === true;
      const deal = uniformDeal ? [uniformTemplate] : (draft.deck.deal ?? []);
      const seatBlocks = deal
        .map((rule, seat) => {
          const fixedEntries = Object.entries(rule.fixed ?? {}).sort(([a], [b]) => orderCompare(a, b));
          const fixedRows = fixedEntries
            .map(([id, count]) => `<tr>
            <td>${escapeHtml(draft.cards[id]?.displayName ?? id)}<small class="muted"> ${escapeHtml(id)}</small></td>
            <td><div class="rules-count-cell"><button class="btn ghost quantity-step-btn" type="button" data-act="rules-deal-fixed-dec" data-seat="${seat}" data-card-id="${escapeAttr(id)}" aria-label="减少座位 ${seat + 1} 的 ${escapeAttr(draft.cards[id]?.displayName ?? id)} 发牌张数"><span aria-hidden="true">-</span></button><input class="deck-count-input deal-fixed-count-input" data-seat="${seat}" data-card-id="${escapeAttr(id)}" data-ui-key="deal-count:${seat}:${escapeAttr(id)}" data-state-value type="number" inputmode="numeric" min="1" step="1" value="${count}" aria-label="座位 ${seat + 1} 的 ${escapeAttr(draft.cards[id]?.displayName ?? id)} 发牌张数" /><button class="btn ghost quantity-step-btn" type="button" data-act="rules-deal-fixed-inc" data-seat="${seat}" data-card-id="${escapeAttr(id)}" aria-label="增加座位 ${seat + 1} 的 ${escapeAttr(draft.cards[id]?.displayName ?? id)} 发牌张数"><span aria-hidden="true">+</span></button></div></td>
            <td><button class="btn danger" data-act="rules-deal-fixed-remove" data-seat="${seat}" data-card-id="${escapeAttr(id)}">移除</button></td>
          </tr>`)
            .join("");
          const addable = Object.keys(draft.deck.cards).filter((id) => draft.deck.cards[id] > 0 && !((rule.fixed ?? {})[id] > 0)).sort(orderCompare);
          return `<div class="deal-seat ${uniformDeal ? "uniform-deal-seat" : ""}">
          <div class="deal-seat-head"><strong>${uniformDeal ? "每位玩家" : `座位 ${seat + 1}`}</strong>
            <label><span>补足手牌数</span><input class="deal-fill" data-seat="${seat}" type="number" inputmode="numeric" min="2" step="1" placeholder="使用全局值" value="${rule.fill ?? ""}" /></label>
          </div>
          <div class="rules-table-wrap deal-fixed-wrap"><table class="data-table deal-fixed-table"><colgroup><col /><col /><col /></colgroup><thead><tr><th>牌面</th><th>数量</th><th>操作</th></tr></thead><tbody>${fixedRows || `<tr><td colspan="3" class="muted">无固定发牌（全部随机补足）</td></tr>`}</tbody></table></div>
          <div class="rules-deck-add">
            <select class="deal-add-select" data-seat="${seat}">${addable.map((id) => `<option value="${escapeAttr(id)}">${escapeHtml(draft.cards[id]?.displayName ?? id)}（${escapeAttr(id)}）</option>`).join("")}</select>
            <button class="btn" data-act="rules-deal-fixed-add" data-seat="${seat}" ${addable.length ? "" : "disabled"}>加入固定发牌</button>
          </div>
        </div>`;
        })
        .join("");
      body = `
      <div class="setup-grid modal-grid rules-display-settings rules-deal-settings">
        <div class="field"><label class="checkbox-label"><input id="reUniformDeal" type="checkbox" ${uniformDeal ? "checked" : ""} /> 为所有用户发放一样的卡牌</label><small>勾选后只编辑一份“每位玩家”发牌模板，并按本局实际人数复制。</small></div>
        <div class="field"><label class="checkbox-label"><input id="reDisableOpeningExchange" type="checkbox" ${disableOpeningExchange ? "checked" : ""} /> 禁止所有用户换牌</label><small>勾选后本局任何用户都无法换牌；联机局的加倍选择不受影响。</small></div>
      </div>
      <div class="field global-deal-fill"><label>全局补足手牌数</label><input id="reInitialHand" type="number" min="2" step="1" placeholder="开房时设置" value="${typeof draft.setup.initialHand === "number" ? draft.setup.initialHand : ""}" ${initialHandEditorLocked ? "disabled" : ""} /><small>${initialHandEditorLocked ? "由各人数的 JSON 设置决定" : "留空且所有席位均未填写补足数时，开房者可以设置；否则作为未单独填写席位的默认补足数。"}</small></div>
      <p class="muted">${uniformDeal ? "统一模板会复制给开房时选择的每一位玩家；牌堆不足时只为该房间补入同种卡牌并更新本局规则快照。" : `为每个座位指定固定发牌与补足手牌数；座位数为 0 表示按全局补足数自动发牌。${deal.length > 0 ? `当前规定了 ${deal.length} 个座位，房间人数将固定为 ${deal.length} 人。` : ""}`}</p>
      ${uniformDeal ? "" : `<div class="field deal-seat-count"><label>发牌座位数</label><input id="reDealSeatCount" data-state-value type="number" min="0" max="10" step="1" value="${deal.length}" /><small>输入完成或失焦后更新席位；0 表示自动发牌，不能只设 1 个席位</small></div>`}
      ${seatBlocks}
    `;
    }
  } else if (tab === "display") {
    const autoStack = draft.display?.autoStack !== false;
    const maxStack = draft.display?.maxStack ?? 0;
    const orderList = draftDisplayOrder(draft)
      .map((id, index) => renderDisplayOrderItem(draft.cards[id], id, index))
      .join("");
    body = `
      <div class="setup-grid modal-grid rules-display-settings">
        <div class="field"><label class="checkbox-label rules-display-toggle"><input id="reAutoStack" type="checkbox" ${autoStack ? "checked" : ""} /> 自动堆叠相同卡牌</label><small>勾选后手牌与换牌界面中同名牌自动堆叠显示</small></div>
        <div class="field rules-display-max-stack" id="reMaxStackField" ${autoStack ? "" : "hidden"}><label>最大堆叠显示数量</label><input id="reMaxStack" type="number" min="0" max="99" step="1" value="${maxStack}" /><small>同名牌数量超过该值时按每堆该数量分堆显示，堆左上角照常显示“n×”；0 表示无限制（全部堆成一堆）</small></div>
      </div>
      <div class="section-title rules-display-order-head"><span class="rules-display-order-title">显示顺序</span><button class="btn" data-act="rules-order-edit">编辑</button></div>
      <p class="muted rules-display-order-help">牌在换牌与游戏过程中的显示顺序；默认通用类型排在操作牌前面。</p>
      <div class="display-order-list readonly-list rules-display-order-list">${orderList || `<div class="muted">暂无卡牌</div>`}</div>
    `;
  } else if (tab === "cards") {
    const ids = Object.keys(draft.cards).sort(orderCompare);
    const selected = state.selectedCardId && draft.cards[state.selectedCardId] ? state.selectedCardId : undefined;
    const def = selected ? draft.cards[selected] : undefined;
    const list = ids
      .map((id) => `<button class="rules-card-item ${id === selected ? "selected" : ""}" style="--card-list-color:${escapeAttr(defaultTopColor(draft.cards[id]))}" data-act="rules-card-select" data-card-id="${escapeAttr(id)}"><span>${escapeHtml(draft.cards[id].displayName)}</span><small>${escapeHtml(customCardCategoryLabel(draft.cards[id]))}</small></button>`)
      .join("");
    const detail = def && selected
      ? `
        <div class="setup-grid modal-grid">
          <div class="field"><label>卡牌 ID</label><input value="${escapeAttr(selected)}" disabled /></div>
          <div class="field"><label>显示名称</label><input id="reCardName" maxlength="24" value="${escapeAttr(def.displayName)}" /></div>
          <div class="field"><label>类型</label><input value="${escapeAttr(customCardCategoryLabel(def))}" disabled /></div>
          <div class="field"><label>顶部色条</label><input id="reCardTopColor" type="color" value="${escapeAttr(def.topColor ?? defaultTopColor(def))}" /></div>
          <div class="field wide"><label>卡牌说明</label><textarea id="reCardDescription" maxlength="500" rows="3" placeholder="可选；留空表示不显示说明">${escapeHtml(def.description ?? "")}</textarea><small>游戏中仅非经典的操作牌、特殊物质牌和通用牌显示说明气泡；离子牌不显示</small></div>
        </div>
        <p class="muted">行为定义（反应表 / steps / 监听器等），以 JSON 编辑并点击“应用卡牌定义”。</p>
        <textarea id="reCardExtra" class="rules-json-input" rows="12">${escapeHtml(JSON.stringify(def, null, 2))}</textarea>
        <div class="top-actions">
          <button class="btn" data-act="rules-card-apply">应用卡牌定义</button>
          <button class="btn danger" data-act="rules-card-delete">删除卡牌</button>
        </div>
      `
      : `<p class="muted rules-card-selection-hint"><span class="desktop-card-selection-hint">从左侧选择一张卡牌进行编辑。</span><span class="mobile-card-selection-hint">从上方选择一张卡牌进行编辑。</span></p>`;
    body = `
      <div class="rules-cards-layout">
        <div class="rules-card-list">${list}</div>
        <div class="rules-card-detail">
          ${detail}
          <div class="top-actions"><button class="btn" data-act="rules-card-create-open">新建卡牌</button></div>
        </div>
      </div>
    `;
  } else {
    body = `
      <p class="muted">完整规则 JSON。编辑后点击“应用 JSON”生效；校验在保存时由服务器重新执行。</p>
      <textarea id="reJsonText" class="rules-json-input" rows="18">${escapeHtml(JSON.stringify(draft, null, 2))}</textarea>
      <div class="top-actions">
        <button class="btn" data-act="rules-json-apply">应用 JSON</button>
        <button class="btn" data-act="rules-json-import">导入 JSON 文件</button>
        <button class="btn" data-act="export-rules-full">导出完整规则</button>
      </div>
      <input id="reJsonFile" type="file" accept="application/json,.json" class="visually-hidden" />
    `;
  }
  return `
    <div class="modal-backdrop">
      <section class="modal panel rules-editor-dialog ${tab === "display" ? "rules-display-page" : ""} ${tab === "deck" || tab === "deal" ? "rules-editor-table-page" : ""}">
        <div class="modal-head"><div><span class="dialog-kicker">自定义规则</span><h2>规则编辑器</h2></div><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="rules-tabs">${RULES_EDITOR_TABS.map(([value, label]) => {
    const locked = value === "deck" ? deckEditorLocked : value === "deal" ? dealEditorLocked : false;
    return `<button class="btn ${tab === value ? "primary" : "ghost"} ${locked ? "is-locked" : ""}" data-act="rules-editor-tab" data-tab="${value}" ${locked ? `aria-label="${label}（已在高级 JSON 中设定）"` : ""}>${label}${locked ? `<span class="rules-tab-lock" aria-hidden="true">高级</span>` : ""}</button>`;
  }).join("")}</div>
        ${body}
        <div class="top-actions rules-editor-footer">
          <span class="muted">${state.target === "create" ? "保存后用于创建新对局" : "保存后由服务器重新解析并通知所有玩家"}</span>
          <button class="btn" data-act="rules-doc-download">下载规则说明</button>
          <button class="btn" data-act="rules-template-download">下载 JSON 模板</button>
          <button class="btn" data-act="dialog-close">取消</button>
          <button class="btn primary" data-act="rules-editor-save">保存规则</button>
        </div>
      </section>
    </div>
  `;
}

let displayOrderDragId: string | undefined;
let displayOrderDropTarget: { id: string; before: boolean } | undefined;

function setDisplayOrderIndicator(id: string, before: boolean): void {
  displayOrderDropTarget = { id, before };
  document.querySelectorAll<HTMLElement>(".display-order-item").forEach((el) => {
    el.classList.remove("insert-before", "insert-after");
    if (el.dataset.cardId === id) el.classList.add(before ? "insert-before" : "insert-after");
  });
}

function clearDisplayOrderIndicator(): void {
  displayOrderDragId = undefined;
  displayOrderDropTarget = undefined;
  document.querySelectorAll<HTMLElement>(".display-order-item.dragging").forEach((el) => el.classList.remove("dragging"));
  document.querySelectorAll<HTMLElement>(".display-order-item.insert-before, .display-order-item.insert-after").forEach((el) => el.classList.remove("insert-before", "insert-after"));
}

function renderRulesDisplayOrderDialog(state: Extract<DialogState, { kind: "rules-display-order" }>): string {
  const { editor, order } = state;
  const items = order
    .map((id, index) => renderDisplayOrderItem(editor.draft.cards[id], id, index, { draggable: true }))
    .join("");
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><div><span class="dialog-kicker">显示</span><h2>编辑显示顺序</h2></div><button class="btn ghost" data-act="rules-order-cancel">取消</button></div>
        <p class="muted">拖动条目调整顺序，保存后牌在换牌与游戏过程中按此顺序显示。</p>
        <div class="display-order-list">${items || `<div class="muted">暂无卡牌</div>`}</div>
        <div class="top-actions">
          <button class="btn" data-act="rules-order-cancel">取消</button>
          <button class="btn primary" data-act="rules-order-save">保存顺序</button>
        </div>
      </section>
    </div>
  `;
}

function renderRulesCardCreateDialog(state: Extract<DialogState, { kind: "rules-card-create" }>): string {
  const genericColor = newCardCategoryDefaults("generic").color;
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><div><span class="dialog-kicker">卡牌库</span><h2>新建卡牌</h2></div><button class="btn ghost" data-act="rules-card-create-cancel">取消</button></div>
        <div class="setup-grid modal-grid">
          <div class="field"><label>卡牌 ID</label><input id="rncId" maxlength="32" placeholder="例如 MyCard" /></div>
          <div class="field"><label>显示名称</label><input id="rncName" maxlength="24" placeholder="例如 我的卡牌" /></div>
          <div class="field"><label>类型</label><select id="rncType">${NEW_CARD_CATEGORIES.map((value) => `<option value="${value}" ${value === "generic" ? "selected" : ""}>${NEW_CARD_CATEGORY_LABELS[value]}</option>`).join("")}</select></div>
          <div class="field" id="rncChargeField" hidden><label>电荷</label><input id="rncCharge" type="number" min="1" max="7" step="1" value="1" /><small>阳离子取正、阴离子取负的绝对值（1-7）</small></div>
          <div class="field"><label>顶部色条</label><input id="rncTopColor" type="color" value="${escapeAttr(genericColor)}" /></div>
          <div class="field wide"><label>卡牌说明</label><textarea id="rncDescription" maxlength="500" rows="3" placeholder="可选；留空表示不显示说明"></textarea></div>
        </div>
        <p class="muted">行为定义（反应表 / steps / 监听器等），可选 JSON 对象；与上方字段合并时显式字段优先。</p>
        <textarea id="rncExtra" class="rules-json-input" rows="7" placeholder='例如 {"reactions":{"solid":["OH^-"]}}'></textarea>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="top-actions">
          <button class="btn" data-act="rules-card-create-cancel">取消</button>
          <button class="btn primary" data-act="rules-card-create-confirm">创建卡牌</button>
        </div>
      </section>
    </div>
  `;
}

function renderRoomEditNoticeDialog(state: Extract<DialogState, { kind: "room-edit-notice" }>): string {
  if (state.notice.problems?.length) {
    return `
      <div class="modal-backdrop">
        <section class="modal panel room-edit-notice">
          <div class="notice-orbit"><span>受限</span></div>
          <div>
            <span class="dialog-kicker">房间通知</span>
            <h2>房间设置不符合开房者权限</h2>
            <p class="muted">该房间由 ${escapeHtml(state.notice.updatedByNickname)} 创建，当前设置已不符合开房者的权限限制，游戏无法开始。</p>
          </div>
          <ul class="room-problem-list">
            ${state.notice.problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}
          </ul>
          <div class="top-actions"><button class="btn primary" data-act="dialog-close">我知道了</button></div>
        </section>
      </div>
    `;
  }
  return `
    <div class="modal-backdrop">
      <section class="modal panel room-edit-notice">
        <div class="notice-orbit"><span>已更新</span></div>
        <div>
          <span class="dialog-kicker">房间通知</span>
          <h2>房间设置已修改</h2>
          <p class="muted">${escapeHtml(state.notice.updatedByNickname)} 更新了房间设置。</p>
        </div>
        <div class="room-edit-summary">
          <div><span>总玩家数</span><strong>${state.notice.capacity}</strong></div>
          <div><span>底注</span><strong>${state.notice.baseBet}</strong></div>
          <div><span>初始手牌</span><strong>${state.notice.initialHandSize ?? "默认"}</strong></div>
          <div><span>出牌时间</span><strong>${state.notice.turnTimeLimitSec ?? "默认"}</strong></div>
          <div><span>换牌时间</span><strong>${state.notice.openingExchangeSec ?? "默认"}</strong></div>
        </div>
        <div class="top-actions"><button class="btn primary" data-act="dialog-close">我知道了</button></div>
      </section>
    </div>
  `;
}

function renderPasswordConfirm(): string {
  if (!passwordConfirm) return "";
  return `
    <div class="modal-backdrop password-confirm-backdrop">
      <section class="modal panel password-confirm-dialog">
        <div class="modal-head"><h2>确认密码</h2><button class="btn ghost" data-act="password-confirm-close">关闭</button></div>
        ${passwordConfirm.error ? `<div class="form-error">${escapeHtml(passwordConfirm.error)}</div>` : ""}
        <p class="muted">请输入你自己的当前密码以确认本次更改。</p>
        <div class="field"><label>当前密码</label><input id="confirmCurrentPassword" type="password" maxlength="72" /></div>
        <div class="top-actions"><button class="btn primary" data-act="password-confirm-submit">确认更改</button></div>
      </section>
    </div>
  `;
}

function renderOpeningExchangeModal(): string {
  if (dialog?.kind === "leave-room") return "";
  if (!game || game.status !== "opening-exchange" || !game.openingExchange) return "";
  const exchangeDisabled = customRulesOf(game)?.setup.disableOpeningExchange === true;
  const openingTitle = exchangeDisabled ? "开局选择" : "开局换牌";
  if (shouldHideCompletedOnlineOpeningExchangeModal()) {
    return `
      <div class="modal-backdrop">
        <section class="modal panel exchange-wait-modal" role="dialog" aria-modal="true">
          <div class="modal-head"><h2>${openingTitle}</h2></div>
          <p class="muted">你已完成开局选择，正在等待其他玩家…</p>
          <p class="muted">所有玩家完成选择后，游戏将自动开始。</p>
        </section>
      </div>
    `;
  }
  const seat = openingExchangePlayer();
  const deadline = seat
    ? (game.openingExchange.deadlineByPlayerId?.[seat.id] ?? game.openingExchange.deadlineAt)
    : game.openingExchange.deadlineAt;
  const left = mode === "online" ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : undefined;
  if (!seat) {
    return `
      <div class="modal-backdrop soft-backdrop">
        <section class="modal panel">
          <div class="modal-head"><h2>${openingTitle}</h2></div>
          <p class="muted">${left === undefined ? "等待其他本地玩家完成选择。" : `${openingTitle}阶段，${left} 秒后开始。`}</p>
        </section>
      </div>
    `;
  }
  const key = `${game.id}:${seat.id}`;
  const exchangeDone = game.openingExchange.completedPlayerIds.includes(seat.id);
  const doubleDone = (game.openingExchange.doubleCompletedPlayerIds ?? []).includes(seat.id);
  const aiAction = currentAdvancedAiAction(seat.id);
  const aiSuggestedDiscardIndices = openingAiSuggestedDiscardIndices(seat, aiAction);
  if (openingSelectionKey !== key) {
    openingSelectionKey = key;
    openingExchangeSelection = new Set<number>();
  }
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>${openingTitle}</h2><div class="top-actions">${left === undefined ? "" : `<span class="muted">${left} 秒</span>`}</div></div>
        <p class="muted">${exchangeDisabled ? "本局规则已禁止所有用户换牌。" : `${escapeHtml(seat.nickname)} 可弃置 ${seat.openingExchangeMin ?? 0}-${seat.openingExchangeMax ?? "不限"} 张牌并补等量牌。`}</p>
        ${exchangeDisabled
      ? `<p class="status-ok">无需提交换牌选择</p>`
      : exchangeDone
      ? `<p class="status-ok">换牌选择已提交</p>`
      : `<div class="card-grid exchange-grid">
                ${seat.hand
        .map((entry, index) => ({ card: cardIdOf(entry), index }))
        .sort((a, b) => handDisplayCompare()(a.card, b.card) || a.index - b.index)
        .map(({ card, index }) => {
          const selected = openingExchangeSelection.has(index) ? "selected" : "";
          const sameHint =
            !selected && [...openingExchangeSelection].some((selectedIndex) => cardIdOf(seat.hand[selectedIndex]) === card) ? "same-card-hint" : "";
          const aiSuggested = !selected && aiSuggestedDiscardIndices.has(index) ? "ai-opening-suggestion" : "";
          const visual = cardVisual(card);
          const description = customCardDescription(card);
          return `<button class="card ${visual.cls} ${selected} ${sameHint} ${aiSuggested} ${description ? "has-description" : ""}"${cardVisualStyle(visual)} data-exchange-index="${index}"${cardDescriptionAttributes(card, `exchange:${index}`)}><span class="formula"${cardFormulaStyle(card, visual)}>${visual.formula}</span><span class="kind">${visual.kind}</span></button>`;
        })
        .join("")}
              </div>`
    }
        <div class="top-actions">
          ${aiAction ? `<button class="btn ai ai-opening-suggestion" data-act="apply-ai-suggestion">${escapeHtml(`AI 建议：${describeActionText(aiAction)}`)}</button>` : ""}
          ${game.scoring?.baseBet && !doubleDone
      ? `<button class="btn" data-act="opening-no-double">不加倍</button><button class="btn warn" data-act="opening-double">加倍</button>`
      : doubleDone
        ? `<span class="muted">加倍选择已提交</span>`
        : ""
    }
          ${!exchangeDisabled && !exchangeDone && (seat.openingExchangeMin ?? 0) === 0 ? `<button class="btn" data-act="opening-skip">不换牌</button>` : ""}
          ${!exchangeDisabled && !exchangeDone ? `<button class="btn primary" data-act="opening-submit">确认换牌 (${openingExchangeSelection.size})</button>` : ""}
        </div>
      </section>
    </div>
  `;
}

function renderWinModal(): string {
  if (modal) return "";
  if (!game || game.status !== "ended" || !game.winnerId || dismissedWinnerId === game.winnerId) return "";
  const winner = game.players.find((p) => p.id === game?.winnerId);
  const mineWon = winner?.id === selfId || (mode === "local" && winner?.seat === 0);
  return `
    <div class="modal-backdrop win-backdrop">
      <section class="modal win-modal panel ${mineWon ? "" : "lost"}">
        <div class="winner-mark">${mineWon ? "胜" : "终"}</div>
        <h2>${mineWon ? `${winner ? renderPlayerName(winner) : "你"} 获胜` : "游戏结束"}</h2>
        <p class="muted">${mineWon ? "所有手牌已经出完，本局结束。" : `获胜玩家：${escapeHtml(winner?.nickname ?? "未知")}`}</p>
        ${renderWinScoringLines(game)}
        <div class="top-actions">
          <button class="btn" data-act="export-game-log">导出日志</button>
          <button class="btn" data-act="win-close">查看终局</button>
          ${mode === "online" && room && !room.duelMode
      ? `<button class="btn primary" data-act="start-online">再来一局</button>`
      : mode === "local"
        ? `<button class="btn primary" data-act="restart-local">再来一局</button>`
        : ""
    }
        </div>
      </section>
    </div>
  `;
}

function renderWinScoringLines(state: ClientGame): string {
  if (!state.scoring || state.mode !== "online") return state.scoring ? `<p class="muted">本局待结算积分：${state.scoring.total ?? state.scoring.stake}</p>` : "";
  if (state.scoring.settlesPoints === false || !onlineGameSettlesPoints(state as GameState)) return `<p class="muted">本场不结算积分</p>`;
  const gross = state.scoring.winnerGrossPoints ?? state.scoring.total ?? state.scoring.stake;
  const tax = state.scoring.winnerTax ?? 0;
  return `
        <p class="muted">本局待结算积分：${gross}</p>
        ${tax > 0 ? `<p class="muted">对胜利者的税收：${tax}</p><p class="muted">胜利者税后获得：${Math.max(0, gross - tax)}</p>` : ""}`;
}

function onlineGameSettlesPoints(state: GameState): boolean {
  if (!state.scoring || state.scoring.baseBet <= 0) return false;
  const winner = state.players.find((player) => player.id === state.winnerId);
  if (!winner || winner.bot || !winner.accountId) return false;
  return state.players.some((player) => !player.bot && player.accountId && player.id !== winner.id);
}

function bind(): void {
  bindCardDescriptionBubbles();
  document.querySelectorAll<HTMLElement>("[data-act]").forEach((el) => {
    el.addEventListener("click", () => void handleAct(el.dataset.act!, el));
  });
  document.querySelectorAll<HTMLElement>("[data-card]").forEach((el) => {
    el.addEventListener("click", () => {
      const card = el.dataset.card as CardId | "all";
      const index = Number(el.dataset.cardIndex);
      if (cardClickTimer) window.clearTimeout(cardClickTimer);
      cardClickTimer = window.setTimeout(() => {
        cardClickTimer = 0;
        if (card === "all") {
          selectedCard = "all";
          selectedHandIndex = null;
        } else {
          if (selectedHandIndex === index) {
            selectedCard = "all";
            selectedHandIndex = null;
          } else {
            selectedCard = card;
            selectedHandIndex = Number.isInteger(index) ? index : null;
          }
        }
        render();
      }, 220);
    });
    el.addEventListener("dblclick", (event) => {
      event.preventDefault();
      if (cardClickTimer) window.clearTimeout(cardClickTimer);
      cardClickTimer = 0;
      void handleCardDoubleClick(el.dataset.card as CardId | "all", Number(el.dataset.cardIndex));
    });
  });
  document.querySelectorAll<HTMLElement>("[data-exchange-index]").forEach((el) => {
    el.addEventListener("click", () => {
      const index = Number(el.dataset.exchangeIndex);
      if (!Number.isInteger(index)) return;
      if (openingExchangeSelection.has(index)) openingExchangeSelection.delete(index);
      else {
        const configuredMax = openingExchangePlayer()?.openingExchangeMax;
        const max = configuredMax === undefined ? 3 : configuredMax;
        if (max === null || openingExchangeSelection.size < max) openingExchangeSelection.add(index);
        else toast(`最多只能选择 ${max} 张牌`);
      }
      render();
    });
  });
  document.querySelectorAll<HTMLElement>("[data-action-index]").forEach((el) => {
    el.addEventListener("click", () => {
      const player = visibleSeat();
      if (!game || !player) return;
      const actions = actionsForDisplay(
        player.id,
        actionsForPlayer(player.id).filter(
          (a) =>
            !isDrawResponse(a) &&
            (game?.pendingDraw ||
              selectedCard === "all" ||
              actionMatchesCard(a, selectedCard) ||
              isAdvancedAiSuggestedAction(a, player.id)),
        ),
      );
      const action = actions[Number(el.dataset.actionIndex)];
      if (action) void submit(action);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-modal-action-index]").forEach((el) => {
    el.addEventListener("click", () => {
      if (!modal || modal.kind !== "actions" || modal.submitting) return;
      const action = modal.actions[Number(el.dataset.modalActionIndex)];
      if (!action) return;
      if (modal.drawPrompt) {
        const stateRevision = game?.revision;
        modal = { ...modal, submitting: true, stateRevision };
        render();
        startModalActionSubmissionTimeout(stateRevision);
      } else {
        modal = null;
        render();
      }
      void submit(action);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-seat-id]").forEach((el) => {
    el.addEventListener("click", () => {
      if (game?.status !== "ended") return;
      watchedSeatId = el.dataset.seatId ?? "";
      selectedCard = "all";
      selectedHandIndex = null;
      render();
    });
  });
  document.querySelector<HTMLSelectElement>("#watchSeat")?.addEventListener("change", (event) => {
    watchedSeatId = (event.currentTarget as HTMLSelectElement).value;
    selectedCard = "all";
    selectedHandIndex = null;
    render();
  });
  document.querySelector<HTMLSelectElement>("#advancedAiLevel")?.addEventListener("change", (event) => {
    const level = (event.currentTarget as HTMLSelectElement).value;
    if (!isAdvancedAiLevel(level) || level === advancedAiLevel) return;
    const previousEffectiveLevel = effectiveAdvancedAiLevel();
    advancedAiLevel = level;
    localStorage.setItem("ionStormAdvancedAiLevel", level);
    if (previousEffectiveLevel !== effectiveAdvancedAiLevel()) {
      advancedAiCalculationKey = "";
      advancedAiSuggestion = undefined;
      advancedAiStatus = "idle";
      advancedAiRequestId += 1;
      advancedAiWorker?.terminate();
      advancedAiWorker = undefined;
    }
    render();
  });
  document.querySelector<HTMLSelectElement>("#permRole")?.addEventListener("change", (event) => {
    fillPermissionFields((event.currentTarget as HTMLSelectElement).value as UserRole);
  });
  document.querySelector<HTMLSelectElement>("#requestKind")?.addEventListener("change", (event) => {
    updateRequestFields((event.currentTarget as HTMLSelectElement).value);
  });
  document.querySelector<HTMLSelectElement>("#inviteRole")?.addEventListener("change", updateInvitationGrantFields);
  document.querySelector<HTMLSelectElement>("#inviteUsePolicy")?.addEventListener("change", updateInvitationUsageFields);
  document.querySelector<HTMLSelectElement>("#inviteExpiryMode")?.addEventListener("change", updateInvitationUsageFields);
  document.querySelector<HTMLSelectElement>("#invitePermissionMode")?.addEventListener("change", updateInvitationPermissionFields);
  document.querySelector<HTMLSelectElement>("#inviteCustomModeLimitMode")?.addEventListener("change", updateInvitationPermissionFields);
  document.querySelector<HTMLSelectElement>("#inviteAdminMode")?.addEventListener("change", () => updateInvitationGrantMode("Admin"));
  document.querySelector<HTMLSelectElement>("#inviteAdvancedMode")?.addEventListener("change", () => updateInvitationGrantMode("Advanced"));
  document.querySelector<HTMLSelectElement>("#editPermissionMode")?.addEventListener("change", updateEditUserFields);
  document.querySelector<HTMLSelectElement>("#editPermissionExpiryMode")?.addEventListener("change", updateEditUserFields);
  document.querySelector<HTMLSelectElement>("#editCustomModeLimitMode")?.addEventListener("change", updateEditUserFields);
  document.querySelector<HTMLSelectElement>("#editCustomModeLimitExpiryMode")?.addEventListener("change", updateEditUserFields);
  document.querySelector<HTMLSelectElement>("#editAdminMode")?.addEventListener("change", updateEditUserFields);
  document.querySelector<HTMLSelectElement>("#editAdvancedMode")?.addEventListener("change", updateEditUserFields);
  document.querySelector<HTMLSelectElement>("#banScope")?.addEventListener("change", updateBanFields);
  document.querySelector<HTMLSelectElement>("#banAccountMode")?.addEventListener("change", updateBanFields);
  document.querySelector<HTMLSelectElement>("#banLeaderboardMode")?.addEventListener("change", updateBanFields);
  document.querySelector<HTMLSelectElement>("#activationPolicy")?.addEventListener("change", updateActivationFields);
  document.querySelector<HTMLSelectElement>("#activationExpiryMode")?.addEventListener("change", updateActivationFields);
  document.querySelector<HTMLSelectElement>("#activationTitleMode")?.addEventListener("change", updateActivationFields);
  document.querySelector<HTMLSelectElement>("#activationNicknameColorMode")?.addEventListener("change", updateActivationFields);
  document.querySelector<HTMLSelectElement>("#activationPermissionMode")?.addEventListener("change", updateActivationFields);
  document.querySelector<HTMLSelectElement>("#activationCustomModeLimitMode")?.addEventListener("change", updateActivationFields);
  document.querySelector<HTMLSelectElement>("#activationCustomModeLimitDurationMode")?.addEventListener("change", updateActivationFields);
  ["edit", "invite", "activation", "perm"].forEach((prefix) => {
    document.querySelector<HTMLSelectElement>(`#${prefix}DuelPolicy`)?.addEventListener("change", () => updateDuelLimitFields(prefix));
  });
  ["globalCustomMode", "editCustomMode", "inviteCustomMode", "activationCustomMode"].forEach((prefix) => {
    document.querySelector<HTMLSelectElement>(`#${prefix}CustomMaxBetMode`)?.addEventListener("change", () => updateCustomLimitFields(prefix));
    document.querySelector<HTMLSelectElement>(`#${prefix}CustomCapMode`)?.addEventListener("change", () => updateCustomLimitFields(prefix));
  });
  ["activationExchangeMaxMode", "activationMaxBaseBetMode"].forEach((id) => {
    document.querySelector<HTMLSelectElement>(`#${id}`)?.addEventListener("change", () => updatePartialPermissionFields("activation"));
  });
  document.querySelector<HTMLInputElement>("#activationPoints")?.addEventListener("input", updateActivationFields);
  document.querySelector<HTMLSelectElement>("#pointDistributionExpiryMode")?.addEventListener("change", updatePointDistributionFields);
  document.querySelector<HTMLInputElement>("#pointDistributionMaxUses")?.addEventListener("input", updatePointDistributionFields);
  document.querySelector<HTMLInputElement>("#pointDistributionTotalPoints")?.addEventListener("input", updatePointDistributionFields);
  document.querySelector<HTMLInputElement>("#pointDistributionPerUserPoints")?.addEventListener("input", updatePointDistributionFields);
  document.querySelector<HTMLSelectElement>("#pointDistributionMode")?.addEventListener("change", updatePointDistributionFields);
  document.querySelector<HTMLSelectElement>("#editAdvancedAiMode")?.addEventListener("change", updateEditUserFields);
  document.querySelector<HTMLSelectElement>("#editTaxRateMode")?.addEventListener("change", updateEditUserFields);
  document.querySelector<HTMLSelectElement>("#inviteTaxRateMode")?.addEventListener("change", updateInvitationTaxFields);
  document.querySelector<HTMLSelectElement>("#activationTaxRateMode")?.addEventListener("change", updateActivationTaxFields);
  document.querySelector<HTMLInputElement>("#modalBaseBet")?.addEventListener("input", () => {
    if (modal?.kind === "online") {
      const baseBet = Number((document.querySelector("#modalBaseBet") as HTMLInputElement | null)?.value ?? modal.baseBet);
      const playersRaw = ((document.querySelector("#modalPlayers") as HTMLInputElement | null)?.value ?? "").trim();
      const players = Number(playersRaw);
      const botsRaw = ((document.querySelector("#modalBots") as HTMLInputElement | null)?.value ?? "").trim();
      const bots = Number(botsRaw);
      const handRaw = (document.querySelector("#modalInitialHandSize") as HTMLInputElement | null)?.value ?? modal.initialHandSize;
      modal = {
        ...modal,
        baseBet,
        playerCount: playersRaw !== "" && Number.isInteger(players) ? players : modal.playerCount,
        botCount: botsRaw !== "" && Number.isInteger(bots) ? bots : modal.botCount,
        initialHandSize: handRaw,
      };
      const playersInput = document.querySelector<HTMLInputElement>("#modalPlayers");
      const duelActive = modal.ruleset === "classic" && isDuelBaseBet(baseBet, currentUser);
      if (playersInput) {
        playersInput.disabled = duelActive;
        if (duelActive) playersInput.value = "2";
      }
      updateModalInitialHandSizeHint();
      updateRoomBetHintLive();
    }
  });
  document.querySelector<HTMLInputElement>("#modalPlayers")?.addEventListener("input", () => {
    if (modal?.kind === "local" || modal?.kind === "online") {
      const raw = (document.querySelector<HTMLInputElement>("#modalPlayers")?.value ?? "").trim();
      const value = Number(raw);
      if (raw !== "" && Number.isInteger(value)) modal.playerCount = value;
      if (modal.ruleset === "custom" && hasPlayerCountDeckOverrides(modal.customRules)) {
        render();
        return;
      }
    }
    updateModalInitialHandSizeHint();
    updateRoomBetHintLive();
  });
  document.querySelector<HTMLInputElement>("#modalBots")?.addEventListener("input", () => {
    if (modal?.kind === "local") {
      const raw = (document.querySelector<HTMLInputElement>("#modalBots")?.value ?? "").trim();
      const value = Number(raw);
      if (raw !== "" && Number.isInteger(value)) modal.botCount = value;
    }
    updateModalInitialHandSizeHint();
    updateRoomBetHintLive();
  });
  document.querySelector<HTMLSelectElement>("#modalRuleset")?.addEventListener("change", () => {
    if (modal?.kind !== "local" && modal?.kind !== "online") return;
    const value = document.querySelector<HTMLSelectElement>("#modalRuleset")?.value === "custom" ? "custom" : "classic";
    const botsRaw = ((document.querySelector("#modalBots") as HTMLInputElement | null)?.value ?? "").trim();
    const bots = Number(botsRaw);
    const playersRaw = ((document.querySelector("#modalPlayers") as HTMLInputElement | null)?.value ?? "").trim();
    const players = Number(playersRaw);
    modal = {
      ...modal,
      ruleset: value,
      botCount: value === "custom" ? 0 : botsRaw !== "" && Number.isInteger(bots) ? bots : modal.botCount,
      playerCount: playersRaw !== "" && Number.isInteger(players) ? players : modal.playerCount,
    };
    render();
  });
  document.querySelector<HTMLSelectElement>("#modalRoomCodeMode")?.addEventListener("change", (event) => {
    if (modal?.kind !== "online") return;
    const modeSelect = event.currentTarget as HTMLSelectElement;
    const roomCodeMode = modeSelect.value === "reserved" ? "reserved" : "custom";
    const currentCode = document.querySelector<HTMLInputElement | HTMLSelectElement>("#modalRoomCode")?.value ?? "";
    modal = { ...modal, roomCodeMode, roomCode: roomCodeMode === "reserved" ? (sortReservedRoomCodes(currentUser?.reservedRoomCodes ?? [])[0] ?? "") : currentCode, error: undefined };
    // On mobile Safari, restoring focus to a freshly rendered <select> can
    // immediately reopen its native picker. Blur before render so the generic
    // interaction snapshot does not carry this select's focus into the new DOM.
    modeSelect.blur();
    render();
  });
  document.querySelector<HTMLInputElement>("#modalRoomCode")?.addEventListener("input", () => {
    if (modal?.kind === "online") modal.roomCode = document.querySelector<HTMLInputElement>("#modalRoomCode")?.value ?? "";
  });
  document.querySelector<HTMLSelectElement>("#modalCustomSource")?.addEventListener("change", () => {
    if (modal?.kind !== "local" && modal?.kind !== "online") return;
    const value = document.querySelector<HTMLSelectElement>("#modalCustomSource")?.value ?? "";
    if (value === "__blank__") {
      modal = { ...modal, customPresetId: undefined, customPresetEdited: false, customRules: undefined, customBlank: true, customPresetLoading: false, error: undefined };
      renderSetupModalPreservingScroll();
      return;
    }
    if (!value) {
      modal = { ...modal, customPresetId: undefined, customPresetEdited: false, customRules: undefined, customBlank: false, customPresetLoading: false, error: undefined };
      renderSetupModalPreservingScroll();
      return;
    }
    modal = {
      ...modal,
      customPresetId: value,
      customPresetEdited: false,
      customRules: undefined,
      customBlank: false,
      customPresetLoading: true,
      error: undefined,
    };
    renderSetupModalPreservingScroll();
    void (async () => {
      try {
        const rules = await loadEnabledCustomPresetRules(value);
        if ((modal?.kind !== "local" && modal?.kind !== "online") || modal.customPresetId !== value) return;
        modal = { ...modal, customRules: rules, customPresetLoading: false, error: undefined };
      } catch (error) {
        if ((modal?.kind !== "local" && modal?.kind !== "online") || modal.customPresetId !== value) return;
        modal = {
          ...modal,
          customPresetLoading: false,
          error: error instanceof Error ? error.message : "加载预设规则失败",
        };
      }
      renderSetupModalPreservingScroll();
    })();
  });
  document.querySelector<HTMLInputElement>("#presetDisplayName")?.addEventListener("input", () => {
    if (dialog?.kind === "custom-presets" && dialog.form) {
      dialog.form.displayName = document.querySelector<HTMLInputElement>("#presetDisplayName")?.value ?? "";
    }
  });
  document.querySelector<HTMLTextAreaElement>("#presetSource")?.addEventListener("input", () => {
    if (dialog?.kind === "custom-presets" && dialog.form) {
      dialog.form.source = document.querySelector<HTMLTextAreaElement>("#presetSource")?.value ?? "";
    }
  });
  document.querySelector<HTMLInputElement>("#modalInitialHandSize")?.addEventListener("input", () => {
    if (modal?.kind === "local" || modal?.kind === "online") {
      modal.initialHandSize = document.querySelector<HTMLInputElement>("#modalInitialHandSize")?.value ?? "";
    }
    updateModalInitialHandSizeHint();
    updateRoomBetHintLive();
  });
  document.querySelector<HTMLInputElement>("#editRoomCapacity")?.addEventListener("input", () => {
    const capacity = Number((document.querySelector("#editRoomCapacity") as HTMLInputElement | null)?.value ?? room?.capacity ?? 2);
    const cleanCapacity = Number.isInteger(capacity) && capacity > 0 ? capacity : 1;
    const roomRules = room?.rulesetMode === "custom" ? currentRoomCustomRules() : undefined;
    const maximum = roomRules ? customInitialHandSizeMax(roomRules, cleanCapacity) : maxInitialHandSize(cleanCapacity);
    const activeDeal = roomRules ? customDeckForPlayerCount(roomRules, cleanCapacity).deal : undefined;
    const minimum = roomRules ? customDealMinimumGlobalFill(activeDeal) : 2;
    const input = document.querySelector<HTMLInputElement>("#editRoomInitialHandSize");
    const hint = document.querySelector("#editRoomInitialHandSizeHint");
    if (input) input.min = String(minimum);
    if (input) input.max = String(maximum);
    if (hint) hint.textContent = `留空使用规则默认；按总玩家数可设 ${minimum}-${maximum}；修改将在下一局开始时生效`;
    updateEditRoomBetHint();
  });
  document.querySelector<HTMLInputElement>("#editRoomCapacity")?.addEventListener("change", () => {
    if (room?.rulesetMode === "custom" && dialog?.kind === "edit-room") render();
  });
  document.querySelector<HTMLInputElement>("#editRoomInitialHandSize")?.addEventListener("input", updateEditRoomBetHint);
  document.querySelector<HTMLSelectElement>("#reDeckFilter")?.addEventListener("change", () => {
    if (dialog?.kind !== "rules-editor") return;
    dialog = { ...dialog, deckFilter: (document.querySelector<HTMLSelectElement>("#reDeckFilter")?.value ?? "all") as "all" | CustomCardDef["type"] };
    render();
  });
  document.querySelector<HTMLInputElement>("#reName")?.addEventListener("input", () => {
    if (dialog?.kind !== "rules-editor") return;
    const value = (document.querySelector<HTMLInputElement>("#reName")?.value ?? "").trim();
    dialog.draft.displayName = value || undefined;
  });
  for (const [inputId, key] of [["rePlayersMin", 0], ["rePlayersMax", 1]] as const) {
    document.querySelector<HTMLInputElement>(`#${inputId}`)?.addEventListener("input", () => {
      if (dialog?.kind !== "rules-editor") return;
      if (hasPlayerSpecificDeck(dialog.draft) || hasPlayerSpecificDealOrInitialHand(dialog.draft)) return;
      const uniformTemplate = customUniformDealTemplate(dialog.draft);
      const fixedPlayers = typeof dialog.draft.setup.players === "number" ? dialog.draft.setup.players : undefined;
      const current = Array.isArray(dialog.draft.setup.players)
        ? [...(dialog.draft.setup.players as [number, number])]
        : fixedPlayers !== undefined ? [fixedPlayers, fixedPlayers] : [2, 10];
      const value = Number(document.querySelector<HTMLInputElement>(`#${inputId}`)?.value);
      if (Number.isInteger(value) && value >= 2 && value <= 10) current[key] = value;
      if (current[0] <= current[1]) {
        dialog.draft.setup.players = current;
        if (uniformTemplate) setUniformDealTemplate(dialog.draft, uniformTemplate);
      }
    });
  }
  document.querySelector<HTMLInputElement>("#reBaseBet")?.addEventListener("input", () => {
    if (dialog?.kind !== "rules-editor") return;
    const raw = (document.querySelector<HTMLInputElement>("#reBaseBet")?.value ?? "").trim();
    const value = Number(raw);
    if (raw === "") delete dialog.draft.setup.baseBet;
    else if (Number.isInteger(value) && value >= 0) dialog.draft.setup.baseBet = value;
  });
  document.querySelector<HTMLInputElement>("#reInitialHand")?.addEventListener("input", () => {
    if (dialog?.kind !== "rules-editor") return;
    if (hasPlayerSpecificInitialHand(dialog.draft)) return;
    const raw = (document.querySelector<HTMLInputElement>("#reInitialHand")?.value ?? "").trim();
    const value = Number(raw);
    if (raw === "") delete dialog.draft.setup.initialHand;
    else if (Number.isInteger(value) && value >= 2) dialog.draft.setup.initialHand = value;
  });
  document.querySelector<HTMLInputElement>("#reCardName")?.addEventListener("input", () => {
    if (dialog?.kind !== "rules-editor" || !dialog.selectedCardId) return;
    // 仅同步右侧 JSON 预览，不写入草稿；点击“应用卡牌定义”才保存
    const extra = document.querySelector<HTMLTextAreaElement>("#reCardExtra");
    if (!extra) return;
    try {
      const parsed = JSON.parse(extra.value);
      const value = (document.querySelector<HTMLInputElement>("#reCardName")?.value ?? "").trim();
      if (value) parsed.displayName = value;
      extra.value = JSON.stringify(parsed, null, 2);
    } catch {
      /* 预览 JSON 暂不合法时跳过同步 */
    }
  });
  document.querySelector<HTMLTextAreaElement>("#reCardDescription")?.addEventListener("input", () => {
    if (dialog?.kind !== "rules-editor" || !dialog.selectedCardId) return;
    const extra = document.querySelector<HTMLTextAreaElement>("#reCardExtra");
    if (!extra) return;
    try {
      const parsed = JSON.parse(extra.value);
      const value = (document.querySelector<HTMLTextAreaElement>("#reCardDescription")?.value ?? "").trim();
      if (value) parsed.description = value;
      else delete parsed.description;
      extra.value = JSON.stringify(parsed, null, 2);
    } catch {
      /* 预览 JSON 暂不合法时跳过同步 */
    }
  });
  document.querySelector<HTMLInputElement>("#reCardTopColor")?.addEventListener("input", () => {
    if (dialog?.kind !== "rules-editor" || !dialog.selectedCardId) return;
    const extra = document.querySelector<HTMLTextAreaElement>("#reCardExtra");
    if (!extra) return;
    try {
      const parsed = JSON.parse(extra.value);
      const value = (document.querySelector<HTMLInputElement>("#reCardTopColor")?.value ?? "").trim();
      parsed.topColor = value || undefined;
      extra.value = JSON.stringify(parsed, null, 2);
    } catch {
      /* 预览 JSON 暂不合法时跳过同步 */
    }
  });
  document.querySelector<HTMLSelectElement>("#rncType")?.addEventListener("change", (event) => {
    if (dialog?.kind !== "rules-card-create") return;
    const category = (event.target as HTMLSelectElement).value as NewCardCategory;
    const defaults = newCardCategoryDefaults(category);
    const chargeField = document.querySelector<HTMLElement>("#rncChargeField");
    if (chargeField) chargeField.hidden = defaults.type !== "ion";
    const chargeInput = document.querySelector<HTMLInputElement>("#rncCharge");
    if (chargeInput) chargeInput.value = "1";
    const colorInput = document.querySelector<HTMLInputElement>("#rncTopColor");
    if (colorInput) colorInput.value = defaults.color;
  });
  document.querySelector<HTMLInputElement>("#reAutoStack")?.addEventListener("change", () => {
    if (dialog?.kind !== "rules-editor") return;
    const checked = document.querySelector<HTMLInputElement>("#reAutoStack")?.checked ?? true;
    dialog.draft.display = { ...dialog.draft.display, autoStack: checked };
    render();
  });
  document.querySelector<HTMLInputElement>("#reMaxStack")?.addEventListener("input", () => {
    if (dialog?.kind !== "rules-editor") return;
    const value = Number(document.querySelector<HTMLInputElement>("#reMaxStack")?.value ?? "0");
    if (Number.isInteger(value) && value >= 0 && value <= 99) {
      dialog.draft.display = { ...dialog.draft.display, maxStack: value };
    }
  });
  document.querySelector<HTMLInputElement>("#reDealSeatCount")?.addEventListener("change", () => {
    if (dialog?.kind !== "rules-editor") return;
    if (visualDeckEditorLocked(dialog, "deal")) return;
    const value = Number(document.querySelector<HTMLInputElement>("#reDealSeatCount")?.value ?? "0");
    if (!Number.isInteger(value) || value < 0 || value > 10) return;
    if (value === 1) {
      dialog = { ...dialog, error: "初始发牌不能只规定 1 个座位；游戏至少 2 人，0 表示自动发牌" };
      render();
      return;
    }
    const current = dialog.draft.deck.deal ?? [];
    if (value === 0) {
      delete dialog.draft.deck.deal;
    } else {
      const next = current.slice(0, value).map((rule, seat) => ({ ...rule, seat }));
      while (next.length < value) next.push({ seat: next.length, fixed: {} });
      dialog.draft.deck.deal = next;
    }
    render();
  });
  document.querySelector<HTMLInputElement>("#reUniformDeal")?.addEventListener("change", (event) => {
    if (dialog?.kind !== "rules-editor") return;
    if (visualDeckEditorLocked(dialog, "deal")) return;
    const checked = (event.target as HTMLInputElement).checked;
    if (checked) {
      const template = dialog.draft.deck.deal?.[0] ?? {};
      setUniformDealTemplate(dialog.draft, template);
    } else {
      stopUsingUniformDeal(dialog.draft);
    }
    renderRulesEditorPreservingScroll();
  });
  document.querySelector<HTMLInputElement>("#reDisableOpeningExchange")?.addEventListener("change", (event) => {
    if (dialog?.kind !== "rules-editor") return;
    if ((event.target as HTMLInputElement).checked) dialog.draft.setup.disableOpeningExchange = true;
    else delete dialog.draft.setup.disableOpeningExchange;
  });
  document.querySelector<HTMLInputElement>("#reAllowWangZha")?.addEventListener("change", (event) => {
    if (dialog?.kind !== "rules-editor") return;
    if ((event.target as HTMLInputElement).checked) delete dialog.draft.setup.allowWangZha;
    else dialog.draft.setup.allowWangZha = false;
  });
  document.querySelectorAll<HTMLInputElement>(".deck-count-input").forEach((input) => {
    if (input.classList.contains("deal-fixed-count-input")) return;
    input.addEventListener("input", () => {
      if (dialog?.kind !== "rules-editor") return;
      if (visualDeckEditorLocked(dialog, "deck")) return;
      const id = input.dataset.cardId ?? "";
      if (!(id in dialog.draft.deck.cards)) return;
      const raw = input.value.trim();
      if (raw === "") return;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 1) return;
      dialog.draft.deck.cards[id] = value;
      const total = Object.values(dialog.draft.deck.cards).reduce((sum, count) => sum + count, 0);
      const totalLabel = document.querySelector<HTMLElement>("#reDeckTotal");
      if (totalLabel) totalLabel.textContent = `牌堆总数 ${total}`;
    });
    input.addEventListener("change", () => {
      if (dialog?.kind !== "rules-editor") return;
      if (visualDeckEditorLocked(dialog, "deck")) return;
      const id = input.dataset.cardId ?? "";
      const value = Number(input.value);
      if (!(id in dialog.draft.deck.cards)) return;
      if (!Number.isSafeInteger(value) || value < 1) {
        input.value = String(dialog.draft.deck.cards[id]);
      }
    });
  });
  document.querySelectorAll<HTMLInputElement>(".deal-fixed-count-input").forEach((input) => {
    input.addEventListener("input", () => {
      if (dialog?.kind !== "rules-editor") return;
      if (visualDeckEditorLocked(dialog, "deal")) return;
      const seat = Number(input.dataset.seat);
      const id = input.dataset.cardId ?? "";
      const raw = input.value.trim();
      if (raw === "") return;
      const value = Number(raw);
      if (Number.isSafeInteger(value) && value >= 1) {
        updateVisualDealRule(dialog.draft, seat, (rule) => {
          if (rule.fixed && id in rule.fixed) rule.fixed[id] = value;
        });
      }
    });
    input.addEventListener("change", () => {
      if (dialog?.kind !== "rules-editor") return;
      if (visualDeckEditorLocked(dialog, "deal")) return;
      const seat = Number(input.dataset.seat);
      const id = input.dataset.cardId ?? "";
      const value = Number(input.value);
      const rule = customUniformDealTemplate(dialog.draft) ?? dialog.draft.deck.deal?.[seat];
      if (!rule?.fixed || !(id in rule.fixed)) return;
      if (!Number.isSafeInteger(value) || value < 1) input.value = String(rule.fixed[id]);
    });
  });
  document.querySelectorAll<HTMLInputElement>(".deal-fill").forEach((input) => {
    input.addEventListener("input", () => {
      if (dialog?.kind !== "rules-editor") return;
      if (visualDeckEditorLocked(dialog, "deal")) return;
      const seat = Number(input.dataset.seat);
      const raw = input.value.trim();
      const value = Number(raw);
      updateVisualDealRule(dialog.draft, seat, (rule) => {
        if (raw === "") delete rule.fill;
        else if (Number.isSafeInteger(value) && value >= 2) rule.fill = value;
      });
    });
    input.addEventListener("change", () => {
      if (dialog?.kind !== "rules-editor") return;
      const seat = Number(input.dataset.seat);
      const rule = customUniformDealTemplate(dialog.draft) ?? dialog.draft.deck.deal?.[seat];
      if (!rule) return;
      const raw = input.value.trim();
      const value = Number(raw);
      if (raw !== "" && (!Number.isSafeInteger(value) || value < 2)) input.value = rule.fill === undefined ? "" : String(rule.fill);
    });
  });
  document.querySelectorAll<HTMLElement>(".display-order-item[draggable='true']").forEach((item) => {
    item.addEventListener("dragstart", (event) => {
      displayOrderDragId = item.dataset.cardId;
      item.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", displayOrderDragId ?? "");
    });
    item.addEventListener("dragend", () => clearDisplayOrderIndicator());
    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (dialog?.kind !== "rules-display-order" || !displayOrderDragId) return;
      const id = item.dataset.cardId;
      if (!id) return;
      const rect = item.getBoundingClientRect();
      const before = event.clientY - rect.top < rect.height / 2;
      setDisplayOrderIndicator(id, before);
    });
  });
  const orderListEl = document.querySelector<HTMLElement>(".display-order-list:not(.readonly-list)");
  orderListEl?.addEventListener("dragover", (event) => {
    if (dialog?.kind !== "rules-display-order" || !displayOrderDragId) return;
    if ((event.target as HTMLElement).closest(".display-order-item")) return;
    event.preventDefault();
    const last = Array.from(orderListEl.querySelectorAll<HTMLElement>(".display-order-item[data-card-id]")).pop();
    if (last?.dataset.cardId) setDisplayOrderIndicator(last.dataset.cardId, false);
  });
  orderListEl?.addEventListener("drop", (event) => {
    event.preventDefault();
    if (dialog?.kind !== "rules-display-order") return;
    const from = displayOrderDragId ?? event.dataTransfer?.getData("text/plain");
    const target = displayOrderDropTarget;
    clearDisplayOrderIndicator();
    if (!from || !target) return;
    const order = [...dialog.order];
    const fromIndex = order.indexOf(from);
    let insertAt = order.indexOf(target.id) + (target.before ? 0 : 1);
    if (fromIndex < 0 || insertAt < 0) return;
    order.splice(fromIndex, 1);
    if (fromIndex < insertAt) insertAt -= 1;
    order.splice(Math.min(insertAt, order.length), 0, from);
    dialog = { ...dialog, order };
    render();
  });
  document.querySelector<HTMLInputElement>("#reJsonFile")?.addEventListener("change", async (event) => {
    if (dialog?.kind !== "rules-editor") return;
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      dialog = { ...dialog, draft: rulesDraftFromImportedSource(parsed), jsonRevision: (dialog.jsonRevision ?? 0) + 1, error: undefined };
    } catch (error) {
      dialog = { ...dialog, error: `导入失败：${error instanceof Error ? error.message : String(error)}` };
    }
    render();
  });
  document.querySelector<HTMLSelectElement>("#bulkGrantMode")?.addEventListener("change", () => { if (dialog?.kind === "bulk-grant-points") render(); });
  document.querySelector<HTMLInputElement>("#bulkGrantTotalPoints")?.addEventListener("input", updateBulkGrantHints);
  document.querySelector<HTMLInputElement>("#bulkGrantPerUserPoints")?.addEventListener("input", updateBulkGrantHints);
  document.querySelector<HTMLInputElement>("#bulkSelectAll")?.addEventListener("change", (event) => {
    if (dialog?.kind !== "bulk-grant-points") return;
    const checked = (event.currentTarget as HTMLInputElement).checked;
    dialog = { ...dialog, selectedUserIds: checked ? sortedManagedUsersForLeaderboard().map((user) => user.id) : [] };
    render();
  });
  document.querySelectorAll<HTMLInputElement>("[data-bulk-user]").forEach((input) => input.addEventListener("change", () => {
    if (dialog?.kind !== "bulk-grant-points") return;
    const selected = new Set(dialog.selectedUserIds ?? []);
    if (input.checked) selected.add(input.dataset.bulkUser ?? "");
    else selected.delete(input.dataset.bulkUser ?? "");
    dialog = { ...dialog, selectedUserIds: [...selected].filter(Boolean) };
    render();
  }));
  for (const id of ["Admin", "Advanced"] as const) {
    document.querySelector<HTMLSelectElement>(`#activation${id}Grant`)?.addEventListener("change", () => updateActivationGrantFields(id));
    document.querySelector<HTMLSelectElement>(`#activation${id}Mode`)?.addEventListener("change", () => updateActivationGrantFields(id));
  }
  for (const prefix of ["invite", "activation"] as const) {
    document
      .querySelector<HTMLSelectElement>(`#${prefix}AdvancedAiGrant`)
      ?.addEventListener("change", () => updateAdvancedAiGrantFields(prefix));
    document
      .querySelector<HTMLSelectElement>(`#${prefix}AdvancedAiMode`)
      ?.addEventListener("change", () => updateAdvancedAiGrantFields(prefix));
  }
}

async function handleAct(action: string, el?: HTMLElement): Promise<void> {
  if (action === "clear-date") {
    const input = document.getElementById(el?.dataset.target ?? "") as HTMLInputElement | null;
    if (input) {
      input.value = "";
      input.focus();
    }
  }
  if (action === "open-credits") {
    modal = { kind: "credits" };
    render();
  }
  if (action === "sound") {
    audio.enabled = !audio.enabled;
    localStorage.setItem("ionStormAudio", audio.enabled ? "1" : "0");
    audio.play("click");
    render();
  }
  if (action === "open-auth") {
    modal = { kind: "auth", mode: "login", username: currentUser?.username ?? "" };
    render();
  }
  if (action === "switch-register" && modal?.kind === "auth") {
    if (currentUser) return;
    modal = { kind: "auth", mode: "register", username: authUsernameValue() };
    render();
  }
  if (action === "switch-login" && modal?.kind === "auth") {
    modal = { kind: "auth", mode: "login", username: authUsernameValue() };
    render();
  }
  if (action === "guest-continue") {
    localStorage.setItem("ionStormGuestOk", "1");
    modal = null;
    render();
  }
  if (action === "auth-submit") {
    await submitAuth();
  }
  if (action === "toggle-account-menu") {
    accountMenuOpen = !accountMenuOpen;
    render();
  }
  if (action === "open-users") {
    accountMenuOpen = false;
    await openUserManagement();
  }
  if (action === "open-leaderboard") {
    accountMenuOpen = false;
    await openLeaderboard();
  }
  if (action === "go-home") {
    history.pushState({}, "", "/");
    dialog = null;
    render();
  }
  if (action === "go-invite") {
    await openInviteManagement();
  }
  if (action === "go-activation") {
    await openActivationManagement();
  }
  if (action === "go-ticket") {
    await openTicketManagement();
  }
  if (action === "ack-request-notice") {
    await acknowledgeRequestNotifications();
  }
  if (action === "request-logout") {
    accountMenuOpen = false;
    dialog = { kind: "confirm-logout" };
    render();
  }
  if (action === "confirm-logout") {
    await logout();
  }
  if (action === "refresh-state") {
    await manualRefreshState();
  }
  if (action === "cancel-autoplay") {
    await cancelOwnAutoplay();
  }
  if (action === "open-user-edit") {
    dialog = { kind: "edit-user", userId: el?.dataset.userId ?? "" };
    render();
  }
  if (action === "open-user-disable") {
    dialog = { kind: "disable-user", userId: el?.dataset.userId ?? "" };
    render();
  }
  if (action === "open-reserved-room-codes") {
    const userId = el?.dataset.userId ?? "";
    if (!userId) return;
    dialog = { kind: "reserved-room-codes", userId };
    render();
    await loadReservedRoomCodes(userId);
  }
  if (action === "edit-reserved-room-code" && dialog?.kind === "reserved-room-codes") {
    dialog = { ...dialog, editingCode: dialog.editingCode === el?.dataset.code ? undefined : el?.dataset.code, error: undefined };
    render();
  }
  if (action === "add-reserved-room-code" && dialog?.kind === "reserved-room-codes") {
    await addReservedRoomCode(dialog.userId);
  }
  if (action === "save-reserved-room-code" && dialog?.kind === "reserved-room-codes") {
    await editReservedRoomCode(dialog.userId, el?.dataset.code ?? "");
  }
  if (action === "delete-reserved-room-code" && dialog?.kind === "reserved-room-codes") {
    await deleteReservedRoomCode(dialog.userId, el?.dataset.code ?? "");
  }
  if (action === "submit-user-edit") {
    await saveUserFromDialog(el?.dataset.userId ?? "");
  }
  if (action === "submit-user-disable") {
    await saveUserDisableFromDialog(el?.dataset.userId ?? "");
  }
  if (action === "delete-user") {
    dialog = { kind: "delete-user", userId: el?.dataset.userId ?? "" };
    render();
  }
  if (action === "submit-user-delete") {
    await deleteUserFromDialog(el?.dataset.userId ?? "");
  }
  if (action === "download-users-csv") {
    await downloadUsersCsv();
  }
  if (action === "new-invite") {
    dialog = { kind: "edit-invite" };
    render();
  }
  if (action === "edit-invite") {
    dialog = { kind: "edit-invite", code: el?.dataset.code ?? "" };
    render();
  }
  if (action === "delete-invite") {
    dialog = { kind: "delete-invite", code: el?.dataset.code ?? "" };
    render();
  }
  if (action === "confirm-delete-invite") {
    await deleteManagedCode("invite", el?.dataset.code ?? "");
  }
  if (action === "submit-invite-edit") {
    await saveInviteFromDialog(el?.dataset.code || undefined);
  }
  if (action === "edit-permissions") {
    await openPermissionsDialog();
  }
  if (action === "edit-custom-presets") {
    await openCustomPresetsDialog();
  }
  if (action === "save-custom-mode-limits") {
    await saveCustomModeLimitsFromDialog();
  }
  if (action === "preset-new" && dialog?.kind === "custom-presets") {
    dialog = { ...dialog, form: { displayName: "", source: "" }, error: undefined, previewResult: undefined };
    render();
  }
  if (action === "preset-edit" && dialog?.kind === "custom-presets") {
    const preset = customPresetsSnapshot?.find((item) => item.id === el?.dataset.id);
    if (preset) {
      dialog = { ...dialog, form: { id: preset.id, displayName: preset.displayName, source: JSON.stringify(preset.sourceDocument, null, 2) }, error: undefined, previewResult: undefined };
      render();
    }
  }
  if (action === "preset-cancel" && dialog?.kind === "custom-presets") {
    dialog = { ...dialog, form: undefined, error: undefined, previewResult: undefined };
    render();
  }
  if (action === "preset-save") {
    await savePresetFromDialog();
  }
  if (action === "preset-preview") {
    await previewPresetFromDialog();
  }
  if (action === "preset-toggle" && dialog?.kind === "custom-presets") {
    const preset = customPresetsSnapshot?.find((item) => item.id === el?.dataset.id);
    if (preset) {
      try {
        await httpPost(`/api/custom-presets/${preset.id}`, { enabled: !preset.enabled });
        await refreshCustomPresets();
        await loadEnabledCustomPresets(true);
        dialog = { kind: "custom-presets" };
      } catch (error) {
        dialog = { kind: "custom-presets", error: error instanceof Error ? error.message : "操作失败" };
      }
      render();
    }
  }
  if (action === "preset-duplicate" && dialog?.kind === "custom-presets") {
    try {
      await httpPost(`/api/custom-presets/${el?.dataset.id}/duplicate`, {});
      await refreshCustomPresets();
      await loadEnabledCustomPresets(true);
      dialog = { kind: "custom-presets" };
    } catch (error) {
      dialog = { kind: "custom-presets", error: error instanceof Error ? error.message : "复制失败" };
    }
    render();
  }
  if (action === "preset-delete" && dialog?.kind === "custom-presets") {
    try {
      await httpDelete(`/api/custom-presets/${el?.dataset.id}`);
      await refreshCustomPresets();
      await loadEnabledCustomPresets(true);
      dialog = { kind: "custom-presets" };
    } catch (error) {
      dialog = { kind: "custom-presets", error: error instanceof Error ? error.message : "删除失败" };
    }
    render();
  }
  if (action === "submit-permissions") {
    await savePermissionsFromDialog();
  }
  if (action === "edit-tax-settings") {
    await openTaxSettingsDialog();
  }
  if (action === "submit-tax-settings") {
    await saveTaxSettingsFromDialog();
  }
  if (action === "submit-ticket") {
    dialog = { kind: "request" };
    render();
  }
  if (action === "review-ticket") {
    const requestId = el?.dataset.requestId ?? "";
    const request = requests.find((item) => item.id === requestId);
    if (request?.kind === "security") await submitTicketReview(requestId, "ignored");
    else {
      dialog = { kind: "review-ticket", requestId };
      render();
    }
  }
  if (action === "submit-ticket-review") {
    await submitTicketReview(el?.dataset.requestId ?? "");
  }
  if (action === "download-security-log") {
    await downloadSecurityLog(el?.dataset.logId ?? "");
  }
  if (action === "submit-request") {
    await submitRequestFromDialog();
  }
  if (action === "open-win-music") {
    dialog = { kind: "win-music", userId: el?.dataset.userId ?? "" };
    render();
  }
  if (action === "upload-music") {
    await uploadMusicByPicker(el?.dataset.userId ?? "");
  }
  if (action === "play-music") {
    await playUserMusic(el?.dataset.userId ?? "", true);
  }
  if (action === "download-music") {
    await downloadUserMusic(el?.dataset.userId ?? "");
  }
  if (action === "delete-music") {
    passwordConfirm = { action: { kind: "delete-music", userId: el?.dataset.userId ?? "" } };
    render();
  }
  if (action === "new-activation") {
    dialog = { kind: "edit-activation" };
    render();
  }
  if (action === "grant-points") {
    activationRegisteredUserCount = Math.max(activationRegisteredUserCount, managedUsers.length);
    dialog = { kind: "edit-point-distribution" };
    render();
  }
  if (action === "bulk-grant-points") {
    dialog = { kind: "bulk-grant-points", selectedUserIds: [] };
    render();
  }
  if (action === "submit-bulk-grant-points") {
    await submitBulkGrantPoints();
  }
  if (action === "edit-point-distribution") {
    dialog = { kind: "edit-point-distribution", code: el?.dataset.code ?? "" };
    render();
  }
  if (action === "edit-activation") {
    dialog = { kind: "edit-activation", code: el?.dataset.code ?? "" };
    render();
  }
  if (action === "delete-activation") {
    dialog = { kind: "delete-activation", code: el?.dataset.code ?? "" };
    render();
  }
  if (action === "confirm-delete-activation") {
    await deleteManagedCode("activation", el?.dataset.code ?? "");
  }
  if (action === "submit-activation") {
    await saveActivationFromDialog(el?.dataset.code || undefined);
  }
  if (action === "submit-point-distribution") {
    await savePointDistributionFromDialog(el?.dataset.code || undefined);
  }
  if (action === "redeem-activation") {
    dialog = { kind: "redeem-activation" };
    render();
  }
  if (action === "submit-activation-redeem") {
    await redeemActivationFromDialog();
  }
  if (action === "confirm-activation-custom") {
    await redeemActivationWithCustomValues();
  }
  if (action === "dialog-close") {
    dialog = null;
    render();
  }
  if (action === "password-confirm-close") {
    passwordConfirm = null;
    render();
  }
  if (action === "password-confirm-submit") {
    await executeProtectedAction();
  }
  if (action === "opening-submit") {
    await submitOpeningExchange([...openingExchangeSelection]);
  }
  if (action === "opening-skip") {
    openingExchangeSelection.clear();
    await submitOpeningExchange([]);
  }
  if (action === "opening-double") {
    if (game && isCustomGame(game)) await submit({ type: "custom", choiceId: "opening-double", selectedCount: 2 });
    else await submit({ type: "opening-double", enabled: true });
  }
  if (action === "opening-no-double") {
    if (game && isCustomGame(game)) await submit({ type: "custom", choiceId: "opening-double", selectedCount: 0 });
    else await submit({ type: "opening-double", enabled: false });
  }
  if (action === "toggle-ai-advice") {
    await toggleAdvancedAiAdvice();
  }
  if (action === "apply-ai-suggestion") {
    const seat = advancedAiDecisionPlayer();
    const suggested = seat ? currentAdvancedAiAction(seat.id) : undefined;
    if (suggested) await submit(suggested);
  }
  if (action === "open-local") openSetupModal("local");
  if (action === "open-online") {
    if (!currentUser) {
      modal = { kind: "auth", mode: "login", username: "" };
      toast("请先登录后创建联机房间");
    } else openSetupModal("online");
  }
  if (action === "open-join") {
    if (!currentUser) {
      modal = { kind: "auth", mode: "login", username: "", error: "请先登录后加入联机房间" };
      render();
      return;
    }
    modal = { kind: "join", code: room?.code ?? "" };
    render();
  }
  if (action === "modal-close") {
    if (modal?.kind === "actions" && modal.forced) return;
    modal = null;
    render();
  }
  if (action === "modal-submit") {
    await submitModal();
  }
  if (action === "copy-room-link" && room) {
    if (await copyText(`${location.origin}/room/${room.code}`)) toast("房间链接已复制");
    else toast("复制失败，请手动复制房间链接");
  }
  if (action === "start-online" && room) {
    let customRulesHashReady: string | undefined;
    if (room.rulesetMode === "custom") {
      const code = room.code;
      const expectedHash = room.customRulesHash;
      if (!expectedHash) {
        toast("房间缺少自定义规则快照");
        return;
      }
      try {
        const rules = await loadRoomCustomRules(code, expectedHash);
        if (room?.code !== code || room.customRulesHash !== expectedHash || rules.hash !== expectedHash) return;
        customRulesHashReady = expectedHash;
      } catch (error) {
        toast(error instanceof Error ? error.message : "规则下载失败，请重试");
        return;
      }
    }
    if (game?.status === "ended") {
      dismissedWinnerId = game.winnerId ?? "";
      waitingForOnlineRematch = true;
      game = undefined;
      watchedSeatId = "";
      selectedCard = "all";
      selectedHandIndex = null;
      openingSelectionKey = "";
      openingExchangeSelection.clear();
      drawAnimations = [];
      animatedSeatIds.clear();
      animatedDrawCounts.clear();
      activeWinMusic?.pause();
      render();
      startHeartbeat();
      startReconcilePolling(room.code);
    }
    await sendOnlineMessage(
      { type: "startGame", code: room.code, playerId: selfId, customRulesHashReady },
      `/api/rooms/${room.code}/start`,
      { playerId: selfId, customRulesHashReady },
    );
  }
  if (action === "add-online-bot" && room) {
    await sendOnlineMessage({ type: "addBot", code: room.code, ownerId: selfId }, `/api/rooms/${room.code}/bots`, { ownerId: selfId });
  }
  if (action === "edit-room" && room && currentUser?.id === room.creatorAccountId) {
    dialog = { kind: "edit-room" };
    render();
  }
  if (action === "view-room-rules") {
    dialog = { kind: "view-room-rules" };
    render();
    if (room && room.rulesetMode === "custom" && !currentViewableRules()) {
      const code = room.code;
      const hash = room.customRulesHash;
      void (async () => {
        try {
          await loadRoomCustomRules(code, hash);
        } catch (error) {
          toast(error instanceof Error ? error.message : "加载房间规则失败");
        }
        if (dialog?.kind === "view-room-rules") render();
      })();
    }
  }
  if (action === "view-rules-card-select" && dialog?.kind === "view-room-rules") {
    dialog = { ...dialog, selectedCardId: el?.dataset.cardId ?? undefined };
    renderRoomRulesPreservingScroll();
  }
  if (action === "rules-blank-create" && modal && (modal.kind === "local" || modal.kind === "online")) {
    modal = { ...modal, customRules: undefined, customPresetId: undefined, customBlank: true };
    dialog = { kind: "rules-editor", target: "create", tab: "cards", draft: blankRulesDraft(), deckFilter: "all" };
    render();
  }
  if (action === "open-rules-editor" && modal && (modal.kind === "local" || modal.kind === "online")) {
    // Preserve the source label for the picker, but submit an edited copy instead of mutating the global preset.
    dialog = {
      kind: "rules-editor",
      target: "create",
      tab: "cards",
      draft: modal.customBlank && !modal.customRules ? blankRulesDraft() : rulesDraftFromResolved(modal.customRules ?? PLATFORM_PRESET),
      deckFilter: "all",
    };
    modal = { ...modal, customPresetEdited: Boolean(modal.customPresetId) };
    render();
  }
  if (action === "edit-room-rules" && room && room.rulesetMode === "custom") {
    const code = room.code;
    const hash = room.customRulesHash;
    void (async () => {
      try {
        const rules = await loadRoomCustomRules(code, hash);
        dialog = { kind: "rules-editor", target: "edit-room", tab: "cards", draft: rulesDraftFromResolved(rules), deckFilter: "all" };
      } catch (error) {
        toast(error instanceof Error ? error.message : "加载房间规则失败");
      }
      render();
    })();
  }
  if (action === "rules-editor-tab" && dialog?.kind === "rules-editor") {
    const tab = (el?.dataset.tab ?? "basic") as RulesEditorTab;
    dialog = { ...dialog, tab, error: undefined };
    render();
  }
  if (action === "rules-deck-inc" && dialog?.kind === "rules-editor") {
    if (visualDeckEditorLocked(dialog, "deck")) return;
    const id = el?.dataset.cardId ?? "";
    if (id in dialog.draft.deck.cards) dialog.draft.deck.cards[id] += 1;
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-deck-dec" && dialog?.kind === "rules-editor") {
    if (visualDeckEditorLocked(dialog, "deck")) return;
    const id = el?.dataset.cardId ?? "";
    if (id in dialog.draft.deck.cards) {
      dialog.draft.deck.cards[id] -= 1;
      if (dialog.draft.deck.cards[id] <= 0) delete dialog.draft.deck.cards[id];
    }
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-deck-remove" && dialog?.kind === "rules-editor") {
    if (visualDeckEditorLocked(dialog, "deck")) return;
    const id = el?.dataset.cardId ?? "";
    delete dialog.draft.deck.cards[id];
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-deck-add" && dialog?.kind === "rules-editor") {
    if (visualDeckEditorLocked(dialog, "deck")) return;
    const id = (document.querySelector("#reAddCardId") as HTMLSelectElement | null)?.value ?? "";
    if (id && dialog.draft.cards[id] && !(id in dialog.draft.deck.cards)) dialog.draft.deck.cards[id] = 1;
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-deal-fixed-inc" && dialog?.kind === "rules-editor") {
    if (visualDeckEditorLocked(dialog, "deal")) return;
    const seat = Number(el?.dataset.seat);
    const id = el?.dataset.cardId ?? "";
    updateVisualDealRule(dialog.draft, seat, (rule) => {
      if (rule.fixed && id in rule.fixed) rule.fixed[id] += 1;
    });
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-deal-fixed-dec" && dialog?.kind === "rules-editor") {
    if (visualDeckEditorLocked(dialog, "deal")) return;
    const seat = Number(el?.dataset.seat);
    const id = el?.dataset.cardId ?? "";
    updateVisualDealRule(dialog.draft, seat, (rule) => {
      if (!rule.fixed || !(id in rule.fixed)) return;
      rule.fixed[id] -= 1;
      if (rule.fixed[id] <= 0) delete rule.fixed[id];
    });
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-deal-fixed-remove" && dialog?.kind === "rules-editor") {
    if (visualDeckEditorLocked(dialog, "deal")) return;
    const seat = Number(el?.dataset.seat);
    const id = el?.dataset.cardId ?? "";
    updateVisualDealRule(dialog.draft, seat, (rule) => {
      if (rule.fixed) delete rule.fixed[id];
    });
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-deal-fixed-add" && dialog?.kind === "rules-editor") {
    if (visualDeckEditorLocked(dialog, "deal")) return;
    const seat = Number(el?.dataset.seat);
    const id = (document.querySelector(`.deal-add-select[data-seat="${seat}"]`) as HTMLSelectElement | null)?.value ?? "";
    if (id && dialog.draft.deck.cards[id] > 0) {
      updateVisualDealRule(dialog.draft, seat, (rule) => {
        rule.fixed ??= {};
        if (!(id in rule.fixed)) rule.fixed[id] = 1;
      });
    }
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-order-edit" && dialog?.kind === "rules-editor") {
    dialog = { kind: "rules-display-order", editor: dialog, order: [...draftDisplayOrder(dialog.draft)] };
    render();
  }
  if (action === "rules-order-save" && dialog?.kind === "rules-display-order") {
    const { editor, order } = dialog;
    editor.draft.display = { ...editor.draft.display, order };
    dialog = editor;
    render();
  }
  if (action === "rules-order-cancel" && dialog?.kind === "rules-display-order") {
    dialog = dialog.editor;
    render();
  }
  if (action === "rules-doc-download") {
    downloadTextFile("custom-rules-json-spec.md", rulesSpecMarkdown, "text/markdown;charset=utf-8");
  }
  if (action === "rules-template-download") {
    downloadTextFile("custom-game-template.json", rulesTemplateJson);
  }
  if (action === "rules-card-select" && dialog?.kind === "rules-editor") {
    dialog = { ...dialog, selectedCardId: el?.dataset.cardId ?? undefined, error: undefined };
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-card-apply" && dialog?.kind === "rules-editor" && dialog.selectedCardId) {
    const id = dialog.selectedCardId;
    const raw = (document.querySelector("#reCardExtra") as HTMLTextAreaElement | null)?.value ?? "";
    const nameValue = ((document.querySelector("#reCardName") as HTMLInputElement | null)?.value ?? "").trim();
    const descriptionValue = ((document.querySelector("#reCardDescription") as HTMLTextAreaElement | null)?.value ?? "").trim();
    const topColorValue = ((document.querySelector("#reCardTopColor") as HTMLInputElement | null)?.value ?? "").trim();
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("卡牌定义必须是对象");
      if (parsed.type !== dialog.draft.cards[id]?.type) throw new Error("不能在编辑器中修改卡牌类型；如需变更请删除后重建");
      if (nameValue) parsed.displayName = nameValue;
      if (descriptionValue) parsed.description = descriptionValue;
      else delete parsed.description;
      if (topColorValue) parsed.topColor = topColorValue;
      dialog.draft.cards[id] = parsed as CustomCardDef;
      dialog = { ...dialog, error: undefined };
    } catch (error) {
      dialog = { ...dialog, error: `卡牌定义无效：${error instanceof Error ? error.message : String(error)}` };
    }
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-card-delete" && dialog?.kind === "rules-editor" && dialog.selectedCardId) {
    const id = dialog.selectedCardId;
    delete dialog.draft.cards[id];
    delete dialog.draft.deck.cards[id];
    if (dialog.draft.display?.order) dialog.draft.display.order = dialog.draft.display.order.filter((existing) => existing !== id);
    dialog = { ...dialog, selectedCardId: undefined };
    renderRulesEditorPreservingScroll();
  }
  if (action === "rules-card-create-open" && dialog?.kind === "rules-editor") {
    dialog = { kind: "rules-card-create", editor: dialog };
    render();
  }
  if (action === "rules-card-create-cancel" && dialog?.kind === "rules-card-create") {
    dialog = dialog.editor;
    render();
  }
  if (action === "rules-card-create-confirm" && dialog?.kind === "rules-card-create") {
    const editor = dialog.editor;
    const id = ((document.querySelector("#rncId") as HTMLInputElement | null)?.value ?? "").trim();
    const name = ((document.querySelector("#rncName") as HTMLInputElement | null)?.value ?? "").trim();
    const description = ((document.querySelector("#rncDescription") as HTMLTextAreaElement | null)?.value ?? "").trim();
    const category = (((document.querySelector("#rncType") as HTMLSelectElement | null)?.value ?? "generic") as NewCardCategory);
    const chargeRaw = Number((document.querySelector("#rncCharge") as HTMLInputElement | null)?.value ?? "1");
    const topColor = (((document.querySelector("#rncTopColor") as HTMLInputElement | null)?.value ?? "").trim() || undefined);
    const extraRaw = ((document.querySelector("#rncExtra") as HTMLTextAreaElement | null)?.value ?? "").trim();
    const fail = (message: string) => {
      dialog = { kind: "rules-card-create", editor, error: message };
      render();
    };
    if (!/^[A-Za-z0-9_+\-^{}[\]]{1,32}$/.test(id)) return fail("卡牌 ID 只能包含字母、数字与常用符号，最长 32 字符");
    if (editor.draft.cards[id]) return fail(`卡牌 ${id} 已存在`);
    if (!name) return fail("请输入显示名称");
    if (!NEW_CARD_CATEGORIES.includes(category)) return fail("未知卡牌类型");
    let extra: Record<string, unknown> = {};
    if (extraRaw) {
      try {
        const parsed = JSON.parse(extraRaw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("行为定义必须是 JSON 对象");
        extra = parsed as Record<string, unknown>;
      } catch (error) {
        return fail(`行为定义无效：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const defaults = newCardCategoryDefaults(category);
    const magnitude = Number.isInteger(chargeRaw) && chargeRaw !== 0 ? Math.min(7, Math.abs(chargeRaw)) : 1;
    const charge = defaults.type === "ion" ? (category === "anion" ? -magnitude : magnitude) : undefined;
    const def = {
      ...extra,
      displayName: name,
      ...(description ? { description } : {}),
      type: defaults.type,
      ...(charge !== undefined ? { charge } : {}),
      ...(topColor && topColor !== defaults.color ? { topColor } : {}),
    } as CustomCardDef;
    editor.draft.cards[id] = def;
    // 新牌默认放在它所属类型牌的最后
    if (editor.draft.display?.order) {
      const order = editor.draft.display.order.filter((existing) => existing !== id);
      let insertAt = order.length;
      for (let i = order.length - 1; i >= 0; i--) {
        if (editor.draft.cards[order[i]]?.type === defaults.type) {
          insertAt = i + 1;
          break;
        }
      }
      order.splice(insertAt, 0, id);
      editor.draft.display.order = order;
    }
    dialog = { ...editor, selectedCardId: id, error: undefined };
    render();
  }
  if (action === "rules-json-apply" && dialog?.kind === "rules-editor") {
    const raw = (document.querySelector("#reJsonText") as HTMLTextAreaElement | null)?.value ?? "";
    try {
      const parsed = JSON.parse(raw) as unknown;
      dialog = { ...dialog, draft: rulesDraftFromImportedSource(parsed), jsonRevision: (dialog.jsonRevision ?? 0) + 1, error: undefined };
    } catch (error) {
      dialog = { ...dialog, error: `JSON 无效：${error instanceof Error ? error.message : String(error)}` };
    }
    render();
  }
  if (action === "rules-json-import" && dialog?.kind === "rules-editor") {
    (document.querySelector("#reJsonFile") as HTMLInputElement | null)?.click();
  }
  if (action === "export-rules-full") {
    const source =
      dialog?.kind === "rules-editor"
        ? JSON.stringify(dialog.draft, null, 2)
        : currentViewableRules()
          ? JSON.stringify(rulesDraftFromResolved(currentViewableRules()!), null, 2)
          : undefined;
    if (source) downloadTextFile(`ion-storm-rules-${Date.now()}.json`, source);
  }
  if (action === "rules-editor-save") {
    await saveRulesEditorDraft();
  }
  if (action === "submit-room-edit") {
    await saveRoomEditFromDialog();
  }
  if (action === "kick-room-player") {
    dialog = { kind: "kick-player", playerId: el?.dataset.playerId ?? "" };
    render();
  }
  if (action === "confirm-kick-player" && room) {
    const targetId = el?.dataset.playerId ?? "";
    dialog = null;
    await sendOnlineMessage(
      { type: "kickPlayer", code: room.code, playerId: selfId, targetId },
      `/api/rooms/${room.code}/kick`,
      { playerId: selfId, targetId },
    );
  }
  if (action === "leave-room") {
    if (mode === "online" && isOnlineGameRunning()) return;
    dialog = { kind: "leave-room", local: mode === "local" };
    render();
  }
  if (action === "confirm-leave-room") {
    if (el?.dataset.local === "true") {
      location.reload();
      return;
    }
    await exitOnlineRoom();
  }
  if (action === "restart-local" && mode === "local" && game?.status === "ended") {
    const nextGame = createRulesetRematch(game);
    beginGameContextSwitch();
    mode = "local";
    room = undefined;
    game = nextGame;
    modal = null;
    prefetchGameWinMusic(game);
    startDealAnimation(game, true);
    audio.play("start");
    render();
  }
  if (action === "win-close" && game?.winnerId) {
    dismissedWinnerId = game.winnerId;
    render();
  }
  if (action === "export-game-log") {
    exportGameLogCsv();
  }
}

function openSetupModal(kind: "local" | "online"): void {
  if (game?.winnerId) dismissedWinnerId = game.winnerId;
  modal = { kind, ruleset: "classic", playerCount: 2, botCount: 0, baseBet: 5, initialHandSize: "", turnTimeLimit: "", openingExchangeTime: "" };
  if (currentUser) void loadEnabledCustomPresets();
  render();
}

async function submitModal(): Promise<void> {
  if (!modal) return;
  if (modal.kind === "local" || modal.kind === "online") {
    const ruleset = (document.querySelector("#modalRuleset") as HTMLSelectElement | null)?.value === "custom" ? ("custom" as const) : ("classic" as const);
    const playerCount = Number((document.querySelector("#modalPlayers") as HTMLInputElement).value);
    const botCount =
      modal.kind === "local" && ruleset === "classic" ? Number((document.querySelector("#modalBots") as HTMLInputElement).value || 0) : 0;
    const baseBet = modal.kind === "online" ? Number((document.querySelector("#modalBaseBet") as HTMLInputElement | null)?.value ?? 5) : 0;
    const initialHandSizeRaw = ((document.querySelector("#modalInitialHandSize") as HTMLInputElement | null)?.value ?? "").trim();
    const turnTimeLimitRaw = ((document.querySelector("#modalTurnTimeLimit") as HTMLInputElement | null)?.value ?? "").trim();
    const openingExchangeTimeRaw = ((document.querySelector("#modalOpeningExchangeTime") as HTMLInputElement | null)?.value ?? "").trim();
    const roomCodeMode = modal.kind === "online" && document.querySelector<HTMLSelectElement>("#modalRoomCodeMode")?.value === "reserved" ? "reserved" as const : "custom" as const;
    const roomCode = ((document.querySelector<HTMLInputElement | HTMLSelectElement>("#modalRoomCode")?.value ?? "").trim());
    const handSizeSeats = modal.kind === "online" ? playerCount : playerCount + botCount;
    const initialHandSize = initialHandSizeRaw === "" ? undefined : Number(initialHandSizeRaw);
    const presetSelected = ruleset === "custom" && Boolean(modal.customPresetId);
    const customRulesForSubmit = ruleset === "custom"
      ? (modal.customRules ?? (modal.customBlank || presetSelected ? undefined : PLATFORM_PRESET))
      : undefined;
    const customPresetIdForSubmit = ruleset === "custom" && modal.kind === "online" && !modal.customPresetEdited ? (modal.customPresetId || undefined) : undefined;
    const [customPlayersMin, customPlayersMax] = setupPlayersRange((customRulesForSubmit ?? PLATFORM_PRESET).setup.players);
    const dealRequiredForSubmit = customRulesForSubmit ? requiredPlayersFromDeal(customRulesForSubmit, playerCount) : null;
    const customRoomHandEditable = customRulesForSubmit
      ? !customDealHasAnyFill(customDeckForPlayerCount(customRulesForSubmit, playerCount).deal)
      : false;
    const error =
      (ruleset === "custom" && !customRulesForSubmit
        ? presetSelected
          ? "预设规则尚未加载完成，请稍后重试或重新选择预设"
          : "请先点击“编辑规则”完成自定义规则后再创建"
        : undefined) ??
      (ruleset === "custom" && dealRequiredForSubmit !== null && playerCount !== dealRequiredForSubmit
        ? `该规则按 ${dealRequiredForSubmit} 个座位规定了初始发牌，玩家数量必须为 ${dealRequiredForSubmit}`
        : undefined) ??
      (modal.kind === "online"
        ? ruleset === "custom"
          ? (!customPresetIdForSubmit && (!Number.isInteger(playerCount) || playerCount < customPlayersMin || playerCount > customPlayersMax))
            ? `自定义模式玩家数量必须为 ${customPlayersMin}-${customPlayersMax}`
            : undefined
          : validateRoomCapacity(playerCount)
        : ruleset === "custom"
          ? !Number.isInteger(playerCount) || playerCount < customPlayersMin || playerCount > customPlayersMax
            ? `自定义模式玩家数量必须为 ${customPlayersMin}-${customPlayersMax}`
            : undefined
          : validateSetup(playerCount, botCount)) ??
      (ruleset === "custom"
        ? customRoomHandEditable
          ? validateCustomInitialHandSizeInput(initialHandSizeRaw, customRulesForSubmit ?? PLATFORM_PRESET, playerCount)
          : undefined
        : validateInitialHandSizeInput(initialHandSizeRaw, handSizeSeats)) ??
      (modal.kind === "online"
        ? ruleset === "custom"
          ? validateCustomBaseBet(baseBet, currentUser, customRulesForSubmit ?? PLATFORM_PRESET)
          : validateBaseBet(baseBet, currentUser, playerCount, initialHandSize)
        : undefined) ??
      (modal.kind === "online" ? validateRoomTimeLimitInput(turnTimeLimitRaw, "出牌时间") : undefined) ??
      (modal.kind === "online" ? validateRoomTimeLimitInput(openingExchangeTimeRaw, "换牌时间") : undefined) ??
      (modal.kind === "online" && roomCodeMode === "custom" && roomCode && !/^[1-9]\d{5}$/.test(roomCode)
        ? "自定义房间号必须是首位非 0 的六位数字"
        : undefined) ??
      (modal.kind === "online" && roomCodeMode === "reserved" && !(currentUser?.reservedRoomCodes ?? []).includes(roomCode)
        ? "请选择你已有的专属房间号"
        : undefined);
    if (error) {
      modal = { ...modal, ruleset, playerCount, botCount, baseBet, initialHandSize: initialHandSizeRaw, turnTimeLimit: turnTimeLimitRaw, openingExchangeTime: openingExchangeTimeRaw, roomCodeMode, roomCode, error };
      render();
      return;
    }
    if (modal.kind === "local") {
      const setupVersion = ++roomJoinVersion;
      if (currentUser) {
        const auth = await httpGet("/api/auth/me").catch(() => undefined);
        if (setupVersion !== roomJoinVersion) return;
        if (auth?.user) currentUser = auth.user;
      }
      const humans = createLocalHumans(playerCount);
      const bots = Array.from({ length: botCount }, (_, index) => ({
        nickname: `AI ${index + 1}`,
        bot: true,
      }));
      const preparedLocalRules = ruleset === "custom"
        ? parseCustomRules(customRulesSourceForRoom(customRulesForSubmit ?? PLATFORM_PRESET, playerCount, initialHandSize))
        : undefined;
      if (preparedLocalRules) {
        await prepareCustomRulesForPlay(preparedLocalRules);
        if (setupVersion !== roomJoinVersion) return;
      }
      const nextGame =
        preparedLocalRules
          ? createRulesetGame({
            mode: "local",
            rules: preparedLocalRules,
            players: humans,
            handSize: initialHandSize,
          })
          : createGame({
            mode: "local",
            players: [...humans, ...bots],
            handSize: initialHandSize,
          });
      beginGameContextSwitch();
      mode = "local";
      room = undefined;
      game = nextGame;
      prefetchGameWinMusic(game);
      startDealAnimation(game, true);
      modal = null;
      audio.play("start");
      render();
      return;
    }
    if (!currentUser) {
      modal = { kind: "auth", mode: "login", username: "", error: "请先登录后创建联机房间" };
      render();
      return;
    }
    const setupVersion = ++roomJoinVersion;
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        capacity: playerCount,
        baseBet,
        initialHandSize,
        turnTimeLimitSec: turnTimeLimitRaw === "" ? undefined : Number(turnTimeLimitRaw),
        openingExchangeSec: openingExchangeTimeRaw === "" ? undefined : Number(openingExchangeTimeRaw),
        roomCodeMode,
        roomCode: roomCode || undefined,
        rulesetMode: ruleset,
        customRules:
          ruleset === "custom" && !customPresetIdForSubmit && customRulesForSubmit
            ? rulesDraftFromResolved(customRulesForSubmit)
            : undefined,
        customPresetId: customPresetIdForSubmit,
      }),
    });
    if (setupVersion !== roomJoinVersion) return;
    const data = await res.json();
    if (setupVersion !== roomJoinVersion) return;
    if (!res.ok) {
      const duelCooldown = Number(data?.duelCooldownUntil ?? 0);
      if (duelCooldown > 0) duelCooldownUntil = duelCooldown;
      modal = { ...modal, ruleset, playerCount, botCount, baseBet, initialHandSize: initialHandSizeRaw, turnTimeLimit: turnTimeLimitRaw, openingExchangeTime: openingExchangeTimeRaw, roomCodeMode, roomCode, error: data.error ?? "创建房间失败" };
      render();
      return;
    }
    duelCooldownUntil = 0;
    if (data.existing) toast("已恢复该专属房间号对应的现有房间");
    await joinRoom(data.code, botCount);
    return;
  }
  if (modal.kind === "join") {
    const code = ((document.querySelector("#joinCode") as HTMLInputElement).value || "").trim();
    if (!/^\d+$/.test(code)) {
      modal = { ...modal, code, error: "房间号必须是纯数字" };
      render();
      return;
    }
    pendingOnlineBots = 0;
    modal = null;
    await joinRoom(code);
  }
}

async function joinRoom(code: string, botsToAdd = 0): Promise<void> {
  const joinVersion = ++roomJoinVersion;
  const res = await fetch(`/api/rooms/${code}/join`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ playerId: selfId || undefined }),
  });
  if (joinVersion !== roomJoinVersion) return;
  if (!res.ok) {
    toast((await res.json()).error ?? "加入失败");
    render();
    return;
  }
  const data = await res.json();
  if (joinVersion !== roomJoinVersion) return;
  const contextVersion = beginGameContextSwitch();
  selfId = data.playerId;
  localStorage.setItem("ionStormPlayerId", selfId);
  room = data.room;
  mode = "online";
  moveToRoomUrl(data.room?.code ?? code, Boolean(roomCodeFromLocation()));
  game = undefined;
  pendingOnlineBots = botsToAdd;
  modal = null;
  render();
  applyServerPayload(data);
  if (data.game?.status !== "ended") {
    startHeartbeat();
    startReconcilePolling(code);
  }
  connectSocket(code, contextVersion);
}

function connectSocket(code: string, contextVersion = gameContextVersion, preserveFallback = false): void {
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();
  if (!preserveFallback) {
    stopPolling();
    httpFallback = false;
  }
  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  let nextSocket: WebSocket;
  try {
    nextSocket = new WebSocket(`${wsProtocol}://${location.host}/ws?code=${encodeURIComponent(code)}`);
  } catch {
    startHttpFallback(code, contextVersion);
    scheduleSocketReconnect(code, contextVersion);
    return;
  }
  socket = nextSocket;
  if (websocketFallbackTimer) window.clearTimeout(websocketFallbackTimer);
  websocketFallbackTimer = window.setTimeout(() => {
    if (isOnlineContext(code, contextVersion) && nextSocket.readyState !== WebSocket.OPEN) startHttpFallback(code, contextVersion);
  }, 1800);
  nextSocket.onopen = () => {
    if (!isOnlineContext(code, contextVersion) || socket !== nextSocket) {
      nextSocket.close();
      return;
    }
    if (websocketFallbackTimer) window.clearTimeout(websocketFallbackTimer);
    if (websocketRetryTimer) window.clearTimeout(websocketRetryTimer);
    websocketRetryTimer = 0;
    stopPolling();
    httpFallback = false;
    startReconcilePolling(code, contextVersion);
    nextSocket.send(JSON.stringify({ type: "joinRoom", code, playerId: selfId, token: authToken || undefined }));
  };
  nextSocket.onmessage = (event) => {
    if (!isOnlineContext(code, contextVersion) || socket !== nextSocket) return;
    let msg: any;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    syncServerClock(msg.serverNow);
    if (msg.type === "joined") {
      selfId = msg.playerId;
      localStorage.setItem("ionStormPlayerId", selfId);
      applyServerPayload(msg);
      for (let i = 0; i < pendingOnlineBots; i++) {
        nextSocket.send(JSON.stringify({ type: "addBot", code, ownerId: selfId }));
      }
      pendingOnlineBots = 0;
    }
    if (msg.type === "gameStarted") {
      applyServerPayload(msg, { sound: true });
      nextSocket.send(JSON.stringify({ type: "gameStartedAck", code, playerId: selfId, gameId: msg.gameId }));
    }
    if (msg.type === "refreshStateResult") {
      if (msg.requestId === lastRefreshRequestId) {
        refreshPending = false;
      }
      applyServerPayload(msg, { sound: true });
      render();
    }
    if (msg.type === "roomState") applyServerPayload(msg);
    if (msg.type === "gameState") {
      applyServerPayload(msg, { sound: true });
    }
    if (msg.type === "leftRoom") leaveRemovedRoom("你已退出房间");
    if (msg.type === "duelDissolved") {
      toast("决斗房间已结束，请刷新查看终局");
      void manualRefreshState();
    }
    if (msg.type === "actionRejected") {
      resetModalActionSubmission();
      toast(msg.message);
      render();
    }
  };
  nextSocket.onerror = () => {
    if (isOnlineContext(code, contextVersion)) {
      startHttpFallback(code, contextVersion);
      scheduleSocketReconnect(code, contextVersion);
    }
  };
  nextSocket.onclose = () => {
    if (socket === nextSocket) socket = undefined;
    if (isOnlineContext(code, contextVersion) && game?.status !== "ended") {
      startHttpFallback(code, contextVersion);
      scheduleSocketReconnect(code, contextVersion);
    }
  };
}

function scheduleSocketReconnect(code: string, contextVersion = gameContextVersion): void {
  if (websocketRetryTimer || !isOnlineContext(code, contextVersion) || game?.status === "ended") return;
  websocketRetryTimer = window.setTimeout(() => {
    websocketRetryTimer = 0;
    if (!isOnlineContext(code, contextVersion) || game?.status === "ended") return;
    if (socket?.readyState === WebSocket.OPEN) return;
    connectSocket(code, contextVersion, true);
  }, WEBSOCKET_RETRY_INTERVAL_MS);
}

function startHttpFallback(code: string, contextVersion = gameContextVersion): void {
  if (httpFallback || !isOnlineContext(code, contextVersion) || game?.status === "ended") return;
  toast("WebSocket 不可用，已切换为 HTTP 兼容模式");
  ensureHttpPolling(code, contextVersion);
  scheduleSocketReconnect(code, contextVersion);
  if (pendingOnlineBots > 0) {
    const count = pendingOnlineBots;
    pendingOnlineBots = 0;
    for (let i = 0; i < count; i++) void httpPost(`/api/rooms/${code}/bots`, { ownerId: selfId });
  }
}

function ensureHttpPolling(code: string, contextVersion = gameContextVersion): void {
  if (!isOnlineContext(code, contextVersion)) return;
  httpFallback = true;
  stopReconcilePolling();
  if (pollInterval) return;
  void pollRoomState(code, contextVersion, true);
  pollInterval = window.setInterval(() => void pollRoomState(code, contextVersion), HTTP_FALLBACK_POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollInterval) window.clearInterval(pollInterval);
  pollInterval = 0;
}

function startHeartbeat(): void {
  if (heartbeatInterval) return;
  const code = room?.code;
  const contextVersion = gameContextVersion;
  if (!code || !isOnlineContext(code, contextVersion)) return;
  const heartbeat = () => {
    if (!isOnlineContext(code, contextVersion)) {
      stopHeartbeat();
      return;
    }
    if (game?.status === "ended") {
      stopHeartbeat();
      return;
    }
    if (socket?.readyState === WebSocket.OPEN && selfId) {
      socket.send(JSON.stringify({ type: "heartbeat", code, playerId: selfId }));
    }
  };
  heartbeat();
  heartbeatInterval = window.setInterval(heartbeat, WEBSOCKET_HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatInterval) window.clearInterval(heartbeatInterval);
  heartbeatInterval = 0;
}

function startReconcilePolling(code: string, contextVersion = gameContextVersion): void {
  stopReconcilePolling();
  if (httpFallback || !isOnlineContext(code, contextVersion)) return;
  reconcileInterval = window.setInterval(() => {
    if (isOnlineContext(code, contextVersion)) void pollRoomState(code, contextVersion);
  }, WEBSOCKET_RECONCILE_INTERVAL_MS);
}

function stopReconcilePolling(): void {
  if (reconcileInterval) window.clearInterval(reconcileInterval);
  reconcileInterval = 0;
}

function stopOnlineTimers(): void {
  stopPolling();
  stopReconcilePolling();
  stopHeartbeat();
  httpFallback = false;
  lastRoomStatePollAt = 0;
  lastPresenceSyncAt = 0;
  if (websocketFallbackTimer) window.clearTimeout(websocketFallbackTimer);
  websocketFallbackTimer = 0;
  if (websocketRetryTimer) window.clearTimeout(websocketRetryTimer);
  websocketRetryTimer = 0;
}

function beginGameContextSwitch(): number {
  gameContextVersion += 1;
  roomJoinVersion += 1;
  resetAdvancedAiState();
  stopOnlineTimers();
  if (timerInterval) window.clearInterval(timerInterval);
  timerInterval = 0;
  if (localBotTimer) window.clearTimeout(localBotTimer);
  localBotTimer = 0;
  localBotDeadline = 0;
  if (dealAnimationTimer) window.clearTimeout(dealAnimationTimer);
  dealAnimationTimer = 0;
  if (openingExchangeTimer) window.clearTimeout(openingExchangeTimer);
  openingExchangeTimer = 0;
  if (cardClickTimer) window.clearTimeout(cardClickTimer);
  cardClickTimer = 0;
  activeTouchCardDescriptionKey = "";
  if (modalActionSubmissionTimer) window.clearTimeout(modalActionSubmissionTimer);
  modalActionSubmissionTimer = 0;
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();
  activeWinMusic?.pause();
  activeWinMusic = undefined;
  if (activeWinMusicUrl) URL.revokeObjectURL(activeWinMusicUrl);
  activeWinMusicUrl = "";
  pendingOnlineBots = 0;
  serverClock = undefined;
  dismissedWinnerId = "";
  waitingForOnlineRematch = false;
  watchedSeatId = "";
  selectedCard = "all";
  selectedHandIndex = null;
  openingSelectionKey = "";
  openingExchangeSelection.clear();
  drawAnimations = [];
  animatedSeatIds.clear();
  animatedDrawCounts.clear();
  dealAnimationUntil = 0;
  landingAnimationUntil = 0;
  lastBotTurn = "";
  lastTickKey = "";
  lastRoomEditNoticeId = "";
  roomExitInFlight = false;
  refreshPending = false;
  lastRefreshRequestId = "";
  return gameContextVersion;
}

function isOnlineContext(code: string, version = gameContextVersion): boolean {
  return version === gameContextVersion && mode === "online" && room?.code === code;
}

function syncServerClock(serverNow: unknown): void {
  if (typeof serverNow !== "number") return;
  serverClock = { serverNow, clientNow: performance.now() };
}

async function pollRoomState(code: string, contextVersion = gameContextVersion, force = false): Promise<void> {
  if (!selfId || !isOnlineContext(code, contextVersion)) return;
  if (roomStatePollPromise) return roomStatePollPromise;
  const now = Date.now();
  const minimumDelay = document.hidden
    ? HTTP_POLL_HIDDEN_MIN_DELAY_MS
    : game?.status === "playing" || game?.status === "opening-exchange"
      ? HTTP_POLL_PLAYING_MIN_DELAY_MS
      : HTTP_POLL_LOBBY_MIN_DELAY_MS;
  if (!force && now - lastRoomStatePollAt < minimumDelay) return;
  lastRoomStatePollAt = now;
  const playerId = selfId;
  const includePresence = now - lastPresenceSyncAt >= HTTP_PRESENCE_SYNC_INTERVAL_MS;
  if (includePresence) lastPresenceSyncAt = now;
  let request!: Promise<void>;
  request = (async () => {
    try {
      const data = await httpGet(
        `/api/rooms/${code}/state?playerId=${encodeURIComponent(playerId)}${includePresence ? "&presence=1" : ""}`,
      );
      if (!isOnlineContext(code, contextVersion)) return;
      applyServerPayload(data);
    } catch (error) {
      if (includePresence) lastPresenceSyncAt = 0;
      if (
        isOnlineContext(code, contextVersion) &&
        error instanceof Error &&
        (error.message.includes("没有权限操作该席位") ||
          error.message.includes("席位不存在") ||
          error.message.includes("房间不存在或已回收"))
      ) {
        leaveRemovedRoom(error.message.includes("不存在") ? "决斗房间已自动解散" : undefined);
      }
      // Other failures retry on the next interval without noisy intranet toasts.
    } finally {
      if (roomStatePollPromise === request) roomStatePollPromise = undefined;
    }
  })();
  roomStatePollPromise = request;
  return request;
}

async function sendOnlineMessage(wsMessage: Record<string, unknown>, httpPath: string, body: Record<string, unknown>): Promise<void> {
  const code = room?.code;
  const contextVersion = gameContextVersion;
  if (!code || !isOnlineContext(code, contextVersion)) return;
  if (!httpFallback && socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(wsMessage));
      return;
    } catch {
      startHttpFallback(code, contextVersion);
    }
  }
  try {
    ensureHttpPolling(code, contextVersion);
    const data = await httpPost(httpPath, body);
    if (!isOnlineContext(code, contextVersion)) return;
    applyServerPayload(data, { sound: true });
  } catch (error) {
    if (!isOnlineContext(code, contextVersion)) return;
    if (error instanceof Error && error.message.includes("决斗房间已自动解散")) {
      leaveRemovedRoom("决斗房间已自动解散");
      return;
    }
    toast(error instanceof Error ? error.message : "请求失败");
  }
}

async function httpGet(path: string) {
  const res = await fetch(path, { headers: authHeaders(false) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "请求失败");
  return data;
}

async function httpPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? data.message ?? "请求失败");
  return data;
}

async function httpPatch(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? data.message ?? "请求失败");
  return data;
}

async function httpDelete(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "DELETE",
    headers: authHeaders(Boolean(body)),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? data.message ?? "请求失败");
  return data;
}

function authHeaders(json = true): HeadersInit {
  const headers: Record<string, string> = json ? { "content-type": "application/json" } : {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  headers["x-ion-device-id"] = deviceId;
  headers["x-ion-browser-fingerprint"] = browserFingerprint;
  return headers;
}

function ensureDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing && /^[A-Za-z0-9_-]{16,160}$/.test(existing)) return existing;
  const created =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(DEVICE_ID_KEY, created);
  return created;
}

function buildBrowserFingerprint(): string {
  const existing = /(?:^|;\s*)ionStormBrowserEnv=([A-Za-z0-9_-]{16,160})(?:;|$)/.exec(document.cookie)?.[1];
  if (existing) return existing;
  const created =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  document.cookie = `ionStormBrowserEnv=${created}; Max-Age=34560000; Path=/; SameSite=Strict`;
  return created;
}

function applyServerPayload(data: { room?: RoomSummary; game?: AnyGameState; message?: string; error?: string; serverNow?: number; duelDissolved?: boolean }, options: { sound?: boolean } = {}): void {
  if (data.duelDissolved) {
    toast("决斗房间已结束，请刷新查看终局");
  }
  if (data.room && (mode !== "online" || (room && room.code !== data.room.code))) return;
  if (data.room && room?.code === data.room.code && selfId && !data.room.players.some((player) => player.id === selfId)) {
    leaveRemovedRoom();
    return;
  }
  syncServerClock(data.serverNow);
  if (data.room) prefetchRoomCustomRules(data.room);
  let changed = false;
  if (data.room && (!room || roomRenderSignature(room) !== roomRenderSignature(data.room))) {
    room = data.room;
    showRoomEditNotice(data.room);
    changed = true;
  }
  if (
    data.game?.status === "ended" &&
    data.room?.status === "ended" &&
    data.room.players.some((player) => player.id === selfId && player.readyToStart)
  ) {
    waitingForOnlineRematch = true;
    if (game?.status === "ended") {
      game = undefined;
      changed = true;
    }
  }
  if (data.game && data.game.status !== "ended" && waitingForOnlineRematch) waitingForOnlineRematch = false;
  const shouldApplyGame = Boolean(
    data.game &&
    !(waitingForOnlineRematch && data.game.status === "ended") &&
    (!game ||
      game.id !== data.game.id ||
      (data.game.revision >= game.revision && gameRenderSignature(game) !== gameRenderSignature(data.game))),
  );
  if (data.game && shouldApplyGame) {
    const previous = game;
    const newGame = !previous || previous.id !== data.game.id;
    if (newGame) {
      dismissedWinnerId = "";
      watchedSeatId = "";
      selectedCard = "all";
      selectedHandIndex = null;
      openingSelectionKey = "";
      openingExchangeSelection.clear();
      drawAnimations = [];
      animatedSeatIds.clear();
      animatedDrawCounts.clear();
      lastBotTurn = "";
      if (modal?.kind === "actions") modal = null;
    } else if (data.game.status !== "ended") {
      watchedSeatId = "";
    }
    const drewCards = trackDrawAnimation(data.game);
    attachCustomRules(data.game);
    game = data.game;
    changed = true;
    if (mode === "online" && room) ensureCustomRulesLoaded(room.code, game);
    if (newGame) prefetchGameWinMusic(game);
    if (game.status === "ended") {
      const waitingForRematch = Boolean(room?.players.find((player) => player.id === selfId)?.readyToStart);
      if (waitingForRematch && room) startReconcilePolling(room.code);
      else stopOnlineTimers();
      void playWinnerMusic(game);
    }
    if (newGame && mode === "online" && room && game.status !== "ended") {
      startHeartbeat();
      startReconcilePolling(room.code);
    }
    if (options.sound) playStateSound(previous, data.game, drewCards);
    playCustomAudioEvents(game);
  }
  if (data.error || data.message) toast(data.error ?? data.message!);
  if (changed) render();
}

function roomRenderSignature(value: RoomSummary): string {
  const roomValue = value as RoomSummary & { createdAt?: number; lastActiveAt?: number };
  const { createdAt: _createdAt, lastActiveAt: _lastActiveAt, ...stable } = roomValue;
  return JSON.stringify(stable);
}

function gameRenderSignature(value: ClientGame): string {
  return JSON.stringify(value, (key, item) => (key === "lastSeenAt" ? undefined : item));
}

function leaveRemovedRoom(message?: string): void {
  const notice = message ?? (roomExitInFlight ? "你已退出房间" : "你已被房间创建者移出房间");
  beginGameContextSwitch();
  mode = "local";
  room = undefined;
  game = undefined;
  modal = null;
  dialog = null;
  selfId = "";
  localStorage.removeItem("ionStormPlayerId");
  if (roomCodeFromLocation()) history.replaceState({}, "", "/");
  toast(notice);
  render();
}

function showRoomEditNotice(nextRoom: RoomSummary): void {
  const notice = nextRoom.editNotice;
  if (!notice || notice.id === lastRoomEditNoticeId || !notice.recipientPlayerIds.includes(selfId)) return;
  lastRoomEditNoticeId = notice.id;
  dialog = { kind: "room-edit-notice", notice };
}

function applyReservedRoomCodes(userId: string, codes: unknown): string[] {
  const next = sortReservedRoomCodes(Array.isArray(codes) ? codes.filter((code): code is string => typeof code === "string") : []);
  reservedRoomCodesByUser.set(userId, next);
  if (currentUser?.id === userId) currentUser = { ...currentUser, reservedRoomCodes: next };
  const managed = managedUsers.find((user) => user.id === userId);
  if (managed) managed.reservedRoomCodes = next;
  return next;
}

async function loadReservedRoomCodes(userId: string): Promise<void> {
  try {
    const data = await httpGet(`/api/users/${encodeURIComponent(userId)}/reserved-room-codes`);
    const codes = applyReservedRoomCodes(userId, data.codes ?? data.reservedRoomCodes);
    if (dialog?.kind === "reserved-room-codes" && dialog.userId === userId) {
      dialog = { ...dialog, codes, error: undefined };
      render();
    }
  } catch (error) {
    if (dialog?.kind === "reserved-room-codes" && dialog.userId === userId) {
      dialog = { ...dialog, error: error instanceof Error ? error.message : "加载专属房间号失败" };
      render();
    }
  }
}

async function mutateReservedRoomCode(userId: string, request: () => Promise<unknown>): Promise<boolean> {
  try {
    const data = await request() as { codes?: unknown; reservedRoomCodes?: unknown };
    const codes = applyReservedRoomCodes(userId, data.codes ?? data.reservedRoomCodes);
    if (dialog?.kind === "reserved-room-codes" && dialog.userId === userId) {
      dialog = { ...dialog, codes, editingCode: undefined, error: undefined };
      render();
    }
    return true;
  } catch (error) {
    if (dialog?.kind === "reserved-room-codes" && dialog.userId === userId) {
      dialog = { ...dialog, error: error instanceof Error ? error.message : "操作失败" };
      render();
    }
    return false;
  }
}

async function addReservedRoomCode(userId: string): Promise<void> {
  const code = inputValue("reservedRoomCodeNew")?.trim() ?? "";
  if (!code) {
    if (dialog?.kind === "reserved-room-codes") {
      dialog = { ...dialog, error: "请输入专属房间号" };
      render();
    }
    return;
  }
  const added = await mutateReservedRoomCode(userId, () => httpPost(`/api/users/${encodeURIComponent(userId)}/reserved-room-codes`, { code }));
  if (added) {
    const input = document.getElementById("reservedRoomCodeNew");
    if (input instanceof HTMLInputElement) input.value = "";
  }
}

async function editReservedRoomCode(userId: string, oldCode: string): Promise<void> {
  const code = inputValue("reservedRoomCodeEdit")?.trim() ?? "";
  if (!code) return;
  await mutateReservedRoomCode(userId, () => httpPatch(`/api/users/${encodeURIComponent(userId)}/reserved-room-codes/${encodeURIComponent(oldCode)}`, { code }));
}

async function deleteReservedRoomCode(userId: string, code: string): Promise<void> {
  await mutateReservedRoomCode(userId, () => httpDelete(`/api/users/${encodeURIComponent(userId)}/reserved-room-codes/${encodeURIComponent(code)}`));
}

async function manualRefreshState(): Promise<void> {
  if (!room || !selfId || refreshPending) return;
  refreshPending = true;
  lastRefreshRequestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  render();
  try {
    const data = await httpGet(`/api/rooms/${room.code}/state?playerId=${encodeURIComponent(selfId)}&presence=1`);
    applyServerPayload(data, { sound: true });
    refreshPending = false;
    render();
  } catch (error) {
    refreshPending = false;
    toast(error instanceof Error ? error.message : "刷新失败");
    render();
  }
}

async function cancelOwnAutoplay(): Promise<void> {
  if (!room || !selfId) return;
  await sendOnlineMessage(
    { type: "cancelAutoplay", code: room.code, playerId: selfId },
    `/api/rooms/${room.code}/cancel-autoplay`,
    { playerId: selfId },
  );
}

async function submitBulkGrantPoints(): Promise<void> {
  if (dialog?.kind !== "bulk-grant-points") return;
  try {
    const targetUserIds = dialog.selectedUserIds ?? [];
    if (targetUserIds.length === 0) throw new Error("请选择用户");
    const distributionMode = (selectValue("bulkGrantMode") ?? "random") as "random" | "equal";
    const payload: Record<string, unknown> = { targetUserIds, distributionMode };
    if (distributionMode === "equal") {
      const perUserPoints = Number(inputValue("bulkGrantPerUserPoints"));
      if (!Number.isInteger(perUserPoints)) throw new Error("每个人得到的积分数必须是整数");
      payload.perUserPoints = perUserPoints;
    } else {
      const totalPoints = Number(inputValue("bulkGrantTotalPoints"));
      if (!Number.isInteger(totalPoints) || totalPoints < targetUserIds.length) throw new Error("发放总积分数必须是整数，且不能小于已选人数");
      payload.totalPoints = totalPoints;
    }
    await httpPost("/api/users/points/bulk", payload);
    dialog = null;
    toast("积分已发放");
    await loadUsersPage();
    if (location.pathname === "/activation") await loadActivationPage();
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "发放失败");
    render();
  }
}

async function saveRoomEditFromDialog(): Promise<void> {
  if (!room || dialog?.kind !== "edit-room") return;
  const capacity = Number((document.querySelector("#editRoomCapacity") as HTMLInputElement | null)?.value);
  const baseBet = Number((document.querySelector("#editRoomBaseBet") as HTMLInputElement | null)?.value);
  const initialHandSizeRaw = ((document.querySelector("#editRoomInitialHandSize") as HTMLInputElement | null)?.value ?? "").trim();
  const turnTimeLimitRaw = ((document.querySelector("#editRoomTurnTimeLimit") as HTMLInputElement | null)?.value ?? "").trim();
  const openingExchangeTimeRaw = ((document.querySelector("#editRoomOpeningExchangeTime") as HTMLInputElement | null)?.value ?? "").trim();
  const minimumCapacity = Math.max(2, room.players.length);
  const customMode = room.rulesetMode === "custom";
  if (customMode && !currentRoomCustomRules()) {
    dialog = { ...dialog, error: "自定义规则快照仍在加载，请稍后重试" };
    render();
    return;
  }
  if (!Number.isInteger(capacity) || capacity < minimumCapacity || capacity > 10) {
    dialog = { ...dialog, error: `总玩家数必须为 ${minimumCapacity}-10` };
    render();
    return;
  }
  const roomRules = customMode ? currentRoomCustomRules() : undefined;
  const customRoomHandEditable = roomRules ? !customDealHasAnyFill(customDeckForPlayerCount(roomRules, capacity).deal) : false;
  if (!customMode || customRoomHandEditable) {
    const initialHandSizeError = customMode && roomRules
      ? validateCustomInitialHandSizeInput(initialHandSizeRaw, roomRules, capacity)
      : validateInitialHandSizeInput(initialHandSizeRaw, capacity);
    if (initialHandSizeError) {
      dialog = { ...dialog, error: initialHandSizeError };
      render();
      return;
    }
  }
  const initialHandSize = customMode && !customRoomHandEditable ? null : initialHandSizeRaw === "" ? null : Number(initialHandSizeRaw);
  const baseBetError = customMode && roomRules
    ? validateCustomBaseBet(baseBet, currentUser, roomRules)
    : validateEditableBaseBet(baseBet, currentUser, capacity, initialHandSize ?? undefined);
  if (baseBetError) {
    dialog = { ...dialog, error: baseBetError };
    render();
    return;
  }
  const turnTimeLimitError = validateRoomTimeLimitInput(turnTimeLimitRaw, "出牌时间");
  if (turnTimeLimitError) {
    dialog = { ...dialog, error: turnTimeLimitError };
    render();
    return;
  }
  const openingExchangeTimeError = validateRoomTimeLimitInput(openingExchangeTimeRaw, "换牌时间");
  if (openingExchangeTimeError) {
    dialog = { ...dialog, error: openingExchangeTimeError };
    render();
    return;
  }
  const turnTimeLimitSec = turnTimeLimitRaw === "" ? null : Number(turnTimeLimitRaw);
  const openingExchangeSec = openingExchangeTimeRaw === "" ? null : Number(openingExchangeTimeRaw);
  await sendOnlineMessage(
    { type: "editRoom", code: room.code, playerId: selfId, capacity, baseBet, initialHandSize, turnTimeLimitSec, openingExchangeSec },
    `/api/rooms/${room.code}/edit`,
    { playerId: selfId, capacity, baseBet, initialHandSize, turnTimeLimitSec, openingExchangeSec },
  );
}

async function saveRulesEditorDraft(): Promise<void> {
  if (dialog?.kind !== "rules-editor") return;
  const state = dialog;
  let resolved: ResolvedCustomRules;
  try {
    resolved = resolvedFromDraft(state.draft);
  } catch (error) {
    dialog = { ...state, error: `规则校验失败：${error instanceof Error ? error.message : String(error)}` };
    render();
    return;
  }
  if (state.target === "create") {
    if (modal && (modal.kind === "local" || modal.kind === "online")) {
      modal = { ...modal, customRules: resolved };
    }
    dialog = null;
    toast("规则已保存，将用于创建新对局");
    render();
    return;
  }
  if (!room || room.rulesetMode !== "custom") return;
  // 21.3：保存后由服务器重新执行 parse → merge → validate → hash → freeze
  const draftPayload = JSON.parse(JSON.stringify(state.draft)) as Record<string, unknown>;
  const capacity = room.capacity;
  const baseBet = room.baseBet ?? 5;
  const code = room.code;
  const contextVersion = gameContextVersion;
  try {
    const data = await httpPost(`/api/rooms/${code}/edit`, {
      playerId: selfId,
      capacity,
      baseBet,
      initialHandSize: room.initialHandSize ?? null,
      customRules: draftPayload,
    });
    if (!isOnlineContext(code, contextVersion)) return;
    applyServerPayload(data, { sound: true });
    dialog = null;
    toast("规则已由服务器确认保存");
    render();
  } catch (error) {
    if (!isOnlineContext(code, contextVersion)) return;
    dialog = { ...state, error: error instanceof Error ? error.message : "规则保存失败" };
    render();
  }
}

async function exitOnlineRoom(): Promise<void> {
  if (!room || roomExitInFlight) return;
  const code = room.code;
  const contextVersion = gameContextVersion;
  roomExitInFlight = true;
  dialog = null;
  render();
  try {
    await httpPost(`/api/rooms/${code}/leave`, { playerId: selfId });
    if (isOnlineContext(code, contextVersion)) leaveRemovedRoom("你已退出房间");
  } catch (error) {
    if (!isOnlineContext(code, contextVersion)) return;
    roomExitInFlight = false;
    dialog = { kind: "leave-room", local: false, error: error instanceof Error ? error.message : "退出房间失败" };
    render();
  }
}

async function submit(action: RulesetAction | CustomActionIntent): Promise<void> {
  const isOpeningIntent =
    !isCustomLegalAction(action) &&
    ((action as ActionIntent).type === "opening-exchange" ||
      (action as ActionIntent).type === "opening-double" ||
      ((action as CustomActionIntent).type === "custom" &&
        ((action as CustomActionIntent).choiceId === "opening-exchange" || (action as CustomActionIntent).choiceId === "opening-double")));
  if (mode === "online" && room) {
    const intent = isCustomLegalAction(action) ? { type: "custom" as const, actionId: action.id } : action;
    const seat = isOpeningIntent ? openingExchangePlayer() : visibleSeat();
    if (!seat) return;
    if (seat.bot) {
      await sendOnlineMessage(
        { type: "botAction", code: room.code, ownerId: selfId, botId: seat.id, action: intent },
        `/api/rooms/${room.code}/action`,
        { playerId: seat.id, action: intent },
      );
    } else {
      await sendOnlineMessage(
        { type: "submitAction", code: room.code, playerId: seat.id, action: intent },
        `/api/rooms/${room.code}/action`,
        { playerId: seat.id, action: intent },
      );
    }
    selectedCard = "all";
    selectedHandIndex = null;
    return;
  }
  if (!game) return;
  const seat = isOpeningIntent ? openingExchangePlayer() : activeSeat();
  if (!seat) return;
  const previous = game;
  const result = applyRulesetAction(previous, seat.id, action);
  const drewCards = trackDrawAnimation(result.game);
  game = result.game;
  selectedCard = "all";
  selectedHandIndex = null;
  if (result.ok) playActionSound(action, drewCards);
  else toast(result.message);
  playCustomAudioEvents(game);
  if (result.ok && game.status === "ended" && previous.status !== "ended") void playWinnerMusic(game);
  render();
}

function maybeRunBot(): void {
  if (!game || game.status !== "playing" || isCustomGame(game)) return;
  const seat = activeSeat();
  if (!seat) return;
  const turnKey = `${game.id}:${game.revision}:${seat.id}:${game.turnStartedAt}:${game.actionPoints}`;
  if (lastBotTurn === turnKey) return;
  if (mode === "local" && seat.bot) {
    lastBotTurn = turnKey;
    if (localBotTimer) window.clearTimeout(localBotTimer);
    const contextVersion = gameContextVersion;
    const gameId = game.id;
    const seatId = seat.id;
    localBotDeadline = Date.now() + AUTOMATED_ACTION_DELAY_MS;
    renderTimer();
    localBotTimer = window.setTimeout(() => {
      localBotTimer = 0;
      localBotDeadline = 0;
      if (
        contextVersion !== gameContextVersion ||
        mode !== "local" ||
        !game ||
        isCustomGame(game) ||
        game.id !== gameId ||
        game.status !== "playing" ||
        activeSeat()?.id !== seatId ||
        !activeSeat()?.bot
      ) {
        return;
      }
      void submit(chooseBotAction(game as GameState, seatId));
    }, AUTOMATED_ACTION_DELAY_MS);
  }
}

function handleCardDoubleClick(card: CardId | "all", index?: number): void {
  if (!game || card === "all") return;
  const seat = visibleSeat();
  if (!seat || seat.bot || seat.id !== activeSeat()?.id) return;
  if (Number.isInteger(index)) {
    selectedCard = card;
    selectedHandIndex = index ?? null;
  }
  const actions = actionsForPlayer(seat.id).filter((action) => actionMatchesCard(action, card));
  if (actions.length === 0) {
    toast("这张牌当前没有合法操作");
    return;
  }
  if (actions.length === 1) {
    void submit(actions[0]);
    return;
  }
  modal = {
    kind: "actions",
    title: `${cardDisplayName(card)} 的合法操作`,
    titleHtml: `${formulaHtml(card)} 的合法操作`,
    actions: actionsForDisplay(seat.id, actions),
  };
  render();
}

function renderTimer(): void {
  window.clearInterval(timerInterval);
  const el = document.querySelector<HTMLDivElement>("#timer");
  if (!el) return;
  if (mode === "local") {
    const tickLocal = () => {
      const seat = game ? activeSeat() : undefined;
      const left = seat?.bot && localBotDeadline ? Math.max(0, localBotDeadline - Date.now()) : undefined;
      el.classList.remove("mine", "theirs");
      el.classList.toggle("danger", left !== undefined);
      el.classList.add("mine");
      const openingLabel = customRulesOf(game)?.setup.disableOpeningExchange === true ? "开局选择" : "开局换牌";
      el.innerHTML = `<strong>${left === undefined ? "--" : Math.ceil(left / 1000)}</strong><span>${game?.status === "opening-exchange" ? openingLabel : escapeHtml(seat?.nickname ?? "当前回合")}</span>`;
    };
    tickLocal();
    if (game?.status === "playing" && activeSeat()?.bot && localBotDeadline) {
      timerInterval = window.setInterval(tickLocal, 250);
    }
    return;
  }
  const tick = () => {
    if (game?.status === "ended") {
      el.classList.remove("mine", "theirs", "danger");
      el.innerHTML = `<strong>--</strong><span>游戏结束</span>`;
      return;
    }
    const seat = game ? activeSeat() : undefined;
    const now = mode === "online" && serverClock ? serverClock.serverNow + (performance.now() - serverClock.clientNow) : Date.now();
    const opening = game?.status === "opening-exchange";
    const limit = opening ? OPENING_EXCHANGE_MS : seat?.timeoutLimitMs;
    let left = opening && game?.openingExchange ? Math.max(0, game.openingExchange.deadlineAt - now) : game?.turnDeadlineAt ? Math.max(0, game.turnDeadlineAt - now) : undefined;
    if (mode === "online" && !serverClock && game?.turnDeadlineAt && limit) left = limit;
    if (left !== undefined && limit) left = Math.min(left, limit);
    const seconds = left === undefined ? "--" : Math.ceil(left / 1000).toString();
    const mine = mode !== "online" || !seat ? true : seat.id === selfId;
    el.classList.toggle("mine", mine);
    el.classList.toggle("theirs", !mine);
    el.classList.toggle("danger", left !== undefined && left <= 10_000);
    const timerLabel = opening
      ? customRulesOf(game)?.setup.disableOpeningExchange === true ? "开局选择" : "开局换牌"
      : seat ? (mine && mode === "online" ? "你的回合" : escapeHtml(seat.nickname)) : "当前回合";
    el.innerHTML = `<strong>${seconds}</strong><span>${timerLabel}</span>`;
    const tickKey = `${game?.id ?? "none"}:${game?.revision ?? 0}:${seat?.id ?? ""}:${seconds}`;
    if (mine && document.visibilityState === "visible" && left !== undefined && left <= 5_000 && tickKey !== lastTickKey) {
      lastTickKey = tickKey;
      audio.play("tick");
    }
  };
  tick();
  if (game?.status === "ended") return;
  timerInterval = window.setInterval(tick, 1000);
}

function visibleSeat() {
  if (!game) return undefined;
  if (game.status === "ended") {
    return game.players.find((p) => p.id === watchedSeatId) ?? game.players.find((p) => p.id === game?.winnerId) ?? game.players[0];
  }
  if (mode === "online") {
    const active = activeSeat();
    return game.players.find((p) => p.id === selfId && !p.bot) ?? active;
  }
  return activeSeat();
}

function syncDrawModal(): void {
  if ((!game?.pendingDraw && !game?.pendingChoice) || game.status !== "playing") {
    if (modal?.kind === "actions" && modal.drawPrompt) {
      modal = null;
      clearModalActionSubmissionTimer();
    }
    return;
  }
  const seat = visibleSeat();
  if (isCustomGame(game)) {
    if (!seat || seat.id !== activeSeat()?.id || seat.bot) {
      if (modal?.kind === "actions" && modal.drawPrompt) modal = null;
      clearModalActionSubmissionTimer();
      return;
    }
    const customActions = actionsForPlayer(seat.id).filter(
      (action) => isCustomLegalAction(action) && (isDrawResponse(action) || action.kind === "choice"),
    );
    if (customActions.length === 0) {
      if (modal?.kind === "actions" && modal.drawPrompt) modal = null;
      clearModalActionSubmissionTimer();
      return;
    }
    const submitting = modal?.kind === "actions" && modal.drawPrompt && modal.submitting && modal.stateRevision === game.revision;
    if (!submitting) clearModalActionSubmissionTimer();
    modal = {
      kind: "actions",
      title: game.pendingDraw ? "拿牌" : "请选择",
      titleHtml: game.pendingDraw
        ? `拿牌：${escapeHtml(game.pendingDraw.reason)} 剩余 ${game.pendingDraw.remaining} 张`
        : escapeHtml(game.pendingChoice?.prompt?.trim() || "请选择目标"),
      actions: customActions,
      forced: true,
      drawPrompt: true,
      submitting,
      stateRevision: game.revision,
    };
    return;
  }
  if (!seat || seat.id !== activeSeat()?.id || seat.bot) {
    if (modal?.kind === "actions" && modal.drawPrompt) modal = null;
    clearModalActionSubmissionTimer();
    return;
  }
  const classicPendingChoice = (game as GameState).pendingChoice;
  const actions = classicPendingChoice
    ? actionsForPlayer(seat.id).filter((action) =>
      !isCustomLegalAction(action) &&
      (classicPendingChoice.kind === "enough-selection" ? action.type === "resolve-enough" : action.type === "resolve-impurity"),
    )
    : actionsForPlayer(seat.id).filter(isDrawResponse);
  if (actions.length === 0) {
    if (modal?.kind === "actions" && modal.drawPrompt) modal = null;
    clearModalActionSubmissionTimer();
    return;
  }
  const submitting = modal?.kind === "actions" && modal.drawPrompt && modal.submitting && modal.stateRevision === game.revision;
  if (!submitting) clearModalActionSubmissionTimer();
  const choiceTitle =
    classicPendingChoice?.kind === "impurity-reaction"
      ? `杂质翻出 ${formulaHtml(classicPendingChoice.card)}，请选择反应目标`
      : classicPendingChoice?.kind === "enough-selection"
        ? "请选择要作为足量试剂放入溶液区的同种离子及数量"
        : `拿牌：${escapeHtml(game.pendingDraw!.reason)} 剩余 ${game.pendingDraw!.remaining} 张`;
  modal = {
    kind: "actions",
    title: classicPendingChoice?.kind === "enough-selection" ? "选择足量离子" : classicPendingChoice ? "选择反应目标" : "拿牌",
    titleHtml: choiceTitle,
    actions: actionsForDisplay(seat.id, actions),
    forced: true,
    drawPrompt: true,
    submitting,
    stateRevision: game.revision,
  };
}

function startModalActionSubmissionTimeout(stateRevision?: number): void {
  clearModalActionSubmissionTimer();
  modalActionSubmissionTimer = window.setTimeout(() => {
    modalActionSubmissionTimer = 0;
    if (modal?.kind !== "actions" || !modal.drawPrompt || !modal.submitting || modal.stateRevision !== stateRevision) return;
    modal = { ...modal, submitting: false };
    toast("选择提交尚未确认，请重试");
    render();
  }, 6_000);
}

function clearModalActionSubmissionTimer(): void {
  if (modalActionSubmissionTimer) window.clearTimeout(modalActionSubmissionTimer);
  modalActionSubmissionTimer = 0;
}

function resetModalActionSubmission(): void {
  clearModalActionSubmissionTimer();
  if (modal?.kind === "actions" && modal.drawPrompt && modal.submitting) modal = { ...modal, submitting: false };
}

function trackDrawAnimation(nextGame: ClientGame): boolean {
  const previous = game;
  const opening = !previous || previous.id !== nextGame.id;
  const seats = new Set<string>();
  const counts = new Map<string, number>();
  for (const nextPlayer of nextGame.players) {
    const before = previous?.players.find((player) => player.id === nextPlayer.id);
    const drawn = opening ? nextPlayer.hand.length : before ? nextPlayer.hand.length - before.hand.length : 0;
    if (drawn > 0) {
      seats.add(nextPlayer.id);
      counts.set(nextPlayer.id, drawn);
    }
  }
  if (seats.size > 0) startDealAnimation(nextGame, opening, seats, counts);
  return seats.size > 0;
}

function playActionSound(action: RulesetAction | CustomActionIntent, drewCards: boolean): void {
  if (isCustomLegalAction(action)) {
    if (drewCards || action.kind === "accept-draw" || action.kind === "counter") {
      audio.play("deal");
      return;
    }
    audio.play(action.kind === "play-ion" ? "react" : "click");
    return;
  }
  if ((action as CustomActionIntent).type === "custom") {
    audio.play(drewCards ? "deal" : "click");
    return;
  }
  const intent = action as ActionIntent;
  if (drewCards || intent.type === "accept-draw" || intent.type === "counter-draw") {
    audio.play("deal");
    return;
  }
  audio.play(intent.type === "play-ion" ? "react" : "click");
}

function playStateSound(previous: ClientGame | undefined, next: ClientGame, drewCards: boolean): void {
  const soundKey = `${next.id}:${next.revision}:${next.status}:${drewCards ? "draw" : "state"}`;
  if (soundKey === lastSoundKey) return;
  if (next.status === "ended" && previous?.status !== "ended") {
    lastSoundKey = soundKey;
    audio.play("win");
    return;
  }
  if (!previous || previous.id !== next.id) {
    lastSoundKey = soundKey;
    audio.play("start");
    return;
  }
  if (drewCards && next.revision !== previous.revision) {
    lastSoundKey = soundKey;
    audio.play("deal");
    return;
  }
  if (next.revision !== previous.revision) {
    lastSoundKey = soundKey;
    audio.play("click");
  }
}

const playedCustomAudioKeys = new Set<string>();
let playedCustomAudioGameId = "";

function playCustomAudioEvents(next: ClientGame): void {
  if (!isCustomGame(next)) return;
  const rules = customRulesOf(next);
  if (!rules) return;
  if (playedCustomAudioGameId !== next.id) {
    playedCustomAudioGameId = next.id;
    playedCustomAudioKeys.clear();
  }
  for (const event of next.custom.audioEvents) {
    const eventKey = `${event.id}:${event.cardId}:${event.audioKey}`;
    const batchKey = event.batchId ? `batch:${event.batchId}:${event.cardId}:${event.audioKey}` : "";
    if (playedCustomAudioKeys.has(eventKey) || (batchKey && playedCustomAudioKeys.has(batchKey))) continue;
    playedCustomAudioKeys.add(eventKey);
    if (batchKey) playedCustomAudioKeys.add(batchKey);
    // 定向音频：联机只播发给全体或自己的；本地同屏全部播放
    if (mode === "online" && event.to !== "all" && event.to !== selfId) continue;
    const src = rules.cards[event.cardId]?.audio?.[event.audioKey];
    if (!src) continue;
    try {
      const preloaded = customRuleAudioPreloads.get(rules.hash)?.get(src);
      const player = preloaded ? preloaded.cloneNode(true) as HTMLAudioElement : new Audio(src);
      void player.play().catch(() => undefined);
    } catch {
      // 音频数据不可用时静默跳过
    }
  }
}

function startDealAnimation(
  nextGame: ClientGame,
  opening = false,
  seats = new Set(nextGame.players.map((player) => player.id)),
  counts = new Map(nextGame.players.map((player) => [player.id, player.hand.length] as const)),
): void {
  if (dealAnimationTimer) window.clearTimeout(dealAnimationTimer);
  const contextVersion = gameContextVersion;
  const gameId = nextGame.id;
  animatedSeatIds = seats;
  animatedDrawCounts = new Map(counts);
  const duration = opening ? 3000 : 1400;
  dealAnimationUntil = Date.now() + duration;
  landingAnimationUntil = Date.now() + 760;
  const now = Date.now();
  drawAnimations.push(
    ...[...seats].map((seatId) => ({
      id: `${seatId}:${now}:${Math.random().toString(36).slice(2, 7)}`,
      seatId,
      count: counts.get(seatId) ?? 1,
      opening,
      startedAt: now,
      duration,
    })),
  );
  dealAnimationTimer = window.setTimeout(() => {
    dealAnimationTimer = 0;
    if (contextVersion === gameContextVersion && game?.id === gameId && Date.now() >= dealAnimationUntil) {
      animatedSeatIds.clear();
      animatedDrawCounts.clear();
      drawAnimations = drawAnimations.filter((animation) => Date.now() - animation.startedAt < animation.duration + 120);
      render();
    }
  }, duration + 40);
}

function isSeatAnimating(playerId: string): boolean {
  return animatedSeatIds.has(playerId) && Date.now() < dealAnimationUntil;
}

function isLandingAnimating(playerId: string): boolean {
  return animatedSeatIds.has(playerId) && Date.now() < landingAnimationUntil;
}

function actionsForPlayer(playerId: string): RulesetAction[] {
  if (!game) return [];
  if (isCustomGame(game)) return enumerateRulesetActions(game, playerId);
  return uniqueActions(enumerateActions(game as GameState, playerId));
}

function renderAdvancedAiButton(): string {
  if (!currentUser?.advancedAiAccess || !game || game.status === "ended" || isCustomGame(game)) return "";
  return `
    <div class="ai-advice-controls">
      ${advancedAiEnabled
      ? `<label class="ai-level-label"><span>推理强度</span><select id="advancedAiLevel" aria-label="AI 推理强度">
            ${(["none", "low", "medium", "high", "xhigh"] as AdvancedAiLevel[])
        .map(
          (level) =>
            `<option value="${level}" ${advancedAiLevel === level ? "selected" : ""}>${advancedAiLevelLabel(level)}</option>`,
        )
        .join("")}
          </select></label>`
      : ""}
      <button class="btn ai" data-act="toggle-ai-advice">${advancedAiEnabled ? "关闭AI建议" : "打开AI建议"}</button>
    </div>
  `;
}

function legalActionHeading(playerId?: string): string {
  const decision = advancedAiDecisionPlayer();
  if (!advancedAiEnabled || !playerId || decision?.id !== playerId) return "合法操作";
  if (advancedAiStatus === "computing") return "合法操作 · 计算中";
  if (advancedAiStatus === "complete" && currentAdvancedAiAction(playerId)) return "合法操作 · 计算完成";
  return "合法操作";
}

function actionsForDisplay(playerId: string, actions: RulesetAction[]): RulesetAction[] {
  if (!game || isCustomGame(game)) return actions;
  const classic = actions.filter((action): action is ActionIntent => !isCustomLegalAction(action));
  const suggested = currentAdvancedAiAction(playerId);
  return rankLegalActions(game as GameState, playerId, classic, suggested);
}

function isAdvancedAiSuggestedAction(action: RulesetAction, playerId?: string): boolean {
  if (isCustomLegalAction(action)) return false;
  const suggested = playerId ? currentAdvancedAiAction(playerId) : undefined;
  return Boolean(suggested && actionKey(suggested) === actionKey(action));
}

function currentAdvancedAiAction(playerId: string): ActionIntent | undefined {
  if (
    !advancedAiEnabled ||
    advancedAiStatus !== "complete" ||
    !game ||
    advancedAiSuggestion?.gameId !== game.id ||
    advancedAiSuggestion.revision !== game.revision ||
    advancedAiSuggestion.playerId !== playerId
  ) {
    return undefined;
  }
  return advancedAiSuggestion.action;
}

function effectiveAdvancedAiLevel(): AdvancedAiLevel {
  return advancedAiLevel;
}

function advancedAiDecisionPlayer() {
  if (!game || !currentUser?.advancedAiAccess || game.status === "ended" || isCustomGame(game)) return undefined;
  if (game.status === "opening-exchange") {
    const player = openingExchangePlayer();
    return player && !player.bot ? player : undefined;
  }
  if (game.status !== "playing") return undefined;
  const player = activeSeat();
  if (!player || player.bot || (mode === "online" && player.id !== selfId)) return undefined;
  return player;
}

function scheduleAdvancedAiCalculation(): void {
  if (!advancedAiEnabled || !currentUser?.advancedAiAccess || !game) return;
  const player = advancedAiDecisionPlayer();
  if (!player) {
    advancedAiStatus = "idle";
    advancedAiSuggestion = undefined;
    advancedAiCalculationKey = "";
    advancedAiWorker?.terminate();
    advancedAiWorker = undefined;
    return;
  }
  const level = effectiveAdvancedAiLevel();
  const key = `${game.id}:${game.revision}:${player.id}:${game.status}:${game.actionPoints}:${level}`;
  if (advancedAiCalculationKey === key) return;
  advancedAiCalculationKey = key;
  advancedAiStatus = "computing";
  advancedAiSuggestion = undefined;
  advancedAiWorker?.terminate();
  const worker = new Worker(new URL("./advancedAiWorker.ts", import.meta.url), { type: "module" });
  advancedAiWorker = worker;
  const requestId = ++advancedAiRequestId;
  const gameId = game.id;
  const revision = game.revision;
  worker.onmessage = (
    event: MessageEvent<{
      requestId: number;
      recommendation?: AdvancedAiRecommendation;
      error?: string;
    }>,
  ) => {
    if (
      requestId !== event.data.requestId ||
      requestId !== advancedAiRequestId ||
      !game ||
      game.id !== gameId ||
      game.revision !== revision ||
      advancedAiCalculationKey !== key
    ) {
      return;
    }
    advancedAiWorker = undefined;
    worker.terminate();
    if (!event.data.recommendation) {
      advancedAiStatus = "idle";
      if (event.data.error) toast(event.data.error);
      render();
      return;
    }
    advancedAiSuggestion = {
      gameId,
      revision,
      playerId: player.id,
      action: event.data.recommendation.action,
      recommendation: event.data.recommendation,
    };
    advancedAiStatus = "complete";
    render();
  };
  worker.onerror = () => {
    if (requestId !== advancedAiRequestId) return;
    advancedAiWorker = undefined;
    advancedAiStatus = "idle";
    worker.terminate();
    render();
  };
  worker.postMessage({
    game: structuredClone(game),
    playerId: player.id,
    requestId,
    options: { ...ADVANCED_AI_PRESETS[level], level, seed: game.rngSeed ^ game.revision },
  });
  render();
}

async function toggleAdvancedAiAdvice(): Promise<void> {
  if (advancedAiEnabled) {
    advancedAiEnabled = false;
    advancedAiStatus = "idle";
    advancedAiSuggestion = undefined;
    advancedAiCalculationKey = "";
    advancedAiRequestId += 1;
    advancedAiWorker?.terminate();
    advancedAiWorker = undefined;
    render();
    return;
  }
  try {
    const result = await httpPost("/api/advanced-ai/access", {});
    if (!result.allowed) throw new Error("请求失败");
    advancedAiEnabled = true;
    advancedAiCalculationKey = "";
    render();
  } catch {
    if (currentUser) delete currentUser.advancedAiAccess;
    advancedAiEnabled = false;
    render();
  }
}

function resetAdvancedAiState(): void {
  advancedAiEnabled = false;
  advancedAiStatus = "idle";
  advancedAiSuggestion = undefined;
  advancedAiCalculationKey = "";
  advancedAiRequestId += 1;
  advancedAiWorker?.terminate();
  advancedAiWorker = undefined;
}

function readAdvancedAiLevel(): AdvancedAiLevel {
  const saved = localStorage.getItem("ionStormAdvancedAiLevel");
  return isAdvancedAiLevel(saved) ? saved : "medium";
}

function isAdvancedAiLevel(value: unknown): value is AdvancedAiLevel {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function advancedAiLevelLabel(level: AdvancedAiLevel): string {
  return level;
}

function describeActionText(action: RulesetAction): string {
  if (isCustomLegalAction(action)) return action.description.replace(/\s+/g, " ").trim();
  return describeAction(action).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function isDrawResponse(action: RulesetAction): boolean {
  if (isCustomLegalAction(action)) return action.kind === "accept-draw" || action.kind === "counter" || action.kind === "follow";
  return action.type === "accept-draw" || action.type === "counter-draw" || action.type === "follow-function";
}

function uniqueActions(actions: ActionIntent[]): ActionIntent[] {
  const seen = new Set<string>();
  const result: ActionIntent[] = [];
  for (const action of actions) {
    const key = actionDedupeKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

function actionDedupeKey(action: ActionIntent): string {
  if (action.type === "play-ion" && action.targetId && game) {
    const outcome = simulatePlayIonOutcome(action);
    if (outcome) {
      const solution = [...outcome.zones.solution].sort().join(",");
      const products = outcome.zones.products
        .map((product) => `${product.kind}:${product.radiationLeft ?? ""}:${[...product.cards].sort().join(",")}`)
        .sort()
        .join("|");
      const discard = [...outcome.zones.discard].sort().join(",");
      return `${action.type}:${action.card}:${action.count}:${outcome.actionPoints}:${outcome.currentPlayer}:${outcome.status}:${solution}:${products}:${discard}`;
    }
  }
  return actionKey(action);
}

function actionKey(action: ActionIntent): string {
  if (action.type === "opening-exchange") return `opening-exchange:${action.discard.join(",")}`;
  if (action.type === "opening-double") return `opening-double:${action.enabled}`;
  if (action.type === "accept-draw") return "accept-draw";
  if (action.type === "counter-draw") return `counter-draw:${action.method}`;
  if (action.type === "play-ion") {
    const target = targetForAction(action);
    return target
      ? `${action.type}:${action.card}:${action.count}:${target.id}`
      : `${action.type}:${action.card}:${action.count}:solution`;
  }
  if (action.type === "play-special") return `${action.type}:${action.card}`;
  if (action.type === "play-function") return `${action.type}:${action.card}:${action.payload?.enoughCard ?? ""}:${action.payload?.enoughCount ?? ""}`;
  if (action.type === "follow-function") return `${action.type}:${action.card}`;
  if (action.type === "resolve-impurity") return `${action.type}:${action.targetId ?? ""}`;
  if (action.type === "resolve-enough") return `${action.type}:${action.card}:${action.count}`;
  return action.type;
}

function actionMatchesCard(action: RulesetAction, card: CardId | "all"): boolean {
  if (card === "all") return true;
  if (isCustomLegalAction(action)) return action.cardIds.includes(card);
  if (action.type === "play-ion" || action.type === "play-special" || action.type === "play-function") return action.card === card;
  if (action.type === "follow-function") return action.card === card;
  if (action.type === "counter-draw") return action.method === "AddSodium" ? card === "AddSodium" : card === "Acid" || card === "Alkali";
  return action.type === "wang-zha" && (card === "Acid" || card === "Alkali");
}

const functionCardEffectCache = new WeakMap<GameState, Map<string, { count: number; unit: "cards" | "groups" } | undefined>>();

function functionCardEffect(g: GameState, card: CardId): { count: number; unit: "cards" | "groups" } | undefined {
  let byCard = functionCardEffectCache.get(g);
  if (!byCard) {
    byCard = new Map();
    functionCardEffectCache.set(g, byCard);
  }
  if (!byCard.has(card)) byCard.set(card, previewFunctionCardEffect(g, card));
  return byCard.get(card);
}

function describeAction(action: RulesetAction): string {
  if (isCustomLegalAction(action)) return escapeHtml(action.description);
  if (action.type === "opening-exchange") return `开局换牌 ${action.discard.length} 张`;
  if (action.type === "opening-double") return action.enabled ? "开局加倍" : "开局不加倍";
  if (action.type === "accept-draw") {
    const pending = game?.pendingDraw;
    const count = pending ? Math.min(pending.perPlayerCap, pending.remaining) : "";
    return `摸牌 ${count}`;
  }
  if (action.type === "counter-draw") return action.method === "AddSodium" ? "加钠抵挡" : "王炸抵挡";
  if (action.type === "follow-function") return `跟出 ${formulaHtml(action.card)}，传递加牌效果`;
  if (action.type === "resolve-impurity") {
    const classicGame = game as GameState | undefined;
    const target = classicGame?.pendingChoice?.kind === "impurity-reaction"
      ? findReactionTargets(classicGame, classicGame.pendingChoice.card, 1).find((item) => item.id === action.targetId)
      : undefined;
    return target ? `杂质：${targetSourceHtml(target)} -> ${productKindName(target.kind)}` : "杂质：选择反应目标";
  }
  if (action.type === "resolve-enough") {
    const reactiveCount = game ? previewEnoughReactionCount(game as GameState, action.card) : 0;
    return `将 ${action.count} x ${formulaHtml(action.card)} 作为足量试剂放入溶液区，可与 ${reactiveCount} 张卡牌反应`;
  }
  if (action.type === "play-ion") {
    const target = targetForAction(action);
    if (target) {
      return describeIonReaction(action, target);
    }
    return `打出: ${action.count} x ${formulaHtml(action.card)} -> 溶液区`;
  }
  if (action.type === "play-special") return `打出 ${formulaHtml(action.card)}`;
  if (action.type === "play-function") {
    const effect = game ? functionCardEffect(game as GameState, action.card) : undefined;
    if (effect && effect.count > 0) {
      return `使用 ${formulaHtml(action.card)} 操作 ${effect.count} ${effect.unit === "groups" ? "组" : "张"}卡牌`;
    }
    return `使用 ${formulaHtml(action.card)}`;
  }
  if (action.type === "wang-zha") return "王炸";
  return "跳过";
}

const playIonOutcomeCache = new WeakMap<GameState, Map<string, GameState | null>>();

function simulatePlayIonOutcome(action: Extract<ActionIntent, { type: "play-ion" }>): GameState | undefined {
  if (!game || game.status !== "playing" || isCustomGame(game)) return undefined;
  const classicGame = game as GameState;
  let byAction = playIonOutcomeCache.get(classicGame);
  if (!byAction) {
    byAction = new Map();
    playIonOutcomeCache.set(classicGame, byAction);
  }
  const key = actionKey(action);
  if (!byAction.has(key)) {
    let outcome: GameState | null = null;
    try {
      const result = applyAction(classicGame, activeSeat()!.id, action);
      if (result.ok) outcome = result.game;
    } catch {
      outcome = null;
    }
    byAction.set(key, outcome);
  }
  return byAction.get(key) ?? undefined;
}

function multisetDiff(before: CardId[], after: CardId[]): CardId[] {
  const counts = new Map<CardId, number>();
  for (const card of after) counts.set(card, (counts.get(card) ?? 0) + 1);
  const result: CardId[] = [];
  for (const card of before) {
    const left = counts.get(card) ?? 0;
    if (left > 0) counts.set(card, left - 1);
    else result.push(card);
  }
  return result;
}

function describeIonReaction(action: Extract<ActionIntent, { type: "play-ion" }>, target: NonNullable<ReturnType<typeof targetForAction>>): string {
  const simulated = simulatePlayIonOutcome(action);
  if (!simulated || !game) return describeIonReactionClassic(action, target);
  const classicGame = game as GameState;
  const consumedSolution = multisetDiff(classicGame.zones.solution, simulated.zones.solution);
  const consumedProducts = classicGame.zones.products.filter((product) => !simulated.zones.products.some((item) => item.id === product.id));
  const newProducts = simulated.zones.products.filter((product) => !classicGame.zones.products.some((item) => item.id === product.id));
  const discarded = multisetDiff(simulated.zones.discard, classicGame.zones.discard);
  const leftover =
    simulated.zones.solution.filter((card) => card === action.card).length - classicGame.zones.solution.filter((card) => card === action.card).length;
  const leftParts = [`${action.count} x ${formulaHtml(action.card)}`];
  if (consumedSolution.length > 0) leftParts.push(`${formatIonList(consumedSolution)} (溶液区)`);
  for (const product of consumedProducts) leftParts.push(`${compoundFormulaFromCards(product.cards)} (生成物区)`);
  const rightParts: string[] = [];
  for (const product of newProducts) rightParts.push(`${compoundFormulaFromCards(product.cards)} (${productKindName(product.kind)})`);
  if (discarded.length > 0) rightParts.push(`${compoundFormulaFromCards(discarded)} (弃置)`);
  if (leftover > 0) rightParts.push(formatIonTerm(leftover, action.card));
  if (rightParts.length === 0) rightParts.push("溶液区");
  return `打出: ${leftParts.join(" + ")} -> ${rightParts.join(" + ")}`;
}

function describeIonReactionClassic(action: Extract<ActionIntent, { type: "play-ion" }>, target: NonNullable<ReturnType<typeof targetForAction>>): string {
  const existing = target.source === "solution" ? formatIonTerm(target.tableNeeded, target.tableCard) : existingProductHtml(target);
  const source = target.source === "solution" ? "溶液区" : `生成物${productIndex(target)}`;
  const product = compoundFormulaHtml([
    { card: target.playedCard, count: target.playedNeeded },
    { card: target.tableCard, count: target.tableNeeded },
  ]);
  const returned = returnedIonsHtml(action, target);
  return `打出: ${action.count} x ${formulaHtml(action.card)} + ${existing} (${source}) -> ${product} (${productKindName(target.kind)})${returned}`;
}

function targetForAction(action: ActionIntent) {
  if (!game || action.type !== "play-ion" || !action.targetId || isCustomGame(game)) return undefined;
  return findReactionTargets(game as GameState, action.card, action.count).find((target) => target.id === action.targetId);
}

function targetSourceHtml(target: NonNullable<ReturnType<typeof targetForAction>>): string {
  if (!game || target.source === "solution") return "溶液区";
  const index = game.zones.products.findIndex((product) => product.id === target.productId);
  const product = index >= 0 ? game.zones.products[index] : undefined;
  const title = product ? productTitleHtml(product) : "生成物";
  return `生成物区第 ${index + 1 || "?"} 组（${title}）`;
}

function targetSourceShort(target: NonNullable<ReturnType<typeof targetForAction>>): string {
  if (!game || target.source === "solution") return "溶液区";
  const index = game.zones.products.findIndex((product) => product.id === target.productId);
  return `生成物${index >= 0 ? index + 1 : "?"}`;
}

function productIndex(target: NonNullable<ReturnType<typeof targetForAction>>): string {
  if (!game) return "?";
  const index = game.zones.products.findIndex((product) => product.id === target.productId);
  return index >= 0 ? String(index + 1) : "?";
}

function existingProductHtml(target: NonNullable<ReturnType<typeof targetForAction>>): string {
  if (!game) return formulaHtml(target.tableCard);
  const product = game.zones.products.find((item) => item.id === target.productId);
  return product ? compoundFormulaFromCards(product.cards.map(cardIdOf)) : formulaHtml(target.tableCard);
}

function returnedIonsHtml(action: Extract<ActionIntent, { type: "play-ion" }>, target: NonNullable<ReturnType<typeof targetForAction>>): string {
  if (!game) return "";
  const returned: CardId[] = [];
  if (target.source === "product") {
    const product = game.zones.products.find((item) => item.id === target.productId);
    if (product) {
      const cards = product.cards.map(cardIdOf);
      removeCardsForDisplay(cards, target.tableCard, target.tableNeeded);
      returned.push(...cards);
    }
  }
  const usedFromHand = target.playedNeeded - (target.solutionPlayedNeeded ?? 0);
  if (action.count > usedFromHand) {
    returned.push(...Array(action.count - usedFromHand).fill(action.card));
  }
  if (returned.length === 0) return "";
  return ` + ${formatIonList(returned)}`;
}

function productTitleHtml(product: ClientGame["zones"]["products"][number]): string {
  const cards = product.cards.map(cardIdOf);
  if (product.kind === "special") return cards.map((card) => formulaHtml(card)).join(" + ");
  return `${compoundFormulaFromCards(cards)} (${productKindName(product.kind)})`;
}

function productKindName(kind: string): string {
  return ({ solid: "沉淀", gas: "气体", weak: "弱电解质", nonexistent: "不存在物", micro: "微溶物", special: "特殊物质" } as Record<string, string>)[kind] ?? "生成物";
}

function cardDisplayName(card: CardId): string {
  const customDef = customRulesOf(game)?.cards[card];
  if (customDef) return customDef.displayName;
  return LABELS[card] ?? card;
}

function formulaHtml(card: CardId): string {
  const customDef = customRulesOf(game)?.cards[card];
  if (customDef) return escapeHtml(customDef.displayName);
  return FORMULA_HTML[card] ?? escapeHtml(LABELS[card] ?? card);
}

function coloredIonStyle(card: CardId): string {
  const color = (
    {
      "Fe^{2+}": "#5F8A62",
      "Fe^{3+}": "#A64B2A",
      "Cu^{2+}": "#1677B8",
    } as Record<CardId, string>
  )[card];
  return color ? ` style="color:${color}"` : "";
}

function compoundFormulaFromCards(cards: CardId[]): string {
  const entries = Object.entries(
    cards.reduce<Record<CardId, number>>((acc, card) => {
      acc[card] = (acc[card] ?? 0) + 1;
      return acc;
    }, {}),
  ).map(([card, count]) => ({ card, count }));
  return compoundFormulaHtml(entries);
}

function formatIonTerm(count: number, card: CardId): string {
  return count > 1 ? `${count} x ${formulaHtml(card)}` : formulaHtml(card);
}

function formatIonList(cards: CardId[]): string {
  const counts = cards.reduce<Record<CardId, number>>((acc, card) => {
    acc[card] = (acc[card] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([card, count]) => formatIonTerm(count, card)).join(" + ");
}

function removeCardsForDisplay(cards: CardId[], card: CardId, count: number): void {
  for (let i = 0; i < count; i++) {
    const index = cards.indexOf(card);
    if (index >= 0) cards.splice(index, 1);
  }
}

function kindName(kind?: string): string {
  return ({ cation: "阳离子", anion: "阴离子", function: "操作牌", special: "特殊物质" } as Record<string, string>)[kind ?? ""] ?? "卡牌";
}

function roleLabel(role: UserRole): string {
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

async function refreshAuth(): Promise<void> {
  if (!authToken) return;
  try {
    const data = await httpGet("/api/auth/me");
    currentUser = data.user;
    if (currentUser && modal?.kind === "auth") modal = null;
    if (!currentUser) {
      authToken = "";
      localStorage.removeItem("ionStormAuthToken");
    }
    if (!currentUser?.advancedAiAccess) resetAdvancedAiState();
    if (currentUser) await refreshRequestNotifications();
  } catch {
    authToken = "";
    currentUser = undefined;
    localStorage.removeItem("ionStormAuthToken");
  }
  if (!currentUser && roomCodeFromLocation()) {
    modal = { kind: "auth", mode: "login", username: "", error: "请先登录后加入联机房间" };
    render();
    return;
  }
  if (currentUser && location.pathname === "/user") await loadUsersPage();
  else if (currentUser && location.pathname === "/invite") await loadInvitePage();
  else if (currentUser && location.pathname === "/activation") await loadActivationPage();
  else if (currentUser && location.pathname === "/ticket") await loadTicketPage();
  else if (currentUser && location.pathname === "/leaderboard") await loadLeaderboard();
  else {
    render();
    await joinRoomFromLocation();
  }
}

async function submitAuth(): Promise<void> {
  if (!modal || modal.kind !== "auth") return;
  const authMode = modal.mode;
  if (authMode === "register" && currentUser) {
    modal = null;
    render();
    return;
  }
  const username = authUsernameValue();
  const nickname = ((document.querySelector("#authNickname") as HTMLInputElement | null)?.value ?? username).trim();
  const inviteCode = ((document.querySelector("#authInviteCode") as HTMLInputElement | null)?.value ?? "").trim();
  const reservedRoomCode = ((document.querySelector("#authReservedRoomCode") as HTMLInputElement | null)?.value ?? "").trim();
  const password = (document.querySelector("#authPassword") as HTMLInputElement | null)?.value ?? "";
  if (authMode === "register" && !inviteCode) {
    modal = { ...modal, username, inviteCode, error: "注册必须填写邀请码" };
    render();
    return;
  }
  try {
    const data = await httpPost(`/api/auth/${authMode}`, { username, nickname, inviteCode, password, reservedRoomCode: reservedRoomCode || undefined });
    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem("ionStormAuthToken", authToken);
    localStorage.setItem("ionStormGuestOk", "1");
    await refreshRequestNotifications();
    modal = null;
    if (location.pathname === "/user") {
      await loadUsersPage();
      return;
    }
    if (location.pathname === "/invite") {
      await loadInvitePage();
      return;
    }
    if (location.pathname === "/activation") {
      await loadActivationPage();
      return;
    }
    if (location.pathname === "/ticket") {
      await loadTicketPage();
      return;
    }
    if (location.pathname === "/leaderboard") {
      await loadLeaderboard();
      return;
    }
    render();
    await joinRoomFromLocation();
  } catch (error) {
    modal = { kind: "auth", mode: authMode, username, inviteCode, reservedRoomCode, error: error instanceof Error ? error.message : "请求失败" };
    render();
  }
}

async function logout(): Promise<void> {
  try {
    await httpPost("/api/auth/logout", {});
  } catch {
    // Local logout still clears the browser token.
  }
  authToken = "";
  currentUser = undefined;
  resetAdvancedAiState();
  requestSeenThrough = 0;
  accountMenuOpen = false;
  dialog = null;
  localStorage.removeItem("ionStormAuthToken");
  const wasOnline = mode === "online";
  beginGameContextSwitch();
  if (wasOnline) {
    mode = "local";
    room = undefined;
    game = undefined;
  }
  if (location.pathname !== "/") history.pushState({}, "", "/");
  render();
}

async function openLeaderboard(): Promise<void> {
  if (!currentUser) {
    modal = { kind: "auth", mode: "login", username: "" };
    render();
    return;
  }
  if (location.pathname !== "/leaderboard") history.pushState({}, "", "/leaderboard");
  await loadLeaderboard();
}

async function loadLeaderboard(): Promise<void> {
  try {
    leaderboard = await httpGet("/api/leaderboard");
    leaderboardError = "";
  } catch (error) {
    leaderboard = undefined;
    leaderboardError = error instanceof Error ? error.message : "排行榜加载失败";
  }
  render();
}

async function openUserManagement(): Promise<void> {
  if (!currentUser) {
    modal = { kind: "auth", mode: "login", username: "" };
    render();
    return;
  }
  if (location.pathname !== "/user") history.pushState({}, "", "/user");
  await loadUsersPage();
}

async function loadUsersPage(): Promise<void> {
  try {
    const data = await httpGet("/api/users");
    managedUsers = data.users;
    userPageError = "";
  } catch (error) {
    managedUsers = currentUser ? [currentUser] : [];
    userPageError = error instanceof Error ? error.message : "加载失败";
  }
  render();
}

async function openInviteManagement(): Promise<void> {
  if (!currentUser) {
    modal = { kind: "auth", mode: "login", username: "" };
    render();
    return;
  }
  if (location.pathname !== "/invite") history.pushState({}, "", "/invite");
  await loadInvitePage();
}

async function loadInvitePage(): Promise<void> {
  try {
    const data = await httpGet("/api/invitations");
    invitations = data.invitations ?? [];
    invitePageError = "";
  } catch (error) {
    invitations = [];
    invitePageError = error instanceof Error ? error.message : "加载失败";
  }
  render();
}

async function openActivationManagement(): Promise<void> {
  if (!currentUser?.superAdmin) {
    toast("只有超级管理员可以访问激活码管理");
    return;
  }
  history.pushState({}, "", "/activation");
  await loadActivationPage();
}

async function loadActivationPage(): Promise<void> {
  try {
    const [data, userData] = await Promise.all([httpGet("/api/activations"), httpGet("/api/users").catch(() => undefined)]);
    activationCodes = data.activations ?? [];
    activationRegisteredUserCount = Number(data.registeredUserCount ?? 0);
    activationPageError = "";
    if (userData?.users) managedUsers = userData.users;
  } catch (error) {
    activationCodes = [];
    activationRegisteredUserCount = 0;
    activationPageError = error instanceof Error ? error.message : "加载失败";
  }
  render();
}

async function openTicketManagement(): Promise<void> {
  if (!currentUser) {
    modal = { kind: "auth", mode: "login", username: "" };
    render();
    return;
  }
  history.pushState({}, "", "/ticket");
  await loadTicketPage();
}

async function loadTicketPage(): Promise<void> {
  try {
    const [requestData, userData] = await Promise.all([httpGet("/api/requests"), httpGet("/api/users")]);
    requests = requestData.requests ?? [];
    requestSeenThrough = Number(requestData.seenThrough ?? 0);
    managedUsers = userData.users ?? [];
    ticketPageError = "";
    await acknowledgeRequestNotifications(false);
  } catch (error) {
    requests = [];
    ticketPageError = error instanceof Error ? error.message : "加载失败";
  }
  render();
}

async function refreshRequestNotifications(): Promise<void> {
  try {
    const data = await httpGet("/api/requests");
    requests = data.requests ?? [];
    requestSeenThrough = Number(data.seenThrough ?? 0);
  } catch {
    requests = [];
    requestSeenThrough = 0;
  }
}

async function acknowledgeRequestNotifications(shouldRender = true): Promise<void> {
  try {
    const through = requests.reduce(
      (maximum, request) => Math.max(maximum, request.createdAt, request.repliedAt ?? 0),
      requestSeenThrough,
    );
    if (through > requestSeenThrough) {
      const data = await httpPost("/api/requests/ack", { through });
      requestSeenThrough = Number(data.seenThrough ?? through);
    }
  } catch (error) {
    if (shouldRender) toast(error instanceof Error ? error.message : "更新提醒状态失败");
  }
  if (shouldRender) render();
}

async function openPermissionsDialog(): Promise<void> {
  try {
    permissionsSnapshot = await httpGet("/api/permissions");
    dialog = { kind: "permissions" };
  } catch (error) {
    dialog = { kind: "permissions", error: error instanceof Error ? error.message : "权限加载失败" };
  }
  render();
}

async function refreshCustomPresets(): Promise<void> {
  customPresetsSnapshot = (await httpGet("/api/custom-presets")).presets;
}

async function openCustomPresetsDialog(): Promise<void> {
  try {
    const [, limits] = await Promise.all([refreshCustomPresets(), httpGet("/api/custom-mode-limits")]);
    customModeLimitsSnapshot = limits as CustomModeLimits;
    dialog = { kind: "custom-presets" };
  } catch (error) {
    dialog = { kind: "custom-presets", error: error instanceof Error ? error.message : "预设加载失败" };
  }
  render();
}

async function saveCustomModeLimitsFromDialog(): Promise<void> {
  if (dialog?.kind !== "custom-presets") return;
  try {
    customModeLimitsSnapshot = (await httpPatch("/api/custom-mode-limits", customModeLimitsInput("globalCustomMode"))) as CustomModeLimits;
    dialog = { ...dialog, error: undefined };
  } catch (error) {
    dialog = { ...dialog, error: error instanceof Error ? error.message : "全局自定义模式设置保存失败" };
  }
  render();
}

function presetDialogError(message: string): void {
  if (dialog?.kind === "custom-presets") dialog = { ...dialog, error: message, previewResult: undefined };
  render();
}

async function savePresetFromDialog(): Promise<void> {
  if (dialog?.kind !== "custom-presets" || !dialog.form) return;
  const displayName = dialog.form.displayName.trim();
  if (!displayName) {
    presetDialogError("请填写预设名称");
    return;
  }
  let sourceDocument: unknown;
  try {
    sourceDocument = JSON.parse(dialog.form.source);
  } catch {
    presetDialogError("规则文档不是合法 JSON");
    return;
  }
  try {
    if (dialog.form.id) await httpPost(`/api/custom-presets/${dialog.form.id}`, { displayName, sourceDocument });
    else await httpPost("/api/custom-presets", { displayName, sourceDocument });
    await refreshCustomPresets();
    await loadEnabledCustomPresets(true);
    dialog = { kind: "custom-presets" };
  } catch (error) {
    presetDialogError(error instanceof Error ? error.message : "保存预设失败");
    return;
  }
  render();
}

async function previewPresetFromDialog(): Promise<void> {
  if (dialog?.kind !== "custom-presets" || !dialog.form) return;
  let sourceDocument: unknown;
  try {
    sourceDocument = JSON.parse(dialog.form.source);
  } catch {
    presetDialogError("规则文档不是合法 JSON");
    return;
  }
  try {
    const info = (await httpPost("/api/custom-presets/preview", { sourceDocument })) as { displayName: string; players: [number, number]; cardCount: number; deckSize: number };
    dialog = { ...dialog, error: undefined, previewResult: `校验通过：${info.displayName}｜人数 ${info.players[0]}-${info.players[1]}｜卡牌定义 ${info.cardCount}｜牌堆 ${info.deckSize} 张` };
  } catch (error) {
    dialog = { ...dialog, error: error instanceof Error ? error.message : "规则解析失败", previewResult: undefined };
  }
  render();
}

async function openTaxSettingsDialog(): Promise<void> {
  try {
    taxSettings = await httpGet("/api/tax-settings");
    dialog = { kind: "tax-settings" };
  } catch (error) {
    dialog = { kind: "tax-settings", error: error instanceof Error ? error.message : "税收设置加载失败" };
  }
  render();
}

async function saveTaxSettingsFromDialog(): Promise<void> {
  const value = Number(inputValue("globalTaxRatePercent"));
  if (!Number.isInteger(value) || value < -1 || value > 100) {
    setDialogError("最高征税比例必须是 -1 到 100 的整数");
    render();
    return;
  }
  const thresholdRaw = (inputValue("globalTaxWinnerPointsThreshold") ?? "").trim();
  let threshold: number | null = null;
  if (thresholdRaw !== "") {
    threshold = Number(thresholdRaw);
    if (!Number.isInteger(threshold)) {
      setDialogError("征税积分门槛必须是整数，或留空表示对全部用户征税");
      render();
      return;
    }
  }
  try {
    taxSettings = await httpPatch("/api/tax-settings", { taxRatePercent: value, taxWinnerPointsThreshold: thresholdRaw === "" ? null : threshold });
    dialog = null;
    toast("税收设置已保存");
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "税收设置保存失败");
  }
  render();
}

async function saveUserFromDialog(userId: string): Promise<void> {
  if (!userId) return;
  const original = managedUsers.find((user) => user.id === userId);
  if (!original) return;
  const patch: Record<string, unknown> = {};
  const nickname = inputValue("editNickname");
  const password = inputValue("editPassword");
  const title = inputValue("editTitle");
  const nicknameColor = inputValue("editNicknameColor");
  const points = inputValue("editPoints");
  if (nickname !== undefined && nickname.trim() !== original.nickname) patch.nickname = nickname.trim();
  if (password) patch.password = password;
  if (title !== undefined && title.trim() !== (original.title ?? "")) patch.title = title.trim() || null;
  if (nicknameColor !== undefined && nicknameColor.trim() !== original.nicknameColor) patch.nicknameColor = nicknameColor.trim() || null;
  if (points !== undefined && Number(points) !== original.points) patch.points = Number(points);
  const taxRateMode = selectValue("editTaxRateMode");
  if (taxRateMode === "default" && original.taxRatePercent !== undefined) patch.taxRatePercent = null;
  if (taxRateMode === "custom") {
    const taxRate = Number(inputValue("editTaxRatePercent"));
    if (!Number.isInteger(taxRate) || taxRate < -1 || taxRate > 100) {
      setDialogError("用户最高征税比例必须是 -1 到 100 的整数");
      render();
      return;
    }
    if (taxRate !== original.taxRatePercent) patch.taxRatePercent = taxRate;
  }
  const advancedAiMode = selectValue("editAdvancedAiMode");
  if (advancedAiMode) {
    const currentMode = original.advancedAiPermanent ? "permanent" : original.advancedAiExpiresAt ? "absolute" : "none";
    if (advancedAiMode === "none" && currentMode !== "none") {
      patch.advancedAiPermanent = false;
      patch.advancedAiExpiresAt = null;
    } else if (advancedAiMode === "permanent" && currentMode !== "permanent") {
      patch.advancedAiPermanent = true;
      patch.advancedAiExpiresAt = null;
    } else if (advancedAiMode === "absolute") {
      const expiresAt = inputValue("editAdvancedAiExpiresAt");
      if (!expiresAt) {
        setDialogError("请选择高级 AI 截止日期");
        render();
        return;
      }
      const isoLike = `${expiresAt}:00`;
      if (currentMode !== "absolute" || isoLike !== original.advancedAiExpiresAt) {
        patch.advancedAiPermanent = false;
        patch.advancedAiExpiresAt = isoLike;
      }
    }
  }
  try {
    addUserRoleGrantPatch(patch, original, "Admin");
    addUserRoleGrantPatch(patch, original, "Advanced");
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "身份期限设置不正确");
    render();
    return;
  }
  if (!document.getElementById("editAdvancedMode")) {
    addDatePatch(patch, "advancedExpiresAt", inputValue("editAdvancedExpiresAt"), original.advancedExpiresAt);
  }
  const permissionMode = selectValue("editPermissionMode");
  if (permissionMode === "default" && original.permissionOverride) patch.permissions = null;
  if (permissionMode === "custom") {
    const permissions = permissionInput("edit");
    if (JSON.stringify(permissions) !== JSON.stringify(original.permissionOverride)) patch.permissions = permissions;
    const expiryMode = selectValue("editPermissionExpiryMode") ?? "permanent";
    const currentPermanent = original.permissionOverridePermanent ?? true;
    const currentExpiresAt = original.permissionOverrideExpiresAt ?? "";
    if (expiryMode === "permanent") {
      if (!currentPermanent || patch.permissions !== undefined) patch.permissionsPermanent = true;
    } else if (expiryMode === "relative") {
      const amount = Number(inputValue("editPermissionExpiryDurationAmount") ?? "");
      const unit = selectValue("editPermissionExpiryDurationUnit") ?? "day";
      if (!Number.isInteger(amount) || amount <= 0) {
        setDialogError("权限覆盖相对时长必须是正整数");
        render();
        return;
      }
      patch.permissionsDurationMs = amount * (unit === "hour" ? 3600_000 : 86_400_000);
      patch.permissionsPermanent = false;
    } else {
      const until = inputValue("editPermissionExpiryExpiresAt");
      if (!until) {
        setDialogError("请选择权限覆盖截止时间");
        render();
        return;
      }
      const nextExpiresAt = `${until}:00`;
      if (nextExpiresAt !== currentExpiresAt || currentPermanent || patch.permissions !== undefined) {
        patch.permissionsExpiresAt = nextExpiresAt;
        patch.permissionsPermanent = false;
      }
    }
    if (patch.permissions === undefined && patch.permissionsPermanent === undefined && patch.permissionsDurationMs === undefined && patch.permissionsExpiresAt === undefined) {
      // 权限与期限均未变化
    }
  }
  const customModeLimitMode = selectValue("editCustomModeLimitMode");
  if (customModeLimitMode === "default" && original.customModeLimitOverride) patch.customModeLimits = null;
  if (customModeLimitMode === "custom") {
    const customModeLimits = customModeLimitsInput("editCustomMode");
    if (JSON.stringify(customModeLimits) !== JSON.stringify(original.customModeLimitOverride)) patch.customModeLimits = customModeLimits;
    const expiryMode = selectValue("editCustomModeLimitExpiryMode") ?? "permanent";
    const currentPermanent = original.customModeLimitOverridePermanent ?? true;
    const currentExpiresAt = original.customModeLimitOverrideExpiresAt ?? "";
    if (expiryMode === "permanent") {
      if (!currentPermanent || patch.customModeLimits !== undefined) patch.customModeLimitsPermanent = true;
    } else if (expiryMode === "relative") {
      const amount = Number(inputValue("editCustomModeLimitExpiryDurationAmount") ?? "");
      const unit = selectValue("editCustomModeLimitExpiryDurationUnit") ?? "day";
      if (!Number.isInteger(amount) || amount <= 0) {
        setDialogError("自定义模式额度相对时长必须是正整数");
        render();
        return;
      }
      patch.customModeLimitsDurationMs = amount * (unit === "hour" ? 3600_000 : 86_400_000);
      patch.customModeLimitsPermanent = false;
    } else {
      const until = inputValue("editCustomModeLimitExpiryExpiresAt");
      if (!until) {
        setDialogError("请选择自定义模式额度截止时间");
        render();
        return;
      }
      const nextExpiresAt = `${until}:00`;
      if (nextExpiresAt !== currentExpiresAt || currentPermanent || patch.customModeLimits !== undefined) {
        patch.customModeLimitsExpiresAt = nextExpiresAt;
        patch.customModeLimitsPermanent = false;
      }
    }
  }
  const nicknameChangeDisabled = selectValue("editNicknameChangeDisabled");
  if (nicknameChangeDisabled !== undefined && (nicknameChangeDisabled === "true") !== original.nicknameChangeDisabled) {
    patch.nicknameChangeDisabled = nicknameChangeDisabled === "true";
  }
  if (Object.keys(patch).length === 0) return;
  passwordConfirm = { action: { kind: "update-user", userId, patch } };
  render();
}

async function saveUserDisableFromDialog(userId: string): Promise<void> {
  if (!userId) return;
  const target = managedUsers.find((user) => user.id === userId);
  const selfSuperAdmin = Boolean(currentUser?.superAdmin && target?.id === currentUser.id);
  const scope = selfSuperAdmin ? "leaderboard" : currentUser?.superAdmin ? selectValue("banScope") ?? "account" : "account";
  const patch: Record<string, unknown> = {};
  if (scope === "leaderboard") {
    const mode = selectValue("banLeaderboardMode");
    const until = inputValue("banLeaderboardUntil");
    if (mode === "temporary" && !until) {
      setDialogError("请选择排行榜移除截止时间");
      render();
      return;
    }
    patch.disabledPermanent = false;
    patch.disabledUntil = null;
    patch.hideFromLeaderboardWhileDisabled = false;
    patch.leaderboardHiddenPermanent = mode === "permanent";
    patch.leaderboardHiddenUntil = mode === "temporary" ? `${until}:00` : null;
  } else {
    const mode = selectValue("banAccountMode");
    const until = inputValue("banAccountUntil");
    if (mode === "temporary" && !until) {
      setDialogError("请选择账号禁用截止时间");
      render();
      return;
    }
    patch.disabledPermanent = mode === "permanent";
    patch.disabledUntil = mode === "temporary" ? `${until}:00` : null;
    if (currentUser?.superAdmin) {
      patch.hideFromLeaderboardWhileDisabled = mode === "none" ? false : selectValue("banHideLeaderboard") === "true";
      patch.leaderboardHiddenPermanent = false;
      patch.leaderboardHiddenUntil = null;
    }
  }
  passwordConfirm = { action: { kind: "update-user", userId, patch } };
  render();
}

async function deleteUserFromDialog(userId: string): Promise<void> {
  if (!userId) return;
  passwordConfirm = { action: { kind: "delete-user", userId } };
  render();
}

async function downloadUsersCsv(): Promise<void> {
  if (!authToken) return;
  try {
    const response = await fetch("/api/users.csv", { headers: authHeaders(false) });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(error.error ?? "导出失败");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ion-storm-users.csv";
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    toast(error instanceof Error ? error.message : "导出失败");
  }
}

async function downloadSecurityLog(logId: string): Promise<void> {
  if (!logId || !currentUser?.superAdmin) return;
  try {
    const response = await fetch(`/api/security-logs/${encodeURIComponent(logId)}`, {
      headers: authHeaders(false),
    });
    if (!response.ok) throw new Error("安全日志下载失败");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `security-${logId.replace(/[^A-Za-z0-9_-]/g, "")}.ndjson`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    toast(error instanceof Error ? error.message : "安全日志下载失败");
  }
}

function exportGameLogCsv(): void {
  if (!game || game.status !== "ended") {
    toast("对局结束后才能导出日志");
    return;
  }
  const state = game;
  const roomCode = state.mode === "online" ? room?.code ?? "" : "";
  let csv: string;
  try {
    csv = buildGameLogCsv(state, roomCode);
  } catch (error) {
    toast(error instanceof Error ? error.message : "日志导出失败");
    return;
  }
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = gameLogFileName(state, roomCode);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function saveInviteFromDialog(existingCode?: string): Promise<void> {
  try {
    const usePolicy = (selectValue("inviteUsePolicy") ?? "unlimited") as "unlimited" | "global-total" | "global-window";
    const maxUses = Number(inputValue("inviteMaxUses") ?? 1);
    if (usePolicy !== "unlimited" && (!Number.isInteger(maxUses) || maxUses < 1)) {
      throw new Error("最多注册次数必须是正整数");
    }
    const role = selectValue("inviteRole") as UserRole;
    const adminGrant = invitationGrantInput("Admin", invitationRoleIncludes(role, "admin"));
    const advancedGrant = invitationGrantInput("Advanced", invitationRoleIncludes(role, "advanced"));
    const advancedAiGrant = advancedAiGrantInput("invite");
    const permissionMode = selectValue("invitePermissionMode");
    const expiresAtInput = inputValue("inviteExpiresAt");
    if (selectValue("inviteExpiryMode") === "absolute" && !expiresAtInput) throw new Error("请选择邀请码失效时间");
    const invitation = {
      code: existingCode || inputValue("inviteCode") || undefined,
      usePolicy,
      maxUses,
      windowMs: usePolicy === "global-window" ? Number(inputValue("inviteWindowDays") ?? 7) * 86_400_000 : null,
      expiresAt: selectValue("inviteExpiryMode") === "absolute" ? `${expiresAtInput}:00` : null,
      role,
      initialPoints: Number(inputValue("invitePoints") ?? 0),
      initialTitle: inputValue("inviteTitle")?.trim() || null,
      initialNicknameColor: inputValue("inviteNicknameColor")?.trim() || null,
      permissions: permissionMode === "custom" ? permissionInput("invite") : null,
      customModeLimits: selectValue("inviteCustomModeLimitMode") === "custom" ? customModeLimitsInput("inviteCustomMode", true) : null,
      reservedRoomCodeMode: (selectValue("inviteReservedRoomCodeMode") === "user-input" || selectValue("inviteReservedRoomCodeMode") === "random") ? selectValue("inviteReservedRoomCodeMode") : null,
      adminDurationMs: adminGrant.durationMs,
      advancedDurationMs: advancedGrant.durationMs,
      adminExpiresAt: adminGrant.expiresAt,
      advancedExpiresAt: advancedGrant.expiresAt,
      advancedAiDurationMs: advancedAiGrant.durationMs,
      advancedAiExpiresAt: advancedAiGrant.expiresAt,
      taxRatePercent: invitationTaxInput(),
    };
    await httpPost("/api/invitations", invitation);
    dialog = null;
    await loadInvitePage();
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "邀请码保存失败");
    render();
  }
}

async function saveActivationFromDialog(existingCode?: string): Promise<void> {
  try {
    const policy = selectValue("activationPolicy") as ActivationUsePolicy;
    const permissionsMode = selectValue("activationPermissionMode");
    const customModeLimitMode = selectValue("activationCustomModeLimitMode");
    const expiresAtInput = inputValue("activationExpiresAt");
    if (selectValue("activationExpiryMode") === "absolute" && !expiresAtInput) throw new Error("请选择激活码失效时间");
    const adminGrant = activationGrantInput("Admin");
    const advancedGrant = activationGrantInput("Advanced");
    const advancedAiGrant = advancedAiGrantInput("activation");
    const titleMode = selectValue("activationTitleMode") as ActivationTitleMode;
    const title = inputValue("activationTitle")?.trim();
    if (titleMode === "fixed" && !title) throw new Error("请输入固定头衔");
    const nicknameColorMode = selectValue("activationNicknameColorMode") as ActivationNicknameColorMode;
    const nicknameColor = inputValue("activationNicknameColor")?.trim();
    if (nicknameColorMode === "fixed" && !isHexColor(nicknameColor)) throw new Error("固定昵称颜色必须是 #RRGGBB");
    const activation = {
      code: existingCode || inputValue("activationCode") || undefined,
      usePolicy: policy,
      maxUses: Number(inputValue("activationMaxUses") ?? 1),
      windowMs:
        policy === "global-window" || policy === "per-user-window"
          ? Number(inputValue("activationWindowDays") ?? 7) * 86_400_000
          : null,
      expiresAt: selectValue("activationExpiryMode") === "absolute" ? `${expiresAtInput}:00` : null,
      points: Number(inputValue("activationPoints") ?? 0),
      requireNonNegativeBalance: selectValue("activationBalanceGuard") === "true",
      titleMode,
      title: titleMode === "fixed" ? title : null,
      nicknameColorMode,
      nicknameColor: nicknameColorMode === "fixed" ? nicknameColor : null,
      adminDurationMs: adminGrant.durationMs,
      adminExpiresAt: adminGrant.expiresAt,
      advancedDurationMs: advancedGrant.durationMs,
      advancedExpiresAt: advancedGrant.expiresAt,
      advancedAiDurationMs: advancedAiGrant.durationMs,
      advancedAiExpiresAt: advancedAiGrant.expiresAt,
      taxRatePercent: activationTaxInput(),
      permissionDurationMs: permissionsMode === "custom" ? null : false,
      permissions: permissionsMode === "custom" ? permissionInput("activation", { partial: true }) : null,
      customModeLimitDurationMs:
        customModeLimitMode !== "custom"
          ? false
          : selectValue("activationCustomModeLimitDurationMode") === "permanent"
            ? null
            : Number(inputValue("activationCustomModeLimitDurationAmount") ?? 7) *
            (selectValue("activationCustomModeLimitDurationUnit") === "hour" ? 3600_000 : 86_400_000),
      customModeLimits: customModeLimitMode === "custom" ? customModeLimitsInput("activationCustomMode", true) : null,
      reservedRoomCodeMode: (selectValue("activationReservedRoomCodeMode") === "user-input" || selectValue("activationReservedRoomCodeMode") === "random") ? selectValue("activationReservedRoomCodeMode") : null,
    };
    await httpPost("/api/activations", activation);
    dialog = null;
    await loadActivationPage();
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "激活码保存失败");
    render();
  }
}

async function savePointDistributionFromDialog(existingCode?: string): Promise<void> {
  try {
    const existing = existingCode ? activationCodes.find((item) => item.code === existingCode) : undefined;
    const locked = Boolean(existing?.redemptions.length);
    const maxUses = document.getElementById("pointDistributionMaxUses")
      ? Number(inputValue("pointDistributionMaxUses"))
      : existing?.maxUses ?? 0;
    const distributionMode = (selectValue("pointDistributionMode") ?? existing?.distributionMode ?? "random") as "random" | "equal";
    const totalPoints = locked
      ? existing?.totalPoints ?? 0
      : distributionMode === "equal"
        ? Number(inputValue("pointDistributionPerUserPoints")) * maxUses
        : Number(inputValue("pointDistributionTotalPoints"));
    const maximumUses = Math.max(1, activationRegisteredUserCount || managedUsers.length);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > maximumUses) {
      throw new Error(`领取人数必须是 1-${maximumUses} 的整数`);
    }
    if (!Number.isInteger(totalPoints) || totalPoints < maxUses) throw new Error("发放积分必须为整数，且总额不得小于领取人数");
    const expiresAtInput = inputValue("pointDistributionExpiresAt");
    if (selectValue("pointDistributionExpiryMode") === "absolute" && !expiresAtInput) throw new Error("请选择失效时间");
    await httpPost("/api/activations", {
      kind: "point-distribution",
      code: existingCode || inputValue("pointDistributionCode") || undefined,
      distributionMode,
      maxUses,
      totalPoints,
      expiresAt: selectValue("pointDistributionExpiryMode") === "absolute" ? `${expiresAtInput}:00` : null,
    });
    dialog = null;
    toast("激活码红包已保存");
    if (location.pathname === "/activation") await loadActivationPage();
    else render();
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "激活码红包保存失败");
    render();
  }
}

async function redeemActivationFromDialog(): Promise<void> {
  const code = inputValue("redeemActivationCode")?.trim();
  if (!code) return setDialogError("请输入激活码");
  try {
    const prepared = await httpPost("/api/activations/redeem/prepare", { code });
    const titleMode = prepared.titleMode as ActivationTitleMode;
    const nicknameColorMode = prepared.nicknameColorMode as ActivationNicknameColorMode;
    const reservedRoomCodeMode = prepared.reservedRoomCodeMode as "user-input" | "random" | undefined;
    if (titleMode === "user-custom" || nicknameColorMode === "user-custom" || reservedRoomCodeMode === "user-input") {
      dialog = { kind: "redeem-activation-custom", code, titleMode, nicknameColorMode, reservedRoomCodeMode };
      render();
      return;
    }
    await completeActivationRedemption(code);
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "兑换失败");
    render();
  }
}

async function redeemActivationWithCustomValues(): Promise<void> {
  if (!dialog || dialog.kind !== "redeem-activation-custom") return;
  const title = dialog.titleMode === "user-custom" ? inputValue("redeemActivationTitle")?.trim() : undefined;
  const nicknameColor =
    dialog.nicknameColorMode === "user-custom" ? inputValue("redeemActivationNicknameColor")?.trim() : undefined;
  const reservedRoomCode = dialog.reservedRoomCodeMode === "user-input" ? inputValue("redeemActivationReservedRoomCode")?.trim() : undefined;
  if (dialog.titleMode === "user-custom" && !title) {
    setDialogError("请输入自定义头衔");
    render();
    return;
  }
  if (dialog.nicknameColorMode === "user-custom" && !isHexColor(nicknameColor)) {
    setDialogError("自定义昵称颜色必须是 #RRGGBB");
    render();
    return;
  }
  if (dialog.reservedRoomCodeMode === "user-input" && (!reservedRoomCode || !/^\d{1,6}$/.test(reservedRoomCode))) {
    setDialogError("专属房间号必须为最多 6 位的数字");
    render();
    return;
  }
  try {
    await completeActivationRedemption(dialog.code, title, nicknameColor, reservedRoomCode);
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "兑换失败");
    render();
  }
}

async function completeActivationRedemption(code: string, customTitle?: string, customNicknameColor?: string, reservedRoomCode?: string): Promise<void> {
  const previousReservedRoomCodes = new Set(currentUser?.reservedRoomCodes ?? []);
  const data = await httpPost("/api/activations/redeem", { code, customTitle, customNicknameColor, reservedRoomCode });
  currentUser = data.user;
  const managedUserIndex = managedUsers.findIndex((user) => user.id === data.user.id);
  if (managedUserIndex >= 0) managedUsers[managedUserIndex] = data.user;
  dialog = null;
  const grantedReservedRoomCode = (data.user.reservedRoomCodes ?? []).find((item: string) => !previousReservedRoomCodes.has(item));
  toast(grantedReservedRoomCode ? `激活码兑换成功，已获得专属房间号 ${grantedReservedRoomCode}` : "激活码兑换成功");
  render();
}

async function deleteManagedCode(kind: "invite" | "activation", code: string): Promise<void> {
  if (!code) return;
  try {
    await httpDelete(`/api/${kind === "invite" ? "invitations" : "activations"}/${encodeURIComponent(code)}`);
    dialog = null;
    if (kind === "invite") await loadInvitePage();
    else await loadActivationPage();
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "删除失败");
    render();
  }
}

async function savePermissionsFromDialog(): Promise<void> {
  const role = selectValue("permRole") as UserRole;
  try {
    await httpPatch("/api/permissions", {
      role,
      permissions: permissionInput("perm"),
    });
    dialog = null;
    await refreshAuth();
    toast("权限已保存");
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "权限保存失败");
    render();
  }
}

async function submitRequestFromDialog(): Promise<void> {
  const kind = selectValue("requestKind") as "ticket" | "unban" | "nickname";
  const text = textAreaValue("requestText")?.trim();
  const requestedNickname = inputValue("requestNickname")?.trim();
  if (kind === "nickname" && !requestedNickname) return setDialogError("请输入新昵称");
  if (kind !== "nickname" && !text) return setDialogError("请输入内容");
  try {
    const data = await httpPost("/api/requests", {
      kind,
      text: kind === "nickname" ? undefined : text,
      requestedNickname: kind === "nickname" ? requestedNickname : undefined,
      privateToSuperAdmin: selectValue("requestPrivate") === "true",
    });
    if (data.request) requests = [data.request, ...requests.filter((request) => request.id !== data.request.id)];
    dialog = null;
    toast("申请已提交");
    render();
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "提交失败");
    render();
  }
}

async function submitTicketReview(requestId: string, forcedStatus?: UserRequestView["status"]): Promise<void> {
  if (!requestId) return;
  try {
    await httpPost(`/api/requests/${encodeURIComponent(requestId)}/respond`, {
      status: forcedStatus ?? selectValue("ticketStatus"),
      reply: forcedStatus === "ignored" ? undefined : textAreaValue("ticketReply")?.trim() || undefined,
    });
    dialog = null;
    await loadTicketPage();
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : "处理失败");
    render();
  }
}

async function uploadMusicByPicker(userId: string): Promise<void> {
  if (!userId) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*,video/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast("音乐文件不能超过 10MB");
      return;
    }
    const duration = await mediaDuration(file).catch(() => 0);
    if (!Number.isFinite(duration) || duration <= 0) {
      toast("浏览器无法读取该媒体格式或时长");
      return;
    }
    if (duration > 15.2) {
      toast("音乐长度不能超过 15 秒");
      return;
    }
    passwordConfirm = { action: { kind: "upload-music", userId, file, durationSeconds: duration } };
    render();
  };
  input.click();
}

async function executeProtectedAction(): Promise<void> {
  if (!passwordConfirm) return;
  const currentPassword = inputValue("confirmCurrentPassword");
  if (!currentPassword) {
    passwordConfirm = { ...passwordConfirm, error: "请输入当前密码" };
    render();
    return;
  }
  const action = passwordConfirm.action;
  try {
    if (action.kind === "update-user") {
      await httpPatch(`/api/users/${encodeURIComponent(action.userId)}`, { ...action.patch, currentPassword });
      await refreshAuth();
    } else if (action.kind === "delete-user") {
      await httpDelete(`/api/users/${encodeURIComponent(action.userId)}`, { currentPassword });
    } else if (action.kind === "upload-music") {
      const dataUrl = await fileToDataUrl(action.file);
      await httpPost(`/api/users/${encodeURIComponent(action.userId)}/music`, {
        fileName: action.file.name,
        mimeType: action.file.type,
        dataUrl,
        durationSeconds: action.durationSeconds,
        currentPassword,
      });
      await deleteCachedWinMusic(action.userId).catch(() => undefined);
      await ensureWinMusicCached([action.userId]).catch(() => undefined);
    } else {
      await httpDelete(`/api/users/${encodeURIComponent(action.userId)}/music`, { currentPassword });
      await deleteCachedWinMusic(action.userId).catch(() => undefined);
    }
    passwordConfirm = null;
    dialog = null;
    if (location.pathname === "/user") await loadUsersPage();
    else render();
    if (action.kind === "upload-music") toast("胜利音乐已上传");
    if (action.kind === "delete-music") toast("胜利音乐已删除");
  } catch (error) {
    passwordConfirm = { action, error: error instanceof Error ? error.message : "操作失败" };
    render();
  }
}

function mediaDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const mediaEl = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    mediaEl.preload = "metadata";
    mediaEl.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(mediaEl.duration);
    };
    mediaEl.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取音频时长"));
    };
    mediaEl.src = url;
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function playWinnerMusic(state: ClientGame): Promise<void> {
  if (lastWinMusicGameId === state.id) return;
  lastWinMusicGameId = state.id;
  const winner = state.players.find((player) => player.id === state.winnerId);
  if (!winner?.accountId) return;
  await winMusicPrefetches.get(state.id);
  await playCachedWinMusic(winner.accountId, false);
}

async function playUserMusic(userId: string, reportError: boolean): Promise<void> {
  if (!userId) return;
  try {
    await ensureWinMusicCached([userId]);
    await playCachedWinMusic(userId, true);
  } catch (error) {
    if (reportError) toast(error instanceof Error ? error.message : "胜利音乐播放失败");
  }
}

async function downloadUserMusic(userId: string): Promise<void> {
  if (!userId) return;
  try {
    const data = await httpGet(`/api/users/${encodeURIComponent(userId)}/music?purpose=download`);
    const music = data.music as { dataUrl?: string; fileName?: string } | undefined;
    if (!music?.dataUrl) throw new Error("音乐不存在");
    const anchor = document.createElement("a");
    anchor.href = music.dataUrl;
    anchor.download = music.fileName?.trim() || "victory-music";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } catch (error) {
    toast(error instanceof Error ? error.message : "胜利音乐下载失败");
  }
}

function prefetchGameWinMusic(state: ClientGame): void {
  if (winMusicPrefetches.has(state.id)) return;
  const accountIds = [...new Set(state.players.map((player) => player.accountId).filter((id): id is string => Boolean(id)))];
  const task = ensureWinMusicCached(accountIds).catch(() => undefined);
  winMusicPrefetches.set(state.id, task);
  if (winMusicPrefetches.size > 12) {
    const oldest = winMusicPrefetches.keys().next().value as string | undefined;
    if (oldest) winMusicPrefetches.delete(oldest);
  }
}

async function ensureWinMusicCached(userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)].slice(0, 10);
  if (ids.length === 0) return;
  if (!("caches" in window)) throw new Error("当前浏览器不支持胜利音乐持久缓存");
  if (!storagePersistenceRequested) {
    storagePersistenceRequested = true;
    void navigator.storage?.persist?.().catch(() => false);
  }
  const manifestData = await httpGet(`/api/music/manifest?ids=${ids.map(encodeURIComponent).join(",")}`);
  const manifests = new Map<string, WinMusicManifestEntry>(
    ((manifestData.music ?? []) as WinMusicManifestEntry[]).map((entry) => [entry.userId, entry]),
  );
  const cache = await caches.open(WIN_MUSIC_CACHE_NAME);
  await Promise.all(
    ids.map(async (userId) => {
      const manifest = manifests.get(userId);
      if (!manifest) {
        await cache.delete(winMusicCacheKey(userId));
        return;
      }
      const cached = await cache.match(winMusicCacheKey(userId));
      if (cached && (await responseMatchesMusicHashes(cached, manifest))) return;
      await cache.delete(winMusicCacheKey(userId));
      await downloadVerifiedWinMusic(cache, userId);
    }),
  );
}

async function downloadVerifiedWinMusic(cache: Cache, userId: string): Promise<void> {
  let lastError: Error = new Error("胜利音乐校验失败");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await httpGet(`/api/users/${encodeURIComponent(userId)}/music?download=${Date.now()}-${attempt}`);
      const music = data.music as {
        dataUrl?: string;
        mimeType?: string;
        sha1?: string;
        sha256?: string;
      };
      if (!music?.dataUrl || !music.sha1 || !music.sha256) throw new Error("胜利音乐数据不完整");
      const bytes = dataUrlToBytes(music.dataUrl);
      const hashes = await musicHashes(bytes);
      if (hashes.sha1 !== music.sha1 || hashes.sha256 !== music.sha256) throw new Error("胜利音乐下载校验失败");
      const body = musicArrayBuffer(bytes);
      await cache.put(
        winMusicCacheKey(userId),
        new Response(body, {
          headers: {
            "content-type": music.mimeType || "application/octet-stream",
            "x-ion-sha1": hashes.sha1,
            "x-ion-sha256": hashes.sha256,
          },
        }),
      );
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("胜利音乐下载校验失败");
    }
  }
  throw lastError;
}

async function responseMatchesMusicHashes(response: Response, expected: WinMusicManifestEntry): Promise<boolean> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hashes = await musicHashes(bytes);
  return hashes.sha1 === expected.sha1 && hashes.sha256 === expected.sha256;
}

async function musicHashes(bytes: Uint8Array): Promise<{ sha1: string; sha256: string }> {
  const body = musicArrayBuffer(bytes);
  const [sha1, sha256] = await Promise.all([crypto.subtle.digest("SHA-1", body), crypto.subtle.digest("SHA-256", body)]);
  return { sha1: hexDigest(sha1), sha256: hexDigest(sha256) };
}

function musicArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function hexDigest(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("胜利音乐数据格式错误");
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (!meta.includes(";base64")) return new TextEncoder().encode(decodeURIComponent(payload));
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function playCachedWinMusic(userId: string, throwWhenMissing: boolean): Promise<void> {
  try {
    const cache = await caches.open(WIN_MUSIC_CACHE_NAME);
    const response = await cache.match(winMusicCacheKey(userId));
    if (!response) throw new Error("该用户没有可播放的胜利音乐");
    const url = URL.createObjectURL(await response.blob());
    activeWinMusic?.pause();
    if (activeWinMusicUrl) URL.revokeObjectURL(activeWinMusicUrl);
    const player = new Audio(url);
    player.volume = 0.75;
    player.onended = () => {
      if (activeWinMusicUrl === url) {
        URL.revokeObjectURL(url);
        activeWinMusicUrl = "";
      }
    };
    activeWinMusic = player;
    activeWinMusicUrl = url;
    await player.play();
  } catch (error) {
    if (throwWhenMissing) throw error;
  }
}

function winMusicCacheKey(userId: string): Request {
  return new Request(`${location.origin}/__ion-storm_win_music__/${encodeURIComponent(userId)}`);
}

async function deleteCachedWinMusic(userId: string): Promise<void> {
  if (!("caches" in window)) return;
  const cache = await caches.open(WIN_MUSIC_CACHE_NAME);
  await cache.delete(winMusicCacheKey(userId));
}

function createLocalHumans(count: number): Array<{ nickname: string; accountId?: string; profile?: PlayerProfile; canOpeningExchange?: boolean }> {
  const humans: Array<{ nickname: string; accountId?: string; profile?: PlayerProfile; canOpeningExchange?: boolean }> = [];
  if (currentUser) {
    const profile = userProfile(currentUser);
    humans.push({ nickname: currentUser.nickname, accountId: currentUser.id, profile, canOpeningExchange: true });
  }
  while (humans.length < count) {
    const guestIndex = currentUser ? humans.length - 1 : humans.length;
    const nickname = guestIndex === 0 ? "未登录用户" : `未登录用户${guestIndex}`;
    humans.push({
      nickname,
      profile: {
        username: nickname,
        nickname,
        role: "normal",
        color: "#000000",
        nicknameColor: "#000000",
        permissions: { exchangeMin: 0, exchangeMax: 3, canCreateZeroBaseBet: false, maxBaseBet: 100 },
        hasAdvancedPerk: false,
        guest: true,
      },
      canOpeningExchange: true,
    });
  }
  return humans;
}

function userProfile(user: PublicUser): PlayerProfile {
  return {
    accountId: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    color: user.color,
    nicknameColor: user.nicknameColor,
    permissions: user.permissions,
    title: user.title,
    subtitle: user.subtitle,
    hasAdvancedPerk: user.hasAdvancedPerk,
    points: user.points,
  };
}

function openingExchangePlayer() {
  if (!game || game.status !== "opening-exchange" || !game.openingExchange) return undefined;
  const eligible = new Set(game.openingExchange.eligiblePlayerIds);
  const exchangeCompleted = new Set(game.openingExchange.completedPlayerIds);
  const doubleCompleted = new Set(game.openingExchange.doubleCompletedPlayerIds ?? []);
  const hasPendingDecision = (playerId: string) => !exchangeCompleted.has(playerId) || !doubleCompleted.has(playerId);
  if (mode === "online") {
    const mine = game.players.find((player) => player.id === selfId && eligible.has(player.id) && hasPendingDecision(player.id));
    return mine;
  }
  return game.players.find((player) => eligible.has(player.id) && hasPendingDecision(player.id));
}

function shouldHideCompletedOnlineOpeningExchangeModal(): boolean {
  if (!game || game.status !== "opening-exchange" || !game.openingExchange || mode !== "online") return false;
  const mine = game.players.find((player) => player.id === selfId);
  if (!mine) return false;
  const opening = game.openingExchange;
  return (
    opening.eligiblePlayerIds.includes(mine.id) &&
    opening.completedPlayerIds.includes(mine.id) &&
    (opening.doubleCompletedPlayerIds ?? []).includes(mine.id)
  );
}

function openingAiSuggestedDiscardIndices(seat: { hand: readonly (CardId | CardInstance)[] }, action?: ActionIntent): Set<number> {
  if (!action || action.type !== "opening-exchange") return new Set<number>();
  const remaining = action.discard.reduce<Map<CardId, number>>((counts, card) => {
    counts.set(card, (counts.get(card) ?? 0) + 1);
    return counts;
  }, new Map<CardId, number>());
  const indices = new Set<number>();
  seat.hand.forEach((entry, index) => {
    const card = cardIdOf(entry);
    const count = remaining.get(card) ?? 0;
    if (count <= 0) return;
    indices.add(index);
    if (count === 1) remaining.delete(card);
    else remaining.set(card, count - 1);
  });
  return indices;
}

async function submitOpeningExchange(indices: number[]): Promise<void> {
  const seat = openingExchangePlayer();
  if (!game || !seat) return;
  if (isCustomGame(game)) {
    const cardInstanceIds = indices
      .map((index) => seat.hand[index])
      .filter((entry): entry is CardInstance => typeof entry === "object" && entry !== null)
      .map((entry) => entry.instanceId);
    openingExchangeSelection.clear();
    await submit({ type: "custom", choiceId: "opening-exchange", cardInstanceIds });
    return;
  }
  const discard = indices.map((index) => cardIdOf(seat.hand[index])).filter(Boolean);
  openingExchangeSelection.clear();
  await submit({ type: "opening-exchange", discard });
}

function scheduleLocalOpeningExchange(): void {
  if (openingExchangeTimer) window.clearTimeout(openingExchangeTimer);
  openingExchangeTimer = 0;
}

function renderPlayerName(player: { nickname: string; profile?: PlayerProfile }): string {
  const color = player.profile?.nicknameColor ?? player.profile?.color ?? "#000000";
  const name = player.profile?.nickname ?? player.nickname;
  const username = player.profile?.username;
  return `<strong class="user-name" style="color:${escapeAttr(color)}">${escapeHtml(name)}</strong>${username ? `<br><small class="username-tag">@${escapeHtml(username)}</small>` : ""}`;
}

function authUsernameValue(): string {
  return ((document.querySelector("#authUsername") as HTMLInputElement | null)?.value ?? "").trim();
}

function fieldValue(row: HTMLElement, field: string): string | undefined {
  const input = row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-user-field="${field}"]`);
  return input?.value;
}

function inputValue(id: string): string | undefined {
  return (document.getElementById(id) as HTMLInputElement | null)?.value;
}

function selectValue(id: string): string | undefined {
  return (document.getElementById(id) as HTMLSelectElement | null)?.value;
}

function textAreaValue(id: string): string | undefined {
  return (document.getElementById(id) as HTMLTextAreaElement | null)?.value;
}

function setDialogError(error: string): void {
  if (!dialog) return;
  dialog = { ...dialog, error } as DialogState;
}

function addBoolPatch(patch: Record<string, unknown>, field: "adminPermanent" | "advancedPermanent", value: string | undefined, original: boolean): void {
  if (value !== undefined && (value === "true") !== original) patch[field] = value === "true";
}

function addDatePatch(patch: Record<string, unknown>, field: "adminExpiresAt" | "advancedExpiresAt", value: string | undefined, original?: string): void {
  if (value === undefined) return;
  const next = value ? `${value}:00` : null;
  const current = original ? `${toLocalDateTime(original)}:00` : null;
  if (next !== current) patch[field] = next;
}

function addUserRoleGrantPatch(
  patch: Record<string, unknown>,
  user: PublicUser,
  id: "Admin" | "Advanced",
): void {
  const mode = selectValue(`edit${id}Mode`);
  if (mode === undefined) return;
  const permanentField = id === "Admin" ? "adminPermanent" : "advancedPermanent";
  const expiryField = id === "Admin" ? "adminExpiresAt" : "advancedExpiresAt";
  const originalPermanent = id === "Admin" ? user.adminPermanent : user.advancedPermanent;
  const originalExpiry = id === "Admin" ? user.adminExpiresAt : user.advancedExpiresAt;
  const permanent = mode === "permanent";
  const expiresAt = mode === "absolute" ? inputValue(`edit${id}ExpiresAt`) : "";
  if (mode === "absolute" && !expiresAt) throw new Error(`请选择${id === "Admin" ? "管理员" : "高级用户"}截止时间`);
  if (permanent !== originalPermanent) patch[permanentField] = permanent;
  const nextExpiry = expiresAt ? `${expiresAt}:00` : null;
  const currentExpiry = originalExpiry ? `${toLocalDateTime(originalExpiry)}:00` : null;
  if (nextExpiry !== currentExpiry) patch[expiryField] = nextExpiry;
}

function permissionInput(prefix: string, options: { partial?: boolean } = {}): Partial<PermissionRule> {
  const partial = Boolean(options.partial);
  const result: Partial<PermissionRule> = { exchangeMin: 0 };
  const exchangeMode = selectValue(`${prefix}ExchangeMaxMode`);
  if (!partial || exchangeMode !== "default") {
    const exchangeMax = Number(selectValue(`${prefix}ExchangeMax`));
    result.exchangeMax = exchangeMax < 0 ? null : exchangeMax;
  }
  const zeroBet = selectValue(`${prefix}ZeroBet`);
  if (!partial || zeroBet !== "default") {
    result.canCreateZeroBaseBet = zeroBet === "true";
  }
  const maxBaseBetMode = selectValue(`${prefix}MaxBaseBetMode`);
  if (!partial || maxBaseBetMode !== "default") {
    result.maxBaseBet = inputValue(`${prefix}MaxBaseBet`)?.trim() ? Number(inputValue(`${prefix}MaxBaseBet`)) : null;
  }
  const duelLimit = duelLimitInput(prefix, partial);
  if (duelLimit !== undefined) result.duelLimit = duelLimit;
  return result;
}

function customModeLimitsInput(prefix: string, partial = false): CustomModeLimitGrant {
  const maxBaseBet = customLimitInput(prefix, "customMaxBaseBet", partial) as CustomMaxBaseBetRule | undefined;
  const settlementCap = customLimitInput(prefix, "customSettlementCap", partial) as CustomSettlementCapRule | undefined;
  return {
    ...(maxBaseBet ? { maxBaseBet } : {}),
    ...(settlementCap ? { settlementCap } : {}),
  };
}

function customLimitInput(prefix: string, kind: CustomLimitKind, partial: boolean): CustomMaxBaseBetRule | CustomSettlementCapRule | undefined {
  const inputId = `${prefix}${kind === "customMaxBaseBet" ? "CustomMaxBet" : "CustomCap"}`;
  const mode = selectValue(`${inputId}Mode`);
  if (partial && (!mode || mode === "default")) return undefined;
  const cleanMode = mode ?? "unlimited";
  if (cleanMode === "unlimited") return { mode: "unlimited" };
  const value = Number(inputValue(`${inputId}Value`) ?? "");
  if (!Number.isFinite(value) || value < 0) throw new Error(kind === "customMaxBaseBet" ? "自定义最大底注数值不正确" : "每名输家扣分上限数值不正确");
  if (cleanMode === "absolute") {
    if (!Number.isInteger(value)) throw new Error("固定值必须是整数");
    return { mode: "absolute", value } as CustomMaxBaseBetRule | CustomSettlementCapRule;
  }
  if (cleanMode === "classic-multiple" && kind === "customMaxBaseBet") {
    if (value <= 0) throw new Error("倍率必须是正数");
    return { mode: "classic-multiple", factor: value } as CustomMaxBaseBetRule;
  }
  if (cleanMode === "base-bet-multiple" && kind === "customSettlementCap") {
    if (value <= 0) throw new Error("倍率必须是正数");
    return { mode: "base-bet-multiple", factor: value } as CustomSettlementCapRule;
  }
  throw new Error("自定义限制方式不正确");
}

function duelLimitInput(prefix: string, partial: boolean): DuelLimitRule | undefined {
  const policy = selectValue(`${prefix}DuelPolicy`);
  if (partial && (!policy || policy === "default")) return undefined;
  const period = (policy ?? "hour") as DuelLimitPeriod;
  if (period === "none") return { period, count: 0 };
  if (period === "unlimited") return { period, count: null };
  if (period !== "hour" && period !== "day" && period !== "week") throw new Error("决斗次数限制不正确");
  const count = Number(inputValue(`${prefix}DuelCount`) ?? 1);
  if (!Number.isInteger(count) || count < 1) throw new Error("决斗次数必须是正整数");
  return { period, count };
}

function expirySummary(user: PublicUser): string {
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

function managedUsersTotalPoints(): number {
  return managedUsers.reduce((sum, user) => sum + user.points, 0);
}

function sortedManagedUsersForLeaderboard(): PublicUser[] {
  return [...managedUsers].sort(
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

function winRateFromUser(user: Pick<PublicUser, "gamesWon" | "gamesPlayed">): number {
  return user.gamesPlayed > 0 ? user.gamesWon / user.gamesPlayed : 0;
}

function rolePriority(role: UserRole): number {
  return { "super-admin": 5, "admin-advanced": 4, admin: 3, advanced: 2, normal: 1 }[role];
}

function formatAverage(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatSignedInteger(value: number): string {
  const clean = Number.isFinite(value) ? Math.trunc(value) : 0;
  return clean > 0 ? `+${clean}` : String(clean);
}

function pointDeltaClass(value: number): string {
  const clean = Number.isFinite(value) ? Math.trunc(value) : 0;
  if (clean > 0) return "point-delta-positive";
  if (clean < 0) return "point-delta-negative";
  return "point-delta-zero";
}

function formatDate(value: number): string {
  if (!Number.isFinite(value)) return "";
  const date = new Date(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatWinRate(rate: number): string {
  const percent = Math.max(0, Math.min(1, Number.isFinite(rate) ? rate : 0)) * 100;
  return `${percent.toFixed(2).replace(/\.?0+$/, "")}%`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function roleOptions(selected: UserRole, includeSuperAdmin: boolean): string {
  const roles: UserRole[] = includeSuperAdmin ? ["normal", "advanced", "admin", "admin-advanced", "super-admin"] : ["normal", "advanced", "admin", "admin-advanced"];
  return roles.map((role) => `<option value="${role}" ${role === selected ? "selected" : ""}>${escapeHtml(roleLabel(role))}</option>`).join("");
}

function isAdminUser(user?: PublicUser): boolean {
  return Boolean(user && (user.role === "admin" || user.role === "admin-advanced" || user.role === "super-admin"));
}

function winMusicControlAccess(user: PublicUser, self?: PublicUser): { canManage: boolean; canDownload: boolean; canPlay: boolean } {
  return {
    canManage: Boolean(self && user.hasAdvancedPerk && canManageWinMusic(self, user)),
    canDownload: Boolean(self && user.hasWinMusic && canDownloadWinMusic(self, user)),
    canPlay: Boolean(self && user.hasWinMusic && ((user.hasAdvancedPerk && canPlayWinMusic(self, user)) || canPlayDownloadedWinMusic(self, user))),
  };
}

function fillPermissionFields(role: UserRole): void {
  const rule = permissionsSnapshot?.rolePermissions[role];
  if (!rule) return;
  setSelectValue("permExchangeMax", rule.exchangeMax === null ? "-1" : String(rule.exchangeMax));
  setSelectValue("permZeroBet", String(rule.canCreateZeroBaseBet));
  const maxBaseBet = document.getElementById("permMaxBaseBet") as HTMLInputElement | null;
  if (maxBaseBet) maxBaseBet.value = rule.maxBaseBet === null ? "" : String(rule.maxBaseBet);
  setDuelLimitInputs("perm", rule.duelLimit);
  updateDuelLimitFields("perm");
}

function setCustomLimitInputs(prefix: string, kind: CustomLimitKind, rule?: CustomMaxBaseBetRule | CustomSettlementCapRule): void {
  const inputId = `${prefix}${kind === "customMaxBaseBet" ? "CustomMaxBet" : "CustomCap"}`;
  setSelectValue(`${inputId}Mode`, rule?.mode ?? "unlimited");
  const valueInput = document.getElementById(`${inputId}Value`) as HTMLInputElement | null;
  const raw = rule && "value" in rule ? rule.value : rule && "factor" in rule ? rule.factor : 1;
  if (valueInput) valueInput.value = String(raw);
}

function setSelectValue(id: string, value: string): void {
  const select = document.getElementById(id) as HTMLSelectElement | null;
  if (select) select.value = value;
}

function setDuelLimitInputs(prefix: string, rule?: Partial<DuelLimitRule>): void {
  const normalized = duelLimitForDisplay(rule);
  setSelectValue(`${prefix}DuelPolicy`, normalized.period);
  const count = document.getElementById(`${prefix}DuelCount`) as HTMLInputElement | null;
  if (count) count.value = String(normalized.count ?? 1);
}

function updateDuelLimitFields(prefix: string): void {
  const policy = selectValue(`${prefix}DuelPolicy`);
  const showCount = policy === "hour" || policy === "day" || policy === "week";
  document.getElementById(`${prefix}DuelCountField`)?.classList.toggle("is-hidden", !showCount);
}

function updateCustomLimitFields(prefix: string): void {
  for (const kind of ["CustomMaxBet", "CustomCap"] as const) {
    const mode = selectValue(`${prefix}${kind}Mode`);
    const show = mode === "absolute" || mode === "classic-multiple" || mode === "base-bet-multiple";
    document.getElementById(`${prefix}${kind}ValueField`)?.classList.toggle("is-hidden", !show);
  }
}

function updatePartialPermissionFields(prefix: string): void {
  const exchangeDefault = selectValue(`${prefix}ExchangeMaxMode`) === "default";
  document.getElementById(`${prefix}ExchangeMax`)?.classList.toggle("is-hidden", exchangeDefault);
  const maxBaseBetDefault = selectValue(`${prefix}MaxBaseBetMode`) === "default";
  document.getElementById(`${prefix}MaxBaseBet`)?.classList.toggle("is-hidden", maxBaseBetDefault);
  updateCustomLimitFields(prefix);
}

function updateRequestFields(kind: string): void {
  document.getElementById("requestNicknameField")?.classList.toggle("is-hidden", kind !== "nickname");
  document.getElementById("requestTextField")?.classList.toggle("is-hidden", kind === "nickname");
}

function updateEditUserFields(): void {
  document.getElementById("editPermissionFields")?.classList.toggle("is-hidden", selectValue("editPermissionMode") !== "custom");
  updateDuelLimitFields("edit");
  const expiryMode = selectValue("editPermissionExpiryMode") ?? "permanent";
  document.getElementById("editPermissionExpiryRelativeField")?.classList.toggle("is-hidden", expiryMode !== "relative");
  document.getElementById("editPermissionExpiryAbsoluteField")?.classList.toggle("is-hidden", expiryMode !== "absolute");
  const customModeLimitEnabled = selectValue("editCustomModeLimitMode") === "custom";
  document.getElementById("editCustomModeLimitFields")?.classList.toggle("is-hidden", !customModeLimitEnabled);
  const customModeLimitExpiryMode = selectValue("editCustomModeLimitExpiryMode") ?? "permanent";
  document.getElementById("editCustomModeLimitExpiryRelativeField")?.classList.toggle("is-hidden", !customModeLimitEnabled || customModeLimitExpiryMode !== "relative");
  document.getElementById("editCustomModeLimitExpiryAbsoluteField")?.classList.toggle("is-hidden", !customModeLimitEnabled || customModeLimitExpiryMode !== "absolute");
  document.getElementById("editAdminAbsoluteField")?.classList.toggle("is-hidden", selectValue("editAdminMode") !== "absolute");
  document.getElementById("editAdvancedAbsoluteField")?.classList.toggle("is-hidden", selectValue("editAdvancedMode") !== "absolute");
  document.getElementById("editAdvancedAiAbsoluteField")?.classList.toggle("is-hidden", selectValue("editAdvancedAiMode") !== "absolute");
  document.getElementById("editTaxRateField")?.classList.toggle("is-hidden", selectValue("editTaxRateMode") !== "custom");
}

function updateBanFields(): void {
  const scope = selectValue("banScope") ?? "account";
  const account = scope === "account";
  const accountMode = selectValue("banAccountMode");
  const leaderboardMode = selectValue("banLeaderboardMode");
  document.getElementById("accountBanFields")?.classList.toggle("is-hidden", !account);
  document.getElementById("leaderboardBanFields")?.classList.toggle("is-hidden", account);
  document.getElementById("accountBanWarning")?.classList.toggle("is-hidden", !account);
  document.getElementById("leaderboardBanWarning")?.classList.toggle("is-hidden", account);
  document.getElementById("banAccountUntilField")?.classList.toggle("is-hidden", !account || accountMode !== "temporary");
  document.getElementById("banHideLeaderboardField")?.classList.toggle("is-hidden", !account || accountMode === "none");
  document.getElementById("banLeaderboardUntilField")?.classList.toggle("is-hidden", account || leaderboardMode !== "temporary");
}

function updateInvitationUsageFields(): void {
  const policy = selectValue("inviteUsePolicy");
  document.getElementById("inviteMaxUsesField")?.classList.toggle("is-hidden", policy === "unlimited");
  document.getElementById("inviteWindowDaysField")?.classList.toggle("is-hidden", policy !== "global-window");
  document.getElementById("inviteExpiresAtField")?.classList.toggle("is-hidden", selectValue("inviteExpiryMode") !== "absolute");
}

function updateInvitationGrantFields(): void {
  const role = selectValue("inviteRole") as UserRole;
  document.getElementById("inviteAdminGrantFields")?.classList.toggle("is-hidden", !invitationRoleIncludes(role, "admin"));
  document.getElementById("inviteAdvancedGrantFields")?.classList.toggle("is-hidden", !invitationRoleIncludes(role, "advanced"));
  updateInvitationGrantMode("Admin");
  updateInvitationGrantMode("Advanced");
}

function updateInvitationPermissionFields(): void {
  document.getElementById("invitePermissionFields")?.classList.toggle("is-hidden", selectValue("invitePermissionMode") !== "custom");
  document.getElementById("inviteCustomModeLimitFields")?.classList.toggle("is-hidden", selectValue("inviteCustomModeLimitMode") !== "custom");
  updateDuelLimitFields("invite");
}

function updateInvitationGrantMode(id: "Admin" | "Advanced"): void {
  const mode = selectValue(`invite${id}Mode`);
  document.getElementById(`invite${id}RelativeField`)?.classList.toggle("is-hidden", mode !== "relative");
  document.getElementById(`invite${id}AbsoluteField`)?.classList.toggle("is-hidden", mode !== "absolute");
}

function updateActivationFields(): void {
  const policy = selectValue("activationPolicy");
  document.getElementById("activationMaxUsesField")?.classList.toggle("is-hidden", policy === "unlimited");
  document
    .getElementById("activationWindowDaysField")
    ?.classList.toggle("is-hidden", policy !== "global-window" && policy !== "per-user-window");
  document.getElementById("activationExpiresAtField")?.classList.toggle("is-hidden", selectValue("activationExpiryMode") !== "absolute");
  document.getElementById("activationBalanceGuardField")?.classList.toggle("is-hidden", Number(inputValue("activationPoints") ?? 0) >= 0);
  document.getElementById("activationFixedTitleField")?.classList.toggle("is-hidden", selectValue("activationTitleMode") !== "fixed");
  document
    .getElementById("activationFixedNicknameColorField")
    ?.classList.toggle("is-hidden", selectValue("activationNicknameColorMode") !== "fixed");
  document.getElementById("activationPermissionFields")?.classList.toggle("is-hidden", selectValue("activationPermissionMode") !== "custom");
  const customModeLimitEnabled = selectValue("activationCustomModeLimitMode") === "custom";
  document.getElementById("activationCustomModeLimitFields")?.classList.toggle("is-hidden", !customModeLimitEnabled);
  document.getElementById("activationCustomModeLimitDurationField")?.classList.toggle(
    "is-hidden",
    !customModeLimitEnabled || selectValue("activationCustomModeLimitDurationMode") === "permanent",
  );
  updatePartialPermissionFields("activation");
  updateDuelLimitFields("activation");
}

function updatePointDistributionFields(): void {
  document
    .getElementById("pointDistributionExpiresAtField")
    ?.classList.toggle("is-hidden", selectValue("pointDistributionExpiryMode") !== "absolute");
  const mode = selectValue("pointDistributionMode") ?? "random";
  document.getElementById("pointDistributionRandomField")?.classList.toggle("is-hidden", mode !== "random");
  document.getElementById("pointDistributionEqualField")?.classList.toggle("is-hidden", mode !== "equal");
  const maxUses = Math.max(1, Number(inputValue("pointDistributionMaxUses") ?? 1));
  const totalPoints = Number(inputValue("pointDistributionTotalPoints") ?? 0);
  const perUserPoints = Number(inputValue("pointDistributionPerUserPoints") ?? 0);
  const average = document.getElementById("pointDistributionAverageHint");
  if (average) average.textContent = `人均获得：${formatAverage(totalPoints / maxUses)}`;
  const total = document.getElementById("pointDistributionTotalHint");
  if (total) total.textContent = `总发放积分数：${maxUses * perUserPoints}`;
}

function updateBulkGrantHints(): void {
  if (dialog?.kind !== "bulk-grant-points") return;
  const mode = selectValue("bulkGrantMode") ?? "random";
  document.getElementById("bulkGrantRandomField")?.classList.toggle("is-hidden", mode !== "random");
  document.getElementById("bulkGrantEqualField")?.classList.toggle("is-hidden", mode !== "equal");
  const selectedCount = dialog.selectedUserIds?.length ?? 0;
  const totalPoints = Number(inputValue("bulkGrantTotalPoints") ?? 0);
  const perUserPoints = Number(inputValue("bulkGrantPerUserPoints") ?? 0);
  const average = document.getElementById("bulkGrantAverageHint");
  if (average) average.textContent = `人均获得：${selectedCount ? formatAverage(totalPoints / selectedCount) : "0"}`;
  const total = document.getElementById("bulkGrantTotalHint");
  if (total) total.textContent = `总发放积分数：${selectedCount * (Number.isFinite(perUserPoints) ? perUserPoints : 0)}`;
}

function updateActivationGrantFields(id: "Admin" | "Advanced"): void {
  const granted = selectValue(`activation${id}Grant`) === "grant";
  const mode = selectValue(`activation${id}Mode`);
  document.getElementById(`activation${id}GrantFields`)?.classList.toggle("is-hidden", !granted);
  document.getElementById(`activation${id}RelativeField`)?.classList.toggle("is-hidden", !granted || mode !== "relative");
  document.getElementById(`activation${id}AbsoluteField`)?.classList.toggle("is-hidden", !granted || mode !== "absolute");
}

function updateInvitationTaxFields(): void {
  const mode = selectValue("inviteTaxRateMode");
  document.getElementById("inviteTaxRateField")?.classList.toggle("is-hidden", mode !== "custom");
}

function updateActivationTaxFields(): void {
  const mode = selectValue("activationTaxRateMode");
  document.getElementById("activationTaxRateField")?.classList.toggle("is-hidden", mode !== "custom");
}

function updateAdvancedAiGrantFields(prefix: "invite" | "activation"): void {
  const id = `${prefix}AdvancedAi`;
  const granted = selectValue(`${id}Grant`) === "grant";
  const mode = selectValue(`${id}Mode`);
  document.getElementById(`${id}GrantFields`)?.classList.toggle("is-hidden", !granted);
  document.getElementById(`${id}RelativeField`)?.classList.toggle("is-hidden", !granted || mode !== "relative");
  document.getElementById(`${id}AbsoluteField`)?.classList.toggle("is-hidden", !granted || mode !== "absolute");
}

function invitationGrantInput(id: "Admin" | "Advanced", enabled: boolean): { durationMs: number | null | false; expiresAt: string | null } {
  if (!enabled) return { durationMs: false, expiresAt: null };
  const mode = selectValue(`invite${id}Mode`);
  if (mode === "permanent") return { durationMs: null, expiresAt: null };
  if (mode === "absolute") {
    const expiresAt = inputValue(`invite${id}ExpiresAt`);
    if (!expiresAt) throw new Error("请选择身份组的绝对截止时间");
    return { durationMs: false, expiresAt: `${expiresAt}:00` };
  }
  const amount = Number(inputValue(`invite${id}DurationAmount`) ?? 0);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("身份组相对时长必须是正整数");
  const unitMs = selectValue(`invite${id}DurationUnit`) === "hour" ? 3_600_000 : 86_400_000;
  return { durationMs: amount * unitMs, expiresAt: null };
}

function activationGrantInput(id: "Admin" | "Advanced"): { durationMs: number | null | false; expiresAt: string | null } {
  if (selectValue(`activation${id}Grant`) !== "grant") return { durationMs: false, expiresAt: null };
  const mode = selectValue(`activation${id}Mode`);
  if (mode === "permanent") return { durationMs: null, expiresAt: null };
  if (mode === "absolute") {
    const expiresAt = inputValue(`activation${id}ExpiresAt`);
    if (!expiresAt) throw new Error("请选择身份组的绝对截止时间");
    return { durationMs: false, expiresAt: `${expiresAt}:00` };
  }
  const amount = Number(inputValue(`activation${id}DurationAmount`) ?? 0);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("身份组相对时长必须是正整数");
  const unitMs = selectValue(`activation${id}DurationUnit`) === "hour" ? 3_600_000 : 86_400_000;
  return { durationMs: amount * unitMs, expiresAt: null };
}

function advancedAiGrantInput(prefix: "invite" | "activation"): { durationMs: number | null | false; expiresAt: string | null } {
  const id = `${prefix}AdvancedAi`;
  if (selectValue(`${id}Grant`) !== "grant") return { durationMs: false, expiresAt: null };
  const mode = selectValue(`${id}Mode`);
  if (mode === "permanent") return { durationMs: null, expiresAt: null };
  if (mode === "absolute") {
    const expiresAt = inputValue(`${id}ExpiresAt`);
    if (!expiresAt) throw new Error("请选择高级 AI 截止时间");
    return { durationMs: false, expiresAt: `${expiresAt}:00` };
  }
  const amount = Number(inputValue(`${id}DurationAmount`) ?? 0);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("高级 AI 相对时长必须是正整数");
  const unitMs = selectValue(`${id}DurationUnit`) === "hour" ? 3_600_000 : 86_400_000;
  return { durationMs: amount * unitMs, expiresAt: null };
}

function invitationTaxInput(): number | null {
  const mode = selectValue("inviteTaxRateMode");
  if (mode !== "custom") return null;
  const rate = Number(inputValue("inviteTaxRatePercent"));
  if (!Number.isInteger(rate) || rate < -1 || rate > 100) {
    throw new Error("用户最高征税比例必须是 -1 到 100 的整数");
  }
  return rate;
}

function activationTaxInput(): number | null {
  const mode = selectValue("activationTaxRateMode");
  if (mode !== "custom") return null;
  const rate = Number(inputValue("activationTaxRatePercent"));
  if (!Number.isInteger(rate) || rate < -1 || rate > 100) {
    throw new Error("用户最高征税比例必须是 -1 到 100 的整数");
  }
  return rate;
}

function invitationGrantMode(invite: InvitationCode | undefined, kind: "admin" | "advanced"): "relative" | "absolute" | "permanent" {
  const duration = kind === "admin" ? invite?.adminDurationMs : invite?.advancedDurationMs;
  const expiresAt = kind === "admin" ? invite?.adminExpiresAt : invite?.advancedExpiresAt;
  const permanent = kind === "admin" ? invite?.adminPermanent : invite?.advancedPermanent;
  if (typeof duration === "number") return "relative";
  if (expiresAt && duration !== null && !permanent) return "absolute";
  return "permanent";
}

function invitationDurationParts(duration?: number | null): { amount: number; unit: "day" | "hour" } {
  if (typeof duration !== "number" || duration <= 0) return { amount: 7, unit: "day" };
  if (duration % 86_400_000 === 0) return { amount: duration / 86_400_000, unit: "day" };
  return { amount: Math.max(1, Math.round(duration / 3_600_000)), unit: "hour" };
}

function invitationGrantSummary(invite: InvitationCode, kind: "admin" | "advanced"): string {
  if (!invitationRoleIncludes(invite.role, kind)) return "";
  const duration = kind === "admin" ? invite.adminDurationMs : invite.advancedDurationMs;
  const expiresAt = kind === "admin" ? invite.adminExpiresAt : invite.advancedExpiresAt;
  const permanent = kind === "admin" ? invite.adminPermanent : invite.advancedPermanent;
  if (duration === null || permanent) return "永久";
  if (typeof duration === "number") {
    const { amount, unit } = invitationDurationParts(duration);
    return `注册后 ${amount} ${unit === "day" ? "日" : "小时"}`;
  }
  return expiresAt ? `至 ${formatDate(Date.parse(expiresAt))}` : "永久";
}

function invitationPermissionSummary(permissions?: Partial<PermissionRule>): string {
  if (!permissions) return "身份组默认";
  const parts: string[] = [];
  if (permissions.exchangeMax !== undefined) parts.push(`换牌 0-${permissions.exchangeMax === null ? "不限" : permissions.exchangeMax}`);
  else parts.push("换牌默认");
  parts.push("固定 15s");
  if (permissions.canCreateZeroBaseBet !== undefined) parts.push(`0底注${permissions.canCreateZeroBaseBet ? "允许" : "禁止"}`);
  else parts.push("0底注默认");
  if (permissions.maxBaseBet !== undefined) parts.push(`最大底注 ${permissions.maxBaseBet === null ? "不限" : permissions.maxBaseBet}`);
  else parts.push("最大底注默认");
  parts.push(`决斗${duelLimitSummary(permissions.duelLimit)}`);
  return parts.join("；");
}

function customModeLimitGrantSummary(limits?: CustomModeLimitGrant, durationMs?: number | null): string {
  if (!limits) return "全局最高设置";
  const maxBaseBet = limits.maxBaseBet ? customMaxBaseBetSummary(limits.maxBaseBet) : "沿用全局";
  const settlementCap = limits.settlementCap ? customSettlementCapSummary(limits.settlementCap) : "沿用全局";
  const duration = durationMs === null
    ? "永久"
    : typeof durationMs === "number"
      ? (() => {
        const parts = invitationDurationParts(durationMs);
        return `${parts.amount}${parts.unit === "day" ? "日" : "小时"}`;
      })()
      : "永久";
  return `底注 ${maxBaseBet}；每名输家扣分 ${settlementCap}；${duration}`;
}

function duelLimitSummary(rule?: Partial<DuelLimitRule>): string {
  if (!rule) return "默认";
  const normalized = duelLimitForDisplay(rule);
  if (normalized.period === "none") return "不允许";
  if (normalized.period === "unlimited") return "不限";
  return `${duelPeriodLabel(normalized.period)}${normalized.count ?? 1}次`;
}

function invitationUseSummary(invite: InvitationCode): string {
  const policy = invite.usePolicy ?? (invite.remainingUses === null ? "unlimited" : "global-total");
  if (policy === "unlimited") return "不限次数";
  if (policy === "global-window") {
    return `每 ${Math.max(1, Math.round((invite.windowMs ?? 86_400_000) / 86_400_000))} 日最多 ${invite.maxUses ?? 1} 次`;
  }
  return `总计 ${invite.maxUses ?? (invite.registrations?.length ?? 0) + (invite.remainingUses ?? 0)} 次`;
}

function advancedAiGrantSummary(code: {
  advancedAiDurationMs?: number | null;
  advancedAiExpiresAt?: string;
}): string {
  if (code.advancedAiDurationMs === null) return "永久";
  if (typeof code.advancedAiDurationMs === "number") {
    const { amount, unit } = invitationDurationParts(code.advancedAiDurationMs);
    return `${amount}${unit === "hour" ? "小时" : "日"}`;
  }
  if (code.advancedAiExpiresAt) return `至 ${formatDate(Date.parse(code.advancedAiExpiresAt))}`;
  return "不授予";
}

function invitationRoleIncludes(role: UserRole, kind: "admin" | "advanced"): boolean {
  return kind === "admin" ? role === "admin" || role === "admin-advanced" : role === "advanced" || role === "admin-advanced";
}

function activationPolicyOptions(selected: ActivationUsePolicy): string {
  const policies: ActivationUsePolicy[] = ["unlimited", "global-total", "per-user-total", "global-window", "per-user-window"];
  return policies.map((policy) => `<option value="${policy}" ${policy === selected ? "selected" : ""}>${activationPolicyLabel(policy)}</option>`).join("");
}

function activationPolicyLabel(policy: ActivationUsePolicy): string {
  return (
    {
      unlimited: "不限次数",
      "global-total": "全局总次数",
      "per-user-total": "每用户总次数",
      "global-window": "全局滚动周期",
      "per-user-window": "每用户滚动周期",
    } as Record<ActivationUsePolicy, string>
  )[policy];
}

function activationTitleSummary(activation: ActivationCode): string {
  const mode = activation.titleMode ?? "default";
  if (mode === "fixed") return `固定：${activation.title ?? ""}`;
  if (mode === "user-custom") return "用户自定义";
  return "默认（不改变）";
}

function activationNicknameColorSummary(activation: ActivationCode): string {
  const mode = activation.nicknameColorMode ?? "default";
  if (mode === "fixed") return `固定：${activation.nicknameColor ?? ""}`;
  if (mode === "user-custom") return "用户自定义";
  return "默认（不改变）";
}

function reservedRoomCodeGrantSummary(mode?: "user-input" | "random"): string {
  if (mode === "user-input") return "用户输入";
  if (mode === "random") return "随机生成";
  return "不赠送";
}

function activationGrantSummary(activation: ActivationCode, kind: "admin" | "advanced"): string {
  const duration = kind === "admin" ? activation.adminDurationMs : activation.advancedDurationMs;
  const expiresAt = kind === "admin" ? activation.adminExpiresAt : activation.advancedExpiresAt;
  if (duration === undefined && !expiresAt) return "默认（不改变）";
  if (duration === null) return "永久";
  if (expiresAt) return `至 ${formatDate(Date.parse(expiresAt))}`;
  const { amount, unit } = invitationDurationParts(duration);
  return `${amount} ${unit === "day" ? "日" : "小时"}`;
}

function durationLabel(duration?: number | null): string {
  if (duration === null) return "永久";
  if (duration === undefined) return "";
  return `${Math.round(duration / 86_400_000)} 日`;
}

function durationInputValue(prefix: string): number | null | false {
  const mode = selectValue(`${prefix}Mode`);
  if (mode === "none") return false;
  if (mode === "permanent") return null;
  return Number(inputValue(`${prefix}Days`) ?? 1) * 86_400_000;
}

function exchangeMaxOptions(selected: number | null | undefined): string {
  const value = selected === null ? -1 : selected ?? 3;
  const options = [0, 1, 2, 3, 4, 5, -1];
  if (!options.includes(value)) options.splice(options.length - 1, 0, value);
  return options
    .map((option) => `<option value="${option}" ${option === value ? "selected" : ""}>${option < 0 ? "不限" : option}</option>`)
    .join("");
}

function requestKindLabel(kind: UserRequestView["kind"]): string {
  return ({ ticket: "工单", unban: "解封申请", nickname: "昵称修改", security: "安全审计" } as const)[kind];
}

function requestStatusLabel(status: UserRequestView["status"]): string {
  return ({ open: "待处理", approved: "已通过", replied: "已回复", ignored: "已忽略" } as const)[status];
}

function toLocalDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().slice(0, 16);
}

function cssEscape(value: string): string {
  return CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

function validateSetup(playerCount: number, botCount: number): string | undefined {
  if (!Number.isInteger(playerCount) || !Number.isInteger(botCount)) return "玩家数量和机器人数量必须是整数";
  if (botCount < 0 || botCount > 9) return "机器人数量必须为 0-9";
  if (botCount === 0 && (playerCount < 2 || playerCount > 10)) return "无机器人时，玩家数量必须为 2-10";
  if (botCount > 0 && (playerCount < 1 || playerCount > 10 - botCount)) return `有机器人时，玩家数量必须为 1-${10 - botCount}`;
  if (playerCount + botCount < 2) return "至少需要 2 个席位";
  return undefined;
}

function validateRoomCapacity(capacity: number): string | undefined {
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 10) return "玩家数量（含 AI）必须是 2-10 的整数";
  return undefined;
}

function validateInitialHandSizeInput(raw: string, playerCount: number): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed)) return "初始手牌数量只能输入数字";
  const maximum = maxInitialHandSize(playerCount);
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 2 || value > maximum) return `初始手牌数量必须为 2-${maximum}`;
  return undefined;
}

function updateModalInitialHandSizeHint(): void {
  if (!modal || (modal.kind !== "local" && modal.kind !== "online")) return;
  const players = Number((document.querySelector("#modalPlayers") as HTMLInputElement | null)?.value ?? modal.playerCount);
  const bots = modal.kind === "local" ? Number((document.querySelector("#modalBots") as HTMLInputElement | null)?.value ?? modal.botCount) : 0;
  const customMode = modal.ruleset === "custom";
  const duelActive = !customMode && modal.kind === "online" && isDuelBaseBet(modal.baseBet, currentUser);
  const seats = modal.kind === "online" ? (duelActive ? 2 : players) : players + bots;
  const cleanSeats = Number.isInteger(seats) && seats > 0 ? seats : 1;
  const activeRules = modal.customRules ?? PLATFORM_PRESET;
  const activeDeal = customMode ? customDeckForPlayerCount(activeRules, cleanSeats).deal : undefined;
  const maximum = customMode ? customInitialHandSizeMax(activeRules, cleanSeats) : maxInitialHandSize(cleanSeats);
  const minimum = customMode ? customDealMinimumGlobalFill(activeDeal) : 2;
  const input = document.querySelector<HTMLInputElement>("#modalInitialHandSize");
  const hint = document.querySelector("#modalInitialHandSizeHint");
  if (input) input.min = String(minimum);
  if (input) input.max = String(maximum);
  if (hint) hint.textContent = customMode
    ? `规则未设置席位补足数，可设 ${minimum}-${maximum}；该值会成为本局所有玩家的全局补足数。`
    : `留空使用规则默认；${modal.kind === "local" ? "按总人数（含机器人）" : "按玩家数量"}可设 ${minimum}-${maximum}`;
}

function editRoomBetHintText(capacity: number, initialHandSize?: number): RoomBetHintContent {
  const seats = Number.isInteger(capacity) && capacity >= 2 ? capacity : 2;
  const handSize = effectiveInitialHandSize(initialHandSize, seats);
  const total = seats * handSize;
  const maximum = effectiveMaxBaseBet(currentUser);
  const minimumBet = currentUser?.permissions.canCreateZeroBaseBet ? 0 : 1;
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

function updateEditRoomBetHint(): void {
  if (!room) return;
  const hint = document.querySelector<HTMLElement>("#editRoomBetHint");
  if (!hint) return;
  const capacity = Number((document.querySelector("#editRoomCapacity") as HTMLInputElement | null)?.value ?? room.capacity);
  const raw = ((document.querySelector("#editRoomInitialHandSize") as HTMLInputElement | null)?.value ?? "").trim();
  const parsed = raw !== "" && /^\d+$/.test(raw) ? Number(raw) : undefined;
  const content = editRoomBetHintText(capacity, parsed);
  hint.className = content.className;
  hint.textContent = content.text;
}

function isHexColor(value?: string): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function effectiveMaxBaseBet(user?: PublicUser): number | null {
  if (!user) return 100;
  return user.permissions.maxBaseBet;
}

function effectiveCustomMaxBaseBet(user?: PublicUser): number | null {
  if (!user) return resolveCustomMaxBaseBet(defaultCustomModeLimits().maxBaseBet, 100);
  return resolveCustomMaxBaseBet(user.customModeLimits?.maxBaseBet ?? defaultCustomModeLimits().maxBaseBet, user.permissions.maxBaseBet);
}

function effectiveRoomMaximumBaseBet(user: PublicUser | undefined, customMode: boolean): number | null {
  const maximum = customMode ? effectiveCustomMaxBaseBet(user) : effectiveMaxBaseBet(user);
  return !customMode && maximum !== null ? maximum * 100 : maximum;
}

function customInitialHandSizeMax(rules: ResolvedCustomRules | undefined, players: number): number {
  return customInitialHandSizeMaximum(rules ?? { deck: { cards: {} } }, players);
}

function isDuelBaseBet(value: number, user?: PublicUser): boolean {
  const maximum = effectiveMaxBaseBet(user);
  if (maximum === null || maximum <= 0) return false;
  return Number.isInteger(value) && value > maximum && value <= maximum * 100;
}

function duelLimitText(): string {
  const rule = currentUser?.permissions.duelLimit;
  if (!rule) return "每小时仅可创建 1 个决斗房间";
  if (rule.period === "unlimited" || rule.count === null) return "创建决斗房间不限次数";
  if (rule.period === "none" || rule.count <= 0) return "当前账号没有决斗额度";
  const periodText = rule.period === "hour" ? "每小时" : rule.period === "day" ? "每天" : rule.period === "week" ? "每周" : "每个周期";
  return `${periodText}仅可创建 ${rule.count} 个决斗房间`;
}

type RoomBetHintContent = { className: string; text: string };

function computeRoomBetHint(baseBet: number, playerCount: number, initialHandSizeRaw: string): RoomBetHintContent {
  const maximum = effectiveMaxBaseBet(currentUser);
  const trimmed = initialHandSizeRaw.trim();
  const parsedHandSize = trimmed !== "" && /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
  if (maximum !== null && maximum > 0 && isDuelBaseBet(baseBet, currentUser)) {
    const duelHandSize = effectiveInitialHandSize(parsedHandSize, 2);
    const duelCap = duelMaxBaseBet(maximum, duelHandSize);
    if (duelCap === null) {
      return { className: "duel-hint cooldown-hint", text: `初始手牌数量超过 65 张时不能开设决斗模式房间，请降低初始手牌数量或将底注降至 ${maximum} 及以下。` };
    }
    if (baseBet > duelCap) {
      return { className: "duel-hint cooldown-hint", text: `初始手牌 ${duelHandSize} 张时决斗底注不能超过 ${duelCap}，当前底注 ${baseBet} 已超出上限，请降低底注或初始手牌数量。` };
    }
    if (duelCooldownUntil > Date.now()) {
      return { className: "duel-hint cooldown-hint", text: `当前不可创建决斗房间，请等到 ${formatDate(duelCooldownUntil)} 后重试` };
    }
    const capNote = duelHandSize >= 11 ? `受初始手牌数 ${duelHandSize} 张限制，本房间决斗底注最高 ${duelCap}。` : `决斗底注不能超过底注上限的 100 倍（${duelCap}）。`;
    return {
      className: "duel-hint",
      text: `你已进入决斗模式，${duelLimitText()}。底注上限为 ${maximum}，当前底注 ${baseBet}（${(baseBet / maximum).toFixed(1)} 倍），${capNote}人数强制为 2 且不能添加机器人。对局结束后若你仍有决斗额度，可保留原房间码再来一局，新对局开始时才会扣除额度。`,
    };
  }
  if (maximum !== null && maximum > 0 && Number.isInteger(baseBet) && baseBet > maximum * 100) {
    return { className: "duel-hint cooldown-hint", text: `底注 ${baseBet} 超出决斗模式最高限额（底注上限的 100 倍，即 ${maximum * 100}），请降低底注。` };
  }
  const seats = Number.isInteger(playerCount) && playerCount >= 2 ? playerCount : 2;
  const handSize = effectiveInitialHandSize(parsedHandSize, seats);
  const total = seats * handSize;
  const minimumBet = currentUser?.permissions.canCreateZeroBaseBet ? 0 : 1;
  if (total > 100) {
    const cap = maximum === null ? null : normalMaxBaseBet(maximum, total);
    return {
      className: "duel-hint card-war-hint",
      text: `你已进入算牌大战：总发牌数 ${total} 张（${seats} 人 × 初始手牌 ${handSize} 张），底注上限同步降为 ${cap ?? "不限"}。请注意：当牌堆和弃牌堆较少时可能会出现预期之外的结果。`,
    };
  }
  return {
    className: "muted room-bet-hint",
    text: `底注允许范围 ${minimumBet}-${maximum ?? "不限"}；当前总发牌数 ${total} 张，超过 100 张将进入算牌大战并降低底注上限；底注超过 ${maximum ?? "不限"} 将进入决斗模式。`,
  };
}

function renderRoomBetHint(modal: SetupModal): string {
  if (modal.kind !== "online") return "";
  const hint = computeRoomBetHint(modal.baseBet, modal.playerCount, modal.initialHandSize);
  return `<p id="roomBetHint" class="${hint.className}">${escapeHtml(hint.text)}</p>`;
}

function updateRoomBetHintLive(): void {
  if (!modal || modal.kind !== "online") return;
  const hint = document.querySelector<HTMLElement>("#roomBetHint");
  if (!hint) return;
  const baseBet = Number((document.querySelector("#modalBaseBet") as HTMLInputElement | null)?.value ?? modal.baseBet);
  const playerCount = Number((document.querySelector("#modalPlayers") as HTMLInputElement | null)?.value ?? modal.playerCount);
  const handRaw = (document.querySelector("#modalInitialHandSize") as HTMLInputElement | null)?.value ?? modal.initialHandSize;
  const content = computeRoomBetHint(baseBet, playerCount, handRaw);
  hint.className = content.className;
  hint.textContent = content.text;
}

function validateBaseBet(baseBet: number, user: PublicUser | undefined, capacity: number, initialHandSize?: number): string | undefined {
  try {
    cleanRoomBaseBet({
      value: baseBet,
      maximum: effectiveMaxBaseBet(user),
      canCreateZeroBaseBet: Boolean(user?.permissions.canCreateZeroBaseBet),
      allowDuel: true,
      capacity,
      initialHandSize,
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "底注设置无效";
  }
}

function validateCustomBaseBet(baseBet: number, user: PublicUser | undefined, rules: ResolvedCustomRules): string | undefined {
  try {
    cleanCustomRoomBaseBet({
      value: baseBet,
      setupBaseBet: rules.setup.baseBet,
      maximum: effectiveCustomMaxBaseBet(user),
      canCreateZeroBaseBet: Boolean(user?.permissions.canCreateZeroBaseBet),
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "自定义模式底注设置无效";
  }
}

function validateCustomInitialHandSizeInput(raw: string, rules: ResolvedCustomRules, players: number): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  const minimum = customDealMinimumGlobalFill(customDeckForPlayerCount(rules, players).deal);
  const maximum = customInitialHandSizeMax(rules, players);
  if (!Number.isInteger(value) || value < minimum || value > maximum) return `自定义模式初始手牌必须为 ${minimum}-${maximum} 的整数，且不能小于固定发牌数；或留空使用 JSON 默认`;
  return undefined;
}

function validateEditableBaseBet(baseBet: number, user: PublicUser | undefined, capacity: number, initialHandSize?: number): string | undefined {
  try {
    cleanRoomBaseBet({
      value: baseBet,
      maximum: effectiveMaxBaseBet(user),
      canCreateZeroBaseBet: Boolean(user?.permissions.canCreateZeroBaseBet),
      allowDuel: false,
      capacity,
      initialHandSize,
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "底注设置无效";
  }
}

function validateRoomTimeLimitInput(raw: string, label: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed)) return `${label}只能输入整数秒`;
  try {
    cleanRoomTimeLimitSec(Number(trimmed), label);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : `${label}设置无效`;
  }
}

function createAudio() {
  let ctx: AudioContext | undefined;
  let lastTick = 0;
  return {
    enabled: localStorage.getItem("ionStormAudio") !== "0",
    play(name: "click" | "react" | "deal" | "tick" | "win" | "start") {
      if (!this.enabled) return;
      if (name === "tick" && Date.now() - lastTick < 900) return;
      if (name === "tick") lastTick = Date.now();
      ctx ??= new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const freq = { click: 360, react: 520, deal: 240, tick: 780, win: 660, start: 440 }[name];
      osc.frequency.value = freq;
      osc.type = name === "react" ? "sawtooth" : "sine";
      gain.gain.value = 0.001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(name === "tick" ? 0.035 : 0.06, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (name === "win" ? 0.42 : 0.16));
      osc.stop(ctx.currentTime + (name === "win" ? 0.45 : 0.18));
    },
  };
}

function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy, user-gesture-friendly clipboard path.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function renderGameLog(input: string): string {
  let html = escapeHtml(input);
  for (const ion of LOG_ION_FORMATS) html = html.replaceAll(escapeHtml(ion.label), ion.html);
  return html;
}

function escapeAttr(input: string): string {
  return escapeHtml(input).replace(/`/g, "&#96;");
}

declare global {
  interface Window {
    render_game_to_text: () => string;
    advanceTime: (ms?: number) => void;
  }
}
