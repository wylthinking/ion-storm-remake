import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { AUTOMATED_ACTION_DELAY_MS, OPENING_EXCHANGE_MS, autoplay, finishOpeningExchange, maxInitialHandSize } from "../src/shared/engine.js";
import { ensureBankerPlayerId, nextBankerPlayerId } from "../src/shared/banker.js";
import { buildLeaderboard } from "../src/shared/leaderboard.js";
import { canDownloadWinMusic, canManageWinMusic, canPlayDownloadedWinMusic, canPlayWinMusic } from "../src/shared/music-access.js";
import { assertSpreadsheetExportAccountName, assertSpreadsheetExportIdentity, assertSpreadsheetSafeAccountName, assertSpreadsheetSafeText, spreadsheetCsvCell } from "../src/shared/spreadsheet-safety.js";
import { parseVictoryMusicDataUrl } from "../src/shared/victory-music.js";
import { randomPointRewardUpperBound } from "../src/shared/point-distribution.js";
import { DEFAULT_TAX_RATE_PERCENT, calculateWinnerTax, cleanTaxRatePercent, normalizeTaxRatePercent, normalizeTaxWinnerPointsThreshold, winnerGrossPoints, winnerPreTaxPoints } from "../src/shared/tax.js";
import { containsProtectedGameMutation, isStrictActionIntent } from "../src/shared/action-security.js";
import { checkCustomRoomConfigAgainstPermissions, checkRoomConfigAgainstPermissions, cleanCustomInitialHandSize, cleanCustomRoomBaseBet, cleanRoomBaseBet, cleanRoomTimeLimitSec } from "../src/shared/room-limits.js";
import { applyRulesetAction, advanceRulesetOpeningTimeout, createRulesetGame, publicRulesetGame, randomRulesetTimeoutAction, rulesetCurrentPlayer, rulesetOfflineFallbackAction } from "../src/shared/ruleset.js";
import { parseCustomRules, type CustomPresetProvider } from "../src/shared/custom-rules-parser.js";
import type { CustomRulesSource, ResolvedCustomRules } from "../src/shared/custom-rules-types.js";
import { canonicalCustomRulesHash, customRulesSourceForRoom, requiredPlayersFromDeal } from "../src/shared/custom-rules-types.js";
import {
  defaultCustomModeLimits,
  normalizeCustomModeLimitGrant,
  normalizeCustomModeLimits,
  resolveCustomMaxBaseBet,
  setupPlayersRange,
  resolveCustomSettlementCap,
  type CustomModeLimitGrant,
  type CustomModeLimits,
  type CustomMaxBaseBetRule,
  type CustomSettlementCapRule,
} from "../src/shared/custom-limits.js";
import { calculateCustomSettlement } from "../src/shared/custom-settlement.js";
import { PLATFORM_PRESET } from "../src/shared/generated/custom-json.generated.js";
import { decodeStaticRequestPath, isProtectedAdvancedAiAssetPath, safeCookieValue } from "../src/shared/http-security.js";
import { isCustomGame, normalizeRulesetMode, type AnyActionIntent, type AnyGameState } from "../src/shared/types.js";
import type { ActionIntent, CustomPlayerState, GameState, PlayerProfile, PlayerState, RoomCode, UserRole } from "../src/shared/types.js";

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete?(key: string): Promise<boolean>;
  };
}

declare global {
  interface WebSocket {
    accept(): void;
  }

  interface ResponseInit {
    webSocket?: WebSocket | null;
  }

  var WebSocketPair: {
    new (): { 0: WebSocket; 1: WebSocket };
  };
}

interface Env {
  ASSETS?: Fetcher;
  ION_USERS?: KVNamespace;
  ION_ROOMS?: KVNamespace;
  ION_SESSIONS?: KVNamespace;
  ION_ACCOUNT_STATE?: DurableObjectNamespace;
  ION_ROOM_STATE?: DurableObjectNamespace;
  AUTH_SECRET?: string;
  AUTH_SECRET_PREVIOUS?: string;
  BOOTSTRAP_SUPER_ADMIN_USERNAME?: string;
  BOOTSTRAP_SUPER_ADMIN_PASSWORD?: string;
}

interface StoredUser {
  id: string;
  usernameEncrypted: string;
  usernameLookup: string;
  passwordHash: string;
  sessionVersion?: number;
  nickname?: string;
  nicknameColor?: string;
  inviteCodeUsed?: string;
  lastLoginAt?: number;
  points?: number;
  disabledUntil?: string;
  disabledPermanent?: boolean;
  hideFromLeaderboardWhileDisabled?: boolean;
  leaderboardHiddenUntil?: string;
  leaderboardHiddenPermanent?: boolean;
  disabledAt?: number;
  disabledBy?: string;
  unbanRequestedForDisabledAt?: number;
  nicknameChangeDisabled?: boolean;
  superAdmin: boolean;
  adminPermanent: boolean;
  advancedPermanent: boolean;
  adminExpiresAt?: string;
  advancedExpiresAt?: string;
  advancedAiPermanent?: boolean;
  advancedAiExpiresAt?: string;
  taxRatePercent?: number;
  title?: string;
  gamesPlayed: number;
  gamesWon: number;
  todayStatsDate?: string;
  todayGamesPlayed?: number;
  todayGamesWon?: number;
  todayGamePointsDelta?: number;
  createdAt: number;
  updatedAt: number;
  /** Lexical room codes reserved by this account.  Keep these as strings: 023 and 23 are different codes. */
  reservedRoomCodes?: string[];
  winMusic?: {
    fileName: string;
    mimeType: string;
    size: number;
    durationSeconds?: number;
    uploadedAt: number;
    dataUrl?: string;
    sha1?: string;
    sha256?: string;
  };
}

type DuelLimitPeriod = "none" | "hour" | "day" | "week" | "unlimited";

type DuelLimitRule = {
  period: DuelLimitPeriod;
  count: number | null;
};

type PermissionRule = {
  exchangeMin: number;
  exchangeMax: number | null;
  canCreateZeroBaseBet: boolean;
  maxBaseBet: number | null;
  duelLimit: DuelLimitRule;
};

type LegacyCustomPermissionFields = {
  customMaxBaseBet?: CustomMaxBaseBetRule;
  customSettlementCap?: CustomSettlementCapRule;
};

type WorkerCustomModeLimitOverride = {
  limits: CustomModeLimitGrant;
  expiresAt?: string;
  permanent?: boolean;
};

type WorkerInvitation = {
  code: string;
  remainingUses: number | null;
  expiresAt?: string;
  role: UserRole;
  initialPoints: number;
  initialTitle?: string;
  initialNicknameColor?: string;
  permissions?: Partial<PermissionRule>;
  customModeLimits?: CustomModeLimitGrant;
  adminDurationMs?: number | null;
  advancedDurationMs?: number | null;
  adminExpiresAt?: string;
  advancedExpiresAt?: string;
  adminPermanent?: boolean;
  advancedPermanent?: boolean;
  advancedAiDurationMs?: number | null;
  advancedAiExpiresAt?: string;
  taxRatePercent?: number;
  usePolicy?: "unlimited" | "global-total" | "global-window";
  maxUses?: number;
  windowMs?: number;
  registrations?: Array<{ userId: string; usedAt: number; deviceHash: string; browserHash: string }>;
  createdAt: number;
  updatedAt: number;
  reservedRoomCodeMode?: "user-input" | "random";
};

type WorkerActivation = {
  code: string;
  kind?: "standard" | "point-distribution";
  usePolicy: "unlimited" | "global-total" | "per-user-total" | "global-window" | "per-user-window";
  maxUses: number;
  distributionMode?: "random" | "equal";
  totalPoints?: number;
  windowMs?: number;
  expiresAt?: string;
  points: number;
  requireNonNegativeBalance?: boolean;
  titleMode?: "default" | "fixed" | "user-custom";
  title?: string;
  nicknameColorMode?: "default" | "fixed" | "user-custom";
  nicknameColor?: string;
  adminDurationMs?: number | null;
  advancedDurationMs?: number | null;
  adminExpiresAt?: string;
  advancedExpiresAt?: string;
  advancedAiDurationMs?: number | null;
  advancedAiExpiresAt?: string;
  taxRatePercent?: number;
  permissionDurationMs?: number | null;
  permissions?: Partial<PermissionRule>;
  customModeLimitDurationMs?: number | null;
  customModeLimits?: CustomModeLimitGrant;
  redemptions: Array<{ userId: string; usedAt: number; points?: number }>;
  createdAt: number;
  updatedAt: number;
  reservedRoomCodeMode?: "user-input" | "random";
};

type WorkerRequest = {
  id: string;
  kind: "ticket" | "unban" | "nickname" | "security";
  fromUserId: string;
  text: string;
  privateToSuperAdmin: boolean;
  requestedNickname?: string;
  status: "open" | "approved" | "replied" | "ignored";
  reply?: string;
  replyUserId?: string;
  createdAt: number;
  repliedAt?: number;
  securityLogId?: string;
  securitySubject?: string;
  banSnapshot?: {
    disabledAt?: number;
    disabledUntil?: string;
    disabledPermanent?: boolean;
    disabledBy?: string;
  };
};

type WorkerSecurityEvent = {
  actorUserId?: string;
  subjectKey: string;
  category: "unauthorized-read" | "unauthorized-operation" | "forged-action" | "protected-mutation";
  operation: string;
  method: string;
  route: string;
  ip?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  occurredAt: number;
};

type WorkerSecurityIncident = {
  id: string;
  subjectKey: string;
  actorUserId?: string;
  startedAt: number;
  endsAt: number;
  reportedAt?: number;
  requestId?: string;
  suppressedEvents?: number;
  events: WorkerSecurityEvent[];
};

type AdminStatePayload = {
  users: StoredUser[];
  invitations: WorkerInvitation[];
  activationCodes: WorkerActivation[];
  requests: WorkerRequest[];
  requestSeenAtByUserId: Record<string, number>;
  rolePermissions: Record<UserRole, PermissionRule>;
  customModeLimits: CustomModeLimits;
  taxRatePercent: number;
  taxWinnerPointsThreshold?: number;
  userPermissions: Record<string, { permissions: Partial<PermissionRule>; expiresAt?: string; permanent?: boolean }>;
  userCustomModeLimits: Record<string, WorkerCustomModeLimitOverride>;
  customRulesPresets: WorkerCustomRulesPreset[];
  settledGameIds: string[];
  securityIncidents: WorkerSecurityIncident[];
  duelRoomCooldowns: Record<string, number | number[]>;
};

type WorkerCustomRulesPreset = {
  id: string;
  displayName: string;
  sourceDocument: unknown;
  resolvedRules: ResolvedCustomRules;
  resolvedHash: string;
  revision: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
};

interface Room {
  code: RoomCode;
  codeKind?: "custom" | "reserved";
  revision?: number;
  players: Array<PlayerState | CustomPlayerState>;
  game?: AnyGameState;
  rulesetMode?: "classic" | "custom";
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
  baseBet: number;
  initialHandSize?: number;
  turnTimeLimitSec?: number;
  openingExchangeSec?: number;
  duelMode?: boolean;
  readyPlayerIds: string[];
  startAckGameId?: string;
  startAckedPlayerIds?: string[];
  startAckLastSentAtByPlayerId?: Record<string, number>;
  roomGamesPlayed: Record<string, number>;
  roomGamesWon: Record<string, number>;
  departedPlayerIds?: string[];
  editNotice?: RoomEditNotice;
  statsSettledGameId?: string;
  createdAt: number;
  lastActiveAt: number;
}

interface RoomEditNotice {
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

type RoomClientMessage =
  | { type: "joinRoom"; code: RoomCode; playerId?: string; token?: string }
  | { type: "startGame"; code: RoomCode; playerId: string; customRulesHashReady?: string }
  | { type: "submitAction"; code: RoomCode; playerId: string; action: ActionIntent }
  | { type: "botAction"; code: RoomCode; ownerId: string; botId?: string; action?: ActionIntent }
  | { type: "addBot"; code: RoomCode; ownerId: string }
  | { type: "kickPlayer"; code: RoomCode; playerId: string; targetId: string }
  | { type: "editRoom"; code: RoomCode; playerId: string; capacity: number; baseBet: number; initialHandSize?: number | null; turnTimeLimitSec?: number | null; openingExchangeSec?: number | null; customRules?: unknown }
  | { type: "leaveRoom"; code: RoomCode; playerId: string }
  | { type: "heartbeat"; code: RoomCode; playerId: string }
  | { type: "cancelAutoplay"; code: RoomCode; playerId: string }
  | { type: "refreshState"; code: RoomCode; playerId: string; requestId: string }
  | { type: "gameStartedAck"; code: RoomCode; playerId: string; gameId: string }
  | { type: "leaveSeat"; code: RoomCode; playerId: string };

type RoomSocketMeta = {
  code?: string;
  playerId?: string;
  actorId?: string;
};

const USERS_KEY = "users:v1";
const ROOM_TTL_SECONDS = 600;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const SECURITY_CAPTURE_MS = 2 * 60 * 60 * 1000;
const MAX_SECURITY_EVENTS_PER_INCIDENT = 500;
const MAX_SECURITY_INCIDENTS = 256;
const MAX_SECURITY_EVENTS_TOTAL = 5_000;
const MAX_SECURITY_STORAGE_BYTES = 2 * 1024 * 1024;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 64 * 1024;
const WEBSOCKET_JOIN_TIMEOUT_MS = 10_000;
const MAX_PENDING_WEBSOCKETS_PER_ROOM = 16;
const MAX_WEBSOCKETS_PER_ROOM = 128;
const REGISTRATION_RATE_WINDOW_MS = 60_000;
const REGISTRATION_RATE_LIMIT = 8;
const PRESENCE_OFFLINE_MS = 30_000;
const DEFAULT_SUPER_USERNAME = "admin";
const DEFAULT_SUPER_PASSWORD = "admin";
const ROLE_COLORS: Record<UserRole, string> = {
  "super-admin": "#FF0000",
  "admin-advanced": "#FF8F00",
  admin: "#FF008F",
  advanced: "#008F8F",
  normal: "#000000",
};
const memory = {
  adminState: defaultAdminState(),
  rooms: new Map<string, Room>(),
  sessions: new Map<string, string>(),
};
const workerRegistrationAttempts = new Map<string, { count: number; resetsAt: number }>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      requireWorkerAuthSecret(env);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "AUTH_SECRET 未配置" }, 503);
    }
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (!isWebSocketUpgradeRequest(request)) return json({ error: "WebSocket Upgrade required" }, 426);
      const code = url.searchParams.get("code")?.trim() ?? "";
      if (!/^\d+$/.test(code)) return json({ error: "房间号必须是数字" }, 400);
      if (!env.ION_ROOM_STATE) return json({ error: "房间 Durable Object 未配置" }, 503);
      const stub = env.ION_ROOM_STATE.get(env.ION_ROOM_STATE.idFromName(code));
      return stub.fetch(request);
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "请求失败" }, 400);
      }
    }
    const normalizedAssetPath = decodeStaticRequestPath(url.pathname);
    if (normalizedAssetPath === undefined) return new Response(null, { status: 400 });
    if (isProtectedAdvancedAiAssetPath(normalizedAssetPath)) {
      await hydrateAdminState(env);
      const actor = await userForToken(env, safeCookieValue(request.headers.get("cookie") ?? undefined, "ion_ai_access") ?? "");
      if (!actor || !hasWorkerAdvancedAiAccess(actor)) return new Response(null, { status: 404 });
      const response = await env.ASSETS?.fetch(request);
      if (!response) return new Response("Worker assets binding is not configured", { status: 503 });
      const headers = new Headers(response.headers);
      headers.set("cache-control", "private, no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return env.ASSETS?.fetch(request) ?? new Response("Worker assets binding is not configured", { status: 503 });
  },
};

