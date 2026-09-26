import type { CardInstance, CustomGameState, CustomRemoveCause, CustomRemoveEvent, PlayerId } from "./types.js";
import type { CustomEventListenerRule } from "./custom-rules-types.js";

export interface CustomEventContext {
  actor?: PlayerId;
  cause: CustomRemoveCause;
  sourceCard?: string;
  reactionResult?: string;
  batchId?: string;
}

export interface PlayedBatchEvent {
  actor: PlayerId;
  batchId: string;
  entries: Array<{ cardId: string; count: number }>;
}

export interface DeferredTrigger {
  listener: CustomEventListenerRule;
  selfInstanceId: string;
  event: CustomEventContext;
}

export interface MarkListenerHit {
  instance: CardInstance;
  markIndex: number;
  listener: CustomEventListenerRule;
}

export function listenerMatchesEvent(listener: CustomEventListenerRule, event: CustomEventContext): boolean {
  const where = listener.where;
  if (!where) return true;
  if (where.cause !== undefined) {
    const causes = Array.isArray(where.cause) ? where.cause : [where.cause];
    if (!causes.includes(event.cause)) return false;
  }
  if (where.reactionResult !== undefined) {
    const results = Array.isArray(where.reactionResult) ? where.reactionResult : [where.reactionResult];
    if (!event.reactionResult || !results.includes(event.reactionResult)) return false;
  }
  return true;
}

export function findInstancesById(game: CustomGameState, instanceIds: string[]): CardInstance[] {
  const wanted = new Set(instanceIds);
  const found: CardInstance[] = [];
  const scan = (instances: CardInstance[]) => {
    for (const instance of instances) if (wanted.has(instance.instanceId)) found.push(instance);
  };
  for (const player of game.players) scan(player.hand);
  scan(game.zones.solution);
  scan(game.zones.discard);
  scan(game.zones.drawPile);
  for (const group of game.zones.products) scan(group.cards);
  return found;
}

export function allFieldInstances(game: CustomGameState): CardInstance[] {
  return [...game.zones.solution, ...game.zones.products.flatMap((group) => group.cards)];
}

export function collectMarkListeners(game: CustomGameState, when: CustomEventListenerRule["when"]): MarkListenerHit[] {
  const hits: MarkListenerHit[] = [];
  for (const instance of allFieldInstances(game)) {
    instance.marks.forEach((mark, markIndex) => {
      for (const listener of mark.listeners) {
        if (listener.when === when) hits.push({ instance, markIndex, listener });
      }
    });
  }
  return hits;
}

export function makeRemoveEvent(context: CustomEventContext, removed: CardInstance[]): CustomRemoveEvent {
  return {
    actor: context.actor,
    cause: context.cause,
    sourceCard: context.sourceCard,
    reactionResult: context.reactionResult,
    batchId: context.batchId,
    removed,
  };
}
