import {
  CUSTOM_REACTION_KINDS,
  defaultTopColor,
  type CustomCardDef,
  type CustomReactionKind,
  type ResolvedCustomRules,
} from "./custom-rules-types.js";

export interface CustomCardRegistry {
  readonly rules: ResolvedCustomRules;
  get(id: string): CustomCardDef | undefined;
  has(id: string): boolean;
  ids(): string[];
  displayName(id: string): string;
  typeOf(id: string): CustomCardDef["type"] | undefined;
  chargeOf(id: string): number | undefined;
  topColorOf(id: string): string;
  ionColorOf(id: string): string | undefined;
  isIon(id: string): boolean;
  isColored(id: string): boolean;
  hasFlameTest(id: string): boolean;
  isNonreactive(id: string): boolean;
  reactionKind(a: string, b: string): CustomReactionKind | undefined;
  balance(a: string, b: string): [number, number];
}

export function createCustomCardRegistry(rules: ResolvedCustomRules): CustomCardRegistry {
  const pairMaps = new Map<CustomReactionKind, Map<string, Set<string>>>();
  for (const kind of CUSTOM_REACTION_KINDS) pairMaps.set(kind, new Map());
  for (const [id, def] of Object.entries(rules.cards)) {
    if (def.type !== "ion" || !def.reactions) continue;
    for (const kind of CUSTOM_REACTION_KINDS) {
      const map = pairMaps.get(kind);
      if (!map) continue;
      for (const target of def.reactions[kind] ?? []) {
        let set = map.get(id);
        if (!set) {
          set = new Set();
          map.set(id, set);
        }
        set.add(target);
        let reverse = map.get(target);
        if (!reverse) {
          reverse = new Set();
          map.set(target, reverse);
        }
        reverse.add(id);
      }
    }
  }
  const nonreactiveIds = new Set<string>();
  for (const [id, def] of Object.entries(rules.cards)) {
    if (def.type !== "ion") continue;
    const hasAny = CUSTOM_REACTION_KINDS.some((kind) => (def.reactions?.[kind]?.length ?? 0) > 0);
    if (!hasAny) nonreactiveIds.add(id);
  }

  const registry: CustomCardRegistry = {
    rules,
    get(id) {
      return rules.cards[id];
    },
    has(id) {
      return id in rules.cards;
    },
    ids() {
      return Object.keys(rules.cards);
    },
    displayName(id) {
      return rules.cards[id]?.displayName ?? id;
    },
    typeOf(id) {
      return rules.cards[id]?.type;
    },
    chargeOf(id) {
      const def = rules.cards[id];
      return def?.type === "ion" ? def.charge : undefined;
    },
    topColorOf(id) {
      const def = rules.cards[id];
      return def ? defaultTopColor(def) : "#8a8f98";
    },
    ionColorOf(id) {
      const def = rules.cards[id];
      return def?.type === "ion" ? def.color : undefined;
    },
    isIon(id) {
      return rules.cards[id]?.type === "ion";
    },
    isColored(id) {
      const def = rules.cards[id];
      return def?.type === "ion" && typeof def.color === "string" && def.color.length > 0;
    },
    hasFlameTest(id) {
      const def = rules.cards[id];
      return def?.type === "ion" && def.flameTest === true;
    },
    isNonreactive(id) {
      return nonreactiveIds.has(id);
    },
    reactionKind(a, b) {
      for (const kind of ["gas", "solid", "micro", "weak", "nonexistent"] as const) {
        const map = pairMaps.get(kind);
        if (map?.get(a)?.has(b)) return kind;
      }
      return undefined;
    },
    balance(a, b) {
      const ca = Math.abs(registry.chargeOf(a) ?? 0);
      const cb = Math.abs(registry.chargeOf(b) ?? 0);
      if (!ca || !cb) return [1, 1];
      const div = gcd(ca, cb);
      return [cb / div, ca / div];
    },
  };
  return registry;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}
