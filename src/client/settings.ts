/**
 * 设置弹窗（S2 拆分）。
 *
 * 三个页签共用同一个 .modal 外壳：常规设置 / 用户管理 / 工单管理。
 * HTML 结构与类名沿用原样，原有 data-act 名字一个都没改，所以 app.ts 的 bind()/handleAct()
 * 不需要任何改动。唯一的增量是「常规设置」里新增的两个本机开关（开始界面动画、合法操作提示），
 * 它们刻意用 data-setting-toggle 而不是 data-act，点击处理留在本文件（见下面的 document 监听），
 * 这样 app.ts 完全不用知道它们的存在。
 *
 * 这个模块读的全部是「账号 / 用户列表 / 工单列表」这类共享状态，
 * 一律走 context.ts 的 getBridge()：
 *   - currentUser / currentSettingsTab / setCurrentSettingsTab
 *   - userPageError / managedUsers / ticketPageError / requests / themeColor
 * 不 import app.ts 的任何运行时值（import type 是擦除的，允许）。
 */
import { audio } from "./audio.js";
import { getBridge } from "./context.js";
import { escapeAttr, escapeHtml } from "./dom.js";
import {
  DEFAULT_THEME_COLOR,
  expirySummary,
  formatDate,
  isAdminUser,
  requestKindLabel,
  requestStatusLabel,
  roleLabel,
} from "./format.js";
import { applyStartScreenAnimation, startScreenAnimationEnabled } from "./start-background.js";
import type { PublicUser, SettingsTab, UserRequestView } from "./types.js";

// ---------------------------------------------------------------------------
// 「常规设置」里的两个本机开关
//
// 状态只存 localStorage，不进账号、不走服务端：
//   ionStormStartAnimation  开始界面动画显示（读取在 start-background.ts，本模块只负责写）
//   ionStormLegalHighlight  合法操作提示（手牌高亮在 app.ts 里按同一个键读）
// 两个键都遵循同一套口径：没写过 = 开，"0" / "false" / "off" = 关。
// ---------------------------------------------------------------------------
const LEGAL_HIGHLIGHT_KEY = "ionStormLegalHighlight";

/**
 * 「合法操作提示」开关的读取口径，必须和 app.ts 里手牌高亮那份（legalHighlightEnabled）
 * 完全一致：没写过 = 开，"0" / "false" / "off" = 关。
 * app.ts 不 import 本模块（拆分后单向依赖），所以这条 3 行规则在两处各存一份，
 * 唯一的约定就是键名 ionStormLegalHighlight——改口径时要两边一起改。
 */