export class AccountState {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly state: DurableObjectState, private readonly env: Env = {}) {}

  fetch(request: Request): Promise<Response> {
    const operation = this.operationQueue.then(() => this.handleSafely(request));
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async handleSafely(request: Request): Promise<Response> {
    try {
      return await this.handle(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "账户状态操作失败" }, 400);
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const payload = normalizeAdminState((await this.state.storage.get<AdminStatePayload>("state")) ?? defaultAdminState());
    if (migrateWorkerUserSecrets(payload, this.env)) await this.state.storage.put("state", payload);
    if (request.method === "GET") {
      if (finalizeWorkerSecurityIncidents(payload, Date.now())) await this.state.storage.put("state", payload);
      return json(payload);
    }
    const body = await readJson(request);

    if (url.pathname === "/initialize") {
      if (payload.users.length === 0) {
        const users = structuredClone((body.users as StoredUser[] | undefined) ?? []);
        ensureSingleSuperAdmin(users);
        payload.users = users;
      }
      await this.state.storage.put("state", payload);
      return json(payload);
    }
    if (url.pathname === "/users/register") {
      const user = structuredClone(body.user as StoredUser);
      if (!user?.id || !user.usernameLookup) throw new Error("注册用户数据不完整");
      if (payload.users.some((item) => item.usernameLookup === user.usernameLookup)) throw new Error("用户名已存在");
      const inviteCode = String(body.inviteCode ?? "").trim();
      if (!inviteCode) throw new Error("注册必须填写邀请码");
      const configuredInvitation = payload.invitations.find((item) => item.code === inviteCode);
      const grantedReservedRoomCode = configuredInvitation?.reservedRoomCodeMode
        ? await prepareWorkerReservedRoomCodeGrant(this.env, payload, user, configuredInvitation.reservedRoomCodeMode, body.reservedRoomCode)
        : undefined;
      const invitation = consumeWorkerInvitation(
        payload,
        inviteCode,
        user.id,
        String(body.deviceHash ?? `internal:${user.id}`),
        String(body.browserHash ?? `internal:${user.id}`),
      );
      applyWorkerInvitation(user, invitation);
      if (grantedReservedRoomCode) user.reservedRoomCodes = [grantedReservedRoomCode];
      if (invitation.permissions && Object.keys(invitation.permissions).length > 0) {
        payload.userPermissions[user.id] = {
          permissions: normalizeWorkerPermissionPatch(invitation.permissions),
          permanent: true,
        };
      }
      if (invitation.customModeLimits && Object.keys(invitation.customModeLimits).length > 0) {
        payload.userCustomModeLimits[user.id] = {
          limits: normalizeCustomModeLimitGrant(invitation.customModeLimits),
          permanent: true,
        };
      }
      payload.users.push(user);
      await this.state.storage.put("state", payload);
      return json({ user });
    }
    if (url.pathname === "/invitations/preflight") {
      const invitation = preflightWorkerInvitation(
        payload,
        String(body.inviteCode ?? ""),
        String(body.deviceHash ?? ""),
        String(body.browserHash ?? ""),
        Date.now(),
      );
      return json({ ok: true, reservedRoomCodeMode: invitation.reservedRoomCodeMode });
    }
    if (url.pathname === "/users/set") {
      const user = structuredClone(body.user as StoredUser);
      const index = payload.users.findIndex((item) => item.id === user?.id);
      if (index < 0) throw new Error("用户不存在");
      if (body.baseUpdatedAt !== undefined && payload.users[index].updatedAt !== Number(body.baseUpdatedAt)) {
        throw new Error("用户信息已在其他设备上更新，请刷新后重试");
      }
      payload.users[index] = user;
      if (body.permissions !== undefined) {
        if (body.permissions === null) delete payload.userPermissions[user.id];
        else payload.userPermissions[user.id] = {
          permissions: normalizeWorkerPermissionPatch(body.permissions as Partial<PermissionRule>),
          permanent: body.permissionsPermanent !== undefined ? Boolean(body.permissionsPermanent) : true,
          expiresAt: typeof body.permissionsExpiresAt === "string" ? body.permissionsExpiresAt : undefined,
        };
      }
      if (body.customModeLimits !== undefined) {
        if (body.customModeLimits === null) delete payload.userCustomModeLimits[user.id];
        else payload.userCustomModeLimits[user.id] = {
          limits: normalizeCustomModeLimitGrant(body.customModeLimits as CustomModeLimitGrant),
          permanent: body.customModeLimitsPermanent !== undefined ? Boolean(body.customModeLimitsPermanent) : true,
          expiresAt: typeof body.customModeLimitsExpiresAt === "string" ? body.customModeLimitsExpiresAt : undefined,
        };
      }
      ensureSingleSuperAdmin(payload.users);
      await this.state.storage.put("state", payload);
      return json({ user });
    }
    if (url.pathname === "/users/replace") {
      const users = structuredClone((body.users as StoredUser[] | undefined) ?? []);
      ensureSingleSuperAdmin(users);
      payload.users = users;
      await this.state.storage.put("state", payload);
      return json({ ok: true });
    }
    if (url.pathname === "/users/points/bulk") {
      const actor = payload.users.find((item) => item.id === String(body.actorUserId ?? ""));
      if (!actor?.superAdmin) throw new Error("只有超级管理员可以一键发放积分");
      const targetUserIds = [...new Set(((body.targetUserIds as string[] | undefined) ?? []).map(String).filter(Boolean))];
      if (!targetUserIds.length) throw new Error("请选择要发放积分的用户");
      const targets = targetUserIds.map((id) => payload.users.find((user) => user.id === id));
      if (targets.some((user) => !user)) throw new Error("部分用户不存在");
      const grants = body.distributionMode === "equal"
        ? equalWorkerPointGrants(targetUserIds, Number(body.perUserPoints ?? 0))
        : randomWorkerPointGrants(targetUserIds, Number(body.totalPoints ?? 0));
      const now = Date.now();
      for (const grant of grants) {
        const target = payload.users.find((user) => user.id === grant.userId);
        if (!target) throw new Error("用户不存在");
        target.points = (target.points ?? 0) + grant.points;
        target.updatedAt = now;
      }
      await this.state.storage.put("state", payload);
      return json({ grants, totalPoints: grants.reduce((sum, item) => sum + item.points, 0) });
    }
    if (url.pathname === "/users/delete") {
      const target = payload.users.find((item) => item.id === String(body.userId ?? ""));
      if (!target) throw new Error("用户不存在");
      if (target.superAdmin) throw new Error("超级管理员不可删除");
      payload.users = payload.users.filter((item) => item.id !== target.id);
      delete payload.userPermissions[target.id];
      delete payload.userCustomModeLimits[target.id];
      await this.state.storage.put("state", payload);
      return json({ ok: true });
    }
    if (url.pathname === "/users/settle") {
      const accountIds = [...new Set(((body.accountIds as string[] | undefined) ?? []).map(String))];
      const winnerId = String(body.winnerAccountId ?? "");
      const amount = Math.max(0, Math.floor(Number(body.amount ?? 0)));
      const winnerTax = Math.max(0, Math.floor(Number(body.winnerTax ?? 0)));
      const gameId = String(body.gameId ?? "");
      if (!gameId) throw new Error("结算缺少游戏 ID");
      if (payload.settledGameIds.includes(gameId)) return json({ ok: true, duplicate: true });
      const now = Date.now();
      for (const id of accountIds) {
        const user = payload.users.find((item) => item.id === id);
        if (!user) continue;
        user.gamesPlayed += 1;
        if (id === winnerId) user.gamesWon += 1;
        recordTodayStats(user, id === winnerId, now);
        user.updatedAt = now;
      }
      const winner = payload.users.find((item) => item.id === winnerId);
      if (winner && amount > 0) {
        for (const loserId of accountIds.filter((id) => id !== winnerId)) {
          const loser = payload.users.find((item) => item.id === loserId);
          if (!loser) continue;
          loser.points = (loser.points ?? 0) - amount;
          addWorkerTodayGamePointsDelta(loser, -amount, now);
          winner.points = (winner.points ?? 0) + amount;
          addWorkerTodayGamePointsDelta(winner, amount, now);
          loser.updatedAt = now;
        }
        winner.updatedAt = now;
      }
      if (winner && winnerTax > 0) {
        winner.points = (winner.points ?? 0) - winnerTax;
        addWorkerTodayGamePointsDelta(winner, -winnerTax, now);
        winner.updatedAt = now;
      }
      payload.settledGameIds.push(gameId);
      payload.settledGameIds = payload.settledGameIds.slice(-10_000);
      await this.state.storage.put("state", payload);
      return json({ ok: true });
    }
    if (url.pathname === "/invitations/upsert") {
      const now = Date.now();
      const code = validateCode(String(body.code || randomBytes(8).toString("base64url")));
      let invitation = payload.invitations.find((item) => item.code === code);
      if (!invitation) {
        invitation = {
          code,
          remainingUses: null,
          role: "normal",
          initialPoints: 0,
          usePolicy: "unlimited",
          maxUses: 1,
          registrations: [],
          createdAt: now,
          updatedAt: now,
        };
        payload.invitations.push(invitation);
      }
      applyInvitationBody(invitation, body);
      invitation.updatedAt = now;
      await this.state.storage.put("state", payload);
      return json({ invitation });
    }
    if (url.pathname === "/invitations/delete") {
      payload.invitations = payload.invitations.filter((item) => item.code !== String(body.code ?? ""));
      await this.state.storage.put("state", payload);
      return json({ ok: true });
    }
    if (url.pathname === "/invitations/consume") {
      const invitation = consumeWorkerInvitation(
        payload,
        String(body.code ?? ""),
        String(body.userId ?? uid("registration")),
        String(body.deviceHash ?? uid("device")),
        String(body.browserHash ?? uid("browser")),
      );
      await this.state.storage.put("state", payload);
      return json({ invitation });
    }
    if (url.pathname === "/permissions/update") {
      const role = body.role as UserRole | undefined;
      const userId = typeof body.userId === "string" ? body.userId : undefined;
      if (Boolean(role) === Boolean(userId)) throw new Error("每次只能修改一个身份组或一个用户的权限");
      if (role) {
        if (!isUserRole(role)) throw new Error("身份组不正确");
        payload.rolePermissions[role] = normalizeWorkerPermission({ ...payload.rolePermissions[role], ...(body.permissions as Partial<PermissionRule>) });
      }
      if (userId) {
        if (!payload.users.some((user) => user.id === userId)) throw new Error("用户不存在");
        if (body.permissions === null) delete payload.userPermissions[userId];
        else payload.userPermissions[userId] = { permissions: normalizeWorkerPermissionPatch(body.permissions as Partial<PermissionRule>), permanent: true };
      }
      await this.state.storage.put("state", payload);
      return json({ ok: true });
    }
    if (url.pathname === "/custom-mode-limits/update") {
      payload.customModeLimits = normalizeCustomModeLimits(body.limits as CustomModeLimitGrant);
      await this.state.storage.put("state", payload);
      return json({ ok: true });
    }
    if (url.pathname === "/presets/create") {
      const actor = mustWorkerPresetAdmin(payload, body.actorUserId);
      if (body.sourceDocument === undefined) throw new Error("缺少规则文档");
      const preset = buildWorkerPresetEntry(payload, actor.id, body.displayName, body.sourceDocument);
      payload.customRulesPresets.push(preset);
      await this.state.storage.put("state", payload);
      return json({ preset });
    }
    if (url.pathname === "/presets/update") {
      const actor = mustWorkerPresetAdmin(payload, body.actorUserId);
      const preset = payload.customRulesPresets.find((item) => item.id === String(body.id ?? ""));
      if (!preset) throw new Error("预设不存在");
      const next = body.sourceDocument !== undefined
        ? buildWorkerPresetEntry(payload, actor.id, body.displayName !== undefined ? body.displayName : preset.displayName, body.sourceDocument, preset)
        : { ...preset, displayName: body.displayName !== undefined ? cleanWorkerPresetDisplayName(body.displayName) : preset.displayName, updatedAt: Date.now(), updatedBy: actor.id };
      if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
      payload.customRulesPresets[payload.customRulesPresets.indexOf(preset)] = next;
      await this.state.storage.put("state", payload);
      return json({ preset: next });
    }
    if (url.pathname === "/presets/delete") {
      mustWorkerPresetAdmin(payload, body.actorUserId);
      const before = payload.customRulesPresets.length;
      payload.customRulesPresets = payload.customRulesPresets.filter((item) => item.id !== String(body.id ?? ""));
      if (payload.customRulesPresets.length === before) throw new Error("预设不存在");
      await this.state.storage.put("state", payload);
      return json({ ok: true });
    }
    if (url.pathname === "/presets/duplicate") {
      const actor = mustWorkerPresetAdmin(payload, body.actorUserId);
      const preset = payload.customRulesPresets.find((item) => item.id === String(body.id ?? ""));
      if (!preset) throw new Error("预设不存在");
      const copy = buildWorkerPresetEntry(payload, actor.id, `${preset.displayName} 副本`.slice(0, 40), preset.sourceDocument);
      payload.customRulesPresets.push(copy);
      await this.state.storage.put("state", payload);
      return json({ preset: copy });
    }
    if (url.pathname === "/tax/update") {
      payload.taxRatePercent = normalizeTaxRatePercent(body.taxRatePercent, payload.taxRatePercent);
      payload.taxWinnerPointsThreshold = normalizeTaxWinnerPointsThreshold(body.taxWinnerPointsThreshold, payload.taxWinnerPointsThreshold);
      await this.state.storage.put("state", payload);
      return json({ taxRatePercent: payload.taxRatePercent, taxWinnerPointsThreshold: payload.taxWinnerPointsThreshold });
    }
    if (url.pathname === "/requests/create") {
      const kind = String(body.kind ?? "") as WorkerRequest["kind"];
      if (!["ticket", "unban", "nickname"].includes(kind)) throw new Error("申请类型不正确");
      const requestedNickname = kind === "nickname" ? validateNickname(String(body.requestedNickname ?? "")) : undefined;
      const text = kind === "nickname" ? `申请修改昵称为：${requestedNickname}` : String(body.text ?? "").trim().slice(0, 1000);
      if (!text) throw new Error("内容不能为空");
      const fromUserId = String(body.fromUserId ?? "");
      const requester = payload.users.find((item) => item.id === fromUserId);
      if (!requester) throw new Error("申请用户不存在");
      if (kind === "unban") {
        if (!isStoredUserDisabled(requester)) throw new Error("当前账号未被禁用");
        requester.disabledAt ??= Date.now();
        if (requester.unbanRequestedForDisabledAt === requester.disabledAt) throw new Error("本次被禁用后只能提交一次解封申请");
        requester.unbanRequestedForDisabledAt = requester.disabledAt;
        requester.updatedAt = Date.now();
      }
      const request: WorkerRequest = {
        id: uid("req"),
        kind,
        fromUserId,
        text,
        privateToSuperAdmin: Boolean(body.privateToSuperAdmin),
        requestedNickname,
        status: "open",
        createdAt: nextWorkerRequestActivityAt(payload.requests),
        banSnapshot:
          kind === "unban"
            ? {
                disabledAt: requester.disabledAt,
                disabledUntil: requester.disabledUntil,
                disabledPermanent: requester.disabledPermanent,
                disabledBy: requester.disabledBy,
              }
            : undefined,
      };
      payload.requests.push(request);
      await this.state.storage.put("state", payload);
      return json({ request });
    }
    if (url.pathname === "/security/record") {
      const now = Number.isFinite(Number(body.occurredAt)) ? Number(body.occurredAt) : Date.now();
      finalizeWorkerSecurityIncidents(payload, now);
      const subjectKey = String(body.subjectKey ?? "").slice(0, 240);
      if (!subjectKey) throw new Error("安全事件缺少主体");
      let incident = payload.securityIncidents.find(
        (item) => !item.reportedAt && item.subjectKey === subjectKey && now < item.endsAt,
      );
      if (!incident) {
        incident = {
          id: uid("security"),
          subjectKey,
          actorUserId: typeof body.actorUserId === "string" ? body.actorUserId : undefined,
          startedAt: now,
          endsAt: now + SECURITY_CAPTURE_MS,
          events: [],
        };
        payload.securityIncidents.push(incident);
      }
      const event: WorkerSecurityEvent = {
        actorUserId: typeof body.actorUserId === "string" ? body.actorUserId : undefined,
        subjectKey,
        category: validateWorkerSecurityCategory(body.category),
        operation: cleanRequiredWorkerText(body.operation, 160),
        method: cleanRequiredWorkerText(body.method, 16),
        route: cleanRequiredWorkerText(body.route, 240),
        ip: cleanOptional(typeof body.ip === "string" ? body.ip : null, 160),
        userAgent: cleanOptional(typeof body.userAgent === "string" ? body.userAgent : null, 500),
        details: sanitizeWorkerAuditDetails(body.details),
        occurredAt: now,
      };
      if (incident.events.length < MAX_SECURITY_EVENTS_PER_INCIDENT) incident.events.push(event);
      else incident.suppressedEvents = (incident.suppressedEvents ?? 0) + 1;
      trimWorkerSecurityIncidents(payload);
      await this.state.storage.put("state", payload);
      return json({ ok: true, incidentId: incident.id });
    }
    if (url.pathname === "/requests/respond") {
      const ticket = payload.requests.find((item) => item.id === String(body.id ?? ""));
      if (!ticket) throw new Error("申请不存在");
      if (ticket.status !== "open") throw new Error("该申请已经处理");
      const status = body.status as WorkerRequest["status"];
      if (!["approved", "replied", "ignored"].includes(status)) throw new Error("处理状态不正确");
      if (ticket.kind === "security" && status === "ignored") {
        payload.requests = payload.requests.filter((item) => item.id !== ticket.id);
        await this.state.storage.put("state", payload);
        return json({ request: { ...ticket, status: "ignored" } });
      }
      ticket.status = status;
      ticket.reply = String(body.reply ?? "").trim() || undefined;
      ticket.replyUserId = String(body.replyUserId ?? "");
      ticket.repliedAt = nextWorkerRequestActivityAt(payload.requests);
      if (ticket.kind === "nickname" && status === "approved" && ticket.requestedNickname) {
        const target = payload.users.find((item) => item.id === ticket.fromUserId);
        if (!target) throw new Error("申请用户不存在");
        target.nickname = ticket.requestedNickname;
        target.updatedAt = Date.now();
      }
      if (ticket.kind === "unban" && status === "approved") {
        const target = payload.users.find((item) => item.id === ticket.fromUserId);
        if (!target) throw new Error("申请用户不存在");
        target.disabledPermanent = false;
        target.disabledUntil = undefined;
        target.updatedAt = Date.now();
      }
      await this.state.storage.put("state", payload);
      return json({ request: ticket });
    }
    if (url.pathname === "/requests/ack") {
      const userId = String(body.userId ?? "");
      if (!payload.users.some((user) => user.id === userId)) throw new Error("用户不存在");
      const maximum = maxWorkerRequestActivity(payload.requests);
      const requested = Number(body.through);
      const bounded = Number.isFinite(requested) ? Math.min(Math.max(0, Math.floor(requested)), maximum) : maximum;
      const seenThrough = Math.max(payload.requestSeenAtByUserId[userId] ?? 0, bounded);
      payload.requestSeenAtByUserId[userId] = seenThrough;
      await this.state.storage.put("state", payload);
      return json({ seenThrough });
    }
    if (url.pathname === "/reserved-room-codes/list") {
      const actor = payload.users.find((item) => item.id === String(body.actorUserId ?? ""));
      const target = payload.users.find((item) => item.id === String(body.userId ?? actor?.id ?? ""));
      if (!actor || !target || !canManageExclusiveRoomCode(actor, target, "read")) throw new Error("没有权限查看该用户的专属房间号");
      return json({ reservedRoomCodes: normalizeReservedRoomCodes(target.reservedRoomCodes) });
    }
    if (url.pathname === "/reserved-room-codes/add") {
      const actor = payload.users.find((item) => item.id === String(body.actorUserId ?? ""));
      const target = payload.users.find((item) => item.id === String(body.userId ?? ""));
      if (!actor || !target || !canManageExclusiveRoomCode(actor, target, "add")) throw new Error("没有权限添加该用户的专属房间号");
      const code = validateExclusiveRoomCode(body.code, actor.superAdmin);
      ensureExclusiveRoomCodeAvailable(payload, code, target.id);
      if (await workerRoomCodeIsOccupied(this.env, code)) throw new Error("该专属房间号已被现有房间占用");
      const codes = normalizeReservedRoomCodes(target.reservedRoomCodes);
      if (!actor.superAdmin && codes.length >= 10) throw new Error("每个用户最多只能拥有 10 个专属房间号");
      if (codes.includes(code)) throw new Error("该专属房间号已存在");
      target.reservedRoomCodes = [...codes, code];
      target.updatedAt = Date.now();
      await this.state.storage.put("state", payload);
      return json({ reservedRoomCodes: target.reservedRoomCodes });
    }
    if (url.pathname === "/reserved-room-codes/update") {
      const actor = payload.users.find((item) => item.id === String(body.actorUserId ?? ""));
      const target = payload.users.find((item) => item.id === String(body.userId ?? ""));
      if (!actor || !target || !canManageExclusiveRoomCode(actor, target, "update")) throw new Error("没有权限编辑该用户的专属房间号");
      const previous = String(body.previousCode ?? "");
      const codes = normalizeReservedRoomCodes(target.reservedRoomCodes);
      if (!codes.includes(previous)) throw new Error("专属房间号不存在");
      const code = validateExclusiveRoomCode(body.code, actor.superAdmin);
      ensureExclusiveRoomCodeAvailable(payload, code, target.id, previous);
      if (code !== previous && await workerRoomCodeIsOccupied(this.env, code)) throw new Error("该专属房间号已被现有房间占用");
      target.reservedRoomCodes = codes.map((item) => (item === previous ? code : item));
      target.updatedAt = Date.now();
      await this.state.storage.put("state", payload);
      return json({ reservedRoomCodes: target.reservedRoomCodes });
    }
    if (url.pathname === "/reserved-room-codes/delete") {
      const actor = payload.users.find((item) => item.id === String(body.actorUserId ?? ""));
      const target = payload.users.find((item) => item.id === String(body.userId ?? ""));
      if (!actor || !target || !canManageExclusiveRoomCode(actor, target, "delete")) throw new Error("没有权限删除该用户的专属房间号");
      const code = String(body.code ?? "");
      const codes = normalizeReservedRoomCodes(target.reservedRoomCodes);
      if (!codes.includes(code)) throw new Error("专属房间号不存在");
      target.reservedRoomCodes = codes.filter((item) => item !== code);
      target.updatedAt = Date.now();
      await this.state.storage.put("state", payload);
      return json({ reservedRoomCodes: target.reservedRoomCodes });
    }
    if (url.pathname === "/activations/upsert") {
      const activation = upsertWorkerActivation(payload, body);
      await this.state.storage.put("state", payload);
      return json({ activation });
    }
    if (url.pathname === "/activations/delete") {
      payload.activationCodes = payload.activationCodes.filter((item) => item.code !== String(body.code ?? ""));
      await this.state.storage.put("state", payload);
      return json({ ok: true });
    }
    if (url.pathname === "/activations/prepare") {
      const activation = payload.activationCodes.find((item) => item.code === validateCode(String(body.code ?? "")));
      if (!activation) throw new Error("激活码不存在");
      const now = Date.now();
      if (activation.expiresAt && Date.parse(activation.expiresAt) <= now) throw new Error("激活码已失效");
      const userId = String(body.userId ?? "");
      enforceWorkerActivationQuota(activation, userId, now);
      const user = payload.users.find((item) => item.id === userId);
      if (!user) throw new Error("用户不存在");
      if (isStoredUserDisabled(user, now)) throw new Error("账号禁用期间不能兑换激活码");
      ensureWorkerRedemptionReservedRoomCodeAllowance(user);
      if (activation.kind !== "point-distribution" && activation.requireNonNegativeBalance && (user.points ?? 0) + activation.points < 0) {
        throw new Error("兑换后积分不能为负数");
      }
      return json({
        titleMode: activation.titleMode ?? "default",
        nicknameColorMode: activation.nicknameColorMode ?? "default",
        reservedRoomCodeMode: activation.reservedRoomCodeMode,
      });
    }
    if (url.pathname === "/activations/redeem") {
      const activation = payload.activationCodes.find((item) => item.code === validateCode(String(body.code ?? "")));
      if (!activation) throw new Error("激活码不存在");
      const now = Date.now();
      if (activation.expiresAt && Date.parse(activation.expiresAt) <= now) throw new Error("激活码已失效");
      enforceWorkerActivationQuota(activation, String(body.userId ?? ""), now);
      const userId = String(body.userId ?? "");
      const user = payload.users.find((item) => item.id === userId);
      if (!user) throw new Error("用户不存在");
      if (isStoredUserDisabled(user, now)) throw new Error("账号禁用期间不能兑换激活码");
      ensureWorkerRedemptionReservedRoomCodeAllowance(user);
      const grantedReservedRoomCode = activation.reservedRoomCodeMode
        ? await prepareWorkerReservedRoomCodeGrant(this.env, payload, user, activation.reservedRoomCodeMode, body.reservedRoomCode)
        : undefined;
      const redeemedPoints = activation.kind === "point-distribution" ? workerPointDistributionReward(activation) : activation.points;
      const nextPoints = (user.points ?? 0) + redeemedPoints;
      if (activation.requireNonNegativeBalance && nextPoints < 0) throw new Error("兑换后积分不能为负数");
      const titleMode = activation.titleMode ?? "default";
      const nextTitle =
        titleMode === "fixed"
          ? activation.title
          : titleMode === "user-custom"
            ? cleanRequiredString(body.customTitle, 24)
            : undefined;
      const nicknameColorMode = activation.nicknameColorMode ?? "default";
      const nextNicknameColor =
        nicknameColorMode === "fixed"
          ? activation.nicknameColor
          : nicknameColorMode === "user-custom"
            ? validateHexColor(String(body.customNicknameColor ?? ""))
            : undefined;
      activation.redemptions.push({ userId, usedAt: now, points: redeemedPoints });
      user.points = nextPoints;
      if (titleMode !== "default") user.title = nextTitle;
      if (nicknameColorMode !== "default") user.nicknameColor = nextNicknameColor;
      if (activation.kind !== "point-distribution") applyWorkerActivation(user, activation, now);
      else user.updatedAt = now;
      if (grantedReservedRoomCode) user.reservedRoomCodes = [...normalizeReservedRoomCodes(user.reservedRoomCodes), grantedReservedRoomCode];
      if (activation.kind !== "point-distribution" && activation.permissions && activation.permissionDurationMs !== undefined) {
        const durationMs = activation.permissionDurationMs;
        const existing = payload.userPermissions[userId];
        const permanent = durationMs === null || Boolean(existing?.permanent);
        const base = existing?.expiresAt ? Math.max(now, Date.parse(existing.expiresAt)) : now;
        payload.userPermissions[userId] = {
          permissions: normalizeWorkerPermissionPatch({ ...(existing?.permissions ?? {}), ...activation.permissions }),
          permanent,
          expiresAt: permanent || durationMs === null ? undefined : new Date(base + durationMs).toISOString(),
        };
      }
      if (activation.kind !== "point-distribution" && activation.customModeLimits && activation.customModeLimitDurationMs !== undefined) {
        const durationMs = activation.customModeLimitDurationMs;
        const existing = payload.userCustomModeLimits[userId];
        const permanent = durationMs === null || Boolean(existing?.permanent);
        const base = existing?.expiresAt ? Math.max(now, Date.parse(existing.expiresAt)) : now;
        payload.userCustomModeLimits[userId] = {
          limits: normalizeCustomModeLimitGrant({ ...(existing?.limits ?? {}), ...activation.customModeLimits }),
          permanent,
          expiresAt: permanent || durationMs === null ? undefined : new Date(base + durationMs).toISOString(),
        };
      }
      activation.updatedAt = now;
      await this.state.storage.put("state", payload);
      return json({ activation, user });
    }
    if (url.pathname === "/duel/check") {
      const userId = String(body.userId ?? "");
      const status = workerDuelCooldownStatus(payload, userId);
      if (!status.allowed) return json({ duelCooldownUntil: status.retryAt, duelDenied: status.retryAt === undefined });
      return json({ ok: true });
    }
    if (url.pathname === "/duel/reserve") {
      const userId = String(body.userId ?? "");
      const now = Date.now();
      const user = payload.users.find((item) => item.id === userId);
      if (!user) throw new Error("用户不存在");
      const rule = workerPermissionsForPayload(payload, user).duelLimit;
      const status = workerDuelLimitStatus(rule, duelRecordsFor(payload.duelRoomCooldowns[userId]), now);
      if (!status.allowed) return json({ duelCooldownUntil: status.retryAt, duelDenied: status.retryAt === undefined });
      if (rule.period !== "unlimited") payload.duelRoomCooldowns[userId] = pruneWorkerDuelRecords(rule, duelRecordsFor(payload.duelRoomCooldowns[userId]), now).concat(now);
      await this.state.storage.put("state", payload);
      return json({ ok: true, reservedAt: now });
    }
    if (url.pathname === "/duel/release") {
      const userId = String(body.userId ?? "");
      const reservedAt = Number(body.reservedAt);
      const records = duelRecordsFor(payload.duelRoomCooldowns[userId]);
      if (Number.isFinite(reservedAt) && records.includes(reservedAt)) {
        const next = records.filter((item) => item !== reservedAt);
        if (next.length) payload.duelRoomCooldowns[userId] = next;
        else delete payload.duelRoomCooldowns[userId];
        await this.state.storage.put("state", payload);
      }
      return json({ ok: true });
    }
    if (url.pathname === "/duel/record") {
      const userId = String(body.userId ?? "");
      const now = Date.now();
      const user = payload.users.find((item) => item.id === userId);
      if (!user) throw new Error("用户不存在");
      const rule = workerPermissionsForPayload(payload, user).duelLimit;
      const status = workerDuelLimitStatus(rule, duelRecordsFor(payload.duelRoomCooldowns[userId]), now);
      if (!status.allowed) return json({ duelCooldownUntil: status.retryAt, duelDenied: status.retryAt === undefined });
      if (rule.period !== "unlimited") payload.duelRoomCooldowns[userId] = pruneWorkerDuelRecords(rule, duelRecordsFor(payload.duelRoomCooldowns[userId]), now).concat(now);
      await this.state.storage.put("state", payload);
      return json({ ok: true });
    }
    return json({ error: "未知账户状态操作" }, 404);
  }
}

