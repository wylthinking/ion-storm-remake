import { FormulaError, tryCompileFormula } from "./custom-formula.js";
import { deepFreeze } from "./stable-json.js";
import {
  CUSTOM_CARD_TYPES,
  CUSTOM_LIMITS,
  CUSTOM_OPS,
  CUSTOM_REACTION_KINDS,
  CUSTOM_RULES_VERSION,
  canonicalCustomRulesHash,
  customUniformDealTemplate,
  type CustomCardDef,
  type CustomComboDef,
  type CustomDisplay,
  type CustomEventListenerRule,
  type CustomRulesSource,
  type CustomStep,
  type CustomWhereClause,
  type ResolvedCustomRules,
} from "./custom-rules-types.js";
import { mergeRulesDocuments, type MergedRulesDocument } from "./custom-rules-merge.js";
import { PLATFORM_PRESET } from "./generated/custom-json.generated.js";
import type { CustomRemoveCause } from "./types.js";

export class CustomRulesError extends Error {}

function documentByteLength(value: unknown, path: string): number {
  let normalized: string | undefined;
  try {
    normalized = JSON.stringify(value);
  } catch (error) {
    throw new CustomRulesError(`${path}: 规则必须能序列化为 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (normalized === undefined) throw new CustomRulesError(`${path}: 规则必须能序列化为 JSON`);
  return new TextEncoder().encode(normalized).length;
}

function assertDocumentByteLimit(value: unknown, path: string): void {
  if (documentByteLength(value, path) > CUSTOM_LIMITS.maxDocumentBytes) {
    throw new CustomRulesError(`${path}: 规则 JSON 超过 ${CUSTOM_LIMITS.maxDocumentBytes} 字节`);
  }
}

function decodedAudioByteLength(dataUrl: string, path: string): number {
  const match = /^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new CustomRulesError(`${path}: 必须是 data:audio/...;base64, 格式`);
  const mime = match[1].toLowerCase();
  if (!CUSTOM_LIMITS.allowedAudioMime.includes(mime)) throw new CustomRulesError(`${path}: MIME "${mime}" 不在白名单`);
  const body = match[2].replace(/\s/g, "");
  if (body.length === 0 || body.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw new CustomRulesError(`${path}: Base64 无法解码`);
  }
  try {
    if (typeof atob === "function") return atob(body).length;
    if (typeof Buffer !== "undefined") return Buffer.from(body, "base64").byteLength;
  } catch {
    throw new CustomRulesError(`${path}: Base64 无法解码`);
  }
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return (body.length / 4) * 3 - padding;
}

export interface CustomPresetEntry {
  source: string | CustomRulesSource;
  revision?: number;
}

export interface CustomPresetProvider {
  get(presetId: string): CustomPresetEntry | undefined;
}

const EVENT_WHENS = ["turn.started", "self.removed", "marked.removed", "marked.reacted", "card.playedBatch"] as const;
const REMOVE_CAUSES: CustomRemoveCause[] = ["reaction", "operation", "rule", "other"];
const REACTION_RESULTS = ["solid", "gas", "micro", "weak", "nonexistent", "water"];
const EVENT_PHASES = ["afterOperationPrimaryEffect"];
const CHOICE_REFS = ["self.hand", "players.other"];
const MOVE_TO_REFS = ["field.solution", "field.products", "discard"];
const REMOVE_FROM_REFS = ["field", "field.solution", "field.products", "self.hand", "player.hand"];
const REMOVE_TO_REFS = ["discard"];
const TARGET_REFS = ["self", "all", "minHand", "event.actor", "event.turnPlayer", "owner", "next", "choose:other"];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REAGENT_VARIABLE_REF = /^[A-Za-z_][A-Za-z0-9_]*\.name$/;

function fail(path: string, message: string): never {
  throw new CustomRulesError(`${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, `不允许的字段 "${key}"`);
  }
}

function assertString(value: unknown, path: string, label: string, maxLength = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) fail(path, `${label}必须是 1-${maxLength} 字符的字符串`);
  return value;
}

function assertInt(value: unknown, path: string, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `${label}必须是 ${min}-${max} 的整数`);
  }
  return value as number;
}

function assertBoolean(value: unknown, path: string, label: string): boolean {
  if (typeof value !== "boolean") fail(path, `${label}必须是布尔值`);
  return value;
}

function assertFormula(value: unknown, path: string, label: string): string | number {
  if (typeof value !== "string" && typeof value !== "number") fail(path, `${label}必须是数字或公式字符串`);
  try {
    tryCompileFormula(value);
  } catch (error) {
    fail(path, `${label}公式非法：${error instanceof FormulaError ? error.message : String(error)}`);
  }
  return value;
}

function assertTargetRef(value: unknown, path: string, label: string): string {
  const ref = assertString(value, path, label);
  if ((TARGET_REFS as readonly string[]).includes(ref) || IDENT.test(ref)) return ref;
  fail(path, `${label}引用了未知目标 "${ref}"`);
}

function assertRef(value: unknown, allowed: readonly string[], path: string, label: string): string {
  const ref = assertString(value, path, label);
  if (allowed.includes(ref)) return ref;
  fail(path, `${label}引用了未知区域 "${ref}"`);
}

function assertSetupValue(value: unknown, path: string, label: string, min: number, max: number): void {
  if (typeof value === "number") {
    assertInt(value, path, label, min, max);
    return;
  }
  if (Array.isArray(value) && value.length === 2) {
    const [a, b] = value;
    assertInt(a, path, `${label} 下限`, min, max);
    assertInt(b, path, `${label} 上限`, min, max);
    if (a > b) fail(path, `${label} 下限不能大于上限`);
    return;
  }
  fail(path, `${label}必须是整数或 [min,max]`);
}

