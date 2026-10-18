/**
 * 网络传输层（S4 批次一 + 批次二）。
 *
 * 从 app.ts 搬出来的「怎么和后端说话」：
 *   批次一：设备 id / 浏览器指纹、请求头、响应解析、四个 http* 动词。
 *   批次二：WebSocket 连接与重连、心跳、对账轮询、HTTP 兼容模式轮询。
 *
 * 这里的状态只有「传输层自己的」：socket 句柄、四个定时器句柄、降级标志、轮询节流时间戳。
 * 对局状态（game / room / selfId / 版本号 / 待补建 AI）一律不碰，只通过 context 的回调问：
 *   读：authToken() / selfId() / room() / game()
 *   新鲜度：gameContextVersion() / isOnlineContext()（版本号的自增仍在 app.ts）
 *   交给 app.ts：onSocketMessage()（WS 消息整条递过去）、applyServerPayload()、leaveRemovedRoom()
 *   取走：takePendingOnlineBots()（降级成 HTTP 兼容模式时改走 REST 补建 AI）
 *
 * 设备 id 与浏览器指纹原来是 app.ts 的模块级常量（`const deviceId = ensureDeviceId()`）。
 * 现在改成这里初始化：ESM 会先求值依赖模块，所以它们仍然在 app.ts 的模块体之前算好，
 * 计算次数、写入 localStorage / cookie 的时机都与原实现一样（各一次）。
 *
 * 本模块顶层不调用 getBridge()（只在函数体内调用），所以模块求值顺序不影响正确性。
 */
import { getBridge } from "./context.js";
import { toast } from "./dom.js";

/** localStorage 里设备 id 的键名（与原来 app.ts 的 DEVICE_ID_KEY 一致）。 */
const DEVICE_ID_KEY = "ionStormDeviceId";

/** 本机设备 id：模块加载时算一次，等价于原来的模块级常量。 */
const deviceId = ensureDeviceId();

/** 浏览器环境指纹：模块加载时算一次，等价于原来的模块级常量。 */
const browserFingerprint = buildBrowserFingerprint();

/** 请求头：默认带 JSON content-type，带上当前 token、设备 id 与浏览器指纹。 */
export function authHeaders(json = true): HeadersInit {
  const headers: Record<string, string> = json ? { "content-type": "application/json" } : {};
  const authToken = getBridge().authToken();
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  headers["x-ion-device-id"] = deviceId;
  headers["x-ion-browser-fingerprint"] = browserFingerprint;
  return headers;
}

// 统一解析响应。后端没起、跑的是旧版本、或 404 落到 SPA fallback 时回的是 HTML，
// 直接 res.json() 会抛 "Unexpected end of JSON input"，把「根本没有这个接口」
// 伪装成解析错误（解散房间那个 404 就是这么被看错的）。这里换成一句能看懂的话，
// 并且始终带上 status —— refreshAuth 要靠它区分「token 失效」和「后端抖了一下」。
export async function readJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(
      new Error(res.ok ? "响应格式异常，请刷新页面后重试" : `接口不存在或后端版本过旧（HTTP ${res.status}）`),
      { status: res.status },
    );
  }
  if (!res.ok) throw Object.assign(new Error(data?.error ?? data?.message ?? "请求失败"), { status: res.status });
  return data;
}

export async function httpGet(path: string) {
  const res = await fetch(path, { headers: authHeaders(false) });
  return readJsonResponse(res);
}

export async function httpPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return readJsonResponse(res);
}

export async function httpPatch(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return readJsonResponse(res);
}

export async function httpDelete(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "DELETE",
    headers: authHeaders(Boolean(body)),
    body: body ? JSON.stringify(body) : undefined,
  });
  return readJsonResponse(res);
}

/** 读出 localStorage 里的设备 id；没有或格式不对就生成一个并写回去。 */
function ensureDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing && /^[A-Za-z0-9_-]{16,160}$/.test(existing)) return existing;
  const created =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(DEVICE_ID_KEY, created);
  return created;
}

