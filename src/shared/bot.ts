import { enumerateActions, findReactionTargets } from "./engine.js";
import type { ActionIntent, GameState } from "./types.js";

export function chooseBotAction(game: GameState, playerId: string): ActionIntent {
  const actions = enumerateActions(game, playerId).filter((action) => action.type !== "pass");
  if (actions.length === 0) throw new Error("AI 当前没有可执行的合法操作");
  return actions.sort((a, b) => evaluate(game, b) - evaluate(game, a))[0];
}

function evaluate(game: GameState, action: ActionIntent): number {
  if (action.type === "play-ion") {
    const reaction = action.targetId ? findReactionTargets(game, action.card, action.count).find((target) => target.id === action.targetId) : undefined;
    return action.count * 10 + (reaction?.score ?? 0) * 18;
  }
  if (action.type === "play-special") return 35;
  if (action.type === "resolve-enough") return action.count * 20;
  if (action.type === "resolve-impurity") {
    if (game.pendingChoice?.kind !== "impurity-reaction") return 0;
    return findReactionTargets(game, game.pendingChoice.card, 1).find((target) => target.id === action.targetId)?.score ?? 0;
  }
  if (action.type === "follow-function") return 40;
  if (action.type === "counter-draw") return action.method === "WangZha" ? 45 : 35;
  if (action.type === "accept-draw") return 1;
  if (action.type === "wang-zha") return game.zones.products.length > 3 ? 60 : 12;
  if (action.type === "play-function") {
    const solids = game.zones.products.filter((p) => p.kind === "solid").length;
    const gas = game.zones.products.filter((p) => p.kind === "gas").length;
    const colored = game.zones.solution.filter((c) => c === "Fe^{2+}" || c === "Fe^{3+}" || c === "Cu^{2+}").length;
    const values: Record<string, number> = {
      Filter: solids * 18,
      AirWashing: gas * 22,
      Fade: colored * 16,
      Distill: game.zones.products.length === 0 ? game.zones.solution.length * 8 : -10,
      Ban: 28,
      Reverse: game.players.length === 2 ? 28 : 8,
      AddSodium: game.zones.products.length + game.zones.solution.length > 8 ? 25 : 5,
      Acid: 18,
      Alkali: 18,
      Enough: 24,
      Impurity: 12,
    };
    return values[action.card] ?? 0;
  }
  return -100;
}