function validateWhere(where: unknown, path: string): void {
  if (!isRecord(where)) fail(path, "where 必须是对象");
  assertKeys(where, ["type", "kind", "colored", "flameTest", "name", "reactsWith", "playableTo", "contains", "any"], path);
  if (where.type !== undefined && !(CUSTOM_CARD_TYPES as readonly string[]).includes(where.type as string)) {
    fail(path, `未知卡牌类型 "${String(where.type)}"`);
  }
  if (where.kind !== undefined) {
    const kinds = Array.isArray(where.kind) ? where.kind : [where.kind];
    for (const kind of kinds) {
      if (!(CUSTOM_REACTION_KINDS as readonly string[]).includes(kind as string)) fail(path, `未知反应类型 "${String(kind)}"`);
    }
  }
  if (where.colored !== undefined) assertBoolean(where.colored, path, "colored");
  if (where.flameTest !== undefined) assertBoolean(where.flameTest, path, "flameTest");
  if (where.name !== undefined) {
    if (typeof where.name === "string") assertString(where.name, path, "name");
    else if (isRecord(where.name)) {
      assertKeys(where.name, ["not"], path);
      assertString(where.name.not, path, "name.not");
    } else fail(path, "name 必须是字符串或 {not}");
  }
  if (where.reactsWith !== undefined) assertString(where.reactsWith, path, "reactsWith", 64);
  if (where.playableTo !== undefined && where.playableTo !== "field") fail(path, `未知 playableTo "${String(where.playableTo)}"`);
  if (where.contains !== undefined) validateWhere(where.contains, `${path}.contains`);
  if (where.any !== undefined) {
    if (!Array.isArray(where.any) || where.any.length === 0) fail(path, "any 必须是非空数组");
    where.any.forEach((item, index) => validateWhere(item, `${path}.any[${index}]`));
  }
}

function validateListeners(listeners: unknown, path: string, depth: number): void {
  if (!Array.isArray(listeners)) fail(path, "on 必须是数组");
  if (listeners.length > CUSTOM_LIMITS.maxMarkListenersPerCard) fail(path, "事件监听器数量超限");
  for (const [index, listener] of listeners.entries()) {
    const sub = `${path}[${index}]`;
    if (!isRecord(listener)) fail(sub, "监听器必须是对象");
    assertKeys(listener, ["when", "where", "while", "phase", "do"], sub);
    if (!(EVENT_WHENS as readonly string[]).includes(listener.when as string)) fail(sub, `未知事件 when "${String(listener.when)}"`);
    if (listener.where !== undefined) {
      if (!isRecord(listener.where)) fail(sub, "where 必须是对象");
      assertKeys(listener.where, ["cause", "reactionResult", "name"], sub);
      if (listener.where.cause !== undefined) {
        const causes = Array.isArray(listener.where.cause) ? listener.where.cause : [listener.where.cause];
        for (const cause of causes) {
          if (!REMOVE_CAUSES.includes(cause as CustomRemoveCause)) fail(sub, `未知 cause "${String(cause)}"`);
        }
      }
      if (listener.where.reactionResult !== undefined) {
        const results = Array.isArray(listener.where.reactionResult) ? listener.where.reactionResult : [listener.where.reactionResult];
        for (const result of results) {
          if (!REACTION_RESULTS.includes(result as string)) fail(sub, `未知 reactionResult "${String(result)}"`);
        }
      }
      if (listener.where.name !== undefined) assertString(listener.where.name, sub, "where.name");
    }
    if (listener.while !== undefined) {
      if (listener.while !== "self.onField") fail(sub, `未知 while "${String(listener.while)}"`);
    }
    if (listener.phase !== undefined && !EVENT_PHASES.includes(listener.phase as string)) {
      fail(sub, `未知 phase "${String(listener.phase)}"`);
    }
    validateSteps(listener.do, `${sub}.do`, depth);
  }
}

function validateSteps(steps: unknown, path: string, depth: number): void {
  if (!Array.isArray(steps)) fail(path, "steps 必须是数组");
  if (depth > CUSTOM_LIMITS.maxIfDepth) fail(path, `if 嵌套深度超过 ${CUSTOM_LIMITS.maxIfDepth}`);
  if (steps.length > CUSTOM_LIMITS.maxStepsPerCard) fail(path, `steps 数量超过 ${CUSTOM_LIMITS.maxStepsPerCard}`);
  for (const [index, step] of steps.entries()) {
    validateStep(step, `${path}[${index}]`, depth);
  }
}

