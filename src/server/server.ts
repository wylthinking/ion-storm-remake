import express from "express";
import { createServer as createHttpServer } from "node:http";
import type { Request } from "express";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import { containsProtectedGameMutation, isStrictActionIntent } from "../shared/action-security.js";
import { ensureBankerPlayerId, nextBankerPlayerId } from "../shared/banker.js";
import { calculateWinnerTax, winnerGrossPoints, winnerPreTaxPoints } from "../shared/tax.js";
import { AUTOMATED_ACTION_DELAY_MS, OPENING_EXCHANGE_MS, autoplay, currentPlayer, finishOpeningExchange, maxInitialHandSize } from "../shared/engine.js";
import { checkCustomRoomConfigAgainstPermissions, checkRoomConfigAgainstPermissions, cleanCustomInitialHandSize, cleanCustomRoomBaseBet, cleanRoomBaseBet, cleanRoomTimeLimitSec } from "../shared/room-limits.js";
import { applyRulesetAction, advanceRulesetOpeningTimeout, createRulesetGame, publicRulesetGame, randomRulesetTimeoutAction, rulesetCurrentPlayer, rulesetOfflineFallbackAction } from "../shared/ruleset.js";
import { parseCustomRules } from "../shared/custom-rules-parser.js";
import type { ResolvedCustomRules } from "../shared/custom-rules-types.js";
import { CUSTOM_LIMITS, canonicalCustomRulesHash, customRulesSourceForRoom, requiredPlayersFromDeal } from "../shared/custom-rules-types.js";
import { resolveCustomMaxBaseBet, resolveCustomSettlementCap, setupPlayersRange } from "../shared/custom-limits.js";
import { calculateCustomSettlement } from "../shared/custom-settlement.js";
import { PLATFORM_PRESET } from "../shared/generated/custom-json.generated.js";
import { decodeStaticRequestPath, isProtectedAdvancedAiAssetPath, safeCookieValue } from "../shared/http-security.js";
import { isCustomGame, normalizeRulesetMode } from "../shared/types.js";
import type { AnyActionIntent, PlayerState, RoomCode } from "../shared/types.js";
import { RoomStore, type Room, type RoomEditNotice, type RoomPlayer } from "./store.js";
import { UserStore, type StoredUser } from "./users.js";

type ClientMessage =
  | { type: "joinRoom"; code: RoomCode; nickname?: string; playerId?: string; token?: string }
  | { type: "startGame"; code: RoomCode; playerId: string; customRulesHashReady?: string }
  | { type: "submitAction"; code: RoomCode; playerId: string; action: AnyActionIntent }
  | { type: "cancelAutoplay"; code: RoomCode; playerId: string }
  | { type: "refreshState"; code: RoomCode; playerId: string; requestId: string }
  | { type: "gameStartedAck"; code: RoomCode; playerId: string; gameId: string }
  | { type: "botAction"; code: RoomCode; ownerId: string; botId: string; action: AnyActionIntent }
  | { type: "addBot"; code: RoomCode; ownerId: string; nickname?: string }
  | { type: "kickPlayer"; code: RoomCode; playerId: string; targetId: string }
  | { type: "editRoom"; code: RoomCode; playerId: string; capacity: number; baseBet: number; initialHandSize?: number | null; turnTimeLimitSec?: number | null; openingExchangeSec?: number | null; customRules?: unknown }
  | { type: "leaveRoom"; code: RoomCode; playerId: string }
  | { type: "heartbeat"; code: RoomCode; playerId: string }
  | { type: "leaveSeat"; code: RoomCode; playerId: string };

interface SocketMeta {
  code?: RoomCode;
  playerId?: string;
}

const app = express();
const httpServer = createHttpServer(app);
const MAX_WEBSOCKET_PAYLOAD_BYTES = 64 * 1024;
const WEBSOCKET_JOIN_TIMEOUT_MS = 10_000;
const MAX_PENDING_WEBSOCKETS = 64;
const MAX_WEBSOCKETS = 1_024;
const wss = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });
const store = new RoomStore();
const users = new UserStore({ reservedRoomCodeIsOccupied: async (code) => Boolean(await store.get(code)) });
const sockets = new Map<WebSocket, SocketMeta>();
const socketJoinTimers = new Map<WebSocket, NodeJS.Timeout>();
const timers = new Map<RoomCode, NodeJS.Timeout>();
const offlineTimers = new Map<string, NodeJS.Timeout>();
const PRESENCE_OFFLINE_MS = 30_000;
const DEFAULT_BASE_BET = 5;
const REGISTRATION_RATE_WINDOW_MS = 60_000;
const REGISTRATION_RATE_LIMIT = 8;
const registrationAttempts = new Map<string, { count: number; resetsAt: number }>();
const defaultJsonParser = express.json();
const customRulesJsonParser = express.json({ limit: CUSTOM_LIMITS.maxDocumentBytes + 128 * 1024 });
const winMusicJsonParser = express.json({ limit: 14 * 1024 * 1024 });

app.use((req, res, next) => {
  if (req.method === "POST" && /^\/api\/users\/[^/]+\/music$/.test(req.path)) {
    return winMusicJsonParser(req, res, next);
  }
  if (
    req.method === "POST" &&
    (/^\/api\/custom-presets(?:\/preview|\/[^/]+)?$/.test(req.path) || /^\/api\/rooms(?:\/[^/]+\/edit)?$/.test(req.path))
  ) {
    return customRulesJsonParser(req, res, next);
  }
  return defaultJsonParser(req, res, next);
});

app.post("/api/auth/register", async (req, res) => {
  try {
    enforceRegistrationRateLimit(req);
    const actor = await authFromRequest(req);
    if (actor) {
      await auditRequest(req, actor, "unauthorized-operation", "logged-in-registration", {});
      return res.status(409).json({ error: "已登录状态下不能注册新账号" });
    }
    const result = await users.register(
      String(req.body?.username ?? ""),
      String(req.body?.password ?? ""),
      String(req.body?.nickname ?? req.body?.username ?? ""),
      optionalString(req.body?.inviteCode),
      {
        deviceId: String(req.headers["x-ion-device-id"] ?? ""),
        browserFingerprint: String(req.headers["x-ion-browser-fingerprint"] ?? ""),
      },
      optionalString(req.body?.reservedRoomCode),
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "注册失败" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const result = await users.login(String(req.body?.username ?? ""), String(req.body?.password ?? ""));
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "登录失败" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  users.logout(tokenFromRequest(req) ?? "");
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const user = await authFromRequest(req);
  res.json({ user: user ? users.publicFor(user, true, user) : undefined });
});

app.post("/api/advanced-ai/access", async (req, res) => {
  const actor = await authFromRequest(req);
  if (!actor || !users.canUseAdvancedAi(actor)) {
    await auditRequest(req, actor, "unauthorized-operation", "advanced-ai-access", {});
    return res.status(404).json({ error: "请求的资源不存在" });
  }
  res.setHeader("set-cookie", `ion_ai_access=${encodeURIComponent(tokenFromRequest(req) ?? "")}; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`);
  res.json({ allowed: true });
});

app.get("/api/security-logs/:id", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const log = users.securityLog(actor, req.params.id);
    res
      .status(200)
      .setHeader("content-type", "application/x-ndjson; charset=utf-8")
      .setHeader("content-disposition", `attachment; filename="security-${safeFilePart(req.params.id)}.ndjson"`)
      .send(log);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "日志不存在" });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    res.json({ users: users.listUsers(actor), selfId: actor.id });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载用户失败" });
  }
});

app.post("/api/users/points/bulk", async (req, res) => {
  try {
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    res.json(await users.bulkGrantPoints(actor, req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "一键发放积分失败" });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    const actor = await requireActor(req);
    res.json(users.leaderboard(actor));
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : "请先登录" });
  }
});

app.get("/api/music/manifest", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 10);
    res.json({ music: users.winMusicManifest(actor, ids) });
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : "请先登录" });
  }
});

app.get("/api/users.csv", async (req, res) => {
  try {
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const csv = users.exportUsersCsv(actor);
    res
      .status(200)
      .setHeader("content-type", "text/csv; charset=utf-8")
      .setHeader("content-disposition", 'attachment; filename="ion-storm-users.csv"')
      .send(`\uFEFF${csv}`);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "导出失败" });
  }
});

app.patch("/api/users/:id", async (req, res) => {
  try {
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    if (isDefiniteProtectedAccountMutation(actor, req.body)) {
      await auditRequest(req, actor, "protected-mutation", "account-readonly-field-mutation", {
        targetUserId: req.params.id,
        fields: Object.keys(req.body ?? {}),
      });
    }
    const user = await users.updateUser(actor, req.params.id, req.body ?? {});
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "保存失败" });
  }
});

app.delete("/api/users/:id", async (req, res) => {
  try {
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    await users.deleteUser(actor, req.params.id, String(req.body?.currentPassword ?? ""));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除失败" });
  }
});

