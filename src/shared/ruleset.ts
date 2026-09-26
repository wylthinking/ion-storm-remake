import { applyAction, autoplay, createGame, createLocalRematch, currentPlayer, enumerateActions, finishOpeningExchange, publicGame, type CreateGameOptions } from "./engine.js";
import {
  applyCustomAction,
  applyCustomOpeningTimeout,
  createCustomGame,
  createLocalCustomRematch,
  currentCustomPlayer,
  customOfflineFallbackAction,
  enumerateCustomActions,
  publicCustomGame,
  randomCustomTimeoutAction,
  type CustomLegalAction,
} from "./custom-engine.js";
import { isCustomGame } from "./types.js";
import type { ActionIntent, AnyGameState, CustomActionIntent, CustomGameState, CustomPlayerState, GameState, PlayerId, PlayerState } from "./types.js";
import type { ResolvedCustomRules } from "./custom-rules-types.js";

export type RulesetGame = AnyGameState;
export type RulesetPlayer = PlayerState | CustomPlayerState;
export type RulesetAction = ActionIntent | CustomLegalAction;
export type RulesetActionIntent = ActionIntent | CustomActionIntent;

export interface CreateRulesetGameOptions extends Omit<CreateGameOptions, "players"> {
  rules?: ResolvedCustomRules;
  players: CreateGameOptions["players"];
  settlementLoserCap?: number | null;
}

export function isCustomLegalAction(action: unknown): action is CustomLegalAction {
  return (
    typeof action === "object" &&
    action !== null &&
    typeof (action as CustomLegalAction).kind === "string" &&
    typeof (action as CustomLegalAction).id === "string"
  );
}

export function createRulesetGame(options: CreateRulesetGameOptions): RulesetGame {
  if (options.rules) {
    return createCustomGame({
      mode: options.mode,
      rules: options.rules,
      players: options.players.map((player) => ({
        nickname: player.nickname,
        accountId: player.accountId,
        profile: player.profile,
        canOpeningExchange: player.canOpeningExchange,
      })),
      handSize: options.handSize,
      seed: options.seed,
      baseBet: options.baseBet,
      turnTimeLimitMs: options.turnTimeLimitMs,
      openingExchangeWindowMs: options.openingExchangeWindowMs,
      startingSeat: options.startingSeat,
      settlementLoserCap: options.settlementLoserCap,
    });
  }
  return createGame(options);
}

export function createRulesetRematch(previous: RulesetGame): RulesetGame {
  return isCustomGame(previous) ? createLocalCustomRematch(previous) : createLocalRematch(previous);
}

export function rulesetCurrentPlayer(game: RulesetGame): RulesetPlayer {
  return isCustomGame(game) ? currentCustomPlayer(game) : currentPlayer(game);
}

export function enumerateRulesetActions(game: RulesetGame, playerId: PlayerId): RulesetAction[] {
  return isCustomGame(game) ? enumerateCustomActions(game, playerId) : enumerateActions(game, playerId);
}

export function rulesetIntentFromAction(action: RulesetAction): RulesetActionIntent {
  if (isCustomLegalAction(action)) return { type: "custom", actionId: action.id };
  return action;
}

export function applyRulesetAction(
  game: RulesetGame,
  playerId: PlayerId,
  action: RulesetAction | RulesetActionIntent,
  source: "normal" | "timeout" = "normal",
): { ok: boolean; message: string; game: RulesetGame } {
  if (isCustomGame(game)) {
    const intent: CustomActionIntent = isCustomLegalAction(action as RulesetAction)
      ? { type: "custom", actionId: (action as CustomLegalAction).id }
      : (action as CustomActionIntent);
    return applyCustomAction(game as CustomGameState, playerId, intent, source);
  }
  const intent = action as ActionIntent;
  if (typeof intent?.type !== "string") return { ok: false, message: "非法操作", game };
  return applyAction(game as GameState, playerId, intent, source);
}

export function publicRulesetGame(game: RulesetGame, viewerId?: PlayerId): RulesetGame {
  return isCustomGame(game) ? publicCustomGame(game, viewerId) : publicGame(game, viewerId);
}

export function advanceRulesetOpeningTimeout(game: RulesetGame): RulesetGame {
  return isCustomGame(game) ? applyCustomOpeningTimeout(game as CustomGameState) : finishOpeningExchange(game as GameState);
}

export function rulesetOfflineFallbackAction(game: RulesetGame, playerId: PlayerId): RulesetActionIntent | undefined {
  if (!isCustomGame(game)) return undefined;
  const action = customOfflineFallbackAction(game as CustomGameState, playerId);
  return action ? { type: "custom", actionId: action.id } : undefined;
}

export function randomRulesetTimeoutAction(game: RulesetGame, playerId: PlayerId): RulesetActionIntent | undefined {  if (isCustomGame(game)) {
    const action = randomCustomTimeoutAction(game, playerId);
    return action ? { type: "custom", actionId: action.id } : undefined;
  }
  try {
    return autoplay(game as GameState);
  } catch {
    return enumerateActions(game as GameState, playerId)[0];
  }
}