export class RoomState {
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly sockets = new Map<WebSocket, RoomSocketMeta>();
  private readonly socketJoinTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (isWebSocketUpgradeRequest(request)) return this.enqueue(() => this.handleWebSocketUpgrade(request));
    const operation = this.enqueue(() => this.handleSafely(request));
    return operation;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.operationQueue.then(task, task);
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code")?.trim() ?? "";
    if (!/^\d+$/.test(code)) return json({ error: "房间号必须是数字" }, 400);
    const room = await this.load(code);
    if (!room || room.code !== code) return json({ error: "房间不存在或已回收" }, 404);
    const pendingSockets = [...this.sockets.values()].filter((meta) => !meta.playerId).length;
    if (this.sockets.size >= MAX_WEBSOCKETS_PER_ROOM || pendingSockets >= MAX_PENDING_WEBSOCKETS_PER_ROOM) {
      return json({ error: "WebSocket 连接数量已达上限" }, 429);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.set(server, { code });
    this.socketJoinTimers.set(
      server,
      setTimeout(() => {
        if (this.sockets.get(server)?.playerId) return;
        this.sockets.delete(server);
        this.socketJoinTimers.delete(server);
        try {
          server.close(1008, "Join timeout");
        } catch {
          // The peer may already have disconnected.
        }
      }, WEBSOCKET_JOIN_TIMEOUT_MS),
    );

    server.addEventListener("message", (event: MessageEvent) => {
      void this.enqueue(async () => {
        try {
          const message = this.parseSocketMessage(event.data);
          await this.handleSocketMessage(server, code, message);
        } catch (error) {
          if (error instanceof Error && error.message === "WebSocket 消息过大") {
            try {
              server.close(1009, "Message too large");
            } finally {
              this.clearSocketJoinTimer(server);
              this.sockets.delete(server);
            }
            return;
          }
          this.send(server, "actionRejected", { message: error instanceof Error ? error.message : "请求失败" });
        }
      });
    });

    server.addEventListener("close", () => {
      void this.enqueue(async () => {
        await this.handleSocketClose(server);
      });
    });

    server.addEventListener("error", () => {
      void this.enqueue(async () => {
        await this.handleSocketClose(server);
      });
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private parseSocketMessage(data: unknown): RoomClientMessage {
    let raw: string;
    if (typeof data === "string") {
      if (data.length > MAX_WEBSOCKET_PAYLOAD_BYTES || new TextEncoder().encode(data).byteLength > MAX_WEBSOCKET_PAYLOAD_BYTES) {
        throw new Error("WebSocket 消息过大");
      }
      raw = data;
    } else if (data instanceof ArrayBuffer) {
      if (data.byteLength > MAX_WEBSOCKET_PAYLOAD_BYTES) throw new Error("WebSocket 消息过大");
      raw = new TextDecoder().decode(data);
    } else {
      throw new Error("WebSocket 消息格式无效");
    }
    const message = JSON.parse(raw) as RoomClientMessage;
    if (!message || typeof message !== "object" || typeof message.type !== "string") throw new Error("消息格式无效");
    return message;
  }

  private async handleSocketMessage(socket: WebSocket, code: string, message: RoomClientMessage): Promise<void> {
    if (message.code !== code) throw new Error("房间号不匹配");
    await hydrateAdminState(this.env);

    let room = await this.load(code);
    if (!room) throw new Error("房间不存在或已回收");

    if (message.type === "joinRoom") {
      const actor = await userForToken(this.env, message.token ?? "");
      if (!actor) throw new Error("请先登录后加入联机房间");
      if (publicUser(this.env, actor).disabled) throw new Error("该用户已被禁用，请联系管理员或超级管理员");

      const player = joinRoom(room, this.env, actor, message.playerId);
      markPlayerOnline(room, player.id);
      this.sockets.set(socket, { code, playerId: player.id, actorId: actor.id });
      this.clearSocketJoinTimer(socket);

      await this.persist(room);
      this.send(socket, "joined", { playerId: player.id, ...roomPayload(room, player.id) });
      this.broadcastRoom(room);
      return;
    }

    const meta = this.sockets.get(socket);
    if (!meta?.playerId || !meta.actorId) throw new Error("请先加入房间");

    const actor = memory.adminState.users.find((user) => user.id === meta.actorId);
    if (!actor) throw new Error("请先登录");

    if ("playerId" in message && typeof message.playerId === "string") markPlayerOnline(room, message.playerId);
    if ("ownerId" in message && typeof message.ownerId === "string") markPlayerOnline(room, message.ownerId);

    if (message.type === "refreshState") {
      this.ensureSocketPlayer(socket, message.playerId);
      ensurePlayerAccount(room, message.playerId, actor.id);
      const changed = await advanceRoomIfNeeded(this.env, room);
      if (changed) await this.persist(room);
      if (await this.maybeDissolveDuel(room)) return;
      this.send(socket, "refreshStateResult", { requestId: message.requestId, ...roomPayload(room, message.playerId) });
      return;
    }

    if (message.type === "gameStartedAck") {
      this.ensureSocketPlayer(socket, message.playerId);
      ensurePlayerAccount(room, message.playerId, actor.id);
      if (room.startAckGameId === message.gameId) {
        room.startAckedPlayerIds ??= [];
        if (!room.startAckedPlayerIds.includes(message.playerId)) room.startAckedPlayerIds.push(message.playerId);
        await this.persist(room);
      }
      return;
    }

    if (message.type === "cancelAutoplay") {
      this.ensureSocketPlayer(socket, message.playerId);
      ensurePlayerAccount(room, message.playerId, actor.id);
      cancelAutoplay(room, message.playerId);
      await this.persist(room);
      this.broadcastRoom(room);
      return;
    }

    if (message.type === "startGame") {
      this.ensureSocketPlayer(socket, message.playerId);
      ensurePlayerAccount(room, message.playerId, actor.id);
      try {
        await confirmStart(this.env, room, message.playerId, message.customRulesHashReady);
      } catch (error) {
        if (room.editNotice?.problems?.length) {
          await this.persist(room);
          this.broadcastRoom(room);
        }
        throw error;
      }
      await this.persist(room);
      this.broadcastRoom(room);
      return;
    }

    if (message.type === "submitAction") {
      this.ensureSocketPlayer(socket, message.playerId);

      if (containsProtectedGameMutation(message) || !isStrictActionIntent(message.action)) {
        await auditWorkerSecurity(
          this.env,
          actor,
          containsProtectedGameMutation(message) || containsProtectedGameMutation(message.action) ? "protected-mutation" : "forged-action",
          "malformed-game-action",
          { code, playerId: message.playerId, action: message.action },
        );
        throw new Error("动作请求格式无效");
      }

      try {
        ensureActionAccount(room, message.playerId, actor.id);
      } catch (error) {
        await auditWorkerSecurity(this.env, actor, "unauthorized-operation", "room-seat-action", {
          code,
          playerId: message.playerId,
        });
        throw error;
      }

      const result = await submit(this.env, room, message.playerId, message.action);
      await this.persist(room);

      if (!result.ok) this.send(socket, "actionRejected", { message: result.message });
      this.broadcastRoom(room);
      if (await this.maybeDissolveDuel(room)) return;
      return;
    }

    if (message.type === "botAction") {
      await auditWorkerSecurity(this.env, actor, "unauthorized-operation", "client-bot-action", {
        code,
        ownerId: message.ownerId,
        botId: message.botId,
      });
      throw new Error("联机机器人由服务器自动操作");
    }

    if (message.type === "addBot") {
      this.ensureSocketPlayer(socket, message.ownerId);
      ensurePlayerAccount(room, message.ownerId, actor.id);
      addBot(room, message.ownerId);
      await this.persist(room);
      this.broadcastRoom(room);
      return;
    }

    if (message.type === "kickPlayer") {
      this.ensureSocketPlayer(socket, message.playerId);
      ensurePlayerAccount(room, message.playerId, actor.id);
      kickPlayer(room, actor.id, message.targetId);
      await advanceRoomIfNeeded(this.env, room);
      await this.persist(room);
      this.broadcastRoom(room);
      return;
    }

    if (message.type === "editRoom") {
      this.ensureSocketPlayer(socket, message.playerId);
      ensurePlayerAccount(room, message.playerId, actor.id);
      editRoom(room, this.env, actor, message.capacity, message.baseBet, message.initialHandSize, message.turnTimeLimitSec, message.openingExchangeSec, message.customRules);
      await this.persist(room);
      this.broadcastRoom(room);
      return;
    }

    if (message.type === "leaveRoom") {
      this.ensureSocketPlayer(socket, message.playerId);
      ensurePlayerAccount(room, message.playerId, actor.id);
      leaveRoom(room, actor.id, message.playerId);
      await advanceRoomIfNeeded(this.env, room);
      await this.persist(room);
      this.send(socket, "leftRoom", {});
      this.broadcastRoom(room);
      return;
    }

    if (message.type === "heartbeat") {
      this.ensureSocketPlayer(socket, message.playerId);
      ensurePlayerAccount(room, message.playerId, actor.id);

      const presenceChanged = markPlayerOnline(room, message.playerId);
      const advanced = await advanceRoomIfNeeded(this.env, room);

      if (presenceChanged || advanced) {
        await this.persist(room);
        this.broadcastRoom(room);
      }
      return;
    }

    if (message.type === "leaveSeat") {
      this.ensureSocketPlayer(socket, message.playerId);
      ensurePlayerAccount(room, message.playerId, actor.id);
      this.markSocketPlayerOffline(room, message.playerId, socket);
      await this.persist(room);
      this.broadcastRoom(room);
      return;
    }
  }

  private async handleSocketClose(socket: WebSocket): Promise<void> {
    const meta = this.sockets.get(socket);
    this.clearSocketJoinTimer(socket);
    this.sockets.delete(socket);

    if (!meta?.code || !meta.playerId) return;

    const room = await this.load(meta.code);
    if (!room) return;

    this.markSocketPlayerOffline(room, meta.playerId, socket);
    await this.persist(room);
    this.broadcastRoom(room);
  }

  private ensureSocketPlayer(socket: WebSocket, playerId: string): void {
    const meta = this.sockets.get(socket);
    if (!meta?.playerId || meta.playerId !== playerId) throw new Error("没有权限操作该席位");
  }

  private clearSocketJoinTimer(socket: WebSocket): void {
    const timer = this.socketJoinTimers.get(socket);
    if (timer !== undefined) clearTimeout(timer);
    this.socketJoinTimers.delete(socket);
  }

  private markSocketPlayerOffline(room: Room, playerId: string, closingSocket?: WebSocket): void {
    if (this.hasOpenSocketForPlayer(playerId, closingSocket)) return;

    const now = Date.now();
    for (const player of [...room.players, ...(room.game?.players ?? [])]) {
      if (player.id === playerId) {
        player.online = false;
        player.lastSeenAt = now;
      }
    }
  }

  private hasOpenSocketForPlayer(playerId: string, ignoredSocket?: WebSocket): boolean {
    for (const [socket, meta] of this.sockets) {
      if (socket !== ignoredSocket && meta.playerId === playerId) return true;
    }
    return false;
  }

  private broadcastRoom(room: Room): void {
    for (const [socket, meta] of this.sockets) {
      if (meta.code !== room.code || !meta.playerId) continue;

      this.maybeSendGameStarted(socket, room, meta.playerId);
      this.send(socket, "roomState", {
        room: summarizeRoom(room),
        serverNow: Date.now(),
      });

      if (room.game) {
        this.send(socket, "gameState", {
          game: publicRulesetGame(room.game, meta.playerId),
          serverNow: Date.now(),
        });
      }

      if (room.game?.status === "playing" || room.game?.status === "opening-exchange") {
        this.send(socket, "timerSync", {
          currentPlayerId: rulesetCurrentPlayer(room.game).id,
          deadlineAt: room.game.turnDeadlineAt,
          limitMs: room.game.status === "opening-exchange" ? (room.game.openingExchangeWindowMs ?? OPENING_EXCHANGE_MS) : rulesetCurrentPlayer(room.game).timeoutLimitMs,
          serverNow: Date.now(),
        });
      }

      if (room.game?.status === "ended") {
        this.send(socket, "gameEnded", {
          winnerId: room.game.winnerId,
        });
      }
    }
  }

  private maybeSendGameStarted(socket: WebSocket, room: Room, playerId: string): void {
    if (!room.game || room.startAckGameId !== room.game.id) return;
    const player = room.players.find((item) => item.id === playerId);
    if (!player || player.bot) return;
    if ((room.startAckedPlayerIds ?? []).includes(playerId)) return;
    const now = Date.now();
    room.startAckLastSentAtByPlayerId ??= {};
    const lastSent = room.startAckLastSentAtByPlayerId[playerId] ?? 0;
    if (now - lastSent < 1000) return;
    room.startAckLastSentAtByPlayerId[playerId] = now;
    this.send(socket, "gameStarted", { gameId: room.game.id, ...roomPayload(room, playerId) });
  }

  private send(socket: WebSocket, type: string, payload: Record<string, unknown>): void {
    try {
      socket.send(JSON.stringify({ type, ...payload }));
    } catch {
      this.sockets.delete(socket);
    }
  }

  private async handleSafely(request: Request): Promise<Response> {
    try {
      return await this.handle(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "房间状态操作失败" }, 400);
    }
  }

  private async handle(request: Request): Promise<Response> {
    const command = await readJson(request);
    const code = String(command.code ?? "");
    const operation = String(command.operation ?? "");
    if (!/^\d+$/.test(code)) throw new Error("房间号必须是数字");
    if (operation === "exists") return json({ exists: Boolean(await this.load(code)) });
    await hydrateAdminState(this.env);

    let room = await this.load(code);
    const actorId = typeof command.actorId === "string" ? command.actorId : "";
    const actor = actorId ? memory.adminState.users.find((user) => user.id === actorId) : undefined;
    const body = (command.body && typeof command.body === "object" ? command.body : {}) as Record<string, unknown>;

    if (operation === "create") {
      mustLogin(actor);
      if (publicUser(this.env, actor!).disabled) throw new Error("该用户已被禁用，请联系管理员或超级管理员");
      const requestedRoomCode = resolveRequestedRoomCode(memory.adminState, actor!, body.roomCodeMode, body.roomCode);
      if (requestedRoomCode.code && requestedRoomCode.code !== code) throw new Error("房间号与创建请求不一致");
      if (room) {
        if (requestedRoomCode.mode === "reserved" && requestedRoomCode.code === code && room.creatorAccountId === actor!.id) {
          room.codeKind = "reserved";
          await this.persist(room);
          return json({
            code,
            roomCodeKind: room.codeKind,
            duelMode: Boolean(room.duelMode),
            rulesetMode: room.rulesetMode ?? "classic",
            customRulesHash: room.customRulesHash,
            existing: true,
          });
        }
        return json({ error: "房间码已存在" }, 409);
      }
      if (!requestedRoomCode.code && (!/^[1-9]\d{5}$/.test(code) || isReservedRoomCode(memory.adminState, code))) {
        throw new Error("该房间号已被占用");
      }
      const rulesetMode = normalizeRulesetMode(command.rulesetMode);
      let customRules: ResolvedCustomRules | undefined;
      let customRulesHash: string | undefined;
      let customPresetId: string | undefined;
      let customPresetRevision: number | undefined;
      if (rulesetMode === "custom") {
        const presetId = typeof command.customPresetId === "string" && command.customPresetId.trim() ? command.customPresetId.trim() : undefined;
        if (presetId) {
          const preset = memory.adminState.customRulesPresets.find((item) => item.id === presetId && item.enabled);
          if (!preset) throw new Error("所选自定义预设不存在或已停用");
          customRules = preset.resolvedRules;
          customPresetId = preset.id;
          customPresetRevision = preset.revision;
        } else {
          customRules = command.customRules && typeof command.customRules === "object" ? (command.customRules as ResolvedCustomRules) : PLATFORM_PRESET;
        }
        customRulesHash = canonicalCustomRulesHash(customRules);
      }
      const requestedCapacity = Number(command.capacity ?? command.targetHumanPlayers ?? 2);
      if (!Number.isInteger(requestedCapacity) || requestedCapacity < 2 || requestedCapacity > 10) {
        throw new Error("玩家数量（含 AI）必须是 2-10 的整数");
      }
      let customRequiredPlayers: number | null = null;
      if (rulesetMode === "custom" && customRules) {
        const [minPlayers, maxPlayers] = setupPlayersRange(customRules.setup.players);
        if (requestedCapacity < minPlayers || requestedCapacity > maxPlayers) throw new Error(`该自定义规则要求玩家数量为 ${minPlayers}-${maxPlayers}`);
        customRequiredPlayers = requiredPlayersFromDeal(customRules, requestedCapacity);
        if (customRequiredPlayers !== null && requestedCapacity !== customRequiredPlayers) throw new Error(`该规则按 ${customRequiredPlayers} 个座位规定了初始发牌，房间人数必须为 ${customRequiredPlayers} 人`);
      }
      const publicActor = publicUser(this.env, actor!);
      const initialHandSize = rulesetMode === "custom" && customRules
        ? cleanCustomInitialHandSize(command.initialHandSize, customRules, requestedCapacity, customRequiredPlayers !== null)
        : cleanInitialHandSize(command.initialHandSize, requestedCapacity);
      if (rulesetMode === "custom" && customRules) {
        customRules = parseCustomRules(customRulesSourceForRoom(customRules, requestedCapacity, initialHandSize));
        customRulesHash = canonicalCustomRulesHash(customRules);
      }
      const turnTimeLimitSec = cleanRoomTimeLimitSec(command.turnTimeLimitSec, "出牌时间");
      const openingExchangeSec = cleanRoomTimeLimitSec(command.openingExchangeSec, "换牌时间");
      let baseBet: number;
      let duelMode = false;
      if (rulesetMode === "custom" && customRules) {
        baseBet = cleanCustomRoomBaseBet({
          value: command.baseBet ?? (typeof customRules.setup.baseBet === "number" ? customRules.setup.baseBet : 5),
          setupBaseBet: customRules.setup.baseBet as number | [number, number] | undefined,
          maximum: resolveCustomMaxBaseBet(publicActor.customModeLimits.maxBaseBet, publicActor.permissions.maxBaseBet),
          canCreateZeroBaseBet: publicActor.permissions.canCreateZeroBaseBet,
        });
      } else {
        ({ baseBet, duel: duelMode } = cleanRoomBaseBet({
          value: command.baseBet ?? 5,
          maximum: publicActor.permissions.maxBaseBet,
          canCreateZeroBaseBet: publicActor.permissions.canCreateZeroBaseBet,
          allowDuel: true,
          capacity: requestedCapacity,
          initialHandSize,
        }));
      }
      room = {
        code,
        codeKind: requestedRoomCode.mode,
        players: [],
        capacity: duelMode ? 2 : requestedCapacity,
        creatorAccountId: actor!.id,
        baseBet,
        rulesetMode,
        initialHandSize,
        turnTimeLimitSec,
        openingExchangeSec,
        duelMode: duelMode || undefined,
        customRulesHash,
        customPresetId,
        customPresetRevision,
        customRules,
        readyPlayerIds: [],
        roomGamesPlayed: {},
        roomGamesWon: {},
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      await this.persist(room);
      return json({ code, roomCodeKind: requestedRoomCode.mode, duelMode, rulesetMode, customRulesHash });
    }

    if (!room) throw new Error("房间不存在或已回收");
    if (operation === "get") return json({ room: summarizeRoom(room) });
    if (operation === "rules") {
      mustLogin(actor);
      if (!canReadRoomRules(room, actor!.id)) return json({ error: "只有房间参与者可以查看完整规则" }, 403);
      if ((room.rulesetMode ?? "classic") !== "custom") return json({ error: "该房间不是自定义模式" }, 404);
      const rules = room.customRules ?? (room.game && isCustomGame(room.game) ? (room.game.custom.rules as ResolvedCustomRules | undefined) : undefined);
      if (!rules) return json({ error: "该房间没有自定义规则快照" }, 404);
      return json({ rules, hash: canonicalCustomRulesHash(rules) });
    }

    mustLogin(actor);
    if (operation === "join") {
      if (publicUser(this.env, actor!).disabled) throw new Error("该用户已被禁用，请联系管理员或超级管理员");
      const player = joinRoom(room, this.env, actor!, typeof body.playerId === "string" ? body.playerId : undefined);
      await this.persist(room);
      return json({ playerId: player.id, ...roomPayload(room, player.id) });
    }

    const playerId = String(body.playerId ?? "");
    if (operation === "state") {
      try {
        ensurePlayerAccount(room, playerId, actor!.id);
      } catch (error) {
        await auditWorkerSecurity(this.env, actor, "unauthorized-read", "room-private-state", {
          code,
          playerId,
        });
        throw error;
      }
      const presenceChanged = body.presence === true ? markPlayerOnline(room, playerId) : false;
      if ((await advanceRoomIfNeeded(this.env, room)) || presenceChanged) await this.persist(room);
      if (await this.maybeDissolveDuel(room)) return json({ duelDissolved: true });
      return json(roomPayload(room, playerId));
    }
    if (operation === "start") {
      ensurePlayerAccount(room, playerId, actor!.id);
      try {
        await confirmStart(this.env, room, playerId, typeof body.customRulesHashReady === "string" ? body.customRulesHashReady : undefined);
      } catch (error) {
        if (room.editNotice?.problems?.length) {
          await this.persist(room);
          this.broadcastRoom(room);
        }
        throw error;
      }
      await this.persist(room);
      this.broadcastRoom(room);
      return json(roomPayload(room, playerId));
    }
    if (operation === "action") {
      if (containsProtectedGameMutation(body) || !isStrictActionIntent(body.action)) {
        await auditWorkerSecurity(
          this.env,
          actor,
          containsProtectedGameMutation(body) || containsProtectedGameMutation(body.action)
            ? "protected-mutation"
            : "forged-action",
          "malformed-game-action",
          { code, playerId, action: body.action },
        );
        return json({ error: "动作请求格式无效" }, 400);
      }
      try {
        ensureActionAccount(room, playerId, actor!.id);
      } catch (error) {
        await auditWorkerSecurity(this.env, actor, "unauthorized-operation", "room-seat-action", {
          code,
          playerId,
        });
        throw error;
      }
      const result = await submit(this.env, room, playerId, body.action as ActionIntent);
      await this.persist(room);
      return json({ ...roomPayload(room, playerId), message: result.message }, result.ok ? 200 : 400);
    }
    if (operation === "bots") {
      const ownerId = String(body.ownerId ?? "");
      ensurePlayerAccount(room, ownerId, actor!.id);
      addBot(room, ownerId);
      await this.persist(room);
      return json(roomPayload(room, ownerId));
    }
    if (operation === "kick") {
      ensurePlayerAccount(room, playerId, actor!.id);
      kickPlayer(room, actor!.id, String(body.targetId ?? ""));
      await advanceRoomIfNeeded(this.env, room);
      await this.persist(room);
      return json(roomPayload(room, playerId));
    }
    if (operation === "edit") {
      ensurePlayerAccount(room, playerId, actor!.id);
      editRoom(room, this.env, actor!, Number(body.capacity), Number(body.baseBet), body.initialHandSize, body.turnTimeLimitSec, body.openingExchangeSec, body.customRules);
      await this.persist(room);
      return json(roomPayload(room, playerId));
    }
    if (operation === "leave") {
      ensurePlayerAccount(room, playerId, actor!.id);
      leaveRoom(room, actor!.id, playerId);
      await advanceRoomIfNeeded(this.env, room);
      await this.persist(room);
      return json({ ok: true });
    }
    if (operation === "cancel-autoplay") {
      ensurePlayerAccount(room, playerId, actor!.id);
      cancelAutoplay(room, playerId);
      await this.persist(room);
      return json(roomPayload(room, playerId));
    }
    if (operation === "heartbeat") {
      ensurePlayerAccount(room, playerId, actor!.id);
      markPlayerOnline(room, playerId);
      await this.persist(room);
      return json(roomPayload(room, playerId));
    }
    throw new Error("未知房间操作");
  }

  private async load(code: string): Promise<Room | undefined> {
    let room = await this.state.storage.get<Room>("room");
    if (!room && this.env.ION_ROOMS) {
      const legacy = await this.env.ION_ROOMS.get(`room:${code}`);
      if (legacy) {
        room = JSON.parse(legacy) as Room;
        await this.state.storage.put("room", room);
        await this.env.ION_ROOMS.delete(`room:${code}`);
      }
    }
    if (room && Date.now() - room.lastActiveAt > ROOM_TTL_SECONDS * 1000) {
      if (this.state.storage.delete) {
        await this.state.storage.delete("room");
        await this.state.storage.delete("customRules");
      }
      return undefined;
    }
    if (room) {
      normalizeRoomCapacity(room);
      room.rulesetMode ??= "classic";
      if (room.rulesetMode === "custom" && room.customRules === undefined) {
        room.customRules = await this.state.storage.get<ResolvedCustomRules>("customRules");
      }
      normalizeCustomRulesSnapshot(room);
    }
    return room;
  }

  private async persist(room: Room): Promise<void> {
    room.revision = (room.revision ?? 0) + 1;
    room.lastActiveAt = Date.now();
    if (room.customRules !== undefined) await this.state.storage.put("customRules", room.customRules);
    const { customRules: _rules, ...light } = room;
    await this.state.storage.put("room", light as Room);
  }

  private async maybeDissolveDuel(_room: Room): Promise<boolean> {
    return false;
  }
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await readJson(request);
  await hydrateAdminState(env);
  const token = tokenFromRequest(request);
  const actor = token ? await userForToken(env, token) : undefined;

  if (url.pathname === "/api/auth/register" && method === "POST") {
    enforceWorkerRegistrationRateLimit(request);
    if (actor) {
      await auditWorkerRequest(env, request, actor, "unauthorized-operation", "logged-in-registration", {});
      return json({ error: "已登录状态下不能注册新账号" }, 409);
    }
    const result = await register(
      env,
      String(body?.username ?? ""),
      String(body?.password ?? ""),
      String(body?.nickname ?? body?.username ?? ""),
      String(body?.inviteCode ?? ""),
      String(request.headers.get("x-ion-device-id") ?? ""),
      String(request.headers.get("x-ion-browser-fingerprint") ?? ""),
      body?.reservedRoomCode === undefined ? undefined : String(body.reservedRoomCode),
    );
    return json(result);
  }
  if (url.pathname === "/api/auth/login" && method === "POST") return json(await login(env, String(body?.username ?? ""), String(body?.password ?? "")));
  if (url.pathname === "/api/auth/logout" && method === "POST") {
    if (token) await deleteSession(env, token);
    return json({ ok: true });
  }
  if (url.pathname === "/api/auth/me" && method === "GET") return json({ user: actor ? publicUser(env, actor, true, true) : undefined });
  if (url.pathname === "/api/advanced-ai/access" && method === "POST") {
    if (!actor || !hasWorkerAdvancedAiAccess(actor)) {
      await auditWorkerRequest(env, request, actor, "unauthorized-operation", "advanced-ai-access", {});
      return json({ error: "请求的资源不存在" }, 404);
    }
    return new Response(JSON.stringify({ allowed: true }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `ion_ai_access=${encodeURIComponent(token ?? "")}; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`,
      },
    });
  }
  const securityLogMatch = /^\/api\/security-logs\/([^/]+)$/.exec(url.pathname);
  if (securityLogMatch && method === "GET") {
    mustLogin(actor);
    if (!actor!.superAdmin) return json({ error: "日志不存在" }, 404);
    const incident = memory.adminState.securityIncidents.find(
      (item) => item.id === decodeURIComponent(securityLogMatch[1]),
    );
    if (!incident) return json({ error: "日志不存在" }, 404);
    return new Response(workerSecurityLog(incident), {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="security-${safeWorkerFilePart(incident.id)}.ndjson"`,
      },
    });
  }
  if (url.pathname === "/api/users" && method === "GET") {
    mustLogin(actor);
    const users = await loadUsers(env);
    const viewAll = isAdminRole(roleFor(actor!));
    return json({
      users: (viewAll ? users : [actor!]).map((user) =>
        publicUser(env, user, Boolean(actor!.superAdmin || actor!.id === user.id), canManageExclusiveRoomCode(actor!, user, "read")),
      ),
      selfId: actor!.id,
    });
  }
  const reservedRoomCodesMatch = /^\/api\/users\/([^/]+)\/reserved-room-codes(?:\/([^/]+))?$/.exec(url.pathname);
  if (reservedRoomCodesMatch) {
    mustLogin(actor);
    const targetId = decodeURIComponent(reservedRoomCodesMatch[1]);
    const pathCode = reservedRoomCodesMatch[2] === undefined ? undefined : decodeURIComponent(reservedRoomCodesMatch[2]);
    if (method === "GET" && pathCode === undefined) {
      const result = await adminStateMutation(env, "/reserved-room-codes/list", { actorUserId: actor!.id, userId: targetId });
      return json(result);
    }
    if (method === "POST" && pathCode === undefined) {
      const result = await adminStateMutation(env, "/reserved-room-codes/add", { actorUserId: actor!.id, userId: targetId, code: body?.code });
      await hydrateAdminState(env);
      return json(result);
    }
    if (method === "PATCH" && pathCode !== undefined) {
      const result = await adminStateMutation(env, "/reserved-room-codes/update", {
        actorUserId: actor!.id,
        userId: targetId,
        previousCode: pathCode,
        code: body?.code,
      });
      await hydrateAdminState(env);
      return json(result);
    }
    if (method === "DELETE" && pathCode !== undefined) {
      const result = await adminStateMutation(env, "/reserved-room-codes/delete", { actorUserId: actor!.id, userId: targetId, code: pathCode });
      await hydrateAdminState(env);
      return json(result);
    }
    return json({ error: "未知 API" }, 404);
  }
  if (url.pathname === "/api/users/points/bulk" && method === "POST") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以一键发放积分");
    const result = await adminStateMutation(env, "/users/points/bulk", { ...(body ?? {}), actorUserId: actor!.id });
    await hydrateAdminState(env);
    return json(result);
  }
  if (url.pathname === "/api/leaderboard" && method === "GET") {
    mustLogin(actor);
    const users = (await loadUsers(env)).map((user) => {
      const view = publicUser(env, user);
      return {
        id: view.id,
        nickname: view.nickname,
        nicknameColor: view.nicknameColor,
        username: view.username,
        points: view.points,
        gamesWon: view.gamesWon,
        gamesPlayed: view.gamesPlayed,
        role: view.role,
        createdAt: view.createdAt,
        excluded: view.hiddenFromLeaderboard,
      };
    });
    return json(buildLeaderboard(users, actor!.id));
  }
  if (url.pathname === "/api/music/manifest" && method === "GET") {
    mustLogin(actor);
    const ids = String(url.searchParams.get("ids") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 10);
    const users = await loadUsers(env);
    const music = [];
    for (const userId of [...new Set(ids)]) {
      const user = users.find((item) => item.id === userId);
      if (!user?.winMusic) continue;
      const targetView = publicUser(env, user);
      const actorView = publicUser(env, actor!);
      if ((!targetView.hasAdvancedPerk && !canPlayDownloadedWinMusic(actorView, targetView))
        || (!canPlayWinMusic(actorView, targetView) && !canPlayDownloadedWinMusic(actorView, targetView))) continue;
      const dataUrl = env.ION_USERS ? await env.ION_USERS.get(`music:${user.id}`) : user.winMusic.dataUrl;
      if (!dataUrl) continue;
      const hashes = user.winMusic.sha1 && user.winMusic.sha256 ? user.winMusic : { ...user.winMusic, ...hashMusicDataUrl(dataUrl) };
      music.push({
        userId,
        fileName: hashes.fileName,
        mimeType: hashes.mimeType,
        size: hashes.size,
        sha1: hashes.sha1,
        sha256: hashes.sha256,
      });
    }
    return json({ music });
  }
  if (url.pathname === "/api/users.csv" && method === "GET") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以下载所有用户数据");
    return new Response(`\uFEFF${exportUsersCsv(env, await loadUsers(env))}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="ion-storm-users.csv"',
      },
    });
  }
  if (url.pathname === "/api/invitations" && method === "GET") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以查看邀请码");
    return json({ invitations: memory.adminState.invitations });
  }
  if (url.pathname === "/api/invitations" && method === "POST") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以管理邀请码");
    const result = await adminStateMutation(env, "/invitations/upsert", body ?? {});
    await hydrateAdminState(env);
    return json(result);
  }
  const invitationDeleteMatch = /^\/api\/invitations\/([^/]+)$/.exec(url.pathname);
  if (invitationDeleteMatch && method === "DELETE") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以管理邀请码");
    await adminStateMutation(env, "/invitations/delete", { code: decodeURIComponent(invitationDeleteMatch[1]) });
    await hydrateAdminState(env);
    return json({ ok: true });
  }
  if (url.pathname === "/api/permissions" && method === "GET") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以查看权限");
    return json({ rolePermissions: memory.adminState.rolePermissions, userPermissions: memory.adminState.userPermissions });
  }
  if (url.pathname === "/api/permissions" && method === "PATCH") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以修改权限");
    await adminStateMutation(env, "/permissions/update", body ?? {});
    await hydrateAdminState(env);
    return json({ ok: true });
  }
  if (url.pathname === "/api/custom-mode-limits" && method === "GET") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以查看自定义模式设置");
    return json(memory.adminState.customModeLimits);
  }
  if (url.pathname === "/api/custom-mode-limits" && method === "PATCH") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以修改自定义模式设置");
    await adminStateMutation(env, "/custom-mode-limits/update", { limits: body ?? {} });
    await hydrateAdminState(env);
    return json(memory.adminState.customModeLimits);
  }
  if (url.pathname === "/api/custom-presets" && method === "GET") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以管理自定义预设");
    return json({ presets: memory.adminState.customRulesPresets.map(workerPresetAdminView) });
  }
  if (url.pathname === "/api/custom-presets/enabled" && method === "GET") {
    mustLogin(actor);
    return json({
      presets: memory.adminState.customRulesPresets
        .filter((preset) => preset.enabled)
        .map(workerPresetMeta),
    });
  }
  const enabledPresetMatch = /^\/api\/custom-presets\/enabled\/([^/]+)$/.exec(url.pathname);
  if (enabledPresetMatch && method === "GET") {
    mustLogin(actor);
    const id = decodeURIComponent(enabledPresetMatch[1]);
    const preset = memory.adminState.customRulesPresets.find((item) => item.id === id && item.enabled);
    if (!preset) return json({ error: "所选自定义预设不存在或已停用" }, 404);
    return json({ id: preset.id, rules: preset.resolvedRules });
  }
  if (url.pathname === "/api/custom-presets/preview" && method === "POST") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以管理自定义预设");
    const { rules } = resolveWorkerCustomRulesDocument(memory.adminState, body?.sourceDocument);
    return json({
      displayName: rules.displayName ?? rules.name,
      name: rules.name,
      players: setupPlayersRange(rules.setup.players),
      cardCount: Object.keys(rules.cards).length,
      deckSize: Object.values(rules.deck.cards).reduce((sum, count) => sum + count, 0),
    });
  }
  if (url.pathname === "/api/custom-presets" && method === "POST") {
    mustLogin(actor);
    const result = await adminStateMutation(env, "/presets/create", { ...(body ?? {}), actorUserId: actor!.id });
    await hydrateAdminState(env);
    return json(workerPresetMutationResult(result));
  }
  const presetMatch = /^\/api\/custom-presets\/([^/]+)(\/duplicate)?$/.exec(url.pathname);
  if (presetMatch && method === "POST") {
    mustLogin(actor);
    const id = decodeURIComponent(presetMatch[1]);
    const result = presetMatch[2]
      ? await adminStateMutation(env, "/presets/duplicate", { id, actorUserId: actor!.id })
      : await adminStateMutation(env, "/presets/update", { ...(body ?? {}), id, actorUserId: actor!.id });
    await hydrateAdminState(env);
    return json(workerPresetMutationResult(result));
  }
  if (presetMatch && method === "DELETE") {
    mustLogin(actor);
    await adminStateMutation(env, "/presets/delete", { id: decodeURIComponent(presetMatch[1]), actorUserId: actor!.id });
    await hydrateAdminState(env);
    return json({ ok: true });
  }
  if (url.pathname === "/api/tax-settings" && method === "GET") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以查看税收设置");
    return json({ taxRatePercent: memory.adminState.taxRatePercent, taxWinnerPointsThreshold: memory.adminState.taxWinnerPointsThreshold });
  }
  if (url.pathname === "/api/tax-settings" && method === "PATCH") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以修改税收设置");
    if (env.ION_ACCOUNT_STATE) {
      await adminStateMutation(env, "/tax/update", body ?? {});
      await hydrateAdminState(env);
    } else {
      memory.adminState.taxRatePercent = normalizeTaxRatePercent(body?.taxRatePercent, memory.adminState.taxRatePercent);
      memory.adminState.taxWinnerPointsThreshold = normalizeTaxWinnerPointsThreshold(body?.taxWinnerPointsThreshold, memory.adminState.taxWinnerPointsThreshold);
    }
    return json({ taxRatePercent: memory.adminState.taxRatePercent, taxWinnerPointsThreshold: memory.adminState.taxWinnerPointsThreshold });
  }
  if (url.pathname === "/api/requests" && method === "GET") {
    mustLogin(actor);
    const view = publicUser(env, actor!);
    const requests =
      view.role === "super-admin"
        ? memory.adminState.requests
        : view.role === "admin" || view.role === "admin-advanced"
          ? memory.adminState.requests.filter((item) => item.kind !== "security" && !item.privateToSuperAdmin)
          : memory.adminState.requests.filter((item) => item.kind !== "security" && item.fromUserId === actor!.id);
    return json({ requests, seenThrough: memory.adminState.requestSeenAtByUserId[actor!.id] ?? 0 });
  }
  if (url.pathname === "/api/requests/ack" && method === "POST") {
    mustLogin(actor);
    const result = await adminStateMutation(env, "/requests/ack", { userId: actor!.id, through: body?.through });
    await hydrateAdminState(env);
    return json(result);
  }
  if (url.pathname === "/api/requests" && method === "POST") {
    mustLogin(actor);
    return json(await adminStateMutation(env, "/requests/create", { ...(body ?? {}), fromUserId: actor!.id }));
  }
  const requestRespondMatch = /^\/api\/requests\/([^/]+)\/respond$/.exec(url.pathname);
  if (requestRespondMatch && method === "POST") {
    mustLogin(actor);
    const actorView = publicUser(env, actor!);
    if (actorView.role !== "super-admin" && actorView.role !== "admin" && actorView.role !== "admin-advanced") throw new Error("没有权限处理申请");
    const ticket = memory.adminState.requests.find((item) => item.id === decodeURIComponent(requestRespondMatch[1]));
    if (!ticket) throw new Error("申请不存在");
    if ((ticket.kind === "security" || ticket.privateToSuperAdmin) && actorView.role !== "super-admin") throw new Error("该申请仅超级管理员可处理");
    const result = await adminStateMutation(env, "/requests/respond", {
      id: ticket.id,
      status: body?.status,
      reply: body?.reply,
      replyUserId: actor!.id,
    });
    await hydrateAdminState(env);
    return json(result);
  }
  if (url.pathname === "/api/activations" && method === "GET") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以查看激活码");
    return json({ activations: memory.adminState.activationCodes, registeredUserCount: memory.adminState.users.length });
  }
  if (url.pathname === "/api/activations" && method === "POST") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以管理激活码");
    const result = await adminStateMutation(env, "/activations/upsert", body ?? {});
    await hydrateAdminState(env);
    return json(result);
  }
  if (url.pathname === "/api/activations/redeem" && method === "POST") {
    mustLogin(actor);
    const result = await adminStateMutation(env, "/activations/redeem", {
      code: body?.code,
      userId: actor!.id,
      reservedRoomCode: body?.reservedRoomCode,
      customTitle: body?.customTitle,
      customNicknameColor: body?.customNicknameColor,
    });
    await hydrateAdminState(env);
    const target = result.user as StoredUser;
    return json({ user: publicUser(env, target, true, true) });
  }
  if (url.pathname === "/api/activations/redeem/prepare" && method === "POST") {
    mustLogin(actor);
    return json(
      await adminStateMutation(env, "/activations/prepare", {
        code: body?.code,
        userId: actor!.id,
        reservedRoomCode: body?.reservedRoomCode,
      }),
    );
  }
  const activationDeleteMatch = /^\/api\/activations\/([^/]+)$/.exec(url.pathname);
  if (activationDeleteMatch && method === "DELETE") {
    mustLogin(actor);
    if (!actor!.superAdmin) throw new Error("只有超级管理员可以管理激活码");
    await adminStateMutation(env, "/activations/delete", { code: decodeURIComponent(activationDeleteMatch[1]) });
    await hydrateAdminState(env);
    return json({ ok: true });
  }

  const userMatch = /^\/api\/users\/([^/]+)$/.exec(url.pathname);
  if (userMatch && method === "PATCH") {
    mustLogin(actor);
    if (isDefiniteWorkerProtectedAccountMutation(env, actor!, body)) {
      await auditWorkerRequest(env, request, actor, "protected-mutation", "account-readonly-field-mutation", {
        targetUserId: decodeURIComponent(userMatch[1]),
        fields: Object.keys(body ?? {}),
      });
    }
    return json({ user: await updateUser(env, actor!, decodeURIComponent(userMatch[1]), body ?? {}) });
  }
  if (userMatch && method === "DELETE") {
    mustLogin(actor);
    const targetId = decodeURIComponent(userMatch[1]);
    await deleteUser(env, actor!, targetId, String(body?.currentPassword ?? ""));
    if (env.ION_USERS) await env.ION_USERS.delete(`music:${targetId}`);
    return json({ ok: true });
  }

  const musicMatch = /^\/api\/users\/([^/]+)\/music$/.exec(url.pathname);
  if (musicMatch && method === "GET") {
    mustLogin(actor);
    const user = (await loadUsers(env)).find((item) => item.id === decodeURIComponent(musicMatch[1]));
    if (!user?.winMusic) return json({ error: "音乐不存在" }, 404);
    const actorView = publicUser(env, actor!);
    const targetView = publicUser(env, user);
    const purpose = url.searchParams.get("purpose") === "download" ? "download" : "play";
    if (purpose === "download") {
      if (!canDownloadWinMusic(actorView, targetView)) return json({ error: "没有权限下载该用户胜利音乐" }, 403);
    } else {
      if (!canPlayWinMusic(actorView, targetView)) return json({ error: "没有权限播放该用户胜利音乐" }, 403);
      if (!targetView.hasAdvancedPerk && !canPlayDownloadedWinMusic(actorView, targetView)) return json({ error: "音乐不存在" }, 404);
    }
    const dataUrl = env.ION_USERS ? await env.ION_USERS.get(`music:${user.id}`) : user.winMusic.dataUrl;
    if (!dataUrl) return json({ error: "音乐不存在" }, 404);
    const hashes = user.winMusic.sha1 && user.winMusic.sha256 ? user.winMusic : { ...user.winMusic, ...hashMusicDataUrl(dataUrl) };
    return json({ music: { ...hashes, dataUrl } });
  }
  if (musicMatch && method === "POST") {
    mustLogin(actor);
    const users = await loadUsers(env);
    const target = users.find((item) => item.id === decodeURIComponent(musicMatch[1]));
    if (!target) throw new Error("用户不存在");
    const actorView = publicUser(env, actor!);
    const targetView = publicUser(env, target);
    if (!canManageWinMusic(actorView, targetView)) throw new Error("没有权限修改该用户胜利音乐");
    if (!targetView.hasAdvancedPerk) throw new Error("只有当前有效的高级用户或超级管理员可以设置胜利音乐");
    if (!verifyPassword(String(body?.currentPassword ?? ""), actor!.passwordHash)) throw new Error("请先验证当前密码");
    const dataUrl = String(body?.dataUrl ?? "");
    const parsed = parseVictoryMusicDataUrl(dataUrl);
    const hashes = hashMusicBytes(parsed.bytes);
    const baseUpdatedAt = target.updatedAt;
    if (env.ION_USERS) await env.ION_USERS.put(`music:${target.id}`, dataUrl);
    target.winMusic = {
      fileName: String(body?.fileName ?? "win-music").slice(0, 160),
      mimeType: parsed.mimeType,
      size: parsed.size,
      durationSeconds: parsed.durationSeconds,
      uploadedAt: Date.now(),
      dataUrl: env.ION_USERS ? undefined : dataUrl,
      ...hashes,
    };
    target.updatedAt = Date.now();
    await saveUser(env, target, baseUpdatedAt);
    return json({ ok: true });
  }
  if (musicMatch && method === "DELETE") {
    mustLogin(actor);
    const users = await loadUsers(env);
    const target = users.find((item) => item.id === decodeURIComponent(musicMatch[1]));
    if (!target) throw new Error("用户不存在");
    if (!canManageWinMusic(publicUser(env, actor!), publicUser(env, target))) throw new Error("没有权限删除该用户胜利音乐");
    if (!verifyPassword(String(body?.currentPassword ?? ""), actor!.passwordHash)) throw new Error("请先验证当前密码");
    const baseUpdatedAt = target.updatedAt;
    target.winMusic = undefined;
    target.updatedAt = Date.now();
    if (env.ION_USERS) await env.ION_USERS.delete(`music:${target.id}`);
    await saveUser(env, target, baseUpdatedAt);
    return json({ ok: true });
  }

  if (url.pathname === "/api/rooms" && method === "POST") {
    mustLogin(actor);
    if (publicUser(env, actor!).disabled) throw new Error("该用户已被禁用，请联系管理员或超级管理员");
    const publicActor = publicUser(env, actor!);
    const rulesetMode = normalizeRulesetMode(body?.rulesetMode);
    let customRules: ResolvedCustomRules | undefined;
    let customRulesHash: string | undefined;
    let customPresetId: string | undefined;
    let customPresetRevision: number | undefined;
    if (rulesetMode === "custom") {
      const presetId = typeof body?.customPresetId === "string" && body.customPresetId.trim() ? body.customPresetId.trim() : undefined;
      try {
        if (presetId) {
          const preset = memory.adminState.customRulesPresets.find((item) => item.id === presetId && item.enabled);
          if (!preset) return json({ error: "所选自定义预设不存在或已停用" }, 400);
          customRules = preset.resolvedRules;
          customPresetId = preset.id;
          customPresetRevision = preset.revision;
        } else {
          customRules = body?.customRules !== undefined ? resolveWorkerCustomRulesDocument(memory.adminState, body.customRules).rules : PLATFORM_PRESET;
        }
      } catch (error) {
        return json({ error: `自定义规则无效：${error instanceof Error ? error.message : String(error)}` }, 400);
      }
      customRulesHash = canonicalCustomRulesHash(customRules);
    }
    let capacity = Number(body?.capacity ?? body?.targetHumanPlayers ?? 2);
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 10) throw new Error("玩家数量（含 AI）必须是 2-10 的整数");
    let customRequiredPlayers: number | null = null;
    if (rulesetMode === "custom" && customRules) {
      const [minPlayers, maxPlayers] = setupPlayersRange(customRules.setup.players);
      if (capacity < minPlayers || capacity > maxPlayers) throw new Error(`该自定义规则要求玩家数量为 ${minPlayers}-${maxPlayers}`);
      customRequiredPlayers = requiredPlayersFromDeal(customRules, capacity);
      if (customRequiredPlayers !== null && capacity !== customRequiredPlayers) throw new Error(`该规则按 ${customRequiredPlayers} 个座位规定了初始发牌，房间人数必须为 ${customRequiredPlayers} 人`);
    }
    const initialHandSize = rulesetMode === "custom" && customRules
      ? cleanCustomInitialHandSize(body?.initialHandSize, customRules, capacity, customRequiredPlayers !== null)
      : cleanInitialHandSize(body?.initialHandSize, capacity);
    if (rulesetMode === "custom" && customRules) {
      customRules = parseCustomRules(customRulesSourceForRoom(customRules, capacity, initialHandSize));
      customRulesHash = canonicalCustomRulesHash(customRules);
    }
    const turnTimeLimitSec = cleanRoomTimeLimitSec(body?.turnTimeLimitSec, "出牌时间");
    const openingExchangeSec = cleanRoomTimeLimitSec(body?.openingExchangeSec, "换牌时间");
    let baseBet: number;
    let classicDuelMode = false;
    if (rulesetMode === "custom" && customRules) {
      const setupBaseBet = customRules.setup.baseBet as number | [number, number] | undefined;
      baseBet = cleanCustomRoomBaseBet({
        value: body?.baseBet ?? (typeof setupBaseBet === "number" ? setupBaseBet : 5),
        setupBaseBet,
        maximum: resolveCustomMaxBaseBet(publicActor.customModeLimits.maxBaseBet, publicActor.permissions.maxBaseBet),
        canCreateZeroBaseBet: publicActor.permissions.canCreateZeroBaseBet,
      });
    } else {
      ({ baseBet, duel: classicDuelMode } = cleanRoomBaseBet({
        value: body?.baseBet ?? 5,
        maximum: publicActor.permissions.maxBaseBet,
        canCreateZeroBaseBet: publicActor.permissions.canCreateZeroBaseBet,
        allowDuel: true,
        capacity,
        initialHandSize,
      }));
    }
    const duelMode = rulesetMode === "custom" ? false : classicDuelMode;
    if (rulesetMode === "custom" && classicDuelMode) return json({ error: "自定义模式不支持决斗房间" }, 400);
    if (duelMode) {
      const duelStatus = workerDuelCooldownStatus(memory.adminState, actor!.id);
      if (!duelStatus.allowed) {
        const retryAt = duelStatus.retryAt ? new Date(duelStatus.retryAt).toLocaleString("zh-CN", { hour12: false }) : "管理员重新开放决斗权限";
        return json({ error: duelStatus.retryAt ? `当前不可创建决斗房间，请等到 ${retryAt} 后重试` : "当前账号不允许创建决斗房间", duelCooldownUntil: duelStatus.retryAt }, 400);
      }
    }
    if (duelMode) capacity = 2;
    const requestedRoomCode = resolveRequestedRoomCode(memory.adminState, actor!, body?.roomCodeMode, body?.roomCode);
    if (env.ION_ROOM_STATE) {
      return await createDurableRoom(env, actor!.id, {
        capacity,
        baseBet,
        duelMode,
        initialHandSize,
        turnTimeLimitSec,
        openingExchangeSec,
        rulesetMode,
        customRules: customPresetId ? undefined : customRules,
        customRulesHash,
        customPresetId,
        customPresetRevision,
      }, requestedRoomCode);
    }
    if (requestedRoomCode.mode === "reserved" && requestedRoomCode.code) {
      const existingRoom = await getRoom(env, requestedRoomCode.code);
      if (existingRoom) {
        if (existingRoom.creatorAccountId !== actor!.id) throw new Error("房间号已存在");
        existingRoom.codeKind = "reserved";
        await saveRoom(env, existingRoom);
        return json({
          code: existingRoom.code,
          roomCodeKind: existingRoom.codeKind,
          duelMode: Boolean(existingRoom.duelMode),
          rulesetMode: existingRoom.rulesetMode ?? "classic",
          customRulesHash: existingRoom.customRulesHash,
          existing: true,
        });
      }
    }
    const room = await createRoom(env, capacity, actor!.id, requestedRoomCode.code);
    room.codeKind = requestedRoomCode.mode;
    room.baseBet = baseBet;
    room.rulesetMode = rulesetMode;
    if (customRules) room.customRules = customRules;
    if (customRulesHash) room.customRulesHash = customRulesHash;
    if (customPresetId) room.customPresetId = customPresetId;
    if (customPresetRevision !== undefined) room.customPresetRevision = customPresetRevision;
    room.initialHandSize = initialHandSize;
    room.turnTimeLimitSec = turnTimeLimitSec;
    room.openingExchangeSec = openingExchangeSec;
    room.duelMode = duelMode || undefined;
    await saveRoom(env, room);
    return json({ code: room.code, roomCodeKind: requestedRoomCode.mode, duelMode, rulesetMode, customRulesHash });
  }

  const roomMatch = /^\/api\/rooms\/(\d+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!roomMatch) throw new Error("未知 API");
  const code = roomMatch[1];
  const action = roomMatch[2] ?? "";
  if (env.ION_ROOM_STATE) {
    const allowedRoomActions = new Set(["get", "rules", "join", "state", "start", "action", "bots", "kick", "edit", "leave", "cancel-autoplay", "heartbeat"]);
    if (!allowedRoomActions.has(action || "get")) {
      await auditWorkerRequest(env, request, actor, "unauthorized-operation", "room-action-whitelist", { code, action });
      return json({ error: "未知 API" }, 404);
    }
    if (
      action === "action" &&
      method === "POST" &&
      (containsProtectedGameMutation(body) || !isStrictActionIntent(body?.action))
    ) {
      await auditWorkerRequest(
        env,
        request,
        actor,
        containsProtectedGameMutation(body) || containsProtectedGameMutation(body?.action)
          ? "protected-mutation"
          : "forged-action",
        "malformed-game-action",
        { code, playerId: body?.playerId, action: body?.action },
      );
      return json({ error: "动作请求格式无效" }, 400);
    }
    return durableRoomRequest(env, code, action || "get", actor?.id, {
      ...(body ?? {}),
      ...(action === "state"
        ? {
            playerId: url.searchParams.get("playerId") ?? "",
            presence: url.searchParams.get("presence") === "1",
          }
        : {}),
    });
  }
  const room = await mustRoom(env, code);

  if (!action && method === "GET") return json({ room: summarizeRoom(room) });
  if (action === "rules" && method === "GET") {
    mustLogin(actor);
    if (!canReadRoomRules(room, actor!.id)) return json({ error: "只有房间参与者可以查看完整规则" }, 403);
    if ((room.rulesetMode ?? "classic") !== "custom") return json({ error: "该房间不是自定义模式" }, 404);
    const rules = room.customRules ?? (room.game && isCustomGame(room.game) ? (room.game.custom.rules as ResolvedCustomRules | undefined) : undefined);
    if (!rules) return json({ error: "该房间没有自定义规则快照" }, 404);
    return json({ rules, hash: canonicalCustomRulesHash(rules) });
  }
  if (action === "join" && method === "POST") {
    mustLogin(actor);
    if (publicUser(env, actor!).disabled) throw new Error("该用户已被禁用，请联系管理员或超级管理员");
    const player = joinRoom(room, env, actor!, typeof body?.playerId === "string" ? body.playerId : undefined);
    await saveRoom(env, room);
    return json({ playerId: player.id, ...roomPayload(room, player.id) });
  }
  if (action === "state" && method === "GET") {
    mustLogin(actor);
    const playerId = url.searchParams.get("playerId") ?? "";
    try {
      ensurePlayerAccount(room, playerId, actor!.id);
    } catch (error) {
      await auditWorkerRequest(env, request, actor, "unauthorized-read", "room-private-state", { code, playerId });
      throw error;
    }
    const presenceChanged = url.searchParams.get("presence") === "1" ? markPlayerOnline(room, playerId) : false;
    if ((await advanceRoomIfNeeded(env, room)) || presenceChanged) await saveRoom(env, room);
    return json(roomPayload(room, playerId));
  }
  if (action === "start" && method === "POST") {
    mustLogin(actor);
    ensurePlayerAccount(room, String(body?.playerId ?? ""), actor!.id);
    try {
      await confirmStart(env, room, String(body?.playerId ?? ""), typeof body?.customRulesHashReady === "string" ? body.customRulesHashReady : undefined);
    } catch (error) {
      if (room.editNotice?.problems?.length) await saveRoom(env, room);
      throw error;
    }
    await saveRoom(env, room);
    return json(roomPayload(room, String(body?.playerId ?? "")));
  }
  if (action === "action" && method === "POST") {
    mustLogin(actor);
    const playerId = String(body?.playerId ?? "");
    if (containsProtectedGameMutation(body) || !isStrictActionIntent(body?.action)) {
      await auditWorkerRequest(
        env,
        request,
        actor,
        containsProtectedGameMutation(body) || containsProtectedGameMutation(body?.action)
          ? "protected-mutation"
          : "forged-action",
        "malformed-game-action",
        { code, playerId, action: body?.action },
      );
      return json({ error: "动作请求格式无效" }, 400);
    }
    try {
      ensureActionAccount(room, playerId, actor!.id);
    } catch (error) {
      await auditWorkerRequest(env, request, actor, "unauthorized-operation", "room-seat-action", { code, playerId });
      throw error;
    }
    const result = await submit(env, room, playerId, body?.action as ActionIntent);
    await saveRoom(env, room);
    return json({ ...roomPayload(room, playerId), message: result.message }, result.ok ? 200 : 400);
  }
  if (action === "bots" && method === "POST") {
    mustLogin(actor);
    ensurePlayerAccount(room, String(body?.ownerId ?? ""), actor!.id);
    addBot(room, String(body?.ownerId ?? ""));
    await saveRoom(env, room);
    return json(roomPayload(room, String(body?.ownerId ?? "")));
  }
  if (action === "kick" && method === "POST") {
    mustLogin(actor);
    const playerId = String(body?.playerId ?? "");
    ensurePlayerAccount(room, playerId, actor!.id);
    kickPlayer(room, actor!.id, String(body?.targetId ?? ""));
    await advanceRoomIfNeeded(env, room);
    await saveRoom(env, room);
    return json(roomPayload(room, playerId));
  }
  if (action === "edit" && method === "POST") {
    mustLogin(actor);
    const playerId = String(body?.playerId ?? "");
    ensurePlayerAccount(room, playerId, actor!.id);
    editRoom(room, env, actor!, Number(body?.capacity), Number(body?.baseBet), body?.initialHandSize, body?.turnTimeLimitSec, body?.openingExchangeSec, body?.customRules);
    await saveRoom(env, room);
    return json(roomPayload(room, playerId));
  }
  if (action === "leave" && method === "POST") {
    mustLogin(actor);
    const playerId = String(body?.playerId ?? "");
    ensurePlayerAccount(room, playerId, actor!.id);
    leaveRoom(room, actor!.id, playerId);
    await advanceRoomIfNeeded(env, room);
    await saveRoom(env, room);
    return json({ ok: true });
  }
  if (action === "cancel-autoplay" && method === "POST") {
    mustLogin(actor);
    const playerId = String(body?.playerId ?? "");
    ensurePlayerAccount(room, playerId, actor!.id);
    cancelAutoplay(room, playerId);
    await saveRoom(env, room);
    return json(roomPayload(room, playerId));
  }
  if (action === "heartbeat" && method === "POST") {
    mustLogin(actor);
    ensurePlayerAccount(room, String(body?.playerId ?? ""), actor!.id);
    markPlayerOnline(room, String(body?.playerId ?? ""));
    await saveRoom(env, room);
    return json(roomPayload(room, String(body?.playerId ?? "")));
  }
  throw new Error("未知 API");
}