app.get("/api/users/:id/reserved-room-codes", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const target = users.userById(req.params.id);
    if (!target) return res.status(404).json({ error: "用户不存在" });
    if (!users.canViewReservedRoomCodes(actor, target)) {
      return res.status(403).json({ error: "没有权限查看该用户的专属房间号" });
    }
    res.json({ reservedRoomCodes: [...(target.reservedRoomCodes ?? [])] });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载专属房间号失败" });
  }
});

app.post("/api/users/:id/reserved-room-codes", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const code = String(req.body?.code ?? "").trim();
    if (await store.get(code)) return res.status(400).json({ error: "该专属房间号已被现有房间占用" });
    const reservedRoomCodes = await users.addReservedRoomCode(actor, req.params.id, code);
    res.json({ reservedRoomCodes });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "添加专属房间号失败" });
  }
});

app.patch("/api/users/:id/reserved-room-codes/:code", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const nextCode = String(req.body?.code ?? "").trim();
    if (nextCode !== req.params.code && await store.get(nextCode)) return res.status(400).json({ error: "该专属房间号已被现有房间占用" });
    const reservedRoomCodes = await users.replaceReservedRoomCode(actor, req.params.id, req.params.code, nextCode);
    res.json({ reservedRoomCodes });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "修改专属房间号失败" });
  }
});

app.delete("/api/users/:id/reserved-room-codes/:code", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const reservedRoomCodes = await users.deleteReservedRoomCode(actor, req.params.id, req.params.code);
    res.json({ reservedRoomCodes });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除专属房间号失败" });
  }
});

app.get("/api/invitations", async (req, res) => {
  try {
    const actor = await requireActor(req);
    res.json({ invitations: users.listInvitations(actor) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载失败" });
  }
});

app.post("/api/invitations", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const invitation = await users.upsertInvitation(actor, req.body ?? {});
    res.json({ invitation });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "保存失败" });
  }
});

app.delete("/api/invitations/:code", async (req, res) => {
  try {
    const actor = await requireActor(req);
    await users.deleteInvitation(actor, req.params.code);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除失败" });
  }
});

app.get("/api/activations", async (req, res) => {
  try {
    const actor = await requireActor(req);
    res.json({ activations: users.listActivationCodes(actor), registeredUserCount: users.listUsers(actor).length });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载失败" });
  }
});

app.post("/api/activations", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const activation = await users.upsertActivationCode(actor, req.body ?? {});
    res.json({ activation });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "保存失败" });
  }
});

app.delete("/api/activations/:code", async (req, res) => {
  try {
    const actor = await requireActor(req);
    await users.deleteActivationCode(actor, req.params.code);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除失败" });
  }
});

app.post("/api/activations/redeem/prepare", async (req, res) => {
  try {
    const actor = await requireActor(req);
    res.json(users.prepareActivationCode(actor, String(req.body?.code ?? "")));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "激活码校验失败" });
  }
});

app.post("/api/activations/redeem", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const user = await users.redeemActivationCode(
      actor,
      String(req.body?.code ?? ""),
      optionalString(req.body?.customTitle),
      optionalString(req.body?.customNicknameColor),
      optionalString(req.body?.reservedRoomCode),
    );
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "兑换失败" });
  }
});

app.get("/api/permissions", async (req, res) => {
  try {
    const actor = await requireActor(req);
    res.json(users.getPermissions(actor));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载失败" });
  }
});

app.patch("/api/permissions", async (req, res) => {
  try {
    const actor = await requireActor(req);
    await users.updatePermissions(actor, req.body ?? {});
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "保存失败" });
  }
});

app.get("/api/custom-mode-limits", async (req, res) => {
  try {
    const actor = await requireActor(req);
    res.json(users.getCustomModeLimits(actor));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载自定义模式设置失败" });
  }
});

app.patch("/api/custom-mode-limits", async (req, res) => {
  try {
    const actor = await requireActor(req);
    await users.updateCustomModeLimits(actor, req.body ?? {});
    res.json(users.getCustomModeLimits(actor));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "保存自定义模式设置失败" });
  }
});

app.get("/api/tax-settings", async (req, res) => {
  try {
    const actor = await requireActor(req);
    res.json(users.getTaxSettings(actor));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载税收设置失败" });
  }
});

app.get("/api/custom-presets", async (req, res) => {
  try {
    const actor = await requireActor(req);
    res.json({ presets: users.listCustomRulesPresets(actor).map((preset) => users.customRulesPresetAdminView(preset)) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载预设失败" });
  }
});

app.get("/api/custom-presets/enabled", async (req, res) => {
  try {
    await requireActor(req);
    res.json({ presets: users.listEnabledCustomRulesPresets() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载预设失败" });
  }
});

app.get("/api/custom-presets/enabled/:id", async (req, res) => {
  try {
    await requireActor(req);
    const preset = users.enabledCustomPreset(req.params.id);
    if (!preset) return res.status(404).json({ error: "所选自定义预设不存在或已停用" });
    res.json({ id: preset.id, rules: preset.resolvedRules });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载预设规则失败" });
  }
});

app.post("/api/custom-presets/preview", async (req, res) => {
  try {
    const actor = await requireActor(req);
    res.json(users.previewCustomRulesPreset(actor, req.body?.sourceDocument));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "规则解析失败" });
  }
});

app.post("/api/custom-presets", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const preset = await users.createCustomRulesPreset(actor, req.body ?? {});
    res.json({ preset: users.customRulesPresetAdminView(preset) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "保存预设失败" });
  }
});

app.post("/api/custom-presets/:id", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const preset = await users.updateCustomRulesPreset(actor, req.params.id, req.body ?? {});
    res.json({ preset: users.customRulesPresetAdminView(preset) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "保存预设失败" });
  }
});

app.post("/api/custom-presets/:id/duplicate", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const preset = await users.duplicateCustomRulesPreset(actor, req.params.id);
    res.json({ preset: users.customRulesPresetAdminView(preset) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "复制预设失败" });
  }
});

app.delete("/api/custom-presets/:id", async (req, res) => {
  try {
    const actor = await requireActor(req);
    await users.deleteCustomRulesPreset(actor, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除预设失败" });
  }
});

app.patch("/api/tax-settings", async (req, res) => {
  try {
    const actor = await requireActor(req);
    await users.updateTaxSettings(actor, req.body ?? {});
    res.json(users.getTaxSettings(actor));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "保存税收设置失败" });
  }
});

app.get("/api/requests", async (req, res) => {
  try {
    const actor = await requireActor(req);
    res.json({ requests: users.listRequests(actor), seenThrough: users.requestSeenThrough(actor) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载失败" });
  }
});

app.post("/api/requests/ack", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const seenThrough = await users.acknowledgeRequests(actor, Number(req.body?.through));
    res.json({ seenThrough });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "更新提醒状态失败" });
  }
});

app.post("/api/requests", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const request = await users.createRequest(actor, req.body ?? {});
    res.json({ request });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "提交失败" });
  }
});

app.post("/api/requests/:id/respond", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const request = await users.respondRequest(actor, req.params.id, req.body ?? {});
    res.json({ request });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "处理失败" });
  }
});

app.post("/api/users/:id/music", async (req, res) => {
  try {
    const actor = await requireActor(req);
    const dataUrl = String(req.body?.dataUrl ?? "");
    await users.setWinMusic(
      actor,
      req.params.id,
      {
        fileName: String(req.body?.fileName ?? "win-music"),
        mimeType: "application/octet-stream",
        size: 0,
        uploadedAt: Date.now(),
        dataUrl,
      },
      String(req.body?.currentPassword ?? ""),
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "上传失败" });
  }
});

app.delete("/api/users/:id/music", async (req, res) => {
  try {
    const actor = await requireActor(req);
    await users.deleteWinMusic(actor, req.params.id, String(req.body?.currentPassword ?? ""));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除失败" });
  }
});

app.get("/api/users/:id/music", async (req, res) => {
  try {
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const purpose = req.query.purpose === "download" ? "download" : "play";
    const music = users.winMusicForActor(actor, req.params.id, purpose);
    if (!music?.dataUrl) return res.status(404).json({ error: "音乐不存在" });
    res.json({ music });
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : "没有权限访问该音乐" });
  }
});

