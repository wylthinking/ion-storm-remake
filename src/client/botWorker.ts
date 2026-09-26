import { chooseBotAction } from "../shared/bot.js";
import type { GameState } from "../shared/types.js";

self.onmessage = (event: MessageEvent<{ game: GameState; playerId: string }>) => {
  const started = performance.now();
  const action = chooseBotAction(event.data.game, event.data.playerId);
  const elapsed = performance.now() - started;
  self.postMessage({ action, elapsed });
};
