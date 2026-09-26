import { stableHash } from "./stable-json.js";

export const CUSTOM_RULES_VERSION = 4;

export type CustomRemoveCause = "reaction" | "operation" | "rule" | "other";

export const CUSTOM_CARD_TYPES = ["ion", "operation", "special", "generic"] as const;
export type CustomCardType = (typeof CUSTOM_CARD_TYPES)[number];

export const CUSTOM_REACTION_KINDS = ["solid", "gas", "micro", "weak", "nonexistent"] as const;
export type CustomReactionKind = (typeof CUSTOM_REACTION_KINDS)[number];

export type CustomSetupValue = number | [number, number];

export interface CustomSetup {
  players?: CustomSetupValue;
  baseBet?: CustomSetupValue;
  initialHand?: CustomSetupValue;
  /** Per-player-count default hand-size overrides, keyed by "2" through "10". */
  initialHandByPlayers?: Partial<Record<CustomPlayerCountKey, CustomSetupValue>>;
  /** When true, no player may exchange cards during this game's opening phase. */
  disableOpeningExchange?: boolean;
  /** Defaults to true. When false, Strong Acid + Strong Alkali cannot be played as WangZha. */
  allowWangZha?: boolean;
  [key: string]: unknown;
}

export type CustomPlayerCount = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type CustomPlayerCountKey = `${CustomPlayerCount}`;

export interface CustomWhereClause {
  type?: CustomCardType;
  kind?: CustomReactionKind | CustomReactionKind[];
  colored?: boolean;
  flameTest?: boolean;
  name?: string | { not: string };
  reactsWith?: string;
  playableTo?: string;
  contains?: CustomWhereClause;
  any?: CustomWhereClause[];
  [key: string]: unknown;
}

export type CustomTargetRef = string;

export interface CustomEventListenerRule {
  when: "turn.started" | "self.removed" | "marked.removed" | "marked.reacted" | "card.playedBatch";
  where?: {
    cause?: CustomRemoveCause | CustomRemoveCause[];
    reactionResult?: string | string[];
    name?: string;
    [key: string]: unknown;
  };
  while?: string;
  phase?: string;
  do: CustomStep[];
}

export interface CustomMarkRule {
  name: string;
  owner?: CustomTargetRef;
  badge?: string;
  reactionPriority?: number;
  on?: CustomEventListenerRule[];
}

export type CustomStep =
  | { op: "action"; to: CustomTargetRef; add: string | number }
  | { op: "audio"; id: string; to: CustomTargetRef; oncePer?: "event" }
  | { op: "cancelDraw"; next?: string; skip?: CustomTargetRef }
  | {
      op: "choose";
      from: string;
      where?: CustomWhereClause;
      mode?: "kind+count";
      count?: number;
      as: string;
      empty?: "stop" | "illegal";
    }
  | { op: "counter"; target: CustomTargetRef; name: string; add: string | number }
  | { op: "draw"; to: CustomTargetRef; n: string | number; start?: CustomTargetRef; scoreTo?: CustomTargetRef }
  | {
      op: "drawFlow";
      n: string | number;
      perPlayerCap?: number;
      scoreTo?: CustomTargetRef;
      /** Whether the draw flow created by this exact step may be followed by the same card/combo. */
      follow?: boolean;
    }
  | {
      op: "drawWhere";
      from: "deck";
      to: CustomTargetRef;
      where?: CustomWhereClause;
      pick: string;
      recycleDiscard?: boolean;
      excludeSourceCard?: boolean;
      as: string;
      scoreTo?: CustomTargetRef;
      empty?: "stop" | "illegal";
    }
  | { op: "flushDeferred"; from: string; scoreTo?: CustomTargetRef }
  | { op: "if"; test: string; then: CustomStep[]; else?: CustomStep[] }
  | {
      op: "inspect";
      player: CustomTargetRef;
      revealTo: CustomTargetRef;
      cases: Array<{ where: CustomWhereClause; show: "distinctDisplayNames" }>;
      empty?: string;
    }
  | { op: "move"; cards: string; to: string }
  | { op: "play"; card: string; consumeAction?: boolean; mark?: CustomMarkRule }
  | { op: "pot"; mul: string | number; creditTo?: CustomTargetRef }
  | {
      op: "reactSweep";
      reagent: string;
      virtual?: boolean;
      mode?: "enough";
      repeat?: "stable";
      as: string;
    }
  | {
      op: "remove";
      from?: string;
      target?: CustomTargetRef;
      where?: CustomWhereClause;
      to: string;
      cause: CustomRemoveCause;
      as?: string;
      deferCardTriggers?: boolean;
    }
  | { op: "reverse" }
  | { op: "score"; to: CustomTargetRef; add: string | number }
  | { op: "skip"; player: CustomTargetRef; stack?: boolean };