app.post("/api/rooms", async (_req, res) => {
  try {
    const actor = await authFromRequest(_req);
    if (!actor) return res.status(401).json({ error: "请先登录后创建房间" });
    if (users.publicFor(actor).disabled) return res.status(403).json({ error: "该用户已被禁用，请联系管理员或超级管理员" });
    const publicUser = users.publicFor(actor);
    const rulesetMode = normalizeRulesetMode(_req.body?.rulesetMode);
    let customRules: ResolvedCustomRules | undefined;
    let customRulesHash: string | undefined;
    let customPresetId: string | undefined;
    let customPresetRevision: number | undefined;
    if (rulesetMode === "custom") {
      const presetId = typeof _req.body?.customPresetId === "string" && _req.body.customPresetId.trim() ? _req.body.customPresetId.trim() : undefined;
      try {
        if (presetId) {
          const preset = users.enabledCustomPreset(presetId);
          if (!preset) return res.status(400).json({ error: "所选自定义预设不存在或已停用" });
          customRules = preset.resolvedRules;
          customPresetId = preset.id;
          customPresetRevision = preset.revision;
        } else {
          customRules = _req.body?.customRules !== undefined ? users.resolveCustomRulesDocument(_req.body.customRules).rules : PLATFORM_PRESET;
        }
      } catch (error) {
        return res.status(400).json({ error: `自定义规则无效：${error instanceof Error ? error.message : String(error)}` });
      }
      customRulesHash = canonicalCustomRulesHash(customRules);
    }
    let capacity = Number(_req.body?.capacity ?? _req.body?.targetHumanPlayers ?? 2);
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 10) throw new Error("玩家数量（含 AI）必须是 2-10 的整数");
    let customRequiredPlayers: number | null = null;
    if (rulesetMode === "custom" && customRules) {
      const [minPlayers, maxPlayers] = setupPlayersRange(customRules.setup.players);
      if (capacity < minPlayers || capacity > maxPlayers) throw new Error(`该自定义规则要求玩家数量为 ${minPlayers}-${maxPlayers}`);
      customRequiredPlayers = requiredPlayersFromDeal(customRules, capacity);
      if (customRequiredPlayers !== null && capacity !== customRequiredPlayers) throw new Error(`该规则按 ${customRequiredPlayers} 个座位规定了初始发牌，房间人数必须为 ${customRequiredPlayers} 人`);
    }
    const initialHandSize = rulesetMode === "custom" && customRules
      ? cleanCustomInitialHandSize(_req.body?.initialHandSize, customRules, capacity, customRequiredPlayers !== null)
      : cleanInitialHandSize(_req.body?.initialHandSize, capacity);
    if (rulesetMode === "custom" && customRules) {
      customRules = parseCustomRules(customRulesSourceForRoom(customRules, capacity, initialHandSize));
      customRulesHash = canonicalCustomRulesHash(customRules);
    }
    const turnTimeLimitSec = cleanRoomTimeLimitSec(_req.body?.turnTimeLimitSec, "出牌时间");
    const openingExchangeSec = cleanRoomTimeLimitSec(_req.body?.openingExchangeSec, "换牌时间");
    let baseBet: number;
    let classicDuelMode = false;
    if (rulesetMode === "custom" && customRules) {
      // 自定义底注取交集：JSON setup 固定/范围 ∩ 平台自定义底注权限 ∩ 0 底注许可
      const setupBaseBet = customRules.setup.baseBet as number | [number, number] | undefined;
      baseBet = cleanCustomRoomBaseBet({
        value: _req.body?.baseBet ?? (typeof setupBaseBet === "number" ? setupBaseBet : DEFAULT_BASE_BET),
        setupBaseBet,
        maximum: resolveCustomMaxBaseBet(publicUser.customModeLimits.maxBaseBet, publicUser.permissions.maxBaseBet),
        canCreateZeroBaseBet: publicUser.permissions.canCreateZeroBaseBet,
      });
    } else {
      ({ baseBet, duel: classicDuelMode } = cleanRoomBaseBet({
        value: _req.body?.baseBet ?? DEFAULT_BASE_BET,
        maximum: publicUser.permissions.maxBaseBet,
        canCreateZeroBaseBet: publicUser.permissions.canCreateZeroBaseBet,
        allowDuel: true,
        capacity,
        initialHandSize,
      }));
    }
    const duelMode = rulesetMode === "custom" ? false : classicDuelMode;
    if (duelMode) {
      const duelStatus = users.duelRoomCooldownStatus(actor.id);
      if (!duelStatus.allowed) {
        const retryAt = duelStatus.retryAt ? new Date(duelStatus.retryAt).toLocaleString("zh-CN", { hour12: false }) : "管理员重新开放决斗权限";
        return res.status(400).json({ error: duelStatus.retryAt ? `当前不可创建决斗房间，请等到 ${retryAt} 后重试` : "当前账号不允许创建决斗房间", duelCooldownUntil: duelStatus.retryAt });
      }
    }
    if (duelMode) capacity = 2;
    const roomCodeMode = _req.body?.roomCodeMode === "reserved" ? "reserved" : "custom";
    const requestedRoomCode = typeof _req.body?.roomCode === "string" ? _req.body.roomCode.trim() : "";
    const roomCode = await selectRoomCode(actor, roomCodeMode, requestedRoomCode);
    const existingRoom = roomCodeMode === "reserved" ? await store.get(roomCode) : undefined;
    if (existingRoom) {
      existingRoom.codeKind = "reserved";
      await store.set(existingRoom);
      const roomCodeKind = existingRoom.codeKind;
      return res.json({
        code: existingRoom.code,
        codeKind: roomCodeKind,
        roomCodeKind,
        duelMode: Boolean(existingRoom.duelMode),
        rulesetMode: existingRoom.rulesetMode ?? "classic",
        customRulesHash: existingRoom.customRulesHash,
        existing: true,
      });
    }
    const room = await store.create(capacity, actor.id, roomCode);
    room.codeKind = roomCodeMode;
    room.baseBet = baseBet;
    room.rulesetMode = rulesetMode;
    if (customRules) room.customRules = customRules;
    if (customRulesHash) room.customRulesHash = customRulesHash;
    if (customPresetId) room.customPresetId = customPresetId;
    if (customPresetRevision !== undefined) room.customPresetRevision = customPresetRevision;
    if (initialHandSize !== undefined) room.initialHandSize = initialHandSize;
    if (turnTimeLimitSec !== undefined) room.turnTimeLimitSec = turnTimeLimitSec;
    if (openingExchangeSec !== undefined) room.openingExchangeSec = openingExchangeSec;
    if (duelMode) room.duelMode = true;
    await store.set(room);
    res.json({ code: room.code, codeKind: room.codeKind, roomCodeKind: room.codeKind, duelMode, rulesetMode, customRulesHash });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "创建房间失败" });
  }
});

app.get("/api/rooms/:code", async (req, res) => {
  try {
    const room = await store.get(req.params.code);
    if (!room) return res.status(404).json({ error: "房间不存在或已回收" });
    res.json({ room: summarizeRoom(room) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载房间失败" });
  }
});

app.get("/api/rooms/:code/rules", async (req, res) => {
  try {
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const room = await store.get(req.params.code);
    if (!room) return res.status(404).json({ error: "房间不存在或已回收" });
    if (!canReadRoomRules(room, actor.id)) return res.status(403).json({ error: "只有房间参与者可以查看完整规则" });
    if ((room.rulesetMode ?? "classic") !== "custom") return res.status(404).json({ error: "该房间不是自定义模式" });
    const rules = room.customRules ?? (room.game && isCustomGame(room.game) ? (room.game.custom.rules as ResolvedCustomRules | undefined) : undefined);
    if (!rules) return res.status(404).json({ error: "该房间没有自定义规则快照" });
    res.json({ rules, hash: canonicalCustomRulesHash(rules) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加载房间规则失败" });
  }
});

app.post("/api/rooms/:code/join", async (req, res) => {
  try {
    const room = await store.get(req.params.code);
    if (!room) return res.status(404).json({ error: "房间不存在或已回收" });
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录后加入联机房间" });
    if (users.publicFor(actor).disabled) return res.status(403).json({ error: "该用户已被禁用，请联系管理员或超级管理员" });
    const player = joinRoom(room, actor, typeof req.body.playerId === "string" ? req.body.playerId : undefined);
    await store.set(room);
    res.json({ playerId: player.id, ...roomPayload(room, player.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "加入房间失败" });
  }
});

app.get("/api/rooms/:code/state", async (req, res) => {
  try {
    const room = await mustRoom(req.params.code);
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const playerId = typeof req.query.playerId === "string" ? req.query.playerId : "";
    try {
      ensurePlayerAccount(room, playerId, actor.id);
    } catch (error) {
      await auditRequest(req, actor, "unauthorized-read", "room-private-state", { code: room.code, playerId });
      throw error;
    }
    if (req.query.presence === "1") {
      markPlayerOnline(room, playerId);
      await store.set(room);
    }
    ensureTimer(room);
    res.json(roomPayload(room, playerId));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "请求失败" });
  }
});

app.post("/api/rooms/:code/start", async (req, res) => {
  try {
    const room = await mustRoom(req.params.code);
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const playerId = String(req.body.playerId ?? "");
    ensurePlayerAccount(room, playerId, actor.id);
    await confirmStart(room, playerId, typeof req.body.customRulesHashReady === "string" ? req.body.customRulesHashReady : undefined);
    res.json(roomPayload(room, playerId));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "请求失败" });
  }
});

app.post("/api/rooms/:code/action", async (req, res) => {
  try {
    const room = await mustRoom(req.params.code);
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const playerId = String(req.body.playerId ?? "");
    if (containsProtectedGameMutation(req.body)) {
      await auditRequest(req, actor, "protected-mutation", "game-state-envelope-mutation", {
        code: room.code,
        playerId,
        fields: Object.keys(req.body ?? {}),
      });
      return res.status(400).json({ error: "动作请求包含禁止修改的牌局字段" });
    }
    if (!isStrictActionIntent(req.body?.action)) {
      await auditRequest(
        req,
        actor,
        containsProtectedGameMutation(req.body?.action) ? "protected-mutation" : "forged-action",
        "malformed-game-action",
        { code: room.code, playerId, action: req.body?.action },
      );
      return res.status(400).json({ error: "动作请求格式无效" });
    }
    try {
      ensureActionAccount(room, playerId, actor.id);
    } catch (error) {
      await auditRequest(req, actor, "unauthorized-operation", "room-seat-action", { code: room.code, playerId });
      throw error;
    }
    const result = await submit(room, playerId, req.body.action as AnyActionIntent, "normal");
    res.status(result.ok ? 200 : 400).json({ ...roomPayload(room, playerId), message: result.message });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "请求失败" });
  }
});