async function register(
  env: Env,
  username: string,
  password: string,
  nickname?: string,
  inviteCodeInput?: string,
  deviceIdInput?: string,
  browserFingerprintInput?: string,
  reservedRoomCodeInput?: string,
) {
  const clean = validateUsername(username);
  const cleanNickname = validateNickname(nickname ?? clean);
  const inviteCode = String(inviteCodeInput ?? "").trim();
  if (!inviteCode) throw new Error("注册必须填写邀请码");
  const deviceId = String(deviceIdInput ?? "").trim();
  const browserFingerprint = String(browserFingerprintInput ?? "").trim();
  if (!deviceId || !browserFingerprint || deviceId.length > 160 || browserFingerprint.length > 160) {
    throw new Error("无法确认注册设备或浏览器环境");
  }
  const deviceHash = workerRegistrationHash(env, "device", deviceId);
  const browserHash = workerRegistrationHash(env, "browser", browserFingerprint);
  await adminStateMutation(env, "/invitations/preflight", { inviteCode, deviceHash, browserHash });
  const users = await loadUsers(env);
  if (users.some((user) => user.usernameLookup === lookup(env, clean))) throw new Error("用户名已存在");
  validatePassword(password);
  const now = Date.now();
  const user: StoredUser = {
    id: uid("u"),
    usernameEncrypted: encrypt(env, clean),
    usernameLookup: lookup(env, clean),
    passwordHash: hashPassword(password),
    sessionVersion: 0,
    nickname: cleanNickname,
    points: 0,
    disabledPermanent: false,
    nicknameChangeDisabled: false,
    superAdmin: false,
    adminPermanent: false,
    advancedPermanent: false,
    advancedAiPermanent: false,
    gamesPlayed: 0,
    gamesWon: 0,
    createdAt: now,
    updatedAt: now,
  };
  const result = await adminStateMutation(env, "/users/register", {
    user,
    inviteCode,
    deviceHash,
    browserHash,
    reservedRoomCode: reservedRoomCodeInput,
  });
  await hydrateAdminState(env);
  return issueAuth(env, result.user as StoredUser);
}

async function login(env: Env, username: string, password: string) {
  const users = await loadUsers(env);
  const user = users.find((item) => item.usernameLookup === lookup(env, username));
  if (!user || !verifyPassword(password, user.passwordHash)) throw new Error("用户名或密码错误");
  const baseUpdatedAt = user.updatedAt;
  user.lastLoginAt = Date.now();
  user.updatedAt = Date.now();
  await saveUser(env, user, baseUpdatedAt);
  return issueAuth(env, user);
}

async function issueAuth(env: Env, user: StoredUser) {
  const token = randomBytes(32).toString("base64url");
  await putSession(env, token, user.id, user.sessionVersion ?? 0);
  return { token, user: publicUser(env, user, true, true) };
}

async function loadUsers(env: Env): Promise<StoredUser[]> {
  if (env.ION_ACCOUNT_STATE) return memory.adminState.users;
  if (memory.adminState.users.length === 0) memory.adminState.users = bootstrapWorkerSuperAdmin(env);
  return memory.adminState.users;
}

async function saveUser(
  env: Env,
  user: StoredUser,
  baseUpdatedAt?: number,
  permissions?: Partial<PermissionRule> | null,
  permissionsPermanent?: boolean,
  permissionsExpiresAt?: string,
  customModeLimits?: CustomModeLimitGrant | null,
  customModeLimitsPermanent?: boolean,
  customModeLimitsExpiresAt?: string,
): Promise<void> {
  if (env.ION_ACCOUNT_STATE) {
    await adminStateMutation(env, "/users/set", {
      user,
      baseUpdatedAt,
      permissions,
      permissionsPermanent,
      permissionsExpiresAt,
      customModeLimits,
      customModeLimitsPermanent,
      customModeLimitsExpiresAt,
    });
    await hydrateAdminState(env);
  } else {
    const users = await loadUsers(env);
    const index = users.findIndex((item) => item.id === user.id);
    if (index < 0) throw new Error("用户不存在");
    users[index] = user;
    if (permissions !== undefined) {
      if (permissions === null) delete memory.adminState.userPermissions[user.id];
      else memory.adminState.userPermissions[user.id] = {
        permissions: normalizeWorkerPermissionPatch(permissions),
        permanent: permissionsPermanent ?? true,
        expiresAt: permissionsExpiresAt,
      };
    }
    if (customModeLimits !== undefined) {
      if (customModeLimits === null) delete memory.adminState.userCustomModeLimits[user.id];
      else memory.adminState.userCustomModeLimits[user.id] = {
        limits: normalizeCustomModeLimitGrant(customModeLimits),
        permanent: customModeLimitsPermanent ?? true,
        expiresAt: customModeLimitsExpiresAt,
      };
    }
  }
}

function assertSuperAdmin(users: StoredUser[]): StoredUser[] {
  const supers = users.filter((user) => user.superAdmin);
  if (supers.length !== 1) throw new Error("初始用户数据必须且只能包含一个超级管理员");
  return users;
}

async function updateUser(env: Env, actor: StoredUser, targetId: string, patch: Record<string, unknown>) {
  const users = await loadUsers(env);
  const target = users.find((user) => user.id === targetId);
  if (!target) throw new Error("用户不存在");
  const baseUpdatedAt = target.updatedAt;
  const actorView = publicUser(env, actor);
  const targetView = publicUser(env, target);
  const self = actor.id === target.id;
  const selfSuperAdminLeaderboardOnly = self && actor.superAdmin && target.superAdmin;
  if (selfSuperAdminLeaderboardOnly) {
    if (patch.disabledPermanent !== undefined || patch.disabledUntil !== undefined || patch.hideFromLeaderboardWhileDisabled !== undefined) {
      throw new Error("超级管理员只能将自己限期或永久从排行榜移除，不会禁用账号功能");
    }
  }
  if (patch.username !== undefined) throw new Error("用户名不可修改");
  if (touchesProtectedFields(patch) && !verifyPassword(String(patch.currentPassword ?? ""), actor.passwordHash)) {
    throw new Error("请先验证当前密码");
  }
  if (patch.nickname !== undefined) {
    if (self && target.nicknameChangeDisabled) throw new Error("该账号已被禁止自行修改昵称，请提交昵称修改工单");
    if (!self && !canManageNickname(actorView, targetView)) throw new Error("没有权限修改该昵称");
    target.nickname = validateNickname(String(patch.nickname));
  }
  if (patch.password !== undefined) {
    if (!self && (!actor.superAdmin || target.superAdmin)) throw new Error("没有权限修改该密码");
    validatePassword(String(patch.password));
    target.passwordHash = hashPassword(String(patch.password));
    target.sessionVersion = (target.sessionVersion ?? 0) + 1;
  }
  if (patch.title !== undefined) {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以设置头衔");
    target.title = cleanOptional(patch.title, 24);
  }
  if (patch.nicknameColor !== undefined) {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以设置昵称颜色");
    target.nicknameColor = patch.nicknameColor === null ? undefined : validateHexColor(String(patch.nicknameColor));
  }
  if (patch.points !== undefined) {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以设置积分");
    const points = Number(patch.points);
    if (!Number.isInteger(points)) throw new Error("积分必须是整数");
    target.points = points;
  }
  if (patch.taxRatePercent !== undefined) {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以设置用户税收比例");
    target.taxRatePercent = patch.taxRatePercent === null ? undefined : cleanTaxRatePercent(patch.taxRatePercent);
  }
  const leaderboardBanPatch =
    patch.hideFromLeaderboardWhileDisabled !== undefined ||
    patch.leaderboardHiddenUntil !== undefined ||
    patch.leaderboardHiddenPermanent !== undefined;
  if (leaderboardBanPatch && !actor.superAdmin) throw new Error("只有超级管理员可以设置排行榜隐藏");
  if (patch.disabledPermanent !== undefined || patch.disabledUntil !== undefined) {
    if (!canManageBan(actorView, targetView)) throw new Error("没有权限禁用或解禁该用户");
    const wasDisabled = isStoredUserDisabled(target);
    if (patch.disabledPermanent !== undefined) target.disabledPermanent = Boolean(patch.disabledPermanent);
    if (patch.disabledUntil !== undefined) target.disabledUntil = cleanExpiry(patch.disabledUntil);
    if (isStoredUserDisabled(target) && !wasDisabled) {
      target.disabledAt = Date.now();
      target.disabledBy = actor.id;
      target.unbanRequestedForDisabledAt = undefined;
    }
  }
  if (patch.hideFromLeaderboardWhileDisabled !== undefined) {
    target.hideFromLeaderboardWhileDisabled = Boolean(patch.hideFromLeaderboardWhileDisabled);
  }
  if (patch.leaderboardHiddenUntil !== undefined) {
    target.leaderboardHiddenUntil = cleanExpiry(patch.leaderboardHiddenUntil);
  }
  if (patch.leaderboardHiddenPermanent !== undefined) {
    target.leaderboardHiddenPermanent = Boolean(patch.leaderboardHiddenPermanent);
  }
  if (patch.nicknameChangeDisabled !== undefined) {
    if (self || !canManageNickname(actorView, targetView)) throw new Error("没有权限修改该账号的昵称自改状态");
    target.nicknameChangeDisabled = Boolean(patch.nicknameChangeDisabled);
  }
  if (hasRolePatch(patch)) applyRolePatch(actorView, targetView, target, patch);
  let permissions: Partial<PermissionRule> | null | undefined;
  let permissionsPermanent: boolean | undefined;
  let permissionsExpiresAt: string | undefined;
  if (patch.permissions !== undefined) {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以设置用户权限");
    permissions = patch.permissions === null ? null : normalizeWorkerPermissionPatch(patch.permissions as Partial<PermissionRule>);
    if (permissions) {
      const meta = workerPermissionOverrideMetaFromPatch(patch, undefined);
      permissionsPermanent = meta.permanent;
      permissionsExpiresAt = meta.expiresAt;
    }
  } else if (patch.permissionsPermanent !== undefined || patch.permissionsDurationMs !== undefined || patch.permissionsExpiresAt !== undefined) {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以设置用户权限");
    const existing = memory.adminState.userPermissions[target.id];
    if (!existing) throw new Error("该用户没有自定义权限覆盖");
    permissions = existing.permissions;
    const meta = workerPermissionOverrideMetaFromPatch(patch, existing);
    permissionsPermanent = meta.permanent;
    permissionsExpiresAt = meta.expiresAt;
  }
  let customModeLimits: CustomModeLimitGrant | null | undefined;
  let customModeLimitsPermanent: boolean | undefined;
  let customModeLimitsExpiresAt: string | undefined;
  if (patch.customModeLimits !== undefined) {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以设置用户的自定义模式权益");
    customModeLimits = patch.customModeLimits === null ? null : normalizeCustomModeLimitGrant(patch.customModeLimits as CustomModeLimitGrant);
    if (customModeLimits) {
      const meta = workerCustomModeLimitOverrideMetaFromPatch(patch, undefined);
      customModeLimitsPermanent = meta.permanent;
      customModeLimitsExpiresAt = meta.expiresAt;
    }
  } else if (
    patch.customModeLimitsPermanent !== undefined ||
    patch.customModeLimitsDurationMs !== undefined ||
    patch.customModeLimitsExpiresAt !== undefined
  ) {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以设置用户的自定义模式权益");
    const existing = memory.adminState.userCustomModeLimits[target.id];
    if (!existing) throw new Error("该用户没有自定义模式权益覆盖");
    customModeLimits = existing.limits;
    const meta = workerCustomModeLimitOverrideMetaFromPatch(patch, existing);
    customModeLimitsPermanent = meta.permanent;
    customModeLimitsExpiresAt = meta.expiresAt;
  }
  if (patch.advancedAiAccess !== undefined || patch.advancedAiPermanent !== undefined || patch.advancedAiExpiresAt !== undefined) {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以设置高级 AI 权限");
    if (patch.advancedAiAccess !== undefined) {
      if (target.superAdmin && !patch.advancedAiAccess) throw new Error("超级管理员始终具有高级 AI 权限");
      target.advancedAiPermanent = Boolean(patch.advancedAiAccess);
      target.advancedAiExpiresAt = undefined;
    } else {
      if (target.superAdmin && patch.advancedAiPermanent === false && !patch.advancedAiExpiresAt) throw new Error("超级管理员始终具有高级 AI 权限");
      if (patch.advancedAiPermanent !== undefined) target.advancedAiPermanent = Boolean(patch.advancedAiPermanent);
      if (patch.advancedAiExpiresAt !== undefined) target.advancedAiExpiresAt = cleanExpiry(patch.advancedAiExpiresAt) ?? undefined;
      if (target.advancedAiPermanent) target.advancedAiExpiresAt = undefined;
    }
  }
  target.updatedAt = Date.now();
  await saveUser(
    env,
    target,
    baseUpdatedAt,
    permissions,
    permissionsPermanent,
    permissionsExpiresAt,
    customModeLimits,
    customModeLimitsPermanent,
    customModeLimitsExpiresAt,
  );
  return publicUser(env, target, Boolean(actor.superAdmin || actor.id === target.id), canManageExclusiveRoomCode(actor, target, "read"));
}

function workerPermissionOverrideMetaFromPatch(patch: Record<string, unknown>, existing?: { expiresAt?: string; permanent?: boolean }): { permanent: boolean; expiresAt?: string } {
  const durationMs = patch.permissionsDurationMs !== undefined && patch.permissionsDurationMs !== null ? Number(patch.permissionsDurationMs) : undefined;
  const expiresAtRaw = patch.permissionsExpiresAt !== undefined ? cleanExpiry(patch.permissionsExpiresAt) : undefined;
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) throw new Error("权限覆盖时长不正确");
  const permanent = durationMs === undefined && !expiresAtRaw ? (patch.permissionsPermanent !== undefined ? Boolean(patch.permissionsPermanent) : true) : false;
  if (permanent) return { permanent: true };
  if (durationMs !== undefined) return { permanent: false, expiresAt: new Date(Date.now() + durationMs).toISOString() };
  return { permanent: false, expiresAt: expiresAtRaw ?? existing?.expiresAt };
}