function validateStep(step: unknown, path: string, depth: number): void {
  if (!isRecord(step)) fail(path, "step 必须是对象");
  if (!(CUSTOM_OPS as readonly string[]).includes(step.op as string)) fail(path, `未知 op "${String(step.op)}"`);
  switch (step.op as (typeof CUSTOM_OPS)[number]) {
    case "action":
      assertKeys(step, ["op", "to", "add"], path);
      assertTargetRef(step.to, path, "to");
      assertFormula(step.add, path, "add");
      break;
    case "audio":
      assertKeys(step, ["op", "id", "to", "oncePer"], path);
      assertString(step.id, path, "id", CUSTOM_LIMITS.maxAudioKeyLength);
      assertTargetRef(step.to, path, "to");
      if (step.oncePer !== undefined && step.oncePer !== "event") fail(path, `未知 oncePer "${String(step.oncePer)}"`);
      break;
    case "cancelDraw":
      assertKeys(step, ["op", "next", "skip"], path);
      if (step.next !== undefined) assertFormula(step.next, path, "next");
      if (step.skip !== undefined) assertTargetRef(step.skip, path, "skip");
      break;
    case "choose":
      assertKeys(step, ["op", "from", "where", "mode", "count", "as", "empty"], path);
      if (!CHOICE_REFS.includes(assertString(step.from, path, "from"))) fail(path, `from 引用了未知选择来源 "${String(step.from)}"`);
      if (step.where !== undefined) validateWhere(step.where, `${path}.where`);
      if (step.mode !== undefined && step.mode !== "kind+count") fail(path, `未知 choose mode "${String(step.mode)}"`);
      if (step.count !== undefined) assertInt(step.count, path, "count", 1, 130);
      if (!IDENT.test(assertString(step.as, path, "as", 64))) fail(path, "as 必须是合法标识符");
      if (step.empty !== undefined && step.empty !== "stop" && step.empty !== "illegal") fail(path, `未知 empty "${String(step.empty)}"`);
      break;
    case "counter":
      assertKeys(step, ["op", "target", "name", "add"], path);
      assertTargetRef(step.target, path, "target");
      if (!IDENT.test(assertString(step.name, path, "name", 64))) fail(path, "counter name 必须是合法标识符");
      assertFormula(step.add, path, "add");
      break;
    case "draw":
      assertKeys(step, ["op", "to", "n", "start", "scoreTo"], path);
      assertTargetRef(step.to, path, "to");
      assertFormula(step.n, path, "n");
      if (step.start !== undefined) assertTargetRef(step.start, path, "start");
      if (step.scoreTo !== undefined) assertTargetRef(step.scoreTo, path, "scoreTo");
      break;
    case "drawFlow":
      assertKeys(step, ["op", "n", "perPlayerCap", "scoreTo", "follow"], path);
      assertFormula(step.n, path, "n");
      if (step.perPlayerCap !== undefined) assertInt(step.perPlayerCap, path, "perPlayerCap", 1, CUSTOM_LIMITS.maxDynamicDraw);
      if (step.scoreTo !== undefined) assertTargetRef(step.scoreTo, path, "scoreTo");
      if (step.follow !== undefined) assertBoolean(step.follow, path, "follow");
      break;
    case "drawWhere":
      assertKeys(step, ["op", "from", "to", "where", "pick", "recycleDiscard", "excludeSourceCard", "as", "scoreTo", "empty"], path);
      if (step.from !== "deck") fail(path, `drawWhere 只支持 from:"deck"`);
      assertTargetRef(step.to, path, "to");
      if (step.where !== undefined) validateWhere(step.where, `${path}.where`);
      if (!/^random:(\d+)$/.test(assertString(step.pick, path, "pick", 32))) fail(path, `pick 必须是 "random:N"`);
      if (step.recycleDiscard !== undefined) assertBoolean(step.recycleDiscard, path, "recycleDiscard");
      if (step.excludeSourceCard !== undefined) assertBoolean(step.excludeSourceCard, path, "excludeSourceCard");
      if (!IDENT.test(assertString(step.as, path, "as", 64))) fail(path, "as 必须是合法标识符");
      if (step.scoreTo !== undefined) assertTargetRef(step.scoreTo, path, "scoreTo");
      if (step.empty !== undefined && step.empty !== "stop" && step.empty !== "illegal") fail(path, `未知 empty "${String(step.empty)}"`);
      break;
    case "flushDeferred":
      assertKeys(step, ["op", "from", "scoreTo"], path);
      if (!IDENT.test(assertString(step.from, path, "from", 64))) fail(path, "from 必须是合法标识符");
      if (step.scoreTo !== undefined) assertTargetRef(step.scoreTo, path, "scoreTo");
      break;
    case "if":
      assertKeys(step, ["op", "test", "then", "else"], path);
      assertFormula(step.test, path, "test");
      validateSteps(step.then, `${path}.then`, depth + 1);
      if (step.else !== undefined) validateSteps(step.else, `${path}.else`, depth + 1);
      break;
    case "inspect":
      assertKeys(step, ["op", "player", "revealTo", "cases", "empty"], path);
      assertTargetRef(step.player, path, "player");
      assertTargetRef(step.revealTo, path, "revealTo");
      if (!Array.isArray(step.cases) || step.cases.length === 0) fail(path, "cases 必须是非空数组");
      for (const [index, item] of step.cases.entries()) {
        if (!isRecord(item)) fail(`${path}.cases[${index}]`, "case 必须是对象");
        assertKeys(item, ["where", "show"], `${path}.cases[${index}]`);
        validateWhere(item.where, `${path}.cases[${index}].where`);
        if (item.show !== "distinctDisplayNames") fail(`${path}.cases[${index}]`, `未知 show "${String(item.show)}"`);
      }
      if (step.empty !== undefined) assertString(step.empty, path, "empty", 100);
      break;
    case "move":
      assertKeys(step, ["op", "cards", "to"], path);
      if (!IDENT.test(assertString(step.cards, path, "cards", 64))) fail(path, "cards 必须是合法变量名");
      assertRef(step.to, MOVE_TO_REFS, path, "to");
      break;
    case "play":
      assertKeys(step, ["op", "card", "consumeAction", "mark"], path);
      if (!IDENT.test(assertString(step.card, path, "card", 64))) fail(path, "card 必须是合法变量名");
      if (step.consumeAction !== undefined) assertBoolean(step.consumeAction, path, "consumeAction");
      if (step.mark !== undefined) {
        const mark = step.mark;
        if (!isRecord(mark)) fail(path, "mark 必须是对象");
        assertKeys(mark, ["name", "owner", "badge", "reactionPriority", "on"], path);
        if (!IDENT.test(assertString(mark.name, path, "mark.name", 64))) fail(path, "mark.name 必须是合法标识符");
        if (mark.owner !== undefined) assertTargetRef(mark.owner, path, "mark.owner");
        if (mark.badge !== undefined) assertString(mark.badge, path, "mark.badge", 40);
        if (mark.reactionPriority !== undefined) assertInt(mark.reactionPriority, path, "mark.reactionPriority", -100, 100);
        if (mark.on !== undefined) validateListeners(mark.on, `${path}.mark.on`, depth);
      }
      break;
    case "pot":
      assertKeys(step, ["op", "mul", "creditTo"], path);
      assertFormula(step.mul, path, "mul");
      if (step.creditTo !== undefined) assertTargetRef(step.creditTo, path, "creditTo");
      break;
    case "reactSweep":
      assertKeys(step, ["op", "reagent", "virtual", "mode", "repeat", "as"], path);
      assertString(step.reagent, path, "reagent", 64);
      if (step.virtual !== undefined) assertBoolean(step.virtual, path, "virtual");
      if (step.mode !== undefined && step.mode !== "enough") fail(path, `未知 reactSweep mode "${String(step.mode)}"`);
      if (step.repeat !== undefined && step.repeat !== "stable") fail(path, `未知 reactSweep repeat "${String(step.repeat)}"`);
      if (!IDENT.test(assertString(step.as, path, "as", 64))) fail(path, "as 必须是合法标识符");
      break;
    case "remove":
      assertKeys(step, ["op", "from", "target", "where", "to", "cause", "as", "deferCardTriggers"], path);
      if (step.from !== undefined && !REMOVE_FROM_REFS.includes(assertString(step.from, path, "from"))) {
        fail(path, `from 引用了未知移除来源 "${String(step.from)}"`);
      }
      if (step.target !== undefined) assertTargetRef(step.target, path, "target");
      if (step.from === "player.hand" && step.target === undefined) fail(path, `from:"player.hand" 必须同时指定 target`);
      if (step.where !== undefined) validateWhere(step.where, `${path}.where`);
      assertRef(step.to, REMOVE_TO_REFS, path, "to");
      if (!REMOVE_CAUSES.includes(step.cause as CustomRemoveCause)) fail(path, `未知 cause "${String(step.cause)}"`);
      if (step.as !== undefined && !IDENT.test(assertString(step.as, path, "as", 64))) fail(path, "as 必须是合法标识符");
      if (step.deferCardTriggers !== undefined) assertBoolean(step.deferCardTriggers, path, "deferCardTriggers");
      break;
    case "reverse":
      assertKeys(step, ["op"], path);
      break;
    case "score":
      assertKeys(step, ["op", "to", "add"], path);
      assertTargetRef(step.to, path, "to");
      assertFormula(step.add, path, "add");
      break;
    case "skip":
      assertKeys(step, ["op", "player", "stack"], path);
      assertTargetRef(step.player, path, "player");
      if (step.stack !== undefined) assertBoolean(step.stack, path, "stack");
      break;
  }
}

