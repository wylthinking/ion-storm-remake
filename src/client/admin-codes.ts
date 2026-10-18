/**
 * 邀请码 / 激活码管理（S3 拆分）。
 *
 * 两块原来是 app.ts 里的独立页面（renderInvitePage / renderActivationPage + /invite、/activation
 * 短路分支），后来并成弹窗：结构是 .modal-backdrop > section.modal，因此直接吃到
 * #app.modal-entering 的入场动画。列很多（邀请码 16 列、激活码 16 列），宽度靠 .user-table-wrap 横滚。
 *
 * 这里放三样东西：
 *   1. 两个管理弹窗与两行渲染器（renderInviteModal / renderInviteRow / renderActivationModal / renderActivationRow）；
 *   2. 编辑邀请码、编辑激活码、积分红包、兑换、删除确认这几个 DialogState 渲染器；
 *   3. 一堆「把邀请码/激活码的字段翻译成表格文案」的纯汇总函数（原来紧挨着 app.ts 的绑定逻辑）。
 *
 * 共享状态一律走 context.ts 的 getBridge()，本模块只读不写：
 *   currentUser / invitations / inviteModalError / activationCodes / activationModalError /
 *   activationRegisteredUserCount / managedUsers
 * 纯函数共用：排序、金额格式化在 format.ts，字段构造器在 dialogs.ts。
 *
 * HTML 与 data-act 名字逐字保留，bind() / handleAct() 不需要改动。
 */
import { customMaxBaseBetSummary, customSettlementCapSummary, type CustomModeLimitGrant } from "../shared/custom-limits.js";
import type { UserRole } from "../shared/types.js";
import { getBridge } from "./context.js";
import { dateTimeField, duelLimitForDisplay, duelPeriodLabel, renderCustomModeLimitFields, renderPermissionFields } from "./dialogs.js";
import { escapeAttr, escapeHtml } from "./dom.js";
import { formatAverage, formatDate, invitationRoleIncludes, roleLabel, roleOptions, toLocalDateTime, usersTotalPoints } from "./format.js";
import type { ActivationCode, ActivationUsePolicy, DialogState, DuelLimitRule, InvitationCode, PermissionRule } from "./types.js";

/**
 * 「邀请码」弹窗。入口是「设置 → 用户管理」工具条上的「邀请码」。
 */
export function renderInviteModal(): string {
  const currentUser = getBridge().currentUser();
  const inviteModalError = getBridge().inviteModalError();
  const invitations = getBridge().invitations();
  const allowed = Boolean(currentUser?.superAdmin);
  const body = !allowed
    ? `<div class="panel management-denied">只有超级管理员可以访问邀请码管理。</div>`
    : `
        <div class="settings-toolbar"><button class="btn primary" data-act="new-invite">新邀请码</button></div>
        ${inviteModalError ? `<div class="form-error">${escapeHtml(inviteModalError)}</div>` : ""}
        <div class="user-table-wrap">
          <table class="user-table">
            <thead>
              <tr><th>邀请码</th><th>注册额度</th><th>已注册</th><th>失效时间</th><th>注册身份</th><th>初始积分</th><th>初始头衔</th><th>昵称颜色</th><th>专属房间号</th><th>初始权限</th><th>自定义模式额度</th><th>管理员期限</th><th>高级期限</th><th>高级 AI</th><th>创建时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              ${invitations.map(renderInviteRow).join("")}
            </tbody>
          </table>
        </div>
      `;
  return `
    <div class="modal-backdrop" data-backdrop-dismiss>
      <section class="modal panel invite-dialog" role="dialog" aria-modal="true" aria-labelledby="inviteTitle">
        <div class="modal-head"><h2 id="inviteTitle">邀请码管理</h2><button class="btn ghost" data-act="modal-close">关闭</button></div>
        ${body}
      </section>
    </div>
  `;
}

function renderInviteRow(invite: InvitationCode): string {
  return `
    <tr>
      <td>${escapeHtml(invite.code)}</td>
      <td>${escapeHtml(invitationUseSummary(invite))}</td>
      <td>${invite.registrations?.length ?? 0}</td>
      <td>${invite.expiresAt ? escapeHtml(formatDate(Date.parse(invite.expiresAt))) : "永久"}</td>
      <td>${escapeHtml(roleLabel(invite.role))}</td>
      <td>${invite.initialPoints}</td>
      <td>${escapeHtml(invite.initialTitle ?? "")}</td>
      <td>${escapeHtml(invite.initialNicknameColor ?? "")}</td>
      <td>${escapeHtml(reservedRoomCodeGrantSummary(invite.reservedRoomCodeMode))}</td>
      <td>${escapeHtml(invitationPermissionSummary(invite.permissions))}</td>
      <td>${escapeHtml(customModeLimitGrantSummary(invite.customModeLimits))}</td>
      <td>${escapeHtml(invitationGrantSummary(invite, "admin"))}</td>
      <td>${escapeHtml(invitationGrantSummary(invite, "advanced"))}</td>
      <td>${escapeHtml(advancedAiGrantSummary(invite))}</td>
      <td>${escapeHtml(formatDate(invite.createdAt))}</td>
      <td><button class="btn primary" data-act="edit-invite" data-code="${escapeAttr(invite.code)}">编辑</button><button class="btn danger" data-act="delete-invite" data-code="${escapeAttr(invite.code)}">删除</button></td>
    </tr>
  `;
}