app.post("/api/rooms/:code/cancel-autoplay", async (req, res) => {
  try {
    const room = await mustRoom(req.params.code);
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const playerId = String(req.body.playerId ?? "");
    ensurePlayerAccount(room, playerId, actor.id);
    await cancelAutoplay(room, playerId);
    res.json(roomPayload(room, playerId));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "取消托管失败" });
  }
});

app.post("/api/rooms/:code/bots", async (req, res) => {
  try {
    const room = await mustRoom(req.params.code);
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const ownerId = String(req.body.ownerId ?? "");
    ensurePlayerAccount(room, ownerId, actor.id);
    await addBot(room, ownerId, typeof req.body.nickname === "string" ? req.body.nickname : undefined);
    res.json(roomPayload(room, ownerId));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "请求失败" });
  }
});

app.post("/api/rooms/:code/kick", async (req, res) => {
  try {
    const room = await mustRoom(req.params.code);
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const playerId = String(req.body.playerId ?? "");
    ensurePlayerAccount(room, playerId, actor.id);
    await kickPlayer(room, actor.id, String(req.body.targetId ?? ""));
    res.json(roomPayload(room, playerId));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "移出房间失败" });
  }
});

app.post("/api/rooms/:code/edit", async (req, res) => {
  try {
    const room = await mustRoom(req.params.code);
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const playerId = String(req.body.playerId ?? "");
    ensurePlayerAccount(room, playerId, actor.id);
    await editRoom(room, actor, Number(req.body.capacity), Number(req.body.baseBet), req.body.initialHandSize, req.body.turnTimeLimitSec, req.body.openingExchangeSec, req.body.customRules);
    res.json(roomPayload(room, playerId));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "修改房间失败" });
  }
});

app.post("/api/rooms/:code/leave", async (req, res) => {
  try {
    const room = await mustRoom(req.params.code);
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const playerId = String(req.body.playerId ?? "");
    ensurePlayerAccount(room, playerId, actor.id);
    await leaveRoom(room, actor.id, playerId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "退出房间失败" });
  }
});

app.post("/api/rooms/:code/heartbeat", async (req, res) => {
  try {
    const room = await store.get(req.params.code);
    if (!room) return res.status(404).json({ error: "房间不存在或已回收" });
    const actor = await authFromRequest(req);
    if (!actor) return res.status(401).json({ error: "请先登录" });
    const player = room.players.find((p) => p.id === String(req.body.playerId ?? ""));
    if (!player) throw new Error("席位不存在");
    ensurePlayerAccount(room, player.id, actor.id);
    markPlayerOnline(room, player.id);
    await store.set(room);
    broadcastRoom(room);
    res.json(roomPayload(room, player.id));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "心跳失败" });
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = resolveStaticDir();
let vite: ViteDevServer | undefined;
app.use(async (req, res, next) => {
  const normalizedPath = decodeStaticRequestPath(req.path);
  if (normalizedPath === undefined) return res.status(400).end();
  if (!isProtectedAdvancedAiAssetPath(normalizedPath)) return next();
  const actor = await users.userForToken(safeCookieValue(req.headers.cookie, "ion_ai_access"));
  if (!actor || !users.canUseAdvancedAi(actor)) return res.status(404).end();
  res.setHeader("cache-control", "private, no-store");
  next();
});
if (staticDir) app.use(express.static(staticDir));
else if (process.env.NODE_ENV !== "production") {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    appType: "custom",
    server: { middlewareMode: true },
  });
  app.use(vite.middlewares);
}
app.get("*", async (req, res, next) => {
  if (staticDir) {
    res.sendFile(path.join(staticDir, "index.html"));
    return;
  }
  if (vite) {
    try {
      const template = readFileSync(path.resolve(process.cwd(), "index.html"), "utf-8");
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).type("html").send(html);
    } catch (error) {
      vite.ssrFixStacktrace(error as Error);
      next(error);
    }
    return;
  }
  {
    res
      .status(503)
      .type("text/plain")
      .send("前端构建文件不存在。请先运行 npm.cmd run build，或开发时同时运行 npm.cmd run dev 访问 Vite 端口。");
    return;
  }
});

function resolveStaticDir(): string | undefined {
  const candidates = [
    process.env.STATIC_DIR,
    path.resolve(process.cwd(), "dist/client"),
    path.resolve(__dirname, "../client"),
    path.resolve(__dirname, "../../dist/client"),
  ].filter(Boolean) as string[];
  return candidates.find((dir) => existsSync(path.join(dir, "index.html")));
}

function tokenFromRequest(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

function enforceRegistrationRateLimit(req: Request): void {
  const now = Date.now();
  const key = req.socket.remoteAddress ?? "unknown";
  const existing = registrationAttempts.get(key);
  if (!existing || existing.resetsAt <= now) {
    registrationAttempts.set(key, { count: 1, resetsAt: now + REGISTRATION_RATE_WINDOW_MS });
  } else {
    existing.count += 1;
    if (existing.count > REGISTRATION_RATE_LIMIT) throw new Error("注册请求过于频繁，请稍后重试");
  }
  if (registrationAttempts.size > 4_096) {
    for (const [subject, bucket] of registrationAttempts) {
      if (bucket.resetsAt <= now) registrationAttempts.delete(subject);
    }
  }
}

async function authFromRequest(req: Request): Promise<StoredUser | undefined> {
  return users.userForToken(tokenFromRequest(req));
}

async function authFromToken(token?: string): Promise<StoredUser | undefined> {
  return users.userForToken(token);
}

async function requireActor(req: Request): Promise<StoredUser> {
  const actor = await authFromRequest(req);
  if (!actor) throw new Error("请先登录");
  return actor;
}

wss.on("connection", (socket) => {
  const pendingSockets = [...sockets.values()].filter((meta) => !meta.playerId).length;
  if (sockets.size >= MAX_WEBSOCKETS || pendingSockets >= MAX_PENDING_WEBSOCKETS) {
    socket.close(1013, "WebSocket capacity reached");
    return;
  }
  sockets.set(socket, {});
  const joinTimer = setTimeout(() => {
    if (!sockets.get(socket)?.playerId) socket.close(1008, "Join timeout");
  }, WEBSOCKET_JOIN_TIMEOUT_MS);
  joinTimer.unref?.();
  socketJoinTimers.set(socket, joinTimer);
  socket.on("error", (error) => {
    console.warn("[ws-client]", error.message);
  });
  socket.on("message", async (payload) => {
    try {
      await handleMessage(socket, JSON.parse(payload.toString()) as ClientMessage);
    } catch (error) {
      send(socket, "actionRejected", { message: error instanceof Error ? error.message : "请求失败" });
    }
  });
  socket.on("close", async () => {
    try {
      clearSocketJoinTimer(socket);
      const meta = sockets.get(socket);
      sockets.delete(socket);
      if (!meta?.code || !meta.playerId) return;
      const room = await store.get(meta.code);
      const player = room?.players.find((p) => p.id === meta.playerId);
      if (room && player) {
        markPlayerOffline(room, player.id);
        await store.set(room);
        broadcastRoom(room);
        scheduleOfflineAutoplay(room.code, player.id);
      }
    } catch (error) {
      console.warn("[ws-close]", error instanceof Error ? error.message : error);
    }
  });
});
wss.on("error", (error) => {
  console.warn("[ws-server]", error.message);
});

await store.connect();
await users.connect();
setInterval(() => void runBackground("room-prune", store.prune()), 60_000);
setInterval(() => void runBackground("security-report", users.flushSecurityIncidents()), 60_000);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
httpServer.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  console.log(`Ion Storm server listening on http://${displayHost}:${port} (HOST=${host})`);
});