function legalHighlightSwitchOn(): boolean {
  const raw = (localStorage.getItem(LEGAL_HIGHLIGHT_KEY) ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * 两个开关的点击处理刻意留在这个模块，没有塞进 app.ts 的 handleAct()：
 * 它们只做「翻一下 localStorage → 立刻生效 → 整页重渲染一次」，不碰任何共享业务状态。
 * 按钮也刻意不用 data-act（app.ts 的 bind() 会给页面上所有 [data-act] 各绑一次点击），
 * 改用 data-setting-toggle，交给下面这个 document 级监听独占处理。
 * 监听只在模块加载时注册一次，#app 被整体重建也不会失效。
 */
function toggleLocalSetting(name: string): void {
  if (name === "start-animation") {
    localStorage.setItem("ionStormStartAnimation", startScreenAnimationEnabled() ? "0" : "1");
    // 立刻作用到已经挂在 #app 之外的那层幕布上，不用等下一次重建。
    applyStartScreenAnimation();
  } else if (name === "legal-highlight") {
    localStorage.setItem(LEGAL_HIGHLIGHT_KEY, legalHighlightSwitchOn() ? "0" : "1");
  } else {
    return;
  }
  // 重渲染一次让按钮文案/高亮状态跟着变；手牌高亮也会在这次渲染里按新开关重算。
  getBridge().render();
}

document.addEventListener("click", (event) => {
  const trigger = (event.target as Element | null)?.closest?.<HTMLElement>("[data-setting-toggle]");
  const name = trigger?.dataset.settingToggle;
  if (name) toggleLocalSetting(name);
});

/** 设置弹窗的「常规设置」页签：音效、开始界面动画、合法操作提示、主题色、关于项目。 */
function renderGeneralSettingsPane(): string {
  const color = getBridge().themeColor();
  const startAnimationOn = startScreenAnimationEnabled();
  const legalHighlightOn = legalHighlightSwitchOn();
  return `
    <div class="settings-group">
      <div class="settings-row">
        <div class="settings-row-text"><strong>音效</strong><span>出牌、发牌与回合提示音；关闭后全部静音。</span></div>
        <button class="btn ${audio.enabled ? "primary" : ""}" data-act="sound">${audio.enabled ? "已开启" : "已关闭"}</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-text"><strong>开始界面动画显示</strong><span>主界面背景的牌面缓慢滚动；关闭后牌面仍然随机铺满屏幕，但静止不动。</span></div>
        <button class="btn ${startAnimationOn ? "primary" : ""}" data-setting-toggle="start-animation">${startAnimationOn ? "已开启" : "已关闭"}</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-text"><strong>合法操作提示</strong><span>把手牌里打出去会和场上溶液区 / 生成物区反应的那几张标成主题色外发光。</span></div>
        <button class="btn ${legalHighlightOn ? "primary" : ""}" data-setting-toggle="legal-highlight">${legalHighlightOn ? "已开启" : "已关闭"}</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-text"><strong>主题色</strong><span>驱动主按钮与标题图标的主色，改动实时生效，只保存在本机。</span></div>
        <div class="settings-theme-controls">
          <input type="color" data-theme-color data-state-value value="${escapeAttr(color)}" aria-label="主题色取色器" />
          <input type="text" id="settingsThemeHex" data-theme-color data-state-value maxlength="7" spellcheck="false" placeholder="${DEFAULT_THEME_COLOR}" value="${escapeAttr(color)}" aria-label="主题色十六进制值" />
          <button class="btn" data-act="settings-theme-reset">恢复默认</button>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-text"><strong>关于项目</strong><span>项目版本、技术栈与最后更新日期。</span></div>
        <button class="btn" data-act="open-credits">关于项目</button>
      </div>
    </div>
  `;
}

/** 「用户管理」页签：表格 + 超级管理员工具条。 */
function renderUsersPane(): string {
  const self = getBridge().currentUser();
  const superAdmin = Boolean(self?.superAdmin);
  if (!self) return `<div class="panel management-denied">请先登录后管理用户。</div>`;
  // 工具条里剩下的按钮全是超级管理员功能，所以普通管理员（role=admin / admin-advanced）没有这一条；
  // 与其渲染一个空白的 .settings-toolbar（它自带 margin-bottom），不如整条不输出。
  const toolbar = superAdmin
    ? `<div class="settings-toolbar">
          <button class="btn" data-act="download-users-csv">下载 CSV</button>
          <button class="btn" data-act="go-invite">邀请码</button>
          <button class="btn" data-act="go-activation">激活码</button>
          <button class="btn" data-act="edit-permissions">权限</button>
          <button class="btn" data-act="edit-custom-presets">自定义模式</button>
          <button class="btn" data-act="edit-tax-settings">税收管理</button>
          <button class="btn" data-act="bulk-grant-points">批量操作</button>
        </div>`
    : "";
  const userPageError = getBridge().userPageError();
  return `
        ${toolbar}
        ${userPageError ? `<div class="form-error">${escapeHtml(userPageError)}</div>` : ""}
        <div class="user-table-wrap">
          <table class="user-table user-management-table">
            <thead>
              <tr>
                <th>昵称</th><th>用户名</th><th>总局</th><th>胜局</th><th>今日</th><th>积分</th><th>注册使用的邀请码</th><th>账号状态</th><th>身份</th><th>颜色</th><th class="management-expiry-column">到期</th><th>最后登录</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${getBridge().managedUsers().map((user) => renderUserRow(user, self)).join("")}
            </tbody>
          </table>
        </div>
  `;
}

function renderUserRow(user: PublicUser, self?: PublicUser): string {
  const isSelf = self?.id === user.id;
  const canSuperManage = Boolean(self?.superAdmin && !user.superAdmin);
  const canSelfLeaderboardManage = Boolean(self?.superAdmin && isSelf);
  const canAdminManage = Boolean(self && (self.role === "admin" || self.role === "admin-advanced") && user.role !== "admin" && user.role !== "admin-advanced" && !user.superAdmin);
  // 「编辑」在这里是管理员工具（身份/权限/自定义额度/高级 AI/税率/禁用范围），不是「编辑个人资料」——
  // 个人资料（昵称、密码）已移到个人中心，见 renderProfileDialog。
  // 「专属房间号」「胜利音效」原本挤在这一列里，现在也归个人中心（renderProfileModal 的两个入口）。
  return `
    <tr class="user-row" data-user-id="${escapeAttr(user.id)}">
      <td><strong style="color:${escapeAttr(user.nicknameColor)}">${escapeHtml(user.nickname)}</strong></td>
      <td><span class="username-text">@${escapeHtml(user.username)}</span></td>
      <td>${user.gamesPlayed}</td>
      <td>${user.gamesWon}</td>
      <td>${user.todayGamesWon}/${user.todayGamesPlayed}</td>
      <td>${user.points}</td>
      <td>${escapeHtml(user.inviteCodeUsed ?? "")}</td>
      <td>${user.disabled ? "账号已禁用" : user.hiddenFromLeaderboard ? "仅排行榜隐藏" : "正常"}${user.disabledPermanent || user.leaderboardHiddenPermanent ? " / 永久" : ""}${user.hideFromLeaderboardWhileDisabled && user.disabled ? " / 同步移出排行榜" : ""}${user.nicknameChangeDisabled ? " / 禁止自改昵称" : ""}</td>
      <td>${escapeHtml(roleLabel(user.role))}${user.subtitle ? ` / ${escapeHtml(user.subtitle)}` : ""}</td>
      <td>${escapeHtml(user.nicknameColor)}</td>
      <td class="management-expiry-column">${escapeHtml(expirySummary(user))}</td>
      <td>${user.lastLoginAt ? escapeHtml(formatDate(user.lastLoginAt)) : ""}</td>
      <td>
        <button class="btn primary" data-act="open-user-edit" data-user-id="${escapeAttr(user.id)}">编辑</button>
        ${canSuperManage || canAdminManage || canSelfLeaderboardManage ? `<button class="btn warn" data-act="open-user-disable" data-user-id="${escapeAttr(user.id)}">${user.disabled || user.hiddenFromLeaderboard ? "解禁/禁用" : "禁用"}</button>` : ""}
        ${canSuperManage ? `<button class="btn warn" data-act="delete-user" data-user-id="${escapeAttr(user.id)}">删除</button>` : ""}
      </td>
    </tr>
  `;
}

/** 「工单管理」页签。普通用户看到的是只读的自己的工单列表（列少一半）。 */
function renderTicketsPane(): string {
  const currentUser = getBridge().currentUser();
  if (!currentUser) return `<div class="panel management-denied">请先登录后查看工单。</div>`;
  const admin = isAdminUser(currentUser);
  // 普通用户这份是只读的：列少一半，且 renderTicketRow 的 !admin 分支根本不输出批复/忽略按钮。
  const columns = admin
    ? "<th>类型</th><th>提交用户</th><th>内容</th><th>范围</th><th>状态</th><th>提交时间</th><th>封禁时间</th><th>封禁截止</th><th>封禁执行者</th><th>回复时间</th><th>回复者</th><th>回复</th><th>操作</th>"
    : "<th>类型</th><th>内容</th><th>状态</th><th>提交时间</th><th>回复时间</th><th>回复</th>";
  const ticketPageError = getBridge().ticketPageError();
  const requests = getBridge().requests();
  return `
        <div class="settings-toolbar"><button class="btn primary" data-act="submit-ticket">提交工单/申请</button></div>
        ${ticketPageError ? `<div class="form-error">${escapeHtml(ticketPageError)}</div>` : ""}
        <div class="user-table-wrap">
          <table class="user-table">
            <thead><tr>${columns}</tr></thead>
            <tbody>${requests.length
      ? requests.map((request) => renderTicketRow(request, admin)).join("")
      : `<tr><td colspan="${admin ? 13 : 6}" class="muted">暂无工单记录</td></tr>`
    }</tbody>
          </table>
        </div>
  `;
}

function renderTicketRow(request: UserRequestView, admin: boolean): string {
  const managedUsers = getBridge().managedUsers();
  const from = managedUsers.find((user) => user.id === request.fromUserId);
  const replyUser = managedUsers.find((user) => user.id === request.replyUserId);
  const banUser = managedUsers.find((user) => user.id === request.banSnapshot?.disabledBy);
  if (!admin) {
    return `
      <tr>
        <td>${escapeHtml(requestKindLabel(request.kind))}</td>
        <td>${escapeHtml(request.requestedNickname ?? request.text)}</td>
        <td>${escapeHtml(requestStatusLabel(request.status))}</td>
        <td>${escapeHtml(formatDate(request.createdAt))}</td>
        <td>${request.repliedAt ? escapeHtml(formatDate(request.repliedAt)) : ""}</td>
        <td>${escapeHtml(request.reply ?? "")}</td>
      </tr>
    `;
  }
  return `
    <tr>
      <td>${escapeHtml(requestKindLabel(request.kind))}</td>
      <td>${escapeHtml(from ? `${from.nickname} / @${from.username}` : request.fromUserId)}</td>
      <td>${escapeHtml(request.requestedNickname ?? request.text)}</td>
      <td>${request.privateToSuperAdmin ? "仅超级管理员" : "管理员可见"}</td>
      <td>${escapeHtml(requestStatusLabel(request.status))}</td>
      <td>${escapeHtml(formatDate(request.createdAt))}</td>
      <td>${request.banSnapshot?.disabledAt ? escapeHtml(formatDate(request.banSnapshot.disabledAt)) : ""}</td>
      <td>${request.banSnapshot?.disabledPermanent ? "永久" : request.banSnapshot?.disabledUntil ? escapeHtml(formatDate(Date.parse(request.banSnapshot.disabledUntil))) : ""}</td>
      <td>${escapeHtml(banUser ? `${banUser.nickname} / @${banUser.username}` : request.banSnapshot?.disabledBy ?? "")}</td>
      <td>${request.repliedAt ? escapeHtml(formatDate(request.repliedAt)) : ""}</td>
      <td>${escapeHtml(replyUser ? `${replyUser.nickname} / @${replyUser.username}` : request.replyUserId ?? "")}</td>
      <td>${escapeHtml(request.reply ?? "")}</td>
      <td>${request.securityLogId ? `<button class="btn ai" data-act="download-security-log" data-log-id="${escapeAttr(request.securityLogId)}">下载日志</button>` : ""}${request.status === "open" ? `<button class="btn primary" data-act="review-ticket" data-request-id="${escapeAttr(request.id)}">${request.kind === "security" ? "忽略" : "批复"}</button>` : ""}</td>
    </tr>
  `;
}

/** 综合设置弹窗。三个页签共用同一个 .modal 外壳，内容由 currentSettingsTab 决定。 */
export function renderSettingsModal(): string {
  // 「用户管理」无权限就直接不渲染（不置灰）；「工单管理」所有登录用户都能进——普通用户看到的是
  // 只读的自己的工单列表（见 renderTicketsPane）。未登录时两个页签都不渲染。
  const currentUser = getBridge().currentUser();
  const canManage = isAdminUser(currentUser);
  const available = (tab: SettingsTab): boolean =>
    tab === "general" || (tab === "tickets" ? Boolean(currentUser) : canManage);
  // 停在一个当前身份看不到的页签上（弹窗开着时退出登录、别处直接写 currentSettingsTab）就地拨回「常规设置」。
  let activeTab = getBridge().currentSettingsTab();
  if (!available(activeTab)) {
    getBridge().setCurrentSettingsTab("general");
    activeTab = "general";
  }
  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "general", label: "常规设置" },
    { id: "users", label: "用户管理" },
    { id: "tickets", label: "工单管理" },
  ];
  const visibleTabs = tabs.filter((tab) => available(tab.id));
  const pane = activeTab === "users"
    ? renderUsersPane()
    : activeTab === "tickets"
      ? renderTicketsPane()
      : renderGeneralSettingsPane();
  return `
    <div class="modal-backdrop" data-backdrop-dismiss>
      <section class="modal panel settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <div class="modal-head">
          <h2 id="settingsTitle">设置</h2>
          <button class="btn ghost" data-act="modal-close">关闭</button>
        </div>
        <div class="settings-tabs" role="tablist">
          ${visibleTabs.map((tab) => {
    const active = activeTab === tab.id;
    return `<button class="btn settings-tab${active ? " active" : ""}" role="tab" aria-selected="${active}" data-act="settings-tab" data-tab="${tab.id}">${tab.label}</button>`;
  }).join("")}
        </div>
        <div class="settings-pane">${pane}</div>
      </section>
    </div>
  `;
}