/** 「激活码」弹窗。原独立页面（renderActivationPage + /activation）搬过来，理由同 renderInviteModal。 */
export function renderActivationModal(): string {
  const currentUser = getBridge().currentUser();
  const activationModalError = getBridge().activationModalError();
  const activationCodes = getBridge().activationCodes();
  const allowed = Boolean(currentUser?.superAdmin);
  const body = !allowed
    ? `<div class="panel management-denied">只有超级管理员可以访问激活码管理。</div>`
    : `
        <div class="settings-toolbar">
          <button class="btn primary" data-act="new-activation">新激活码</button>
          <button class="btn" data-act="grant-points">发送激活码红包</button>
          <button class="btn" data-act="bulk-grant-points">一键发放积分</button>
        </div>
        ${activationModalError ? `<div class="form-error">${escapeHtml(activationModalError)}</div>` : ""}
        <div class="user-table-wrap">
          <table class="user-table activation-management-table">
            <thead><tr><th>激活码</th><th>类型/策略</th><th>次数</th><th>滚动周期</th><th>失效时间</th><th>积分</th><th>头衔</th><th>昵称颜色</th><th>专属房间号</th><th>管理员</th><th>高级用户</th><th>高级 AI</th><th class="management-permission-column">权限</th><th>自定义模式额度</th><th>已使用</th><th>操作</th></tr></thead>
            <tbody>${activationCodes.map(renderActivationRow).join("")}</tbody>
          </table>
        </div>
      `;
  return `
    <div class="modal-backdrop" data-backdrop-dismiss>
      <section class="modal panel activation-dialog" role="dialog" aria-modal="true" aria-labelledby="activationTitle">
        <div class="modal-head"><h2 id="activationTitle">激活码管理</h2><button class="btn ghost" data-act="modal-close">关闭</button></div>
        ${body}
      </section>
    </div>
  `;
}

function renderActivationRow(code: ActivationCode): string {
  const pointDistribution = code.kind === "point-distribution";
  const distributedPoints = code.redemptions.reduce((sum, redemption) => sum + (redemption.points ?? 0), 0);
  const points = pointDistribution ? `总 ${code.totalPoints ?? 0} / 剩 ${(code.totalPoints ?? 0) - distributedPoints}` : String(code.points);
  return `
    <tr>
      <td>${escapeHtml(code.code)}</td>
      <td>${pointDistribution ? (code.distributionMode === "equal" ? "积分均分" : "积分瓜分") : escapeHtml(activationPolicyLabel(code.usePolicy))}</td>
      <td>${code.usePolicy === "unlimited" ? "不限" : code.maxUses}</td>
      <td>${!pointDistribution && code.windowMs ? `${Math.round(code.windowMs / 86_400_000)} 日` : ""}</td>
      <td>${code.expiresAt ? escapeHtml(formatDate(Date.parse(code.expiresAt))) : "永久"}</td>
      <td>${escapeHtml(points)}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(activationTitleSummary(code))}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(activationNicknameColorSummary(code))}</td>
      <td>${pointDistribution ? "不赠送" : escapeHtml(reservedRoomCodeGrantSummary(code.reservedRoomCodeMode))}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(activationGrantSummary(code, "admin"))}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(activationGrantSummary(code, "advanced"))}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(advancedAiGrantSummary(code))}</td>
      <td class="management-permission-column">${pointDistribution ? "不改变" : escapeHtml(invitationPermissionSummary(code.permissions))}</td>
      <td>${pointDistribution ? "不改变" : escapeHtml(customModeLimitGrantSummary(code.customModeLimits, code.customModeLimitDurationMs))}</td>
      <td>${code.redemptions.length}</td>
      <td><button class="btn primary" data-act="${pointDistribution ? "edit-point-distribution" : "edit-activation"}" data-code="${escapeAttr(code.code)}">编辑</button><button class="btn danger" data-act="delete-activation" data-code="${escapeAttr(code.code)}">删除</button></td>
    </tr>
  `;
}

