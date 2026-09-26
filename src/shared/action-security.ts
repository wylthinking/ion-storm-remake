import { CARDS } from "./cards.js";
import type { ActionIntent, AnyActionIntent, CustomActionIntent } from "./types.js";

const ACTION_KEYS: Record<ActionIntent["type"] | CustomActionIntent["type"], ReadonlySet<string>> = {
  "opening-exchange": new Set(["type", "discard"]),
  "opening-double": new Set(["type", "enabled"]),
  "play-ion": new Set(["type", "card", "count", "targetId"]),
  "play-special": new Set(["type", "card"]),
  "play-function": new Set(["type", "card", "payload"]),
  "follow-function": new Set(["type", "card"]),
  "resolve-impurity": new Set(["type", "targetId"]),
  "resolve-enough": new Set(["type", "card", "count"]),
  "wang-zha": new Set(["type"]),
  "accept-draw": new Set(["type"]),
  "counter-draw": new Set(["type", "method"]),
  pass: new Set(["type"]),
  custom: new Set(["type", "actionId", "cardId", "cardInstanceIds", "selectedPlayerIds", "selectedGroupIds", "selectedCount", "choiceId"]),
};

export function isStrictActionIntent(value: unknown): value is AnyActionIntent {
  if (!isPlainRecord(value) || typeof value.type !== "string" || !(value.type in ACTION_KEYS)) return false;
  const type = value.type as keyof typeof ACTION_KEYS;
  if (Object.keys(value).some((key) => !ACTION_KEYS[type].has(key))) return false;

  switch (type) {
    case "opening-exchange":
      return Array.isArray(value.discard) && value.discard.length <= 130 && value.discard.every(isCard);
    case "opening-double":
      return typeof value.enabled === "boolean";
    case "play-ion":
      return isCard(value.card) && isPositiveCount(value.count) && isOptionalIdentifier(value.targetId);
    case "play-special":
      return value.card === "Au" || value.card === "U";
    case "play-function":
      return isCard(value.card) && isValidFunctionPayload(value.payload);
    case "follow-function":
      return isCard(value.card);
    case "resolve-impurity":
      return isOptionalIdentifier(value.targetId);
    case "resolve-enough":
      return isCard(value.card) && isPositiveCount(value.count);
    case "counter-draw":
      return value.method === "AddSodium" || value.method === "WangZha";
    case "custom":
      return isValidCustomIntent(value);
    case "wang-zha":
    case "accept-draw":
    case "pass":
      return true;
  }
}

const PROTECTED_GAME_KEYS = new Set([
  "points",
  "score",
  "scoring",
  "hand",
  "players",
  "zones",
  "drawPile",
  "discard",
  "products",
  "winnerId",
  "revision",
  "game",
]);

export function containsProtectedGameMutation(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (isStrictActionIntent(value)) return false;
  if (Array.isArray(value)) return value.some((item) => containsProtectedGameMutation(item));
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => PROTECTED_GAME_KEYS.has(key) || containsProtectedGameMutation(item));
}

function isValidCustomIntent(value: Record<string, unknown>): boolean {
  if (value.actionId !== undefined && !isShortIdentifier(value.actionId)) return false;
  if (value.cardId !== undefined && !isShortIdentifier(value.cardId)) return false;
  if (value.choiceId !== undefined && !isShortIdentifier(value.choiceId)) return false;
  if (value.cardInstanceIds !== undefined && !isIdentifierArray(value.cardInstanceIds, 130)) return false;
  if (value.selectedPlayerIds !== undefined && !isIdentifierArray(value.selectedPlayerIds, 10)) return false;
  if (value.selectedGroupIds !== undefined && !isIdentifierArray(value.selectedGroupIds, 130)) return false;
  if (value.selectedCount !== undefined && !(Number.isInteger(value.selectedCount) && Number(value.selectedCount) >= 0 && Number(value.selectedCount) <= 130)) return false;
  return (
    value.actionId !== undefined ||
    value.choiceId !== undefined ||
    value.cardInstanceIds !== undefined ||
    value.selectedPlayerIds !== undefined ||
    value.selectedGroupIds !== undefined ||
    value.selectedCount !== undefined
  );
}

function isShortIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}

function isIdentifierArray(value: unknown, maxLength: number): boolean {
  return Array.isArray(value) && value.length <= maxLength && value.every(isShortIdentifier);
}

function isValidFunctionPayload(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainRecord(value) || Object.keys(value).some((key) => key !== "enoughCard" && key !== "enoughCount")) return false;
  return (
    (value.enoughCard === undefined || isCard(value.enoughCard)) &&
    (value.enoughCount === undefined || isPositiveCount(value.enoughCount))
  );
}

function isCard(value: unknown): value is string {
  return typeof value === "string" && value in CARDS;
}

function isPositiveCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 130;
}

function isOptionalIdentifier(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= 160);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
