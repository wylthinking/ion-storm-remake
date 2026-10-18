/**
 * DialogState 弹窗渲染器（S2 拆分，分三批搬入：内联小弹窗 → 用户/权限/额度表单 → 批量发积分与编辑房间）。
 *
 * 这些函数原来是 app.ts 里的一串 `render*Dialog(state)`，由 renderDialog() 按
 * dialog.kind 分派。**dispatch 还留在 app.ts**：dialog.kind 有 27 个分支，
 * 等 rules-editor / 邀请码 / 激活码那几块也拆出去（S3）之后 dispatcher 再整体搬过来。
 *
 * 共享状态一律走 context.ts 的 getBridge()：
 *   currentUser / managedUsers / requests / room / game / selfId / reservedRoomCodesByUser
 *   permissionsSnapshot / taxSettings / customRulesByHash / enabledCustomPresets
 * 不 import app.ts 的任何运行时值；纯算法（排序链、房间额度上限）放在 format.ts 共用。
 *
 * HTML 与 data-act 名字逐字保留，bind() / handleAct() 不需要改动。
 */
import { customDealHasAnyFill, customDealMinimumGlobalFill, customDeckForPlayerCount, requiredPlayersFromDeal } from "../shared/custom-rules-types.js";
import { maxInitialHandSize } from "../shared/engine.js";
import { canDownloadWinMusic, canManageWinMusic, canPlayDownloadedWinMusic, canPlayWinMusic } from "../shared/music-access.js";
import type { CustomMaxBaseBetRule, CustomModeLimitGrant, CustomSettlementCapRule } from "../shared/custom-limits.js";
import { DEFAULT_OPENING_EXCHANGE_SEC, DEFAULT_TURN_TIME_LIMIT_SEC, MAX_ROOM_TIME_LIMIT_SEC, MIN_ROOM_TIME_LIMIT_SEC } from "../shared/room-limits.js";
import { getBridge } from "./context.js";
import { escapeAttr, escapeHtml, inputValue, selectValue } from "./dom.js";
import { customInitialHandSizeMax, editRoomBetHintText, effectiveCustomMaxBaseBet, effectiveMaxBaseBet, formatAverage, formatSignedInteger, hasPlayerCountDeckOverrides, pointDeltaClass, roleOptions, sortReservedRoomCodes, sortUsersForLeaderboard, toLocalDateTime, usersTotalPoints } from "./format.js";
import type { CustomLimitKind, DialogState, DuelLimitPeriod, DuelLimitRule, PermissionRule, PublicUser } from "./types.js";

/** 专属房间号的增删改权限：超级管理员全权；本人可删；管理员可删普通/高级用户的号。 */
function reservedRoomCodeAccess(target: PublicUser): { canAdd: boolean; canEdit: boolean; canDelete: boolean } {
  const self = getBridge().currentUser();
  const own = self?.id === target.id;
  const adminTarget = target.role === "advanced" || target.role === "normal";
  const admin = Boolean(self && (self.role === "admin" || self.role === "admin-advanced") && adminTarget && !target.superAdmin);
  return { canAdd: Boolean(self?.superAdmin), canEdit: Boolean(self?.superAdmin), canDelete: Boolean(own || self?.superAdmin || admin) };
}

export function renderReservedRoomCodesDialog(state: Extract<DialogState, { kind: "reserved-room-codes" }>): string {
  const bridge = getBridge();
  const currentUser = bridge.currentUser();
  const target = bridge.managedUsers().find((user) => user.id === state.userId) ?? (currentUser?.id === state.userId ? currentUser : undefined);
  if (!target) return "";
  const codes = sortReservedRoomCodes(state.codes ?? bridge.reservedRoomCodesByUser().get(target.id) ?? target.reservedRoomCodes ?? []);
  const access = reservedRoomCodeAccess(target);
  const editing = state.editingCode;
  // 个人中心的入口也是这个弹窗（userId 就是自己），所以自己看自己时换一句说明：号码由激活码/邀请码发放，
  // 普通用户只能删不能加（access.canAdd 只有超级管理员为真）。
  const isSelf = currentUser?.id === target.id;
  const selfNote = access.canAdd
    ? " · 你可以直接新增、修改或删除"
    : " · 号码由激活码或邀请码发放，这里只能删除；删除后该号码会被回收";
  return `
    <div class="modal-backdrop">
      <section class="modal panel reserved-codes-dialog">
        <div class="modal-head"><h2>专属房间号</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        <p class="dialog-subtitle">${escapeHtml(target.nickname)} / @${escapeHtml(target.username)}${isSelf ? selfNote : !access.canAdd && access.canDelete ? " · 你可以删除允许范围内的专属房间号" : ""}</p>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="reserved-code-list">
          ${codes.length ? codes.map((code) => `<div class="reserved-code-item"><strong>${escapeHtml(code)}</strong>${access.canEdit && editing === code ? `<input id="reservedRoomCodeEdit" inputmode="numeric" value="${escapeAttr(code)}" aria-label="编辑专属房间号" />` : ""}<div class="reserved-code-actions">${access.canEdit ? `<button class="btn ghost" data-act="edit-reserved-room-code" data-code="${escapeAttr(code)}">${editing === code ? "取消编辑" : "编辑"}</button>${editing === code ? `<button class="btn primary" data-act="save-reserved-room-code" data-code="${escapeAttr(code)}">保存</button>` : ""}` : ""}${access.canDelete ? `<button class="btn ghost danger" data-act="delete-reserved-room-code" data-code="${escapeAttr(code)}">删除</button>` : ""}</div></div>`).join("") : `<p class="muted">暂无专属房间号。</p>`}
        </div>
        ${access.canAdd ? `<div class="reserved-code-add"><div class="field"><label>新增专属房间号</label><input id="reservedRoomCodeNew" inputmode="numeric" placeholder="输入房间号" /></div><button class="btn primary" data-act="add-reserved-room-code">添加</button></div>` : ""}
      </section>
    </div>`;
}