export function renderEditInviteDialog(state: Extract<DialogState, { kind: "edit-invite" }>): string {
  const invitations = getBridge().invitations();
  const invite = state.code ? invitations.find((item) => item.code === state.code) : undefined;
  const usePolicy = invite?.usePolicy ?? (invite?.remainingUses === null || !invite ? "unlimited" : "global-total");
  const neverExpires = !invite?.expiresAt;
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>${invite ? "编辑邀请码" : "新邀请码"}</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>邀请码</label><input id="inviteCode" maxlength="32" value="${escapeAttr(invite?.code ?? "")}" ${invite ? "disabled" : ""} /></div>
          <div class="field"><label>注册额度</label><select id="inviteUsePolicy"><option value="unlimited" ${usePolicy === "unlimited" ? "selected" : ""}>不限次数</option><option value="global-total" ${usePolicy === "global-total" ? "selected" : ""}>总次数上限</option><option value="global-window" ${usePolicy === "global-window" ? "selected" : ""}>滚动周期上限</option></select></div>
          <div id="inviteMaxUsesField" class="field ${usePolicy === "unlimited" ? "is-hidden" : ""}"><label>最多注册次数</label><input id="inviteMaxUses" type="number" min="1" step="1" value="${invite?.maxUses ?? Math.max(1, (invite?.registrations?.length ?? 0) + (invite?.remainingUses ?? 1))}" /></div>
          <div id="inviteWindowDaysField" class="field ${usePolicy === "global-window" ? "" : "is-hidden"}"><label>滚动周期</label><div class="compound-input"><input id="inviteWindowDays" type="number" min="1" step="1" value="${Math.max(1, Math.round((invite?.windowMs ?? 7 * 86_400_000) / 86_400_000))}" /><span>日</span></div></div>
          <div class="field"><label>有效期限</label><select id="inviteExpiryMode"><option value="never" ${neverExpires ? "selected" : ""}>永久有效</option><option value="absolute" ${neverExpires ? "" : "selected"}>指定失效时间</option></select></div>
          ${dateTimeField("inviteExpiresAt", "失效时间", invite?.expiresAt, { wrapperId: "inviteExpiresAtField", hidden: neverExpires })}
          <div class="field"><label>注册身份</label><select id="inviteRole">${roleOptions(invite?.role ?? "normal", false)}</select></div>
          <div class="field"><label>初始积分</label><input id="invitePoints" type="number" step="1" value="${invite?.initialPoints ?? 0}" /></div>
          <div class="field"><label>初始头衔</label><input id="inviteTitle" maxlength="24" value="${escapeAttr(invite?.initialTitle ?? "")}" /></div>
          <div class="field"><label>昵称颜色</label><input id="inviteNicknameColor" maxlength="7" placeholder="#008F8F" value="${escapeAttr(invite?.initialNicknameColor ?? "")}" /></div>
          <div class="field"><label>初始权限</label><select id="invitePermissionMode"><option value="none" ${invite?.permissions ? "" : "selected"}>使用身份组默认</option><option value="custom" ${invite?.permissions ? "selected" : ""}>自定义权限</option></select></div>
          <div id="invitePermissionFields" class="invite-permission-fields ${invite?.permissions ? "" : "is-hidden"}">${renderPermissionFields("invite", invite?.permissions)}</div>
          <div class="field wide"><label>自定义模式额度</label><select id="inviteCustomModeLimitMode"><option value="default" ${invite?.customModeLimits ? "" : "selected"}>使用全局最高设置</option><option value="custom" ${invite?.customModeLimits ? "selected" : ""}>随邀请码永久发放特殊额度</option></select><small>注册成功后单独写入用户，不归入权限。</small></div>
          <div id="inviteCustomModeLimitFields" class="invite-permission-fields ${invite?.customModeLimits ? "" : "is-hidden"}">${renderCustomModeLimitFields("inviteCustomMode", invite?.customModeLimits, { partial: true })}</div>
          <div class="field wide"><label>专属房间号赠送</label><select id="inviteReservedRoomCodeMode"><option value="none" ${invite?.reservedRoomCodeMode ? "" : "selected"}>不赠送</option><option value="user-input" ${invite?.reservedRoomCodeMode === "user-input" ? "selected" : ""}>由用户输入</option><option value="random" ${invite?.reservedRoomCodeMode === "random" ? "selected" : ""}>随机生成</option></select><small>用户输入和随机生成均限制为最多 6 位数字；随机号可含前导 0。</small></div>
          ${renderInvitationGrantFields(invite, "admin", "管理员", invite?.role ?? "normal")}
          ${renderInvitationGrantFields(invite, "advanced", "高级用户", invite?.role ?? "normal")}
          ${renderAdvancedAiGrantFields("invite", invite?.advancedAiDurationMs, invite?.advancedAiExpiresAt)}
          ${renderInvitationTaxFields(invite)}
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-invite-edit" data-code="${escapeAttr(invite?.code ?? "")}">保存</button></div>
      </section>
    </div>
  `;
}

function renderInvitationGrantFields(
  invite: InvitationCode | undefined,
  kind: "admin" | "advanced",
  label: string,
  role: UserRole,
): string {
  const id = kind === "admin" ? "Admin" : "Advanced";
  const mode = invitationGrantMode(invite, kind);
  const duration = kind === "admin" ? invite?.adminDurationMs : invite?.advancedDurationMs;
  const expiresAt = kind === "admin" ? invite?.adminExpiresAt : invite?.advancedExpiresAt;
  const { amount, unit } = invitationDurationParts(duration);
  const enabled = invitationRoleIncludes(role, kind);
  return `
    <div id="invite${id}GrantFields" class="invite-grant-fields ${enabled ? "" : "is-hidden"}">
      <div class="field">
        <label>${label}期限方式</label>
        <select id="invite${id}Mode">
          <option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option>
          <option value="relative" ${mode === "relative" ? "selected" : ""}>注册后相对时间</option>
          <option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option>
        </select>
      </div>
      <div id="invite${id}RelativeField" class="field ${mode === "relative" ? "" : "is-hidden"}">
        <label>${label}相对时长</label>
        <div class="compound-input">
          <input id="invite${id}DurationAmount" type="number" min="1" step="1" value="${amount}" />
          <select id="invite${id}DurationUnit">
            <option value="day" ${unit === "day" ? "selected" : ""}>日</option>
            <option value="hour" ${unit === "hour" ? "selected" : ""}>小时</option>
          </select>
        </div>
      </div>
      <div id="invite${id}AbsoluteField" class="field ${mode === "absolute" ? "" : "is-hidden"}">
        <label>${label}截止时间</label>
        <div class="date-input-group"><input id="invite${id}ExpiresAt" type="datetime-local" value="${escapeAttr(toLocalDateTime(expiresAt))}" /><button class="btn" type="button" data-act="clear-date" data-target="invite${id}ExpiresAt">清空</button></div>
      </div>
    </div>
  `;
}

export function renderEditActivationDialog(state: Extract<DialogState, { kind: "edit-activation" }>): string {
  const activationCodes = getBridge().activationCodes();
  const activation = state.code ? activationCodes.find((item) => item.code === state.code) : undefined;
  const policy = activation?.usePolicy ?? "global-total";
  const rolling = policy === "global-window" || policy === "per-user-window";
  const neverExpires = !activation?.expiresAt;
  const titleMode = activation?.titleMode ?? "default";
  const nicknameColorMode = activation?.nicknameColorMode ?? "default";
  const customPermissions = Boolean(activation?.permissions);
  const customModeLimits = Boolean(activation?.customModeLimits);
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>${activation ? "编辑激活码" : "新激活码"}</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid">
          <div class="field"><label>激活码</label><input id="activationCode" maxlength="32" value="${escapeAttr(activation?.code ?? "")}" ${activation ? "disabled" : ""} /></div>
          <div class="field"><label>使用策略</label><select id="activationPolicy">${activationPolicyOptions(policy)}</select></div>
          <div id="activationMaxUsesField" class="field ${policy === "unlimited" ? "is-hidden" : ""}"><label>最多使用次数</label><input id="activationMaxUses" type="number" min="1" step="1" value="${activation?.maxUses ?? 1}" /></div>
          <div id="activationWindowDaysField" class="field ${rolling ? "" : "is-hidden"}"><label>滚动周期（日）</label><input id="activationWindowDays" type="number" min="1" step="1" value="${activation?.windowMs ? Math.round(activation.windowMs / 86_400_000) : 7}" /></div>
          <div class="field"><label>有效期限</label><select id="activationExpiryMode"><option value="never" ${neverExpires ? "selected" : ""}>永久有效</option><option value="absolute" ${neverExpires ? "" : "selected"}>指定失效时间</option></select></div>
          ${dateTimeField("activationExpiresAt", "失效时间", activation?.expiresAt, { wrapperId: "activationExpiresAtField", hidden: neverExpires })}
          <div class="field"><label>增加积分</label><input id="activationPoints" type="number" step="1" value="${activation?.points ?? 0}" /></div>
          <div id="activationBalanceGuardField" class="field ${(activation?.points ?? 0) < 0 ? "" : "is-hidden"}"><label>扣分保护</label><select id="activationBalanceGuard"><option value="false" ${activation?.requireNonNegativeBalance ? "" : "selected"}>允许兑换后为负</option><option value="true" ${activation?.requireNonNegativeBalance ? "selected" : ""}>兑换后必须非负</option></select></div>
          <div class="field"><label>头衔</label><select id="activationTitleMode"><option value="default" ${titleMode === "default" ? "selected" : ""}>默认（不改变）</option><option value="fixed" ${titleMode === "fixed" ? "selected" : ""}>固定</option><option value="user-custom" ${titleMode === "user-custom" ? "selected" : ""}>用户自定义</option></select></div>
          <div id="activationFixedTitleField" class="field ${titleMode === "fixed" ? "" : "is-hidden"}"><label>固定头衔</label><input id="activationTitle" maxlength="24" value="${escapeAttr(activation?.title ?? "")}" /></div>
          <div class="field"><label>昵称颜色</label><select id="activationNicknameColorMode"><option value="default" ${nicknameColorMode === "default" ? "selected" : ""}>默认（不改变）</option><option value="fixed" ${nicknameColorMode === "fixed" ? "selected" : ""}>固定</option><option value="user-custom" ${nicknameColorMode === "user-custom" ? "selected" : ""}>用户自定义</option></select></div>
          <div id="activationFixedNicknameColorField" class="field ${nicknameColorMode === "fixed" ? "" : "is-hidden"}"><label>固定昵称颜色</label><input id="activationNicknameColor" maxlength="7" placeholder="#008F8F" value="${escapeAttr(activation?.nicknameColor ?? "")}" /></div>
          ${renderActivationGrantFields(activation, "admin", "管理员")}
          ${renderActivationGrantFields(activation, "advanced", "高级用户")}
          ${renderAdvancedAiGrantFields("activation", activation?.advancedAiDurationMs, activation?.advancedAiExpiresAt)}
          ${renderActivationTaxFields(activation)}
          <div class="field"><label>权限</label><select id="activationPermissionMode"><option value="default" ${customPermissions ? "" : "selected"}>使用身份组默认</option><option value="custom" ${customPermissions ? "selected" : ""}>自定义权限</option></select></div>
          <div id="activationPermissionFields" class="invite-permission-fields ${customPermissions ? "" : "is-hidden"}">${renderPermissionFields("activation", activation?.permissions, { partial: true })}</div>
          <div class="field wide"><label>自定义模式额度</label><select id="activationCustomModeLimitMode"><option value="default" ${customModeLimits ? "" : "selected"}>不发放（继续使用全局最高设置）</option><option value="custom" ${customModeLimits ? "selected" : ""}>发放特殊额度</option></select><small>独立于权限，可单独设置有效期。</small></div>
          <div id="activationCustomModeLimitFields" class="invite-permission-fields ${customModeLimits ? "" : "is-hidden"}">
            ${renderCustomModeLimitFields("activationCustomMode", activation?.customModeLimits, { partial: true })}
            ${renderActivationCustomModeLimitDuration(activation)}
          </div>
          <div class="field wide"><label>专属房间号赠送</label><select id="activationReservedRoomCodeMode"><option value="none" ${activation?.reservedRoomCodeMode ? "" : "selected"}>不赠送</option><option value="user-input" ${activation?.reservedRoomCodeMode === "user-input" ? "selected" : ""}>由用户输入</option><option value="random" ${activation?.reservedRoomCodeMode === "random" ? "selected" : ""}>随机生成</option></select><small>用户输入时会在兑换确认中要求填写，随机模式由系统分配。</small></div>
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-activation" data-code="${escapeAttr(activation?.code ?? "")}">保存</button></div>
      </section>
    </div>
  `;
}

