import { CARDS, FORMULA_HTML, LABELS } from "./cards.js";
import type { CardId } from "./types.js";

export function compoundFormulaHtml(entries: Array<{ card: CardId; count: number }>): string {
  const counts = new Map<CardId, number>();
  for (const entry of entries) counts.set(entry.card, (counts.get(entry.card) ?? 0) + entry.count);
  const merged = [...counts].map(([card, count]) => ({ card, count }));
  const coefficient = merged.length > 1 ? merged.reduce((divisor, entry) => greatestCommonDivisor(divisor, entry.count), 0) : 1;
  const reduced = coefficient > 1 ? merged.map((entry) => ({ ...entry, count: entry.count / coefficient })) : merged;
  const formula = isWaterFormula(reduced)
    ? "H<sub>2</sub>O"
    : [...reduced]
        .sort((a, b) => Math.sign(CARDS[b.card]?.charge ?? 0) - Math.sign(CARDS[a.card]?.charge ?? 0))
        .map(({ card, count }) => neutralIonPart(card, count))
        .join("");
  return `${coefficient > 1 ? coefficient : ""}${formula}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function isWaterFormula(entries: Array<{ card: CardId; count: number }>): boolean {
  if (entries.length !== 2) return false;
  const counts = Object.fromEntries(entries.map((entry) => [entry.card, entry.count]));
  return counts["H^+"] === 1 && counts["OH^-"] === 1;
}

function neutralIonPart(card: CardId, count: number): string {
  const body = (FORMULA_HTML[card] ?? LABELS[card] ?? card).replace(/<sup>[^<]+<\/sup>/g, "");
  if (count <= 1) return body;
  const needsParens = POLYATOMIC_IONS.has(card) && card !== "H^+";
  return `${needsParens ? `(${body})` : body}<sub>${count}</sub>`;
}

const POLYATOMIC_IONS = new Set<CardId>(["NH_4^+", "OH^-", "NO_3^-", "SO_4^{2-}", "SO_3^{2-}", "CO_3^{2-}", "SiO_3^{2-}", "PO_4^{3-}", "Ac^-"]);