export function renderWinMusicDialog(state: Extract<DialogState, { kind: "win-music" }>): string {
  // 个人中心的入口带的是 currentUser.id，而普通用户不会去拉 /api/users，managedUsers 里未必有自己，
  // 所以退回到 currentUser（和 renderReservedRoomCodesDialog 一样的兜底）。
  const currentUser = getBridge().currentUser();
  const user = getBridge().managedUsers().find((item) => item.id === state.userId) ?? (currentUser?.id === state.userId ? currentUser : undefined);
  if (!user) return "";
  const access = winMusicControlAccess(user, currentUser);
  const uploaded = user.hasWinMusic;
  return `
    <div class="modal-backdrop">
      <section class="modal panel win-music-dialog">
        <div class="modal-head"><h2>胜利音效</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        <p class="muted">${escapeHtml(user.nickname)} / @${escapeHtml(user.username)}</p>
        <div class="win-music-actions">
          <button class="btn" data-act="play-music" data-user-id="${escapeAttr(user.id)}" ${uploaded && access.canPlay ? "" : "disabled"}>播放音效</button>
          <button class="btn primary" data-act="upload-music" data-user-id="${escapeAttr(user.id)}" ${access.canManage ? "" : "disabled"}>上传音效</button>
          <button class="btn" data-act="download-music" data-user-id="${escapeAttr(user.id)}" ${uploaded && access.canDownload ? "" : "disabled"}>下载音效</button>
          <button class="btn danger" data-act="delete-music" data-user-id="${escapeAttr(user.id)}" ${uploaded && access.canManage ? "" : "disabled"}>删除音效</button>
        </div>
        <p class="muted win-music-limit">音效不能超过15s或10MB</p>
      </section>
    </div>
  `;
}

export function renderLogoutDialog(): string {
  return `
    <div class="modal-backdrop">
      <section class="modal panel password-confirm-dialog">
        <div class="modal-head"><h2>退出登录</h2><button class="btn ghost" data-act="dialog-close">取消</button></div>
        <p class="muted">确定退出当前账号并返回主界面吗？</p>
        <div class="top-actions">
          <button class="btn" data-act="dialog-close">取消</button>
          <button class="btn danger" data-act="confirm-logout">确定</button>
        </div>
      </section>
    </div>
  `;
}

export function renderDisableUserDialog(state: Extract<DialogState, { kind: "disable-user" }>): string {
  const user = getBridge().managedUsers().find((item) => item.id === state.userId);
  if (!user) return "";
  const currentUser = getBridge().currentUser();
  const superAdmin = Boolean(currentUser?.superAdmin);
  const selfSuperAdmin = Boolean(currentUser?.superAdmin && currentUser.id === user.id);
  const accountMode = user.disabledPermanent ? "permanent" : user.disabledUntil ? "temporary" : "none";
  const leaderboardMode = user.leaderboardHiddenPermanent ? "permanent" : user.leaderboardHiddenUntil ? "temporary" : "none";
  const scope = selfSuperAdmin ? "leaderboard" : superAdmin && user.hiddenFromLeaderboard && !user.disabled ? "leaderboard" : "account";
  return `
    <div class="modal-backdrop">
      <section class="modal panel disable-dialog">
        <div class="modal-head"><h2>禁用设置</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div id="accountBanWarning" class="ban-warning ${scope === "account" ? "" : "is-hidden"}">账号禁用后仍可登录和进行本地游戏，但不能创建或加入联机房间。</div>
        <div id="leaderboardBanWarning" class="ban-warning leaderboard-only-warning ${scope === "leaderboard" ? "" : "is-hidden"}">${selfSuperAdmin ? "超级管理员只能将自己限期或永久从排行榜移除，不会禁用账号功能。" : "仅从排行榜移除不会限制登录、联机、游戏或其他账号功能。"}</div>
        <div class="setup-grid modal-grid">
          <div class="field"><label>用户</label><input value="${escapeAttr(user.nickname)} / @${escapeAttr(user.username)}" disabled /></div>
          ${superAdmin ? `<div class="field"><label>禁用范围</label><select id="banScope" ${selfSuperAdmin ? "disabled" : ""}>${selfSuperAdmin ? "" : `<option value="account" ${scope === "account" ? "selected" : ""}>账号禁用</option>`}<option value="leaderboard" ${scope === "leaderboard" ? "selected" : ""}>仅从排行榜上移除</option></select></div>` : ""}
          <div id="accountBanFields" class="ban-field-group ${scope === "account" ? "" : "is-hidden"}">
            <div class="field"><label>账号禁用方式</label><select id="banAccountMode"><option value="none" ${accountMode === "none" ? "selected" : ""}>不禁用</option><option value="temporary" ${accountMode === "temporary" ? "selected" : ""}>限时禁用</option><option value="permanent" ${accountMode === "permanent" ? "selected" : ""}>永久禁用</option></select></div>
            ${dateTimeField("banAccountUntil", "账号禁用截止时间", user.disabledUntil, { wrapperId: "banAccountUntilField", hidden: accountMode !== "temporary" })}
            ${superAdmin ? `<div id="banHideLeaderboardField" class="field ${accountMode === "none" ? "is-hidden" : ""}"><label>禁用期间从排行榜移除</label><select id="banHideLeaderboard"><option value="false" ${user.hideFromLeaderboardWhileDisabled ? "" : "selected"}>否</option><option value="true" ${user.hideFromLeaderboardWhileDisabled ? "selected" : ""}>是</option></select></div>` : ""}
          </div>
          ${superAdmin
      ? `<div id="leaderboardBanFields" class="ban-field-group ${scope === "leaderboard" ? "" : "is-hidden"}">
                 <div class="field"><label>排行榜移除方式</label><select id="banLeaderboardMode"><option value="none" ${leaderboardMode === "none" ? "selected" : ""}>不禁用</option><option value="temporary" ${leaderboardMode === "temporary" ? "selected" : ""}>限时禁用</option><option value="permanent" ${leaderboardMode === "permanent" ? "selected" : ""}>永久禁用</option></select></div>
                 ${dateTimeField("banLeaderboardUntil", "排行榜移除截止时间", user.leaderboardHiddenUntil, { wrapperId: "banLeaderboardUntilField", hidden: leaderboardMode !== "temporary" })}
               </div>`
      : ""
    }
        </div>
        <div class="top-actions"><button class="btn warn" data-act="submit-user-disable" data-user-id="${escapeAttr(user.id)}">保存禁用设置</button></div>
      </section>
    </div>
  `;
}

export function renderDeleteUserDialog(state: Extract<DialogState, { kind: "delete-user" }>): string {
  const user = getBridge().managedUsers().find((item) => item.id === state.userId);
  if (!user) return "";
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>删除用户</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <p class="muted">将删除 ${escapeHtml(user.nickname)} / @${escapeHtml(user.username)}，该操作不可撤销。</p>
        <div class="top-actions"><button class="btn warn" data-act="submit-user-delete" data-user-id="${escapeAttr(user.id)}">确认删除</button></div>
      </section>
    </div>
  `;
}

export function renderRequestDialog(state: Extract<DialogState, { kind: "request" }>): string {
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>工单/申请</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>类型</label><select id="requestKind"><option value="ticket">工单</option><option value="unban">解封申请</option><option value="nickname">昵称修改</option></select></div>
          <div class="field"><label>仅超级管理员</label><select id="requestPrivate"><option value="false">否</option><option value="true">是</option></select></div>
          <div class="field wide is-hidden" id="requestNicknameField"><label>新昵称</label><input id="requestNickname" maxlength="24" /></div>
          <div class="field wide" id="requestTextField"><label>内容</label><textarea id="requestText" rows="5"></textarea></div>
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-request">提交</button></div>
      </section>
    </div>
  `;
}

