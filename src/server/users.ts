import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createClient, type RedisClientType } from "redis";
import { buildLeaderboard, type LeaderboardResult } from "../shared/leaderboard.js";
import { canDownloadWinMusic, canManageWinMusic, canPlayDownloadedWinMusic, canPlayWinMusic } from "../shared/music-access.js";
import { assertSpreadsheetExportAccountName, assertSpreadsheetExportIdentity, assertSpreadsheetSafeAccountName, assertSpreadsheetSafeText, spreadsheetCsvCell } from "../shared/spreadsheet-safety.js";
import { parseVictoryMusicDataUrl } from "../shared/victory-music.js";
import { randomPointRewardUpperBound } from "../shared/point-distribution.js";
import { DEFAULT_TAX_RATE_PERCENT, cleanTaxRatePercent, normalizeTaxRatePercent, normalizeTaxWinnerPointsThreshold } from "../shared/tax.js";
import type { PlayerProfile, UserRole } from "../shared/types.js";
import {
  defaultCustomModeLimits,
  normalizeCustomModeLimitGrant,
  normalizeCustomModeLimits,
  resolveCustomMaxBaseBet,
  setupPlayersRange,
  type CustomModeLimitGrant,
  type CustomModeLimits,
  type CustomMaxBaseBetRule,
  type CustomSettlementCapRule,
} from "../shared/custom-limits.js";
import { parseCustomRules, type CustomPresetProvider } from "../shared/custom-rules-parser.js";
import { canonicalCustomRulesHash, type CustomRulesSource, type ResolvedCustomRules } from "../shared/custom-rules-types.js";

const scryptAsync = promisify(scrypt);
const USERS_KEY = "ion-storm:users:v1";
const DEFAULT_SUPER_USERNAME = "admin";
const DEFAULT_SUPER_PASSWORD = "admin";
const DEFAULT_POINTS = 0;
const SECURITY_CAPTURE_MS = 2 * 60 * 60 * 1000;
const MAX_SECURITY_EVENTS_PER_INCIDENT = 500;
export const DUEL_ROOM_COOLDOWN_MS = 60 * 60 * 1000;
export const DUEL_LIMIT_PERIOD_MS: Record<Exclude<DuelLimitPeriod, "none" | "unlimited">, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};
const ROLE_COLORS: Record<UserRole, string> = {
  "super-admin": "#FF0000",
  "admin-advanced": "#FF8F00",
  admin: "#FF008F",
  advanced: "#008F8F",
  normal: "#000000",
};

export interface StoredUser {
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
  winMusic?: UserMusic;
  /** Strings are intentional: leading zeroes are meaningful for reserved room codes. */
  reservedRoomCodes?: string[];
}

export interface UserMusic {
  fileName: string;
  mimeType: string;
  size: number;
  durationSeconds?: number;
  uploadedAt: number;
  dataUrl?: string;
  sha1?: string;
  sha256?: string;
}

export interface WinMusicManifestEntry {
  userId: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha1: string;
  sha256: string;
}

export interface InvitationCode {
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
  reservedRoomCodeMode?: ReservedRoomCodeGrantMode;
  usePolicy?: InvitationUsePolicy;
  maxUses?: number;
  windowMs?: number;
  registrations?: InvitationRegistration[];
  createdAt: number;
  updatedAt: number;
}

export type InvitationUsePolicy = "unlimited" | "global-total" | "global-window";

export interface InvitationRegistration {
  userId: string;
  usedAt: number;
  deviceHash: string;
  browserHash: string;
}

export interface RegistrationContext {
  deviceId: string;
  browserFingerprint: string;
}

export type DuelLimitPeriod = "none" | "hour" | "day" | "week" | "unlimited";

export interface DuelLimitRule {
  period: DuelLimitPeriod;
  count: number | null;
}

export interface PermissionRule {
  exchangeMin: number;
  exchangeMax: number | null;
  canCreateZeroBaseBet: boolean;
  maxBaseBet: number | null;
  duelLimit: DuelLimitRule;
}

type LegacyCustomPermissionFields = {
  customMaxBaseBet?: CustomMaxBaseBetRule;
  customSettlementCap?: CustomSettlementCapRule;
};

function legacyCustomModeGrant(value: {
  customModeLimits?: CustomModeLimitGrant;
  permissions?: (Partial<PermissionRule> & LegacyCustomPermissionFields) | undefined;
}): CustomModeLimitGrant | undefined {
  if (value.customModeLimits) return normalizeCustomModeLimitGrant(value.customModeLimits);
  const legacy = value.permissions;
  if (!legacy?.customMaxBaseBet && !legacy?.customSettlementCap) return undefined;
  return normalizeCustomModeLimitGrant({
    maxBaseBet: legacy.customMaxBaseBet,
    settlementCap: legacy.customSettlementCap,
  });
}

export interface UserPermissionOverride {
  permissions: Partial<PermissionRule>;
  expiresAt?: string;
  permanent?: boolean;
}

export interface UserCustomModeLimitOverride {
  limits: CustomModeLimitGrant;
  expiresAt?: string;
  permanent?: boolean;
}

export interface CustomRulesPreset {
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
}

export interface CustomRulesPresetMeta {
  id: string;
  displayName: string;
  enabled: boolean;
  updatedAt: number;
}

/**
 * The management API exposes only fields that are editable or displayable.
 * Hashes and revisions stay on the persisted preset for room snapshots and
 * preset inheritance, but are deliberately not presentation data.
 */
export interface CustomRulesPresetAdminView extends CustomRulesPresetMeta {
  sourceDocument: unknown;
  createdAt: number;
}

export type ActivationUsePolicy = "unlimited" | "global-total" | "per-user-total" | "global-window" | "per-user-window";
export type ActivationTitleMode = "default" | "fixed" | "user-custom";
export type ActivationNicknameColorMode = ActivationTitleMode;
export type ActivationKind = "standard" | "point-distribution";
export type PointDistributionMode = "random" | "equal";

export interface ActivationRedemption {
  userId: string;
  usedAt: number;
  points?: number;
}

export interface ActivationCode {
  code: string;
  kind?: ActivationKind;
  usePolicy: ActivationUsePolicy;
  maxUses: number;
  distributionMode?: PointDistributionMode;
  totalPoints?: number;
  windowMs?: number;
  expiresAt?: string;
  points: number;
  requireNonNegativeBalance?: boolean;
  titleMode?: ActivationTitleMode;
  title?: string;
  nicknameColorMode?: ActivationNicknameColorMode;
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
  reservedRoomCodeMode?: ReservedRoomCodeGrantMode;
  redemptions: ActivationRedemption[];
  createdAt: number;
  updatedAt: number;
}

export type RequestKind = "ticket" | "unban" | "nickname" | "security";

export interface UserRequest {
  id: string;
  kind: RequestKind;
  fromUserId: string;
  targetUserId?: string;
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
}

export interface PublicUser {
  id: string;
  username: string;
  nickname: string;
  role: UserRole;
  color: string;
  nicknameColor: string;
  title?: string;
  subtitle?: string;
  hasAdvancedPerk: boolean;
  superAdmin: boolean;
  adminPermanent: boolean;
  advancedPermanent: boolean;
  adminExpiresAt?: string;
  advancedExpiresAt?: string;
  advancedAiAccess?: boolean;
  advancedAiPermanent?: boolean;
  advancedAiExpiresAt?: string;
  taxRatePercent?: number;
  gamesPlayed: number;
  gamesWon: number;
  todayGamesPlayed: number;
  todayGamesWon: number;
  todayGamePointsDelta: number;
  inviteCodeUsed?: string;
  lastLoginAt?: number;
  points: number;
  disabledUntil?: string;
  disabledPermanent: boolean;
  disabled: boolean;
  hideFromLeaderboardWhileDisabled: boolean;
  leaderboardHiddenUntil?: string;
  leaderboardHiddenPermanent: boolean;
  hiddenFromLeaderboard: boolean;
  nicknameChangeDisabled: boolean;
  permissions: PermissionRule;
  permissionOverride?: Partial<PermissionRule>;
  permissionOverrideExpiresAt?: string;
  permissionOverridePermanent?: boolean;
  customModeLimits: CustomModeLimits;
  customModeLimitOverride?: CustomModeLimitGrant;
  customModeLimitOverrideExpiresAt?: string;
  customModeLimitOverridePermanent?: boolean;
  hasWinMusic: boolean;
  winMusic?: Omit<UserMusic, "dataUrl">;
  reservedRoomCodes: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AuthResult {
  token: string;
  user: PublicUser;
}

export interface UserStoreOptions {
  filePath?: string;
  secret?: string;
  previousSecret?: string;
  bootstrapSuperAdminUsername?: string;
  bootstrapSuperAdminPassword?: string;
  passwordHasher?: (password: string) => Promise<string>;
  redisUrl?: string;
  reservedRoomCodeIsOccupied?: (code: string) => Promise<boolean>;
}

export interface UserPatch {
  nickname?: string;
  password?: string;
  currentPassword?: string;
  title?: string | null;
  nicknameColor?: string | null;
  points?: number;
  disabledUntil?: string | null;
  disabledPermanent?: boolean;
  hideFromLeaderboardWhileDisabled?: boolean;
  leaderboardHiddenUntil?: string | null;
  leaderboardHiddenPermanent?: boolean;
  nicknameChangeDisabled?: boolean;
  adminPermanent?: boolean;
  advancedPermanent?: boolean;
  adminExpiresAt?: string | null;
  advancedExpiresAt?: string | null;
  advancedAiAccess?: boolean;
  advancedAiPermanent?: boolean;
  advancedAiExpiresAt?: string | null;
  taxRatePercent?: number | null;
  permissions?: Partial<PermissionRule> | null;
  permissionsPermanent?: boolean;
  permissionsDurationMs?: number | null;
  permissionsExpiresAt?: string | null;
  customModeLimits?: CustomModeLimitGrant | null;
  customModeLimitsPermanent?: boolean;
  customModeLimitsDurationMs?: number | null;
  customModeLimitsExpiresAt?: string | null;
}

export interface InvitationPatch {
  code?: string;
  remainingUses?: number | null;
  expiresAt?: string | null;
  role?: UserRole;
  initialPoints?: number;
  initialTitle?: string | null;
  initialNicknameColor?: string | null;
  permissions?: Partial<PermissionRule> | null;
  customModeLimits?: CustomModeLimitGrant | null;
  adminDurationMs?: number | null | false;
  advancedDurationMs?: number | null | false;
  adminExpiresAt?: string | null;
  advancedExpiresAt?: string | null;
  adminPermanent?: boolean;
  advancedPermanent?: boolean;
  advancedAiDurationMs?: number | null | false;
  advancedAiExpiresAt?: string | null;
  taxRatePercent?: number | null;
  reservedRoomCodeMode?: ReservedRoomCodeGrantMode | null;
  usePolicy?: InvitationUsePolicy;
  maxUses?: number;
  windowMs?: number | null;
}

export interface ActivationPatch {
  code?: string;
  kind?: ActivationKind;
  usePolicy?: ActivationUsePolicy;
  maxUses?: number;
  distributionMode?: PointDistributionMode;
  totalPoints?: number;
  windowMs?: number | null;
  expiresAt?: string | null;
  points?: number;
  requireNonNegativeBalance?: boolean;
  titleMode?: ActivationTitleMode;
  title?: string | null;
  nicknameColorMode?: ActivationNicknameColorMode;
  nicknameColor?: string | null;
  adminDurationMs?: number | null | false;
  advancedDurationMs?: number | null | false;
  adminExpiresAt?: string | null;
  advancedExpiresAt?: string | null;
  advancedAiDurationMs?: number | null | false;
  advancedAiExpiresAt?: string | null;
  taxRatePercent?: number | null;
  permissionDurationMs?: number | null | false;
  permissions?: Partial<PermissionRule> | null;
  customModeLimitDurationMs?: number | null | false;
  customModeLimits?: CustomModeLimitGrant | null;
  reservedRoomCodeMode?: ReservedRoomCodeGrantMode | null;
}

/** `user-input` is supplied by the recipient at registration/redemption time. */
export type ReservedRoomCodeGrantMode = "user-input" | "random";
export const MAX_SELF_MANAGED_RESERVED_ROOM_CODES = 10;

export interface SecurityAuditEventInput {
  actorUserId?: string;
  subjectKey: string;
  category: "unauthorized-read" | "unauthorized-operation" | "forged-action" | "protected-mutation";
  operation: string;
  method: string;
  route: string;
  ip?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  occurredAt?: number;
}

interface SecurityAuditEvent extends Omit<SecurityAuditEventInput, "occurredAt"> {
  occurredAt: number;
}

interface SecurityIncident {
  id: string;
  subjectKey: string;
  actorUserId?: string;
  startedAt: number;
  endsAt: number;
  reportedAt?: number;
  requestId?: string;
  suppressedEvents?: number;
  events: SecurityAuditEvent[];
}

export class UserStore {
  private users: StoredUser[] = [];
  private invitations: InvitationCode[] = [];
  private activationCodes: ActivationCode[] = [];
  private requests: UserRequest[] = [];
  private requestSeenAtByUserId: Record<string, number> = {};
  private rolePermissions: Record<UserRole, PermissionRule> = defaultRolePermissions();
  private customModeLimits: CustomModeLimits = defaultCustomModeLimits();
  private taxRatePercent = DEFAULT_TAX_RATE_PERCENT;
  private taxWinnerPointsThreshold: number | undefined = undefined;
  private userPermissions: Record<string, UserPermissionOverride> = {};
  private userCustomModeLimits: Record<string, UserCustomModeLimitOverride> = {};
  private settledGameIds: string[] = [];
  private customRulesPresets: CustomRulesPreset[] = [];
  private securityIncidents: SecurityIncident[] = [];
  private duelRoomCooldowns: Record<string, number[]> = {};
  private sessions = new Map<string, string>();
  private saveQueue: Promise<void> = Promise.resolve();
  private redis?: RedisClientType;
  private readonly filePath: string;
  private readonly redisUrl?: string;
  private readonly encKey: Buffer;
  private readonly hmacKey: Buffer;
  private readonly previousEncKey?: Buffer;
  private readonly bootstrapSuperAdminUsername: string;
  private readonly bootstrapSuperAdminPassword: string;
  private readonly passwordHasher: (password: string) => Promise<string>;
  private readonly reservedRoomCodeIsOccupied: (code: string) => Promise<boolean>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: UserStoreOptions = {}) {
    const secret = requireAuthSecret(options.secret ?? process.env.AUTH_SECRET);
    const previousSecret = options.previousSecret ?? process.env.AUTH_SECRET_PREVIOUS;
    this.filePath = options.filePath ?? process.env.USER_DATA_FILE ?? path.resolve(process.cwd(), "data/users.json");
    this.redisUrl = options.redisUrl ?? process.env.REDIS_URL;
    this.encKey = createHash("sha256").update(`${secret}:username-encryption`).digest();
    this.hmacKey = createHash("sha256").update(`${secret}:username-lookup`).digest();
    this.previousEncKey = previousSecret && previousSecret !== secret
      ? createHash("sha256").update(`${requireAuthSecret(previousSecret, "AUTH_SECRET_PREVIOUS")}:username-encryption`).digest()
      : undefined;
    this.bootstrapSuperAdminUsername = options.bootstrapSuperAdminUsername
      ?? process.env.BOOTSTRAP_SUPER_ADMIN_USERNAME
      ?? DEFAULT_SUPER_USERNAME;
    this.bootstrapSuperAdminPassword = options.bootstrapSuperAdminPassword
      ?? process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD
      ?? DEFAULT_SUPER_PASSWORD;
    this.passwordHasher = options.passwordHasher ?? hashPassword;
    this.reservedRoomCodeIsOccupied = options.reservedRoomCodeIsOccupied ?? (async () => false);
  }

