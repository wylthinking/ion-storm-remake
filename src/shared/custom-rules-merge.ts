import type { CustomCardDef, CustomComboDef, CustomDeckOverride, CustomDisplay, CustomPlayerCountKey, CustomRulesSource, CustomSetup } from "./custom-rules-types.js";

export interface MergedRulesDocument {
  version: number;
  name: string;
  displayName?: string;
  description?: string;
  setup: CustomSetup;
  cards: Record<string, CustomCardDef>;
  combos: Record<string, CustomComboDef>;
  deck: { cards: Record<string, number>; deal?: unknown; byPlayers?: Partial<Record<CustomPlayerCountKey, CustomDeckOverride>> };
  display?: CustomDisplay;
}

function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

export function mergeRulesDocuments(base: MergedRulesDocument, patch: CustomRulesSource): MergedRulesDocument {
  const cards: Record<string, CustomCardDef> = { ...base.cards };
  for (const [id, def] of Object.entries(patch.cards ?? {})) {
    setOwn(cards, id, def);
  }
  const combos: Record<string, CustomComboDef> = { ...base.combos };
  for (const [id, combo] of Object.entries(patch.combos ?? {})) {
    setOwn(combos, id, combo);
  }
  const deckCards: Record<string, number> = { ...base.deck.cards };
  for (const [id, count] of Object.entries(patch.deck?.cards ?? {})) {
    if (count === 0) delete deckCards[id];
    else setOwn(deckCards, id, count);
  }
  const byPlayers: Partial<Record<CustomPlayerCountKey, CustomDeckOverride>> = { ...(base.deck.byPlayers ?? {}) };
  for (const [players, override] of Object.entries(patch.deck?.byPlayers ?? {}) as Array<[CustomPlayerCountKey, CustomDeckOverride]>) {
    const inherited = byPlayers[players];
    byPlayers[players] = {
      // A per-player cards object is deliberately a complete deck replacement.
      // Omitted fields inherit the corresponding value from the same branch.
      cards: override.cards === undefined ? inherited?.cards : override.cards,
      deal: override.deal === undefined ? inherited?.deal : override.deal,
    };
  }
  const setup: CustomSetup = {
    ...base.setup,
    ...(patch.setup ?? {}),
    ...((base.setup.initialHandByPlayers !== undefined || patch.setup?.initialHandByPlayers !== undefined)
      ? { initialHandByPlayers: { ...base.setup.initialHandByPlayers, ...patch.setup?.initialHandByPlayers } }
      : {}),
  };
  return {
    version: patch.version,
    name: patch.name,
    displayName: patch.displayName ?? base.displayName,
    description: patch.description ?? base.description,
    setup,
    cards,
    combos,
    deck: {
      cards: deckCards,
      deal: patch.deck?.deal === null ? undefined : patch.deck?.deal !== undefined ? patch.deck.deal : base.deck.deal,
      ...(Object.keys(byPlayers).length > 0 ? { byPlayers } : {}),
    },
    display: patch.display === null ? undefined : patch.display !== undefined ? { ...base.display, ...patch.display } : base.display,
  };
}

export function emptyRulesDocument(name: string): MergedRulesDocument {
  return {
    version: 0,
    name,
    setup: {},
    cards: {},
    combos: {},
    deck: { cards: {} },
  };
}
