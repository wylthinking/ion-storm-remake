import { recommendAdvancedAction, type AdvancedAiOptions } from "../shared/advanced-ai.js";
import type { GameState } from "../shared/types.js";

self.onmessage = (
  event: MessageEvent<{
    game: GameState;
    playerId: string;
    requestId: number;
    options: AdvancedAiOptions;
  }>,
) => {
  try {
    const recommendation = recommendAdvancedAction(
      event.data.game,
      event.data.playerId,
      event.data.options,
    );
    self.postMessage({ requestId: event.data.requestId, recommendation });
  } catch (error) {
    self.postMessage({
      requestId: event.data.requestId,
      error: error instanceof Error ? error.message : "高级计算失败",
    });
  }
};