export const CUSTOM_OPS = [
  "action",
  "audio",
  "cancelDraw",
  "choose",
  "counter",
  "draw",
  "drawFlow",
  "drawWhere",
  "flushDeferred",
  "if",
  "inspect",
  "move",
  "play",
  "pot",
  "reactSweep",
  "remove",
  "reverse",
  "score",
  "skip",
] as const;
export type CustomOp = (typeof CUSTOM_OPS)[number];

export interface CustomCardBase {
  type: CustomCardType;
  displayName: string;
  /** Optional player-facing explanation (up to 500 characters). Blank and ion descriptions are not shown in-game. */
  description?: string;
  topColor?: string;
  audio?: Record<string, string>;
  /** @deprecated Legacy fallback for drawFlow.follow. New JSON should configure each drawFlow step directly. */
  follow?: boolean;
  /**
   * Whether this card may counter any pending draw flow. For legacy JSON this
   * defaults to true when a non-empty `counter` program is present, otherwise false.
   */
  counterAnyFollow?: boolean;
  /** Effects executed when the card counters a pending draw flow. */
  counter?: CustomStep[];
}

export interface CustomIonCard extends CustomCardBase {
  type: "ion";
  charge: number;
  reactions?: Partial<Record<CustomReactionKind, string[]>>;
  color?: string;
  flameTest?: boolean;
}

export interface CustomSpecialCard extends CustomCardBase {
  type: "special";
  play?: {
    to: string;
    inert?: boolean;
    counter?: { name: string; value: number; badge?: string };
  };
  on?: CustomEventListenerRule[];
}

export interface CustomOperationCard extends CustomCardBase {
  type: "operation";
  consume?: "hold";
  steps?: CustomStep[];
}

export interface CustomGenericCard extends CustomCardBase {
  type: "generic";
  consume?: "hold";
  steps?: CustomStep[];
}

export type CustomCardDef = CustomIonCard | CustomSpecialCard | CustomOperationCard | CustomGenericCard;

export interface CustomComboDef {
  requires: Record<string, number>;
  displayName?: string;
  /** @deprecated Legacy fallback for drawFlow.follow. New JSON should configure each drawFlow step directly. */
  follow?: boolean;
  /** Legacy default: true when a non-empty `counter` program is present. */
  counterAnyFollow?: boolean;
  steps?: CustomStep[];
  counter?: CustomStep[];
}

export interface CustomDealSeatRule {
  seat?: number;
  fixed?: Record<string, number>;
  fill?: number;
}

export interface CustomDisplay {
  autoStack?: boolean;
  maxStack?: number;
  order?: string[];
}

export interface CustomDeck {
  cards?: Record<string, number>;
  /** `null` is a preset-patch tombstone that clears an inherited deal. */
  deal?: CustomDealSeatRule[] | null;
  /**
   * Optional per-player-count deck/deal overrides.  An override with `cards`
   * replaces the common deck for that player count; an omitted `cards` reuses
   * the common deck.  `deal` similarly overrides the common initial deal.
   */
  byPlayers?: Partial<Record<CustomPlayerCountKey, CustomDeckOverride>>;
}

export interface CustomDeckOverride {
  cards?: Record<string, number>;
  deal?: CustomDealSeatRule[] | null;
}

export interface CustomRulesSource {
  version: number;
  name: string;
  displayName?: string;
  description?: string;
  preset?: string;
  setup?: CustomSetup;
  cards?: Record<string, CustomCardDef>;
  combos?: Record<string, CustomComboDef>;
  deck?: CustomDeck;
  /** `null` is a preset-patch tombstone that restores default display behavior. */
  display?: CustomDisplay | null;
}

export interface ResolvedCustomRules {
  version: number;
  name: string;
  displayName?: string;
  description?: string;
  setup: CustomSetup;
  cards: Record<string, CustomCardDef>;
  combos: Record<string, CustomComboDef>;
  deck: {
    cards: Record<string, number>;
    deal?: CustomDealSeatRule[];
    byPlayers?: Partial<Record<CustomPlayerCountKey, { cards?: Record<string, number>; deal?: CustomDealSeatRule[] }>>;
  };
  display?: CustomDisplay;
  presetChain: Array<{ id: string; revision?: number }>;
  hash: string;
}

