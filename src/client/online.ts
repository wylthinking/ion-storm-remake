/**
 * 网络传输层（S4 批次一）。
 *
 * 从 app.ts 搬出来的「怎么和后端说话」：设备 id / 浏览器指纹、请求头、响应解析，
 * 以及四个 http* 动词。它们只依赖一个应用状态（当前 token），所以只需要 context 的
 * 一个只读回调，其它全是本模块自己的东西：
 *   authToken()  ← 原来是直接读 app.ts 的 authToken
 *
 * 设备 id 与浏览器指纹原来是 app.ts 的模块级常量（`const deviceId = ensureDeviceId()`）。
 * 现在改成这里初始化：ESM 会先求值依赖模块，所以它们仍然在 app.ts 的模块体之前算好，
 * 计算次数、写入 localStorage / cookie 的时机都与原实现一样（各一次）。
 *
 * 注意：这里只搬「传输」，不含 WebSocket 连接与心跳/轮询的状态机——那部分读写
 * ~35 个应用状态，属于 app.ts 自己的状态机，仍在 app.ts 里。
 */
import { getBridge } from "./context.js";

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