/** 读出 cookie 里的浏览器指纹；没有就生成一个并写回去（有效期与原来一致）。 */
function buildBrowserFingerprint(): string {
  const existing = /(?:^|;\s*)ionStormBrowserEnv=([A-Za-z0-9_-]{16,160})(?:;|$)/.exec(document.cookie)?.[1];
  if (existing) return existing;
  const created =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  document.cookie = `ionStormBrowserEnv=${created}; Max-Age=34560000; Path=/; SameSite=Strict`;
  return created;
}

// ---------------------------------------------------------------------------
// S4 批次二：WebSocket 连接 / 重连 / 心跳 / 对账轮询 / HTTP 兼容模式
// ---------------------------------------------------------------------------

/** 心跳间隔。 */
const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2_000;
/** 对账轮询间隔（WS 正常时也跑，用来兜住漏推的状态）。 */
const WEBSOCKET_RECONCILE_INTERVAL_MS = 5_000;
/** WS 断开后的重连间隔。 */
const WEBSOCKET_RETRY_INTERVAL_MS = 10_000;
/** HTTP 兼容模式的轮询间隔。 */
const HTTP_FALLBACK_POLL_INTERVAL_MS = 6_000;
/** 页面切到后台时的轮询最小间隔。 */
const HTTP_POLL_HIDDEN_MIN_DELAY_MS = 20_000;
/** 对局进行中的轮询最小间隔。 */
const HTTP_POLL_PLAYING_MIN_DELAY_MS = 5_000;
/** 大厅 / 终局的轮询最小间隔。 */
const HTTP_POLL_LOBBY_MIN_DELAY_MS = 10_000;
/** 在线状态（presence=1）的同步间隔。 */
const HTTP_PRESENCE_SYNC_INTERVAL_MS = 20_000;

/** 当前活的 WS 连接；undefined 表示没连上或已断开。 */
let socket: WebSocket | undefined;
/** HTTP 兼容模式的轮询定时器；0 表示没开。 */
let pollInterval = 0;
/** WS 正常时的对账轮询定时器；0 表示没开。 */
let reconcileInterval = 0;
/** 心跳定时器；0 表示没开。 */
let heartbeatInterval = 0;
/** 是否已经降级到 HTTP 兼容模式。 */
let httpFallback = false;
/** 建连超时（1.8s 还没 open 就降级）的定时器；0 表示没有在等。 */
let websocketFallbackTimer = 0;
/** WS 重连定时器；0 表示没有在等。 */
let websocketRetryTimer = 0;
/** 正在飞的轮询请求（同一时刻只允许一个）。 */
let roomStatePollPromise: Promise<void> | undefined;
/** 上一次真正发出轮询请求的时刻（Date.now()）。 */
let lastRoomStatePollAt = 0;
/** 上一次带上 presence=1 的时刻（Date.now()）。 */
let lastPresenceSyncAt = 0;

/**
 * 建立（或重建）WS 连接。
 *
 * 1.8s 内没 open 就降级成 HTTP 轮询；onerror / onclose 都会再排一次重连。
 * 消息不在这里解释：解析完、确认还属于当前上下文与当前 socket 之后，整条交给
 * bridge.onSocketMessage()，由 app.ts 决定怎么改对局状态。
 */