/** Hash a resolved snapshot without feeding its derived `hash` field back into itself. */
export function canonicalCustomRulesHash(rules: ResolvedCustomRules): string {
  const { hash: _derivedHash, ...canonicalSnapshot } = rules;
  return stableHash(canonicalSnapshot);
}

/** Convert a frozen/resolved rules snapshot back into strict source JSON without derived metadata. */
export function customRulesSourceFromResolved(
  rules: ResolvedCustomRules,
  options?: { materializeFollowRules?: boolean },
): CustomRulesSource {
  const materialize = options?.materializeFollowRules !== false;
  const cards = materialize
    ? Object.fromEntries(Object.entries(rules.cards).map(([id, def]) => [id, materializeCustomCardFollowRules(def)]))
    : rules.cards;
  const combos = materialize
    ? Object.fromEntries(Object.entries(rules.combos).map(([id, combo]) => [id, materializeCustomComboFollowRules(combo)]))
    : rules.combos;
  return structuredClone({
    version: rules.version,
    name: rules.name,
    ...(rules.displayName !== undefined ? { displayName: rules.displayName } : {}),
    ...(rules.description !== undefined ? { description: rules.description } : {}),
    setup: rules.setup,
    cards,
    combos,
    deck: rules.deck,
    ...(rules.display !== undefined ? { display: rules.display } : {}),
  });
}

function materializeFollowListeners(listeners: CustomEventListenerRule[], legacyFollow: boolean): CustomEventListenerRule[] {
  return listeners.map((listener) => ({
    ...listener,
    do: materializeFollowSteps(listener.do, legacyFollow),
  }));
}

function materializeFollowSteps(steps: CustomStep[], legacyFollow: boolean): CustomStep[] {
  return steps.map((step) => {
    if (step.op === "drawFlow") return { ...step, follow: step.follow ?? legacyFollow };
    if (step.op === "if") {
      return {
        ...step,
        then: materializeFollowSteps(step.then, legacyFollow),
        ...(step.else ? { else: materializeFollowSteps(step.else, legacyFollow) } : {}),
      };
    }
    if (step.op === "play" && step.mark?.on) {
      return {
        ...step,
        mark: {
          ...step.mark,
          on: materializeFollowListeners(step.mark.on, legacyFollow),
        },
      };
    }
    return step;
  });
}

/** Upgrade legacy card-level follow behavior to exact drawFlow-step declarations for editor/export JSON. */
export function materializeCustomCardFollowRules(def: CustomCardDef): CustomCardDef {
  const upgraded = structuredClone(def);
  const legacyFollow = upgraded.follow ?? false;
  delete upgraded.follow;
  upgraded.counterAnyFollow = upgraded.counterAnyFollow ?? Boolean(upgraded.counter?.length);
  if (upgraded.counter) upgraded.counter = materializeFollowSteps(upgraded.counter, legacyFollow);
  if ((upgraded.type === "operation" || upgraded.type === "generic") && upgraded.steps) {
    upgraded.steps = materializeFollowSteps(upgraded.steps, legacyFollow);
  }
  if (upgraded.type === "special" && upgraded.on) {
    upgraded.on = materializeFollowListeners(upgraded.on, legacyFollow);
  }
  return upgraded;
}

/** Upgrade legacy combo-level follow behavior to exact drawFlow-step declarations for editor/export JSON. */
export function materializeCustomComboFollowRules(combo: CustomComboDef): CustomComboDef {
  const upgraded = structuredClone(combo);
  const legacyFollow = upgraded.follow ?? false;
  delete upgraded.follow;
  upgraded.counterAnyFollow = upgraded.counterAnyFollow ?? Boolean(upgraded.counter?.length);
  if (upgraded.steps) upgraded.steps = materializeFollowSteps(upgraded.steps, legacyFollow);
  if (upgraded.counter) upgraded.counter = materializeFollowSteps(upgraded.counter, legacyFollow);
  return upgraded;
}

export const DEFAULT_TOP_COLORS: Record<CustomCardType, string> = {
  ion: "#b63e32",
  operation: "#6b5aa9",
  special: "#c6972f",
  generic: "#8a8f98",
};

export const ION_ANION_TOP_COLOR = "#226b70";
export const ION_CATION_TOP_COLOR = "#b63e32";

export function defaultTopColor(def: CustomCardDef): string {
  if (def.topColor) return def.topColor;
  if (def.type === "ion") return def.charge < 0 ? ION_ANION_TOP_COLOR : ION_CATION_TOP_COLOR;
  return DEFAULT_TOP_COLORS[def.type];
}