export function renderPointDistributionDialog(state: Extract<DialogState, { kind: "edit-point-distribution" }>): string {
  const activationCodes = getBridge().activationCodes();
  const activationRegisteredUserCount = getBridge().activationRegisteredUserCount();
  const managedUsers = getBridge().managedUsers();
  const activation = state.code ? activationCodes.find((item) => item.code === state.code) : undefined;
  const neverExpires = !activation?.expiresAt;
  const maximumUses = Math.max(1, activationRegisteredUserCount || managedUsers.length);
  const locked = Boolean(activation?.redemptions.length);
  const distributionMode = activation?.distributionMode ?? "random";
  const maxUses = activation?.maxUses ?? 1;
  const totalPoints = activation?.totalPoints ?? maxUses;
  const perUserPoints = distributionMode === "equal" ? Math.floor(totalPoints / Math.max(1, maxUses)) : 1;
  return `
    <div class="modal-backdrop">
      <section class="modal panel edit-dialog">
        <div class="modal-head"><h2>${activation ? "编辑激活码红包" : "发送激活码红包"}</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        <p class="dialog-subtitle">玩家总积分数：${usersTotalPoints(managedUsers)}</p>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="setup-grid modal-grid point-distribution-grid">
          <div class="field"><label>激活码</label><input id="pointDistributionCode" maxlength="32" value="${escapeAttr(activation?.code ?? "")}" ${activation ? "disabled" : ""} /></div>
          ${locked
      ? `<div class="field wide"><label>发放规则</label><p class="muted">${distributionMode === "equal" ? "均分" : "瓜分"}；${activation?.maxUses ?? 0} 次；总积分 ${activation?.totalPoints ?? 0}</p></div>`
      : `
              <div class="field"><label>发放模式</label><select id="pointDistributionMode"><option value="random" ${distributionMode === "random" ? "selected" : ""}>瓜分</option><option value="equal" ${distributionMode === "equal" ? "selected" : ""}>均分</option></select></div>
              <div class="field"><label>领取人数</label><input id="pointDistributionMaxUses" type="number" min="1" max="${maximumUses}" step="1" value="${maxUses}" /><small>当前注册用户共 ${maximumUses} 人</small></div>
              <div id="pointDistributionRandomField" class="field ${distributionMode === "random" ? "" : "is-hidden"}"><label>发放总积分数</label><input id="pointDistributionTotalPoints" type="number" min="1" step="1" value="${totalPoints}" /><small id="pointDistributionAverageHint" class="calculated-hint">人均获得：${formatAverage(totalPoints / Math.max(1, maxUses))}</small></div>
              <div id="pointDistributionEqualField" class="field ${distributionMode === "equal" ? "" : "is-hidden"}"><label>每个人得到的积分数</label><input id="pointDistributionPerUserPoints" type="number" min="1" step="1" value="${perUserPoints}" /><small id="pointDistributionTotalHint" class="calculated-hint">总发放积分数：${perUserPoints * maxUses}</small></div>
            `}
          <div class="field"><label>有效期限</label><select id="pointDistributionExpiryMode"><option value="never" ${neverExpires ? "selected" : ""}>永久有效</option><option value="absolute" ${neverExpires ? "" : "selected"}>指定失效时间</option></select></div>
          ${dateTimeField("pointDistributionExpiresAt", "失效时间", activation?.expiresAt, { wrapperId: "pointDistributionExpiresAtField", hidden: neverExpires })}
        </div>
        <div class="top-actions"><button class="btn primary" data-act="submit-point-distribution" data-code="${escapeAttr(activation?.code ?? "")}">保存</button></div>
      </section>
    </div>
  `;
}

