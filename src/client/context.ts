/**
 * 拆分后的模块与 app.ts 之间的唯一通道（S0 地基）。
 *
 * 为什么需要它：ESM 里 `export let game` 只能被别的模块「读」，不能赋值；
 * 而 app.ts 的 ~120 个模块级状态要被各处读写。与其把上千处引用改成 `state.game`，
 * 不如反向注册：app.ts 保持状态的所有权，把「读状态 / 触发重渲染 / 开关浮层」
 * 以回调形式装进这里，拆出去的模块只调用这些回调。
 *
 * 约定：
 * 1. 拆出去的模块**只能**通过 getBridge() 访问应用状态，不得直接 import app.ts 的运行时值
 *    （`import type` 是例外：类型在编译后被完全擦除，不会产生运行时循环依赖）。
 * 2. app.ts 在启动、第一次 render() 之前调用 installBridge()。
 * 3. 调用方拿到的永远是最新值（回调闭包读的是 app.ts 里的当前变量），不做快照。
 */
import type { ResolvedCustomRules } from "../shared/custom-rules-types.js";
import type { CustomModeLimits } from "../shared/custom-limits.js";
import type { AnyGameState, CardId } from "../shared/types.js";
import type { PublicUser, ActivationCode, CustomPresetFull, CustomPresetMeta, InvitationCode, PermissionsSnapshot, RoomSummary, ServerPayload, SettingsTab, TaxSettings, UserRequestView } from "./types.js";

export type ClientGame = AnyGameState;

export type AppBridge = {
  /** 当前对局；不在对局里就是 undefined。 */
  game(): ClientGame | undefined;
  /** 当前房间（联机模式才有）。 */
  room(): RoomSummary | undefined;
  /** 当前登录用户；未登录是 undefined。 */
  currentUser(): PublicUser | undefined;
  /** 本机玩家 id（localStorage 里的 ionStormPlayerId）。 */
  selfId(): string;
  /** 当前主题色（设置里改过就是新值）。 */
  themeColor(): string;
  /** 当前对局生效的自定义规则；经典模式是 undefined（等价于 app.ts 的 customRulesOf(game)）。 */
  customRules(): ResolvedCustomRules | undefined;
  /** 手牌里当前选中的下标；没有选中是 null。 */
  selectedHandIndex(): number | null;
  /** 当前选中的牌（"all" 是动作筛选那张「全部」）。 */
  selectedCard(): CardId | "all";
  /** 这张手牌是不是 AI 建议的那张：返回 "ai-suggested" 或空串（逻辑仍在 app.ts，读 advancedAi* 一组状态）。 */
  aiSuggestedCardClass(card: CardId): string;
  /** 整页重渲染（等价于 app.ts 的 render()）。 */
  render(): void;
  /** 设置弹窗当前选中的页签。 */
  currentSettingsTab(): SettingsTab;
  /** 切换设置弹窗页签（"用户管理" 无权限时 renderSettingsModal 会把它拨回 "general"，所以需要写入口）。 */
  setCurrentSettingsTab(tab: SettingsTab): void;
  /** 「用户管理」页签的加载错误（空串表示没有错误）。 */
  userPageError(): string;
  /** 「用户管理」表格的数据源。 */
  managedUsers(): PublicUser[];
  /** 「工单管理」页签的加载错误。 */
  ticketPageError(): string;
  /** 当前登录用户能看到的工单列表。 */
  requests(): UserRequestView[];
  /** 用户 id → 已从服务端拉到的专属房间号列表（app.ts 里的 Map，活引用）。 */
  reservedRoomCodesByUser(): Map<string, string[]>;
  /** 权限快照（「权限设置」弹窗与「编辑用户」共用）；未加载是 undefined。 */
  permissionsSnapshot(): PermissionsSnapshot | undefined;
  /** 全局税收设置（「税收管理」弹窗）；未加载是 undefined。 */
  taxSettings(): TaxSettings | undefined;
  /** 规则 hash → 本地缓存的已解析自定义规则（「编辑房间」读房间那份快照）。 */
  customRulesByHash(hash: string): ResolvedCustomRules | undefined;
  /** 已启用的规则预设列表（「编辑房间」显示预设名用）。 */
  enabledCustomPresets(): CustomPresetMeta[];
  // ---- S3（admin-codes.ts）：邀请码 / 激活码管理弹窗与「积分红包」弹窗 ----
  /** 邀请码列表（邀请码管理表格的数据源）。 */
  invitations(): InvitationCode[];
  /** 「邀请码管理」的加载错误。 */
  inviteModalError(): string;
  /** 激活码列表（激活码管理表格与积分红包的数据源）。 */
  activationCodes(): ActivationCode[];
  /** 「激活码管理」的加载错误。 */
  activationModalError(): string;
  /** 注册用户数：积分红包的领取人数上限按它算（0 表示还没拉到，回退到 managedUsers.length）。 */
  activationRegisteredUserCount(): number;
  // ---- S3（rules-editor.ts）：规则编辑器 / 规则预设 / 只读规则摘要 ----
  /** 当前能看的已解析规则：对局里那份优先，否则取房间的规则快照（等价于 app.ts 的 currentViewableRules()）。 */
  currentViewableRules(): ResolvedCustomRules | undefined;
  /** 「自定义模式设置」弹窗的预设全量列表；未加载是 undefined（渲染时回退成空数组）。 */
  customPresetsSnapshot(): CustomPresetFull[] | undefined;
  /** 「自定义模式设置」弹窗的全局自定义模式额度快照；未加载是 undefined。 */
  customModeLimitsSnapshot(): CustomModeLimits | undefined;
  // ---- S4（online.ts）：网络传输层 ----
  /** 当前登录 token（localStorage 里的 ionStormAuthToken）；未登录是空串。 */
  authToken(): string;
  // ---- S4 批次二（online.ts）：连接 / 重连 / 心跳 / 轮询状态机 ----
  /** 当前上下文版本号（只读；自增只发生在 app.ts 的 beginGameContextSwitch）。 */
  gameContextVersion(): number;
  /** 「版本号 + mode + room.code」是否仍是当前联机上下文；实现在 app.ts，全项目唯一一份。 */
  isOnlineContext(code: string, version: number): boolean;
  /**
   * 收到一条已解析的 WS 消息，原样交给 app.ts 处理（online.ts 不解释消息内容）。
   * code 是这条连接加入的房间码（回包 addBot / gameStartedAck 要用；不能用 room.code 现取，
   * 因为处理过程中 applyServerPayload 可能已经动过 room）。
   * reply 在这个 socket 上回包，等价于原来的 nextSocket.send(JSON.stringify(payload))。
   */
  onSocketMessage(code: string, message: any, reply: (payload: Record<string, unknown>) => void): void;
  /** HTTP 轮询 / HTTP 兼容模式拿到服务端回包后，交给 app.ts 合并进对局状态。 */
  applyServerPayload(data: ServerPayload, options?: { sound?: boolean }): void;
  /** 房间已解散 / 已被回收 / 自己不在席位里：清干净本地状态回主界面。 */
  leaveRemovedRoom(message?: string): void;
  /** 取出「待补建的 AI 数量」并清零（HTTP 兼容模式下改用 REST 逐个补建）。 */
  takePendingOnlineBots(): number;
};

let installed: AppBridge | undefined;

export function installBridge(next: AppBridge): void {
  installed = next;
}

export function getBridge(): AppBridge {
  if (!installed) throw new Error("app bridge 尚未安装：被拆出去的模块只能在 app.ts 启动之后调用");
  return installed;
}