async function handleMessage(socket: WebSocket, message: ClientMessage): Promise<void> {
  if (message.type === "joinRoom") {
    const room = await mustRoom(message.code);
    const actor = await authFromToken(message.token);
    if (!actor) throw new Error("请先登录后加入联机房间");
    const player = joinRoom(room, actor, message.playerId);
    markPlayerOnline(room, player.id);
    sockets.set(socket, { code: room.code, playerId: player.id });
    clearSocketJoinTimer(socket);
    await store.set(room);
    send(socket, "joined", { playerId: player.id, ...roomPayload(room, player.id) });
    broadcastRoom(room);
    return;
  }

  const socketMeta = sockets.get(socket);
  if (!socketMeta?.code || socketMeta.code !== message.code) throw new Error("WebSocket 未加入该房间");
  const room = await mustRoom(message.code);
  if (!room.players.some((player) => !player.bot && player.id === socketMeta.playerId)) throw new Error("WebSocket 席位不存在");
  await store.touch(room.code);
  if ("playerId" in message && typeof message.playerId === "string") markPlayerOnline(room, message.playerId);
  if ("ownerId" in message && typeof message.ownerId === "string") markPlayerOnline(room, message.ownerId);

  if (message.type === "refreshState") {
    ensureSocketPlayer(socket, message.playerId);
    send(socket, "refreshStateResult", { requestId: message.requestId, ...roomPayload(room, message.playerId) });
    return;
  }

  if (message.type === "gameStartedAck") {
    ensureSocketPlayer(socket, message.playerId);
    if (room.startAckGameId === message.gameId) {
      room.startAckedPlayerIds ??= [];
      if (!room.startAckedPlayerIds.includes(message.playerId)) room.startAckedPlayerIds.push(message.playerId);
      await store.set(room);
    }
    return;
  }

  if (message.type === "cancelAutoplay") {
    ensureSocketPlayer(socket, message.playerId);
    await cancelAutoplay(room, message.playerId);
    return;
  }

  if (message.type === "startGame") {
    ensureSocketPlayer(socket, message.playerId);
    await confirmStart(room, message.playerId, message.customRulesHashReady);
    return;
  }

  if (message.type === "submitAction") {
    try {
      ensureSocketPlayer(socket, message.playerId);
    } catch (error) {
      const meta = sockets.get(socket);
      const actor = room.players.find((player) => player.id === meta?.playerId)?.accountId;
      await auditSocket(actor, "unauthorized-operation", "room-seat-action", {
        code: room.code,
        claimedPlayerId: message.playerId,
        connectedPlayerId: meta?.playerId,
      });
      throw error;
    }
    if (containsProtectedGameMutation(message) || !isStrictActionIntent(message.action)) {
      const actor = room.players.find((player) => player.id === message.playerId)?.accountId;
      await auditSocket(
        actor,
        containsProtectedGameMutation(message) || containsProtectedGameMutation(message.action) ? "protected-mutation" : "forged-action",
        "malformed-game-action",
        { code: room.code, playerId: message.playerId, action: message.action },
      );
      throw new Error("动作请求格式无效");
    }
    await submit(room, message.playerId, message.action, "normal");
    return;
  }

  if (message.type === "botAction") {
    const meta = sockets.get(socket);
    const actor = room.players.find((player) => player.id === meta?.playerId)?.accountId;
    await auditSocket(actor, "unauthorized-operation", "client-bot-action", {
      code: room.code,
      ownerId: message.ownerId,
      botId: message.botId,
    });
    throw new Error("联机机器人由服务器自动操作");
  }

  if (message.type === "addBot") {
    ensureSocketPlayer(socket, message.ownerId);
    await addBot(room, message.ownerId, message.nickname);
    return;
  }

  if (message.type === "kickPlayer") {
    ensureSocketPlayer(socket, message.playerId);
    const actor = room.players.find((player) => player.id === message.playerId && !player.bot);
    if (!actor?.accountId) throw new Error("没有权限移出房间成员");
    await kickPlayer(room, actor.accountId, message.targetId);
    return;
  }

  if (message.type === "editRoom") {
    ensureSocketPlayer(socket, message.playerId);
    const player = room.players.find((item) => item.id === message.playerId && !item.bot);
    const actor = player?.accountId ? users.userById(player.accountId) : undefined;
    if (!actor) throw new Error("没有权限修改房间");
    await editRoom(room, actor, message.capacity, message.baseBet, message.initialHandSize, message.turnTimeLimitSec, message.openingExchangeSec, message.customRules);
    return;
  }

  if (message.type === "leaveRoom") {
    ensureSocketPlayer(socket, message.playerId);
    const player = room.players.find((item) => item.id === message.playerId && !item.bot);
    if (!player?.accountId) throw new Error("没有权限退出该席位");
    await leaveRoom(room, player.accountId, player.id);
    send(socket, "leftRoom", {});
    return;
  }

  if (message.type === "heartbeat") {
    ensureSocketPlayer(socket, message.playerId);
    const player = room.players.find((p) => p.id === message.playerId);
    if (player) markPlayerOnline(room, player.id);
    await store.set(room);
    broadcastRoom(room);
    return;
  }

  if (message.type === "leaveSeat") {
    ensureSocketPlayer(socket, message.playerId);
    const player = room.players.find((p) => p.id === message.playerId);
    if (player) {
      markPlayerOffline(room, player.id);
      scheduleOfflineAutoplay(room.code, player.id);
    }
    await store.set(room);
    broadcastRoom(room);
  }
}

async function confirmStart(room: Room, playerId: string, customRulesHashReady?: string): Promise<void> {
  if (room.game && room.game.status !== "ended") return;
  const player = room.players.find((p) => p.id === playerId && !p.bot);
  if (!player) throw new Error("只有真人玩家可以确认开始");
  if ((room.rulesetMode ?? "classic") === "custom" && (!room.customRulesHash || customRulesHashReady !== room.customRulesHash)) {
    throw new Error("请先下载当前自定义规则后再确认开始");
  }
  markPlayerOnline(room, player.id);
  room.readyPlayerIds ??= [];
  if (!room.readyPlayerIds.includes(player.id)) room.readyPlayerIds.push(player.id);
  await store.set(room);
  if (canStart(room)) {
    if (room.game?.status === "ended") room.game = undefined;
    await startGame(room);
    return;
  }
  broadcastRoom(room);
}

async function startGame(room: Room): Promise<void> {
  if (room.game) return;
  if (!canStart(room)) throw new Error("仍有玩家尚未确认开始");
  if (room.players.length < 2) throw new Error("至少需要 2 个席位才能开始");
  await ensureRoomConfigWithinCreatorPermissions(room);
  await ensureRoomParticipantsCanStart(room);
  for (const player of room.players.filter((item) => !item.bot && item.accountId)) {
    const account = users.userById(player.accountId!);
    if (!account) throw new Error("房间中的账号已不存在");
    const view = users.publicFor(account);
    if (view.disabled) throw new Error("该用户已被禁用，请联系管理员或超级管理员");
    player.profile = users.profileFor(account);
    player.nickname = view.nickname;
    player.canOpeningExchange = true;
  }
  if (room.duelMode) {
    try {
      await chargeDuelRoomStart(room);
    } catch (error) {
      await publishRoomConfigProblems(room, [error instanceof Error ? error.message : String(error)]);
      throw error;
    }
  }
  room.bankerPlayerId = ensureBankerPlayerId(room.players, room.bankerPlayerId);
  const bankerSeat = room.players.findIndex((player) => player.id === room.bankerPlayerId);
  const customMode = (room.rulesetMode ?? "classic") === "custom";
  if (customMode && room.players.some((player) => player.bot)) throw new Error("自定义模式不允许机器人");
  const customRules = customMode ? (room.customRules ?? PLATFORM_PRESET) : undefined;
  // 开局冻结开房者额度：该额度限制每名输家的扣分，本局不随权限变动。
  const creator = customMode ? users.userById(room.creatorAccountId) : undefined;
  const settlementLoserCap = creator
    ? resolveCustomSettlementCap(users.publicFor(creator).customModeLimits.settlementCap, room.baseBet)
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
    players: room.players.map((p) => ({
      nickname: p.nickname,
      bot: p.bot,
      botOwnerId: p.botOwnerId,
      accountId: p.accountId,
      profile: p.profile,
      canOpeningExchange: p.canOpeningExchange,
    })),
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
      canOpeningExchange: room.players[index]?.canOpeningExchange,
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
  room.statsSettledGameId = undefined;
  room.startAckGameId = room.game.id;
  room.startAckedPlayerIds = [];
  room.startAckLastSentAtByPlayerId = {};
  await store.set(room);
  scheduleTimer(room);
  broadcastRoom(room);
}