function renderInvitationTaxFields(invite: InvitationCode | undefined): string {
  const mode = typeof invite?.taxRatePercent === "number" ? "custom" : "default";
  const percent = typeof invite?.taxRatePercent === "number" ? invite.taxRatePercent : 10;
  return `
    <div class="field"><label>用户最高征税比例</label><select id="inviteTaxRateMode">
      <option value="default" ${mode === "default" ? "selected" : ""}>使用全局设置</option>
      <option value="custom" ${mode === "custom" ? "selected" : ""}>单独设置</option>
    </select></div>
    <div id="inviteTaxRateField" class="field ${mode === "custom" ? "" : "is-hidden"}"><label>最高征税比例（%）</label><input id="inviteTaxRatePercent" type="number" min="-1" max="100" step="1" value="${percent}" /><small class="calculated-hint">-1 表示不征税；选择使用全局设置则注册后沿用全局税收比例。</small></div>
  `;
}

function renderActivationTaxFields(activation: ActivationCode | undefined): string {
  const mode = typeof activation?.taxRatePercent === "number" ? "custom" : "default";
  const percent = typeof activation?.taxRatePercent === "number" ? activation.taxRatePercent : 10;
  return `
    <div class="field"><label>用户最高征税比例</label><select id="activationTaxRateMode">
      <option value="default" ${mode === "default" ? "selected" : ""}>使用全局设置</option>
      <option value="custom" ${mode === "custom" ? "selected" : ""}>单独设置</option>
    </select></div>
    <div id="activationTaxRateField" class="field ${mode === "custom" ? "" : "is-hidden"}"><label>最高征税比例（%）</label><input id="activationTaxRatePercent" type="number" min="-1" max="100" step="1" value="${percent}" /><small class="calculated-hint">-1 表示不征税；选择使用全局设置则兑换后沿用全局税收比例。</small></div>
  `;
}

