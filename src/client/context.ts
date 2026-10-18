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
import type { AnyGameState, CardId } from "../shared/types.js";
import type { PublicUser, RoomSummary, SettingsTab, UserRequestView } from "./types.js";

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
};

let installed: AppBridge | undefined;

export function installBridge(next: AppBridge): void {
  installed = next;
}

export function getBridge(): AppBridge {
  if (!installed) throw new Error("app bridge 尚未安装：被拆出去的模块只能在 app.ts 启动之后调用");
  return installed;
}