function duelKeepAvailable(room: Room): boolean {
  if (!room.duelMode || room.game?.status !== "ended" || !room.creatorAccountId) return false;
  try {
    return users.duelRoomCooldownStatus(room.creatorAccountId).allowed;
  } catch {
    return false;
  }
}

async function publishRoomConfigProblems(room: Room, problems: string[]): Promise<void> {
  const creator = room.creatorAccountId ? users.userById(room.creatorAccountId) : undefined;
  room.editNotice = createRoomEditNotice(room, creator ? users.publicFor(creator).nickname : "系统");
  room.editNotice.problems = problems;
  await store.set(room);
  broadcastRoom(room);
}

async function ensureRoomConfigWithinCreatorPermissions(room: Room): Promise<void> {
  const creator = room.creatorAccountId ? users.userById(room.creatorAccountId) : undefined;
  const problems: string[] = [];
  if (!creator) {
    problems.push("开房者账号已不存在，无法校验房间设置");
  } else {
    const view = users.publicFor(creator);
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
  await publishRoomConfigProblems(room, problems);
  throw new Error(`房间设置已不符合开房者权限限制：${problems.join("；")}`);
}

async function ensureRoomParticipantsCanStart(room: Room): Promise<void> {
  const problems: string[] = [];
  for (const player of room.players.filter((item) => !item.bot && item.accountId)) {
    const account = users.userById(player.accountId!);
    if (!account) problems.push("房间中存在已不存在的账号，无法开始游戏");
    else if (users.publicFor(account).disabled) problems.push("房间中存在已被禁用的账号，无法开始游戏");
  }
  if (!problems.length) return;
  await publishRoomConfigProblems(room, problems);
  throw new Error(problems.join("；"));
}

async function chargeDuelRoomStart(room: Room): Promise<void> {
  if (!room.creatorAccountId) throw new Error("决斗房间缺少创建者，无法开始游戏");
  const status = users.duelRoomCooldownStatus(room.creatorAccountId);
  if (!status.allowed) {
    const retryAt = status.retryAt ? new Date(status.retryAt).toLocaleString("zh-CN", { hour12: false }) : "管理员重新开放决斗权限";
    throw new Error(status.retryAt ? `当前不可开始决斗对局，请等到 ${retryAt} 后重试` : "当前账号不允许开始决斗对局");
  }
  await users.recordDuelRoomCreation(room.creatorAccountId);
}

function canStart(room: Room): boolean {
  const humans = room.players.filter((p) => !p.bot);
  if (room.players.length !== roomCapacity(room)) return false;
  if (room.players.length < 2) return false;
  const ready = new Set(room.readyPlayerIds ?? []);
  return humans.every((player) => ready.has(player.id));
}

async function addBot(room: Room, ownerId: string, nickname?: string): Promise<void> {
  const owner = room.players.find((p) => p.id === ownerId);
  if (!owner || (room.game && room.game.status !== "ended")) throw new Error("只能在待开始阶段添加机器人");
  if (!owner.accountId) throw new Error("请先登录后添加机器人");
  if (room.duelMode) throw new Error("决斗房间不能添加机器人");
  if ((room.rulesetMode ?? "classic") === "custom") throw new Error("自定义模式不允许机器人");
  if (room.players.length >= roomCapacity(room)) throw new Error("房间已达到预定人数");
  const bot: PlayerState = {
    id: `bot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    nickname: nickname?.trim() || `AI ${room.players.filter((p) => p.bot).length + 1}`,
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
  await store.set(room);
  broadcastRoom(room);
}

async function kickPlayer(room: Room, actorAccountId: string, targetId: string): Promise<void> {
  if (room.game && room.game.status !== "ended") throw new Error("游戏过程中不能移出房间成员");
  if (room.creatorAccountId !== actorAccountId) throw new Error("只有房间创建者可以移出成员或机器人");
  const target = room.players.find((player) => player.id === targetId);
  if (!target) throw new Error("目标席位不存在");
  if (target.accountId === actorAccountId) throw new Error("房间创建者不能移出自己");
  removeRoomPlayer(room, targetId);
  if (room.game?.status === "ended") await settleRoomStats(room);
  await store.set(room);
  scheduleTimer(room);
  broadcastRoom(room);
}

async function editRoom(
  room: Room,
  actor: StoredUser,
  requestedCapacity: number,
  requestedBaseBet: number,
  requestedInitialHandSize?: unknown,
  requestedTurnTimeLimitSec?: unknown,
  requestedOpeningExchangeSec?: unknown,
  requestedCustomRules?: unknown,
): Promise<void> {
  if (room.creatorAccountId !== actor.id) throw new Error("只有房间创建者可以修改房间");
  if (room.duelMode) throw new Error("决斗模式房间不能编辑设置");
  const customMode = (room.rulesetMode ?? "classic") === "custom";
  if (requestedCustomRules !== undefined && !customMode) throw new Error("经典房间不支持自定义规则");
  let nextCustomRules: ResolvedCustomRules | undefined;
  let nextCustomRulesHash: string | undefined;
  if (requestedCustomRules !== undefined) {
    // 21.5：对局进行中禁止替换规则，绝不能直接修改当前局 snapshot
    if (room.game && room.game.status !== "ended") throw new Error("对局进行中不能修改自定义规则");
    // 21.3：保存后必须由服务器重新解析，不能相信前端的“校验通过”
    nextCustomRules = users.resolveCustomRulesDocument(requestedCustomRules).rules;
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
  const publicUser = users.publicFor(actor);
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
      maximum: resolveCustomMaxBaseBet(publicUser.customModeLimits.maxBaseBet, publicUser.permissions.maxBaseBet),
      canCreateZeroBaseBet: publicUser.permissions.canCreateZeroBaseBet,
    });
  } else {
    ({ baseBet } = cleanRoomBaseBet({
      value: requestedBaseBet,
      maximum: publicUser.permissions.maxBaseBet,
      canCreateZeroBaseBet: publicUser.permissions.canCreateZeroBaseBet,
      allowDuel: false,
      capacity: requestedCapacity,
      initialHandSize,
    }));
  }
  const owner = room.players.find((player) => player.accountId === actor.id && !player.bot);
  if (!owner) throw new Error("房间创建者席位不存在");
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
  await store.set(room);
  broadcastRoom(room);
}

async function leaveRoom(room: Room, actorAccountId: string, playerId: string): Promise<void> {
  if (room.creatorAccountId === actorAccountId) throw new Error("房间创建者不能退出房间");
  const player = room.players.find((item) => item.id === playerId && !item.bot);
  if (!player || player.accountId !== actorAccountId) throw new Error("没有权限退出该席位");
  replaceRoomPlayerWithBot(room, playerId);
  if (room.game?.status === "ended") await settleRoomStats(room);
  await store.set(room);
  scheduleTimer(room);
  broadcastRoom(room);
}

function removeRoomPlayer(room: Room, targetId: string): void {
  const target = room.players.find((player) => player.id === targetId);
  if (!target) throw new Error("目标席位不存在");
  const previousPlayers = [...room.players];
  const wasBanker = room.bankerPlayerId === targetId;
  room.players = room.players.filter((player) => player.id !== targetId);
  room.players = room.players.map((player, index) => ({ ...player, seat: index }));
  room.readyPlayerIds = (room.readyPlayerIds ?? []).filter((id) => id !== targetId);
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
      markPlayerOffline(room, targetId, false);
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
    id: `bot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
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
  const activeGame = room.game && room.game.status !== "ended" && !isCustomGame(room.game) ? room.game : undefined;
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
      if (completed) room.game = finishOpeningExchange(activeGame);
    }
    if (room.game?.status === "playing" && rulesetCurrentPlayer(room.game).id === targetId) {
      room.game.turnStartedAt = Date.now();
      room.game.turnDeadlineAt = Date.now() + AUTOMATED_ACTION_DELAY_MS;
    }
  }
  room.players = room.players.map((player) => (player.id === targetId ? replacement : player));
  room.readyPlayerIds = (room.readyPlayerIds ?? []).filter((id) => id !== targetId);
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

async function cancelAutoplay(room: Room, playerId: string): Promise<void> {
  if (room.game && isCustomGame(room.game)) throw new Error("自定义模式不支持托管");
  const roomPlayer = room.players.find((player) => player.id === playerId && !player.bot);
  const gamePlayer = room.game?.players.find((player) => player.id === playerId && !player.bot);
  if (!roomPlayer) throw new Error("席位不存在");
  const turnLimitMs = room.game?.turnTimeLimitMs ?? 60_000;
  for (const player of [roomPlayer, gamePlayer].filter(Boolean) as PlayerState[]) {
    player.forcedAutoplay = false;
    player.timeoutLimitMs = turnLimitMs;
    player.timeoutStreak = 0;
    player.normalStreak = 0;
  }
  if (room.game?.status === "playing" && currentPlayer(room.game).id === playerId) {
    room.game.turnStartedAt = Date.now();
    room.game.turnDeadlineAt = Date.now() + turnLimitMs;
  }
  syncRoomMembersFromGame(room);
  await store.set(room);
  scheduleTimer(room);
  broadcastRoom(room);
}

async function submit(room: Room, playerId: string, action: AnyActionIntent, source: "normal" | "timeout") {
  if (!room.game) throw new Error("游戏尚未开始");
  const result = applyRulesetAction(room.game, playerId, action, source);
  room.game = result.game;
  syncRoomMembersFromGame(room);
  if (room.game.status === "ended") {
    advanceBankerAfterGame(room);
    await settleRoomStats(room);
  }
  if (room.duelMode && room.game?.status === "ended") {
    await store.set(room);
    scheduleTimer(room);
    broadcastRoom(room);
    return result;
  }
  if (!result.ok) {
    sendToPlayer(room.code, playerId, "actionRejected", { message: result.message });
  }
  await store.set(room);
  scheduleTimer(room);
  broadcastRoom(room);
  return result;
}

function scheduleTimer(room: Room): void {
  const old = timers.get(room.code);
  if (old) clearTimeout(old);
  timers.delete(room.code);
  if (!room.game) return;
  if (room.game.status === "opening-exchange") {
    const wait = Math.max(250, (room.game.openingExchange?.deadlineAt ?? Date.now()) - Date.now());
    timers.set(room.code, setTimeout(() => void runBackground("opening-timeout", timeoutOpeningExchange(room.code)), wait));
    return;
  }
  if (room.game.status !== "playing") return;
  const player = rulesetCurrentPlayer(room.game);
  if (player.bot || player.forcedAutoplay) {
    const previousLimit = player.timeoutLimitMs;
    player.timeoutLimitMs = AUTOMATED_ACTION_DELAY_MS;
    if (!room.game.turnDeadlineAt || previousLimit !== AUTOMATED_ACTION_DELAY_MS) {
      room.game.turnStartedAt = Date.now();
      room.game.turnDeadlineAt = Date.now() + AUTOMATED_ACTION_DELAY_MS;
    }
    const wait = Math.max(25, room.game.turnDeadlineAt - Date.now());
    timers.set(room.code, setTimeout(() => void runBackground("forced-autoplay", timeoutPlay(room.code)), wait));
    return;
  }
  const wait = Math.max(250, (room.game.turnDeadlineAt ?? Date.now()) - Date.now());
  timers.set(room.code, setTimeout(() => void runBackground("turn-timeout", timeoutPlay(room.code)), wait));
}

function ensureTimer(room: Room): void {
  if ((room.game?.status === "playing" || room.game?.status === "opening-exchange") && !timers.has(room.code)) scheduleTimer(room);
}

async function timeoutOpeningExchange(code: RoomCode): Promise<void> {
  const room = await store.get(code);
  if (!room?.game || room.game.status !== "opening-exchange") return;
  if (isCustomGame(room.game)) {
    // 自定义模式：为每位未完成开局决定的玩家按超时提交最小换牌与不加倍
    room.game = advanceRulesetOpeningTimeout(room.game);
  } else {
    room.game = finishOpeningExchange(room.game);
  }
  syncRoomMembersFromGame(room);
  if (room.game.status === "ended") await settleRoomStats(room);
  await store.set(room);
  scheduleTimer(room);
  broadcastRoom(room);
}

async function timeoutPlay(code: RoomCode, delay = 0): Promise<void> {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const room = await store.get(code);
  if (!room?.game || room.game.status !== "playing") return;
  const player = rulesetCurrentPlayer(room.game);
  const offline = isCustomGame(room.game) && player.online === false;
  const action = offline ? undefined : randomRulesetTimeoutAction(room.game, player.id);
  if (action) {
    await submit(room, player.id, action, player.bot ? "normal" : "timeout");
    return;
  }
  if (!offline) {
    // 自定义模式：超时且无合法实际出牌，按掉线处理；下一次超时将跳过其回合
    markPlayerOffline(room, player.id, false);
    await store.set(room);
    scheduleTimer(room);
    broadcastRoom(room);
    return;
  }
  // 已掉线玩家：用非破坏性默认动作跳过其回合，避免对局停滞
  const fallback = rulesetOfflineFallbackAction(room.game, player.id);
  if (fallback) {
    await submit(room, player.id, fallback, "timeout");
    return;
  }
  await store.set(room);
  broadcastRoom(room);
}

function joinRoom(room: Room, actor: StoredUser, playerId?: string): RoomPlayer {
  const profile = users.profileFor(actor);
  if (users.publicFor(actor).disabled) throw new Error("该用户已被禁用，请联系管理员或超级管理员");
  const existingByAccount = room.players.find((p) => p.accountId === profile.accountId && !p.bot);
  const existingById = playerId ? room.players.find((p) => p.id === playerId && !p.bot) : undefined;
  const existing = existingByAccount ?? (existingById && existingById.accountId === profile.accountId ? existingById : undefined);
  if (existing) {
    existing.accountId = profile.accountId;
    existing.profile = profile;
    existing.nickname = profile.nickname ?? profile.username;
    existing.canOpeningExchange = true;
    markPlayerOnline(room, existing.id);
    room.bankerPlayerId = ensureBankerPlayerId(room.players, room.bankerPlayerId);
    return existing;
  }
  if (room.game && room.game.status !== "ended") throw new Error("对局已经开始，只有同席位玩家可以恢复席位");
  if (room.players.length >= roomCapacity(room)) throw new Error("房间已达到预定人数");
  room.creatorAccountId ||= actor.id;
  const player: PlayerState = {
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    nickname: profile.nickname ?? profile.username,
    accountId: profile.accountId,
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
  room.readyPlayerIds ??= [];
  return player;
}

async function mustRoom(code: RoomCode): Promise<Room> {
  const room = await store.get(code);
  if (!room) throw new Error("房间不存在或已回收");
  return room;
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

function ensureSocketPlayer(socket: WebSocket, playerId: string): void {
  const meta = sockets.get(socket);
  if (!meta?.playerId || meta.playerId !== playerId) throw new Error("没有权限操作该席位");
}

function clearSocketJoinTimer(socket: WebSocket): void {
  const timer = socketJoinTimers.get(socket);
  if (timer) clearTimeout(timer);
  socketJoinTimers.delete(socket);
}

function broadcastRoom(room: Room): void {
  ensureTimer(room);
  for (const [socket, meta] of sockets) {
    if (meta.code !== room.code || socket.readyState !== socket.OPEN) continue;
    send(socket, "roomState", { room: summarizeRoom(room), serverNow: Date.now() });
    if (room.game) send(socket, "gameState", { game: publicRulesetGame(room.game, meta.playerId), serverNow: Date.now() });
    if (room.game?.status === "playing" || room.game?.status === "opening-exchange") {
      send(socket, "timerSync", {
        currentPlayerId: rulesetCurrentPlayer(room.game).id,
        deadlineAt: room.game.turnDeadlineAt,
        limitMs: room.game.status === "opening-exchange" ? (room.game.openingExchangeWindowMs ?? OPENING_EXCHANGE_MS) : rulesetCurrentPlayer(room.game).timeoutLimitMs,
        serverNow: Date.now(),
      });
    }
    if (room.game?.status === "ended") send(socket, "gameEnded", { winnerId: room.game.winnerId });
  }
}

function maybeSendGameStarted(room: Room, socket: WebSocket, playerId: string): void {
  if (!room.game || room.startAckGameId !== room.game.id) return;
  const player = room.players.find((item) => item.id === playerId);
  if (!player || player.bot || room.startAckedPlayerIds?.includes(playerId)) return;
  const now = Date.now();
  const last = room.startAckLastSentAtByPlayerId?.[playerId] ?? 0;
  if (now - last < 1_000) return;
  room.startAckLastSentAtByPlayerId ??= {};
  room.startAckLastSentAtByPlayerId[playerId] = now;
  send(socket, "gameStarted", { gameId: room.game.id, ...roomPayload(room, playerId) });
}

function sendToPlayer(code: RoomCode, playerId: string, type: string, payload: Record<string, unknown>): void {
  for (const [socket, meta] of sockets) {
    if (meta.code === code && meta.playerId === playerId) send(socket, type, payload);
  }
}

function send(socket: WebSocket, type: string, payload: Record<string, unknown>): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type, ...payload }));
}