function renderActivationGrantFields(activation: ActivationCode | undefined, kind: "admin" | "advanced", label: string): string {
  const id = kind === "admin" ? "Admin" : "Advanced";
  const duration = kind === "admin" ? activation?.adminDurationMs : activation?.advancedDurationMs;
  const expiresAt = kind === "admin" ? activation?.adminExpiresAt : activation?.advancedExpiresAt;
  const enabled = duration !== undefined || Boolean(expiresAt);
  const mode = duration === null ? "permanent" : expiresAt ? "absolute" : "relative";
  const { amount, unit } = invitationDurationParts(duration);
  return `
    <div class="field"><label>${label}身份</label><select id="activation${id}Grant"><option value="default" ${enabled ? "" : "selected"}>默认（不改变）</option><option value="grant" ${enabled ? "selected" : ""}>授予</option></select></div>
    <div id="activation${id}GrantFields" class="activation-grant-fields ${enabled ? "" : "is-hidden"}">
      <div class="field"><label>${label}期限方式</label><select id="activation${id}Mode"><option value="relative" ${mode === "relative" ? "selected" : ""}>相对截止时间</option><option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option><option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option></select></div>
      <div id="activation${id}RelativeField" class="field ${mode === "relative" ? "" : "is-hidden"}"><label>${label}相对时长</label><div class="compound-input"><input id="activation${id}DurationAmount" type="number" min="1" step="1" value="${amount}" /><select id="activation${id}DurationUnit"><option value="day" ${unit === "day" ? "selected" : ""}>日</option><option value="hour" ${unit === "hour" ? "selected" : ""}>小时</option></select></div></div>
      ${dateTimeField(`activation${id}ExpiresAt`, `${label}截止时间`, expiresAt, { wrapperId: `activation${id}AbsoluteField`, hidden: mode !== "absolute" })}
    </div>
  `;
}

function renderAdvancedAiGrantFields(
  prefix: "invite" | "activation",
  duration?: number | null,
  expiresAt?: string,
): string {
  const id = `${prefix}AdvancedAi`;
  const enabled = duration !== undefined || Boolean(expiresAt);
  const mode = duration === null ? "permanent" : expiresAt ? "absolute" : "relative";
  const { amount, unit } = invitationDurationParts(duration);
  return `
    <div class="field"><label>高级 AI 权限</label><select id="${id}Grant"><option value="default" ${enabled ? "" : "selected"}>不授予</option><option value="grant" ${enabled ? "selected" : ""}>授予</option></select></div>
    <div id="${id}GrantFields" class="activation-grant-fields ${enabled ? "" : "is-hidden"}">
      <div class="field"><label>高级 AI 期限方式</label><select id="${id}Mode"><option value="relative" ${mode === "relative" ? "selected" : ""}>相对截止时间</option><option value="absolute" ${mode === "absolute" ? "selected" : ""}>绝对截止时间</option><option value="permanent" ${mode === "permanent" ? "selected" : ""}>永久</option></select></div>
      <div id="${id}RelativeField" class="field ${mode === "relative" ? "" : "is-hidden"}"><label>高级 AI 相对时长</label><div class="compound-input"><input id="${id}DurationAmount" type="number" min="1" step="1" value="${amount}" /><select id="${id}DurationUnit"><option value="day" ${unit === "day" ? "selected" : ""}>日</option><option value="hour" ${unit === "hour" ? "selected" : ""}>小时</option></select></div></div>
      ${dateTimeField(`${id}ExpiresAt`, "高级 AI 截止时间", expiresAt, { wrapperId: `${id}AbsoluteField`, hidden: mode !== "absolute" })}
    </div>
  `;
}

function renderActivationCustomModeLimitDuration(activation?: ActivationCode): string {
  const duration = activation?.customModeLimitDurationMs;
  const permanent = duration === null;
  const { amount, unit } = invitationDurationParts(duration);
  return `
    <div class="field"><label>特殊额度期限</label><select id="activationCustomModeLimitDurationMode"><option value="relative" ${permanent ? "" : "selected"}>兑换后相对时长</option><option value="permanent" ${permanent ? "selected" : ""}>永久</option></select></div>
    <div id="activationCustomModeLimitDurationField" class="field ${permanent ? "is-hidden" : ""}"><label>相对时长</label><div class="compound-input"><input id="activationCustomModeLimitDurationAmount" type="number" min="1" step="1" value="${amount}" /><select id="activationCustomModeLimitDurationUnit"><option value="day" ${unit === "day" ? "selected" : ""}>日</option><option value="hour" ${unit === "hour" ? "selected" : ""}>小时</option></select></div></div>
  `;
}