// 手牌/换牌显示顺序：默认把通用类型排在操作牌前面，其余保持现有相对顺序
export const DISPLAY_TYPE_ORDER: Record<CustomCardType, number> = { generic: 0, operation: 1, special: 2, ion: 3 };

export function defaultDisplayOrder(cards: Record<string, CustomCardDef>): string[] {
  return Object.keys(cards).sort((a, b) => DISPLAY_TYPE_ORDER[cards[a].type] - DISPLAY_TYPE_ORDER[cards[b].type]);
}

export function effectiveDisplayOrder(rules: { cards: Record<string, CustomCardDef>; display?: CustomDisplay }): string[] {
  const order = rules.display?.order;
  const fallback = defaultDisplayOrder(rules.cards);
  if (!order || order.length === 0) return fallback;
  const explicit = new Set(order);
  return [...order, ...fallback.filter((id) => !explicit.has(id))];
}

export function displayOrderComparator(rules: { cards: Record<string, CustomCardDef>; display?: CustomDisplay }): (a: string, b: string) => number {
  const order = effectiveDisplayOrder(rules);
  const index = new Map(order.map((id, position) => [id, position]));
  return (a, b) => {
    const ia = index.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = index.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  };
}

// 初始发牌规定了每个座位的手牌时，房间人数必须等于发牌座位数
export function customDeckForPlayerCount(
  rules: { deck?: { cards?: Record<string, number>; deal?: CustomDealSeatRule[] | null; byPlayers?: Partial<Record<CustomPlayerCountKey, { cards?: Record<string, number>; deal?: CustomDealSeatRule[] | null }>> } },
  players: number,
): { cards: Record<string, number>; deal?: CustomDealSeatRule[] } {
  const override = rules.deck?.byPlayers?.[String(players) as CustomPlayerCountKey];
  return { cards: override?.cards ?? rules.deck?.cards ?? {}, deal: override?.deal ?? rules.deck?.deal ?? undefined };
}

function setupPlayerRange(value: CustomSetup["players"] | undefined): [number, number] {
  if (typeof value === "number") return [value, value];
  if (Array.isArray(value) && value.length === 2) return [value[0], value[1]];
  return [2, 10];
}

function dealRuleSignature(rule: CustomDealSeatRule): string {
  const fixed = Object.fromEntries(Object.entries(rule.fixed ?? {}).filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ fixed, ...(rule.fill !== undefined ? { fill: rule.fill } : {}) });
}

/**
 * The visual editor stores “same cards for every player” without adding a v4
 * schema field: every allowed `deck.byPlayers.N.deal` contains N identical
 * seat rules. This helper recognizes that existing-JSON representation.
 */
export function customUniformDealTemplate(
  rules: { setup?: CustomSetup; deck?: { byPlayers?: Partial<Record<CustomPlayerCountKey, { deal?: CustomDealSeatRule[] | null }>> } },
): CustomDealSeatRule | undefined {
  const [minimum, maximum] = setupPlayerRange(rules.setup?.players);
  let template: CustomDealSeatRule | undefined;
  let signature = "";
  for (let players = minimum; players <= maximum; players++) {
    const deal = rules.deck?.byPlayers?.[String(players) as CustomPlayerCountKey]?.deal;
    if (!Array.isArray(deal) || deal.length !== players) return undefined;
    for (const rule of deal) {
      const nextSignature = dealRuleSignature(rule);
      if (!template) {
        template = { ...(rule.fixed ? { fixed: { ...rule.fixed } } : {}), ...(rule.fill !== undefined ? { fill: rule.fill } : {}) };
        signature = nextSignature;
      } else if (nextSignature !== signature) {
        return undefined;
      }
    }
  }
  return template;
}

export function customDealHasAnyFill(deal: CustomDealSeatRule[] | undefined): boolean {
  return Boolean(deal?.some((rule) => rule.fill !== undefined));
}

export function customDealMinimumGlobalFill(deal: CustomDealSeatRule[] | undefined): number {
  return Math.max(2, ...(deal ?? []).map((rule) => Math.max(
    Object.values(rule.fixed ?? {}).reduce((sum, count) => sum + Math.max(0, Math.floor(count)), 0),
    rule.fill ?? 0,
  )));
}