function workerCustomModeLimitOverrideMetaFromPatch(
  patch: Record<string, unknown>,
  existing?: { expiresAt?: string; permanent?: boolean },
): { permanent: boolean; expiresAt?: string } {
  const durationMs = patch.customModeLimitsDurationMs !== undefined && patch.customModeLimitsDurationMs !== null
    ? Number(patch.customModeLimitsDurationMs)
    : undefined;
  const expiresAtRaw = patch.customModeLimitsExpiresAt !== undefined ? cleanExpiry(patch.customModeLimitsExpiresAt) : undefined;
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) throw new Error("自定义模式权益时长不正确");
  const permanent = durationMs === undefined && !expiresAtRaw
    ? patch.customModeLimitsPermanent !== undefined
      ? Boolean(patch.customModeLimitsPermanent)
      : true
    : false;
  if (permanent) return { permanent: true };
  if (durationMs !== undefined) return { permanent: false, expiresAt: new Date(Date.now() + durationMs).toISOString() };
  const expiresAt = expiresAtRaw ?? existing?.expiresAt;
  if (!expiresAt) throw new Error("非永久自定义模式权益必须设置有效期");
  return { permanent: false, expiresAt };
}

async function deleteUser(env: Env, actor: StoredUser, targetId: string, currentPassword?: string): Promise<void> {
  if (!actor.superAdmin) throw new Error("只有超级管理员可以删除用户");
  if (!verifyPassword(String(currentPassword ?? ""), actor.passwordHash)) throw new Error("请先验证当前密码");
  const users = await loadUsers(env);
  const target = users.find((user) => user.id === targetId);
  if (!target) throw new Error("用户不存在");
  if (target.superAdmin) throw new Error("超级管理员不可删除");
  if (env.ION_ACCOUNT_STATE) {
    await adminStateMutation(env, "/users/delete", { userId: targetId });
    await hydrateAdminState(env);
  } else {
    memory.adminState.users = users.filter((user) => user.id !== targetId);
  }
}

function publicUser(env: Env, user: StoredUser, revealAdvancedAi = false, revealReservedRoomCodes = false) {
  const role = roleFor(user);
  const title = user.title?.trim() || undefined;
  const username = decrypt(env, user.usernameEncrypted);
  const nickname = user.nickname?.trim() || username;
  const nicknameColor = cleanColor(user.nicknameColor) ?? ROLE_COLORS[role];
  const advancedAiAccess = hasWorkerAdvancedAiAccess(user);
  return {
    id: user.id,
    username,
    nickname,
    role,
    color: ROLE_COLORS[role],
    nicknameColor,
    title,
    subtitle: subtitleFor(role, title),
    hasAdvancedPerk: role === "super-admin" || role === "admin-advanced" || role === "advanced",
    superAdmin: user.superAdmin,
    adminPermanent: user.adminPermanent,
    advancedPermanent: user.advancedPermanent,
    adminExpiresAt: user.adminExpiresAt,
    advancedExpiresAt: user.advancedExpiresAt,
    ...(revealAdvancedAi
      ? {
          advancedAiAccess,
          advancedAiPermanent: Boolean(user.superAdmin || user.advancedAiPermanent),
          advancedAiExpiresAt: user.advancedAiExpiresAt,
        }
      : {}),
    ...(revealReservedRoomCodes ? { reservedRoomCodes: normalizeReservedRoomCodes(user.reservedRoomCodes) } : {}),
    gamesPlayed: user.gamesPlayed,
    gamesWon: user.gamesWon,
    todayGamesPlayed: user.todayStatsDate === todayKey() ? (user.todayGamesPlayed ?? 0) : 0,
    todayGamesWon: user.todayStatsDate === todayKey() ? (user.todayGamesWon ?? 0) : 0,
    todayGamePointsDelta: user.todayStatsDate === todayKey() ? (user.todayGamePointsDelta ?? 0) : 0,
    inviteCodeUsed: user.inviteCodeUsed,
    lastLoginAt: user.lastLoginAt,
    points: user.points ?? 0,
    disabledUntil: user.disabledUntil,
    disabledPermanent: Boolean(user.disabledPermanent),
    disabled: Boolean(user.disabledPermanent || isFuture(user.disabledUntil)),
    hideFromLeaderboardWhileDisabled: Boolean(user.hideFromLeaderboardWhileDisabled),
    leaderboardHiddenUntil: user.leaderboardHiddenUntil,
    leaderboardHiddenPermanent: Boolean(user.leaderboardHiddenPermanent),
    hiddenFromLeaderboard: isStoredUserHiddenFromLeaderboard(user),
    nicknameChangeDisabled: Boolean(user.nicknameChangeDisabled),
    taxRatePercent: user.taxRatePercent,
    permissions: workerPermissionsFor(user, role),
    permissionOverride: memory.adminState.userPermissions[user.id]?.permissions,
    permissionOverrideExpiresAt: memory.adminState.userPermissions[user.id]?.expiresAt,
    permissionOverridePermanent: memory.adminState.userPermissions[user.id]?.permissions ? Boolean(memory.adminState.userPermissions[user.id]?.permanent ?? true) : undefined,
    customModeLimits: workerCustomModeLimitsForPayload(memory.adminState, user),
    customModeLimitOverride: memory.adminState.userCustomModeLimits[user.id]?.limits,
    customModeLimitOverrideExpiresAt: memory.adminState.userCustomModeLimits[user.id]?.expiresAt,
    customModeLimitOverridePermanent: memory.adminState.userCustomModeLimits[user.id]?.limits
      ? Boolean(memory.adminState.userCustomModeLimits[user.id]?.permanent ?? true)
      : undefined,
    hasWinMusic: Boolean(user.winMusic),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function exportUsersCsv(env: Env, users: StoredUser[]): string {
  const headers = [
    "昵称",
    "用户名",
    "总局数",
    "胜局数",
    "注册时间",
    "注册使用的邀请码",
    "最后登录时间",
    "积分数",
    "是否正在被禁用",
    "被禁用截止时间",
    "是否被永久禁用",
    "是否高级用户",
    "高级用户截止时间",
    "是否永久高级用户",
    "是否管理员",
    "管理员截止时间",
    "是否永久管理员",
    "是否超级管理员",
  ];
  const rows = users.map((user) => {
    const view = publicUser(env, user);
    assertSpreadsheetExportAccountName(view.username, "用户名");
    assertSpreadsheetExportIdentity(view.nickname, "昵称");
    assertSpreadsheetExportIdentity(view.inviteCodeUsed, "邀请码");
    const isAdmin = view.role === "admin" || view.role === "admin-advanced" || view.role === "super-admin";
    const isAdvanced = view.role === "advanced" || view.role === "admin-advanced" || view.role === "super-admin";
    return [
      view.nickname,
      view.username,
      String(view.gamesPlayed),
      String(view.gamesWon),
      new Date(view.createdAt).toISOString(),
      view.inviteCodeUsed ?? "",
      view.lastLoginAt ? new Date(view.lastLoginAt).toISOString() : "",
      String(view.points),
      boolText(view.disabled),
      view.disabledUntil ?? "",
      boolText(view.disabledPermanent),
      boolText(isAdvanced),
      view.advancedExpiresAt ?? "",
      boolText(view.advancedPermanent),
      boolText(isAdmin),
      view.adminExpiresAt ?? "",
      boolText(view.adminPermanent),
      boolText(view.superAdmin),
    ];
  });
  return [headers, ...rows].map((row) => row.map(spreadsheetCsvCell).join(",")).join("\r\n");
}

function profileFor(env: Env, user: StoredUser): PlayerProfile {
  const view = publicUser(env, user);
  return {
    accountId: view.id,
    username: view.username,
    nickname: view.nickname,
    role: view.role,
    color: view.color,
    nicknameColor: view.nicknameColor,
    permissions: view.permissions,
    title: view.title,
    subtitle: view.subtitle,
    hasAdvancedPerk: view.hasAdvancedPerk,
    points: view.points,
  };
}

async function createDurableRoom(
  env: Env,
  actorId: string,
  options: {
    capacity: number;
    baseBet: number;
    duelMode?: boolean;
    initialHandSize?: number;
    turnTimeLimitSec?: number;
    openingExchangeSec?: number;
    rulesetMode?: "classic" | "custom";
    customRules?: ResolvedCustomRules;
    customRulesHash?: string;
    customPresetId?: string;
    customPresetRevision?: number;
  },
  requestedRoomCode?: RequestedRoomCode,
): Promise<Response> {
  if (requestedRoomCode?.code) {
    return durableRoomRequest(env, requestedRoomCode.code, "create", actorId, {
      ...options,
      roomCodeMode: requestedRoomCode.mode,
      roomCode: requestedRoomCode.code,
    });
  }
  for (let attempt = 0; attempt < 1000; attempt++) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    if (isReservedRoomCode(memory.adminState, code)) continue;
    const response = await durableRoomRequest(env, code, "create", actorId, { ...options });
    if (response.status === 409) continue;
    return response;
  }
  throw new Error("暂时无法分配房间码");
}

async function durableRoomRequest(
  env: Env,
  code: string,
  operation: string,
  actorId: string | undefined,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!env.ION_ROOM_STATE) throw new Error("房间 Durable Object 未配置");
  const stub = env.ION_ROOM_STATE.get(env.ION_ROOM_STATE.idFromName(code));
  return stub.fetch(
    new Request("https://room-state/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        operation,
        actorId,
        body,
        capacity: body.capacity,
        baseBet: body.baseBet,
        duelMode: body.duelMode,
        initialHandSize: body.initialHandSize,
        turnTimeLimitSec: body.turnTimeLimitSec,
        openingExchangeSec: body.openingExchangeSec,
        rulesetMode: body.rulesetMode,
        customRules: body.customRules,
        customRulesHash: body.customRulesHash,
        customPresetId: body.customPresetId,
        customPresetRevision: body.customPresetRevision,
      }),
    }),
  );
}

async function createRoom(env: Env, capacity: number, creatorAccountId: string, requestedCode?: string): Promise<Room> {
  let code = requestedCode ?? "";
  if (requestedCode && (await getRoom(env, requestedCode))) throw new Error("房间号已存在");
  if (!requestedCode) {
  for (let i = 0; i < 1000; i++) {
    code = Math.floor(100000 + Math.random() * 900000).toString();
    if (!isReservedRoomCode(memory.adminState, code) && !(await getRoom(env, code))) break;
  }
  }
  const room: Room = {
    code,
    players: [],
    capacity,
    creatorAccountId,
    baseBet: 5,
    readyPlayerIds: [],
    roomGamesPlayed: {},
    roomGamesWon: {},
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  await saveRoom(env, room);
  return room;
}

async function getRoom(env: Env, code: string): Promise<Room | undefined> {
  if (env.ION_ROOMS) {
    const raw = await env.ION_ROOMS.get(`room:${code}`);
    if (!raw) return undefined;
    const room = JSON.parse(raw) as Room;
    normalizeRoomCapacity(room);
    return room;
  }
  const room = memory.rooms.get(code);
  if (room) normalizeRoomCapacity(room);
  return room;
}

async function mustRoom(env: Env, code: string): Promise<Room> {
  const room = await getRoom(env, code);
  if (!room) throw new Error("房间不存在或已回收");
  return room;
}

async function saveRoom(env: Env, room: Room): Promise<void> {
  room.lastActiveAt = Date.now();
  if (env.ION_ROOMS) await env.ION_ROOMS.put(`room:${room.code}`, JSON.stringify(room), { expirationTtl: ROOM_TTL_SECONDS });
  else memory.rooms.set(room.code, room);
}

async function deleteRoom(env: Env, code: string): Promise<void> {
  if (env.ION_ROOMS) await env.ION_ROOMS.delete(`room:${code}`);
  else memory.rooms.delete(code);
}

function joinRoom(room: Room, env: Env, actor: StoredUser, playerId?: string): PlayerState {
  const profile = profileFor(env, actor);
  const existing = room.players.find((p) => p.accountId === actor.id && !p.bot) ?? (playerId ? room.players.find((p) => p.id === playerId && !p.bot && p.accountId === actor.id) : undefined);
  if (existing) {
    existing.nickname = profile.nickname ?? profile.username;
    existing.profile = profile;
    existing.canOpeningExchange = true;
    markPlayerOnline(room, existing.id);
    room.bankerPlayerId = ensureBankerPlayerId(room.players, room.bankerPlayerId);
    return existing as PlayerState;
  }
  if (room.game && room.game.status !== "ended") throw new Error("对局已经开始，只有同席位玩家可以恢复席位");
  if (room.players.length >= roomCapacity(room)) throw new Error("房间已达到预定人数");
  room.creatorAccountId ||= actor.id;
  const player: PlayerState = {
    id: uid("p"),
    nickname: profile.nickname ?? profile.username,
    accountId: actor.id,
    profile,
    hand: [],
    online: true,
    lastSeenAt: Date.now(),
    seat: room.players.length,
    timeoutLimitMs: room.turnTimeLimitSec !== undefined ? room.turnTimeLimitSec * 1000 : 60_000,
    timeoutStreak: 0,
    normalStreak: 0,
    forcedAutoplay: false,
    canOpeningExchange: true,
  };
  room.players.push(player);
  room.bankerPlayerId = ensureBankerPlayerId(room.players, room.bankerPlayerId);
  return player;
}

async function confirmStart(env: Env, room: Room, playerId: string, customRulesHashReady?: string): Promise<void> {
  if (room.game && room.game.status !== "ended") return;
  const player = room.players.find((p) => p.id === playerId && !p.bot);
  if (!player) throw new Error("只有真人玩家可以确认开始");
  if ((room.rulesetMode ?? "classic") === "custom" && (!room.customRulesHash || customRulesHashReady !== room.customRulesHash)) {
    throw new Error("请先下载当前自定义规则后再确认开始");
  }
  markPlayerOnline(room, player.id);
  if (!room.readyPlayerIds.includes(player.id)) room.readyPlayerIds.push(player.id);
  if (canStart(room)) {
    if (room.game?.status === "ended") room.game = undefined;
    await startGame(env, room);
  }
}

function workerDuelKeepAvailable(room: Room): boolean {
  if (!room.duelMode || room.game?.status !== "ended" || !room.creatorAccountId) return false;
  try {
    return workerDuelCooldownStatus(memory.adminState, room.creatorAccountId).allowed;
  } catch {
    return false;
  }
}

function canStart(room: Room): boolean {
  const humans = room.players.filter((p) => !p.bot);
  return room.players.length === roomCapacity(room) && room.players.length >= 2 && humans.every((player) => room.readyPlayerIds.includes(player.id));
}

function publishWorkerRoomConfigProblems(env: Env, room: Room, problems: string[]): void {
  const creator = room.creatorAccountId ? memory.adminState.users.find((user) => user.id === room.creatorAccountId) : undefined;
  room.editNotice = createRoomEditNotice(room, creator ? publicUser(env, creator).nickname : "系统");
  room.editNotice.problems = problems;
}

function ensureRoomConfigWithinCreatorPermissions(env: Env, room: Room): void {
  const creator = room.creatorAccountId ? memory.adminState.users.find((user) => user.id === room.creatorAccountId) : undefined;
  const problems: string[] = [];
  if (!creator) {
    problems.push("开房者账号已不存在，无法校验房间设置");
  } else {
    const view = publicUser(env, creator);
    if (view.disabled) problems.push("开房者账号已被禁用，无法开始游戏");
    else if ((room.rulesetMode ?? "classic") === "custom") {
      const rules = room.customRules ?? PLATFORM_PRESET;
      problems.push(
        ...checkCustomRoomConfigAgainstPermissions({
          capacity: roomCapacity(room),
          baseBet: room.baseBet,
          setupPlayers: setupPlayersRange(rules.setup.players),
          setupBaseBet: rules.setup.baseBet as number | [number, number] | undefined,
          requiredPlayers: requiredPlayersFromDeal(rules, roomCapacity(room)),
          initialHandSize: room.initialHandSize,
          rules,
          maximum: resolveCustomMaxBaseBet(view.customModeLimits.maxBaseBet, view.permissions.maxBaseBet),
          canCreateZeroBaseBet: view.permissions.canCreateZeroBaseBet,
        }),
      );
    } else {
      problems.push(
        ...checkRoomConfigAgainstPermissions({
          capacity: roomCapacity(room),
          baseBet: room.baseBet,
          initialHandSize: room.initialHandSize,
          duelMode: room.duelMode === true,
          maximum: view.permissions.maxBaseBet,
          canCreateZeroBaseBet: view.permissions.canCreateZeroBaseBet,
        }),
      );
    }
  }
  if (!problems.length) return;
  publishWorkerRoomConfigProblems(env, room, problems);
  throw new Error(`房间设置已不符合开房者权限限制：${problems.join("；")}`);
}

function ensureRoomParticipantsCanStart(env: Env, room: Room): void {
  const problems: string[] = [];
  for (const player of room.players.filter((item) => !item.bot && item.accountId)) {
    const account = memory.adminState.users.find((user) => user.id === player.accountId);
    if (!account) problems.push("房间中存在已不存在的账号，无法开始游戏");
    else if (publicUser(env, account).disabled) problems.push("房间中存在已被禁用的账号，无法开始游戏");
  }
  if (!problems.length) return;
  publishWorkerRoomConfigProblems(env, room, problems);
  throw new Error(problems.join("；"));
}

async function startGame(env: Env, room: Room): Promise<void> {
  const users = memory.adminState.users;
  ensureRoomConfigWithinCreatorPermissions(env, room);
  ensureRoomParticipantsCanStart(env, room);
  for (const player of room.players.filter((item) => !item.bot && item.accountId)) {
    const account = users.find((item) => item.id === player.accountId);
    if (!account) throw new Error("房间中的账号已不存在");
    const view = publicUser(env, account);
    if (view.disabled) throw new Error("该用户已被禁用，请联系管理员或超级管理员");
    player.profile = profileFor(env, account);
    player.nickname = view.nickname;
    player.canOpeningExchange = true;
  }
  if (room.duelMode) {
    try {
      await recordWorkerDuelRoomCreation(env, room.creatorAccountId);
    } catch (error) {
      publishWorkerRoomConfigProblems(env, room, [error instanceof Error ? error.message : String(error)]);
      throw error;
    }
  }
  room.bankerPlayerId = ensureBankerPlayerId(room.players, room.bankerPlayerId);
  const bankerSeat = room.players.findIndex((player) => player.id === room.bankerPlayerId);
  const customMode = (room.rulesetMode ?? "classic") === "custom";
  if (customMode && room.players.some((player) => player.bot)) throw new Error("自定义模式不允许机器人");
  const customRules = customMode ? (room.customRules ?? PLATFORM_PRESET) : undefined;
  // 开局冻结开房者额度：该额度限制每名输家的扣分，本局不随权限变动。
  const creator = customMode ? users.find((item) => item.id === room.creatorAccountId) : undefined;
  const settlementLoserCap = creator
    ? resolveCustomSettlementCap(publicUser(env, creator).customModeLimits.settlementCap, room.baseBet)
    : undefined;
  room.game = createRulesetGame({
    mode: "online",
    rules: customRules,
    baseBet: room.baseBet,
    handSize: room.initialHandSize,
    turnTimeLimitMs: room.turnTimeLimitSec !== undefined ? room.turnTimeLimitSec * 1000 : undefined,
    openingExchangeWindowMs: room.openingExchangeSec !== undefined ? room.openingExchangeSec * 1000 : undefined,
    startingSeat: bankerSeat >= 0 ? bankerSeat : 0,
    settlementLoserCap,
    players: room.players.map((p) => ({ nickname: p.nickname, bot: p.bot, botOwnerId: p.botOwnerId, accountId: p.accountId, profile: p.profile, canOpeningExchange: !p.bot })),
  });
  room.departedPlayerIds = [];
  const playerIdMap = new Map<string, string>();
  room.players = room.game.players.map((player, index) => {
    const nextId = room.players[index]?.id ?? player.id;
    playerIdMap.set(player.id, nextId);
    return {
      ...player,
      id: nextId,
      online: room.players[index]?.online ?? true,
      lastSeenAt: room.players[index]?.lastSeenAt ?? Date.now(),
      bot: room.players[index]?.bot,
      botOwnerId: room.players[index]?.botOwnerId,
      accountId: room.players[index]?.accountId,
      profile: room.players[index]?.profile,
      canOpeningExchange: !room.players[index]?.bot,
    };
  });
  room.game.players = room.players as typeof room.game.players;
  for (const entry of room.game.eventLog ?? []) {
    if (entry.playerId) entry.playerId = playerIdMap.get(entry.playerId) ?? entry.playerId;
  }
  if (room.game.openingExchange) {
    room.game.openingExchange.deadlineByPlayerId = Object.fromEntries(
      Object.entries(room.game.openingExchange.deadlineByPlayerId ?? {}).map(([id, deadline]) => [playerIdMap.get(id) ?? id, deadline]),
    );
    room.game.openingExchange.eligiblePlayerIds = room.game.openingExchange.eligiblePlayerIds.map((id) => playerIdMap.get(id) ?? id);
    room.game.openingExchange.completedPlayerIds = room.game.openingExchange.completedPlayerIds.map((id) => playerIdMap.get(id) ?? id);
    room.game.openingExchange.doubleCompletedPlayerIds = (room.game.openingExchange.doubleCompletedPlayerIds ?? []).map(
      (id) => playerIdMap.get(id) ?? id,
    );
    room.game.openingExchange.exchangeDrawCounts = Object.fromEntries(
      Object.entries(room.game.openingExchange.exchangeDrawCounts ?? {}).map(([id, count]) => [playerIdMap.get(id) ?? id, count]),
    );
  }
  if (isCustomGame(room.game)) {
    const runtime = room.game.custom;
    for (const reveal of runtime.inspectReveals) reveal.playerId = playerIdMap.get(reveal.playerId) ?? reveal.playerId;
    if (runtime.settlementCapByPlayerId) {
      runtime.settlementCapByPlayerId = Object.fromEntries(
        Object.entries(runtime.settlementCapByPlayerId).map(([id, cap]) => [playerIdMap.get(id) ?? id, cap]),
      );
    }
  }
  room.readyPlayerIds = [];
  room.startAckGameId = room.game.id;
  room.startAckedPlayerIds = [];
  room.startAckLastSentAtByPlayerId = {};
  room.statsSettledGameId = undefined;
}

function cancelAutoplay(room: Room, playerId: string): void {
  if (room.game && isCustomGame(room.game)) throw new Error("自定义模式不支持托管");
  const member = room.players.find((player) => player.id === playerId && !player.bot);
  const gamePlayer = room.game?.players.find((player) => player.id === playerId && !player.bot);
  if (!member && !gamePlayer) throw new Error("席位不存在");
  const turnLimitMs = room.game?.turnTimeLimitMs ?? 60_000;
  for (const player of [member, gamePlayer]) {
    if (!player) continue;
    player.forcedAutoplay = false;
    player.timeoutLimitMs = turnLimitMs;
    player.timeoutStreak = 0;
    player.normalStreak = 0;
    player.online = true;
    player.lastSeenAt = Date.now();
  }
  if (room.game?.status === "playing" && rulesetCurrentPlayer(room.game).id === playerId) {
    room.game.turnStartedAt = Date.now();
    room.game.turnDeadlineAt = Date.now() + turnLimitMs;
  }
}

async function submit(env: Env, room: Room, playerId: string, action: AnyActionIntent) {
  if (!room.game) throw new Error("游戏尚未开始");
  const result = applyRulesetAction(room.game, playerId, action, "normal");
  room.game = result.game;
  syncRoomMembersFromGame(room);
  if (room.game.status === "ended") {
    advanceBankerAfterGame(room);
    await settleStats(env, room);
  }
  return result;
}

function markWorkerPlayerOffline(room: Room, playerId: string): void {
  const now = Date.now();
  for (const player of [...room.players, ...(room.game?.players ?? [])]) {
    if (player.id === playerId) {
      player.online = false;
      player.lastSeenAt = now;
    }
  }
}

async function advanceRoomIfNeeded(env: Env, room: Room): Promise<boolean> {
  if (!room.game) return false;
  let changed = refreshWorkerPresence(room);
  if (room.game.status === "opening-exchange" && Date.now() >= (room.game.openingExchange?.deadlineAt ?? 0)) {
    if (isCustomGame(room.game)) {
      // 自定义模式：为每位未完成开局决定的玩家按超时提交最小换牌与不加倍
      room.game = advanceRulesetOpeningTimeout(room.game);
    } else {
      room.game = finishOpeningExchange(room.game);
    }
    syncRoomMembersFromGame(room);
    changed = true;
  }
  if (room.game.status === "playing") {
    const player = rulesetCurrentPlayer(room.game);
    if (player.bot || player.forcedAutoplay) {
      const previousLimit = player.timeoutLimitMs;
      player.timeoutLimitMs = AUTOMATED_ACTION_DELAY_MS;
      if (!room.game.turnDeadlineAt || previousLimit !== AUTOMATED_ACTION_DELAY_MS) {
        room.game.turnStartedAt = Date.now();
        room.game.turnDeadlineAt = Date.now() + AUTOMATED_ACTION_DELAY_MS;
        changed = true;
      } else if (Date.now() >= room.game.turnDeadlineAt) {
        const timeoutIntent = isCustomGame(room.game) ? randomRulesetTimeoutAction(room.game, player.id) : autoplay(room.game as GameState);
        if (!timeoutIntent) {
          markWorkerPlayerOffline(room, player.id);
          changed = true;
        } else {
          const result = applyRulesetAction(room.game, player.id, timeoutIntent, player.bot ? "normal" : "timeout");
          room.game = result.game;
          syncRoomMembersFromGame(room);
          if (room.game.status === "ended") {
            advanceBankerAfterGame(room);
            await settleStats(env, room);
          }
          changed = true;
        }
      }
    } else if (Date.now() >= (room.game.turnDeadlineAt ?? Number.POSITIVE_INFINITY)) {
      const offline = isCustomGame(room.game) && player.online === false;
      const timeoutIntent = isCustomGame(room.game)
        ? offline
          ? rulesetOfflineFallbackAction(room.game, player.id)
          : randomRulesetTimeoutAction(room.game, player.id)
        : autoplay(room.game as GameState);
      if (!timeoutIntent) {
        // 自定义模式：超时且无合法实际出牌，按掉线处理；下一次推进将跳过其回合
        markWorkerPlayerOffline(room, player.id);
        changed = true;
      } else {
        const result = applyRulesetAction(room.game, player.id, timeoutIntent, "timeout");
        room.game = result.game;
        syncRoomMembersFromGame(room);
        if (room.game.status === "ended") {
          advanceBankerAfterGame(room);
          await settleStats(env, room);
        }
        changed = true;
      }
    }
  }
  if (room.game.status === "ended" && room.statsSettledGameId !== room.game.id) {
    await settleStats(env, room);
    changed = true;
  }
  return changed;
}


function workerTaxContextForUserId(userId?: string): { taxRatePercent: number; taxWinnerPointsThreshold?: number; winnerPointsBeforeSettlement: number } {
  const user = userId ? memory.adminState.users.find((item) => item.id === userId) : undefined;
  return {
    taxRatePercent: normalizeTaxRatePercent(user?.taxRatePercent, memory.adminState.taxRatePercent),
    taxWinnerPointsThreshold: memory.adminState.taxWinnerPointsThreshold,
    winnerPointsBeforeSettlement: user?.points ?? 0,
  };
}

async function settleStats(env: Env, room: Room): Promise<void> {
  if (!room.game || room.statsSettledGameId === room.game.id) return;
  const custom = isCustomGame(room.game);
  const humanPlayers = room.game.players.filter((p) => !p.bot);
  const ids = humanPlayers.filter((p) => p.accountId).map((p) => p.accountId!);
  const winner = room.game.players.find((p) => p.id === room.game?.winnerId);
  const scoringTotal = room.game.scoring
    ? (room.game.scoring.total ?? room.game.scoring.stake + Object.values(room.game.scoring.pendingByPlayerId).reduce((sum, value) => sum + value, 0))
    : 0;
  const baseBet = room.game.scoring?.baseBet ?? 0;
  const doubleCount = room.game.scoring?.openingDoublePlayerIds.length ?? 0;
  let grossWinnerPoints: number;
  let settleAmountPerLoser = scoringTotal;
  let customCapScale: number | undefined;
  if (custom && isCustomGame(room.game)) {
    // 兼容旧的未结束房间：标量不存在时，只读取开房者在旧快照中的额度。
    const legacyCreatorPlayer = room.game.players.find((player) => player.accountId === room.creatorAccountId);
    const legacyCreatorCap = legacyCreatorPlayer ? room.game.custom.settlementCapByPlayerId?.[legacyCreatorPlayer.id] : undefined;
    const creatorCap = room.game.custom.settlementLoserCap !== undefined
      ? room.game.custom.settlementLoserCap
      : legacyCreatorCap;
    const loserCount = [...new Set(ids)].filter((id) => id !== winner?.accountId).length;
    const settlement = calculateCustomSettlement(scoringTotal, loserCount, creatorCap);
    settleAmountPerLoser = settlement.amountPerLoser;
    grossWinnerPoints = settlement.winnerGrossPoints;
    customCapScale = settlement.capScale;
  } else {
    grossWinnerPoints = winnerGrossPoints(scoringTotal, ids, winner?.accountId);
  }
  const settlesPoints = Boolean(winner && !winner.bot && winner.accountId && humanPlayers.length >= 2 && baseBet > 0 && grossWinnerPoints > 0);
  const rawWinnerTax = !custom && settlesPoints ? baseBet * humanPlayers.length * Math.pow(2, doubleCount) : 0;
  const taxContext = custom ? { taxRatePercent: -1, taxWinnerPointsThreshold: undefined, winnerPointsBeforeSettlement: 0 } : workerTaxContextForUserId(winner?.accountId);
  const winnerPointsBeforeSettlement = taxContext.winnerPointsBeforeSettlement;
  const preTaxPoints = winnerPreTaxPoints(winnerPointsBeforeSettlement, grossWinnerPoints);
  // 自定义模式联机结算不征税
  const winnerTax = settlesPoints
    ? calculateWinnerTax(rawWinnerTax, grossWinnerPoints, taxContext.taxRatePercent, {
        winnerPointsBeforeSettlement,
        taxWinnerPointsThreshold: taxContext.taxWinnerPointsThreshold,
      })
    : 0;
  if (room.game.scoring) {
    room.game.scoring.winnerGrossPoints = grossWinnerPoints;
    room.game.scoring.settlesPoints = settlesPoints;
    room.game.scoring.taxRatePercent = taxContext.taxRatePercent;
    room.game.scoring.taxWinnerPointsThreshold = taxContext.taxWinnerPointsThreshold;
    room.game.scoring.winnerPreTaxPoints = preTaxPoints;
    room.game.scoring.winnerTax = winnerTax;
    if (custom) room.game.scoring.settlementAmountPerLoser = settleAmountPerLoser;
    if (customCapScale !== undefined) room.game.scoring.customCapScale = customCapScale;
  }
  await adminStateMutation(env, "/users/settle", {
    gameId: room.game.id,
    accountIds: ids,
    winnerAccountId: winner?.accountId,
    amount: settleAmountPerLoser,
    winnerTax,
  });
  await hydrateAdminState(env);
  for (const id of ids) room.roomGamesPlayed[id] = (room.roomGamesPlayed[id] ?? 0) + 1;
  if (winner?.accountId) room.roomGamesWon[winner.accountId] = (room.roomGamesWon[winner.accountId] ?? 0) + 1;
  room.statsSettledGameId = room.game.id;
}

function addBot(room: Room, ownerId: string): void {
  if ((room.rulesetMode ?? "classic") === "custom") throw new Error("自定义模式不允许机器人");
  const owner = room.players.find((p) => p.id === ownerId && p.accountId);
  if (!owner || (room.game && room.game.status !== "ended")) throw new Error("只能由登录玩家在待开始阶段添加机器人");
  if (room.duelMode) throw new Error("决斗房间不能添加机器人");
  if (room.players.length >= roomCapacity(room)) throw new Error("房间已达到预定人数");
  const bot: PlayerState = {
    id: uid("bot"),
    nickname: `AI ${room.players.filter((p) => p.bot).length + 1}`,
    hand: [],
    online: true,
    lastSeenAt: Date.now(),
    bot: true,
    botOwnerId: owner.id,
    seat: room.players.length,
    timeoutLimitMs: AUTOMATED_ACTION_DELAY_MS,
    timeoutStreak: 0,
    normalStreak: 0,
    forcedAutoplay: false,
  };
  room.players.push(bot);
}

function kickPlayer(room: Room, actorAccountId: string, targetId: string): void {
  if (room.game && room.game.status !== "ended") throw new Error("游戏过程中不能移出房间成员");
  if (room.creatorAccountId !== actorAccountId) throw new Error("只有房间创建者可以移出成员或机器人");
  const target = room.players.find((player) => player.id === targetId);
  if (!target) throw new Error("目标席位不存在");
  if (target.accountId === actorAccountId) throw new Error("房间创建者不能移出自己");
  removeRoomPlayer(room, targetId);
}

function editRoom(
  room: Room,
  env: Env,
  actor: StoredUser,
  requestedCapacity: number,
  requestedBaseBet: number,
  requestedInitialHandSize?: unknown,
  requestedTurnTimeLimitSec?: unknown,
  requestedOpeningExchangeSec?: unknown,
  requestedCustomRules?: unknown,
): void {
  if (room.creatorAccountId !== actor.id) throw new Error("只有房间创建者可以修改房间");
  if (room.duelMode) throw new Error("决斗模式房间不能编辑设置");
  const customMode = (room.rulesetMode ?? "classic") === "custom";
  if (requestedCustomRules !== undefined && !customMode) throw new Error("经典房间不支持自定义规则");
  let nextCustomRules: ResolvedCustomRules | undefined;
  let nextCustomRulesHash: string | undefined;
  if (requestedCustomRules !== undefined) {
    if (room.game && room.game.status !== "ended") throw new Error("对局进行中不能修改自定义规则");
    nextCustomRules = resolveWorkerCustomRulesDocument(memory.adminState, requestedCustomRules).rules;
    nextCustomRulesHash = canonicalCustomRulesHash(nextCustomRules);
  }
  const minimumCapacity = Math.max(2, room.players.length);
  if (!Number.isInteger(requestedCapacity) || requestedCapacity < minimumCapacity || requestedCapacity > 10) {
    throw new Error(`总玩家数必须为 ${minimumCapacity}-10`);
  }
  const effectiveRules = nextCustomRules ?? (customMode ? (room.customRules ?? PLATFORM_PRESET) : undefined);
  let customRequiredPlayers: number | null = null;
  if (customMode && effectiveRules) {
    const [minPlayers, maxPlayers] = setupPlayersRange(effectiveRules.setup.players);
    if (requestedCapacity < minPlayers || requestedCapacity > maxPlayers) {
      throw new Error(`该自定义规则要求玩家数量为 ${minPlayers}-${maxPlayers}`);
    }
    customRequiredPlayers = requiredPlayersFromDeal(effectiveRules, requestedCapacity);
    if (customRequiredPlayers !== null && requestedCapacity !== customRequiredPlayers) {
      throw new Error(`该规则按 ${customRequiredPlayers} 个座位规定了初始发牌，房间人数必须为 ${customRequiredPlayers} 人`);
    }
  }
  const owner = room.players.find((player) => player.accountId === actor.id && !player.bot);
  if (!owner) throw new Error("房间创建者席位不存在");
  const view = publicUser(env, actor);
  const initialHandSize = customMode && effectiveRules
    ? cleanCustomInitialHandSize(requestedInitialHandSize, effectiveRules, requestedCapacity, customRequiredPlayers !== null)
    : cleanInitialHandSize(requestedInitialHandSize, requestedCapacity);
  const materializedCustomRules = customMode && effectiveRules
    ? parseCustomRules(customRulesSourceForRoom(effectiveRules, requestedCapacity, initialHandSize))
    : undefined;
  let baseBet: number;
  if (customMode) {
    baseBet = cleanCustomRoomBaseBet({
      value: requestedBaseBet,
      setupBaseBet: effectiveRules?.setup.baseBet as number | [number, number] | undefined,
      maximum: resolveCustomMaxBaseBet(view.customModeLimits.maxBaseBet, view.permissions.maxBaseBet),
      canCreateZeroBaseBet: view.permissions.canCreateZeroBaseBet,
    });
  } else {
    ({ baseBet } = cleanRoomBaseBet({
      value: requestedBaseBet,
      maximum: view.permissions.maxBaseBet,
      canCreateZeroBaseBet: view.permissions.canCreateZeroBaseBet,
      allowDuel: false,
      capacity: requestedCapacity,
      initialHandSize,
    }));
  }
  const turnTimeLimitSec = cleanRoomTimeLimitSec(requestedTurnTimeLimitSec, "出牌时间");
  const openingExchangeSec = cleanRoomTimeLimitSec(requestedOpeningExchangeSec, "换牌时间");
  room.capacity = requestedCapacity;
  room.baseBet = baseBet;
  room.initialHandSize = initialHandSize;
  room.turnTimeLimitSec = turnTimeLimitSec;
  room.openingExchangeSec = openingExchangeSec;
  if (materializedCustomRules) {
    room.customRules = materializedCustomRules;
    room.customRulesHash = canonicalCustomRulesHash(materializedCustomRules);
    if (nextCustomRules && nextCustomRulesHash) {
      room.customPresetId = undefined;
      room.customPresetRevision = undefined;
    }
    room.customConfigRevision = (room.customConfigRevision ?? 0) + 1;
  }
  room.readyPlayerIds = [];
  room.editNotice = createRoomEditNotice(room, owner.nickname);
}

function leaveRoom(room: Room, actorAccountId: string, playerId: string): void {
  if (room.creatorAccountId === actorAccountId) throw new Error("房间创建者不能退出房间");
  const player = room.players.find((item) => item.id === playerId && !item.bot);
  if (!player || player.accountId !== actorAccountId) throw new Error("没有权限退出该席位");
  replaceRoomPlayerWithBot(room, playerId);
}

function removeRoomPlayer(room: Room, targetId: string): void {
  const target = room.players.find((player) => player.id === targetId);
  if (!target) throw new Error("目标席位不存在");
  const previousPlayers = [...room.players];
  const wasBanker = room.bankerPlayerId === targetId;
  room.players = room.players.filter((player) => player.id !== targetId);
  room.players = room.players.map((player, index) => ({ ...player, seat: index }));
  room.readyPlayerIds = room.readyPlayerIds.filter((id) => id !== targetId);
  room.bankerPlayerId = wasBanker
    ? nextBankerPlayerId(previousPlayers, targetId, new Set(room.players.map((player) => player.id)))
    : ensureBankerPlayerId(room.players, room.bankerPlayerId);
}

function replaceRoomPlayerWithBot(room: Room, targetId: string): void {
  const target = room.players.find((player) => player.id === targetId && !player.bot);
  if (!target) throw new Error("目标席位不存在");
  if ((room.rulesetMode ?? "classic") === "custom") {
    if (room.game && room.game.status !== "ended") {
      // 自定义模式禁止 AI/托管接替：座位保留给离线玩家，等待其重新连接
      room.departedPlayerIds ??= [];
      if (!room.departedPlayerIds.includes(targetId)) room.departedPlayerIds.push(targetId);
      markWorkerPlayerOffline(room, targetId);
      return;
    }
    // 自定义模式大厅/已结束：直接移除座位，不生成 AI
    removeRoomPlayer(room, targetId);
    return;
  }
  const previousPlayers = [...room.players];
  const wasBanker = room.bankerPlayerId === targetId;
  const owner = room.players.find((player) => player.accountId === room.creatorAccountId && !player.bot);
  const replacement: PlayerState = {
    id: uid("bot"),
    nickname: `AI ${room.players.filter((player) => player.bot).length + 1}`,
    hand: [],
    online: true,
    lastSeenAt: Date.now(),
    bot: true,
    botOwnerId: owner?.id,
    seat: target.seat,
    timeoutLimitMs: AUTOMATED_ACTION_DELAY_MS,
    timeoutStreak: 0,
    normalStreak: 0,
    forcedAutoplay: false,
  };
  const activeGame = room.game && room.game.status !== "ended" ? (room.game as GameState) : undefined;
  if (activeGame) {
    room.departedPlayerIds ??= [];
    if (!room.departedPlayerIds.includes(targetId)) room.departedPlayerIds.push(targetId);
    activeGame.players = activeGame.players.map((player) =>
      player.id === targetId
        ? {
            ...player,
            nickname: `${player.nickname}（AI 接替）`,
            accountId: undefined,
            profile: undefined,
            bot: true,
            botOwnerId: owner?.id,
            online: true,
            timeoutLimitMs: AUTOMATED_ACTION_DELAY_MS,
            forcedAutoplay: true,
          }
        : player,
    );
    const opening = activeGame.openingExchange;
    if (opening?.eligiblePlayerIds.includes(targetId)) {
      if (!opening.completedPlayerIds.includes(targetId)) opening.completedPlayerIds.push(targetId);
      if (!opening.doubleCompletedPlayerIds.includes(targetId)) opening.doubleCompletedPlayerIds.push(targetId);
      delete opening.deadlineByPlayerId[targetId];
      const completed = opening.eligiblePlayerIds.every(
        (id) => opening.completedPlayerIds.includes(id) && opening.doubleCompletedPlayerIds.includes(id),
      );
      if (completed) room.game = finishOpeningExchange(activeGame as GameState);
    }
    if (room.game?.status === "playing" && rulesetCurrentPlayer(room.game).id === targetId) {
      room.game.turnStartedAt = Date.now();
      room.game.turnDeadlineAt = Date.now() + AUTOMATED_ACTION_DELAY_MS;
    }
  }
  room.players = room.players.map((player) => (player.id === targetId ? replacement : player));
  room.readyPlayerIds = room.readyPlayerIds.filter((id) => id !== targetId);
  room.bankerPlayerId = wasBanker
    ? nextBankerPlayerId(previousPlayers, targetId, new Set(room.players.map((player) => player.id)))
    : ensureBankerPlayerId(room.players, room.bankerPlayerId);
  if (activeGame) syncRoomMembersFromGame(room);
}

function syncRoomMembersFromGame(room: Room): void {
  if (!room.game) return;
  const departed = new Set(room.departedPlayerIds ?? []);
  const gameIds = new Set(room.game.players.map((player) => player.id));
  const replacementBots = room.players.filter((player) => player.bot && !gameIds.has(player.id));
  room.players = [...room.game.players.filter((player) => !departed.has(player.id)), ...replacementBots]
    .sort((a, b) => a.seat - b.seat)
    .map((player, index) => ({ ...player, seat: index }));
}

function advanceBankerAfterGame(room: Room): void {
  const game = room.game;
  if (!game || game.status !== "ended" || room.bankerRotationGameId === game.id) return;
  const availableIds = new Set(room.players.map((player) => player.id));
  const next = nextBankerPlayerId(game.players, room.bankerPlayerId, availableIds);
  if (next) room.bankerPlayerId = next;
  room.bankerRotationGameId = game.id;
}

function createRoomEditNotice(room: Room, updatedByNickname: string): RoomEditNotice {
  const updatedAt = Date.now();
  return {
    id: `${updatedAt}_${Math.random().toString(36).slice(2, 8)}`,
    capacity: roomCapacity(room),
    baseBet: room.baseBet,
    initialHandSize: room.initialHandSize,
    turnTimeLimitSec: room.turnTimeLimitSec,
    openingExchangeSec: room.openingExchangeSec,
    updatedByNickname,
    updatedAt,
    recipientPlayerIds: room.players.filter((player) => !player.bot).map((player) => player.id),
  };
}

function canReadRoomRules(room: Room, accountId: string): boolean {
  return room.creatorAccountId === accountId || room.players.some((player) => !player.bot && player.accountId === accountId);
}

function ensurePlayerAccount(room: Room, playerId: string, accountId: string): void {
  const player = room.players.find((p) => p.id === playerId && !p.bot);
  if (!player || player.accountId !== accountId) throw new Error("没有权限操作该席位");
}

function ensureActionAccount(room: Room, playerId: string, accountId: string): void {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) throw new Error("席位不存在");
  if (player.bot) throw new Error("联机机器人由服务器自动操作");
  if (player.accountId !== accountId) throw new Error("没有权限操作该席位");
}