export function renderRedeemActivationDialog(state: Extract<DialogState, { kind: "redeem-activation" }>): string {
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>兑换激活码</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <div class="field"><label>激活码</label><input id="redeemActivationCode" maxlength="32" /></div>
        <div class="top-actions"><button class="btn primary" data-act="submit-activation-redeem">兑换</button></div>
      </section>
    </div>
  `;
}

export function renderRedeemActivationCustomDialog(
  state: Extract<DialogState, { kind: "redeem-activation-custom" }>,
): string {
  const customTitle = state.titleMode === "user-custom";
  const customNicknameColor = state.nicknameColorMode === "user-custom";
  const customReservedRoomCode = state.reservedRoomCodeMode === "user-input";
  const customItems = [
    customTitle ? "头衔" : "",
    customNicknameColor ? "昵称颜色" : "",
    customReservedRoomCode ? "专属房间号" : "",
  ].filter(Boolean);
  const reservedRoomCodeOnly = customReservedRoomCode && customItems.length === 1;
  const dialogTitle = reservedRoomCodeOnly ? "领取专属房间号" : "填写激活码自定义内容";
  const description = reservedRoomCodeOnly
    ? "该激活码会为你的账号添加一个专属房间号，请输入要绑定的号码。取消将不会兑换激活码。"
    : `该激活码需要你填写：${customItems.join("、")}。取消将不会兑换激活码。`;
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>${dialogTitle}</h2><button class="btn ghost" data-act="dialog-close">取消</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <p class="muted">${description}</p>
        ${customTitle ? `<div class="field"><label>头衔</label><input id="redeemActivationTitle" maxlength="24" /></div>` : ""}
        ${customNicknameColor ? `<div class="field"><label>昵称颜色</label><input id="redeemActivationNicknameColor" maxlength="7" placeholder="#008F8F" /></div>` : ""}
        ${customReservedRoomCode ? `<div class="field"><label>专属房间号</label><input id="redeemActivationReservedRoomCode" inputmode="numeric" maxlength="6" placeholder="仅数字，最多 6 位；可保留前导 0" /><small>该号码将归属于你的账号。</small></div>` : ""}
        <div class="top-actions">
          <button class="btn" data-act="dialog-close">取消</button>
          <button class="btn primary" data-act="confirm-activation-custom">确认并兑换</button>
        </div>
      </section>
    </div>
  `;
}