function markPlayerOnline(room: Room, playerId: string): void {
  clearOfflineAutoplay(room.code, playerId);
  const now = Date.now();
  for (const player of [...room.players, ...(room.game?.players ?? [])]) {
    if (player.id === playerId) {
      player.online = true;
      player.lastSeenAt = now;
    }
  }
  for (const player of room.game?.players ?? []) {
    if (player.id === playerId) {
      player.online = true;
      player.lastSeenAt = now;
    }
  }
}

function markPlayerOffline(room: Room, playerId: string, respectOpenSocket = true): void {
  if (respectOpenSocket && hasOpenSocket(room.code, playerId)) return;
  const now = Date.now();
  for (const player of room.players) {
    if (player.id === playerId) {
      player.online = false;
      player.lastSeenAt = now;
    }
  }
  for (const player of room.game?.players ?? []) {
    if (player.id === playerId) {
      player.online = false;
      player.lastSeenAt = now;
    }
  }
}

function hasOpenSocket(code: RoomCode, playerId: string): boolean {
  for (const [socket, meta] of sockets) {
    if (meta.code === code && meta.playerId === playerId && socket.readyState === socket.OPEN) return true;
  }
  return false;
}

function scheduleOfflineAutoplay(code: RoomCode, playerId: string): void {
  clearOfflineAutoplay(code, playerId);
}