export function connectSocket(code: string, contextVersion = getBridge().gameContextVersion(), preserveFallback = false): void {
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();
  if (!preserveFallback) {
    stopPolling();
    httpFallback = false;
  }
  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  let nextSocket: WebSocket;
  try {
    nextSocket = new WebSocket(`${wsProtocol}://${location.host}/ws?code=${encodeURIComponent(code)}`);
  } catch {
    startHttpFallback(code, contextVersion);
    scheduleSocketReconnect(code, contextVersion);
    return;
  }
  socket = nextSocket;
  if (websocketFallbackTimer) window.clearTimeout(websocketFallbackTimer);
  websocketFallbackTimer = window.setTimeout(() => {
    if (getBridge().isOnlineContext(code, contextVersion) && nextSocket.readyState !== WebSocket.OPEN) startHttpFallback(code, contextVersion);
  }, 1800);
  nextSocket.onopen = () => {
    if (!getBridge().isOnlineContext(code, contextVersion) || socket !== nextSocket) {
      nextSocket.close();
      return;
    }
    if (websocketFallbackTimer) window.clearTimeout(websocketFallbackTimer);
    if (websocketRetryTimer) window.clearTimeout(websocketRetryTimer);
    websocketRetryTimer = 0;
    stopPolling();
    httpFallback = false;
    startReconcilePolling(code, contextVersion);
    nextSocket.send(JSON.stringify({ type: "joinRoom", code, playerId: getBridge().selfId(), token: getBridge().authToken() || undefined }));
  };
  nextSocket.onmessage = (event) => {
    if (!getBridge().isOnlineContext(code, contextVersion) || socket !== nextSocket) return;
    let msg: any;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    getBridge().onSocketMessage(code, msg, (payload) => nextSocket.send(JSON.stringify(payload)));
  };
  nextSocket.onerror = () => {
    if (getBridge().isOnlineContext(code, contextVersion)) {
      startHttpFallback(code, contextVersion);
      scheduleSocketReconnect(code, contextVersion);
    }
  };
  nextSocket.onclose = () => {
    if (socket === nextSocket) socket = undefined;
    if (getBridge().isOnlineContext(code, contextVersion) && getBridge().game()?.status !== "ended") {
      startHttpFallback(code, contextVersion);
      scheduleSocketReconnect(code, contextVersion);
    }
  };
}

/**
 * 断开当前 WS 并清空句柄（beginGameContextSwitch 用：换上下文时不留旧连接）。
 * 等价于原来 app.ts 里那三行 `const previousSocket = socket; socket = undefined; previousSocket?.close();`。
 */
export function closeSocket(): void {
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();
}

function scheduleSocketReconnect(code: string, contextVersion = getBridge().gameContextVersion()): void {
  if (websocketRetryTimer || !getBridge().isOnlineContext(code, contextVersion) || getBridge().game()?.status === "ended") return;
  websocketRetryTimer = window.setTimeout(() => {
    websocketRetryTimer = 0;
    if (!getBridge().isOnlineContext(code, contextVersion) || getBridge().game()?.status === "ended") return;
    if (socket?.readyState === WebSocket.OPEN) return;
    connectSocket(code, contextVersion, true);
  }, WEBSOCKET_RETRY_INTERVAL_MS);
}

function startHttpFallback(code: string, contextVersion = getBridge().gameContextVersion()): void {
  if (httpFallback || !getBridge().isOnlineContext(code, contextVersion) || getBridge().game()?.status === "ended") return;
  toast("WebSocket 不可用，已切换为 HTTP 兼容模式");
  ensureHttpPolling(code, contextVersion);
  scheduleSocketReconnect(code, contextVersion);
  const count = getBridge().takePendingOnlineBots();
  if (count > 0) {
    for (let i = 0; i < count; i++) void httpPost(`/api/rooms/${code}/bots`, { ownerId: getBridge().selfId() });
  }
}

function ensureHttpPolling(code: string, contextVersion = getBridge().gameContextVersion()): void {
  if (!getBridge().isOnlineContext(code, contextVersion)) return;
  httpFallback = true;
  stopReconcilePolling();
  if (pollInterval) return;
  void pollRoomState(code, contextVersion, true);
  pollInterval = window.setInterval(() => void pollRoomState(code, contextVersion), HTTP_FALLBACK_POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollInterval) window.clearInterval(pollInterval);
  pollInterval = 0;
}

export function startHeartbeat(): void {
  if (heartbeatInterval) return;
  const code = getBridge().room()?.code;
  const contextVersion = getBridge().gameContextVersion();
  if (!code || !getBridge().isOnlineContext(code, contextVersion)) return;
  const heartbeat = () => {
    if (!getBridge().isOnlineContext(code, contextVersion)) {
      stopHeartbeat();
      return;
    }
    if (getBridge().game()?.status === "ended") {
      stopHeartbeat();
      return;
    }
    if (socket?.readyState === WebSocket.OPEN && getBridge().selfId()) {
      socket.send(JSON.stringify({ type: "heartbeat", code, playerId: getBridge().selfId() }));
    }
  };
  heartbeat();
  heartbeatInterval = window.setInterval(heartbeat, WEBSOCKET_HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatInterval) window.clearInterval(heartbeatInterval);
  heartbeatInterval = 0;
}