export function renderDeleteCodeDialog(
  state: Extract<DialogState, { kind: "delete-invite" | "delete-activation" }>,
  label: string,
): string {
  const action = state.kind === "delete-invite" ? "confirm-delete-invite" : "confirm-delete-activation";
  return `
    <div class="modal-backdrop">
      <section class="modal panel">
        <div class="modal-head"><h2>删除${label}</h2><button class="btn ghost" data-act="dialog-close">关闭</button></div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        <p class="muted">确认删除 ${escapeHtml(state.code)}。已完成的注册或兑换记录不会回退。</p>
        <div class="top-actions"><button class="btn danger" data-act="${action}" data-code="${escapeAttr(state.code)}">确认删除</button></div>
      </section>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// 邀请码 / 激活码字段 → 表格文案的纯汇总（S3 从 app.ts 搬来，逻辑逐字未改）
// ---------------------------------------------------------------------------

function invitationGrantMode(invite: InvitationCode | undefined, kind: "admin" | "advanced"): "relative" | "absolute" | "permanent" {
  const duration = kind === "admin" ? invite?.adminDurationMs : invite?.advancedDurationMs;
  const expiresAt = kind === "admin" ? invite?.adminExpiresAt : invite?.advancedExpiresAt;
  const permanent = kind === "admin" ? invite?.adminPermanent : invite?.advancedPermanent;
  if (typeof duration === "number") return "relative";
  if (expiresAt && duration !== null && !permanent) return "absolute";
  return "permanent";
}

function invitationDurationParts(duration?: number | null): { amount: number; unit: "day" | "hour" } {
  if (typeof duration !== "number" || duration <= 0) return { amount: 7, unit: "day" };
  if (duration % 86_400_000 === 0) return { amount: duration / 86_400_000, unit: "day" };
  return { amount: Math.max(1, Math.round(duration / 3_600_000)), unit: "hour" };
}

function invitationGrantSummary(invite: InvitationCode, kind: "admin" | "advanced"): string {
  if (!invitationRoleIncludes(invite.role, kind)) return "";
  const duration = kind === "admin" ? invite.adminDurationMs : invite.advancedDurationMs;
  const expiresAt = kind === "admin" ? invite.adminExpiresAt : invite.advancedExpiresAt;
  const permanent = kind === "admin" ? invite.adminPermanent : invite.advancedPermanent;
  if (duration === null || permanent) return "永久";
  if (typeof duration === "number") {
    const { amount, unit } = invitationDurationParts(duration);
    return `注册后 ${amount} ${unit === "day" ? "日" : "小时"}`;
  }
  return expiresAt ? `至 ${formatDate(Date.parse(expiresAt))}` : "永久";
}

function invitationPermissionSummary(permissions?: Partial<PermissionRule>): string {
  if (!permissions) return "身份组默认";
  const parts: string[] = [];
  if (permissions.exchangeMax !== undefined) parts.push(`换牌 0-${permissions.exchangeMax === null ? "不限" : permissions.exchangeMax}`);
  else parts.push("换牌默认");
  parts.push("固定 15s");
  if (permissions.canCreateZeroBaseBet !== undefined) parts.push(`0底注${permissions.canCreateZeroBaseBet ? "允许" : "禁止"}`);
  else parts.push("0底注默认");
  if (permissions.maxBaseBet !== undefined) parts.push(`最大底注 ${permissions.maxBaseBet === null ? "不限" : permissions.maxBaseBet}`);
  else parts.push("最大底注默认");
  parts.push(`决斗${duelLimitSummary(permissions.duelLimit)}`);
  return parts.join("；");
}

function customModeLimitGrantSummary(limits?: CustomModeLimitGrant, durationMs?: number | null): string {
  if (!limits) return "全局最高设置";
  const maxBaseBet = limits.maxBaseBet ? customMaxBaseBetSummary(limits.maxBaseBet) : "沿用全局";
  const settlementCap = limits.settlementCap ? customSettlementCapSummary(limits.settlementCap) : "沿用全局";
  const duration = durationMs === null
    ? "永久"
    : typeof durationMs === "number"
      ? (() => {
        const parts = invitationDurationParts(durationMs);
        return `${parts.amount}${parts.unit === "day" ? "日" : "小时"}`;
      })()
      : "永久";
  return `底注 ${maxBaseBet}；每名输家扣分 ${settlementCap}；${duration}`;
}

function duelLimitSummary(rule?: Partial<DuelLimitRule>): string {
  if (!rule) return "默认";
  const normalized = duelLimitForDisplay(rule);
  if (normalized.period === "none") return "不允许";
  if (normalized.period === "unlimited") return "不限";
  return `${duelPeriodLabel(normalized.period)}${normalized.count ?? 1}次`;
}

function invitationUseSummary(invite: InvitationCode): string {
  const policy = invite.usePolicy ?? (invite.remainingUses === null ? "unlimited" : "global-total");
  if (policy === "unlimited") return "不限次数";
  if (policy === "global-window") {
    return `每 ${Math.max(1, Math.round((invite.windowMs ?? 86_400_000) / 86_400_000))} 日最多 ${invite.maxUses ?? 1} 次`;
  }
  return `总计 ${invite.maxUses ?? (invite.registrations?.length ?? 0) + (invite.remainingUses ?? 0)} 次`;
}

function advancedAiGrantSummary(code: {
  advancedAiDurationMs?: number | null;
  advancedAiExpiresAt?: string;
}): string {
  if (code.advancedAiDurationMs === null) return "永久";
  if (typeof code.advancedAiDurationMs === "number") {
    const { amount, unit } = invitationDurationParts(code.advancedAiDurationMs);
    return `${amount}${unit === "hour" ? "小时" : "日"}`;
  }
  if (code.advancedAiExpiresAt) return `至 ${formatDate(Date.parse(code.advancedAiExpiresAt))}`;
  return "不授予";
}

function activationPolicyOptions(selected: ActivationUsePolicy): string {
  const policies: ActivationUsePolicy[] = ["unlimited", "global-total", "per-user-total", "global-window", "per-user-window"];
  return policies.map((policy) => `<option value="${policy}" ${policy === selected ? "selected" : ""}>${activationPolicyLabel(policy)}</option>`).join("");
}

function activationPolicyLabel(policy: ActivationUsePolicy): string {
  return (
    {
      unlimited: "不限次数",
      "global-total": "全局总次数",
      "per-user-total": "每用户总次数",
      "global-window": "全局滚动周期",
      "per-user-window": "每用户滚动周期",
    } as Record<ActivationUsePolicy, string>
  )[policy];
}

function activationTitleSummary(activation: ActivationCode): string {
  const mode = activation.titleMode ?? "default";
  if (mode === "fixed") return `固定：${activation.title ?? ""}`;
  if (mode === "user-custom") return "用户自定义";
  return "默认（不改变）";
}

function activationNicknameColorSummary(activation: ActivationCode): string {
  const mode = activation.nicknameColorMode ?? "default";
  if (mode === "fixed") return `固定：${activation.nicknameColor ?? ""}`;
  if (mode === "user-custom") return "用户自定义";
  return "默认（不改变）";
}

function reservedRoomCodeGrantSummary(mode?: "user-input" | "random"): string {
  if (mode === "user-input") return "用户输入";
  if (mode === "random") return "随机生成";
  return "不赠送";
}

function activationGrantSummary(activation: ActivationCode, kind: "admin" | "advanced"): string {
  const duration = kind === "admin" ? activation.adminDurationMs : activation.advancedDurationMs;
  const expiresAt = kind === "admin" ? activation.adminExpiresAt : activation.advancedExpiresAt;
  if (duration === undefined && !expiresAt) return "默认（不改变）";
  if (duration === null) return "永久";
  if (expiresAt) return `至 ${formatDate(Date.parse(expiresAt))}`;
  const { amount, unit } = invitationDurationParts(duration);
  return `${amount} ${unit === "day" ? "日" : "小时"}`;
}