function validateAudio(audio: unknown, path: string): void {
  if (!isRecord(audio)) fail(path, "audio 必须是对象");
  let total = 0;
  for (const [key, value] of Object.entries(audio)) {
    if (key.length > CUSTOM_LIMITS.maxAudioKeyLength) fail(path, `音频 key "${key}" 过长`);
    const dataUrl = assertString(value, path, `audio.${key}`, CUSTOM_LIMITS.maxAudioBytesPerCard * 2);
    const match = /^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
    if (!match) fail(path, `audio.${key} 必须是 data:audio/...;base64, 格式`);
    const mime = match[1].toLowerCase();
    if (!CUSTOM_LIMITS.allowedAudioMime.includes(mime)) fail(path, `audio.${key} 的 MIME "${mime}" 不在白名单`);
    const decoded = decodedAudioByteLength(dataUrl, `${path}.${key}`);
    if (decoded > CUSTOM_LIMITS.maxAudioBytesPerCard) fail(path, `audio.${key} 解码后超过单音频大小限制`);
    total += decoded;
  }
  if (total > CUSTOM_LIMITS.maxAudioBytesPerCard) fail(path, `单卡音频总大小超过 ${CUSTOM_LIMITS.maxAudioBytesPerCard}`);
}

function validateAudioStepReferences(value: unknown, audio: Record<string, unknown>, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateAudioStepReferences(entry, audio, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  if (value.op === "audio" && typeof value.id === "string" && !Object.prototype.hasOwnProperty.call(audio, value.id)) {
    fail(path, `audio step 引用了当前卡牌未定义的音频 "${value.id}"`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "audio") continue;
    validateAudioStepReferences(entry, audio, `${path}.${key}`);
  }
}

function visitReactSweepReagents(
  value: unknown,
  path: string,
  visitor: (reagent: string, path: string) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitReactSweepReagents(entry, `${path}[${index}]`, visitor));
    return;
  }
  if (!isRecord(value)) return;
  if (value.op === "reactSweep" && typeof value.reagent === "string") visitor(value.reagent, `${path}.reagent`);
  for (const [key, entry] of Object.entries(value)) visitReactSweepReagents(entry, `${path}.${key}`, visitor);
}

function validateDirectCardReferences(value: unknown, defined: ReadonlySet<string>, path: string): void {
  visitReactSweepReagents(value, path, (reagent, reagentPath) => {
    if (!defined.has(reagent) && !REAGENT_VARIABLE_REF.test(reagent)) {
      fail(reagentPath, `引用了未定义的卡牌 "${reagent}"`);
    }
  });
}

function validateCard(id: string, def: unknown, path: string): void {
  if (!isRecord(def)) fail(path, "卡牌定义必须是对象");
  if (!(CUSTOM_CARD_TYPES as readonly string[]).includes(def.type as string)) {
    fail(path, `未知卡牌类型 "${String(def.type)}"`);
  }
  assertString(def.displayName, path, "displayName", 40);
  if (def.description !== undefined && (typeof def.description !== "string" || def.description.length > 500)) {
    fail(path, "description 必须是最多 500 字符的字符串");
  }
  if (def.topColor !== undefined) {
    if (typeof def.topColor !== "string" || !HEX_COLOR.test(def.topColor)) fail(path, "topColor 必须是 #RRGGBB");
  }
  if (def.audio !== undefined) validateAudio(def.audio, `${path}.audio`);
  if (def.follow !== undefined) assertBoolean(def.follow, path, "follow");
  if (def.counterAnyFollow !== undefined) assertBoolean(def.counterAnyFollow, path, "counterAnyFollow");
  if (def.counter !== undefined) validateSteps(def.counter, `${path}.counter`, 0);
  switch (def.type as (typeof CUSTOM_CARD_TYPES)[number]) {
    case "ion": {
      assertKeys(def, ["type", "displayName", "description", "topColor", "audio", "follow", "counterAnyFollow", "counter", "charge", "reactions", "color", "flameTest"], path);
      assertInt(def.charge, path, "charge", -7, 7);
      if (def.charge === 0) fail(path, "离子 charge 不能为 0");
      if (def.color !== undefined) {
        if (typeof def.color !== "string" || !HEX_COLOR.test(def.color)) fail(path, "color 必须是 #RRGGBB");
      }
      if (def.flameTest !== undefined) assertBoolean(def.flameTest, path, "flameTest");
      if (def.reactions !== undefined) {
        if (!isRecord(def.reactions)) fail(path, "reactions 必须是对象");
        assertKeys(def.reactions, CUSTOM_REACTION_KINDS, `${path}.reactions`);
        for (const kind of CUSTOM_REACTION_KINDS) {
          const list = def.reactions[kind];
          if (list === undefined) continue;
          if (!Array.isArray(list)) fail(`${path}.reactions.${kind}`, "必须是被反应离子 ID 数组");
          for (const [index, target] of list.entries()) {
            assertString(target, `${path}.reactions.${kind}[${index}]`, "反应目标", 64);
          }
        }
      }
      break;
    }
    case "special": {
      assertKeys(def, ["type", "displayName", "description", "topColor", "audio", "follow", "counterAnyFollow", "counter", "play", "on"], path);
      if (def.play !== undefined) {
        if (!isRecord(def.play)) fail(path, "play 必须是对象");
        assertKeys(def.play, ["to", "inert", "counter"], `${path}.play`);
        if (def.play.to !== "field.products") fail(path, `special play.to 只支持 field.products`);
        if (def.play.inert !== undefined) assertBoolean(def.play.inert, path, "play.inert");
        if (def.play.counter !== undefined) {
          if (!isRecord(def.play.counter)) fail(path, "play.counter 必须是对象");
          assertKeys(def.play.counter, ["name", "value", "badge"], `${path}.play.counter`);
          if (!IDENT.test(assertString(def.play.counter.name, path, "counter.name", 64))) fail(path, "counter.name 必须是合法标识符");
          assertInt(def.play.counter.value, path, "counter.value", 0, 99);
          if (def.play.counter.badge !== undefined) assertString(def.play.counter.badge, path, "counter.badge", 40);
        }
      }
      if (def.on !== undefined) validateListeners(def.on, `${path}.on`, 0);
      break;
    }
    case "operation":
    case "generic": {
      assertKeys(def, ["type", "displayName", "description", "topColor", "audio", "follow", "counterAnyFollow", "consume", "steps", "counter"], path);
      if (def.consume !== undefined && def.consume !== "hold") fail(path, `未知 consume "${String(def.consume)}"`);
      if (def.steps !== undefined) validateSteps(def.steps, `${path}.steps`, 0);
      break;
    }
  }
  validateAudioStepReferences(def, isRecord(def.audio) ? def.audio : {}, path);
}

