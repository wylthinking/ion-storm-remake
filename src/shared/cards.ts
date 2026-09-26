import type { CardDef, CardId, CardKind, ProductKind } from "./types.js";

export const CATIONS = [
  "H^+",
  "NH_4^+",
  "K^+",
  "Na^+",
  "Ba^{2+}",
  "Ca^{2+}",
  "Mg^{2+}",
  "Al^{3+}",
  "Zn^{2+}",
  "Fe^{2+}",
  "Fe^{3+}",
  "Pb^{2+}",
  "Cu^{2+}",
  "Ag^+",
] as const;

export const ANIONS = [
  "OH^-",
  "NO_3^-",
  "Cl^-",
  "SO_4^{2-}",
  "S^{2-}",
  "SO_3^{2-}",
  "CO_3^{2-}",
  "SiO_3^{2-}",
  "PO_4^{3-}",
  "Ac^-",
] as const;

export const SPECIALS = ["Au", "U"] as const;
export const FUNCTIONS = [
  "Acid",
  "Alkali",
  "Enough",
  "Impurity",
  "Filter",
  "Fade",
  "AirWashing",
  "Distill",
  "AddSodium",
  "Ban",
  "Reverse",
] as const;

export const COLOR_IONS = new Set<CardId>(["Fe^{2+}", "Fe^{3+}", "Cu^{2+}"]);

export const LABELS: Record<CardId, string> = {
  "H^+": "H+",
  "NH_4^+": "NH4+",
  "K^+": "K+",
  "Na^+": "Na+",
  "Ba^{2+}": "Ba2+",
  "Ca^{2+}": "Ca2+",
  "Mg^{2+}": "Mg2+",
  "Al^{3+}": "Al3+",
  "Zn^{2+}": "Zn2+",
  "Fe^{2+}": "Fe2+",
  "Fe^{3+}": "Fe3+",
  "Pb^{2+}": "Pb2+",
  "Cu^{2+}": "Cu2+",
  "Ag^+": "Ag+",
  "OH^-": "OH-",
  "NO_3^-": "NO3-",
  "Cl^-": "Cl-",
  "SO_4^{2-}": "SO4 2-",
  "S^{2-}": "S2-",
  "SO_3^{2-}": "SO3 2-",
  "CO_3^{2-}": "CO3 2-",
  "SiO_3^{2-}": "SiO3 2-",
  "PO_4^{3-}": "PO4 3-",
  "Ac^-": "Ac-",
  Au: "金",
  U: "铀",
  Acid: "强酸",
  Alkali: "强碱",
  Enough: "足量",
  Impurity: "杂质",
  Filter: "过滤",
  Fade: "褪色",
  AirWashing: "洗气",
  Distill: "蒸馏",
  AddSodium: "加钠",
  Ban: "禁",
  Reverse: "逆转",
};

export const FORMULA_HTML: Record<CardId, string> = {
  "H^+": "H<sup>+</sup>",
  "NH_4^+": "NH<sub>4</sub><sup>+</sup>",
  "K^+": "K<sup>+</sup>",
  "Na^+": "Na<sup>+</sup>",
  "Ba^{2+}": "Ba<sup>2+</sup>",
  "Ca^{2+}": "Ca<sup>2+</sup>",
  "Mg^{2+}": "Mg<sup>2+</sup>",
  "Al^{3+}": "Al<sup>3+</sup>",
  "Zn^{2+}": "Zn<sup>2+</sup>",
  "Fe^{2+}": "Fe<sup>2+</sup>",
  "Fe^{3+}": "Fe<sup>3+</sup>",
  "Pb^{2+}": "Pb<sup>2+</sup>",
  "Cu^{2+}": "Cu<sup>2+</sup>",
  "Ag^+": "Ag<sup>+</sup>",
  "OH^-": "OH<sup>-</sup>",
  "NO_3^-": "NO<sub>3</sub><sup>-</sup>",
  "Cl^-": "Cl<sup>-</sup>",
  "SO_4^{2-}": "SO<sub>4</sub><sup>2-</sup>",
  "S^{2-}": "S<sup>2-</sup>",
  "SO_3^{2-}": "SO<sub>3</sub><sup>2-</sup>",
  "CO_3^{2-}": "CO<sub>3</sub><sup>2-</sup>",
  "SiO_3^{2-}": "SiO<sub>3</sub><sup>2-</sup>",
  "PO_4^{3-}": "PO<sub>4</sub><sup>3-</sup>",
  "Ac^-": "Ac<sup>-</sup>",
  Au: "金",
  U: "铀",
  Acid: "强酸",
  Alkali: "强碱",
  Enough: "足量",
  Impurity: "杂质",
  Filter: "过滤",
  Fade: "褪色",
  AirWashing: "洗气",
  Distill: "蒸馏",
  AddSodium: "加钠",
  Ban: "禁",
  Reverse: "逆转",
};