function roomPayload(room: Room, viewerId?: string) {
  return {
    room: summarizeRoom(room),
    game: room.game ? publicRulesetGame(room.game, viewerId) : undefined,
    serverNow: Date.now(),
    timer:
      room.game?.status === "playing" || room.game?.status === "opening-exchange"
        ? {
            currentPlayerId: rulesetCurrentPlayer(room.game).id,
            deadlineAt: room.game.turnDeadlineAt,
            limitMs: room.game.status === "opening-exchange" ? (room.game.openingExchangeWindowMs ?? OPENING_EXCHANGE_MS) : rulesetCurrentPlayer(room.game).timeoutLimitMs,
          }
        : undefined,
  };
}

function summarizeRoom(room: Room) {
  const ready = new Set(room.readyPlayerIds ?? []);
  return {
    code: room.code,
    roomCodeKind: room.codeKind ?? "custom",
    revision: room.revision,
    createdAt: room.createdAt,
    lastActiveAt: room.lastActiveAt,
    capacity: roomCapacity(room),
    creatorAccountId: room.creatorAccountId,
    bankerPlayerId: room.bankerPlayerId,
    baseBet: room.baseBet ?? 5,
    rulesetMode: room.rulesetMode ?? "classic",
    customRulesHash: room.rulesetMode === "custom" ? (room.customRulesHash ?? null) : null,
    customConfigRevision: room.rulesetMode === "custom" ? (room.customConfigRevision ?? 0) : null,
    customPresetId: room.rulesetMode === "custom" ? (room.customPresetId ?? null) : null,
    customPresetRevision: room.rulesetMode === "custom" ? (room.customPresetRevision ?? null) : null,
    initialHandSize: room.initialHandSize ?? null,
    turnTimeLimitSec: room.turnTimeLimitSec ?? null,
    openingExchangeSec: room.openingExchangeSec ?? null,
    duelMode: Boolean(room.duelMode),
    duelKeepAvailable: workerDuelKeepAvailable(room),
    roomGamesPlayed: room.roomGamesPlayed ?? {},
    roomGamesWon: room.roomGamesWon ?? {},
    editNotice: room.editNotice,
    status: room.game?.status ?? "lobby",
    players: room.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      accountId: p.accountId,
      profile: p.profile,
      online: p.online,
      bot: p.bot,
      botOwnerId: p.botOwnerId,
      seat: p.seat,
      handCount: p.hand.length,
      timeoutLimitMs: p.timeoutLimitMs,
      timeoutStreak: p.timeoutStreak,
      forcedAutoplay: p.forcedAutoplay,
      canOpeningExchange: p.canOpeningExchange,
      openingExchangeDone: p.openingExchangeDone,
      openingExchangeMin: p.openingExchangeMin,
      openingExchangeMax: p.openingExchangeMax,
      openingExchangeWindowMs: p.openingExchangeWindowMs,
      readyToStart: p.bot || ready.has(p.id),
    })),
  };
}

function normalizeRoomCapacity(room: Room): void {
  room.capacity ??= room.targetHumanPlayers ?? 2;
  room.rulesetMode ??= "classic";
  room.creatorAccountId ??= room.players.find((player) => !player.bot)?.accountId ?? "";
  room.bankerPlayerId = ensureBankerPlayerId(room.players, room.bankerPlayerId);
  room.departedPlayerIds ??= [];
  normalizeCustomRulesSnapshot(room);
}

function normalizeCustomRulesSnapshot(room: Room): void {
  const rules = room.customRules ?? (room.game && isCustomGame(room.game) ? room.game.custom.rules as ResolvedCustomRules | undefined : undefined);
  if (!rules) return;
  const hash = canonicalCustomRulesHash(rules);
  room.customRulesHash = hash;
  if (room.game && isCustomGame(room.game)) room.game.custom.rulesHash = hash;
}

function roomCapacity(room: Room): number {
  normalizeRoomCapacity(room);
  return Math.min(10, Math.max(1, room.capacity));
}

function markPlayerOnline(room: Room, playerId: string): boolean {
  const now = Date.now();
  let changed = false;
  for (const player of [...room.players, ...(room.game?.players ?? [])]) {
    if (player.id === playerId) {
      if (!player.online || player.lastSeenAt !== now) changed = true;
      player.online = true;
      player.lastSeenAt = now;
    }
  }
  return changed;
}

function refreshWorkerPresence(room: Room, now = Date.now()): boolean {
  let changed = false;
  for (const player of [...room.players, ...(room.game?.players ?? [])]) {
    if (player.bot || player.forcedAutoplay) continue;
    const online = now - (player.lastSeenAt ?? 0) <= PRESENCE_OFFLINE_MS;
    if (player.online !== online) {
      player.online = online;
      changed = true;
    }
  }
  return changed;
}

async function userForToken(env: Env, token: string): Promise<StoredUser | undefined> {
  const raw = env.ION_SESSIONS ? await env.ION_SESSIONS.get(`session:${token}`) : memory.sessions.get(token);
  if (!raw) return undefined;
  let session: { userId: string; sessionVersion: number };
  try {
    const parsed = JSON.parse(raw) as Partial<typeof session>;
    if (!parsed.userId || !Number.isInteger(parsed.sessionVersion)) return undefined;
    session = { userId: parsed.userId, sessionVersion: parsed.sessionVersion as number };
  } catch {
    // Legacy sessions were stored as the bare user id and therefore belong to version 0.
    session = { userId: raw, sessionVersion: 0 };
  }
  const user = (await loadUsers(env)).find((item) => item.id === session.userId);
  return user && (user.sessionVersion ?? 0) === session.sessionVersion ? user : undefined;
}

async function putSession(env: Env, token: string, userId: string, sessionVersion: number): Promise<void> {
  const payload = JSON.stringify({ userId, sessionVersion });
  if (env.ION_SESSIONS) await env.ION_SESSIONS.put(`session:${token}`, payload, { expirationTtl: SESSION_TTL_SECONDS });
  else memory.sessions.set(token, payload);
}

async function deleteSession(env: Env, token: string): Promise<void> {
  if (env.ION_SESSIONS) await env.ION_SESSIONS.delete(`session:${token}`);
  else memory.sessions.delete(token);
}

function roleFor(user: StoredUser, now = Date.now()): UserRole {
  if (user.superAdmin) return "super-admin";
  const admin = user.adminPermanent || isFuture(user.adminExpiresAt, now);
  const advanced = user.advancedPermanent || isFuture(user.advancedExpiresAt, now);
  if (admin && advanced) return "admin-advanced";
  if (admin) return "admin";
  if (advanced) return "advanced";
  return "normal";
}

function hasWorkerAdvancedAiAccess(user: StoredUser, now = Date.now()): boolean {
  return Boolean(user.superAdmin || user.advancedAiPermanent || isFuture(user.advancedAiExpiresAt, now));
}

function applyRolePatch(actor: ReturnType<typeof publicUser>, target: ReturnType<typeof publicUser>, stored: StoredUser, patch: Record<string, unknown>): void {
  if (stored.superAdmin) throw new Error("超级管理员身份不可编辑");
  if (actor.role !== "super-admin") {
    if (target.role === "admin" || target.role === "admin-advanced" || target.role === "super-admin") throw new Error("管理员只能管理非管理员用户");
    if (
      patch.adminPermanent !== undefined ||
      patch.advancedPermanent !== undefined ||
      patch.adminExpiresAt !== undefined ||
      patch.advancedExpiresAt === undefined
    ) {
      throw new Error("管理员只能定时设置高级用户");
    }
    stored.advancedExpiresAt = cleanExpiry(patch.advancedExpiresAt);
    return;
  }
  if (patch.adminPermanent !== undefined) stored.adminPermanent = Boolean(patch.adminPermanent);
  if (patch.advancedPermanent !== undefined) stored.advancedPermanent = Boolean(patch.advancedPermanent);
  if (patch.adminExpiresAt !== undefined) stored.adminExpiresAt = cleanExpiry(patch.adminExpiresAt);
  if (patch.advancedExpiresAt !== undefined) stored.advancedExpiresAt = cleanExpiry(patch.advancedExpiresAt);
}

function hasRolePatch(patch: Record<string, unknown>): boolean {
  return patch.adminPermanent !== undefined || patch.advancedPermanent !== undefined || patch.adminExpiresAt !== undefined || patch.advancedExpiresAt !== undefined;
}

function touchesProtectedFields(patch: Record<string, unknown>): boolean {
  return (
    patch.nickname !== undefined ||
    patch.password !== undefined ||
    patch.title !== undefined ||
    patch.nicknameColor !== undefined ||
    patch.points !== undefined ||
    patch.disabledUntil !== undefined ||
    patch.disabledPermanent !== undefined ||
    patch.hideFromLeaderboardWhileDisabled !== undefined ||
    patch.leaderboardHiddenUntil !== undefined ||
    patch.leaderboardHiddenPermanent !== undefined ||
    patch.nicknameChangeDisabled !== undefined ||
    patch.advancedAiAccess !== undefined ||
    patch.advancedAiPermanent !== undefined ||
    patch.advancedAiExpiresAt !== undefined ||
    patch.taxRatePercent !== undefined ||
    hasRolePatch(patch) ||
    patch.permissions !== undefined ||
    patch.permissionsPermanent !== undefined ||
    patch.permissionsDurationMs !== undefined ||
    patch.permissionsExpiresAt !== undefined ||
    patch.customModeLimits !== undefined ||
    patch.customModeLimitsPermanent !== undefined ||
    patch.customModeLimitsDurationMs !== undefined ||
    patch.customModeLimitsExpiresAt !== undefined
  );
}

function canManageNickname(actor: ReturnType<typeof publicUser>, target: ReturnType<typeof publicUser>): boolean {
  if (target.superAdmin) return false;
  if (actor.role === "super-admin") return true;
  if (actor.role === "admin" || actor.role === "admin-advanced") return target.role !== "admin" && target.role !== "admin-advanced";
  return false;
}

function canManageBan(actor: ReturnType<typeof publicUser>, target: ReturnType<typeof publicUser>): boolean {
  if (actor.role === "super-admin") return !target.superAdmin;
  if (actor.role === "admin" || actor.role === "admin-advanced") return target.role !== "admin" && target.role !== "admin-advanced" && target.role !== "super-admin";
  return false;
}

function isAdminRole(role: UserRole): boolean {
  return role === "super-admin" || role === "admin" || role === "admin-advanced";
}

function subtitleFor(role: UserRole, title?: string): string | undefined {
  const base = role === "super-admin" ? "超级管理员" : role === "admin-advanced" ? "管理员+高级用户" : role === "admin" ? "管理员" : role === "advanced" ? "高级用户" : "";
  if (base) return title ? `${base} · ${title}` : base;
  return title;
}

function validateUsername(username: string): string {
  const clean = username.trim();
  assertSpreadsheetSafeAccountName(clean, "用户名");
  if (clean.length < 1 || clean.length > 24) throw new Error("用户名长度必须为 1-24 个字符");
  return clean;
}

function validatePassword(password: string): void {
  if (password.length < 6 || password.length > 72) throw new Error("密码长度必须为 6-72 个字符");
}

function validateNickname(nickname: string): string {
  const clean = nickname.trim();
  assertSpreadsheetSafeText(clean, "昵称");
  if (clean.length < 1 || clean.length > 24) throw new Error("昵称长度必须为 1-24 个字符");
  return clean;
}

function validateHexColor(value: string): string {
  const clean = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(clean)) throw new Error("颜色必须是 #RRGGBB 格式");
  return clean.toUpperCase();
}

function cleanColor(value: string | undefined): string | undefined {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
}

function cleanOptional(value: unknown, maxLength: number): string | undefined {
  const clean = value === null ? "" : String(value ?? "").trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function cleanRequiredString(value: unknown, maxLength: number): string {
  const clean = String(value ?? "").trim();
  if (!clean) throw new Error("自定义头衔不能为空");
  return clean.slice(0, maxLength);
}

function cleanExpiry(value: unknown): string | undefined {
  if (value === null || value === "") return undefined;
  const raw = String(value);
  const iso = raw.includes("+") || raw.endsWith("Z") ? raw : `${raw}+08:00`;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) throw new Error("到期时间格式不正确");
  return new Date(time).toISOString();
}

function isFuture(value: string | undefined, now = Date.now()): boolean {
  return Boolean(value && Date.parse(value) > now);
}

function isStoredUserDisabled(user: Pick<StoredUser, "disabledPermanent" | "disabledUntil">, now = Date.now()): boolean {
  return Boolean(user.disabledPermanent || isFuture(user.disabledUntil, now));
}

function isStoredUserHiddenFromLeaderboard(
  user: Pick<
    StoredUser,
    "disabledPermanent" | "disabledUntil" | "hideFromLeaderboardWhileDisabled" | "leaderboardHiddenPermanent" | "leaderboardHiddenUntil"
  >,
  now = Date.now(),
): boolean {
  return Boolean(
    user.leaderboardHiddenPermanent ||
      isFuture(user.leaderboardHiddenUntil, now) ||
      (user.hideFromLeaderboardWhileDisabled && isStoredUserDisabled(user, now)),
  );
}

function todayKey(now = Date.now()): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function recordTodayStats(user: StoredUser, won: boolean, now = Date.now()): void {
  const date = todayKey(now);
  if (user.todayStatsDate !== date) {
    user.todayStatsDate = date;
    user.todayGamesPlayed = 0;
    user.todayGamesWon = 0;
    user.todayGamePointsDelta = 0;
  }
  user.todayGamesPlayed = (user.todayGamesPlayed ?? 0) + 1;
  if (won) user.todayGamesWon = (user.todayGamesWon ?? 0) + 1;
}

function addWorkerTodayGamePointsDelta(user: StoredUser, delta: number, now = Date.now()): void {
  const date = todayKey(now);
  if (user.todayStatsDate !== date) {
    user.todayStatsDate = date;
    user.todayGamesPlayed = 0;
    user.todayGamesWon = 0;
    user.todayGamePointsDelta = 0;
  }
  user.todayGamePointsDelta = (user.todayGamePointsDelta ?? 0) + delta;
}

function boolText(value: boolean): string {
  return value ? "是" : "否";
}

function maxWorkerRequestActivity(requests: WorkerRequest[]): number {
  return requests.reduce((maximum, request) => Math.max(maximum, request.createdAt, request.repliedAt ?? 0), 0);
}

function nextWorkerRequestActivityAt(requests: WorkerRequest[]): number {
  return Math.max(Date.now(), maxWorkerRequestActivity(requests) + 1);
}

function cleanInitialHandSize(value: unknown, players: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  const maximum = maxInitialHandSize(players);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > maximum) {
    throw new Error(`初始手牌数量必须为 2-${maximum} 的整数，留空则使用规则默认数量`);
  }
  return parsed;
}

type ReservedRoomCodeOperation = "read" | "add" | "update" | "delete";

type RequestedRoomCode = { mode: "custom" | "reserved"; code?: string };

function resolveRequestedRoomCode(payload: AdminStatePayload, actor: StoredUser, modeInput: unknown, codeInput: unknown): RequestedRoomCode {
  const mode = modeInput === undefined ? "custom" : modeInput;
  if (mode !== "custom" && mode !== "reserved") throw new Error("房间号模式无效");
  const code = typeof codeInput === "string" ? codeInput.trim() : "";
  if (mode === "custom") {
    if (!code) return { mode };
    if (!/^[1-9]\d{5}$/.test(code)) throw new Error("自定义房间号必须是首位非 0 的六位数字");
    if (isReservedRoomCode(payload, code)) throw new Error("该房间号已被占用");
    return { mode, code };
  }
  const owned = normalizeReservedRoomCodes(actor.reservedRoomCodes);
  if (!code || !owned.includes(code)) throw new Error("只能使用本人拥有的专属房间号创建房间");
  return { mode, code };
}