  async connect(): Promise<void> {
    if (this.redisUrl) {
      this.redis = createClient({ url: this.redisUrl });
      this.redis.on("error", (error) => console.warn("[redis-users]", error.message));
      await this.redis.connect();
    }
    await this.load();
    await this.migratePreviousSecretIfNeeded();
    if (this.users.length === 0) await this.bootstrapSuperAdmin();
    await this.ensureSuperAdmin();
  }

  async register(
    username: string,
    password: string,
    nickname?: string,
    inviteCode?: string,
    context?: RegistrationContext,
    reservedRoomCode?: string,
  ): Promise<AuthResult> {
    const cleanUsername = validateUsername(username);
    const cleanNickname = validateNickname(nickname ?? cleanUsername);
    if (!inviteCode?.trim()) throw new Error("注册必须填写邀请码");
    const userId = uid("u");
    this.preflightInvitation(inviteCode, context, userId, Date.now());
    if (this.findByUsername(cleanUsername)) throw new Error("用户名已存在");
    validatePassword(password);
    const passwordHash = await this.passwordHasher(password);
    return this.serializeMutation(async () => {
      if (this.findByUsername(cleanUsername)) throw new Error("用户名已存在");
      const now = Date.now();
      const configuredInvitation = this.preflightInvitation(inviteCode, context, userId, now);
      const preparedReservedRoomCode = configuredInvitation.reservedRoomCodeMode
        ? await this.grantReservedRoomCode(
            { id: "pending-registration", reservedRoomCodes: [] },
            configuredInvitation.reservedRoomCodeMode,
            reservedRoomCode,
            false,
          )
        : undefined;
      const invitation = this.consumeInvitation(inviteCode, context, userId, now);
      const user: StoredUser = {
        id: userId,
        usernameEncrypted: this.encrypt(cleanUsername),
        usernameLookup: this.lookup(cleanUsername),
        passwordHash,
        sessionVersion: 0,
        nickname: cleanNickname,
        inviteCodeUsed: invitation.code,
        points: invitation.initialPoints,
        title: invitation.initialTitle,
        nicknameColor: invitation.initialNicknameColor,
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
      applyInvitationIdentity(user, invitation, now);
      if (preparedReservedRoomCode) user.reservedRoomCodes = [preparedReservedRoomCode];
      applyAdvancedAiGrant(user, invitation.advancedAiDurationMs, invitation.advancedAiExpiresAt, now);
      if (typeof invitation.taxRatePercent === "number") user.taxRatePercent = invitation.taxRatePercent;
      if (invitation.permissions && Object.keys(invitation.permissions).length > 0) {
        this.userPermissions[user.id] = { permissions: normalizePermissionPatch(invitation.permissions), permanent: true };
      }
      if (invitation.customModeLimits && Object.keys(invitation.customModeLimits).length > 0) {
        this.userCustomModeLimits[user.id] = { limits: normalizeCustomModeLimitGrant(invitation.customModeLimits), permanent: true };
      }
      this.users.push(user);
      await this.save();
      return this.issueAuth(user);
    });
  }

  async login(username: string, password: string): Promise<AuthResult> {
    const user = this.findByUsername(username);
    if (!user || !(await verifyPassword(password, user.passwordHash))) throw new Error("用户名或密码错误");
    user.lastLoginAt = Date.now();
    user.updatedAt = Date.now();
    await this.save();
    return this.issueAuth(user);
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  async userForToken(token?: string): Promise<StoredUser | undefined> {
    if (!token) return undefined;
    const userId = this.sessions.get(token);
    return userId ? this.users.find((user) => user.id === userId) : undefined;
  }

  publicFor(user: StoredUser, revealAdvancedAi = false, viewer?: StoredUser): PublicUser {
    const username = this.decrypt(user.usernameEncrypted);
    const role = roleFor(user);
    const title = user.title?.trim() || undefined;
    const nickname = user.nickname?.trim() || username;
    const nicknameColor = cleanColor(user.nicknameColor) ?? ROLE_COLORS[role];
    const advancedAiAccess = hasAdvancedAiAccess(user);
    return {
      id: user.id,
      username,
      nickname,
      role,
      color: ROLE_COLORS[role],
      nicknameColor,
      title,
      subtitle: subtitleFor(role, title),
      hasAdvancedPerk: hasAdvancedPerk(role),
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
      disabled: isUserDisabled(user),
      hideFromLeaderboardWhileDisabled: Boolean(user.hideFromLeaderboardWhileDisabled),
      leaderboardHiddenUntil: user.leaderboardHiddenUntil,
      leaderboardHiddenPermanent: Boolean(user.leaderboardHiddenPermanent),
      hiddenFromLeaderboard: isUserHiddenFromLeaderboard(user),
      nicknameChangeDisabled: Boolean(user.nicknameChangeDisabled),
      taxRatePercent: user.taxRatePercent,
      permissions: this.permissionsFor(user),
      permissionOverride: this.userPermissions[user.id]?.permissions,
      permissionOverrideExpiresAt: this.userPermissions[user.id]?.expiresAt,
      permissionOverridePermanent: this.userPermissions[user.id]?.permissions ? Boolean(this.userPermissions[user.id]?.permanent ?? true) : undefined,
      customModeLimits: this.customModeLimitsFor(user),
      customModeLimitOverride: this.userCustomModeLimits[user.id]?.limits,
      customModeLimitOverrideExpiresAt: this.userCustomModeLimits[user.id]?.expiresAt,
      customModeLimitOverridePermanent: this.userCustomModeLimits[user.id]?.limits ? Boolean(this.userCustomModeLimits[user.id]?.permanent ?? true) : undefined,
      hasWinMusic: Boolean(user.winMusic),
      winMusic: user.winMusic
        ? {
            fileName: user.winMusic.fileName,
            mimeType: user.winMusic.mimeType,
            size: user.winMusic.size,
            uploadedAt: user.winMusic.uploadedAt,
          }
        : undefined,
      reservedRoomCodes: viewer && canViewReservedRoomCodes(viewer, user) ? [...(user.reservedRoomCodes ?? [])] : [],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  profileFor(user: StoredUser): PlayerProfile {
    const view = this.publicFor(user);
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

  userById(id: string): StoredUser | undefined {
    return this.users.find((user) => user.id === id);
  }

  canViewReservedRoomCodes(actor: StoredUser, target: StoredUser): boolean {
    return canViewReservedRoomCodes(actor, target);
  }

  /** Checks the persisted namespace. Active-room collisions are checked by RoomStore. */
  reservedRoomCodeOwner(code: string): StoredUser | undefined {
    return this.users.find((user) => user.reservedRoomCodes?.includes(code));
  }

  async addReservedRoomCode(actor: StoredUser, targetId: string, code: string): Promise<string[]> {
    this.mustSuperAdmin(actor);
    const target = this.mustUser(targetId);
    const clean = validateReservedRoomCode(code, true);
    const owner = this.reservedRoomCodeOwner(clean);
    if (owner && owner.id !== target.id) throw new Error("该专属房间号已被其他用户占用");
    if (target.reservedRoomCodes?.includes(clean)) throw new Error("该用户已拥有此专属房间号");
    if (await this.reservedRoomCodeIsOccupied(clean)) throw new Error("该专属房间号已被现有房间占用");
    target.reservedRoomCodes = [...(target.reservedRoomCodes ?? []), clean];
    target.updatedAt = Date.now();
    await this.save();
    return [...target.reservedRoomCodes!];
  }

  async replaceReservedRoomCode(actor: StoredUser, targetId: string, oldCode: string, nextCode: string): Promise<string[]> {
    this.mustSuperAdmin(actor);
    const target = this.mustUser(targetId);
    const oldClean = validateReservedRoomCode(oldCode, true);
    const index = target.reservedRoomCodes?.indexOf(oldClean) ?? -1;
    if (index < 0) throw new Error("该用户没有此专属房间号");
    const clean = validateReservedRoomCode(nextCode, true);
    const owner = this.reservedRoomCodeOwner(clean);
    if (owner && owner.id !== target.id) throw new Error("该专属房间号已被其他用户占用");
    if (clean !== oldClean && target.reservedRoomCodes?.includes(clean)) throw new Error("该用户已拥有此专属房间号");
    if (clean !== oldClean && await this.reservedRoomCodeIsOccupied(clean)) throw new Error("该专属房间号已被现有房间占用");
    target.reservedRoomCodes![index] = clean;
    target.updatedAt = Date.now();
    await this.save();
    return [...target.reservedRoomCodes!];
  }

  async deleteReservedRoomCode(actor: StoredUser, targetId: string, code: string): Promise<string[]> {
    const target = this.mustUser(targetId);
    const clean = validateReservedRoomCode(code, true);
    const self = actor.id === target.id;
    const actorRole = roleFor(actor);
    const targetRole = roleFor(target);
    const adminMayDelete =
      (actorRole === "admin" || actorRole === "admin-advanced") && (targetRole === "advanced" || targetRole === "normal");
    if (!self && !actor.superAdmin && !adminMayDelete) throw new Error("没有权限删除该用户的专属房间号");
    if (!target.reservedRoomCodes?.includes(clean)) throw new Error("该用户没有此专属房间号");
    target.reservedRoomCodes = target.reservedRoomCodes.filter((item) => item !== clean);
    target.updatedAt = Date.now();
    await this.save();
    return [...target.reservedRoomCodes!];
  }

  guestProfile(username: string): PlayerProfile {
    return {
      username,
      nickname: username,
      role: "normal",
      color: ROLE_COLORS.normal,
      nicknameColor: ROLE_COLORS.normal,
      permissions: defaultRolePermissions().normal,
      hasAdvancedPerk: false,
      guest: true,
    };
  }

  listUsers(actor: StoredUser): PublicUser[] {
    if (!canViewAll(actor)) return [this.publicFor(actor, true, actor)];
    return this.users
      .map((user) => this.publicFor(user, actor.superAdmin || actor.id === user.id, actor))
      .sort((a, b) => a.username.localeCompare(b.username, "zh-Hans-CN"));
  }

  canUseAdvancedAi(actor: StoredUser): boolean {
    return hasAdvancedAiAccess(actor);
  }

  leaderboard(actor: StoredUser): LeaderboardResult {
    return buildLeaderboard(
      this.users.map((user) => {
        const view = this.publicFor(user);
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
      }),
      actor.id,
    );
  }

  exportUsersCsv(actor: StoredUser): string {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以下载所有用户数据");
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
    const rows = this.users.map((user) => {
      const view = this.publicFor(user);
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
        formatTime(view.createdAt),
        view.inviteCodeUsed ?? "",
        view.lastLoginAt ? formatTime(view.lastLoginAt) : "",
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

  async updateUser(actor: StoredUser, targetId: string, patch: UserPatch): Promise<PublicUser> {
    const target = this.mustUser(targetId);
    const actorView = this.publicFor(actor);
    const targetView = this.publicFor(target);
    const self = actor.id === target.id;

    if ((patch as UserPatch & { username?: string }).username !== undefined) {
      throw new Error("用户名不可修改");
    }
    if (touchesProtectedFields(patch) && !(await this.verifyCurrentPassword(actor, patch.currentPassword))) {
      throw new Error("请先验证当前密码");
    }

    if (patch.nickname !== undefined) {
      if (self && target.nicknameChangeDisabled) throw new Error("该账号已被禁止自行修改昵称，请提交昵称修改工单");
      if (!self && !canManageNickname(actorView, targetView)) throw new Error("没有权限修改该昵称");
      target.nickname = validateNickname(patch.nickname);
    }

    if (patch.password !== undefined) {
      if (!self && (!actor.superAdmin || target.superAdmin)) {
        throw new Error("没有权限修改该密码");
      }
      validatePassword(patch.password);
      target.passwordHash = await this.passwordHasher(patch.password);
      target.sessionVersion = (target.sessionVersion ?? 0) + 1;
      this.revokeSessionsForUser(target.id);
    }

    if (patch.title !== undefined) {
      if (!actor.superAdmin) {
        throw new Error("只有超级管理员可以设置头衔");
      }
      target.title = cleanOptional(patch.title, 24);
    }

    if (patch.nicknameColor !== undefined) {
      if (!actor.superAdmin) throw new Error("只有超级管理员可以设置昵称颜色");
      target.nicknameColor = patch.nicknameColor === null ? undefined : validateHexColor(patch.nicknameColor);
    }

    if (patch.points !== undefined) {
      if (!actor.superAdmin) throw new Error("只有超级管理员可以设置积分");
      target.points = cleanInteger(patch.points, "积分");
    }

    if (patch.taxRatePercent !== undefined) {
      if (!actor.superAdmin) throw new Error("只有超级管理员可以设置用户税收比例");
      target.taxRatePercent = patch.taxRatePercent === null ? undefined : cleanTaxRatePercent(patch.taxRatePercent);
    }
    const leaderboardBanPatch =
      patch.hideFromLeaderboardWhileDisabled !== undefined ||
      patch.leaderboardHiddenUntil !== undefined ||
      patch.leaderboardHiddenPermanent !== undefined;
    if (leaderboardBanPatch && !actor.superAdmin) {
      throw new Error("只有超级管理员可以设置排行榜隐藏");
    }
    if (patch.disabledPermanent !== undefined || patch.disabledUntil !== undefined) {
      if (self && target.superAdmin) throw new Error("超级管理员不能禁用自己的账号功能，只能从排行榜移除");
      if (!canManageBan(actorView, targetView)) throw new Error("没有权限禁用或解禁该用户");
      const wasDisabled = isUserDisabled(target);
      if (patch.disabledPermanent !== undefined) target.disabledPermanent = Boolean(patch.disabledPermanent);
      if (patch.disabledUntil !== undefined) target.disabledUntil = cleanExpiry(patch.disabledUntil);
      const disabled = isUserDisabled(target);
      if (disabled && !wasDisabled) {
        target.disabledAt = Date.now();
        target.disabledBy = actor.id;
        target.unbanRequestedForDisabledAt = undefined;
      }
    }
    if (patch.hideFromLeaderboardWhileDisabled !== undefined) {
      if (self && target.superAdmin) throw new Error("超级管理员不能禁用自己的账号功能，只能从排行榜移除");
      target.hideFromLeaderboardWhileDisabled = Boolean(patch.hideFromLeaderboardWhileDisabled);
    }
    if (patch.leaderboardHiddenUntil !== undefined) {
      target.leaderboardHiddenUntil = cleanExpiry(patch.leaderboardHiddenUntil);
    }
    if (patch.leaderboardHiddenPermanent !== undefined) {
      target.leaderboardHiddenPermanent = Boolean(patch.leaderboardHiddenPermanent);
    }

    if (patch.nicknameChangeDisabled !== undefined) {
      if (!canManageNickname(actorView, targetView) || self) throw new Error("没有权限修改该账号的昵称自改状态");
      target.nicknameChangeDisabled = Boolean(patch.nicknameChangeDisabled);
    }

    if (hasRolePatch(patch)) {
      if (target.superAdmin) throw new Error("超级管理员身份不可编辑");
      applyRolePatch(actorView, targetView, target, patch);
    }
    if (patch.permissions !== undefined) {
      if (!actor.superAdmin) throw new Error("只有超级管理员可以设置用户权限");
      if (patch.permissions === null) delete this.userPermissions[target.id];
      else {
        const permissions = normalizePermissionPatch(patch.permissions);
        this.userPermissions[target.id] = this.buildPermissionOverrideEntry(permissions, patch);
      }
    } else if (patch.permissionsPermanent !== undefined || patch.permissionsDurationMs !== undefined || patch.permissionsExpiresAt !== undefined) {
      if (!actor.superAdmin) throw new Error("只有超级管理员可以设置用户权限");
      const existing = this.userPermissions[target.id];
      if (!existing) throw new Error("该用户没有自定义权限覆盖");
      this.userPermissions[target.id] = this.buildPermissionOverrideEntry(existing.permissions, patch, existing);
    }
    if (patch.customModeLimits !== undefined) {
      if (!actor.superAdmin) throw new Error("只有超级管理员可以设置用户的自定义模式权益");
      if (patch.customModeLimits === null) delete this.userCustomModeLimits[target.id];
      else {
        const limits = normalizeCustomModeLimitGrant(patch.customModeLimits);
        this.userCustomModeLimits[target.id] = this.buildCustomModeLimitOverrideEntry(limits, patch);
      }
    } else if (
      patch.customModeLimitsPermanent !== undefined ||
      patch.customModeLimitsDurationMs !== undefined ||
      patch.customModeLimitsExpiresAt !== undefined
    ) {
      if (!actor.superAdmin) throw new Error("只有超级管理员可以设置用户的自定义模式权益");
      const existing = this.userCustomModeLimits[target.id];
      if (!existing) throw new Error("该用户没有自定义模式权益覆盖");
      this.userCustomModeLimits[target.id] = this.buildCustomModeLimitOverrideEntry(existing.limits, patch, existing);
    }
    if (patch.advancedAiAccess !== undefined || patch.advancedAiPermanent !== undefined || patch.advancedAiExpiresAt !== undefined) {
      if (!actor.superAdmin) throw new Error("只有超级管理员可以设置高级 AI 权限");
      if (patch.advancedAiAccess !== undefined) {
        if (target.superAdmin && !patch.advancedAiAccess) throw new Error("超级管理员始终具有高级 AI 权限");
        target.advancedAiPermanent = Boolean(patch.advancedAiAccess);
        target.advancedAiExpiresAt = undefined;
      }
      if (patch.advancedAiPermanent !== undefined || patch.advancedAiExpiresAt !== undefined) {
        if (target.superAdmin && patch.advancedAiPermanent === false && !patch.advancedAiExpiresAt) throw new Error("超级管理员始终具有高级 AI 权限");
        if (patch.advancedAiPermanent !== undefined) target.advancedAiPermanent = Boolean(patch.advancedAiPermanent);
        if (patch.advancedAiPermanent) target.advancedAiExpiresAt = undefined;
        if (patch.advancedAiExpiresAt !== undefined) {
          target.advancedAiExpiresAt = cleanExpiry(patch.advancedAiExpiresAt);
          if (target.advancedAiExpiresAt) target.advancedAiPermanent = false;
        }
      }
    }

    target.updatedAt = Date.now();
    await this.save();
    return this.publicFor(target, actor.superAdmin || actor.id === target.id, actor);
  }

  async deleteUser(actor: StoredUser, targetId: string, currentPassword?: string): Promise<void> {
    const target = this.mustUser(targetId);
    if (!actor.superAdmin) throw new Error("只有超级管理员可以删除用户");
    if (target.superAdmin) throw new Error("超级管理员不可删除");
    if (!(await this.verifyCurrentPassword(actor, currentPassword))) throw new Error("请先验证当前密码");
    this.users = this.users.filter((user) => user.id !== target.id);
    delete this.userPermissions[target.id];
    delete this.userCustomModeLimits[target.id];
    for (const [token, userId] of this.sessions) {
      if (userId === target.id) this.sessions.delete(token);
    }
    await this.save();
  }

  async addStats(accountIds: string[], winnerAccountId?: string): Promise<void> {
    let changed = false;
    const uniqueIds = [...new Set(accountIds)];
    for (const accountId of uniqueIds) {
      const user = this.users.find((item) => item.id === accountId);
      if (!user) continue;
      user.gamesPlayed += 1;
      if (accountId === winnerAccountId) user.gamesWon += 1;
      user.updatedAt = Date.now();
      changed = true;
    }
    if (changed) await this.save();
  }

  async transferPoints(winnerAccountId: string | undefined, loserAccountIds: string[], amount: number): Promise<void> {
    if (!winnerAccountId || amount <= 0) return;
    const winner = this.users.find((item) => item.id === winnerAccountId);
    if (!winner) return;
    let changed = false;
    for (const loserId of [...new Set(loserAccountIds)].filter((id) => id !== winnerAccountId)) {
      const loser = this.users.find((item) => item.id === loserId);
      if (!loser) continue;
      loser.points = (loser.points ?? 0) - amount;
      loser.updatedAt = Date.now();
      winner.points = (winner.points ?? 0) + amount;
      changed = true;
    }
    if (changed) {
      winner.updatedAt = Date.now();
      await this.save();
    }
  }

  async settleGame(gameId: string, accountIds: string[], winnerAccountId: string | undefined, amount: number, winnerTax = 0, loserCaps?: Record<string, number>): Promise<void> {
    if (!gameId || this.settledGameIds.includes(gameId)) return;
    const now = Date.now();
    const uniqueIds = [...new Set(accountIds)];
    const winner = winnerAccountId ? this.users.find((item) => item.id === winnerAccountId) : undefined;
    for (const accountId of uniqueIds) {
      const user = this.users.find((item) => item.id === accountId);
      if (!user) continue;
      user.gamesPlayed += 1;
      if (accountId === winnerAccountId) user.gamesWon += 1;
      recordTodayStats(user, accountId === winnerAccountId, now);
      user.updatedAt = now;
    }
    if (winner && amount > 0) {
      for (const loserId of uniqueIds.filter((id) => id !== winnerAccountId)) {
        const loser = this.users.find((item) => item.id === loserId);
        if (!loser) continue;
        const cap = loserCaps?.[loserId];
        const paid = cap !== undefined ? Math.min(amount, Math.max(0, Math.floor(cap))) : amount;
        if (paid <= 0) continue;
        loser.points = (loser.points ?? 0) - paid;
        addTodayGamePointsDelta(loser, -paid, now);
        winner.points = (winner.points ?? 0) + paid;
        addTodayGamePointsDelta(winner, paid, now);
        loser.updatedAt = now;
      }
      winner.updatedAt = now;
    }
    const cleanWinnerTax = Math.max(0, Math.floor(Number(winnerTax ?? 0)));
    if (winner && cleanWinnerTax > 0) {
      winner.points = (winner.points ?? 0) - cleanWinnerTax;
      addTodayGamePointsDelta(winner, -cleanWinnerTax, now);
      winner.updatedAt = now;
    }
    this.settledGameIds.push(gameId);
    this.settledGameIds = this.settledGameIds.slice(-10_000);
    await this.save();
  }

  async bulkGrantPoints(
    actor: StoredUser,
    input: { targetUserIds?: string[]; distributionMode?: "random" | "equal"; totalPoints?: number; perUserPoints?: number },
  ): Promise<{ grants: Array<{ userId: string; points: number }>; totalPoints: number }> {
    this.mustSuperAdmin(actor);
    const targetUserIds = [...new Set((input.targetUserIds ?? []).map(String).filter(Boolean))];
    if (targetUserIds.length === 0) throw new Error("请选择用户");
    for (const id of targetUserIds) this.mustUser(id);
    const grants = input.distributionMode === "equal"
      ? equalPointGrants(targetUserIds, cleanInteger(Number(input.perUserPoints ?? 0), "每个人得到的积分数"))
      : randomPointGrants(targetUserIds, cleanPositiveInteger(Number(input.totalPoints ?? 0), "发放总积分数"));
    const now = Date.now();
    for (const grant of grants) {
      const user = this.mustUser(grant.userId);
      user.points = (user.points ?? 0) + grant.points;
      user.updatedAt = now;
    }
    await this.save();
    return { grants, totalPoints: grants.reduce((sum, grant) => sum + grant.points, 0) };
  }

  listInvitations(actor: StoredUser): InvitationCode[] {
    this.mustSuperAdmin(actor);
    return structuredClone(this.invitations).sort((a, b) => b.createdAt - a.createdAt);
  }

  async upsertInvitation(actor: StoredUser, patch: InvitationPatch): Promise<InvitationCode> {
    this.mustSuperAdmin(actor);
    const now = Date.now();
    const code = validateInviteCode(patch.code ?? randomInviteCode());
    let invite = this.invitations.find((item) => item.code === code);
    if (!invite) {
      invite = {
        code,
        remainingUses: null,
        role: "normal",
        initialPoints: DEFAULT_POINTS,
        usePolicy: "unlimited",
        maxUses: 1,
        registrations: [],
        createdAt: now,
        updatedAt: now,
      };
      this.invitations.push(invite);
    }
    if (patch.remainingUses !== undefined) invite.remainingUses = patch.remainingUses === null ? null : cleanNonNegativeInteger(patch.remainingUses, "邀请码剩余次数");
    if (patch.remainingUses !== undefined && patch.usePolicy === undefined) {
      invite.usePolicy = patch.remainingUses === null ? "unlimited" : "global-total";
      if (patch.remainingUses !== null) invite.maxUses = (invite.registrations?.length ?? 0) + patch.remainingUses;
    }
    if (patch.usePolicy !== undefined) invite.usePolicy = validateInvitationPolicy(patch.usePolicy);
    if (patch.maxUses !== undefined) invite.maxUses = cleanPositiveInteger(patch.maxUses, "邀请码最多注册次数");
    if (patch.windowMs !== undefined) invite.windowMs = patch.windowMs === null ? undefined : cleanPositiveInteger(patch.windowMs, "邀请码滚动周期");
    if (patch.expiresAt !== undefined) invite.expiresAt = cleanExpiry(patch.expiresAt);
    if (patch.role !== undefined) {
      const role = validateRole(patch.role);
      if (role === "super-admin") throw new Error("邀请码不能授予超级管理员身份");
      invite.role = role;
    }
    if (patch.initialPoints !== undefined) invite.initialPoints = cleanInteger(patch.initialPoints, "初始积分");
    if (patch.initialTitle !== undefined) invite.initialTitle = cleanOptional(patch.initialTitle, 24);
    if (patch.initialNicknameColor !== undefined) {
      invite.initialNicknameColor = patch.initialNicknameColor === null ? undefined : validateHexColor(patch.initialNicknameColor);
    }
    if (patch.permissions !== undefined) {
      invite.permissions = patch.permissions === null ? undefined : normalizePermissionPatch(patch.permissions);
    }
    if (patch.customModeLimits !== undefined) {
      invite.customModeLimits = patch.customModeLimits === null ? undefined : normalizeCustomModeLimitGrant(patch.customModeLimits);
    }
    applyInvitationGrantPatch(invite, "admin", patch.adminDurationMs, patch.adminExpiresAt, patch.adminPermanent);
    applyInvitationGrantPatch(invite, "advanced", patch.advancedDurationMs, patch.advancedExpiresAt, patch.advancedPermanent);
    applyAdvancedAiGrantPatch(invite, patch.advancedAiDurationMs, patch.advancedAiExpiresAt);
    if (patch.taxRatePercent !== undefined) {
      invite.taxRatePercent = patch.taxRatePercent === null ? undefined : cleanTaxRatePercent(patch.taxRatePercent);
    }
    if (patch.reservedRoomCodeMode !== undefined) {
      invite.reservedRoomCodeMode = patch.reservedRoomCodeMode === null ? undefined : validateReservedRoomCodeGrantMode(patch.reservedRoomCodeMode);
    }
    normalizeInvitationRoleGrants(invite);
    normalizeInvitationQuota(invite);
    invite.updatedAt = now;
    await this.save();
    return structuredClone(invite);
  }

  async deleteInvitation(actor: StoredUser, code: string): Promise<void> {
    this.mustSuperAdmin(actor);
    this.invitations = this.invitations.filter((item) => item.code !== code);
    await this.save();
  }

  listActivationCodes(actor: StoredUser): ActivationCode[] {
    this.mustSuperAdmin(actor);
    return structuredClone(this.activationCodes).sort((a, b) => b.createdAt - a.createdAt);
  }

  async upsertActivationCode(actor: StoredUser, patch: ActivationPatch): Promise<ActivationCode> {
    this.mustSuperAdmin(actor);
    const now = Date.now();
    const code = validateInviteCode(patch.code ?? randomInviteCode());
    const existing = this.activationCodes.find((item) => item.code === code);
    const existingKind = existing?.kind ?? "standard";
    if (existing && patch.kind && patch.kind !== existingKind) throw new Error("不能修改激活码类型");
    const activation: ActivationCode = existing
      ? structuredClone(existing)
      : {
        code,
        kind: patch.kind ?? "standard",
        usePolicy: "global-total",
        maxUses: 1,
        points: 0,
        redemptions: [],
        createdAt: now,
        updatedAt: now,
      };
    activation.kind = patch.kind ?? existingKind;
    if (patch.usePolicy !== undefined) activation.usePolicy = validateActivationPolicy(patch.usePolicy);
    if (patch.maxUses !== undefined) activation.maxUses = cleanPositiveInteger(patch.maxUses, "最多使用次数");
    if (patch.distributionMode !== undefined) {
      if (patch.distributionMode !== "random" && patch.distributionMode !== "equal") throw new Error("积分发放模式无效");
      activation.distributionMode = patch.distributionMode;
    }
    if (patch.totalPoints !== undefined) activation.totalPoints = cleanPositiveInteger(patch.totalPoints, "总积分");
    if (patch.windowMs !== undefined) activation.windowMs = patch.windowMs === null ? undefined : cleanPositiveInteger(patch.windowMs, "滚动周期");
    if (patch.expiresAt !== undefined) activation.expiresAt = cleanExpiry(patch.expiresAt);
    if (patch.points !== undefined) activation.points = cleanInteger(patch.points, "积分");
    if (patch.requireNonNegativeBalance !== undefined) activation.requireNonNegativeBalance = Boolean(patch.requireNonNegativeBalance);
    if (patch.titleMode !== undefined) activation.titleMode = validateActivationTitleMode(patch.titleMode);
    if (patch.title !== undefined) activation.title = cleanOptional(patch.title, 24);
    if (patch.nicknameColorMode !== undefined) activation.nicknameColorMode = validateActivationTitleMode(patch.nicknameColorMode);
    if (patch.nicknameColor !== undefined) {
      activation.nicknameColor = patch.nicknameColor === null ? undefined : validateHexColor(patch.nicknameColor);
    }
    applyActivationGrantPatch(activation, "admin", patch.adminDurationMs, patch.adminExpiresAt);
    applyActivationGrantPatch(activation, "advanced", patch.advancedDurationMs, patch.advancedExpiresAt);
    applyAdvancedAiGrantPatch(activation, patch.advancedAiDurationMs, patch.advancedAiExpiresAt);
    if (patch.taxRatePercent !== undefined) {
      activation.taxRatePercent = patch.taxRatePercent === null ? undefined : cleanTaxRatePercent(patch.taxRatePercent);
    }
    if (patch.reservedRoomCodeMode !== undefined) {
      activation.reservedRoomCodeMode = patch.reservedRoomCodeMode === null ? undefined : validateReservedRoomCodeGrantMode(patch.reservedRoomCodeMode);
    }
    if (patch.permissionDurationMs !== undefined) activation.permissionDurationMs = patch.permissionDurationMs === false ? undefined : cleanGrantDuration(patch.permissionDurationMs, "权限时长");
    if (patch.permissions !== undefined) activation.permissions = patch.permissions === null ? undefined : normalizePermissionPatch(patch.permissions);
    if (patch.customModeLimitDurationMs !== undefined) {
      activation.customModeLimitDurationMs = patch.customModeLimitDurationMs === false
        ? undefined
        : cleanGrantDuration(patch.customModeLimitDurationMs, "自定义模式权益时长");
    }
    if (patch.customModeLimits !== undefined) {
      activation.customModeLimits = patch.customModeLimits === null ? undefined : normalizeCustomModeLimitGrant(patch.customModeLimits);
    }
    if ((activation.usePolicy === "global-window" || activation.usePolicy === "per-user-window") && !activation.windowMs) {
      throw new Error("周期限额激活码必须设置滚动周期");
    }
    if (activation.titleMode === "fixed" && !activation.title) throw new Error("固定头衔不能为空");
    if (activation.titleMode !== "fixed") activation.title = undefined;
    if (activation.nicknameColorMode === "fixed" && !activation.nicknameColor) throw new Error("固定昵称颜色不能为空");
    if (activation.nicknameColorMode !== "fixed") activation.nicknameColor = undefined;
    if (activation.kind === "point-distribution") {
      activation.usePolicy = "global-total";
      activation.distributionMode ??= "random";
      activation.totalPoints ??= activation.maxUses;
      if (activation.maxUses > this.users.length) throw new Error(`总兑换次数不能超过注册用户总数 ${this.users.length}`);
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
    if (existing) this.activationCodes[this.activationCodes.indexOf(existing)] = activation;
    else this.activationCodes.push(activation);
    await this.save();
    return structuredClone(activation);
  }

  async deleteActivationCode(actor: StoredUser, code: string): Promise<void> {
    this.mustSuperAdmin(actor);
    this.activationCodes = this.activationCodes.filter((item) => item.code !== code);
    await this.save();
  }

  prepareActivationCode(
    actor: StoredUser,
    code: string,
  ): { titleMode: ActivationTitleMode; nicknameColorMode: ActivationNicknameColorMode; reservedRoomCodeMode?: ReservedRoomCodeGrantMode } {
    if (isUserDisabled(actor)) throw new Error("账号禁用期间不能兑换激活码");
    const clean = validateInviteCode(code);
    const activation = this.activationCodes.find((item) => item.code === clean);
    if (!activation) throw new Error("激活码不存在");
    this.ensureRedemptionReservedRoomCodeAllowance(actor);
    const now = Date.now();
    if (activation.expiresAt && Date.parse(activation.expiresAt) <= now) throw new Error("激活码已失效");
    enforceActivationQuota(activation, actor.id, now);
    if (activation.kind !== "point-distribution" && activation.requireNonNegativeBalance && (actor.points ?? 0) + activation.points < 0) {
      throw new Error("兑换后积分不能为负数");
    }
    return {
      titleMode: activation.titleMode ?? "default",
      nicknameColorMode: activation.nicknameColorMode ?? "default",
      reservedRoomCodeMode: activation.reservedRoomCodeMode,
    };
  }

  async redeemActivationCode(
    actor: StoredUser,
    code: string,
    customTitle?: string,
    customNicknameColor?: string,
    reservedRoomCode?: string,
  ): Promise<PublicUser> {
    return this.serializeMutation(() =>
      this.redeemActivationCodeUnlocked(actor, code, customTitle, customNicknameColor, reservedRoomCode),
    );
  }

  private async redeemActivationCodeUnlocked(
    actor: StoredUser,
    code: string,
    customTitle?: string,
    customNicknameColor?: string,
    reservedRoomCode?: string,
  ): Promise<PublicUser> {
    if (isUserDisabled(actor)) throw new Error("账号禁用期间不能兑换激活码");
    const clean = validateInviteCode(code);
    const activation = this.activationCodes.find((item) => item.code === clean);
    if (!activation) throw new Error("激活码不存在");
    this.ensureRedemptionReservedRoomCodeAllowance(actor);
    const now = Date.now();
    if (activation.expiresAt && Date.parse(activation.expiresAt) <= now) throw new Error("激活码已失效");
    enforceActivationQuota(activation, actor.id, now);
    const grantedReservedRoomCode = activation.reservedRoomCodeMode
      ? await this.grantReservedRoomCode(actor, activation.reservedRoomCodeMode, reservedRoomCode, false)
      : undefined;
    const redeemedPoints = activation.kind === "point-distribution" ? pointDistributionReward(activation) : activation.points;
    const nextPoints = (actor.points ?? 0) + redeemedPoints;
    if (activation.requireNonNegativeBalance && nextPoints < 0) throw new Error("兑换后积分不能为负数");
    const titleMode = activation.titleMode ?? "default";
    const nextTitle =
      titleMode === "fixed"
        ? activation.title
        : titleMode === "user-custom"
          ? cleanRequired(customTitle ?? "", 24)
          : undefined;
    const nicknameColorMode = activation.nicknameColorMode ?? "default";
    const nextNicknameColor =
      nicknameColorMode === "fixed"
        ? activation.nicknameColor
        : nicknameColorMode === "user-custom"
          ? validateHexColor(customNicknameColor ?? "")
          : undefined;
    actor.points = nextPoints;
    if (titleMode !== "default") actor.title = nextTitle;
    if (nicknameColorMode !== "default") actor.nicknameColor = nextNicknameColor;
    if (activation.kind !== "point-distribution") {
      applyActivationRoleGrant(actor, "admin", activation.adminDurationMs, activation.adminExpiresAt, now);
      applyActivationRoleGrant(actor, "advanced", activation.advancedDurationMs, activation.advancedExpiresAt, now);
      applyAdvancedAiGrant(actor, activation.advancedAiDurationMs, activation.advancedAiExpiresAt, now);
      if (typeof activation.taxRatePercent === "number") actor.taxRatePercent = activation.taxRatePercent;
    }
    if (activation.kind !== "point-distribution" && activation.permissions && activation.permissionDurationMs !== undefined) {
      const durationMs = activation.permissionDurationMs;
      const existing = this.userPermissions[actor.id];
      const permanent = durationMs === null || Boolean(existing?.permanent);
      const base = existing?.expiresAt ? Math.max(now, Date.parse(existing.expiresAt)) : now;
      this.userPermissions[actor.id] = {
        permissions: normalizePermissionPatch({ ...(existing?.permissions ?? {}), ...activation.permissions }),
        permanent,
        expiresAt: permanent || durationMs === null ? undefined : new Date(base + durationMs).toISOString(),
      };
    }
    if (activation.kind !== "point-distribution" && activation.customModeLimits && activation.customModeLimitDurationMs !== undefined) {
      const durationMs = activation.customModeLimitDurationMs;
      const existing = this.userCustomModeLimits[actor.id];
      const permanent = durationMs === null || Boolean(existing?.permanent);
      const base = existing?.expiresAt ? Math.max(now, Date.parse(existing.expiresAt)) : now;
      this.userCustomModeLimits[actor.id] = {
        limits: normalizeCustomModeLimitGrant({ ...(existing?.limits ?? {}), ...activation.customModeLimits }),
        permanent,
        expiresAt: permanent || durationMs === null ? undefined : new Date(base + durationMs).toISOString(),
      };
    }
    if (grantedReservedRoomCode) actor.reservedRoomCodes = [...(actor.reservedRoomCodes ?? []), grantedReservedRoomCode];
    activation.redemptions.push({ userId: actor.id, usedAt: now, points: redeemedPoints });
    activation.updatedAt = now;
    actor.updatedAt = now;
    await this.save();
    return this.publicFor(actor, true, actor);
  }

  private buildPermissionOverrideEntry(permissions: Partial<PermissionRule>, patch: UserPatch, existing?: UserPermissionOverride): UserPermissionOverride {
    const durationMs = patch.permissionsDurationMs !== undefined && patch.permissionsDurationMs !== null
      ? Number(patch.permissionsDurationMs)
      : undefined;
    const expiresAtRaw = patch.permissionsExpiresAt !== undefined ? cleanExpiry(patch.permissionsExpiresAt) : undefined;
    if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) throw new Error("权限覆盖时长不正确");
    const permanent = durationMs === undefined && !expiresAtRaw
      ? patch.permissionsPermanent !== undefined
        ? Boolean(patch.permissionsPermanent)
        : true
      : false;
    if (permanent) return { permissions, permanent: true };
    const now = Date.now();
    if (durationMs !== undefined) {
      return { permissions, permanent: false, expiresAt: new Date(now + durationMs).toISOString() };
    }
    const expiresAt = expiresAtRaw ?? existing?.expiresAt;
    if (!expiresAt) throw new Error("非永久权限必须设置有效期（相对时长或绝对截止时间）");
    return { permissions, permanent: false, expiresAt };
  }

  private buildCustomModeLimitOverrideEntry(
    limits: CustomModeLimitGrant,
    patch: UserPatch,
    existing?: UserCustomModeLimitOverride,
  ): UserCustomModeLimitOverride {
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
    if (permanent) return { limits, permanent: true };
    if (durationMs !== undefined) return { limits, permanent: false, expiresAt: new Date(Date.now() + durationMs).toISOString() };
    const expiresAt = expiresAtRaw ?? existing?.expiresAt;
    if (!expiresAt) throw new Error("非永久自定义模式权益必须设置有效期");
    return { limits, permanent: false, expiresAt };
  }

  getPermissions(actor: StoredUser): { rolePermissions: Record<UserRole, PermissionRule>; userPermissions: Record<string, UserPermissionOverride> } {
    this.mustSuperAdmin(actor);
    return { rolePermissions: structuredClone(this.rolePermissions), userPermissions: structuredClone(this.userPermissions) };
  }

  getCustomModeLimits(actor: StoredUser): CustomModeLimits {
    this.mustSuperAdmin(actor);
    return structuredClone(this.customModeLimits);
  }

  async updateCustomModeLimits(actor: StoredUser, limits: CustomModeLimits): Promise<void> {
    this.mustSuperAdmin(actor);
    this.customModeLimits = normalizeCustomModeLimits(limits);
    await this.save();
  }

  customPresetProvider(candidate?: { id: string; source: string | CustomRulesSource; revision: number }): CustomPresetProvider {
    return {
      get: (presetId: string) => {
        if (candidate?.id === presetId) return { source: candidate.source, revision: candidate.revision };
        const preset = this.customRulesPresets.find((item) => item.id === presetId);
        return preset ? { source: preset.sourceDocument as string | CustomRulesSource, revision: preset.revision } : undefined;
      },
    };
  }

  resolveCustomRulesDocument(
    sourceDocument: unknown,
    candidate?: { id: string; source: string | CustomRulesSource; revision: number },
  ): { rules: ResolvedCustomRules; hash: string } {
    const rules = parseCustomRules(sourceDocument, { presets: this.customPresetProvider(candidate) });
    return { rules, hash: canonicalCustomRulesHash(rules) };
  }

  private presetMeta(preset: CustomRulesPreset): CustomRulesPresetMeta {
    return { id: preset.id, displayName: preset.displayName, enabled: preset.enabled, updatedAt: preset.updatedAt };
  }

  customRulesPresetAdminView(preset: CustomRulesPreset): CustomRulesPresetAdminView {
    return {
      ...this.presetMeta(preset),
      sourceDocument: structuredClone(preset.sourceDocument),
      createdAt: preset.createdAt,
    };
  }

  listCustomRulesPresets(actor: StoredUser): CustomRulesPreset[] {
    this.mustSuperAdmin(actor);
    return structuredClone(this.customRulesPresets);
  }

  listEnabledCustomRulesPresets(): CustomRulesPresetMeta[] {
    return this.customRulesPresets.filter((preset) => preset.enabled).map((preset) => this.presetMeta(preset));
  }

  enabledCustomPreset(id: string): CustomRulesPreset | undefined {
    return this.customRulesPresets.find((preset) => preset.id === id && preset.enabled);
  }

  previewCustomRulesPreset(actor: StoredUser, sourceDocument: unknown): { displayName: string; name: string; players: [number, number]; cardCount: number; deckSize: number } {
    this.mustSuperAdmin(actor);
    const { rules } = this.resolveCustomRulesDocument(sourceDocument);
    const deckSize = Object.values(rules.deck.cards).reduce((sum, count) => sum + count, 0);
    return {
      displayName: rules.displayName ?? rules.name,
      name: rules.name,
      players: setupPlayersRange(rules.setup.players),
      cardCount: Object.keys(rules.cards).length,
      deckSize,
    };
  }

  private cleanPresetDisplayName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || name.length > 40) throw new Error("预设名称必须是 1-40 个字符");
    return name;
  }

  private buildPresetEntry(actor: StoredUser, displayName: string, sourceDocument: unknown, existing?: CustomRulesPreset): CustomRulesPreset {
    const revision = existing ? existing.revision + 1 : 1;
    const candidate = existing
      ? { id: existing.id, source: sourceDocument as string | CustomRulesSource, revision }
      : undefined;
    const { rules, hash } = this.resolveCustomRulesDocument(sourceDocument, candidate);
    const now = Date.now();
    return {
      id: existing?.id ?? uid("crp"),
      displayName: this.cleanPresetDisplayName(displayName),
      sourceDocument: structuredClone(sourceDocument),
      resolvedRules: rules,
      resolvedHash: hash,
      revision,
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      updatedBy: actor.id,
    };
  }

  async createCustomRulesPreset(actor: StoredUser, payload: { displayName?: unknown; sourceDocument?: unknown }): Promise<CustomRulesPreset> {
    this.mustSuperAdmin(actor);
    if (payload.sourceDocument === undefined) throw new Error("缺少规则文档");
    const preset = this.buildPresetEntry(actor, String(payload.displayName ?? ""), payload.sourceDocument);
    this.customRulesPresets.push(preset);
    await this.save();
    return structuredClone(preset);
  }

  async updateCustomRulesPreset(actor: StoredUser, id: string, patch: { displayName?: unknown; sourceDocument?: unknown; enabled?: unknown }): Promise<CustomRulesPreset> {
    this.mustSuperAdmin(actor);
    const preset = this.customRulesPresets.find((item) => item.id === id);
    if (!preset) throw new Error("预设不存在");
    const next = patch.sourceDocument !== undefined
      ? this.buildPresetEntry(actor, patch.displayName !== undefined ? String(patch.displayName) : preset.displayName, patch.sourceDocument, preset)
      : { ...preset, displayName: patch.displayName !== undefined ? this.cleanPresetDisplayName(patch.displayName) : preset.displayName, updatedAt: Date.now(), updatedBy: actor.id };
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    const index = this.customRulesPresets.indexOf(preset);
    this.customRulesPresets[index] = next;
    await this.save();
    return structuredClone(next);
  }

  async deleteCustomRulesPreset(actor: StoredUser, id: string): Promise<void> {
    this.mustSuperAdmin(actor);
    const index = this.customRulesPresets.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("预设不存在");
    this.customRulesPresets.splice(index, 1);
    await this.save();
  }

  async duplicateCustomRulesPreset(actor: StoredUser, id: string): Promise<CustomRulesPreset> {
    this.mustSuperAdmin(actor);
    const preset = this.customRulesPresets.find((item) => item.id === id);
    if (!preset) throw new Error("预设不存在");
    const copy = this.buildPresetEntry(actor, `${preset.displayName} 副本`.slice(0, 40), preset.sourceDocument);
    this.customRulesPresets.push(copy);
    await this.save();
    return structuredClone(copy);
  }

  getTaxSettings(actor: StoredUser): { taxRatePercent: number; taxWinnerPointsThreshold?: number } {
    this.mustSuperAdmin(actor);
    return { taxRatePercent: this.taxRatePercent, taxWinnerPointsThreshold: this.taxWinnerPointsThreshold };
  }

  async updateTaxSettings(actor: StoredUser, payload: { taxRatePercent?: number; taxWinnerPointsThreshold?: number | null | string }): Promise<void> {
    this.mustSuperAdmin(actor);
    this.taxRatePercent = normalizeTaxRatePercent(payload.taxRatePercent, this.taxRatePercent);
    this.taxWinnerPointsThreshold = normalizeTaxWinnerPointsThreshold(payload.taxWinnerPointsThreshold, this.taxWinnerPointsThreshold);
    await this.save();
  }

  taxRateForUserId(userId?: string): number {
    const user = userId ? this.users.find((item) => item.id === userId) : undefined;
    return normalizeTaxRatePercent(user?.taxRatePercent, this.taxRatePercent);
  }

  duelRoomCooldownStatus(userId: string, now = Date.now()): { allowed: boolean; retryAt?: number; unlimited?: boolean } {
    const user = this.mustUser(userId);
    return duelLimitStatus(this.permissionsFor(user).duelLimit, this.duelRoomCooldowns[userId] ?? [], now);
  }

  async reserveDuelRoomCreation(userId: string, now = Date.now()): Promise<{ allowed: true; reservedAt: number } | { allowed: false; retryAt?: number }> {
    const user = this.mustUser(userId);
    const rule = this.permissionsFor(user).duelLimit;
    const status = duelLimitStatus(rule, this.duelRoomCooldowns[userId] ?? [], now);
    if (!status.allowed) return { allowed: false, retryAt: status.retryAt };
    if (rule.period === "unlimited") return { allowed: true, reservedAt: now };
    this.duelRoomCooldowns[userId] = pruneDuelRecords(rule, this.duelRoomCooldowns[userId] ?? [], now).concat(now);
    await this.save();
    return { allowed: true, reservedAt: now };
  }

  async releaseDuelRoomCreation(userId: string, reservedAt: number): Promise<void> {
    const records = this.duelRoomCooldowns[userId];
    if (!records?.includes(reservedAt)) return;
    const next = records.filter((item) => item !== reservedAt);
    if (next.length) this.duelRoomCooldowns[userId] = next;
    else delete this.duelRoomCooldowns[userId];
    await this.save();
  }

  async recordDuelRoomCreation(userId: string, now = Date.now()): Promise<void> {
    const user = this.mustUser(userId);
    const rule = this.permissionsFor(user).duelLimit;
    if (rule.period === "unlimited") return;
    this.duelRoomCooldowns[userId] = pruneDuelRecords(rule, this.duelRoomCooldowns[userId] ?? [], now).concat(now);
    await this.save();
  }

  taxContextForUserId(userId?: string): { taxRatePercent: number; taxWinnerPointsThreshold?: number; winnerPointsBeforeSettlement: number } {
    const user = userId ? this.users.find((item) => item.id === userId) : undefined;
    return {
      taxRatePercent: normalizeTaxRatePercent(user?.taxRatePercent, this.taxRatePercent),
      taxWinnerPointsThreshold: this.taxWinnerPointsThreshold,
      winnerPointsBeforeSettlement: user?.points ?? 0,
    };
  }

  async updatePermissions(actor: StoredUser, payload: { role?: UserRole; userId?: string; permissions: Partial<PermissionRule> | null }): Promise<void> {
    this.mustSuperAdmin(actor);
    if (Boolean(payload.role) === Boolean(payload.userId)) throw new Error("每次只能修改一个身份组或一个用户的权限");
    if (payload.role) this.rolePermissions[payload.role] = normalizePermissionRule({ ...this.rolePermissions[payload.role], ...(payload.permissions ?? {}) });
    if (payload.userId) {
      this.mustUser(payload.userId);
      if (payload.permissions === null) delete this.userPermissions[payload.userId];
      else this.userPermissions[payload.userId] = { permissions: normalizePermissionPatch(payload.permissions), permanent: true };
    }
    await this.save();
  }

  async createRequest(actor: StoredUser, input: { kind: RequestKind; text?: string; privateToSuperAdmin?: boolean; requestedNickname?: string }): Promise<UserRequest> {
    const kind = validateRequestKind(input.kind);
    const requestedNickname = kind === "nickname" ? validateNickname(input.requestedNickname ?? "") : undefined;
    const text = kind === "nickname" ? `申请修改昵称为：${requestedNickname}` : cleanRequired(input.text ?? "", 1000);
    const request: UserRequest = {
      id: uid("req"),
      kind,
      fromUserId: actor.id,
      text,
      privateToSuperAdmin: Boolean(input.privateToSuperAdmin),
      requestedNickname,
      status: "open",
      createdAt: nextRequestActivityAt(this.requests),
      banSnapshot:
        kind === "unban"
          ? {
              disabledAt: actor.disabledAt,
              disabledUntil: actor.disabledUntil,
              disabledPermanent: actor.disabledPermanent,
              disabledBy: actor.disabledBy,
            }
          : undefined,
    };
    if (kind === "unban") {
      if (!isUserDisabled(actor)) throw new Error("当前账号未被禁用");
      actor.disabledAt ??= Date.now();
      if (actor.unbanRequestedForDisabledAt === actor.disabledAt) throw new Error("本次被禁用后只能提交一次解封申请");
      actor.unbanRequestedForDisabledAt = actor.disabledAt;
      actor.updatedAt = Date.now();
    }
    this.requests.push(request);
    await this.save();
    return structuredClone(request);
  }

  listRequests(actor: StoredUser): UserRequest[] {
    const actorView = this.publicFor(actor);
    if (actorView.role === "super-admin") return structuredClone(this.requests).sort((a, b) => b.createdAt - a.createdAt);
    if (actorView.role === "admin" || actorView.role === "admin-advanced") {
      return structuredClone(this.requests)
        .filter((item) => item.kind !== "security" && !item.privateToSuperAdmin)
        .sort((a, b) => b.createdAt - a.createdAt);
    }
    return structuredClone(this.requests)
      .filter((item) => item.kind !== "security" && item.fromUserId === actor.id)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  requestSeenThrough(actor: StoredUser): number {
    return this.requestSeenAtByUserId[actor.id] ?? 0;
  }

  async acknowledgeRequests(actor: StoredUser, through?: number): Promise<number> {
    const maximum = maxRequestActivity(this.listRequests(actor));
    const requested = Number.isFinite(through) ? Math.max(0, Math.floor(through!)) : maximum;
    const seenThrough = Math.max(this.requestSeenThrough(actor), Math.min(requested, maximum));
    this.requestSeenAtByUserId[actor.id] = seenThrough;
    await this.save();
    return seenThrough;
  }

  async respondRequest(actor: StoredUser, requestId: string, input: { status: UserRequest["status"]; reply?: string }): Promise<UserRequest> {
    const actorView = this.publicFor(actor);
    if (actorView.role !== "super-admin" && actorView.role !== "admin" && actorView.role !== "admin-advanced") throw new Error("没有权限处理申请");
    const request = this.requests.find((item) => item.id === requestId);
    if (!request) throw new Error("申请不存在");
    if ((request.privateToSuperAdmin || request.kind === "security") && actorView.role !== "super-admin") throw new Error("该申请仅超级管理员可处理");
    if (request.status !== "open") throw new Error("该申请已经处理");
    if (!["approved", "replied", "ignored"].includes(input.status)) throw new Error("处理状态不正确");
    if (request.kind === "security" && input.status === "ignored") {
      this.requests = this.requests.filter((item) => item.id !== request.id);
      await this.save();
      return { ...structuredClone(request), status: "ignored", repliedAt: nextRequestActivityAt(this.requests) };
    }
    request.status = input.status;
    request.reply = input.reply ? cleanOptional(input.reply, 1000) : undefined;
    request.replyUserId = actor.id;
    request.repliedAt = nextRequestActivityAt(this.requests);
    if (request.kind === "nickname" && request.status === "approved" && request.requestedNickname) {
      const target = this.mustUser(request.fromUserId);
      target.nickname = request.requestedNickname;
      target.updatedAt = Date.now();
    }
    if (request.kind === "unban" && request.status === "approved") {
      const target = this.mustUser(request.fromUserId);
      target.disabledPermanent = false;
      target.disabledUntil = undefined;
      target.updatedAt = Date.now();
    }
    await this.save();
    return structuredClone(request);
  }

  async setWinMusic(actor: StoredUser, targetId: string, music: UserMusic, currentPassword: string): Promise<void> {
    const target = this.mustUser(targetId);
    const actorView = this.publicFor(actor);
    const targetView = this.publicFor(target);
    if (!canManageWinMusic(actorView, targetView)) throw new Error("没有权限修改该用户胜利音乐");
    if (!targetView.hasAdvancedPerk) throw new Error("只有当前有效的高级用户或超级管理员可以设置胜利音乐");
    if (!(await this.verifyCurrentPassword(actor, currentPassword))) throw new Error("请先验证当前密码");
    if (!music.dataUrl) throw new Error("音乐文件无效");
    const parsed = parseVictoryMusicDataUrl(music.dataUrl);
    const hashes = hashMusicBytes(parsed.bytes);
    target.winMusic = {
      ...music,
      ...hashes,
      fileName: music.fileName.slice(0, 160),
      mimeType: parsed.mimeType,
      size: parsed.size,
      durationSeconds: parsed.durationSeconds,
      uploadedAt: Date.now(),
    };
    target.updatedAt = Date.now();
    await this.save();
  }

  async deleteWinMusic(actor: StoredUser, targetId: string, currentPassword: string): Promise<void> {
    const target = this.mustUser(targetId);
    const actorView = this.publicFor(actor);
    const targetView = this.publicFor(target);
    if (!canManageWinMusic(actorView, targetView)) throw new Error("没有权限删除该用户胜利音乐");
    if (!(await this.verifyCurrentPassword(actor, currentPassword))) throw new Error("请先验证当前密码");
    target.winMusic = undefined;
    target.updatedAt = Date.now();
    await this.save();
  }

  winMusicForPublic(userId: string): UserMusic | undefined {
    const user = this.users.find((item) => item.id === userId);
    if (!user || !user.winMusic) return undefined;
    if (!this.publicFor(user).hasAdvancedPerk) return undefined;
    const music = structuredClone(user.winMusic);
    return music.dataUrl && (!music.sha1 || !music.sha256) ? { ...music, ...hashMusicDataUrl(music.dataUrl) } : music;
  }

  winMusicForActor(actor: StoredUser, userId: string, purpose: "play" | "download"): UserMusic | undefined {
    const target = this.users.find((item) => item.id === userId);
    if (!target?.winMusic) return undefined;
    const actorView = this.publicFor(actor);
    const targetView = this.publicFor(target);
    if (purpose === "download") {
      if (!canDownloadWinMusic(actorView, targetView)) throw new Error("没有权限下载该用户胜利音乐");
    } else {
      if (!canPlayWinMusic(actorView, targetView)) throw new Error("没有权限播放该用户胜利音乐");
      if (!targetView.hasAdvancedPerk && !canPlayDownloadedWinMusic(actorView, targetView)) return undefined;
    }
    const music = structuredClone(target.winMusic);
    return music.dataUrl && (!music.sha1 || !music.sha256) ? { ...music, ...hashMusicDataUrl(music.dataUrl) } : music;
  }

  winMusicManifest(actor: StoredUser, userIds: string[]): WinMusicManifestEntry[] {
    return [...new Set(userIds)].flatMap((userId) => {
      const target = this.users.find((user) => user.id === userId);
      if (!target) return [];
      const actorView = this.publicFor(actor);
      const targetView = this.publicFor(target);
      if (!canPlayWinMusic(actorView, targetView) && !canPlayDownloadedWinMusic(actorView, targetView)) return [];
      if (!targetView.hasAdvancedPerk && !canPlayDownloadedWinMusic(actorView, targetView)) return [];
      const music = target.winMusic?.dataUrl && (!target.winMusic.sha1 || !target.winMusic.sha256)
        ? { ...target.winMusic, ...hashMusicDataUrl(target.winMusic.dataUrl) }
        : target.winMusic;
      if (!music?.dataUrl || !music.sha1 || !music.sha256) return [];
      return [
        {
          userId,
          fileName: music.fileName,
          mimeType: music.mimeType,
          size: music.size,
          sha1: music.sha1,
          sha256: music.sha256,
        },
      ];
    });
  }

  rawUsersForTest(): StoredUser[] {
    return structuredClone(this.users);
  }

  async setPasswordForTest(userId: string, password: string): Promise<void> {
    const user = this.mustUser(userId);
    user.passwordHash = await this.passwordHasher(password);
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    this.revokeSessionsForUser(user.id);
  }

  async recordSecurityEvent(input: SecurityAuditEventInput): Promise<void> {
    const now = input.occurredAt ?? Date.now();
    this.finalizeExpiredSecurityIncidents(now);
    let incident = this.securityIncidents.find(
      (item) => !item.reportedAt && item.subjectKey === input.subjectKey && now < item.endsAt,
    );
    if (!incident) {
      incident = {
        id: uid("security"),
        subjectKey: input.subjectKey,
        actorUserId: input.actorUserId,
        startedAt: now,
        endsAt: now + SECURITY_CAPTURE_MS,
        events: [],
      };
      this.securityIncidents.push(incident);
    }
    const event: SecurityAuditEvent = {
      actorUserId: input.actorUserId,
      subjectKey: input.subjectKey,
      category: input.category,
      operation: cleanRequired(input.operation, 160),
      method: cleanRequired(input.method, 16),
      route: cleanRequired(input.route, 240),
      ip: cleanOptional(input.ip ?? null, 160),
      userAgent: cleanOptional(input.userAgent ?? null, 500),
      details: sanitizeAuditDetails(input.details),
      occurredAt: now,
    };
    if (incident.events.length < MAX_SECURITY_EVENTS_PER_INCIDENT) incident.events.push(event);
    else incident.suppressedEvents = (incident.suppressedEvents ?? 0) + 1;
    await this.save();
  }

  async flushSecurityIncidents(now = Date.now()): Promise<void> {
    if (this.finalizeExpiredSecurityIncidents(now)) await this.save();
  }

  securityLog(actor: StoredUser, incidentId: string): string {
    this.mustSuperAdmin(actor);
    const incident = this.securityIncidents.find((item) => item.id === incidentId);
    if (!incident) throw new Error("安全日志不存在");
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

  private async issueAuth(user: StoredUser): Promise<AuthResult> {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, user.id);
    return { token, user: this.publicFor(user, true, user) };
  }

  private revokeSessionsForUser(userId: string): void {
    for (const [token, sessionUserId] of this.sessions) {
      if (sessionUserId === userId) this.sessions.delete(token);
    }
  }

  private async verifyCurrentPassword(user: StoredUser, password?: string): Promise<boolean> {
    return typeof password === "string" && (await verifyPassword(password, user.passwordHash));
  }

  private async setUsername(user: StoredUser, username: string): Promise<void> {
    const cleanUsername = validateUsername(username);
    const lookup = this.lookup(cleanUsername);
    const existing = this.users.find((item) => item.usernameLookup === lookup && item.id !== user.id);
    if (existing) throw new Error("用户名已存在");
    user.usernameEncrypted = this.encrypt(cleanUsername);
    user.usernameLookup = lookup;
  }

  private mustUser(id: string): StoredUser {
    const user = this.users.find((item) => item.id === id);
    if (!user) throw new Error("用户不存在");
    return user;
  }

  private mustSuperAdmin(actor: StoredUser): void {
    if (!actor.superAdmin) throw new Error("只有超级管理员可以执行该操作");
  }

  private permissionsFor(user: StoredUser): PermissionRule {
    const role = roleFor(user);
    const override = this.userPermissions[user.id];
    const activeOverride = override && (override.permanent || !override.expiresAt || Date.parse(override.expiresAt) > Date.now()) ? override.permissions : {};
    return normalizePermissionRule({ ...this.rolePermissions[role], ...activeOverride });
  }

  private customModeLimitsFor(user: StoredUser): CustomModeLimits {
    const override = this.userCustomModeLimits[user.id];
    const active = override && (override.permanent || !override.expiresAt || Date.parse(override.expiresAt) > Date.now()) ? override.limits : {};
    const globalLimits: CustomModeLimits = {
      maxBaseBet:
        this.customModeLimits.maxBaseBet.mode === "classic-multiple"
          ? (() => {
              const value = resolveCustomMaxBaseBet(this.customModeLimits.maxBaseBet, this.rolePermissions.normal.maxBaseBet);
              return value === null ? ({ mode: "unlimited" } as const) : ({ mode: "absolute", value } as const);
            })()
          : this.customModeLimits.maxBaseBet,
      settlementCap: this.customModeLimits.settlementCap,
    };
    return normalizeCustomModeLimits(active, globalLimits);
  }

  private consumeInvitation(
    code: string,
    context: RegistrationContext | undefined,
    userId: string,
    now: number,
  ): InvitationCode {
    const clean = validateInviteCode(code);
    const invite = this.invitations.find((item) => item.code === clean);
    if (!invite) throw new Error("邀请码不存在");
    if (invite.expiresAt && Date.parse(invite.expiresAt) <= now) throw new Error("邀请码已失效");
    const deviceId = context?.deviceId?.trim() ?? `internal:${userId}`;
    const browserFingerprint = context?.browserFingerprint?.trim() ?? `internal:${userId}`;
    if (!deviceId || !browserFingerprint || deviceId.length > 160 || browserFingerprint.length > 160) {
      throw new Error("无法确认注册设备或浏览器环境");
    }
    normalizeInvitationQuota(invite);
    const deviceHash = this.registrationHash("device", deviceId);
    const browserHash = this.registrationHash("browser", browserFingerprint);
    const today = todayKey(now);
    const alreadyRegistered = (invite.registrations ?? []).some(
      (registration) =>
        todayKey(registration.usedAt) === today &&
        (registration.deviceHash === deviceHash || registration.browserHash === browserHash),
    );
    if (alreadyRegistered) throw new Error("该设备或浏览器今天已使用此邀请码注册过账号");
    enforceInvitationQuota(invite, now);
    invite.registrations!.push({ userId, usedAt: now, deviceHash, browserHash });
    syncInvitationRemainingUses(invite, now);
    invite.updatedAt = now;
    return structuredClone(invite);
  }

  private preflightInvitation(
    code: string,
    context: RegistrationContext | undefined,
    userId: string,
    now: number,
  ): InvitationCode {
    const clean = validateInviteCode(code);
    const invite = this.invitations.find((item) => item.code === clean);
    if (!invite) throw new Error("邀请码不存在");
    if (invite.expiresAt && Date.parse(invite.expiresAt) <= now) throw new Error("邀请码已失效");
    const deviceId = context?.deviceId?.trim() ?? `internal:${userId}`;
    const browserFingerprint = context?.browserFingerprint?.trim() ?? `internal:${userId}`;
    if (!deviceId || !browserFingerprint || deviceId.length > 160 || browserFingerprint.length > 160) {
      throw new Error("无法确认注册设备或浏览器环境");
    }
    normalizeInvitationQuota(invite);
    const deviceHash = this.registrationHash("device", deviceId);
    const browserHash = this.registrationHash("browser", browserFingerprint);
    const today = todayKey(now);
    if (
      (invite.registrations ?? []).some(
        (registration) =>
          todayKey(registration.usedAt) === today &&
          (registration.deviceHash === deviceHash || registration.browserHash === browserHash),
      )
    ) {
      throw new Error("该设备或浏览器今天已使用此邀请码注册过账号");
    }
    enforceInvitationQuota(invite, now);
    return invite;
  }

  private serializeMutation<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.mutationQueue.then(task, task);
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async grantReservedRoomCode(
    user: Pick<StoredUser, "id" | "reservedRoomCodes">,
    mode: ReservedRoomCodeGrantMode,
    suppliedCode: string | undefined,
    superAdminOverride: boolean,
  ): Promise<string> {
    const codes = user.reservedRoomCodes ?? [];
    if (!superAdminOverride && codes.length >= MAX_SELF_MANAGED_RESERVED_ROOM_CODES) {
      throw new Error("专属房间号已达到 10 个上限，无法兑换邀请码或激活码");
    }
    if (mode === "user-input") {
      const clean = validateReservedRoomCode(suppliedCode ?? "", false);
      const owner = this.reservedRoomCodeOwner(clean);
      if (owner && owner.id !== user.id) throw new Error("该专属房间号已被其他用户占用");
      if (codes.includes(clean)) throw new Error("该用户已拥有此专属房间号");
      if (await this.reservedRoomCodeIsOccupied(clean)) throw new Error("该专属房间号已被现有房间占用");
      return clean;
    }
    for (let attempt = 0; attempt < 1_000; attempt++) {
      const candidate = randomInt(0, 1_000_000).toString().padStart(6, "0");
      if (!this.reservedRoomCodeOwner(candidate) && !codes.includes(candidate) && !(await this.reservedRoomCodeIsOccupied(candidate))) return candidate;
    }
    throw new Error("暂时无法生成未占用的专属房间号，请稍后重试");
  }

  private ensureRedemptionReservedRoomCodeAllowance(user: StoredUser): void {
    if ((user.reservedRoomCodes?.length ?? 0) > MAX_SELF_MANAGED_RESERVED_ROOM_CODES) {
      throw new Error("专属房间号超过 10 个，无法兑换邀请码或激活码");
    }
  }

  private registrationHash(kind: "device" | "browser", value: string): string {
    return createHmac("sha256", this.hmacKey).update(`registration:${kind}:${value}`).digest("hex");
  }

  private finalizeExpiredSecurityIncidents(now: number): boolean {
    let changed = false;
    const fallbackUser = this.users.find((user) => user.superAdmin);
    for (const incident of this.securityIncidents) {
      if (incident.reportedAt || incident.endsAt > now || incident.events.length === 0) continue;
      const request: UserRequest = {
        id: uid("req"),
        kind: "security",
        fromUserId: incident.actorUserId ?? fallbackUser?.id ?? "system",
        text: `安全审计：2 小时内记录 ${incident.events.length} 次明确非法请求${incident.suppressedEvents ? `，另有 ${incident.suppressedEvents} 次被折叠` : ""}`,
        privateToSuperAdmin: true,
        status: "open",
        securityLogId: incident.id,
        securitySubject: incident.subjectKey,
        createdAt: nextRequestActivityAt(this.requests),
      };
      incident.reportedAt = now;
      incident.requestId = request.id;
      this.requests.push(request);
      changed = true;
    }
    this.securityIncidents = this.securityIncidents.slice(-2_000);
    return changed;
  }

  private findByUsername(username: string): StoredUser | undefined {
    return this.users.find((user) => user.usernameLookup === this.lookup(username));
  }

  private async load(): Promise<void> {
    if (this.redis) {
      const raw = await this.redis.get(USERS_KEY);
      if (raw) {
        this.applyPayload(JSON.parse(raw));
        return;
      }
      this.users = await this.readFileUsers();
      await this.redis.set(USERS_KEY, JSON.stringify({ version: 1, users: this.users }, null, 2));
      return;
    }
    this.users = await this.readFileUsers();
  }

  private async readFileUsers(): Promise<StoredUser[]> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const payload = JSON.parse(raw);
      this.applyPayload(payload);
      return this.users;
    } catch {
      return [];
    }
  }

  private async save(): Promise<void> {
    const previousSave = this.saveQueue.catch(() => undefined);
    const nextSave = previousSave.then(async () => {
      const payload = JSON.stringify(
        {
          version: 1,
          users: this.users,
          invitations: this.invitations,
          activationCodes: this.activationCodes,
          requests: this.requests,
          requestSeenAtByUserId: this.requestSeenAtByUserId,
          rolePermissions: this.rolePermissions,
          customModeLimits: this.customModeLimits,
          taxRatePercent: this.taxRatePercent,
          taxWinnerPointsThreshold: this.taxWinnerPointsThreshold,
          userPermissions: this.userPermissions,
          userCustomModeLimits: this.userCustomModeLimits,
          settledGameIds: this.settledGameIds,
          customRulesPresets: this.customRulesPresets,
          securityIncidents: this.securityIncidents,
          duelRoomCooldowns: this.duelRoomCooldowns,
        },
        null,
        2,
      );
      if (this.redis) {
        await this.redis.set(USERS_KEY, payload);
        return;
      }
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, payload, "utf-8");
    });
    this.saveQueue = nextSave.catch(() => undefined);
    await nextSave;
  }

  private applyPayload(payload: {
    users?: StoredUser[];
    invitations?: InvitationCode[];
    activationCodes?: ActivationCode[];
    requests?: UserRequest[];
    requestSeenAtByUserId?: Record<string, number>;
    rolePermissions?: Record<UserRole, PermissionRule & LegacyCustomPermissionFields>;
    customModeLimits?: CustomModeLimits;
    taxRatePercent?: number;
    taxWinnerPointsThreshold?: number | null;
    userPermissions?: Record<string, UserPermissionOverride | Partial<PermissionRule>>;
    userCustomModeLimits?: Record<string, UserCustomModeLimitOverride>;
    settledGameIds?: string[];
    customRulesPresets?: CustomRulesPreset[];
    securityIncidents?: SecurityIncident[];
    duelRoomCooldowns?: Record<string, number | number[]>;
  }): void {
    this.users = (payload.users ?? []).map((user) => ({
      ...user,
      reservedRoomCodes: [...new Set((user.reservedRoomCodes ?? []).filter((code) => typeof code === "string" && /^\d+$/.test(code)))],
    }));
    this.invitations = (payload.invitations ?? []).map((invitation) => ({
      ...invitation,
      customModeLimits: legacyCustomModeGrant(invitation),
      permissions: invitation.permissions ? normalizePermissionPatch(invitation.permissions) : undefined,
    }));
    this.activationCodes = (payload.activationCodes ?? []).map((activation) => ({
      ...activation,
      customModeLimits: legacyCustomModeGrant(activation),
      permissions: activation.permissions ? normalizePermissionPatch(activation.permissions) : undefined,
      customModeLimitDurationMs:
        activation.customModeLimitDurationMs ??
        (legacyCustomModeGrant(activation) ? activation.permissionDurationMs : undefined),
    }));
    this.requests = payload.requests ?? [];
    this.requestSeenAtByUserId = payload.requestSeenAtByUserId ?? {};
    const defaults = defaultRolePermissions();
    this.rolePermissions = Object.fromEntries(
      (Object.keys(defaults) as UserRole[]).map((role) => [
        role,
        normalizePermissionRule({ ...defaults[role], ...(payload.rolePermissions?.[role] ?? {}) }),
      ]),
    ) as Record<UserRole, PermissionRule>;
    const legacyNormal = payload.rolePermissions?.normal;
    this.customModeLimits = normalizeCustomModeLimits(
      payload.customModeLimits ?? {
        maxBaseBet: legacyNormal?.customMaxBaseBet,
        settlementCap: legacyNormal?.customSettlementCap,
      },
    );
    this.taxRatePercent = normalizeTaxRatePercent(payload.taxRatePercent, DEFAULT_TAX_RATE_PERCENT);
    this.taxWinnerPointsThreshold = normalizeTaxWinnerPointsThreshold(payload.taxWinnerPointsThreshold, undefined);
    const legacyUserPermissionEntries = Object.entries(payload.userPermissions ?? {});
    this.userPermissions = Object.fromEntries(
      legacyUserPermissionEntries.map(([userId, value]) => [
        userId,
        "permissions" in value
          ? { ...value, permissions: normalizePermissionPatch(value.permissions) }
          : { permissions: normalizePermissionPatch(value), permanent: true },
      ]),
    );
    this.userCustomModeLimits = Object.fromEntries(
      [
        ...legacyUserPermissionEntries.flatMap(([userId, value]) => {
          const entry = "permissions" in value ? value : { permissions: value, permanent: true };
          const limits = legacyCustomModeGrant(entry);
          return limits ? [[userId, { limits, expiresAt: entry.expiresAt, permanent: entry.permanent }] as const] : [];
        }),
        ...Object.entries(payload.userCustomModeLimits ?? {}).map(([userId, value]) => [
          userId,
          { ...value, limits: normalizeCustomModeLimitGrant(value.limits) },
        ] as const),
      ],
    );
    this.settledGameIds = Array.isArray(payload.settledGameIds) ? payload.settledGameIds.slice(-10_000) : [];
    this.customRulesPresets = Array.isArray(payload.customRulesPresets)
      ? payload.customRulesPresets.map((preset) => ({
          ...preset,
          revision: Number.isInteger(preset.revision) && (preset.revision as number) > 0 ? preset.revision : 1,
          enabled: preset.enabled !== false,
        }))
      : [];
    this.securityIncidents = Array.isArray(payload.securityIncidents) ? payload.securityIncidents.slice(-2_000) : [];
    this.duelRoomCooldowns = normalizeDuelRecordMap(payload.duelRoomCooldowns);
  }

  private async ensureSuperAdmin(): Promise<void> {
    const superAdmins = this.users.filter((user) => user.superAdmin);
    if (superAdmins.length !== 1) throw new Error("初始用户数据必须且只能包含一个超级管理员");
  }

  private async bootstrapSuperAdmin(): Promise<void> {
    const username = validateUsername(this.bootstrapSuperAdminUsername);
    const password = this.bootstrapSuperAdminPassword;
    const usesPublishedDefault = username === DEFAULT_SUPER_USERNAME && password === DEFAULT_SUPER_PASSWORD;
    if (!usesPublishedDefault) {
      if (password.length < 12) throw new Error("自定义初始超级管理员密码至少需要 12 个字符");
      validatePassword(password);
    } else {
      console.warn("[security] 正在使用默认初始管理员 admin/admin；请在对外开放服务前立即修改密码");
    }
    const now = Date.now();
    this.users.push({
      id: "u_initial_super_admin",
      usernameEncrypted: this.encrypt(username),
      usernameLookup: this.lookup(username),
      passwordHash: await this.passwordHasher(password),
      sessionVersion: 0,
      nickname: username,
      points: DEFAULT_POINTS,
      disabledPermanent: false,
      nicknameChangeDisabled: false,
      superAdmin: true,
      adminPermanent: false,
      advancedPermanent: false,
      gamesPlayed: 0,
      gamesWon: 0,
      createdAt: now,
      updatedAt: now,
    });
    await this.save();
  }

  private async migratePreviousSecretIfNeeded(): Promise<void> {
    let changed = false;
    for (const user of this.users) {
      try {
        decryptUsername(user.usernameEncrypted, this.encKey);
        continue;
      } catch {
        if (!this.previousEncKey) {
          throw new Error("无法使用 AUTH_SECRET 解密账户数据；如正在轮换密钥，请临时设置 AUTH_SECRET_PREVIOUS");
        }
      }
      const username = decryptUsername(user.usernameEncrypted, this.previousEncKey);
      user.usernameEncrypted = this.encrypt(username);
      user.usernameLookup = this.lookup(username);
      user.updatedAt = Date.now();
      changed = true;
    }
    if (changed) await this.save();
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
  }

  private decrypt(value: string): string {
    try {
      return decryptUsername(value, this.encKey);
    } catch {
      if (this.previousEncKey) return decryptUsername(value, this.previousEncKey);
      throw new Error("无法解密账户用户名；请检查 AUTH_SECRET 或配置 AUTH_SECRET_PREVIOUS 完成密钥轮换");
    }
  }

  private lookup(username: string): string {
    return createHmac("sha256", this.hmacKey).update(normalizeUsername(username)).digest("hex");
  }
}

export function roleFor(user: Pick<StoredUser, "superAdmin" | "adminPermanent" | "advancedPermanent" | "adminExpiresAt" | "advancedExpiresAt">, now = Date.now()): UserRole {
  if (user.superAdmin) return "super-admin";
  const admin = user.adminPermanent || isFuture(user.adminExpiresAt, now);
  const advanced = user.advancedPermanent || isFuture(user.advancedExpiresAt, now);
  if (admin && advanced) return "admin-advanced";
  if (admin) return "admin";
  if (advanced) return "advanced";
  return "normal";
}

export function colorForRole(role: UserRole): string {
  return ROLE_COLORS[role];
}

function applyRolePatch(actor: PublicUser, target: PublicUser, stored: StoredUser, patch: UserPatch): void {
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

function canViewAll(actor: StoredUser): boolean {
  const role = roleFor(actor);
  return role === "super-admin" || role === "admin" || role === "admin-advanced";
}

function canViewReservedRoomCodes(actor: StoredUser, target: StoredUser): boolean {
  if (actor.id === target.id || actor.superAdmin) return true;
  const actorRole = roleFor(actor);
  const targetRole = roleFor(target);
  return (actorRole === "admin" || actorRole === "admin-advanced") && (targetRole === "advanced" || targetRole === "normal");
}

function canManageNickname(actor: PublicUser, target: PublicUser): boolean {
  if (target.superAdmin) return false;
  if (actor.role === "super-admin") return true;
  if (actor.role === "admin" || actor.role === "admin-advanced") return target.role !== "admin" && target.role !== "admin-advanced";
  return false;
}

function canManageBan(actor: PublicUser, target: PublicUser): boolean {
  if (actor.role === "super-admin") return !target.superAdmin;
  if (actor.role === "admin" || actor.role === "admin-advanced") return target.role !== "admin" && target.role !== "admin-advanced" && target.role !== "super-admin";
  return false;
}

function hasRolePatch(patch: UserPatch): boolean {
  return (
    patch.adminPermanent !== undefined ||
    patch.advancedPermanent !== undefined ||
    patch.adminExpiresAt !== undefined ||
    patch.advancedExpiresAt !== undefined
  );
}

function touchesProtectedFields(patch: UserPatch): boolean {
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

function validateUsername(username: string): string {
  const clean = username.trim();
  assertSpreadsheetSafeAccountName(clean, "用户名");
  if (clean.length < 1 || clean.length > 24) throw new Error("用户名长度必须为 1-24 个字符");
  return clean;
}

function validateInviteCode(code: string): string {
  const clean = code.trim();
  assertSpreadsheetSafeText(clean, "邀请码");
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(clean)) throw new Error("邀请码只能包含 3-32 位字母、数字、下划线或短横线");
  return clean;
}

function validateReservedRoomCode(code: string, superAdminOverride: boolean): string {
  const clean = String(code).trim();
  if (!/^\d+$/.test(clean)) throw new Error("专属房间号只能包含数字");
  if (!superAdminOverride && clean.length > 6) throw new Error("专属房间号不能超过 6 位");
  return clean;
}

function validateRole(role: UserRole): UserRole {
  if (!["super-admin", "admin-advanced", "admin", "advanced", "normal"].includes(role)) throw new Error("身份组不正确");
  if (role === "super-admin") throw new Error("邀请码不能直接授予超级管理员");
  return role;
}

function validateRequestKind(kind: RequestKind): RequestKind {
  if (!["ticket", "unban", "nickname"].includes(kind)) throw new Error("申请类型不正确");
  return kind;
}

function validateInvitationPolicy(policy: InvitationUsePolicy): InvitationUsePolicy {
  if (!["unlimited", "global-total", "global-window"].includes(policy)) throw new Error("邀请码使用策略不正确");
  return policy;
}

function validateActivationPolicy(policy: ActivationUsePolicy): ActivationUsePolicy {
  if (!["unlimited", "global-total", "per-user-total", "global-window", "per-user-window"].includes(policy)) throw new Error("激活码使用策略不正确");
  return policy;
}

function validateActivationTitleMode(mode: ActivationTitleMode): ActivationTitleMode {
  if (!["default", "fixed", "user-custom"].includes(mode)) throw new Error("激活码头衔模式不正确");
  return mode;
}

function validateReservedRoomCodeGrantMode(mode: ReservedRoomCodeGrantMode): ReservedRoomCodeGrantMode {
  if (mode !== "user-input" && mode !== "random") throw new Error("专属房间号发放方式不正确");
  return mode;
}

function cleanRequired(value: string, maxLength: number): string {
  const clean = value.trim();
  if (!clean) throw new Error("内容不能为空");
  return clean.slice(0, maxLength);
}

function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < 6 || password.length > 72) throw new Error("密码长度必须为 6-72 个字符");
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

function cleanInteger(value: number, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label}必须是整数`);
  return value;
}

function cleanNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label}必须是非负整数`);
  return value;
}

function cleanPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}必须是正整数`);
  return value;
}

function equalPointGrants(userIds: string[], perUserPoints: number): Array<{ userId: string; points: number }> {
  if (!Number.isInteger(perUserPoints)) throw new Error("每个人得到的积分数必须是整数");
  return userIds.map((userId) => ({ userId, points: perUserPoints }));
}

function randomPointGrants(userIds: string[], totalPoints: number): Array<{ userId: string; points: number }> {
  if (!Number.isInteger(totalPoints) || totalPoints < userIds.length) throw new Error("发放总积分数必须为整数，且不得小于发放人数");
  let remaining = totalPoints;
  const grants: Array<{ userId: string; points: number }> = [];
  for (let index = 0; index < userIds.length; index += 1) {
    const remainingUses = userIds.length - index;
    const points = remainingUses === 1 ? remaining : 1 + randomInt(randomPointRewardUpperBound(remaining, remainingUses));
    grants.push({ userId: userIds[index], points });
    remaining -= points;
  }
  return grants;
}

function cleanGrantDuration(value: number | null, label: string): number | null {
  if (value === null) return null;
  return cleanPositiveInteger(value, label);
}

function applyInvitationGrantPatch(
  invitation: InvitationCode,
  kind: "admin" | "advanced",
  durationPatch: number | null | false | undefined,
  expiryPatch: string | null | undefined,
  permanentPatch: boolean | undefined,
): void {
  const durationKey = kind === "admin" ? "adminDurationMs" : "advancedDurationMs";
  const expiryKey = kind === "admin" ? "adminExpiresAt" : "advancedExpiresAt";
  const permanentKey = kind === "admin" ? "adminPermanent" : "advancedPermanent";
  let duration = invitation[durationKey];
  let expiresAt = invitation[expiryKey];
  let permanent = invitation[permanentKey];

  if (durationPatch !== undefined) {
    if (durationPatch === false) {
      duration = undefined;
    } else {
      duration = cleanGrantDuration(durationPatch, kind === "admin" ? "管理员相对时长" : "高级用户相对时长");
      expiresAt = undefined;
      permanent = duration === null;
    }
  }
  if (expiryPatch !== undefined && (durationPatch === undefined || durationPatch === false)) {
    expiresAt = cleanExpiry(expiryPatch);
    if (expiresAt) {
      duration = undefined;
      permanent = false;
    } else if (durationPatch === false) {
      duration = undefined;
      permanent = false;
    }
  }
  if (permanentPatch !== undefined && durationPatch === undefined && expiryPatch === undefined) {
    permanent = Boolean(permanentPatch);
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

function normalizeInvitationRoleGrants(invitation: InvitationCode): void {
  for (const kind of ["admin", "advanced"] as const) {
    const enabled = invitationRoleIncludes(invitation.role, kind);
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

function applyInvitationIdentity(user: StoredUser, invitation: InvitationCode, now: number): void {
  applyInvitationIdentityGrant(user, invitation, "admin", now);
  applyInvitationIdentityGrant(user, invitation, "advanced", now);
}

function normalizeInvitationQuota(invitation: InvitationCode): void {
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
  syncInvitationRemainingUses(invitation, Date.now());
}

function enforceInvitationQuota(invitation: InvitationCode, now: number): void {
  normalizeInvitationQuota(invitation);
  if (invitation.usePolicy === "unlimited") return;
  const registrations =
    invitation.usePolicy === "global-window"
      ? invitation.registrations!.filter((item) => item.usedAt > now - invitation.windowMs!)
      : invitation.registrations!;
  if (registrations.length >= invitation.maxUses!) {
    throw new Error(invitation.usePolicy === "global-window" ? "邀请码在当前滚动周期内已达到注册上限" : "邀请码可用次数已用完");
  }
}

function syncInvitationRemainingUses(invitation: InvitationCode, now: number): void {
  if (invitation.usePolicy !== "global-total") {
    invitation.remainingUses = null;
    return;
  }
  const used = invitation.registrations?.filter((item) => item.usedAt <= now).length ?? 0;
  invitation.remainingUses = Math.max(0, (invitation.maxUses ?? 1) - used);
}

function applyInvitationIdentityGrant(user: StoredUser, invitation: InvitationCode, kind: "admin" | "advanced", now: number): void {
  const enabled = invitationRoleIncludes(invitation.role, kind);
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

function invitationRoleIncludes(role: UserRole, kind: "admin" | "advanced"): boolean {
  return kind === "admin" ? role === "admin" || role === "admin-advanced" : role === "advanced" || role === "admin-advanced";
}

function normalizeUsername(username: string): string {
  return username.trim().toLocaleLowerCase("zh-Hans-CN");
}

function cleanOptional(value: string | null, maxLength: number): string | undefined {
  if (value === null) return undefined;
  const clean = String(value).trim();
  if (!clean) return undefined;
  return clean.slice(0, maxLength);
}

function cleanExpiry(value: string | null): string | undefined {
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("到期时间格式不正确");
  const iso = value.includes("+") || value.endsWith("Z") ? value : `${value}+08:00`;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) throw new Error("到期时间格式不正确");
  return new Date(time).toISOString();
}

function isFuture(value: string | undefined, now: number): boolean {
  return Boolean(value && Date.parse(value) > now);
}

function isUserDisabled(user: Pick<StoredUser, "disabledPermanent" | "disabledUntil">, now = Date.now()): boolean {
  return Boolean(user.disabledPermanent || isFuture(user.disabledUntil, now));
}

function isUserHiddenFromLeaderboard(
  user: Pick<
    StoredUser,
    "disabledPermanent" | "disabledUntil" | "hideFromLeaderboardWhileDisabled" | "leaderboardHiddenPermanent" | "leaderboardHiddenUntil"
  >,
  now = Date.now(),
): boolean {
  const leaderboardOnly = Boolean(user.leaderboardHiddenPermanent || isFuture(user.leaderboardHiddenUntil, now));
  return leaderboardOnly || (Boolean(user.hideFromLeaderboardWhileDisabled) && isUserDisabled(user, now));
}

function hasAdvancedPerk(role: UserRole): boolean {
  return role === "super-admin" || role === "admin-advanced" || role === "advanced";
}

function subtitleFor(role: UserRole, title?: string): string | undefined {
  const base = role === "super-admin" ? "超级管理员" : role === "admin-advanced" ? "管理员+高级用户" : role === "admin" ? "管理员" : role === "advanced" ? "高级用户" : "";
  if (base) return title ? `${base} · ${title}` : base;
  return title ? title : undefined;
}

function formatTime(value: number): string {
  return new Date(value).toISOString();
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

function addTodayGamePointsDelta(user: StoredUser, delta: number, now = Date.now()): void {
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

function maxRequestActivity(requests: UserRequest[]): number {
  return requests.reduce((maximum, request) => Math.max(maximum, request.createdAt, request.repliedAt ?? 0), 0);
}

function nextRequestActivityAt(requests: UserRequest[]): number {
  return Math.max(Date.now(), maxRequestActivity(requests) + 1);
}

function randomInviteCode(): string {
  return randomBytes(8).toString("base64url");
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

function enforceActivationQuota(activation: ActivationCode, userId: string, now: number): void {
  if (activation.kind === "point-distribution") {
    if (activation.redemptions.some((item) => item.userId === userId)) throw new Error("每个用户只能兑换一次该积分发放码");
    if (activation.redemptions.length >= activation.maxUses) throw new Error("激活码使用次数已达到上限");
    return;
  }
  if (activation.usePolicy === "unlimited") return;
  const withinWindow = activation.windowMs ? activation.redemptions.filter((item) => item.usedAt > now - activation.windowMs!) : activation.redemptions;
  const total =
    activation.usePolicy === "global-total"
      ? activation.redemptions.length
      : activation.usePolicy === "per-user-total"
        ? activation.redemptions.filter((item) => item.userId === userId).length
        : activation.usePolicy === "global-window"
          ? withinWindow.length
          : withinWindow.filter((item) => item.userId === userId).length;
  if (total >= activation.maxUses) throw new Error("激活码使用次数已达到上限");
}

function pointDistributionReward(activation: ActivationCode): number {
  const totalPoints = activation.totalPoints ?? 0;
  const distributed = activation.redemptions.reduce((sum, redemption) => sum + (redemption.points ?? 0), 0);
  const remainingPoints = totalPoints - distributed;
  const remainingUses = activation.maxUses - activation.redemptions.length;
  if (remainingUses <= 0 || remainingPoints <= 0) throw new Error("积分已发放完毕");
  if (activation.distributionMode === "equal") return totalPoints / activation.maxUses;
  if (remainingUses === 1) return remainingPoints;
  const upper = randomPointRewardUpperBound(remainingPoints, remainingUses);
  return randomInt(1, upper + 1);
}

function applyActivationGrantPatch(
  activation: ActivationCode,
  kind: "admin" | "advanced",
  durationPatch: number | null | false | undefined,
  expiryPatch: string | null | undefined,
): void {
  const durationKey = kind === "admin" ? "adminDurationMs" : "advancedDurationMs";
  const expiryKey = kind === "admin" ? "adminExpiresAt" : "advancedExpiresAt";
  if (durationPatch !== undefined) {
    activation[durationKey] =
      durationPatch === false ? undefined : cleanGrantDuration(durationPatch, kind === "admin" ? "管理员时长" : "高级用户时长");
    if (durationPatch !== false) activation[expiryKey] = undefined;
  }
  if (expiryPatch !== undefined && (durationPatch === undefined || durationPatch === false)) {
    activation[expiryKey] = cleanExpiry(expiryPatch);
    if (activation[expiryKey]) activation[durationKey] = undefined;
  }
}

function applyAdvancedAiGrantPatch(
  target: {
    advancedAiDurationMs?: number | null;
    advancedAiExpiresAt?: string;
  },
  durationPatch: number | null | false | undefined,
  expiryPatch: string | null | undefined,
): void {
  if (durationPatch !== undefined) {
    target.advancedAiDurationMs =
      durationPatch === false ? undefined : cleanGrantDuration(durationPatch, "高级 AI 权限时长");
    if (durationPatch !== false) target.advancedAiExpiresAt = undefined;
  }
  if (expiryPatch !== undefined && (durationPatch === undefined || durationPatch === false)) {
    target.advancedAiExpiresAt = cleanExpiry(expiryPatch);
    if (target.advancedAiExpiresAt) target.advancedAiDurationMs = undefined;
  }
}

function applyAdvancedAiGrant(
  user: StoredUser,
  durationMs: number | null | undefined,
  expiresAt: string | undefined,
  now: number,
): void {
  if (durationMs === undefined && !expiresAt) return;
  if (durationMs === null) {
    user.advancedAiPermanent = true;
    user.advancedAiExpiresAt = undefined;
    return;
  }
  if (user.superAdmin || user.advancedAiPermanent) return;
  const current = user.advancedAiExpiresAt ? Date.parse(user.advancedAiExpiresAt) : 0;
  const next = expiresAt ? Date.parse(expiresAt) : Math.max(now, current) + durationMs!;
  if (next > current) user.advancedAiExpiresAt = new Date(next).toISOString();
}

function hasAdvancedAiAccess(user: StoredUser, now = Date.now()): boolean {
  return Boolean(user.superAdmin || user.advancedAiPermanent || isFuture(user.advancedAiExpiresAt, now));
}

function sanitizeAuditDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const blocked = /password|token|authorization|cookie|music|dataurl/i;
  const clean = Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !blocked.test(key))
      .slice(0, 40)
      .map(([key, value]) => [key, sanitizeAuditValue(value, 0)]),
  );
  const serialized = JSON.stringify(clean);
  return serialized.length <= 8_000 ? clean : { truncated: serialized.slice(0, 7_900) };
}

function sanitizeAuditValue(value: unknown, depth: number): unknown {
  if (depth > 3) return "[depth-limited]";
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeAuditValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/password|token|authorization|cookie|dataurl/i.test(key))
        .slice(0, 40)
        .map(([key, item]) => [key, sanitizeAuditValue(item, depth + 1)]),
    );
  }
  return String(value).slice(0, 200);
}

function applyActivationRoleGrant(
  user: StoredUser,
  kind: "admin" | "advanced",
  durationMs: number | null | undefined,
  expiresAt: string | undefined,
  now: number,
): void {
  if (durationMs === undefined && !expiresAt) return;
  if (kind === "admin") {
    if (durationMs === null) {
      user.adminPermanent = true;
      user.adminExpiresAt = undefined;
      return;
    }
    if (user.adminPermanent) return;
    const current = user.adminExpiresAt ? Date.parse(user.adminExpiresAt) : 0;
    const next = expiresAt ? Date.parse(expiresAt) : Math.max(now, current) + durationMs!;
    if (next > current) user.adminExpiresAt = new Date(next).toISOString();
    return;
  }
  if (durationMs === null) {
    user.advancedPermanent = true;
    user.advancedExpiresAt = undefined;
    return;
  }
  if (user.advancedPermanent) return;
  const current = user.advancedExpiresAt ? Date.parse(user.advancedExpiresAt) : 0;
  const next = expiresAt ? Date.parse(expiresAt) : Math.max(now, current) + durationMs!;
  if (next > current) user.advancedExpiresAt = new Date(next).toISOString();
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

function normalizePermissionRule(rule: Partial<PermissionRule>): PermissionRule {
  const exchangeMin = cleanPermissionBound(rule.exchangeMin ?? 0, "最小换牌数");
  const exchangeMax = rule.exchangeMax === null ? null : cleanPermissionBound(rule.exchangeMax ?? 3, "最大换牌数");
  if (exchangeMax !== null && exchangeMax < exchangeMin) throw new Error("最大换牌数不能小于最小换牌数");
  const maxBaseBet = rule.maxBaseBet === null ? null : cleanPermissionBound(rule.maxBaseBet ?? 100, "最大底注");
  return {
    exchangeMin,
    exchangeMax,
    canCreateZeroBaseBet: Boolean(rule.canCreateZeroBaseBet),
    maxBaseBet,
    duelLimit: normalizeDuelLimitRule(rule.duelLimit),
  };
}

function normalizePermissionPatch(rule: Partial<PermissionRule>): Partial<PermissionRule> {
  const result: Partial<PermissionRule> = {};
  if (rule.exchangeMin !== undefined) result.exchangeMin = cleanPermissionBound(rule.exchangeMin, "最小换牌数");
  if (rule.exchangeMax !== undefined) result.exchangeMax = rule.exchangeMax === null ? null : cleanPermissionBound(rule.exchangeMax, "最大换牌数");
  if (rule.canCreateZeroBaseBet !== undefined) result.canCreateZeroBaseBet = Boolean(rule.canCreateZeroBaseBet);
  if (rule.maxBaseBet !== undefined) result.maxBaseBet = rule.maxBaseBet === null ? null : cleanPermissionBound(rule.maxBaseBet, "最大底注");
  if (rule.duelLimit !== undefined) result.duelLimit = normalizeDuelLimitRule(rule.duelLimit);
  return result;
}

function normalizeDuelLimitRule(rule: Partial<DuelLimitRule> | undefined): DuelLimitRule {
  const period = rule?.period ?? "hour";
  if (!["none", "hour", "day", "week", "unlimited"].includes(period)) throw new Error("决斗次数限制不正确");
  if (period === "none") return { period, count: 0 };
  if (period === "unlimited") return { period, count: null };
  const count = cleanPositiveInteger(rule?.count ?? 1, "决斗次数");
  return { period, count };
}

function normalizeDuelRecordMap(value: Record<string, number | number[]> | undefined): Record<string, number[]> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([userId, raw]) => {
      const records = Array.isArray(raw) ? raw : typeof raw === "number" ? [raw] : [];
      const clean = records.filter((item) => Number.isFinite(item) && item > 0).sort((a, b) => a - b).slice(-200);
      return clean.length ? [[userId, clean]] : [];
    }),
  );
}

function pruneDuelRecords(rule: DuelLimitRule, records: number[], now: number): number[] {
  if (rule.period === "none" || rule.period === "unlimited") return [];
  const windowMs = DUEL_LIMIT_PERIOD_MS[rule.period];
  return records.filter((item) => Number.isFinite(item) && item > now - windowMs).sort((a, b) => a - b).slice(-200);
}

function duelLimitStatus(rule: DuelLimitRule, records: number[], now: number): { allowed: boolean; retryAt?: number; unlimited?: boolean } {
  if (rule.period === "unlimited") return { allowed: true, unlimited: true };
  if (rule.period === "none" || (rule.count ?? 0) <= 0) return { allowed: false };
  const active = pruneDuelRecords(rule, records, now);
  if (active.length < (rule.count ?? 1)) return { allowed: true };
  const retryAt = active[0] + DUEL_LIMIT_PERIOD_MS[rule.period];
  return { allowed: false, retryAt };
}

function cleanPermissionBound(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label}必须是非负整数`);
  return value;
}

function requireAuthSecret(value: string | undefined, name = "AUTH_SECRET"): string {
  if (!value || value.length < 32) throw new Error(`${name} 必须通过部署密钥提供，且至少包含 32 个字符`);
  return value;
}

function decryptUsername(value: string, key: Buffer): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error("用户名密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8");
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [kind, salt, expectedRaw] = hash.split(":");
  if (kind !== "scrypt" || !salt || !expectedRaw) return false;
  const expected = Buffer.from(expectedRaw, "base64url");
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}