export function renderReviewTicketDialog(state: Extract<DialogState, { kind: "review-ticket" }>): string {
  const request = getBridge().requests().find((item) => item.id === state.requestId);
  if (!request) return "";
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>批复工单</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <p class="muted">${escapeHtml(request.requestedNickname ?? request.text)}</p>
        <div class="field"><label>处理结果</label><select id="ticketStatus">${request.kind === "nickname"
      ? `<option value="approved">通过昵称修改</option>`
      : request.kind === "unban"
        ? `<option value="approved">解除禁用</option>`
        : ""
    }<option value="replied">回复</option><option value="ignored">忽略</option></select></div>
        <div class="field"><label>回复内容</label><textarea id="ticketReply" rows="5"></textarea></div>
        <div class="top-actions"><button class="btn primary" data-act="submit-ticket-review" data-request-id="${escapeAttr(request.id)}">提交批复</button></div>
      </section>
    </div>
  `;
}

export function renderKickPlayerDialog(state: Extract<DialogState, { kind: "kick-player" }>): string {
  const target = getBridge().room()?.players.find((player) => player.id === state.playerId);
  if (!target) return "";
  return `
    <div class="modal-backdrop">
      <section class="modal panel kick-dialog">
        <div class="modal-head"><h2>移出房间</h2><button class="btn ghost" data-act="dialog-close">取消</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="kick-target">
          <span class="kick-target-mark">${target.bot ? "AI" : "员"}</span>
          <div><strong>${escapeHtml(target.nickname)}</strong><small>${target.bot ? "机器人" : "已加入成员"}</small></div>
        </div>
        <p class="muted">确认后该成员会立即返回主界面并释放席位。游戏进行过程中不能移出任何成员或机器人。</p>
        <div class="top-actions">
          <button class="btn" data-act="dialog-close">取消</button>
          <button class="btn danger" data-act="confirm-kick-player" data-player-id="${escapeAttr(target.id)}">确认移出</button>
        </div>
      </section>
    </div>
  `;
}

export function renderLeaveRoomDialog(state: Extract<DialogState, { kind: "leave-room" }>): string {
  const bridge = getBridge();
  const game = bridge.game();
  const room = bridge.room();
  const target = state.local ? game?.players[0] : room?.players.find((player) => player.id === bridge.selfId());
  if (state.disband) {
    return `
    <div class="modal-backdrop">
      <section class="modal panel kick-dialog">
        <div class="modal-head"><h2>解散房间</h2><button class="btn ghost" data-act="dialog-close">取消</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="kick-target">
          <span class="kick-target-mark">散</span>
          <div><strong>${escapeHtml(room?.code ?? "当前房间")}</strong><small>${bridge.currentUser()?.id === room?.creatorAccountId ? "你是房主" : "你是房间里最后一名玩家"}</small></div>
        </div>
        <p class="muted">解散后房间会立即从服务器删除并释放房间号，房间里所有玩家都会被请回主界面${game && game.status !== "ended" ? "，当前对局直接作废" : ""}。</p>
        <div class="top-actions">
          <button class="btn" data-act="dialog-close">取消</button>
          <button class="btn danger" data-act="confirm-disband-room">确认解散</button>
        </div>
      </section>
    </div>
  `;
  }
  return `
    <div class="modal-backdrop">
      <section class="modal panel kick-dialog">
        <div class="modal-head"><h2>退出房间</h2><button class="btn ghost" data-act="dialog-close">取消</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="kick-target">
          <span class="kick-target-mark">退</span>
          <div><strong>${escapeHtml(target?.nickname ?? "当前玩家")}</strong><small>${state.local ? "本地游戏" : "你的房间席位"}</small></div>
        </div>
        <p class="muted">${state.local ? "退出本地游戏将刷新页面并返回主界面。" : "退出后会立即返回主界面，并由 AI 接替你当前的房间席位。"}</p>
        <div class="top-actions">
          <button class="btn" data-act="dialog-close">取消</button>
          <button class="btn danger" data-act="confirm-leave-room" data-local="${state.local ? "true" : "false"}">确认退出</button>
        </div>
      </section>
    </div>
  `;
}

export function renderRoomEditNoticeDialog(state: Extract<DialogState, { kind: "room-edit-notice" }>): string {
  if (state.notice.problems?.length) {
    return `
      <div class="modal-backdrop">
        <section class="modal panel room-edit-notice">
          <div class="notice-orbit"><span>受限</span></div>
          <div>
            <span class="dialog-kicker">房间通知</span>
            <h2>房间设置不符合开房者权限</h2>
            <p class="muted">该房间由 ${escapeHtml(state.notice.updatedByNickname)} 创建，当前设置已不符合开房者的权限限制，游戏无法开始。</p>
          </div>
          <ul class="room-problem-list">
            ${state.notice.problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}
          </ul>
          <div class="top-actions"><button class="btn primary" data-act="dialog-close">我知道了</button></div>
        </section>
      </div>
    `;
  }
  return `
    <div class="modal-backdrop">
      <section class="modal panel room-edit-notice">
        <div class="notice-orbit"><span>已更新</span></div>
        <div>
          <span class="dialog-kicker">房间通知</span>
          <h2>房间设置已修改</h2>
          <p class="muted">${escapeHtml(state.notice.updatedByNickname)} 更新了房间设置。</p>
        </div>
        <div class="room-edit-summary">
          <div><span>总玩家数</span><strong>${state.notice.capacity}</strong></div>
          <div><span>底注</span><strong>${state.notice.baseBet}</strong></div>
          <div><span>初始手牌</span><strong>${state.notice.initialHandSize ?? "默认"}</strong></div>
          <div><span>出牌时间</span><strong>${state.notice.turnTimeLimitSec ?? "默认"}</strong></div>
          <div><span>换牌时间</span><strong>${state.notice.openingExchangeSec ?? "默认"}</strong></div>
        </div>
        <div class="top-actions"><button class="btn primary" data-act="dialog-close">我知道了</button></div>
      </section>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// 共用的小构件
// ---------------------------------------------------------------------------

/**
 * datetime-local 输入 + 「清空」按钮。原来在 app.ts 里，S3 的 admin-codes.ts
 * （邀请码/激活码弹窗）也用它，所以从这里 export。
 */
export function dateTimeField(
  inputId: string,
  label: string,
  value?: string,
  options: { wrapperId?: string; wrapperClass?: string; hidden?: boolean } = {},
): string {
  return `
    <div ${options.wrapperId ? `id="${options.wrapperId}"` : ""} class="field ${options.wrapperClass ?? ""} ${options.hidden ? "is-hidden" : ""}">
      <label>${label}</label>
      <div class="date-input-group">
        <input id="${inputId}" type="datetime-local" value="${escapeAttr(toLocalDateTime(value))}" />
        <button class="btn" type="button" data-act="clear-date" data-target="${inputId}">清空</button>
      </div>
    </div>
  `;
}

/** 胜利音效的四个动作各自能不能用（判定逻辑都在 shared/music-access.ts）。 */
function winMusicControlAccess(user: PublicUser, self?: PublicUser): { canManage: boolean; canDownload: boolean; canPlay: boolean } {
  return {
    canManage: Boolean(self && user.hasAdvancedPerk && canManageWinMusic(self, user)),
    canDownload: Boolean(self && user.hasWinMusic && canDownloadWinMusic(self, user)),
    canPlay: Boolean(self && user.hasWinMusic && ((user.hasAdvancedPerk && canPlayWinMusic(self, user)) || canPlayDownloadedWinMusic(self, user))),
  };
}

// ---------------------------------------------------------------------------
// 第二批：用户管理 / 权限 / 税收
//
// 这批里除了两个弹窗，还有一组「纯字段构造器」（权限、决斗次数、自定义额度、身份到期时间）。
// 它们不读任何状态，只按入参拼 HTML，但邀请码/激活码弹窗（S3 的 admin-codes.ts）也要用，
// 所以统一从这里 export。
// ---------------------------------------------------------------------------

/**
 * 「编辑用户」弹窗（设置 → 用户管理 → 某一行的「编辑」）。这是管理员工具，只管别人的管理属性：
 * 昵称颜色 / 积分 / 最高征税比例 / 头衔 / 高级 AI / 用户权限 / 自定义模式额度 / 禁止自改昵称 / 身份。
 *
 * 昵称、用户名、新密码这三个「个人资料」字段刻意不在这里出现（它们只在 renderProfileDialog 里）：
 * 两个弹窗字段集不重叠，管理员从这个弹窗保存时不可能改到别人的昵称或密码。
 * 保存共用 saveUserFromDialog，它按「元素在不在」取字段，不存在的字段不会进 patch。
 */
export function renderEditUserDialog(state: Extract<DialogState, { kind: "edit-user" }>): string {
  const user = getBridge().managedUsers().find((item) => item.id === state.userId);
  if (!user) return "";
  const self = getBridge().currentUser();
  const canSuperManage = Boolean(self?.superAdmin && !user.superAdmin);
  const canAdminManage = Boolean(self && (self.role === "admin" || self.role === "admin-advanced") && user.role !== "admin" && user.role !== "admin-advanced" && !user.superAdmin);
  const isSelf = self?.id === user.id;
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>编辑用户</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <p class="muted">正在编辑：<strong style="color:${escapeAttr(user.nicknameColor)}">${escapeHtml(user.nickname)}</strong> <span class="username-text">@${escapeHtml(user.username)}</span></p>
        <div class="setup-grid modal-grid">
          <div class="field"><label>昵称颜色</label><input id="editNicknameColor" maxlength="7" value="${escapeAttr(user.nicknameColor)}" ${self?.superAdmin ? "" : "disabled"} /></div>
          <div class="field"><label>积分</label><input id="editPoints" type="number" step="1" value="${user.points}" ${self?.superAdmin ? "" : "disabled"} /></div>
          ${self?.superAdmin ? renderEditTaxRateFields(user) : ""}
          <div class="field"><label>头衔</label><input id="editTitle" maxlength="24" value="${escapeAttr(user.title ?? "")}" ${self?.superAdmin ? "" : "disabled"} /></div>
          ${self?.superAdmin ? renderEditAdvancedAiFields(user) : ""}
          ${self?.superAdmin
      ? `<div class="field"><label>用户权限</label><select id="editPermissionMode"><option value="default" ${user.permissionOverride ? "" : "selected"}>使用身份组默认</option><option value="custom" ${user.permissionOverride ? "selected" : ""}>自定义权限</option></select></div>
               <div id="editPermissionFields" class="invite-permission-fields ${user.permissionOverride ? "" : "is-hidden"}">
                 ${renderPermissionFields("edit", user.permissionOverride ?? user.permissions)}
                 ${renderEditPermissionExpiryFields(user)}
               </div>
               <div class="field wide"><label>自定义模式额度</label><select id="editCustomModeLimitMode"><option value="default" ${user.customModeLimitOverride ? "" : "selected"}>使用全局最高设置</option><option value="custom" ${user.customModeLimitOverride ? "selected" : ""}>单独设置</option></select><small>这项设置独立于用户权限。</small></div>
               <div id="editCustomModeLimitFields" class="invite-permission-fields ${user.customModeLimitOverride ? "" : "is-hidden"}">
                 ${renderCustomModeLimitFields("editCustomMode", user.customModeLimitOverride ?? user.customModeLimits)}
                 ${renderEditCustomModeLimitExpiryFields(user)}
               </div>`
      : ""
    }
          ${!isSelf && (canSuperManage || canAdminManage)
      ? `<div class="field"><label>允许用户自行修改昵称</label><select id="editNicknameChangeDisabled"><option value="false" ${user.nicknameChangeDisabled ? "" : "selected"}>允许</option><option value="true" ${user.nicknameChangeDisabled ? "selected" : ""}>禁止</option></select></div>`
      : ""
    }
          ${renderEditRoleFields(user, canSuperManage, canAdminManage)}
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-user-edit" data-user-id="${escapeAttr(user.id)}">保存</button></div>
      </section>
    </div>
  `;
}

/**
 * 「编辑个人资料」弹窗（个人中心 → 编辑个人资料）。只放账号本人有权改的字段：昵称 + 新密码。
 * 昵称颜色 / 头衔 / 积分 / 身份都是超级管理员权限（服务端 updateUser 里有必须 superAdmin 的检查），
 * 硬塞进来只会让普通用户点了保存被服务端打回，所以不放。
 * 保存刻意复用 saveUserFromDialog：字段 id（editNickname / editPassword）和它读的一致，
 * data-act 也用同一个 submit-user-edit，因此不需要第二条保存路径，密码确认那一步也照旧。
 * 字段集和「编辑用户」（renderEditUserDialog）严格不重叠：昵称 / 用户名 / 新密码只在这里，
 * 管理属性（颜色、积分、税率、头衔、AI、权限、额度、身份）只在那边。
 */
export function renderProfileDialog(state: Extract<DialogState, { kind: "profile-edit" }>): string {
  const user = getBridge().currentUser();
  if (!user) return "";
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>编辑个人资料</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>昵称</label><input id="editNickname" maxlength="24" value="${escapeAttr(user.nickname)}" ${user.nicknameChangeDisabled ? "disabled" : ""} />${user.nicknameChangeDisabled ? `<small>该账号已被禁止自行修改昵称，请提交昵称修改工单。</small>` : ""}</div>
          <div class="field"><label>用户名</label><input value="@${escapeAttr(user.username)}" disabled /><small>用户名不可修改。</small></div>
          <div class="field wide"><label>新密码</label><input id="editPassword" type="password" maxlength="72" placeholder="留空则不修改" /><small>保存时需要验证当前密码（下一步会弹出确认框）。</small></div>
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-user-edit" data-user-id="${escapeAttr(user.id)}">保存</button></div>
      </section>
    </div>
  `;
}

export function renderEditRoleFields(user: PublicUser, canSuperManage: boolean, canAdminManage: boolean): string {
  if (canSuperManage) {
    return `
      ${renderUserRoleGrantFields("Admin", "管理员", user.adminPermanent, user.adminExpiresAt)}
      ${renderUserRoleGrantFields("Advanced", "高级用户", user.advancedPermanent, user.advancedExpiresAt)}
    `;
  }
  if (canAdminManage && !user.advancedPermanent) {
    return dateTimeField("editAdvancedExpiresAt", "高级用户截止时间", user.advancedExpiresAt, { wrapperClass: "wide" });
  }
  return "";
}

export function renderEditPermissionExpiryFields(user: PublicUser): string {
  const permanent = user.permissionOverridePermanent ?? true;
  const expiresAt = user.permissionOverrideExpiresAt;
  const mode = permanent ? "permanent" : expiresAt ? "absolute" : "relative";
  return `
    <div class="field"><label>权限覆盖期限方式</label><select id="editPermissionExpiryMode">
      <option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option>
      <option value="relative" ${mode === "relative" ? "selected" : ""}>相对时长</option>
      <option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option>
    </select></div>
    <div id="editPermissionExpiryRelativeField" class="field ${mode === "relative" ? "" : "is-hidden"}"><label>权限覆盖相对时长</label><div class="compound-input"><input id="editPermissionExpiryDurationAmount" type="number" min="1" step="1" value="30" /><select id="editPermissionExpiryDurationUnit"><option value="day" selected>日</option><option value="hour">小时</option></select></div></div>
    ${dateTimeField("editPermissionExpiryExpiresAt", "权限覆盖截止时间", expiresAt, { wrapperId: "editPermissionExpiryAbsoluteField", hidden: mode !== "absolute" })}
  `;
}

export function renderEditCustomModeLimitExpiryFields(user: PublicUser): string {
  const permanent = user.customModeLimitOverridePermanent ?? true;
  const expiresAt = user.customModeLimitOverrideExpiresAt;
  const mode = permanent ? "permanent" : expiresAt ? "absolute" : "relative";
  return `
    <div class="field"><label>自定义模式额度期限</label><select id="editCustomModeLimitExpiryMode">
      <option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option>
      <option value="relative" ${mode === "relative" ? "selected" : ""}>相对时长</option>
      <option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option>
    </select></div>
    <div id="editCustomModeLimitExpiryRelativeField" class="field ${mode === "relative" ? "" : "is-hidden"}"><label>相对时长</label><div class="compound-input"><input id="editCustomModeLimitExpiryDurationAmount" type="number" min="1" step="1" value="30" /><select id="editCustomModeLimitExpiryDurationUnit"><option value="day" selected>日</option><option value="hour">小时</option></select></div></div>
    ${dateTimeField("editCustomModeLimitExpiryExpiresAt", "自定义模式额度截止时间", expiresAt, { wrapperId: "editCustomModeLimitExpiryAbsoluteField", hidden: mode !== "absolute" })}
  `;
}

export function renderUserRoleGrantFields(id: "Admin" | "Advanced", label: string, permanent: boolean, expiresAt?: string): string {
  const mode = permanent ? "permanent" : expiresAt ? "absolute" : "default";
  return `
    <div class="field"><label>${label}身份</label><select id="edit${id}Mode">
      <option value="default" ${mode === "default" ? "selected" : ""}>不授予</option>
      <option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option>
      <option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option>
    </select></div>
    ${dateTimeField(`edit${id}ExpiresAt`, `${label}截止时间`, expiresAt, {
    wrapperId: `edit${id}AbsoluteField`,
    hidden: mode !== "absolute",
  })}
  `;
}

export function renderEditAdvancedAiFields(user: PublicUser): string {
  const mode = user.advancedAiPermanent ? "permanent" : user.advancedAiExpiresAt ? "absolute" : "none";
  return `
    <div class="field"><label>高级 AI 权限</label><select id="editAdvancedAiMode" ${user.superAdmin ? "disabled" : ""}>
      <option value="none" ${mode === "none" ? "selected" : ""}>不授予</option>
      <option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止日期</option>
      <option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久授予</option>
    </select></div>
    ${dateTimeField("editAdvancedAiExpiresAt", "高级 AI 截止日期", user.advancedAiExpiresAt, { wrapperId: "editAdvancedAiAbsoluteField", hidden: mode !== "absolute" })}
  `;
}

export function renderEditTaxRateFields(user: PublicUser): string {
  const mode = user.taxRatePercent === undefined ? "default" : "custom";
  return `
    <div class="field"><label>用户最高征税比例</label><select id="editTaxRateMode">
      <option value="default" ${mode === "default" ? "selected" : ""}>使用全局设置</option>
      <option value="custom" ${mode === "custom" ? "selected" : ""}>单独设置</option>
    </select></div>
    <div id="editTaxRateField" class="field ${mode === "custom" ? "" : "is-hidden"}"><label>最高征税比例（%）</label><input id="editTaxRatePercent" type="number" min="-1" max="100" step="1" value="${user.taxRatePercent ?? 10}" /><small class="calculated-hint">-1 表示不征税；非整数税收向下取整。</small></div>
  `;
}

export function renderTaxSettingsDialog(state: Extract<DialogState, { kind: "tax-settings" }>): string {
  const taxSettings = getBridge().taxSettings();
  const percent = taxSettings?.taxRatePercent ?? 10;
  const threshold = taxSettings?.taxWinnerPointsThreshold;
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>税收管理</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        <p class="dialog-subtitle">胜利者税收会先按底注公式计算，再用本比例限制为获胜者原本可得积分的对应百分比。</p>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>最高征税比例（%）</label><input id="globalTaxRatePercent" type="number" min="-1" max="100" step="1" value="${percent}" /><small class="calculated-hint">范围 -1 到 100；-1 表示不征税。默认按本次需求为 10%。</small></div>
          <div class="field"><label>仅对税前积分高于此值的赢家征税</label><input id="globalTaxWinnerPointsThreshold" type="number" step="1" value="${threshold ?? ""}" placeholder="留空则对全部用户征税" /><small class="calculated-hint">按获胜者获得结算积分后、扣税前的积分判断；必须严格大于该值才征税。</small></div>
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-tax-settings">保存税收设置</button></div>
      </section>
    </div>
  `;
}

export function renderPermissionsDialog(state: Extract<DialogState, { kind: "permissions" }>): string {
  const rule = getBridge().permissionsSnapshot()?.rolePermissions.normal ?? defaultPermissionRule();
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>权限设置</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>身份组</label><select id="permRole">${roleOptions("normal", true)}</select></div>
          ${renderPermissionFields("perm", rule)}
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-permissions">保存权限</button></div>
      </section>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// 纯字段构造器（权限 / 决斗次数 / 自定义模式额度）
// ---------------------------------------------------------------------------

function defaultPermissionRule(): PermissionRule {
  return {
    exchangeMin: 0,
    exchangeMax: 3,
    canCreateZeroBaseBet: false,
    maxBaseBet: 100,
    duelLimit: { period: "hour", count: 1 },
  };
}

/** 最大换牌数的下拉项；-1 表示不限。 */
function exchangeMaxOptions(selected: number | null | undefined): string {
  const value = selected === null ? -1 : selected ?? 3;
  const options = [0, 1, 2, 3, 4, 5, -1];
  if (!options.includes(value)) options.splice(options.length - 1, 0, value);
  return options
    .map((option) => `<option value="${option}" ${option === value ? "selected" : ""}>${option < 0 ? "不限" : option}</option>`)
    .join("");
}

export function customLimitModes(kind: CustomLimitKind): Array<{ value: string; label: string }> {
  return kind === "customMaxBaseBet"
    ? [
      { value: "absolute", label: "固定整数" },
      { value: "classic-multiple", label: "经典最大底注×倍率" },
      { value: "unlimited", label: "不限" },
    ]
    : [
      { value: "absolute", label: "固定积分" },
      { value: "base-bet-multiple", label: "底注×倍率" },
      { value: "unlimited", label: "不限" },
    ];
}

function renderCustomLimitFields(prefix: string, kind: CustomLimitKind, label: string, rule: CustomMaxBaseBetRule | CustomSettlementCapRule | undefined, options: { partial?: boolean } = {}): string {
  const partial = Boolean(options.partial);
  const isDefault = partial && rule === undefined;
  const mode = isDefault ? "default" : (rule?.mode ?? "unlimited");
  const rawValue = rule && "value" in rule ? rule.value : rule && "factor" in rule ? rule.factor : 1;
  const showValue = mode === "absolute" || mode === "classic-multiple" || mode === "base-bet-multiple";
  const inputId = `${prefix}${kind === "customMaxBaseBet" ? "CustomMaxBet" : "CustomCap"}`;
  return `
    <div class="field"><label>${label}</label><select id="${inputId}Mode">
      ${partial ? `<option value="default" ${isDefault ? "selected" : ""}>默认</option>` : ""}
      ${customLimitModes(kind).map((entry) => `<option value="${entry.value}" ${mode === entry.value ? "selected" : ""}>${entry.label}</option>`).join("")}
    </select></div>
    <div id="${inputId}ValueField" class="field ${showValue ? "" : "is-hidden"}"><label>数值</label><input id="${inputId}Value" type="number" min="0" step="any" value="${rawValue ?? 1}" /></div>
  `;
}

export function renderCustomModeLimitFields(prefix: string, limits?: CustomModeLimitGrant, options: { partial?: boolean } = {}): string {
  return `
    ${renderCustomLimitFields(prefix, "customMaxBaseBet", "自定义模式最大底注", limits?.maxBaseBet, options)}
    ${renderCustomLimitFields(prefix, "customSettlementCap", "每名输家扣分上限（按开房者）", limits?.settlementCap, options)}
    <p class="calculated-hint">开局时冻结开房者的额度；每名输家最多扣除此额度，赢家获得全部实际扣分，积分总量保持不变。</p>
  `;
}

export function duelLimitForDisplay(rule?: Partial<DuelLimitRule>): DuelLimitRule {
  const period = rule?.period ?? "hour";
  if (period === "none") return { period, count: 0 };
  if (period === "unlimited") return { period, count: null };
  if (period === "day" || period === "week" || period === "hour") {
    const count = Number(rule?.count ?? 1);
    return { period, count: Number.isInteger(count) && count > 0 ? count : 1 };
  }
  return { period: "hour", count: 1 };
}

export function duelPeriodLabel(period: DuelLimitPeriod): string {
  if (period === "hour") return "每小时";
  if (period === "day") return "每天";
  if (period === "week") return "每周";
  if (period === "none") return "不允许决斗";
  return "不限";
}

function renderDuelLimitFields(prefix: string, rule?: Partial<DuelLimitRule>, options: { partial?: boolean } = {}): string {
  const partial = Boolean(options.partial);
  const normalized = duelLimitForDisplay(rule);
  const selected = partial && rule === undefined ? "default" : normalized.period;
  const count = normalized.count ?? 1;
  const showCount = selected === "hour" || selected === "day" || selected === "week";
  return `
    <div class="field"><label>决斗次数</label><select id="${prefix}DuelPolicy">
      ${partial ? `<option value="default" ${selected === "default" ? "selected" : ""}>默认</option>` : ""}
      <option value="none" ${selected === "none" ? "selected" : ""}>不允许决斗</option>
      <option value="hour" ${selected === "hour" ? "selected" : ""}>每小时</option>
      <option value="day" ${selected === "day" ? "selected" : ""}>每天</option>
      <option value="week" ${selected === "week" ? "selected" : ""}>每周</option>
      <option value="unlimited" ${selected === "unlimited" ? "selected" : ""}>不限</option>
    </select></div>
    <div id="${prefix}DuelCountField" class="field ${showCount ? "" : "is-hidden"}"><label>周期内可创建</label><div class="compound-input"><input id="${prefix}DuelCount" type="number" min="1" step="1" value="${count}" /><span>次</span></div></div>
  `;
}

export function renderPermissionFields(prefix: string, permissions?: Partial<PermissionRule>, options: { partial?: boolean } = {}): string {
  const partial = Boolean(options.partial);
  const exchangeDefault = partial && permissions?.exchangeMax === undefined;
  const zeroDefault = partial && permissions?.canCreateZeroBaseBet === undefined;
  const maxBaseBetDefault = partial && permissions?.maxBaseBet === undefined;
  return `
    <div class="field"><label>最大换牌数</label><select id="${prefix}ExchangeMaxMode" class="${partial ? "" : "is-hidden"}"><option value="default" ${exchangeDefault ? "selected" : ""}>默认</option><option value="custom" ${exchangeDefault ? "" : "selected"}>指定</option></select><select id="${prefix}ExchangeMax" class="${partial && exchangeDefault ? "is-hidden" : ""}">${exchangeMaxOptions(permissions?.exchangeMax)}</select></div>
    <div class="field"><label>允许 0 底注</label><select id="${prefix}ZeroBet">${partial ? `<option value="default" ${zeroDefault ? "selected" : ""}>默认</option>` : ""}<option value="false" ${!zeroDefault && !permissions?.canCreateZeroBaseBet ? "selected" : ""}>否</option><option value="true" ${!zeroDefault && permissions?.canCreateZeroBaseBet ? "selected" : ""}>是</option></select></div>
    <div class="field"><label>最大底注</label><select id="${prefix}MaxBaseBetMode" class="${partial ? "" : "is-hidden"}"><option value="default" ${maxBaseBetDefault ? "selected" : ""}>默认</option><option value="custom" ${maxBaseBetDefault ? "" : "selected"}>指定</option></select><input id="${prefix}MaxBaseBet" class="${partial && maxBaseBetDefault ? "is-hidden" : ""}" type="number" min="0" step="1" placeholder="不限" value="${permissions?.maxBaseBet ?? ""}" /></div>
    ${renderDuelLimitFields(prefix, permissions?.duelLimit, { partial })}
  `;
}

// ---------------------------------------------------------------------------
// 批量发积分 / 编辑房间（S2 第三批）
//
// 排序链与房间额度上限已提到 format.ts，这里直接 import，不再复制第二份实现。
// 用户列表 / 房间 / 当前用户 / 规则缓存 / 预设列表全部走 getBridge()。
// ---------------------------------------------------------------------------

export function renderBulkGrantPointsDialog(state: Extract<DialogState, { kind: "bulk-grant-points" }>): string {
  const managedUsers = getBridge().managedUsers();
  const users = sortUsersForLeaderboard(managedUsers);
  const selected = new Set(state.selectedUserIds ?? []);
  const selectedCount = selected.size;
  const mode = selectValue("bulkGrantMode") ?? "random";
  const totalPoints = Number(inputValue("bulkGrantTotalPoints") ?? 0);
  const perUserPoints = Number(inputValue("bulkGrantPerUserPoints") ?? 0);
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog bulk-grant-dialog">
        <div class="modal-head"><h2>一键发放积分</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        <p class="dialog-subtitle">玩家总积分数：${usersTotalPoints(managedUsers)}</p>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="bulk-grant-toolbar"><label class="bulk-select-all"><input id="bulkSelectAll" type="checkbox" ${selectedCount === users.length && users.length ? "checked" : ""}/> 全选</label><span class="muted">已选择 ${selectedCount} 人</span></div>
        <div class="user-table-wrap bulk-user-select-table"><table class="user-table bulk-grant-user-table"><thead><tr><th class="select-col">选择</th><th class="numeric-col">今日对局积分变化</th><th>昵称</th><th>用户名</th><th class="numeric-col">积分</th></tr></thead><tbody>${users.map((user) => `<tr><td class="select-col"><input type="checkbox" data-bulk-user="${escapeAttr(user.id)}" ${selected.has(user.id) ? "checked" : ""}/></td><td class="numeric-col ${pointDeltaClass(user.todayGamePointsDelta ?? 0)}">${formatSignedInteger(user.todayGamePointsDelta ?? 0)}</td><td title="${escapeAttr(user.nickname)}"><strong style="color:${escapeAttr(user.nicknameColor)}">${escapeHtml(user.nickname)}</strong></td><td title="${escapeAttr(user.username)}"><span class="username-text">@${escapeHtml(user.username)}</span></td><td class="numeric-col">${user.points}</td></tr>`).join("")}</tbody></table></div>
        <div class="bulk-grant-controls">
          <div class="field"><label>发放模式</label><select id="bulkGrantMode"><option value="random" ${mode === "random" ? "selected" : ""}>瓜分</option><option value="equal" ${mode === "equal" ? "selected" : ""}>均分</option></select></div>
          <div id="bulkGrantRandomField" class="field ${mode === "random" ? "" : "is-hidden"}"><label>发放总积分数</label><input id="bulkGrantTotalPoints" type="number" step="1" value="${Number.isFinite(totalPoints) && totalPoints ? totalPoints : ""}" /><small id="bulkGrantAverageHint" class="calculated-hint">人均获得：${selectedCount ? formatAverage(totalPoints / selectedCount) : 0}</small></div>
          <div id="bulkGrantEqualField" class="field ${mode === "equal" ? "" : "is-hidden"}"><label>每个人得到的积分数</label><input id="bulkGrantPerUserPoints" type="number" step="1" value="${Number.isFinite(perUserPoints) && perUserPoints ? perUserPoints : ""}" /><small id="bulkGrantTotalHint" class="calculated-hint">总发放积分数：${selectedCount * (Number.isFinite(perUserPoints) ? perUserPoints : 0)}</small></div>
          <button class="btn primary bulk-grant-submit" data-act="submit-bulk-grant-points">发放</button>
        </div>
      </section>
    </div>`;
}

export function renderEditRoomDialog(state: Extract<DialogState, { kind: "edit-room" }>): string {
  const room = getBridge().room();
  if (!room) return "";
  const currentUser = getBridge().currentUser();
  const currentMembers = room.players.length;
  const minimum = Math.max(2, currentMembers);
  const customMode = room.rulesetMode === "custom";
  const gameActive = room.status === "playing" || room.status === "opening-exchange";
  const minimumBaseBet = currentUser?.permissions.canCreateZeroBaseBet ? 0 : 1;
  const maximumBaseBet = customMode ? effectiveCustomMaxBaseBet(currentUser) : effectiveMaxBaseBet(currentUser);
  const betHint = editRoomBetHintText(currentUser, room.capacity, room.initialHandSize ?? undefined);
  const roomRules = customMode && room.customRulesHash ? getBridge().customRulesByHash(room.customRulesHash) : undefined;
  const hasPlayerCountDeckRules = hasPlayerCountDeckOverrides(roomRules);
  const dealRequired = roomRules ? requiredPlayersFromDeal(roomRules, room.capacity) : null;
  const activeRoomDeal = roomRules ? customDeckForPlayerCount(roomRules, room.capacity).deal : undefined;
  const customRoomHandEditable = Boolean(roomRules) && !customDealHasAnyFill(activeRoomDeal);
  const customRoomHandMinimum = customDealMinimumGlobalFill(activeRoomDeal);
  const capacityLocked = !hasPlayerCountDeckRules && dealRequired !== null && dealRequired >= minimum;
  const customRuleLabel = (room.customPresetId
    ? getBridge().enabledCustomPresets().find((preset) => preset.id === room.customPresetId)?.displayName
    : undefined) ?? roomRules?.displayName ?? roomRules?.name ?? "当前房间规则";
  return `
    <div class="modal-backdrop">
      <section class="modal panel room-edit-dialog">
        <div class="modal-head"><div><span class="dialog-kicker">房主设置</span><h2>编辑房间 ${escapeHtml(room.code)}</h2></div><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="room-edit-summary">
          <div><span>当前成员</span><strong>${currentMembers}</strong></div>
          <div><span>当前容量</span><strong>${room.capacity}</strong></div>
          <div><span>当前底注</span><strong>${room.baseBet ?? 5}</strong></div>
          <div><span>全局补足</span><strong>${customMode && !customRoomHandEditable ? "由席位规则决定" : room.initialHandSize ?? "规则默认"}</strong></div>
          <div><span>出牌时间</span><strong>${room.turnTimeLimitSec ?? "默认"}</strong></div>
          <div><span>换牌时间</span><strong>${room.openingExchangeSec ?? "默认"}</strong></div>
        </div>
        <div class="setup-grid room-edit-fields">
          <div class="field"><label>${customMode ? "总玩家数" : "总玩家数（含 AI）"}</label><input id="editRoomCapacity" type="number" min="${minimum}" max="10" step="1" value="${capacityLocked ? dealRequired : room.capacity}" ${capacityLocked ? "disabled" : ""} /><small>${capacityLocked ? `规则按 ${dealRequired} 个座位规定了初始发牌，人数固定为 ${dealRequired} 人` : hasPlayerCountDeckRules ? "可设置范围内的不同人数会使用 JSON 中对应的牌堆与初始发牌设置。" : `可设置范围：${minimum}-10${customMode ? "；同时必须在自定义规则允许的人数范围内" : ""}`}</small></div>
          <div class="field"><label>底注</label><input id="editRoomBaseBet" type="number" min="${minimumBaseBet}" ${maximumBaseBet === null ? "" : `max="${maximumBaseBet}"`} step="1" value="${room.baseBet ?? 5}" /><small>允许范围：${minimumBaseBet}-${maximumBaseBet ?? "不限"}${customMode ? "" : "；总发牌数达到 101 张时上限会降低"}；修改将在下一局开始时生效</small></div>
          ${customMode
      ? customRoomHandEditable && roomRules
        ? `<div class="field"><label>全局补足手牌数</label><input id="editRoomInitialHandSize" type="number" inputmode="numeric" min="${customRoomHandMinimum}" max="${customInitialHandSizeMax(roomRules, room.capacity)}" step="1" placeholder="规则默认" value="${room.initialHandSize ?? ""}" /><small id="editRoomInitialHandSizeHint">规则未设置席位补足数，可设 ${customRoomHandMinimum}-${customInitialHandSizeMax(roomRules, room.capacity)}；该值将用于所有玩家；修改将在下一局生效</small></div>`
        : `<div class="field"><label>全局补足手牌数</label><input type="text" value="${roomRules ? "由 JSON 规则的席位补足数决定" : "正在加载规则快照"}" disabled /></div>`
      : `<div class="field"><label>初始手牌数量</label><input id="editRoomInitialHandSize" type="number" inputmode="numeric" min="2" max="${maxInitialHandSize(room.capacity)}" step="1" placeholder="默认" value="${room.initialHandSize ?? ""}" /><small id="editRoomInitialHandSizeHint">留空使用规则默认；按总玩家数可设 2-${maxInitialHandSize(room.capacity)}；修改将在下一局开始时生效</small></div>`
    }
          <div class="field"><label>出牌时间（秒）</label><input id="editRoomTurnTimeLimit" type="number" inputmode="numeric" min="${MIN_ROOM_TIME_LIMIT_SEC}" max="${MAX_ROOM_TIME_LIMIT_SEC}" step="1" placeholder="默认 ${DEFAULT_TURN_TIME_LIMIT_SEC}" value="${room.turnTimeLimitSec ?? ""}" /><small>留空使用默认 ${DEFAULT_TURN_TIME_LIMIT_SEC} 秒；可设 ${MIN_ROOM_TIME_LIMIT_SEC}-${MAX_ROOM_TIME_LIMIT_SEC}；修改将在下一局开始时生效</small></div>
          <div class="field"><label>换牌时间（秒）</label><input id="editRoomOpeningExchangeTime" type="number" inputmode="numeric" min="${MIN_ROOM_TIME_LIMIT_SEC}" max="${MAX_ROOM_TIME_LIMIT_SEC}" step="1" placeholder="默认 ${DEFAULT_OPENING_EXCHANGE_SEC}" value="${room.openingExchangeSec ?? ""}" /><small>留空使用默认 ${DEFAULT_OPENING_EXCHANGE_SEC} 秒；可设 ${MIN_ROOM_TIME_LIMIT_SEC}-${MAX_ROOM_TIME_LIMIT_SEC}；修改将在下一局开始时生效</small></div>
          ${customMode
      ? `<div class="field wide"><label>自定义规则</label><div class="rules-picker"><span>${escapeHtml(customRuleLabel)}</span><button class="btn" type="button" data-act="edit-room-rules" ${gameActive ? "disabled" : ""}>编辑自定义规则</button></div><small>${gameActive ? "对局进行中不能修改规则；当前局规则设置不变" : "保存后由服务器重新解析校验，所有人需重新确认"}</small></div>`
      : ""
    }
        </div>
        ${customMode ? "" : `<p id="editRoomBetHint" class="${betHint.className}">${escapeHtml(betHint.text)}</p>`}
        <p class="room-edit-hint">保存后，当前房间内的所有真人玩家都会收到设置变更通知。</p>
        <div class="top-actions"><button class="btn" data-act="dialog-close">取消</button><button class="btn primary" data-act="submit-room-edit">保存设置</button></div>
      </section>
    </div>
  `;
}