export function startReconcilePolling(code: string, contextVersion = getBridge().gameContextVersion()): void {
  stopReconcilePolling();
  if (httpFallback || !getBridge().isOnlineContext(code, contextVersion)) return;
  reconcileInterval = window.setInterval(() => {
    if (getBridge().isOnlineContext(code, contextVersion)) void pollRoomState(code, contextVersion);
  }, WEBSOCKET_RECONCILE_INTERVAL_MS);
}

function stopReconcilePolling(): void {
  if (reconcileInterval) window.clearInterval(reconcileInterval);
  reconcileInterval = 0;
}

export function stopOnlineTimers(): void {
  stopPolling();
  stopReconcilePolling();
  stopHeartbeat();
  httpFallback = false;
  lastRoomStatePollAt = 0;
  lastPresenceSyncAt = 0;
  if (websocketFallbackTimer) window.clearTimeout(websocketFallbackTimer);
  websocketFallbackTimer = 0;
  if (websocketRetryTimer) window.clearTimeout(websocketRetryTimer);
  websocketRetryTimer = 0;
}

async function pollRoomState(code: string, contextVersion = getBridge().gameContextVersion(), force = false): Promise<void> {
  if (!getBridge().selfId() || !getBridge().isOnlineContext(code, contextVersion)) return;
  if (roomStatePollPromise) return roomStatePollPromise;
  const now = Date.now();
  const minimumDelay = document.hidden
    ? HTTP_POLL_HIDDEN_MIN_DELAY_MS
    : getBridge().game()?.status === "playing" || getBridge().game()?.status === "opening-exchange"
      ? HTTP_POLL_PLAYING_MIN_DELAY_MS
      : HTTP_POLL_LOBBY_MIN_DELAY_MS;
  if (!force && now - lastRoomStatePollAt < minimumDelay) return;
  lastRoomStatePollAt = now;
  const playerId = getBridge().selfId();
  const includePresence = now - lastPresenceSyncAt >= HTTP_PRESENCE_SYNC_INTERVAL_MS;
  if (includePresence) lastPresenceSyncAt = now;
  let request!: Promise<void>;
  request = (async () => {
    try {
      const data = await httpGet(
        `/api/rooms/${code}/state?playerId=${encodeURIComponent(playerId)}${includePresence ? "&presence=1" : ""}`,
      );
      if (!getBridge().isOnlineContext(code, contextVersion)) return;
      getBridge().applyServerPayload(data);
    } catch (error) {
      if (includePresence) lastPresenceSyncAt = 0;
      if (
        getBridge().isOnlineContext(code, contextVersion) &&
        error instanceof Error &&
        (error.message.includes("没有权限操作该席位") ||
          error.message.includes("席位不存在") ||
          error.message.includes("房间不存在或已回收"))
      ) {
        // 房间可能是房主解散的，也可能是最后一名玩家离开后被回收的，这里给一个通用的说法。
        getBridge().leaveRemovedRoom(error.message.includes("不存在") ? "房间已解散或已被回收" : undefined);
      }
      // Other failures retry on the next interval without noisy intranet toasts.
    } finally {
      if (roomStatePollPromise === request) roomStatePollPromise = undefined;
    }
  })();
  roomStatePollPromise = request;
  return request;
}

export async function sendOnlineMessage(wsMessage: Record<string, unknown>, httpPath: string, body: Record<string, unknown>): Promise<void> {
  const code = getBridge().room()?.code;
  const contextVersion = getBridge().gameContextVersion();
  if (!code || !getBridge().isOnlineContext(code, contextVersion)) return;
  if (!httpFallback && socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(wsMessage));
      return;
    } catch {
      startHttpFallback(code, contextVersion);
    }
  }
  try {
    ensureHttpPolling(code, contextVersion);
    const data = await httpPost(httpPath, body);
    if (!getBridge().isOnlineContext(code, contextVersion)) return;
    getBridge().applyServerPayload(data, { sound: true });
  } catch (error) {
    if (!getBridge().isOnlineContext(code, contextVersion)) return;
    if (error instanceof Error && error.message.includes("决斗房间已自动解散")) {
      getBridge().leaveRemovedRoom("决斗房间已自动解散");
      return;
    }
    toast(error instanceof Error ? error.message : "请求失败");
  }
}
