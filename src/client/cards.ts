/**
 * 卡牌渲染层（S1）。
 *
 * 从 app.ts 搬出来的「一张牌长什么样」：视觉分类、牌面公式、说明气泡属性、
 * 单张牌/整摞牌的按钮 HTML，以及手牌的排序与合并分组。
 *
 * 它需要三样应用状态，全部通过 context 的 getBridge() 拿，不直接 import app.ts：
 *   customRules()          ← 原来是 customRulesOf(game)
 *   game()                 ← 只用来判 isCustomGame（决定要不要给铁/铜离子上色）
 *   selectedHandIndex()    ← 手牌选中态
 *   selectedCard()         ← 「同名牌」提示用的牌名
 *   aiSuggestedCardClass() ← AI 建议的紫框（那段逻辑仍留在 app.ts，读 advancedAi* 一组状态）
 */
import { CARDS, compareHandCards } from "../shared/cards.js";
import { defaultTopColor, displayOrderComparator, type CustomCardDef } from "../shared/custom-rules-types.js";
import { isCustomGame, type CardId, type CardInstance } from "../shared/types.js";
import { getBridge } from "./context.js";
import { escapeAttr, escapeHtml } from "./dom.js";
import { coloredIonStyle, formulaHtml, kindName } from "./format.js";
import type { CardVisual, HandDisplayGroup } from "./types.js";

/** 自定义卡牌四大类的显示名（规则编辑器、卡牌分类标签共用）。 */
export const CUSTOM_CARD_TYPE_LABELS: Record<CustomCardDef["type"], string> = {
  ion: "离子",
  operation: "操作",
  special: "特殊",
  generic: "通用",
};

/** CardInstance（自定义模式带印记/寿命）→ 纯 CardId。 */
export function cardIdOf(card: CardId | CardInstance): CardId {
  return typeof card === "string" ? card : card.cardId;
}

/** 一张牌的视觉描述：CSS 类、牌面公式、小字种类名、顶部色条、离子颜色。 */
export function cardVisual(id: CardId): CardVisual {
  const rules = getBridge().customRules();
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

export function cardVisualStyle(visual: CardVisual): string {
  const parts: string[] = [];
  if (visual.topColor) parts.push(`--card-top-color:${visual.topColor}`);
  return parts.length ? ` style="${parts.join(";")}"` : "";
}

export function cardFormulaStyle(id: CardId, visual: CardVisual): string {
  if (visual.ionColor) return ` style="color:${escapeAttr(visual.ionColor)}"`;
  const game = getBridge().game();
  return game && isCustomGame(game) ? "" : coloredIonStyle(id);
}

export function customCardDescription(id: CardId): string | undefined {
  const rules = getBridge().customRules();
  if (!rules || Object.prototype.hasOwnProperty.call(CARDS, id)) return undefined;
  const def = rules.cards[id];
  if (!def || def.type === "ion" || !def.description?.trim()) return undefined;
  return def.description.trim();
}

export function cardDescriptionAttributes(id: CardId, key: string): string {
  const description = customCardDescription(id);
  return description
    ? ` data-card-description="${escapeAttr(description)}" data-card-description-key="${escapeAttr(key)}"`
    : "";
}

export function renderCard(card: CardId | CardInstance, clickable = false, extraClass = "", handIndex?: number, badge?: string): string {
  if (card === "__hidden__" || (typeof card !== "string" && card.cardId === "__hidden__")) return `<div class="card hidden"><span class="formula">?</span><span class="kind">牌背</span></div>`;
  const bridge = getBridge();
  const selectedHandIndex = bridge.selectedHandIndex();
  const selectedCard = bridge.selectedCard();
  const id = cardIdOf(card);
  const visual = cardVisual(id);
  const selected = clickable && selectedHandIndex === handIndex ? "selected" : "";
  const sameHint = clickable && selectedHandIndex !== null && selectedHandIndex !== handIndex && selectedCard === id ? "same-card-hint" : "";
  // AI 建议指向这张牌时加一圈紫色边缘。只在手牌路径求值：solution 区、生成物、悬浮窗预览那几处
  // 调用都不传 handIndex，自动跳过（见 renderCard 的各个调用点）。
  const aiSuggested = clickable && handIndex !== undefined ? bridge.aiSuggestedCardClass(id) : "";
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
  return `<button class="card ${visual.cls} ${selected} ${sameHint} ${extraClass} ${aiSuggested} ${lifeBadge ? "has-uranium-life" : ""} ${description ? "has-description" : ""}"${cardVisualStyle(visual)} ${interactionAttrs}${descriptionAttrs}>
    <span class="card-badges">
    ${lifeBadge ? `<span class="card-badge uranium-life" title="还能触发 ${escapeAttr(lifeBadge.replace(/\D/g, ""))} 次辐射摸牌">${escapeHtml(lifeBadge)}</span>` : ""}
    ${markBadge}
    </span>
    <span class="formula"${cardFormulaStyle(id, visual)}>${visual.formula}</span>
    <span class="kind">${visual.kind}</span>
  </button>`;
}

/** 手牌展示顺序：自定义规则用规则里的排序器，经典模式用 compareHandCards。 */
export function handDisplayCompare(): (a: CardId, b: CardId) => number {
  const rules = getBridge().customRules();
  return rules ? displayOrderComparator(rules) : compareHandCards;
}

/** 把手牌按展示顺序排好，再把同名牌合并成「一摞」。 */
export function buildHandDisplayGroups(hand: readonly (CardId | CardInstance)[]): HandDisplayGroup[] {
  const rules = getBridge().customRules();
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

/** 整摞牌：单张时退回 renderCard，多张时输出带错位层的 .card-stack。 */
export function renderHandStack(group: HandDisplayGroup, animatedDrawCount: number, handLength: number): string {
  const { card, indices } = group;
  const selectedHandIndex = getBridge().selectedHandIndex();
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
  // 整摞加紫框（已确认的方案：框住整叠、含后面错开的几张，而不是只标最上面那张）。
  return `<button class="card-stack ${visual.cls} ${description ? "has-description" : ""} ${getBridge().aiSuggestedCardClass(card)}" style="--stack-size:${count}${visual.topColor ? `;--card-top-color:${visual.topColor}` : ""}" data-card="${escapeAttr(card)}" data-card-index="${toggleIndex}"${descriptionAttrs}>
    ${layers}
    <span class="card ${visual.cls} ${selected} ${dealing} stack-top">
      <span class="card-badges">${markBadge}</span>
      <span class="stack-count">${count}×</span>
      <span class="formula"${cardFormulaStyle(card, visual)}>${visual.formula}</span>
      <span class="kind">${visual.kind}</span>
    </span>
  </button>`;
}