function isReservedRoomCode(payload: AdminStatePayload, code: string): boolean {
  return payload.users.some((user) => normalizeReservedRoomCodes(user.reservedRoomCodes).includes(code));
}

function validateReservedRoomCodeGrantMode(value: unknown): "user-input" | "random" {
  if (value !== "user-input" && value !== "random") throw new Error("专属房间号发放方式无效");
  return value;
}

function ensureWorkerRedemptionReservedRoomCodeAllowance(user: StoredUser): void {
  if (normalizeReservedRoomCodes(user.reservedRoomCodes).length > 10) throw new Error("专属房间号超过 10 个，无法兑换邀请码或激活码");
}

async function prepareWorkerReservedRoomCodeGrant(
  env: Env,
  payload: AdminStatePayload,
  user: StoredUser,
  mode: "user-input" | "random",
  suppliedCode: unknown,
): Promise<string> {
  const codes = normalizeReservedRoomCodes(user.reservedRoomCodes);
  if (codes.length >= 10) throw new Error("专属房间号已达到 10 个上限，无法兑换邀请码或激活码");
  if (mode === "user-input") {
    const code = validateExclusiveRoomCode(suppliedCode, false);
    const owner = payload.users.find((item) => normalizeReservedRoomCodes(item.reservedRoomCodes).includes(code));
    if (owner && owner.id !== user.id) throw new Error("该专属房间号已被其他用户占用");
    if (codes.includes(code)) throw new Error("该用户已拥有此专属房间号");
    if (await workerRoomCodeIsOccupied(env, code)) throw new Error("该专属房间号已被现有房间占用");
    return code;
  }
  for (let attempt = 0; attempt < 1000; attempt++) {
    const code = Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0");
    if (!isReservedRoomCode(payload, code) && !codes.includes(code) && !(await workerRoomCodeIsOccupied(env, code))) return code;
  }
  throw new Error("暂时无法生成未占用的专属房间号，请稍后重试");
}

async function workerRoomCodeIsOccupied(env: Env, code: string): Promise<boolean> {
  if (env.ION_ROOM_STATE) {
    const response = await durableRoomRequest(env, code, "exists", undefined, {});
    if (!response.ok) throw new Error("暂时无法校验房间号是否被占用");
    const data = await response.json() as { exists?: boolean };
    return Boolean(data.exists);
  }
  return Boolean(await getRoom(env, code));
}

function normalizeReservedRoomCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((code): code is string => typeof code === "string" && /^\d+$/.test(code)))];
}

function validateExclusiveRoomCode(value: unknown, unlimitedLength: boolean): string {
  const code = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(code)) throw new Error("专属房间号必须是数字字符串");
  if (!unlimitedLength && code.length > 6) throw new Error("专属房间号不能超过 6 位");
  return code;
}

function ensureExclusiveRoomCodeAvailable(payload: AdminStatePayload, code: string, targetUserId: string, replacingCode?: string): void {
  for (const user of payload.users) {
    const codes = normalizeReservedRoomCodes(user.reservedRoomCodes);
    if (!codes.includes(code)) continue;
    if (user.id === targetUserId && code === replacingCode) continue;
    throw new Error("该房间号已被占用");
  }
}

function canManageExclusiveRoomCode(actor: StoredUser, target: StoredUser, operation: ReservedRoomCodeOperation): boolean {
  if (actor.superAdmin) return true;
  if (operation === "read") return actor.id === target.id || (isWorkerAdmin(actor) && isWorkerAdvancedOrNormal(target));
  if (operation === "delete") return actor.id === target.id || (isWorkerAdmin(actor) && isWorkerAdvancedOrNormal(target));
  return false;
}

function isWorkerAdmin(user: StoredUser): boolean {
  const role = roleFor(user);
  return role === "admin" || role === "admin-advanced";
}

function isWorkerAdvancedOrNormal(user: StoredUser): boolean {
  const role = roleFor(user);
  return role === "advanced" || role === "normal";
}

function workerDuelCooldownStatus(payload: AdminStatePayload, userId: string, now = Date.now()): { allowed: boolean; retryAt?: number } {
  const user = payload.users.find((item) => item.id === userId);
  if (!user) throw new Error("用户不存在");
  return workerDuelLimitStatus(workerPermissionsForPayload(payload, user).duelLimit, duelRecordsFor(payload.duelRoomCooldowns[userId]), now);
}

async function recordWorkerDuelRoomCreation(env: Env, userId: string): Promise<void> {
  const result = (await adminStateMutation(env, "/duel/record", { userId })) as { ok?: boolean; duelCooldownUntil?: number; duelDenied?: boolean };
  if (result.duelDenied || typeof result.duelCooldownUntil === "number") {
    const retryAt = typeof result.duelCooldownUntil === "number" ? new Date(result.duelCooldownUntil).toLocaleString("zh-CN", { hour12: false }) : "管理员重新开放决斗权限";
    throw new Error(typeof result.duelCooldownUntil === "number" ? `当前不可开始决斗对局，请等到 ${retryAt} 后重试` : "当前账号不允许开始决斗对局");
  }
  if (!result.ok) throw new Error("决斗额度扣除失败");
}

const DUEL_ROOM_COOLDOWN_MS = 60 * 60 * 1000;
const DUEL_LIMIT_PERIOD_MS: Record<Exclude<DuelLimitPeriod, "none" | "unlimited">, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

function defaultAdminState(): AdminStatePayload {
  return {
    users: [],
    invitations: [],
    activationCodes: [],
    requests: [],
    requestSeenAtByUserId: {},
    rolePermissions: defaultRolePermissions(),
    customModeLimits: defaultCustomModeLimits(),
    taxRatePercent: DEFAULT_TAX_RATE_PERCENT,
    taxWinnerPointsThreshold: undefined,
    userPermissions: {},
    userCustomModeLimits: {},
    customRulesPresets: [],
    settledGameIds: [],
    securityIncidents: [],
    duelRoomCooldowns: {},
  };
}

function normalizeAdminState(value: Partial<AdminStatePayload>): AdminStatePayload {
  const defaults = defaultRolePermissions();
  const legacyRolePermissions = value.rolePermissions as
    | Partial<Record<UserRole, Partial<PermissionRule> & LegacyCustomPermissionFields>>
    | undefined;
  const rolePermissions = Object.fromEntries(
    (Object.keys(defaults) as UserRole[]).map((role) => [
      role,
      normalizeWorkerPermission({ ...defaults[role], ...(legacyRolePermissions?.[role] ?? {}) }),
    ]),
  ) as Record<UserRole, PermissionRule>;
  const legacyGlobal = legacyWorkerCustomModeGrant({ permissions: legacyRolePermissions?.normal });
  const customModeLimits = normalizeCustomModeLimits(
    (value as Partial<AdminStatePayload> & { customModeLimits?: CustomModeLimitGrant }).customModeLimits ?? legacyGlobal,
  );
  const userCustomModeLimits: Record<string, WorkerCustomModeLimitOverride> = {};
  const userPermissions: AdminStatePayload["userPermissions"] = {};
  for (const [userId, entry] of Object.entries(value.userCustomModeLimits ?? {})) {
    userCustomModeLimits[userId] = {
      limits: normalizeCustomModeLimitGrant(entry.limits),
      expiresAt: entry.expiresAt,
      permanent: entry.permanent,
    };
  }
  for (const [userId, entry] of Object.entries(value.userPermissions ?? {})) {
    userPermissions[userId] = {
      permissions: normalizeWorkerPermissionPatch(entry.permissions),
      expiresAt: entry.expiresAt,
      permanent: entry.permanent,
    };
    if (userCustomModeLimits[userId]) continue;
    const legacy = legacyWorkerCustomModeGrant({ permissions: entry.permissions as Partial<PermissionRule> & LegacyCustomPermissionFields });
    if (legacy) userCustomModeLimits[userId] = { limits: legacy, expiresAt: entry.expiresAt, permanent: entry.permanent };
  }
  const normalized: AdminStatePayload = {
    users: Array.isArray(value.users)
      ? value.users.map((user) => ({ ...user, reservedRoomCodes: normalizeReservedRoomCodes(user.reservedRoomCodes) }))
      : [],
    invitations: Array.isArray(value.invitations)
      ? value.invitations.map((invitation) => ({
          ...invitation,
          permissions: invitation.permissions ? normalizeWorkerPermissionPatch(invitation.permissions) : undefined,
          customModeLimits:
            invitation.customModeLimits ??
            legacyWorkerCustomModeGrant({ permissions: invitation.permissions as Partial<PermissionRule> & LegacyCustomPermissionFields }),
        }))
      : [],
    activationCodes: Array.isArray(value.activationCodes)
      ? value.activationCodes.map((activation) => ({
          ...activation,
          permissions: activation.permissions ? normalizeWorkerPermissionPatch(activation.permissions) : undefined,
          customModeLimits:
            activation.customModeLimits ??
            legacyWorkerCustomModeGrant({ permissions: activation.permissions as Partial<PermissionRule> & LegacyCustomPermissionFields }),
          customModeLimitDurationMs: activation.customModeLimitDurationMs ?? activation.permissionDurationMs,
        }))
      : [],
    requests: Array.isArray(value.requests) ? value.requests : [],
    requestSeenAtByUserId: value.requestSeenAtByUserId ?? {},
    rolePermissions,
    customModeLimits,
    taxRatePercent: normalizeTaxRatePercent(value.taxRatePercent, DEFAULT_TAX_RATE_PERCENT),
    taxWinnerPointsThreshold: normalizeTaxWinnerPointsThreshold(value.taxWinnerPointsThreshold, undefined),
    userPermissions,
    userCustomModeLimits,
    customRulesPresets: Array.isArray(value.customRulesPresets)
      ? value.customRulesPresets.map((preset) => ({
          ...preset,
          revision: Number.isInteger(preset.revision) && preset.revision > 0 ? preset.revision : 1,
          enabled: preset.enabled !== false,
        }))
      : [],
    settledGameIds: Array.isArray(value.settledGameIds) ? value.settledGameIds.slice(-10_000) : [],
    securityIncidents: Array.isArray(value.securityIncidents) ? value.securityIncidents.slice(-MAX_SECURITY_INCIDENTS) : [],
    duelRoomCooldowns: normalizeWorkerDuelRecordMap(value.duelRoomCooldowns),
  };
  trimWorkerSecurityIncidents(normalized);
  return normalized;
}

async function hydrateAdminState(env: Env): Promise<void> {
  if (!env.ION_ACCOUNT_STATE) {
    if (memory.adminState.users.length === 0) {
      memory.adminState.users = bootstrapWorkerSuperAdmin(env);
    }
    return;
  }
  const stub = env.ION_ACCOUNT_STATE.get(env.ION_ACCOUNT_STATE.idFromName("global"));
  const response = await stub.fetch(new Request("https://account-state/", { method: "GET" }));
  if (!response.ok) throw new Error("账户状态加载失败");
  let state = normalizeAdminState((await response.json()) as Partial<AdminStatePayload>);
  if (state.users.length === 0) {
    const legacyRaw = env.ION_USERS ? await env.ION_USERS.get(USERS_KEY) : null;
    const legacyUsers = legacyRaw ? ((JSON.parse(legacyRaw) as { users?: StoredUser[] }).users ?? []) : [];
    const users = legacyUsers.length > 0 ? assertSuperAdmin(structuredClone(legacyUsers)) : bootstrapWorkerSuperAdmin(env);
    const initialized = await adminStateMutation(env, "/initialize", { users });
    state = normalizeAdminState(initialized as Partial<AdminStatePayload>);
  }
  memory.adminState = state;
}

async function adminStateMutation(env: Env, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  const request = new Request(`https://account-state${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (env.ION_ACCOUNT_STATE) {
    const stub = env.ION_ACCOUNT_STATE.get(env.ION_ACCOUNT_STATE.idFromName("global"));
    response = await stub.fetch(request);
  } else {
    const localState: DurableObjectState = {
      storage: {
        get: async <T>(_key: string) => structuredClone(memory.adminState) as T,
        put: async (_key, value) => {
          memory.adminState = value as AdminStatePayload;
        },
      },
    };
    response = await new AccountState(localState).fetch(request);
  }
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok || result.error) throw new Error(String(result.error ?? "账户状态保存失败"));
  return result;
}

function applyInvitationBody(invitation: WorkerInvitation, body: Record<string, unknown>): void {
  if (body.remainingUses !== undefined) {
    const remainingUses =
      body.remainingUses === null ? null : cleanWorkerInteger(body.remainingUses, "邀请码剩余次数", 0);
    invitation.remainingUses = remainingUses;
    if (body.usePolicy === undefined) {
      invitation.usePolicy = remainingUses === null ? "unlimited" : "global-total";
      if (remainingUses !== null) {
        invitation.maxUses = (invitation.registrations?.length ?? 0) + remainingUses;
      }
    }
  }
  if (body.usePolicy !== undefined) {
    if (!["unlimited", "global-total", "global-window"].includes(String(body.usePolicy))) {
      throw new Error("邀请码使用策略不正确");
    }
    invitation.usePolicy = body.usePolicy as WorkerInvitation["usePolicy"];
  }
  if (body.maxUses !== undefined) invitation.maxUses = cleanWorkerInteger(body.maxUses, "邀请码最多注册次数", 1);
  if (body.windowMs !== undefined) {
    invitation.windowMs = body.windowMs === null ? undefined : cleanWorkerInteger(body.windowMs, "邀请码滚动周期", 1);
  }
  if (body.expiresAt !== undefined) invitation.expiresAt = cleanExpiry(body.expiresAt);
  if (body.role !== undefined) {
    if (!isUserRole(body.role) || body.role === "super-admin") throw new Error("邀请码注册身份不正确");
    invitation.role = body.role;
  }
  if (body.initialPoints !== undefined) invitation.initialPoints = cleanWorkerInteger(body.initialPoints, "初始积分");
  if (body.initialTitle !== undefined) invitation.initialTitle = cleanOptional(body.initialTitle === null ? null : String(body.initialTitle), 24);
  if (body.initialNicknameColor !== undefined) {
    invitation.initialNicknameColor =
      body.initialNicknameColor === null ? undefined : validateHexColor(String(body.initialNicknameColor));
  }
  if (body.permissions !== undefined) {
    invitation.permissions =
      body.permissions === null ? undefined : normalizeWorkerPermissionPatch(body.permissions as Partial<PermissionRule>);
  }
  if (body.customModeLimits !== undefined) {
    invitation.customModeLimits =
      body.customModeLimits === null ? undefined : normalizeCustomModeLimitGrant(body.customModeLimits as CustomModeLimitGrant);
  }
  applyWorkerInvitationGrantBody(
    invitation,
    "admin",
    body.adminDurationMs,
    body.adminExpiresAt,
    body.adminPermanent,
  );
  applyWorkerInvitationGrantBody(
    invitation,
    "advanced",
    body.advancedDurationMs,
    body.advancedExpiresAt,
    body.advancedPermanent,
  );
  applyWorkerAdvancedAiGrantBody(invitation, body.advancedAiDurationMs, body.advancedAiExpiresAt);
  if (body.taxRatePercent !== undefined) {
    invitation.taxRatePercent = body.taxRatePercent === null ? undefined : cleanTaxRatePercent(body.taxRatePercent);
  }
  if (body.reservedRoomCodeMode !== undefined) {
    invitation.reservedRoomCodeMode = body.reservedRoomCodeMode === null ? undefined : validateReservedRoomCodeGrantMode(body.reservedRoomCodeMode);
  }
  normalizeWorkerInvitationRoleGrants(invitation);
  normalizeWorkerInvitationQuota(invitation);
}

function consumeWorkerInvitation(
  payload: AdminStatePayload,
  codeInput: string,
  userId: string,
  deviceHash: string,
  browserHash: string,
): WorkerInvitation {
  const now = Date.now();
  const invitation = preflightWorkerInvitation(payload, codeInput, deviceHash, browserHash, now);
  invitation.registrations!.push({ userId, usedAt: now, deviceHash, browserHash });
  syncWorkerInvitationRemainingUses(invitation);
  invitation.updatedAt = now;
  return invitation;
}

function preflightWorkerInvitation(
  payload: AdminStatePayload,
  codeInput: string,
  deviceHash: string,
  browserHash: string,
  now: number,
): WorkerInvitation {
  const code = validateCode(codeInput);
  const invitation = payload.invitations.find((item) => item.code === code);
  if (!invitation) throw new Error("邀请码不存在");
  if (!deviceHash || !browserHash) throw new Error("无法确认注册设备或浏览器环境");
  if (invitation.expiresAt && Date.parse(invitation.expiresAt) <= now) throw new Error("邀请码已失效");
  normalizeWorkerInvitationQuota(invitation);
  const sameEnvironment = invitation.registrations!.some(
    (item) =>
      todayKey(item.usedAt) === todayKey(now) &&
      (item.deviceHash === deviceHash || item.browserHash === browserHash),
  );
  if (sameEnvironment) throw new Error("该设备或浏览器今天已使用此邀请码注册过账号");
  enforceWorkerInvitationQuota(invitation, now);
  return invitation;
}

function normalizeWorkerInvitationQuota(invitation: WorkerInvitation): void {
  invitation.registrations ??= [];
  if (!invitation.usePolicy) {
    invitation.usePolicy = invitation.remainingUses === null ? "unlimited" : "global-total";
    if (invitation.remainingUses !== null) {
      invitation.maxUses = invitation.registrations.length + Math.max(0, invitation.remainingUses);
    }
  }
  invitation.maxUses ??= 1;
  if (invitation.usePolicy === "global-window" && !invitation.windowMs) {
    throw new Error("滚动限额邀请码必须设置滚动周期");
  }
  syncWorkerInvitationRemainingUses(invitation);
}

function enforceWorkerInvitationQuota(invitation: WorkerInvitation, now: number): void {
  normalizeWorkerInvitationQuota(invitation);
  if (invitation.usePolicy === "unlimited") return;
  const registrations =
    invitation.usePolicy === "global-window"
      ? invitation.registrations!.filter((item) => item.usedAt > now - invitation.windowMs!)
      : invitation.registrations!;
  if (registrations.length >= invitation.maxUses!) {
    throw new Error(invitation.usePolicy === "global-window" ? "邀请码在当前滚动周期内已达到注册上限" : "邀请码可用次数已用完");
  }
}

function syncWorkerInvitationRemainingUses(invitation: WorkerInvitation): void {
  invitation.remainingUses =
    invitation.usePolicy === "global-total"
      ? Math.max(0, (invitation.maxUses ?? 1) - (invitation.registrations?.length ?? 0))
      : null;
}

function applyWorkerInvitation(user: StoredUser, invitation: WorkerInvitation): void {
  user.inviteCodeUsed = invitation.code;
  user.points = invitation.initialPoints;
  user.title = invitation.initialTitle;
  user.nicknameColor = invitation.initialNicknameColor;
  const now = Date.now();
  applyWorkerInvitationIdentityGrant(user, invitation, "admin", now);
  applyWorkerInvitationIdentityGrant(user, invitation, "advanced", now);
  applyWorkerAdvancedAiGrant(user, invitation.advancedAiDurationMs, invitation.advancedAiExpiresAt, now);
  if (typeof invitation.taxRatePercent === "number") user.taxRatePercent = invitation.taxRatePercent;
  user.updatedAt = now;
}

function applyWorkerInvitationGrantBody(
  invitation: WorkerInvitation,
  kind: "admin" | "advanced",
  durationInput: unknown,
  expiryInput: unknown,
  permanentInput: unknown,
): void {
  const durationKey = kind === "admin" ? "adminDurationMs" : "advancedDurationMs";
  const expiryKey = kind === "admin" ? "adminExpiresAt" : "advancedExpiresAt";
  const permanentKey = kind === "admin" ? "adminPermanent" : "advancedPermanent";
  let duration = invitation[durationKey];
  let expiresAt = invitation[expiryKey];
  let permanent = invitation[permanentKey];

  if (durationInput !== undefined) {
    if (durationInput === false) {
      duration = undefined;
    } else {
      duration = cleanWorkerDuration(durationInput);
      expiresAt = undefined;
      permanent = duration === null;
    }
  }
  if (expiryInput !== undefined && (durationInput === undefined || durationInput === false)) {
    expiresAt = cleanExpiry(expiryInput);
    if (expiresAt) {
      duration = undefined;
      permanent = false;
    } else if (durationInput === false) {
      duration = undefined;
      permanent = false;
    }
  }
  if (permanentInput !== undefined && durationInput === undefined && expiryInput === undefined) {
    permanent = Boolean(permanentInput);
    if (permanent) {
      duration = null;
      expiresAt = undefined;
    } else if (duration === null) {
      duration = undefined;
    }
  }

  invitation[durationKey] = duration;
  invitation[expiryKey] = expiresAt;
  invitation[permanentKey] = permanent;
}

function normalizeWorkerInvitationRoleGrants(invitation: WorkerInvitation): void {
  for (const kind of ["admin", "advanced"] as const) {
    const enabled = workerInvitationRoleIncludes(invitation.role, kind);
    const durationKey = kind === "admin" ? "adminDurationMs" : "advancedDurationMs";
    const expiryKey = kind === "admin" ? "adminExpiresAt" : "advancedExpiresAt";
    const permanentKey = kind === "admin" ? "adminPermanent" : "advancedPermanent";
    if (!enabled) {
      invitation[durationKey] = undefined;
      invitation[expiryKey] = undefined;
      invitation[permanentKey] = false;
    } else if (invitation[durationKey] === undefined && !invitation[expiryKey] && !invitation[permanentKey]) {
      invitation[durationKey] = null;
      invitation[permanentKey] = true;
    }
  }
}

function applyWorkerInvitationIdentityGrant(
  user: StoredUser,
  invitation: WorkerInvitation,
  kind: "admin" | "advanced",
  now: number,
): void {
  const enabled = workerInvitationRoleIncludes(invitation.role, kind);
  const duration = kind === "admin" ? invitation.adminDurationMs : invitation.advancedDurationMs;
  const expiresAt = kind === "admin" ? invitation.adminExpiresAt : invitation.advancedExpiresAt;
  const permanent = kind === "admin" ? invitation.adminPermanent : invitation.advancedPermanent;
  const grantPermanent = enabled && (duration === null || Boolean(permanent) || (duration === undefined && !expiresAt && permanent === undefined));
  const grantExpiry =
    enabled && typeof duration === "number"
      ? new Date(now + duration).toISOString()
      : enabled && !grantPermanent
        ? expiresAt
        : undefined;
  if (kind === "admin") {
    user.adminPermanent = grantPermanent;
    user.adminExpiresAt = grantExpiry;
  } else {
    user.advancedPermanent = grantPermanent;
    user.advancedExpiresAt = grantExpiry;
  }
}

function workerInvitationRoleIncludes(role: UserRole, kind: "admin" | "advanced"): boolean {
  return kind === "admin" ? role === "admin" || role === "admin-advanced" : role === "advanced" || role === "admin-advanced";
}

function ensureSingleSuperAdmin(users: StoredUser[]): void {
  if (users.filter((user) => user.superAdmin).length !== 1) throw new Error("账户状态必须且只能包含一个超级管理员");
}

function upsertWorkerActivation(payload: AdminStatePayload, body: Record<string, unknown>): WorkerActivation {
  const now = Date.now();
  const code = validateCode(String(body.code || randomBytes(8).toString("base64url")));
  const existing = payload.activationCodes.find((item) => item.code === code);
  const existingKind = existing?.kind ?? "standard";
  const requestedKind = body.kind === undefined ? existingKind : String(body.kind);
  if (requestedKind !== "standard" && requestedKind !== "point-distribution") throw new Error("激活码类型无效");
  if (existing && body.kind !== undefined && requestedKind !== existingKind) throw new Error("不能修改激活码类型");
  const activation: WorkerActivation = existing
    ? structuredClone(existing)
    : { code, kind: requestedKind, usePolicy: "global-total", maxUses: 1, points: 0, redemptions: [], createdAt: now, updatedAt: now };
  activation.kind = requestedKind;
  if (body.usePolicy !== undefined) {
    if (!["unlimited", "global-total", "per-user-total", "global-window", "per-user-window"].includes(String(body.usePolicy))) throw new Error("激活码使用策略不正确");
    activation.usePolicy = body.usePolicy as WorkerActivation["usePolicy"];
  }
  if (body.maxUses !== undefined) activation.maxUses = cleanWorkerInteger(body.maxUses, "最多使用次数", 1);
  if (body.distributionMode !== undefined) {
    if (!["random", "equal"].includes(String(body.distributionMode))) throw new Error("积分发放模式无效");
    activation.distributionMode = body.distributionMode as WorkerActivation["distributionMode"];
  }
  if (body.totalPoints !== undefined) activation.totalPoints = cleanWorkerInteger(body.totalPoints, "总积分", 1);
  if (body.windowMs !== undefined) activation.windowMs = body.windowMs === null ? undefined : cleanWorkerInteger(body.windowMs, "滚动周期", 1);
  if (body.expiresAt !== undefined) activation.expiresAt = cleanExpiry(body.expiresAt);
  if (body.points !== undefined) activation.points = cleanWorkerInteger(body.points, "积分");
  if (body.requireNonNegativeBalance !== undefined) activation.requireNonNegativeBalance = Boolean(body.requireNonNegativeBalance);
  if (body.titleMode !== undefined) {
    if (!["default", "fixed", "user-custom"].includes(String(body.titleMode))) throw new Error("激活码头衔模式不正确");
    activation.titleMode = body.titleMode as WorkerActivation["titleMode"];
  }
  if (body.title !== undefined) activation.title = cleanOptional(body.title === null ? null : String(body.title), 24);
  if (body.nicknameColorMode !== undefined) {
    if (!["default", "fixed", "user-custom"].includes(String(body.nicknameColorMode))) throw new Error("激活码昵称颜色模式不正确");
    activation.nicknameColorMode = body.nicknameColorMode as WorkerActivation["nicknameColorMode"];
  }
  if (body.nicknameColor !== undefined) {
    activation.nicknameColor = body.nicknameColor === null ? undefined : validateHexColor(String(body.nicknameColor));
  }
  applyWorkerActivationGrantBody(activation, "admin", body.adminDurationMs, body.adminExpiresAt);
  applyWorkerActivationGrantBody(activation, "advanced", body.advancedDurationMs, body.advancedExpiresAt);
  applyWorkerAdvancedAiGrantBody(activation, body.advancedAiDurationMs, body.advancedAiExpiresAt);
  if (body.taxRatePercent !== undefined) {
    activation.taxRatePercent = body.taxRatePercent === null ? undefined : cleanTaxRatePercent(body.taxRatePercent);
  }
  if (body.reservedRoomCodeMode !== undefined) {
    activation.reservedRoomCodeMode = body.reservedRoomCodeMode === null ? undefined : validateReservedRoomCodeGrantMode(body.reservedRoomCodeMode);
  }
  if (body.permissionDurationMs !== undefined) activation.permissionDurationMs = body.permissionDurationMs === false ? undefined : cleanWorkerDuration(body.permissionDurationMs);
  if (body.permissions !== undefined) activation.permissions = body.permissions === null ? undefined : normalizeWorkerPermissionPatch(body.permissions as Partial<PermissionRule>);
  if (body.customModeLimitDurationMs !== undefined) {
    activation.customModeLimitDurationMs =
      body.customModeLimitDurationMs === false ? undefined : cleanWorkerDuration(body.customModeLimitDurationMs);
  }
  if (body.customModeLimits !== undefined) {
    activation.customModeLimits =
      body.customModeLimits === null ? undefined : normalizeCustomModeLimitGrant(body.customModeLimits as CustomModeLimitGrant);
  }
  if ((activation.usePolicy === "global-window" || activation.usePolicy === "per-user-window") && !activation.windowMs) throw new Error("周期限额激活码必须设置滚动周期");
  if (activation.titleMode === "fixed" && !activation.title) throw new Error("固定头衔不能为空");
  if (activation.titleMode !== "fixed") activation.title = undefined;
  if (activation.nicknameColorMode === "fixed" && !activation.nicknameColor) throw new Error("固定昵称颜色不能为空");
  if (activation.nicknameColorMode !== "fixed") activation.nicknameColor = undefined;
  if (activation.kind === "point-distribution") {
    activation.usePolicy = "global-total";
    activation.distributionMode ??= "random";
    activation.totalPoints ??= activation.maxUses;
    if (activation.maxUses > payload.users.length) throw new Error(`总兑换次数不能超过注册用户总数 ${payload.users.length}`);
    if (activation.totalPoints < activation.maxUses) throw new Error("总积分必须大于或等于总兑换次数");
    if (activation.distributionMode === "equal" && activation.totalPoints % activation.maxUses !== 0) {
      throw new Error("均分模式下总积分必须是总兑换次数的整数倍");
    }
    if (
      existing?.redemptions.length &&
      (activation.maxUses !== existing.maxUses ||
        activation.totalPoints !== existing.totalPoints ||
        activation.distributionMode !== existing.distributionMode)
    ) {
      throw new Error("已有兑换记录的积分发放码不能修改发放规则");
    }
    activation.points = 0;
    activation.requireNonNegativeBalance = undefined;
    activation.titleMode = "default";
    activation.title = undefined;
    activation.nicknameColorMode = "default";
    activation.nicknameColor = undefined;
    activation.adminDurationMs = undefined;
    activation.adminExpiresAt = undefined;
    activation.advancedDurationMs = undefined;
    activation.advancedExpiresAt = undefined;
    activation.advancedAiDurationMs = undefined;
    activation.advancedAiExpiresAt = undefined;
    activation.taxRatePercent = undefined;
    activation.permissionDurationMs = undefined;
    activation.permissions = undefined;
    activation.customModeLimitDurationMs = undefined;
    activation.customModeLimits = undefined;
    activation.reservedRoomCodeMode = undefined;
    activation.windowMs = undefined;
  } else {
    activation.distributionMode = undefined;
    activation.totalPoints = undefined;
  }
  activation.updatedAt = now;
  if (existing) payload.activationCodes[payload.activationCodes.indexOf(existing)] = activation;
  else payload.activationCodes.push(activation);
  return activation;
}

function cleanWorkerDuration(value: unknown): number | null {
  if (value === null) return null;
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration <= 0) throw new Error("授权时长必须是正整数");
  return duration;
}

function cleanWorkerInteger(value: unknown, label: string, minimum = Number.MIN_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${label}必须是${minimum === 1 ? "正" : minimum === 0 ? "非负" : ""}整数`);
  return number;
}

