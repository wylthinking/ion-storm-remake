/**
 * 规则编辑器（S3 后半）。
 *
 * 从 app.ts 搬出来的「自定义规则」界面：只读规则摘要、房间规则弹窗、规则编辑器的六个页签、
 * 显示顺序编辑、新建卡牌，以及「自定义模式设置」（规则预设列表 + 全局自定义模式额度）。
 *
 * 与原实现的行为完全一致，只是 HTML 生成不再读 app.ts 的模块级变量，改走 context：
 *   currentViewableRules()     ← 原来是直接调用 app.ts 的 currentViewableRules()
 *   room() / game()            ← 原来是直接读 room / game
 *   customPresetsSnapshot()    ← 原来是直接读 customPresetsSnapshot
 *   customModeLimitsSnapshot() ← 原来是直接读 customModeLimitsSnapshot
 * 其余依赖全是 import 进来的纯函数与常量（包括 NEW_CARD_* 与 customCardCategory*，它们
 * 一并搬到了 cards.ts），所以模板一个字都没改。
 *
 * 只服务于规则编辑的纯函数也一起搬了过来：draftDisplayOrder 等 app.ts 仍要用，所以是 export；
 * setupRangeText / renderDisplayOrderItem / playerOverrideResultDiffers 之类只有本模块用的保持私有。
 */
import { PLATFORM_PRESET } from "../shared/generated/custom-json.generated.js";
import {
  customDeckForPlayerCount,
  customInitialHandForPlayerCount,
  customUniformDealTemplate,
  defaultTopColor,
  displayOrderComparator,
  effectiveDisplayOrder,
  materializeCustomCardFollowRules,
  type CustomCardDef,
  type CustomDealSeatRule,
  type ResolvedCustomRules,
} from "../shared/custom-rules-types.js";
import { defaultCustomModeLimits, setupPlayersRange } from "../shared/custom-limits.js";
import { stableStringify } from "../shared/stable-json.js";
import {
  CUSTOM_CARD_TYPE_LABELS,
  NEW_CARD_CATEGORIES,
  NEW_CARD_CATEGORY_LABELS,
  customCardCategoryKey,
  customCardCategoryLabel,
  newCardCategoryDefaults,
} from "./cards.js";
import { getBridge } from "./context.js";
import { renderCustomModeLimitFields } from "./dialogs.js";
import { escapeAttr, escapeHtml } from "./dom.js";
import { formatDate } from "./format.js";
import type { DialogState, PlayerDeckOverride, RulesDraft, RulesEditorTab } from "./types.js";

/** 规则草稿的显示顺序比较器；只在规则编辑器内部用。 */
function draftOrderCompare(draft: RulesDraft): (a: string, b: string) => number {
  return displayOrderComparator({ cards: draft.cards, display: draft.display });
}

/** 规则草稿的显示顺序：编辑器渲染要用，app.ts 打开「编辑显示顺序」时也要用，所以 export。 */
export function draftDisplayOrder(draft: RulesDraft): string[] {
  return effectiveDisplayOrder({ cards: draft.cards, display: draft.display });
}

function renderDisplayOrderItem(def: CustomCardDef | undefined, id: string, index: number, options: { draggable?: boolean } = {}): string {
  const color = def ? defaultTopColor(def) : "#c3cad1";
  const category = def ? customCardCategoryKey(def) : "unknown";
  const draggable = Boolean(options.draggable);
  return `<div class="display-order-item ${draggable ? "" : "readonly"}" ${draggable ? `draggable="true" data-card-id="${escapeAttr(id)}"` : ""}><span class="order-color" style="background:${escapeAttr(color)}"></span>${draggable ? `<span class="drag-handle">☰</span>` : ""}<span class="order-index">${index + 1}</span><span class="order-name">${escapeHtml(def?.displayName ?? id)}</span><small class="order-cat cat-${escapeAttr(category)}">${escapeHtml(def ? customCardCategoryLabel(def) : "未定义")}</small></div>`;
}

export function renderCustomPresetsDialog(state: Extract<DialogState, { kind: "custom-presets" }>): string {
  const presets = getBridge().customPresetsSnapshot() ?? [];
  const form = state.form;
  const limits = getBridge().customModeLimitsSnapshot() ?? defaultCustomModeLimits();
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

export function renderViewRoomRulesDialog(state: Extract<DialogState, { kind: "view-room-rules" }>): string {
  const bridge = getBridge();
  const rules = bridge.currentViewableRules();
  return `
    <div class="modal-backdrop">
      <section class="modal panel room-edit-dialog rules-view-dialog">
        <div class="modal-head"><div><span class="dialog-kicker">自定义模式</span><h2>房间规则设置</h2></div><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${rules
      ? renderRulesSummary(rules, state.selectedCardId, bridge.room()?.capacity ?? bridge.game()?.players.length)
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

export function hasPlayerSpecificDeck(draft: RulesDraft): boolean {
  return playerOverrideResultDiffers(draft, draft.deck.cards, (players) => deckOverrideForPlayers(draft, players)?.cards ?? draft.deck.cards);
}

export function hasPlayerSpecificInitialHand(draft: RulesDraft): boolean {
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

export function hasPlayerSpecificDealOrInitialHand(draft: RulesDraft): boolean {
  return (!customUniformDealTemplate(draft) && playerOverrideResultDiffers(draft, draft.deck.deal ?? null, (players) => deckOverrideForPlayers(draft, players)?.deal ?? draft.deck.deal ?? null))
    || hasPlayerSpecificInitialHand(draft);
}

export function setUniformDealTemplate(draft: RulesDraft, template: CustomDealSeatRule): void {
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

export function stopUsingUniformDeal(draft: RulesDraft): void {
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

export function updateVisualDealRule(draft: RulesDraft, seat: number, update: (rule: CustomDealSeatRule) => void): void {
  const uniform = customUniformDealTemplate(draft);
  if (uniform) {
    update(uniform);
    setUniformDealTemplate(draft, uniform);
    return;
  }
  const rule = draft.deck.deal?.[seat];
  if (rule) update(rule);
}

export function visualDeckEditorLocked(state: Extract<DialogState, { kind: "rules-editor" }>, tab: "deck" | "deal"): boolean {
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

export function renderRulesEditorDialog(state: Extract<DialogState, { kind: "rules-editor" }>): string {
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

export function renderRulesDisplayOrderDialog(state: Extract<DialogState, { kind: "rules-display-order" }>): string {
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

export function renderRulesCardCreateDialog(state: Extract<DialogState, { kind: "rules-card-create" }>): string {
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