export function cardText(card: CardId): string {
  const subscript: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉" };
  const superscript: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻" };
  return (FORMULA_HTML[card] ?? LABELS[card] ?? card)
    .replace(/<sub>([^<]+)<\/sub>/g, (_match, value: string) => [...value].map((character) => subscript[character] ?? character).join(""))
    .replace(/<sup>([^<]+)<\/sup>/g, (_match, value: string) => [...value].map((character) => superscript[character] ?? character).join(""));
}

export const INIT_CARD: Record<CardId, number> = {
  "H^+": 6,
  "NH_4^+": 6,
  "K^+": 2,
  "Na^+": 2,
  "Ba^{2+}": 4,
  "Ca^{2+}": 4,
  "Mg^{2+}": 3,
  "Al^{3+}": 2,
  "Zn^{2+}": 3,
  "Fe^{2+}": 3,
  "Fe^{3+}": 3,
  "Pb^{2+}": 3,
  "Cu^{2+}": 3,
  "Ag^+": 3,
  "OH^-": 6,
  "NO_3^-": 3,
  "Cl^-": 4,
  "SO_4^{2-}": 5,
  "S^{2-}": 3,
  "SO_3^{2-}": 3,
  "CO_3^{2-}": 5,
  "SiO_3^{2-}": 3,
  "PO_4^{3-}": 3,
  "Ac^-": 3,
  Au: 3,
  U: 3,
  Acid: 4,
  Alkali: 4,
  Enough: 3,
  Impurity: 3,
  Filter: 5,
  Fade: 3,
  AirWashing: 3,
  Distill: 4,
  AddSodium: 2,
  Ban: 4,
  Reverse: 4,
};

export const CHARGE: Record<CardId, number> = {
  "H^+": 1,
  "NH_4^+": 1,
  "K^+": 1,
  "Na^+": 1,
  "Ba^{2+}": 2,
  "Ca^{2+}": 2,
  "Mg^{2+}": 2,
  "Al^{3+}": 3,
  "Zn^{2+}": 2,
  "Fe^{2+}": 2,
  "Fe^{3+}": 3,
  "Pb^{2+}": 2,
  "Cu^{2+}": 2,
  "Ag^+": 1,
  "OH^-": -1,
  "NO_3^-": -1,
  "Cl^-": -1,
  "SO_4^{2-}": -2,
  "S^{2-}": -2,
  "SO_3^{2-}": -2,
  "CO_3^{2-}": -2,
  "SiO_3^{2-}": -2,
  "PO_4^{3-}": -3,
  "Ac^-": -1,
};

export const TO_GAS = mapPairs({
  "H^+": ["S^{2-}", "SO_3^{2-}", "CO_3^{2-}"],
  "NH_4^+": ["OH^-"],
});

export const TO_SOLID = mapPairs({
  "H^+": ["SiO_3^{2-}"],
  "Ba^{2+}": ["SO_4^{2-}", "SO_3^{2-}", "CO_3^{2-}", "SiO_3^{2-}", "PO_4^{3-}"],
  "Ca^{2+}": ["SO_3^{2-}", "CO_3^{2-}", "SiO_3^{2-}", "PO_4^{3-}"],
  "Mg^{2+}": ["OH^-", "SiO_3^{2-}", "PO_4^{3-}"],
  "Al^{3+}": ["OH^-", "PO_4^{3-}"],
  "Zn^{2+}": ["OH^-", "S^{2-}", "SO_3^{2-}", "CO_3^{2-}", "SiO_3^{2-}", "PO_4^{3-}"],
  "Fe^{2+}": ["OH^-", "S^{2-}", "SO_3^{2-}", "CO_3^{2-}", "SiO_3^{2-}", "PO_4^{3-}"],
  "Fe^{3+}": ["OH^-", "PO_4^{3-}"],
  "Pb^{2+}": ["OH^-", "SO_4^{2-}", "S^{2-}", "SO_3^{2-}", "CO_3^{2-}", "SiO_3^{2-}", "PO_4^{3-}"],
  "Cu^{2+}": ["OH^-", "S^{2-}", "SO_3^{2-}", "PO_4^{3-}"],
  "Ag^+": ["Cl^-", "S^{2-}", "SO_3^{2-}", "CO_3^{2-}", "SiO_3^{2-}", "PO_4^{3-}"],
});

export const TO_MICRO = mapPairs({
  "Ca^{2+}": ["OH^-", "SO_4^{2-}", "S^{2-}"],
  "Mg^{2+}": ["SO_3^{2-}", "CO_3^{2-}"],
  "Pb^{2+}": ["Cl^-"],
  "Ag^+": ["SO_4^{2-}"],
});

