import { createClient, type RedisClientType } from "redis";
import { ensureBankerPlayerId } from "../shared/banker.js";
import { PLATFORM_PRESET } from "../shared/generated/custom-json.generated.js";
import { canonicalCustomRulesHash, type ResolvedCustomRules } from "../shared/custom-rules-types.js";
import { isCustomGame } from "../shared/types.js";
import type { AnyGameState, CustomPlayerState, PlayerState, RoomCode, RulesetMode } from "../shared/types.js";

export type RoomPlayer = PlayerState | CustomPlayerState;

export interface RoomEditNotice {
  id: string;
  capacity: number;
  baseBet: number;
  initialHandSize?: number;
  turnTimeLimitSec?: number;
  openingExchangeSec?: number;
  updatedByNickname: string;
  updatedAt: number;
  recipientPlayerIds: string[];
  problems?: string[];
}

export interface Room {
  code: RoomCode;
  codeKind?: "custom" | "reserved";
  players: RoomPlayer[];
  game?: AnyGameState;
  rulesetMode?: RulesetMode;
  customRules?: ResolvedCustomRules;
  customRulesHash?: string;
  customConfigRevision?: number;
  customPresetId?: string;
  customPresetRevision?: number;
  capacity: number;
  creatorAccountId: string;
  bankerPlayerId?: string;
  bankerRotationGameId?: string;
  targetHumanPlayers?: number;
  readyPlayerIds: string[];
  baseBet: number;
  initialHandSize?: number;
  turnTimeLimitSec?: number;
  openingExchangeSec?: number;
  duelMode?: boolean;
  roomGamesPlayed: Record<string, number>;
  roomGamesWon: Record<string, number>;
  departedPlayerIds?: string[];
  editNotice?: RoomEditNotice;
  statsSettledGameId?: string;
  startAckGameId?: string;
  startAckedPlayerIds?: string[];
  startAckLastSentAtByPlayerId?: Record<string, number>;
  createdAt: number;
  lastActiveAt: number;
}

const TTL_SECONDS = 600;

export class RoomStore {
  private rooms = new Map<RoomCode, Room>();
  private redis?: RedisClientType;

  async connect(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) return;
    this.redis = createClient({ url });
    this.redis.on("error", (error) => console.warn("[redis]", error.message));
    await this.redis.connect();
  }

  async create(capacity = 2, creatorAccountId = "", requestedCode?: RoomCode): Promise<Room> {
    let code = requestedCode ?? "";
    if (requestedCode) {
      if (await this.get(requestedCode)) throw new Error("房间号已被占用");
    } else {
      for (let i = 0; i < 1000; i++) {
        code = Math.floor(100000 + Math.random() * 900000).toString();
        if (!(await this.get(code))) break;
      }
    }
    if (!code) throw new Error("暂时无法生成可用房间号，请稍后重试");
    const room: Room = {
      code,
      players: [],
      capacity,
      creatorAccountId,
      readyPlayerIds: [],
      baseBet: 5,
      roomGamesPlayed: {},
      roomGamesWon: {},
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    await this.set(room);
    return room;
  }

  async get(code: RoomCode): Promise<Room | undefined> {
    const cached = this.rooms.get(code);
    if (cached) {
      cached.bankerPlayerId = ensureBankerPlayerId(cached.players, cached.bankerPlayerId);
      normalizeCustomRulesSnapshot(cached);
      return cached;
    }
    if (!this.redis) return undefined;
    const raw = await this.redis.get(key(code));
    if (!raw) return undefined;
    const room = JSON.parse(raw) as Room;
    room.capacity ??= room.targetHumanPlayers ?? 2;
    room.creatorAccountId ??= room.players.find((player) => !player.bot)?.accountId ?? "";
    room.bankerPlayerId = ensureBankerPlayerId(room.players, room.bankerPlayerId);
    room.readyPlayerIds ??= [];
    room.baseBet ??= 5;
    room.roomGamesPlayed ??= {};
    room.roomGamesWon ??= {};
    room.departedPlayerIds ??= [];
    room.startAckedPlayerIds ??= [];
    room.startAckLastSentAtByPlayerId ??= {};
    room.rulesetMode ??= "classic";
    if (room.game && isCustomGame(room.game) && room.game.custom.rules === undefined) {
      room.game.custom.rules = room.customRules ?? PLATFORM_PRESET;
    }
    normalizeCustomRulesSnapshot(room);
    this.rooms.set(code, room);
    return room;
  }

  async set(room: Room): Promise<void> {
    normalizeCustomRulesSnapshot(room);
    room.lastActiveAt = Date.now();
    this.rooms.set(room.code, room);
    if (this.redis) await this.redis.set(key(room.code), persistPayload(room), { EX: TTL_SECONDS });
  }

  async touch(code: RoomCode): Promise<void> {
    const room = await this.get(code);
    if (!room) return;
    await this.set(room);
  }

  async delete(code: RoomCode): Promise<void> {
    this.rooms.delete(code);
    if (this.redis) await this.redis.del(key(code));
  }

  async activeRooms(): Promise<Room[]> {
    return [...this.rooms.values()];
  }

  async prune(): Promise<void> {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (now - room.lastActiveAt > TTL_SECONDS * 1000) this.rooms.delete(code);
    }
  }
}

function normalizeCustomRulesSnapshot(room: Room): void {
  const rules = room.customRules ?? (room.game && isCustomGame(room.game) ? room.game.custom.rules as ResolvedCustomRules | undefined : undefined);
  if (!rules) return;
  const hash = canonicalCustomRulesHash(rules);
  room.customRulesHash = hash;
  if (room.game && isCustomGame(room.game)) room.game.custom.rulesHash = hash;
}

function key(code: RoomCode): string {
  return `ion-storm:room:${code}`;
}

// 自定义对局的规则文档与 room.customRules 重复，持久化时只保留一份
function persistPayload(room: Room): string {
  const game = room.game;
  if (game && isCustomGame(game) && game.custom.rules !== undefined) {
    const { rules: _strippedRules, ...customRest } = game.custom;
    return JSON.stringify({ ...room, game: { ...game, custom: customRest } });
  }
  return JSON.stringify(room);
}
