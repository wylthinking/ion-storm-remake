import { applyAction } from "./engine.js";
import type { ActionIntent, GameState } from "./types.js";

const ALWAYS_EFFECTIVE_FUNCTIONS = new Set(["Enough", "Impurity", "AddSodium", "Ban", "Reverse"]);

export function rankLegalActions(
  game: GameState,
  playerId: string,
  actions: ActionIntent[],
  suggested?: ActionIntent,
): ActionIntent[] {
  const suggestedKey = suggested ? actionKey(suggested) : "";
  return actions
    .map((action, index) => ({
      action,
      index,
      priority:
        actionKey(action) === suggestedKey
          ? 0
          : isReactionAction(game, playerId, action) || isEffectiveFunctionAction(game, playerId, action)
            ? 1
            : 2,
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ action }) => action);
}

function isReactionAction(game: GameState, playerId: string, action: ActionIntent): boolean {
  if (action.type === "play-ion") return Boolean(action.targetId);
  if (action.type === "resolve-impurity") return Boolean(action.targetId);
  if (action.type !== "resolve-enough") return false;
  const priorEvents = game.eventLog?.length ?? 0;
  const result = applyAction(game, playerId, action, "normal");
  return Boolean(
    result.ok &&
      result.game.eventLog
        ?.slice(priorEvents)
        .some((event) => event.category === "反应" && (event.quantity ?? 0) > 0),
  );
}

function isEffectiveFunctionAction(game: GameState, playerId: string, action: ActionIntent): boolean {
  if (action.type === "follow-function" || action.type === "counter-draw" || action.type === "wang-zha") return true;
  if (action.type !== "play-function") return false;
  if (ALWAYS_EFFECTIVE_FUNCTIONS.has(action.card)) return true;

  const result = applyAction(game, playerId, action, "normal");
  if (!result.ok) return false;
  return (
    tableKey(result.game) !== tableKey(game) ||
    Boolean(result.game.pendingDraw && !game.pendingDraw) ||
    Boolean(result.game.pendingChoice && !game.pendingChoice)
  );
}

function tableKey(game: GameState): string {
  return JSON.stringify({
    solution: game.zones.solution,
    products: game.zones.products.map((product) => ({
      kind: product.kind,
      cards: product.cards,
      radiationLeft: product.radiationLeft,
    })),
  });
}

function actionKey(action: ActionIntent): string {
  return JSON.stringify(action);
}