export const TO_WEAK = mapPairs({
  "H^+": ["OH^-", "PO_4^{3-}", "Ac^-"],
});

export const TO_NONEXISTENT = mapPairs({
  "NH_4^+": ["SiO_3^{2-}"],
  "Mg^{2+}": ["S^{2-}"],
  "Al^{3+}": ["S^{2-}", "SO_3^{2-}", "CO_3^{2-}", "SiO_3^{2-}"],
  "Fe^{3+}": ["S^{2-}", "SO_3^{2-}", "CO_3^{2-}", "SiO_3^{2-}"],
  "Cu^{2+}": ["CO_3^{2-}", "SiO_3^{2-}"],
  "Ag^+": ["OH^-"],
});

export const CARDS: Record<CardId, CardDef> = Object.fromEntries(
  Object.keys(INIT_CARD).map((id) => [
    id,
    {
      id,
      label: LABELS[id] ?? id,
      kind: CATIONS.includes(id as never)
        ? "cation"
        : ANIONS.includes(id as never)
          ? "anion"
          : SPECIALS.includes(id as never)
            ? "special"
            : "function",
      charge: CHARGE[id],
      count: INIT_CARD[id],
    } satisfies CardDef,
  ]),
);

export function isIon(card: CardId): boolean {
  return CATIONS.includes(card as never) || ANIONS.includes(card as never);
}

const HAND_FUNCTION_ORDER: CardId[] = ["Acid", "Alkali", "Ban", "Reverse", "Enough", "Impurity", "Filter", "Fade", "AirWashing", "Distill", "AddSodium"];
const HAND_SPECIAL_ORDER: CardId[] = ["Au", "U"];
const HAND_CATION_ORDER: CardId[] = ["Na^+", "K^+", "Ca^{2+}", "Ba^{2+}", "Mg^{2+}", "Al^{3+}", "Fe^{2+}", "Fe^{3+}", "Cu^{2+}", "Zn^{2+}", "Ag^+", "Pb^{2+}", "NH_4^+", "H^+"];
const HAND_ANION_ORDER: CardId[] = ["Cl^-", "SO_4^{2-}", "NO_3^-", "SO_3^{2-}", "S^{2-}", "SiO_3^{2-}", "PO_4^{3-}", "Ac^-", "CO_3^{2-}", "OH^-"];
const HAND_KIND_ORDER: CardKind[] = ["function", "special", "cation", "anion"];

function handSortRank(card: CardId): number {
  const kind = CARDS[card]?.kind ?? "function";
  const list = kind === "function" ? HAND_FUNCTION_ORDER : kind === "special" ? HAND_SPECIAL_ORDER : kind === "cation" ? HAND_CATION_ORDER : HAND_ANION_ORDER;
  const within = list.indexOf(card);
  return HAND_KIND_ORDER.indexOf(kind) * 100 + (within < 0 ? 99 : within);
}

export function compareHandCards(a: CardId, b: CardId): number {
  const diff = handSortRank(a) - handSortRank(b);
  return diff !== 0 ? diff : a.localeCompare(b);
}

export function isFunction(card: CardId): boolean {
  return FUNCTIONS.includes(card as never);
}

export function isSpecial(card: CardId): card is "Au" | "U" {
  return card === "Au" || card === "U";
}

export function reactionKind(a: CardId, b: CardId): ProductKind | undefined {
  if (hasPair(TO_GAS, a, b)) return "gas";
  if (hasPair(TO_SOLID, a, b)) return "solid";
  if (hasPair(TO_MICRO, a, b)) return "micro";
  if (hasPair(TO_WEAK, a, b)) return "weak";
  if (hasPair(TO_NONEXISTENT, a, b)) return "nonexistent";
  return undefined;
}

export function balance(a: CardId, b: CardId): [number, number] {
  const ca = Math.abs(CHARGE[a] ?? 0);
  const cb = Math.abs(CHARGE[b] ?? 0);
  if (!ca || !cb) return [1, 1];
  const div = gcd(ca, cb);
  return [cb / div, ca / div];
}

export function totalCards(): number {
  return Object.values(INIT_CARD).reduce((sum, count) => sum + count, 0);
}

function mapPairs(input: Record<CardId, CardId[]>): Record<CardId, Set<CardId>> {
  const out: Record<CardId, Set<CardId>> = {};
  for (const [a, list] of Object.entries(input)) {
    out[a] ??= new Set<CardId>();
    for (const b of list) {
      out[a].add(b);
      out[b] ??= new Set<CardId>();
      out[b].add(a);
    }
  }
  return out;
}

function hasPair(map: Record<CardId, Set<CardId>>, a: CardId, b: CardId): boolean {
  return Boolean(map[a]?.has(b));
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}