function clearOfflineAutoplay(code: RoomCode, playerId: string): void {
  const key = offlineKey(code, playerId);
  const timer = offlineTimers.get(key);
  if (timer) clearTimeout(timer);
  offlineTimers.delete(key);
}

async function forceOfflineAutoplay(code: RoomCode, playerId: string, _respectOpenSocket = true): Promise<void> {
  clearOfflineAutoplay(code, playerId);
}

function offlineKey(code: RoomCode, playerId: string): string {
  return `${code}:${playerId}`;
}

async function runBackground(label: string, operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    console.warn(`[${label}]`, error instanceof Error ? error.message : error);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function auditRequest(
  req: Request,
  actor: StoredUser | undefined,
  category: "unauthorized-read" | "unauthorized-operation" | "forged-action" | "protected-mutation",
  operation: string,
  details: Record<string, unknown>,
): Promise<void> {
  const deviceId = String(req.headers["x-ion-device-id"] ?? "").slice(0, 160);
  await users.recordSecurityEvent({
    actorUserId: actor?.id,
    subjectKey: actor ? `user:${actor.id}` : deviceId ? `device:${deviceId}` : `network:${req.ip}`,
    category,
    operation,
    method: req.method,
    route: req.path,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    details,
  });
}

async function auditSocket(
  actorUserId: string | undefined,
  category: "unauthorized-read" | "unauthorized-operation" | "forged-action" | "protected-mutation",
  operation: string,
  details: Record<string, unknown>,
): Promise<void> {
  await users.recordSecurityEvent({
    actorUserId,
    subjectKey: actorUserId ? `user:${actorUserId}` : "websocket:anonymous",
    category,
    operation,
    method: "WS",
    route: "/ws",
    details,
  });
}

function isDefiniteProtectedAccountMutation(actor: StoredUser, body: unknown): boolean {
  const role = users.publicFor(actor).role;
  if (role === "super-admin" || role === "admin" || role === "admin-advanced") return false;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const protectedFields = new Set([
    "points",
    "title",
    "nicknameColor",
    "permissions",
    "permissionsPermanent",
    "permissionsDurationMs",
    "permissionsExpiresAt",
    "customModeLimits",
    "customModeLimitsPermanent",
    "customModeLimitsDurationMs",
    "customModeLimitsExpiresAt",
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
  return Object.keys(body).some((key) => protectedFields.has(key));
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "log";
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

async function scanOfflinePlayers(): Promise<void> {
  const now = Date.now();
  for (const room of await store.activeRooms()) {
    if (!room.game || room.game.status !== "playing") continue;
    let changed = false;
    for (const player of room.players) {
      if (player.bot) continue;
      const lastSeenAt = player.lastSeenAt ?? now;
      if (player.online && now - lastSeenAt > PRESENCE_OFFLINE_MS) {
        markPlayerOffline(room, player.id, false);
        changed = true;
      }
    }
    if (changed) {
      await store.set(room);
      broadcastRoom(room);
    }
  }
}

async function settleRoomStats(room: Room): Promise<void> {
  if (!room.game || room.game.status !== "ended") return;
  if (room.statsSettledGameId === room.game.id) return;
  const custom = isCustomGame(room.game);
  const accountIds = room.game.players.filter((player) => !player.bot && player.accountId).map((player) => player.accountId!);
  const winner = room.game.players.find((player) => player.id === room.game?.winnerId);
  const scoringTotal = room.game.scoring
    ? (room.game.scoring.total ?? room.game.scoring.stake + Object.values(room.game.scoring.pendingByPlayerId).reduce((sum, value) => sum + value, 0))
    : 0;
  const humanPlayers = room.game.players.filter((player) => !player.bot);
  const baseBet = room.game.scoring?.baseBet ?? 0;
  const doubleCount = room.game.scoring?.openingDoublePlayerIds?.length ?? 0;
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
    const loserCount = [...new Set(accountIds)].filter((id) => id !== winner?.accountId).length;
    const settlement = calculateCustomSettlement(scoringTotal, loserCount, creatorCap);
    settleAmountPerLoser = settlement.amountPerLoser;
    grossWinnerPoints = settlement.winnerGrossPoints;
    customCapScale = settlement.capScale;
  } else {
    grossWinnerPoints = winnerGrossPoints(scoringTotal, accountIds, winner?.accountId);
  }
  const settlesPoints = Boolean(winner && !winner.bot && winner.accountId && humanPlayers.length >= 2 && baseBet > 0 && grossWinnerPoints > 0);
  const rawWinnerTax = !custom && settlesPoints ? baseBet * humanPlayers.length * Math.pow(2, doubleCount) : 0;
  const taxContext = custom ? { taxRatePercent: -1, taxWinnerPointsThreshold: undefined, winnerPointsBeforeSettlement: 0 } : users.taxContextForUserId(winner?.accountId);
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
  await users.settleGame(room.game.id, accountIds, winner?.accountId, settleAmountPerLoser, winnerTax);
  for (const id of accountIds) room.roomGamesPlayed[id] = (room.roomGamesPlayed[id] ?? 0) + 1;
  if (winner?.accountId) room.roomGamesWon[winner.accountId] = (room.roomGamesWon[winner.accountId] ?? 0) + 1;
  room.statsSettledGameId = room.game.id;
}

function roomPayload(room: Room, viewerId?: string) {
  ensureTimer(room);
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
    codeKind: room.codeKind ?? "custom",
    roomCodeKind: room.codeKind ?? "custom",
    createdAt: room.createdAt,
    lastActiveAt: room.lastActiveAt,
    capacity: roomCapacity(room),
    creatorAccountId: room.creatorAccountId,
    bankerPlayerId: room.bankerPlayerId,
    rulesetMode: room.rulesetMode ?? "classic",
    customRulesHash: room.rulesetMode === "custom" ? (room.customRulesHash ?? null) : null,
    customConfigRevision: room.rulesetMode === "custom" ? (room.customConfigRevision ?? 0) : null,
    customPresetId: room.rulesetMode === "custom" ? (room.customPresetId ?? null) : null,
    customPresetRevision: room.rulesetMode === "custom" ? (room.customPresetRevision ?? null) : null,
    baseBet: room.baseBet ?? DEFAULT_BASE_BET,
    initialHandSize: room.initialHandSize ?? null,
    turnTimeLimitSec: room.turnTimeLimitSec ?? null,
    openingExchangeSec: room.openingExchangeSec ?? null,
    duelMode: Boolean(room.duelMode),
    duelKeepAvailable: duelKeepAvailable(room),
    status: room.game?.status ?? "lobby",
    roomGamesPlayed: room.roomGamesPlayed ?? {},
    roomGamesWon: room.roomGamesWon ?? {},
    editNotice: room.editNotice,
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

async function selectRoomCode(actor: StoredUser, mode: "custom" | "reserved", requested: string): Promise<RoomCode> {
  const ownReserved = actor.reservedRoomCodes ?? [];
  if (mode === "reserved") {
    if (!ownReserved.length) throw new Error("您没有专属房间号，不能使用专属房间号开房");
    if (!requested || !ownReserved.includes(requested)) throw new Error("只能使用本人已有的专属房间号开房");
    const existing = await store.get(requested);
    if (existing && existing.creatorAccountId !== actor.id) throw new Error("房间号已被占用");
    return requested;
  }
  if (requested) {
    if (!/^[1-9]\d{5}$/.test(requested)) throw new Error("自定义房间号必须是首位不为 0 的六位数字");
    if (users.reservedRoomCodeOwner(requested)) throw new Error("房间号已被专属房间号占用");
    if (await store.get(requested)) throw new Error("房间号已被占用");
    return requested;
  }
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const candidate = Math.floor(100_000 + Math.random() * 900_000).toString();
    if (!users.reservedRoomCodeOwner(candidate) && !(await store.get(candidate))) return candidate;
  }
  throw new Error("暂时无法生成可用房间号，请稍后重试");
}

function roomCapacity(room: Room): number {
  room.capacity ??= room.targetHumanPlayers ?? 2;
  return Math.min(10, Math.max(1, room.capacity));
}