/** Build strict v4 source JSON for one room while preserving reusable by-player templates. */
export function customRulesSourceForRoom(
  rules: ResolvedCustomRules,
  players: number,
  initialHandSize?: number,
): CustomRulesSource {
  // Room materialization preserves legacy omissions and hashes. The editor and
  // exports use the default explicit migration above.
  const source = customRulesSourceFromResolved(rules, { materializeFollowRules: false });
  const active = customDeckForPlayerCount(rules, players);
  const uniform = customUniformDealTemplate(rules);
  if (uniform) {
    const needed: Record<string, number> = {};
    for (const rule of active.deal ?? []) {
      for (const [cardId, count] of Object.entries(rule.fixed ?? {})) needed[cardId] = (needed[cardId] ?? 0) + count;
    }
    const cards = { ...active.cards };
    for (const [cardId, count] of Object.entries(needed)) {
      cards[cardId] = Math.max(cards[cardId] ?? 0, count);
    }
    const setupHand = customInitialHandForPlayerCount(rules, players);
    const fallbackTarget = initialHandSize ?? (typeof setupHand === "number" ? setupHand : Array.isArray(setupHand) ? setupHand[0] : 0);
    const totalNeeded = (active.deal ?? []).reduce((sum, rule) => {
      const fixedTotal = Object.values(rule.fixed ?? {}).reduce((seatSum, count) => seatSum + count, 0);
      return sum + Math.max(fixedTotal, rule.fill ?? fallbackTarget);
    }, 0);
    if (totalNeeded > 1000) throw new Error(`统一初始发牌共需 ${totalNeeded} 张，超过牌堆 1000 张上限`);
    let total = Object.values(cards).reduce((sum, count) => sum + count, 0);
    const weightedIds = Object.entries(active.cards).flatMap(([cardId, count]) => Array.from({ length: Math.max(1, count) }, () => cardId));
    let cursor = 0;
    while (total < totalNeeded) {
      if (weightedIds.length === 0) throw new Error("牌堆为空，无法补足统一初始发牌");
      const cardId = weightedIds[cursor % weightedIds.length];
      cursor += 1;
      cards[cardId] = (cards[cardId] ?? 0) + 1;
      total += 1;
    }
    source.deck ??= {};
    source.deck.byPlayers ??= {};
    const key = String(players) as CustomPlayerCountKey;
    source.deck.byPlayers[key] = { ...(source.deck.byPlayers[key] ?? {}), cards };
  }
  if (initialHandSize !== undefined && !customDealHasAnyFill(active.deal)) {
    source.setup ??= {};
    source.setup.initialHandByPlayers ??= {};
    source.setup.initialHandByPlayers[String(players) as CustomPlayerCountKey] = initialHandSize;
  }
  return source;
}

export function customInitialHandForPlayerCount(rules: { setup?: CustomSetup }, players: number): CustomSetupValue | undefined {
  return rules.setup?.initialHandByPlayers?.[String(players) as CustomPlayerCountKey] ?? rules.setup?.initialHand;
}

// 初始发牌规定了每个座位的手牌时，房间人数必须等于发牌座位数。
// 传入人数后会先选择该人数对应的高级 deck 覆盖；省略人数时仅检查通用 deal。
export function requiredPlayersFromDeal(
  rules: { deck?: { cards?: Record<string, number>; deal?: CustomDealSeatRule[] | null; byPlayers?: Partial<Record<CustomPlayerCountKey, { cards?: Record<string, number>; deal?: CustomDealSeatRule[] | null }>> } },
  players?: number,
): number | null {
  if (customUniformDealTemplate(rules)) return null;
  const deal = players === undefined ? rules.deck?.deal : customDeckForPlayerCount(rules, players).deal;
  if (!deal || deal.length === 0) return null;
  return deal.length;
}

// Resource limits shared by Node / Worker / client validation.
export const CUSTOM_LIMITS = {
  maxDocumentBytes: 512 * 1024,
  maxCardDefinitions: 128,
  maxAudioBytesPerCard: 256 * 1024,
  maxAudioBytesTotal: 1024 * 1024,
  maxStepsPerCard: 64,
  maxIfDepth: 8,
  maxMarkListenersPerCard: 16,
  maxFormulaTokens: 64,
  maxFormulaAstDepth: 12,
  maxFormulaExponent: 64,
  maxFormulaAbsValue: 1e9,
  maxEventsPerAction: 256,
  maxDynamicDraw: 130,
  maxChainReactions: 64,
  maxPresetDepth: 8,
  maxAudioKeyLength: 64,
  allowedAudioMime: ["audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3", "audio/ogg"] as string[],
} as const;