function validateCombo(id: string, combo: unknown, path: string): void {
  if (!isRecord(combo)) fail(path, "combo 必须是对象");
  assertKeys(combo, ["requires", "displayName", "follow", "counterAnyFollow", "steps", "counter"], path);
  if (!isRecord(combo.requires) || Object.keys(combo.requires).length === 0) fail(path, "combo.requires 必须是非空对象");
  for (const [cardId, count] of Object.entries(combo.requires)) {
    assertString(cardId, path, "requires 卡牌", 64);
    assertInt(count, path, `requires.${cardId}`, 1, 130);
  }
  if (combo.displayName !== undefined) assertString(combo.displayName, path, "displayName", 40);
  if (combo.follow !== undefined) assertBoolean(combo.follow, path, "follow");
  if (combo.counterAnyFollow !== undefined) assertBoolean(combo.counterAnyFollow, path, "counterAnyFollow");
  if (combo.steps !== undefined) validateSteps(combo.steps, `${path}.steps`, 0);
  if (combo.counter !== undefined) validateSteps(combo.counter, `${path}.counter`, 0);
}

function loadSourceDocument(raw: string | unknown, path: string): CustomRulesSource {
  let value = raw;
  if (typeof raw === "string") {
    if (new TextEncoder().encode(raw).length > CUSTOM_LIMITS.maxDocumentBytes) {
      fail(path, `规则 JSON 超过 ${CUSTOM_LIMITS.maxDocumentBytes} 字节`);
    }
    try {
      value = JSON.parse(raw);
    } catch (error) {
      fail(path, `JSON 语法错误：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isRecord(value)) fail(path, "规则文档必须是 JSON 对象");
  assertDocumentByteLimit(value, path);
  assertKeys(value, ["version", "name", "displayName", "description", "preset", "setup", "cards", "combos", "deck", "display"], path);
  if (value.version !== CUSTOM_RULES_VERSION) {
    fail(path, `不支持的规则版本 ${String(value.version)}，当前仅支持 version=${CUSTOM_RULES_VERSION}`);
  }
  assertString(value.name, path, "name", 80);
  if (!IDENT.test(value.name as string)) fail(path, "name 必须是合法标识符");
  if (value.displayName !== undefined) assertString(value.displayName, path, "displayName", 80);
  if (value.description !== undefined) assertString(value.description, path, "description", 400);
  if (value.preset !== undefined) assertString(value.preset, path, "preset", 80);
  if (value.setup !== undefined && !isRecord(value.setup)) fail(path, "setup 必须是对象");
  if (value.cards !== undefined && !isRecord(value.cards)) fail(path, "cards 必须是对象");
  if (value.combos !== undefined && !isRecord(value.combos)) fail(path, "combos 必须是对象");
  if (value.deck !== undefined) {
    if (!isRecord(value.deck)) fail(path, "deck 必须是对象");
    assertKeys(value.deck, ["cards", "deal", "byPlayers"], `${path}.deck`);
    if (value.deck.cards !== undefined && !isRecord(value.deck.cards)) fail(path, "deck.cards 必须是对象");
    if (value.deck.deal !== undefined && value.deck.deal !== null && !Array.isArray(value.deck.deal)) fail(path, "deck.deal 必须是数组或 null");
    if (value.deck.byPlayers !== undefined) {
      if (!isRecord(value.deck.byPlayers)) fail(path, "deck.byPlayers 必须是对象");
      for (const [players, override] of Object.entries(value.deck.byPlayers)) {
        if (!/^[2-9]$|^10$/.test(players)) fail(`${path}.deck.byPlayers`, `人数键 ${JSON.stringify(players)} 必须为 2-10`);
        if (!isRecord(override)) fail(`${path}.deck.byPlayers.${JSON.stringify(players)}`, "人数覆盖必须是对象");
        assertKeys(override, ["cards", "deal"], `${path}.deck.byPlayers.${JSON.stringify(players)}`);
        if (override.cards !== undefined && !isRecord(override.cards)) fail(`${path}.deck.byPlayers.${JSON.stringify(players)}`, "cards 必须是对象");
        if (override.deal !== undefined && override.deal !== null && !Array.isArray(override.deal)) fail(`${path}.deck.byPlayers.${JSON.stringify(players)}`, "deal 必须是数组或 null");
      }
    }
  }
  if (value.display !== undefined && value.display !== null) {
    if (!isRecord(value.display)) fail(path, "display 必须是对象");
    assertKeys(value.display, ["autoStack", "maxStack", "order"], `${path}.display`);
  }
  return value as unknown as CustomRulesSource;
}

function resolvePresetChain(
  source: CustomRulesSource,
  presets: CustomPresetProvider | undefined,
  stack: string[],
  path: string,
): { base: MergedRulesDocument | undefined; chain: Array<{ id: string; revision?: number }> } {
  if (!source.preset) return { base: undefined, chain: [] };
  if (stack.includes(source.preset)) fail(path, `preset 循环引用：${[...stack, source.preset].join(" → ")}`);
  if (stack.length >= CUSTOM_LIMITS.maxPresetDepth) fail(path, `preset 继承深度超过 ${CUSTOM_LIMITS.maxPresetDepth}`);
  const entry = presets?.get(source.preset);
  if (!entry) fail(path, `preset "${source.preset}" 不存在`);
  const presetSource = loadSourceDocument(entry.source, `${path}.preset(${source.preset})`);
  const parent = resolvePresetChain(presetSource, presets, [...stack, source.preset], `${path}.preset(${source.preset})`);
  let base: MergedRulesDocument = parent.base ?? {
    version: presetSource.version,
    name: presetSource.name,
    displayName: presetSource.displayName,
    description: presetSource.description,
    setup: presetSource.setup ?? {},
    cards: (presetSource.cards ?? {}) as Record<string, CustomCardDef>,
    combos: (presetSource.combos ?? {}) as Record<string, CustomComboDef>,
    deck: { cards: presetSource.deck?.cards ?? {}, deal: presetSource.deck?.deal === null ? undefined : presetSource.deck?.deal, byPlayers: presetSource.deck?.byPlayers },
    display: presetSource.display === null ? undefined : presetSource.display,
  };
  if (parent.base) {
    base = mergeRulesDocuments(parent.base, presetSource);
  }
  return { base, chain: [...parent.chain, { id: source.preset, revision: entry.revision }] };
}

export function parseCustomRules(raw: string | unknown, options?: { presets?: CustomPresetProvider }): ResolvedCustomRules {
  const source = loadSourceDocument(raw, "rules");
  const { base, chain } = resolvePresetChain(source, options?.presets, [], "rules");
  const merged: MergedRulesDocument = base
    ? mergeRulesDocuments(base, source)
    : {
        version: source.version,
        name: source.name,
        displayName: source.displayName,
        description: source.description,
        setup: source.setup ?? {},
        cards: (source.cards ?? {}) as Record<string, CustomCardDef>,
        combos: (source.combos ?? {}) as Record<string, CustomComboDef>,
        deck: { cards: source.deck?.cards ?? {}, deal: source.deck?.deal === null ? undefined : source.deck?.deal, byPlayers: source.deck?.byPlayers },
        display: source.display === null ? undefined : source.display,
      };

  // setup validation
  const setup = merged.setup ?? {};
  if (!isRecord(setup)) fail("rules.setup", "setup 必须是对象");
  assertKeys(setup, ["players", "baseBet", "initialHand", "initialHandByPlayers", "disableOpeningExchange", "allowWangZha"], "rules.setup");
  if (setup.players !== undefined) assertSetupValue(setup.players, "rules.setup.players", "人数", 2, 10);
  if (setup.baseBet !== undefined) assertSetupValue(setup.baseBet, "rules.setup.baseBet", "底注", 0, Number.MAX_SAFE_INTEGER);
  if (setup.initialHand !== undefined) assertSetupValue(setup.initialHand, "rules.setup.initialHand", "初始手牌", 2, Number.MAX_SAFE_INTEGER);
  if (setup.disableOpeningExchange !== undefined) assertBoolean(setup.disableOpeningExchange, "rules.setup", "disableOpeningExchange");
  if (setup.allowWangZha !== undefined) assertBoolean(setup.allowWangZha, "rules.setup", "allowWangZha");
  if (setup.initialHandByPlayers !== undefined) {
    if (!isRecord(setup.initialHandByPlayers)) fail("rules.setup.initialHandByPlayers", "必须是对象");
    const [minPlayers, maxPlayers] = setup.players === undefined ? [2, 10] : typeof setup.players === "number" ? [setup.players, setup.players] : setup.players;
    for (const [players, hand] of Object.entries(setup.initialHandByPlayers)) {
      const count = assertInt(Number(players), "rules.setup.initialHandByPlayers", "人数键", 2, 10);
      if (String(count) !== players) fail("rules.setup.initialHandByPlayers", `人数键 ${JSON.stringify(players)} 必须为 2-10`);
      if (count < minPlayers || count > maxPlayers) fail("rules.setup.initialHandByPlayers", `人数 ${count} 不在 setup.players 允许范围 ${minPlayers}-${maxPlayers}`);
      assertSetupValue(hand, `rules.setup.initialHandByPlayers.${JSON.stringify(players)}`, "初始手牌", 2, Number.MAX_SAFE_INTEGER);
    }
  }

  // card definitions
  const cards = fillReferencedPlatformCards(merged);
  const cardIds = Object.keys(cards);
  if (cardIds.length === 0) fail("rules.cards", "至少需要一张卡牌定义");
  if (cardIds.length > CUSTOM_LIMITS.maxCardDefinitions) fail("rules.cards", `卡牌定义数量超过 ${CUSTOM_LIMITS.maxCardDefinitions}`);
  for (const [id, def] of Object.entries(cards)) {
    assertString(id, "rules.cards", "cardId", 64);
    validateCard(id, def, `rules.cards.${JSON.stringify(id)}`);
  }

  // combos
  const combos = merged.combos ?? {};
  for (const [id, combo] of Object.entries(combos)) {
    validateCombo(id, combo, `rules.combos.${JSON.stringify(id)}`);
  }

  // reference validation
  const defined = new Set(cardIds);
  for (const [id, def] of Object.entries(cards)) {
    validateDirectCardReferences(def, defined, `rules.cards.${JSON.stringify(id)}`);
  }
  for (const [id, combo] of Object.entries(combos)) {
    validateDirectCardReferences(combo, defined, `rules.combos.${JSON.stringify(id)}`);
  }
  for (const [id, def] of Object.entries(cards)) {
    if (def.type !== "ion" || !def.reactions) continue;
    for (const kind of CUSTOM_REACTION_KINDS) {
      for (const target of def.reactions[kind] ?? []) {
        if (!defined.has(target)) {
          fail(`rules.cards.${JSON.stringify(id)}.reactions.${kind}`, `引用了未定义的卡牌 "${target}"`);
        }
        const targetDef = cards[target];
        if (targetDef.type !== "ion") fail(`rules.cards.${JSON.stringify(id)}.reactions.${kind}`, `"${target}" 不是离子牌`);
      }
    }
  }
  for (const [id, combo] of Object.entries(combos)) {
    for (const cardId of Object.keys(combo.requires)) {
      if (!defined.has(cardId)) fail(`rules.combos.${JSON.stringify(id)}.requires`, `引用了未定义的卡牌 "${cardId}"`);
    }
  }

  // display
  let display: CustomDisplay | undefined;
  if (merged.display !== undefined) {
    const raw = merged.display;
    display = {};
    if (raw.autoStack !== undefined) {
      assertBoolean(raw.autoStack, "rules.display", "autoStack");
      display.autoStack = raw.autoStack;
    }
    if (raw.maxStack !== undefined) display.maxStack = assertInt(raw.maxStack, "rules.display", "maxStack", 0, 99);
    if (raw.order !== undefined) {
      if (!Array.isArray(raw.order)) fail("rules.display.order", "order 必须是数组");
      const seen = new Set<string>();
      const order: string[] = [];
      for (const [index, id] of raw.order.entries()) {
        assertString(id, "rules.display.order", `order[${index}]`, 64);
        if (!defined.has(id)) fail("rules.display.order", `order 引用了未定义的卡牌 "${id}"`);
        if (seen.has(id)) fail("rules.display.order", `order 中卡牌 "${id}" 重复出现`);
        seen.add(id);
        order.push(id);
      }
      display.order = order;
    }
  }

  // deck validation. A `byPlayers.N.cards` is a complete replacement for the
  // common deck at N players; omitted fields inherit the common deck/deal.
  const [setupMinPlayers, setupMaxPlayers] = setup.players === undefined ? [2, 10] : typeof setup.players === "number" ? [setup.players, setup.players] : setup.players;
  const normalizeDeckCards = (rawCards: unknown, path: string): Record<string, number> => {
    if (!isRecord(rawCards)) fail(path, "牌堆必须是对象");
    const normalized: Record<string, number> = {};
    let total = 0;
    for (const [id, count] of Object.entries(rawCards)) {
      if (!defined.has(id)) fail(path, `引用了未定义的卡牌 "${id}"`);
      const value = assertInt(count, path, `cards.${JSON.stringify(id)}`, 0, Number.MAX_SAFE_INTEGER);
      if (value > 0) {
        Object.defineProperty(normalized, id, { value, enumerable: true, configurable: true, writable: true });
        total += value;
      }
    }
    if (total === 0) fail(path, "牌堆不能为空");
    if (total > 1000) fail(path, "牌堆总数超过 1000 张");
    return normalized;
  };
  const normalizeDeal = (rawDeal: unknown, cardsForDeal: Record<string, number>, path: string, expectedPlayers?: number): ResolvedCustomRules["deck"]["deal"] => {
    if (rawDeal === undefined) return undefined;
    if (!Array.isArray(rawDeal)) fail(path, "deal 必须是数组");
    if (rawDeal.length === 1) fail(path, "初始发牌不能只规定 1 个座位（游戏至少 2 人）；留空数组表示自动发牌");
    if (rawDeal.length > 0) {
      if (expectedPlayers !== undefined && rawDeal.length !== expectedPlayers) fail(path, `发牌座位数 ${rawDeal.length} 必须与人数覆盖 ${expectedPlayers} 一致`);
      if (expectedPlayers === undefined && (rawDeal.length < setupMinPlayers || rawDeal.length > setupMaxPlayers)) {
        fail(path, `发牌座位数 ${rawDeal.length} 不在 setup.players 允许范围 ${setupMinPlayers}-${setupMaxPlayers}`);
      }
    }
    const normalized: NonNullable<ResolvedCustomRules["deck"]["deal"]> = [];
    for (const [index, seatRule] of rawDeal.entries()) {
      const sub = `${path}[${index}]`;
      if (!isRecord(seatRule)) fail(sub, "deal 项必须是对象");
      assertKeys(seatRule, ["seat", "fixed", "fill"], sub);
      if (seatRule.seat !== undefined) {
        assertInt(seatRule.seat, sub, "seat", 0, (expectedPlayers ?? setupMaxPlayers) - 1);
        if (seatRule.seat !== index) fail(sub, `seat 必须与数组位置一致（应为 ${index}）`);
      }
      if (seatRule.fixed !== undefined) {
        if (!isRecord(seatRule.fixed)) fail(sub, "fixed 必须是对象");
        for (const [cardId, count] of Object.entries(seatRule.fixed)) {
          if (!defined.has(cardId)) fail(sub, `fixed 引用了未定义的卡牌 "${cardId}"`);
          assertInt(count, sub, `fixed.${JSON.stringify(cardId)}`, 0, Number.MAX_SAFE_INTEGER);
        }
      }
      const fixedTotal = Object.values(seatRule.fixed ?? {}).reduce<number>((sum, count) => sum + Number(count), 0);
      if (seatRule.fill !== undefined) {
        const fill = assertInt(seatRule.fill, sub, "fill", 0, Number.MAX_SAFE_INTEGER);
        if (fill === 1) fail(sub, "fill 不能为 1；自定义模式初始手牌至少为 2 张（0 表示不补足）");
        if (fill < fixedTotal) fail(sub, `fill ${fill} 不能小于该席位固定发牌总数 ${fixedTotal}`);
      }
      normalized.push({ seat: index, ...(seatRule.fixed !== undefined ? { fixed: { ...seatRule.fixed } as Record<string, number> } : {}), ...(seatRule.fill !== undefined ? { fill: seatRule.fill as number } : {}) });
    }
    return normalized;
  };
  const validateDealSupply = (deal: ResolvedCustomRules["deck"]["deal"], cardsForDeal: Record<string, number>, path: string): void => {
    const needed: Record<string, number> = {};
    for (const rule of deal ?? []) {
      for (const [cardId, count] of Object.entries(rule.fixed ?? {})) needed[cardId] = (needed[cardId] ?? 0) + count;
    }
    for (const [cardId, count] of Object.entries(needed)) {
      if ((cardsForDeal[cardId] ?? 0) < count) fail(path, `固定发牌 ${JSON.stringify(cardId)} 共需 ${count} 张，超过牌堆供应 ${cardsForDeal[cardId] ?? 0} 张`);
    }
  };
  const minimumDealFill = (deal: ResolvedCustomRules["deck"]["deal"]): number => Math.max(
    2,
    ...(deal ?? []).map((rule) => Math.max(
      Object.values(rule.fixed ?? {}).reduce((sum, count) => sum + count, 0),
      rule.fill ?? 0,
    )),
  );
  const validateGlobalFill = (value: unknown, deal: ResolvedCustomRules["deck"]["deal"], path: string): void => {
    if (value === undefined || !deal?.length) return;
    const minimum = minimumDealFill(deal);
    const actualMinimum = Array.isArray(value) ? Number(value[0]) : Number(value);
    if (actualMinimum < minimum) fail(path, `全局补足手牌数不能小于任何席位的固定发牌或补足数（至少需要 ${minimum}）`);
  };
  const deckCards = normalizeDeckCards(merged.deck.cards, "rules.deck.cards");
  const normalizedDeal = normalizeDeal(merged.deck.deal, deckCards, "rules.deck.deal");
  validateDealSupply(normalizedDeal, deckCards, "rules.deck.deal");
  const normalizedByPlayers: NonNullable<ResolvedCustomRules["deck"]["byPlayers"]> = {};
  for (const [playersKey, rawOverride] of Object.entries(merged.deck.byPlayers ?? {})) {
    const players = Number(playersKey);
    if (!Number.isInteger(players) || players < 2 || players > 10 || String(players) !== playersKey) fail("rules.deck.byPlayers", `人数键 ${JSON.stringify(playersKey)} 必须为 2-10`);
    if (players < setupMinPlayers || players > setupMaxPlayers) fail("rules.deck.byPlayers", `人数 ${players} 不在 setup.players 允许范围 ${setupMinPlayers}-${setupMaxPlayers}`);
    if (!isRecord(rawOverride)) fail(`rules.deck.byPlayers.${JSON.stringify(playersKey)}`, "人数覆盖必须是对象");
    const cardsForPlayers = rawOverride.cards === undefined ? deckCards : normalizeDeckCards(rawOverride.cards, `rules.deck.byPlayers.${JSON.stringify(playersKey)}.cards`);
    // `null` clears an inherited/common deal.  Preserve that as an empty deal
    // in the resolved snapshot so runtime selection does not fall back to it.
    const dealForPlayers = rawOverride.deal === null ? [] : rawOverride.deal === undefined ? undefined : normalizeDeal(rawOverride.deal, cardsForPlayers, `rules.deck.byPlayers.${JSON.stringify(playersKey)}.deal`, players);
    normalizedByPlayers[playersKey as keyof typeof normalizedByPlayers] = {
      ...(rawOverride.cards === undefined ? {} : { cards: cardsForPlayers }),
      ...(rawOverride.deal === undefined ? {} : { deal: dealForPlayers }),
    };
  }
  const uniformDeal = customUniformDealTemplate({ setup, deck: { byPlayers: normalizedByPlayers } });
  for (const [playersKey, override] of Object.entries(normalizedByPlayers)) {
    const cardsForPlayers = override.cards ?? deckCards;
    if (!uniformDeal) validateDealSupply(override.deal ?? normalizedDeal, cardsForPlayers, `rules.deck.byPlayers.${JSON.stringify(playersKey)}.deal`);
    const hand = setup.initialHandByPlayers?.[playersKey as keyof typeof setup.initialHandByPlayers] ?? setup.initialHand;
    validateGlobalFill(hand, override.deal ?? normalizedDeal, setup.initialHandByPlayers?.[playersKey as keyof typeof setup.initialHandByPlayers] !== undefined
      ? `rules.setup.initialHandByPlayers.${JSON.stringify(playersKey)}`
      : "rules.setup.initialHand");
  }
  validateGlobalFill(setup.initialHand, normalizedDeal, "rules.setup.initialHand");

  const resolved: ResolvedCustomRules = {
    version: merged.version,
    name: merged.name,
    displayName: merged.displayName,
    description: merged.description,
    setup,
    cards,
    combos,
    deck: { cards: deckCards, ...(normalizedDeal !== undefined ? { deal: normalizedDeal } : {}), ...(Object.keys(normalizedByPlayers).length > 0 ? { byPlayers: normalizedByPlayers } : {}) },
    display,
    presetChain: chain,
    hash: "",
  };
  assertDocumentByteLimit(resolved, "rules");
  let totalAudioBytes = 0;
  for (const [cardId, card] of Object.entries(cards)) {
    const audio = (card as { audio?: Record<string, string> }).audio;
    if (!audio) continue;
    for (const [audioKey, dataUrl] of Object.entries(audio)) {
      totalAudioBytes += decodedAudioByteLength(dataUrl, `rules.cards.${JSON.stringify(cardId)}.audio.${audioKey}`);
      if (totalAudioBytes > CUSTOM_LIMITS.maxAudioBytesTotal) {
        fail("rules.cards", `音频解码后总大小超过 ${CUSTOM_LIMITS.maxAudioBytesTotal} 字节`);
      }
    }
  }
  resolved.hash = canonicalCustomRulesHash(resolved);
  return deepFreeze(resolved);
}

function fillReferencedPlatformCards(merged: MergedRulesDocument): Record<string, CustomCardDef> {
  const cards: Record<string, CustomCardDef> = { ...merged.cards };
  const referenced = new Set<string>();
  for (const id of Object.keys(merged.deck.cards ?? {})) referenced.add(id);
  for (const seat of Array.isArray(merged.deck.deal) ? merged.deck.deal : []) {
    if (!isRecord(seat) || !isRecord(seat.fixed)) continue;
    for (const id of Object.keys(seat.fixed)) referenced.add(id);
  }
  for (const override of Object.values(merged.deck.byPlayers ?? {})) {
    if (!isRecord(override)) continue;
    for (const id of Object.keys((override.cards as Record<string, unknown> | undefined) ?? {})) referenced.add(id);
    for (const seat of Array.isArray(override.deal) ? override.deal : []) {
      if (!isRecord(seat) || !isRecord(seat.fixed)) continue;
      for (const id of Object.keys(seat.fixed)) referenced.add(id);
    }
  }
  for (const combo of Object.values(merged.combos ?? {})) {
    for (const id of Object.keys(combo.requires ?? {})) referenced.add(id);
  }
  for (const id of merged.display?.order ?? []) referenced.add(id);
  for (const def of Object.values(cards)) {
    if (def.type !== "ion") continue;
    for (const kind of CUSTOM_REACTION_KINDS) {
      for (const target of def.reactions?.[kind] ?? []) referenced.add(target);
    }
  }
  for (const value of [...Object.values(cards), ...Object.values(merged.combos ?? {})]) {
    visitReactSweepReagents(value, "rules", (reagent) => {
      const directCard = Object.prototype.hasOwnProperty.call(cards, reagent)
        || Object.prototype.hasOwnProperty.call(PLATFORM_PRESET.cards, reagent)
        || !REAGENT_VARIABLE_REF.test(reagent);
      if (directCard) referenced.add(reagent);
    });
  }

  const pending = [...referenced];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (cards[id]) continue;
    const platform = PLATFORM_PRESET.cards[id];
    if (!platform) continue;
    cards[id] = structuredClone(platform);
    if (platform.type !== "ion") continue;
    for (const kind of CUSTOM_REACTION_KINDS) {
      for (const target of platform.reactions?.[kind] ?? []) {
        if (!cards[target]) pending.push(target);
      }
    }
  }
  return cards;
}

export function parseCustomCardFragment(raw: string | unknown): CustomCardDef {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      fail("card", `JSON 语法错误：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isRecord(value)) fail("card", "卡牌片段必须是 JSON 对象");
  validateCard("fragment", value, "card");
  return deepFreeze(value as unknown as CustomCardDef);
}

export type { CustomStep, CustomEventListenerRule, CustomWhereClause };