function isUserRole(value: unknown): value is UserRole {
  return ["normal", "advanced", "admin", "admin-advanced", "super-admin"].includes(String(value));
}

function enforceWorkerActivationQuota(activation: WorkerActivation, userId: string, now: number): void {
  if (activation.kind === "point-distribution") {
    if (activation.redemptions.some((item) => item.userId === userId)) throw new Error("每个用户只能兑换一次该积分发放码");
    if (activation.redemptions.length >= activation.maxUses) throw new Error("激活码使用次数已达到上限");
    return;
  }
  if (activation.usePolicy === "unlimited") return;
  const recent = activation.windowMs ? activation.redemptions.filter((item) => item.usedAt > now - activation.windowMs!) : activation.redemptions;
  const count =
    activation.usePolicy === "global-total"
      ? activation.redemptions.length
      : activation.usePolicy === "per-user-total"
        ? activation.redemptions.filter((item) => item.userId === userId).length
        : activation.usePolicy === "global-window"
          ? recent.length
          : recent.filter((item) => item.userId === userId).length;
  if (count >= activation.maxUses) throw new Error("激活码使用次数已达到上限");
}

function workerPointDistributionReward(activation: WorkerActivation): number {
  const totalPoints = activation.totalPoints ?? 0;
  const distributed = activation.redemptions.reduce((sum, redemption) => sum + (redemption.points ?? 0), 0);
  const remainingPoints = totalPoints - distributed;
  const remainingUses = activation.maxUses - activation.redemptions.length;
  if (remainingUses <= 0 || remainingPoints <= 0) throw new Error("积分已发放完毕");
  if (activation.distributionMode === "equal") return totalPoints / activation.maxUses;
  if (remainingUses === 1) return remainingPoints;
  const upper = randomPointRewardUpperBound(remainingPoints, remainingUses);
  return 1 + unbiasedWorkerRandom(upper);
}

function equalWorkerPointGrants(userIds: string[], perUserPoints: number): { userId: string; points: number }[] {
  if (!Number.isInteger(perUserPoints)) throw new Error("每人积分必须是整数");
  return userIds.map((userId) => ({ userId, points: perUserPoints }));
}

function randomWorkerPointGrants(userIds: string[], totalPoints: number): { userId: string; points: number }[] {
  if (!Number.isInteger(totalPoints) || totalPoints < userIds.length) throw new Error("瓜分总积分必须为整数，且不得小于发放人数");
  let remaining = totalPoints;
  const grants: { userId: string; points: number }[] = [];
  for (let index = 0; index < userIds.length; index += 1) {
    const remainingUses = userIds.length - index;
    const points = remainingUses === 1 ? remaining : 1 + unbiasedWorkerRandom(randomPointRewardUpperBound(remaining, remainingUses));
    grants.push({ userId: userIds[index], points });
    remaining -= points;
  }
  return grants;
}

function unbiasedWorkerRandom(maxExclusive: number): number {
  const range = 0x20_0000_0000_0000;
  const limit = Math.floor(range / maxExclusive) * maxExclusive;
  const values = new Uint32Array(2);
  let value = 0;
  do {
    crypto.getRandomValues(values);
    value = (values[0] & 0x1f_ffff) * 0x1_0000_0000 + values[1];
  } while (value >= limit);
  return value % maxExclusive;
}

function applyWorkerActivation(user: StoredUser, activation: WorkerActivation, now = Date.now()): void {
  applyWorkerRoleGrant(user, "admin", activation.adminDurationMs, activation.adminExpiresAt, now);
  applyWorkerRoleGrant(user, "advanced", activation.advancedDurationMs, activation.advancedExpiresAt, now);
  applyWorkerAdvancedAiGrant(user, activation.advancedAiDurationMs, activation.advancedAiExpiresAt, now);
  if (typeof activation.taxRatePercent === "number") user.taxRatePercent = activation.taxRatePercent;
  user.updatedAt = now;
}

function applyWorkerActivationGrantBody(
  activation: WorkerActivation,
  kind: "admin" | "advanced",
  durationInput: unknown,
  expiryInput: unknown,
): void {
  const durationKey = kind === "admin" ? "adminDurationMs" : "advancedDurationMs";
  const expiryKey = kind === "admin" ? "adminExpiresAt" : "advancedExpiresAt";
  if (durationInput !== undefined) {
    activation[durationKey] = durationInput === false ? undefined : cleanWorkerDuration(durationInput);
    if (durationInput !== false) activation[expiryKey] = undefined;
  }
  if (expiryInput !== undefined && (durationInput === undefined || durationInput === false)) {
    activation[expiryKey] = cleanExpiry(expiryInput);
    if (activation[expiryKey]) activation[durationKey] = undefined;
  }
}

function applyWorkerAdvancedAiGrantBody(
  target: { advancedAiDurationMs?: number | null; advancedAiExpiresAt?: string },
  durationInput: unknown,
  expiryInput: unknown,
): void {
  if (durationInput !== undefined) {
    target.advancedAiDurationMs = durationInput === false ? undefined : cleanWorkerDuration(durationInput);
    if (durationInput !== false) target.advancedAiExpiresAt = undefined;
  }
  if (expiryInput !== undefined && (durationInput === undefined || durationInput === false)) {
    target.advancedAiExpiresAt = cleanExpiry(expiryInput);
    if (target.advancedAiExpiresAt) target.advancedAiDurationMs = undefined;
  }
}

function applyWorkerAdvancedAiGrant(
  user: StoredUser,
  duration: number | null | undefined,
  expiresAt: string | undefined,
  now: number,
): void {
  if (duration === undefined && !expiresAt) return;
  if (duration === null) {
    user.advancedAiPermanent = true;
    user.advancedAiExpiresAt = undefined;
    return;
  }
  if (user.superAdmin || user.advancedAiPermanent) return;
  const current = user.advancedAiExpiresAt ? Date.parse(user.advancedAiExpiresAt) : 0;
  const next = expiresAt ? Date.parse(expiresAt) : Math.max(now, current) + duration!;
  if (next > current) user.advancedAiExpiresAt = new Date(next).toISOString();
}

function applyWorkerRoleGrant(
  user: StoredUser,
  kind: "admin" | "advanced",
  duration: number | null | undefined,
  expiresAt: string | undefined,
  now: number,
): void {
  if (duration === undefined && !expiresAt) return;
  if (kind === "admin") {
    if (duration === null) {
      user.adminPermanent = true;
      user.adminExpiresAt = undefined;
      return;
    }
    if (user.adminPermanent) return;
    const current = user.adminExpiresAt ? Date.parse(user.adminExpiresAt) : 0;
    const next = expiresAt ? Date.parse(expiresAt) : Math.max(now, current) + duration!;
    if (next > current) user.adminExpiresAt = new Date(next).toISOString();
    return;
  }
  if (duration === null) {
    user.advancedPermanent = true;
    user.advancedExpiresAt = undefined;
    return;
  }
  if (user.advancedPermanent) return;
  const current = user.advancedExpiresAt ? Date.parse(user.advancedExpiresAt) : 0;
  const next = expiresAt ? Date.parse(expiresAt) : Math.max(now, current) + duration!;
  if (next > current) user.advancedExpiresAt = new Date(next).toISOString();
}

function normalizeWorkerDuelLimit(rule: Partial<DuelLimitRule> | undefined): DuelLimitRule {
  const period = rule?.period ?? "hour";
  if (!["none", "hour", "day", "week", "unlimited"].includes(period)) throw new Error("决斗次数限制不正确");
  if (period === "none") return { period, count: 0 };
  if (period === "unlimited") return { period, count: null };
  const count = Math.max(1, Math.floor(rule?.count ?? 1));
  return { period, count };
}

function duelRecordsFor(raw: number | number[] | undefined): number[] {
  if (Array.isArray(raw)) return raw.filter((item) => Number.isFinite(item) && item > 0).sort((a, b) => a - b).slice(-200);
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? [raw] : [];
}

function normalizeWorkerDuelRecordMap(value: Record<string, number | number[]> | undefined): Record<string, number[]> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([userId, raw]) => {
      const records = duelRecordsFor(raw);
      return records.length ? [[userId, records]] : [];
    }),
  );
}

function pruneWorkerDuelRecords(rule: DuelLimitRule, records: number[], now: number): number[] {
  if (rule.period === "none" || rule.period === "unlimited") return [];
  const windowMs = DUEL_LIMIT_PERIOD_MS[rule.period];
  return records.filter((item) => Number.isFinite(item) && item > now - windowMs).sort((a, b) => a - b).slice(-200);
}

function workerDuelLimitStatus(rule: DuelLimitRule, records: number[], now: number): { allowed: boolean; retryAt?: number } {
  if (rule.period === "unlimited") return { allowed: true };
  if (rule.period === "none" || (rule.count ?? 0) <= 0) return { allowed: false };
  const active = pruneWorkerDuelRecords(rule, records, now);
  if (active.length < (rule.count ?? 1)) return { allowed: true };
  return { allowed: false, retryAt: active[0] + DUEL_LIMIT_PERIOD_MS[rule.period] };
}

function workerPermissionsFor(user: StoredUser, role: UserRole): PermissionRule {
  return workerPermissionsForPayload(memory.adminState, user, role);
}

function workerPermissionsForPayload(payload: AdminStatePayload, user: StoredUser, role = roleFor(user)): PermissionRule {
  const override = payload.userPermissions[user.id];
  const active = override && (override.permanent || !override.expiresAt || Date.parse(override.expiresAt) > Date.now()) ? override.permissions : {};
  return normalizeWorkerPermission({ ...payload.rolePermissions[role], ...active });
}

function workerCustomModeLimitsForPayload(payload: AdminStatePayload, user: StoredUser): CustomModeLimits {
  const override = payload.userCustomModeLimits[user.id];
  const active = override && (override.permanent || !override.expiresAt || Date.parse(override.expiresAt) > Date.now()) ? override.limits : {};
  const globalLimits: CustomModeLimits = {
    maxBaseBet:
      payload.customModeLimits.maxBaseBet.mode === "classic-multiple"
        ? (() => {
            const value = resolveCustomMaxBaseBet(payload.customModeLimits.maxBaseBet, payload.rolePermissions.normal.maxBaseBet);
            return value === null ? ({ mode: "unlimited" } as const) : ({ mode: "absolute", value } as const);
          })()
        : payload.customModeLimits.maxBaseBet,
    settlementCap: payload.customModeLimits.settlementCap,
  };
  return normalizeCustomModeLimits(active, globalLimits);
}

function legacyWorkerCustomModeGrant(value: {
  customModeLimits?: CustomModeLimitGrant;
  permissions?: (Partial<PermissionRule> & LegacyCustomPermissionFields) | undefined;
}): CustomModeLimitGrant | undefined {
  const direct = normalizeCustomModeLimitGrant(value.customModeLimits);
  const legacy = normalizeCustomModeLimitGrant({
    maxBaseBet: value.permissions?.customMaxBaseBet,
    settlementCap: value.permissions?.customSettlementCap,
  });
  const merged = { ...legacy, ...direct };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function workerCustomPresetProvider(
  payload: AdminStatePayload,
  candidate?: { id: string; source: string | CustomRulesSource; revision: number },
): CustomPresetProvider {
  return {
    get: (presetId: string) => {
      if (candidate?.id === presetId) return { source: candidate.source, revision: candidate.revision };
      const preset = payload.customRulesPresets.find((item) => item.id === presetId);
      return preset ? { source: preset.sourceDocument as string | CustomRulesSource, revision: preset.revision } : undefined;
    },
  };
}

function resolveWorkerCustomRulesDocument(
  payload: AdminStatePayload,
  sourceDocument: unknown,
  candidate?: { id: string; source: string | CustomRulesSource; revision: number },
): { rules: ResolvedCustomRules; hash: string } {
  const rules = parseCustomRules(sourceDocument, { presets: workerCustomPresetProvider(payload, candidate) });
  return { rules, hash: canonicalCustomRulesHash(rules) };
}

function workerPresetMeta(preset: WorkerCustomRulesPreset): Pick<WorkerCustomRulesPreset, "id" | "displayName" | "enabled" | "updatedAt"> {
  return { id: preset.id, displayName: preset.displayName, enabled: preset.enabled, updatedAt: preset.updatedAt };
}

function workerPresetAdminView(preset: WorkerCustomRulesPreset): Pick<WorkerCustomRulesPreset, "id" | "displayName" | "sourceDocument" | "enabled" | "createdAt" | "updatedAt"> {
  return { ...workerPresetMeta(preset), sourceDocument: structuredClone(preset.sourceDocument), createdAt: preset.createdAt };
}

function workerPresetMutationResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("preset" in result)) return result;
  const preset = (result as { preset?: unknown }).preset;
  return preset && typeof preset === "object"
    ? { preset: workerPresetAdminView(preset as WorkerCustomRulesPreset) }
    : result;
}

function cleanWorkerPresetDisplayName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 40) throw new Error("预设名称必须是 1-40 个字符");
  return name;
}

function mustWorkerPresetAdmin(payload: AdminStatePayload, actorUserId: unknown): StoredUser {
  const actor = payload.users.find((user) => user.id === String(actorUserId ?? ""));
  if (!actor?.superAdmin) throw new Error("只有超级管理员可以管理自定义预设");
  return actor;
}

function buildWorkerPresetEntry(
  payload: AdminStatePayload,
  actorId: string,
  displayName: unknown,
  sourceDocument: unknown,
  existing?: WorkerCustomRulesPreset,
): WorkerCustomRulesPreset {
  const revision = existing ? existing.revision + 1 : 1;
  const candidate = existing
    ? { id: existing.id, source: sourceDocument as string | CustomRulesSource, revision }
    : undefined;
  const { rules, hash } = resolveWorkerCustomRulesDocument(payload, sourceDocument, candidate);
  const now = Date.now();
  return {
    id: existing?.id ?? uid("crp"),
    displayName: cleanWorkerPresetDisplayName(displayName),
    sourceDocument: structuredClone(sourceDocument),
    resolvedRules: rules,
    resolvedHash: hash,
    revision,
    enabled: existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    updatedBy: actorId,
  };
}

function normalizeWorkerPermission(rule: Partial<PermissionRule>): PermissionRule {
  const exchangeMin = Math.max(0, Math.floor(rule.exchangeMin ?? 0));
  const exchangeMax = rule.exchangeMax === null ? null : Math.max(exchangeMin, Math.floor(rule.exchangeMax ?? 3));
  return {
    exchangeMin,
    exchangeMax,
    canCreateZeroBaseBet: Boolean(rule.canCreateZeroBaseBet),
    maxBaseBet: rule.maxBaseBet === null ? null : Math.max(0, Math.floor(rule.maxBaseBet ?? 100)),
    duelLimit: normalizeWorkerDuelLimit(rule.duelLimit),
  };
}

function normalizeWorkerPermissionPatch(rule: Partial<PermissionRule>): Partial<PermissionRule> {
  const result: Partial<PermissionRule> = {};
  if (rule.exchangeMin !== undefined) result.exchangeMin = Math.max(0, Math.floor(rule.exchangeMin));
  if (rule.exchangeMax !== undefined) result.exchangeMax = rule.exchangeMax === null ? null : Math.max(0, Math.floor(rule.exchangeMax));
  if (rule.canCreateZeroBaseBet !== undefined) result.canCreateZeroBaseBet = Boolean(rule.canCreateZeroBaseBet);
  if (rule.maxBaseBet !== undefined) result.maxBaseBet = rule.maxBaseBet === null ? null : Math.max(0, Math.floor(rule.maxBaseBet));
  if (rule.duelLimit !== undefined) result.duelLimit = normalizeWorkerDuelLimit(rule.duelLimit);
  return result;
}

function validateCode(value: string): string {
  const clean = value.trim();
  assertSpreadsheetSafeText(clean, "代码");
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(clean)) throw new Error("代码只能包含 3-32 位字母、数字、下划线或短横线");
  return clean;
}

function defaultRolePermissions(): Record<UserRole, PermissionRule> {
  const defaultDuelLimit = (): DuelLimitRule => ({ period: "hour", count: 1 });
  return {
    normal: { exchangeMin: 0, exchangeMax: 3, canCreateZeroBaseBet: false, maxBaseBet: 100, duelLimit: defaultDuelLimit() },
    advanced: { exchangeMin: 0, exchangeMax: 3, canCreateZeroBaseBet: true, maxBaseBet: 100, duelLimit: defaultDuelLimit() },
    admin: { exchangeMin: 0, exchangeMax: 3, canCreateZeroBaseBet: false, maxBaseBet: 100, duelLimit: defaultDuelLimit() },
    "admin-advanced": { exchangeMin: 0, exchangeMax: 3, canCreateZeroBaseBet: true, maxBaseBet: 100, duelLimit: defaultDuelLimit() },
    "super-admin": { exchangeMin: 0, exchangeMax: 3, canCreateZeroBaseBet: true, maxBaseBet: null, duelLimit: defaultDuelLimit() },
  };
}

function tokenFromRequest(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  return /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1];
}

function mustLogin(user: StoredUser | undefined): asserts user is StoredUser {
  if (!user) throw new Error("请先登录");
}

function readJson(request: Request): Promise<Record<string, unknown>> {
  return request.json().catch(() => ({}));
}

function isWebSocketUpgradeRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function encrypt(env: Env, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

function decrypt(env: Env, value: string): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) return "未知用户";
  try {
    return decryptWorkerUsername(value, encKey(env));
  } catch {
    const previous = previousWorkerEncKey(env);
    if (previous) return decryptWorkerUsername(value, previous);
    throw new Error("无法解密账户用户名；请检查 AUTH_SECRET 或配置 AUTH_SECRET_PREVIOUS 完成密钥轮换");
  }
}

function decryptWorkerUsername(value: string, key: Buffer): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error("用户名密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8");
}

function lookup(env: Env, username: string): string {
  return createHmac("sha256", hmacKey(env)).update(username.trim().toLocaleLowerCase("zh-Hans-CN")).digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("base64url")}`;
}

function verifyPassword(password: string, hash: string): boolean {
  const [kind, salt, expectedRaw] = hash.split(":");
  if (kind !== "scrypt" || !salt || !expectedRaw) return false;
  const expected = Buffer.from(expectedRaw, "base64url");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function encKey(env: Env): Buffer {
  return createHash("sha256").update(`${requireWorkerAuthSecret(env)}:username-encryption`).digest();
}

function hmacKey(env: Env): Buffer {
  return createHash("sha256").update(`${requireWorkerAuthSecret(env)}:username-lookup`).digest();
}

function previousWorkerEncKey(env: Env): Buffer | undefined {
  const current = env.AUTH_SECRET;
  const previous = env.AUTH_SECRET_PREVIOUS;
  if (!previous || previous === current) return undefined;
  // Historical Worker deployments used a short built-in fallback when
  // AUTH_SECRET was omitted. Keep the current key strict, but allow a
  // deliberately supplied previous key of any non-empty length so those
  // accounts can be migrated once and the previous secret can then be
  // removed.
  return createHash("sha256")
    .update(`${previous}:username-encryption`)
    .digest();
}

function requireWorkerAuthSecret(env: Env): string {
  return requireWorkerSecretValue(env.AUTH_SECRET, "AUTH_SECRET");
}

function requireWorkerSecretValue(value: string | undefined, name: string): string {
  if (!value || value.length < 32) throw new Error(`${name} 必须通过部署密钥提供，且至少包含 32 个字符`);
  return value;
}

function migrateWorkerUserSecrets(payload: AdminStatePayload, env: Env): boolean {
  const previous = previousWorkerEncKey(env);
  if (!previous || !env.AUTH_SECRET) return false;
  let changed = false;
  for (const user of payload.users) {
    if (!user.usernameEncrypted.startsWith("v1:")) continue;
    try {
      decryptWorkerUsername(user.usernameEncrypted, encKey(env));
      continue;
    } catch {
      const username = decryptWorkerUsername(user.usernameEncrypted, previous);
      user.usernameEncrypted = encrypt(env, username);
      user.usernameLookup = lookup(env, username);
      user.updatedAt = Date.now();
      changed = true;
    }
  }
  return changed;
}

function bootstrapWorkerSuperAdmin(env: Env): StoredUser[] {
  const username = validateUsername(env.BOOTSTRAP_SUPER_ADMIN_USERNAME ?? DEFAULT_SUPER_USERNAME);
  const password = env.BOOTSTRAP_SUPER_ADMIN_PASSWORD ?? DEFAULT_SUPER_PASSWORD;
  const usesPublishedDefault = username === DEFAULT_SUPER_USERNAME && password === DEFAULT_SUPER_PASSWORD;
  if (!usesPublishedDefault) {
    if (password.length < 12) throw new Error("自定义初始超级管理员密码至少需要 12 个字符");
    validatePassword(password);
  } else {
    console.warn("[security] 正在使用默认初始管理员 admin/admin；请在对外开放服务前立即修改密码");
  }
  const now = Date.now();
  return [
    {
      id: "u_initial_super_admin",
      usernameEncrypted: encrypt(env, username),
      usernameLookup: lookup(env, username),
      passwordHash: hashPassword(password),
      sessionVersion: 0,
      nickname: username,
      points: 0,
      disabledPermanent: false,
      nicknameChangeDisabled: false,
      superAdmin: true,
      adminPermanent: false,
      advancedPermanent: false,
      gamesPlayed: 0,
      gamesWon: 0,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function workerRegistrationHash(env: Env, kind: "device" | "browser", value: string): string {
  return createHmac("sha256", hmacKey(env)).update(`registration:${kind}:${value}`).digest("hex");
}

function enforceWorkerRegistrationRateLimit(request: Request): void {
  const now = Date.now();
  const subject = request.headers.get("cf-connecting-ip")?.trim() || "network:unknown";
  const existing = workerRegistrationAttempts.get(subject);
  if (!existing || existing.resetsAt <= now) {
    workerRegistrationAttempts.set(subject, { count: 1, resetsAt: now + REGISTRATION_RATE_WINDOW_MS });
  } else {
    existing.count += 1;
    if (existing.count > REGISTRATION_RATE_LIMIT) throw new Error("注册请求过于频繁，请稍后重试");
  }
  if (workerRegistrationAttempts.size > 4_096) {
    for (const [key, bucket] of workerRegistrationAttempts) {
      if (bucket.resetsAt <= now) workerRegistrationAttempts.delete(key);
    }
  }
}

async function auditWorkerRequest(
  env: Env,
  request: Request,
  actor: StoredUser | undefined,
  category: WorkerSecurityEvent["category"],
  operation: string,
  details: Record<string, unknown>,
): Promise<void> {
  const trustedIp = String(request.headers.get("cf-connecting-ip") ?? "").trim().slice(0, 160);
  await auditWorkerSecurity(env, actor, category, operation, details, {
    method: request.method,
    route: new URL(request.url).pathname,
    ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? undefined,
    userAgent: request.headers.get("user-agent") ?? undefined,
    anonymousSubject: trustedIp
      ? `network:${createHmac("sha256", hmacKey(env)).update(`audit:${trustedIp}`).digest("hex")}`
      : "network:anonymous",
  });
}

async function auditWorkerSecurity(
  env: Env,
  actor: StoredUser | undefined,
  category: WorkerSecurityEvent["category"],
  operation: string,
  details: Record<string, unknown>,
  context: {
    method?: string;
    route?: string;
    ip?: string;
    userAgent?: string;
    anonymousSubject?: string;
  } = {},
): Promise<void> {
  try {
    await adminStateMutation(env, "/security/record", {
      actorUserId: actor?.id,
      subjectKey: actor ? `user:${actor.id}` : context.anonymousSubject ?? "network:anonymous",
      category,
      operation,
      method: context.method ?? "POST",
      route: context.route ?? "/api/rooms",
      ip: context.ip,
      userAgent: context.userAgent,
      details,
    });
    await hydrateAdminState(env);
  } catch (error) {
    console.warn("[security-audit]", error instanceof Error ? error.message : error);
  }
}

function isDefiniteWorkerProtectedAccountMutation(
  env: Env,
  actor: StoredUser,
  body: Record<string, unknown> | undefined,
): boolean {
  const role = publicUser(env, actor).role;
  if (role === "super-admin" || role === "admin" || role === "admin-advanced" || !body) return false;
  const fields = new Set([
    "points",
    "title",
    "nicknameColor",
    "permissions",
    "advancedAiAccess",
    "advancedAiPermanent",
    "advancedAiExpiresAt",
    "taxRatePercent",
    "adminPermanent",
    "advancedPermanent",
    "adminExpiresAt",
    "advancedExpiresAt",
    "gamesPlayed",
    "gamesWon",
  ]);
  return Object.keys(body).some((key) => fields.has(key));
}

function finalizeWorkerSecurityIncidents(payload: AdminStatePayload, now: number): boolean {
  let changed = false;
  const fallbackUser = payload.users.find((user) => user.superAdmin);
  for (const incident of payload.securityIncidents) {
    if (incident.reportedAt || incident.endsAt > now || incident.events.length === 0) continue;
    const request: WorkerRequest = {
      id: uid("req"),
      kind: "security",
      fromUserId: incident.actorUserId ?? fallbackUser?.id ?? "system",
      text: `安全审计：2 小时内记录 ${incident.events.length} 次明确非法请求${incident.suppressedEvents ? `，另有 ${incident.suppressedEvents} 次被折叠` : ""}`,
      privateToSuperAdmin: true,
      status: "open",
      securityLogId: incident.id,
      securitySubject: incident.subjectKey,
      createdAt: nextWorkerRequestActivityAt(payload.requests),
    };
    incident.reportedAt = now;
    incident.requestId = request.id;
    payload.requests.push(request);
    changed = true;
  }
  return changed;
}

function trimWorkerSecurityIncidents(payload: AdminStatePayload): void {
  payload.securityIncidents = payload.securityIncidents.slice(-MAX_SECURITY_INCIDENTS);
  let eventCount = payload.securityIncidents.reduce((sum, incident) => sum + incident.events.length, 0);
  while (eventCount > MAX_SECURITY_EVENTS_TOTAL && payload.securityIncidents.length > 0) {
    const oldest = payload.securityIncidents[0];
    if (oldest.events.length > 1) {
      oldest.events.shift();
      eventCount -= 1;
    } else {
      eventCount -= oldest.events.length;
      payload.securityIncidents.shift();
    }
  }
  while (
    payload.securityIncidents.length > 0 &&
    new TextEncoder().encode(JSON.stringify(payload.securityIncidents)).byteLength > MAX_SECURITY_STORAGE_BYTES
  ) {
    const oldest = payload.securityIncidents[0];
    if (oldest.events.length > 1) oldest.events.shift();
    else payload.securityIncidents.shift();
  }
}

function validateWorkerSecurityCategory(value: unknown): WorkerSecurityEvent["category"] {
  const clean = String(value ?? "");
  if (!["unauthorized-read", "unauthorized-operation", "forged-action", "protected-mutation"].includes(clean)) {
    throw new Error("安全事件分类无效");
  }
  return clean as WorkerSecurityEvent["category"];
}

function cleanRequiredWorkerText(value: unknown, maximum: number): string {
  const clean = String(value ?? "").trim();
  if (!clean) throw new Error("安全事件字段不能为空");
  return clean.slice(0, maximum);
}

function sanitizeWorkerAuditDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const clean = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/password|token|authorization|cookie|dataurl/i.test(key))
      .slice(0, 40)
      .map(([key, item]) => [key, sanitizeWorkerAuditValue(item, 0)]),
  );
  const serialized = JSON.stringify(clean);
  return serialized.length <= 8_000 ? clean : { truncated: serialized.slice(0, 7_900) };
}

function sanitizeWorkerAuditValue(value: unknown, depth: number): unknown {
  if (depth > 3) return "[depth-limited]";
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeWorkerAuditValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/password|token|authorization|cookie|dataurl/i.test(key))
        .slice(0, 40)
        .map(([key, item]) => [key, sanitizeWorkerAuditValue(item, depth + 1)]),
    );
  }
  return String(value).slice(0, 200);
}

function workerSecurityLog(incident: WorkerSecurityIncident): string {
  const header = {
    logVersion: 1,
    incidentId: incident.id,
    subjectKey: incident.subjectKey,
    actorUserId: incident.actorUserId,
    captureStartedAt: new Date(incident.startedAt).toISOString(),
    captureEndedAt: new Date(incident.endsAt).toISOString(),
    reportedAt: incident.reportedAt ? new Date(incident.reportedAt).toISOString() : undefined,
    eventCount: incident.events.length,
    suppressedEvents: incident.suppressedEvents ?? 0,
  };
  return [JSON.stringify(header), ...incident.events.map((event) => JSON.stringify(event))].join("\n");
}

function safeWorkerFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "log";
}

function hashMusicDataUrl(dataUrl: string): { sha1: string; sha256: string } {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("音乐文件无效");
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const bytes = meta.includes(";base64") ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  return hashMusicBytes(bytes);
}

function hashMusicBytes(bytes: Uint8Array): { sha1: string; sha256: string } {
  return {
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}
