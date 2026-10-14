// The launcher's state machine. It owns every piece of state; the renderer draws Snapshots and
// sends intents. Nothing in here imports Electron: main.ts passes the platform pieces in, which
// keeps this testable with plain Node. The design follows Dauntless Revived's launcher.
//
// Two server modes exist (see shared/invite.ts):
//  - private (invite v1): the host's PC over Tailscale, plain HTTP to the host's gateway.
//  - public (invite v2): a server on a public IP. Everything goes over TLS to its gateway, pinned
//    to the invite's certificate fingerprint.
// Either way, while the game runs a local relay on 127.0.0.1:61100 carries the game's own traffic
// (relay.ts): the Reforged runtime sends it there because the launcher sets REFORGED_BACKEND_URL.

import { createHash } from "node:crypto";
import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";

import { parseInvite, isLoopbackHost, type Invite } from "../shared/invite";
import { checkUsername, extractAccountKey } from "../shared/username";
import { limitedView, type ServerStatus } from "../shared/status";
import type {
  ActionResult,
  Branding,
  ConnectProblem,
  DetectedGame,
  ErrorCode,
  ExternalTarget,
  GameInfo,
  GameLanguage,
  GameProblem,
  GraphicsPreset,
  HostAction,
  HostFolder,
  HostJob,
  HostKit,
  InviteCheck,
  Language,
  LauncherError,
  NewsItem,
  NoticeCode,
  Phase,
  RegisterOutcome,
  RuntimeInfo,
  RuntimeProfile,
  Settings,
  Snapshot,
  TaskProgress,
} from "../shared/types";
import { GAME_LANGUAGES, GRAPHICS_PRESETS, LANGUAGES, RUNTIME_PROFILES } from "../shared/types";
import type { Endpoint } from "./http";
import {
  fetchBrandingImage,
  fetchBrandingIndex,
  fetchNews,
  fetchRuntimeManifest,
  fetchServerStatus,
  fetchUserInfo,
  registerAccount,
  type RuntimeManifest,
  type StatusResult,
} from "./hostapi";
import { HashCache } from "./verify";
import { checkRuntime, installLocalRuntime, installRuntime, isCompleteRuntimeDir, RuntimeError, runtimeSetId } from "./runtime-files";
import { applyGameConfig } from "./engineini";
import { detectStoreInstalls, locateExistingGame, readGameVersion, hasGameExe } from "./game-folder";
import { buildLaunchArgs, describeLaunch, GameProcess, gameExitDetail, gameLocale, launchEnvironment, type SpawnFn } from "./launch";
import { backupFileText, KeyStore, KeyStoreError, serverId, type Encryptor, type KeySlot } from "./keystore";
import { SettingsStore, type StoredServer, type StoredSettings } from "./settings";
import { missingVcRuntime } from "./system";
import { fixedLinkUrl, isAllowedExternalUrl } from "./links";
import { describeError, log } from "./log";
import { Relay, RelayError } from "./relay";
import { DEFAULT_RELAY_PORT, EXE_NAME, EXE_RELATIVE_PATH, PINNED_EXE_SHA256, PROJECT_URL, RUNTIME_FILE_NAMES, STATUS_POLL_MS, WIN64_RELATIVE_DIR } from "./constants";
import {
  BACKEND_GAME_DATA,
  DIRECTOR_GAME_DATA,
  DUMPER_OUTPUT_ROOT,
  EXPORT_FLAGS,
  copyTree,
  detectHostKit,
  findDumps,
  findToolchain,
  importSdk,
  msbuildArgs,
  platformToolset,
  publishRuntime,
  runLogged,
  useSyntheticData,
  workspacePaths,
} from "./hostkit";
import type { InjectEvent, InjectOptions } from "./injector";

export type FolderPurpose = "game" | "runtime" | "workspace";

export interface Platform {
  userDataDir: string;
  documentsDir?: string;
  resourcesDir: string;
  hostPlatform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  appVersion: string;
  packaged: boolean;
  defaultLanguage: Language;
  // The operating system's locale ("pt-BR"), for the game language "auto".
  systemLocale?: string;
  encryptor: Encryptor;
  gameConfigDir?: string;
  // Where the local relay listens. The server's QOS_TARGET_URL names 127.0.0.1:61100, so only
  // tests and rehearsals change it. qosPort: the extra QoS listener (80; null = none, for tests).
  relayPort?: number;
  qosPort?: number | null;
  // The executable's pinned hash (tests use a fake game).
  exePin?: string;
  dumpRoot?: string;
  runtimeFilesExist?: (file: string) => boolean;
  chooseFolder(purpose: FolderPurpose, defaultPath: string): Promise<string | null>;
  chooseDll(defaultPath: string): Promise<string | null>;
  chooseSaveFile(defaultName: string): Promise<string | null>;
  chooseOpenFile(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  openPath(dir: string): Promise<void>;
  emitSnapshot(s: Snapshot): void;
  emitProgress(p: TaskProgress): void;
  emitHostKit?(k: HostKit): void;
  findTailscale(): string | null;
  findRunningClients(): Promise<number[]>;
  spawn?: SpawnFn;
  inject?(opts: InjectOptions): Promise<InjectEvent>;
  installUpdate?(): void;
}

const err = (code: ErrorCode, detail?: string): { ok: false; error: LauncherError } => ({ ok: false, error: detail ? { code, detail } : { code } });
const OK: ActionResult = { ok: true };

export function endpointFor(sv: StoredServer): Endpoint {
  return { host: sv.host, port: sv.port, pin: sv.mode === "public" ? sv.fp : null };
}

export class Controller {
  private readonly settings: SettingsStore;
  private readonly keys: KeyStore;
  private readonly game: GameProcess;
  private readonly hashes: HashCache;

  private reachable: boolean | null = null;
  private checking = false;
  private connectProblem: ConnectProblem = null;
  private tailscaleInstalled = false;
  private lastCheckedAt: string | null = null;
  private failedPolls = 0;
  private status: ServerStatus | null = null;
  private statusUnsupported = false;
  private hasKey = false;
  private keyRejected = false;
  // Bumped when a ServerStatus answer already on its way may no longer be shown: logout, a new key,
  // a forgotten or different server. See fetchStatus().
  private statusGen = 0;
  private busy = false;
  private gameInfo: GameInfo = { root: null, problem: "not_set", versionText: null, versionOk: false, exeVerified: false, detected: [] };
  private runtimeManifest: RuntimeManifest | null = null;
  private runtimeInfo: RuntimeInfo = { state: "unavailable", version: null, files: [], localDir: null };
  private runtimePlayable = false;
  private task: TaskProgress | null = null;
  private taskAbort: AbortController | null = null;
  private lastError: LauncherError | null = null;
  private notice: NoticeCode | null = null;
  private updateReady = false;
  private polling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private news: NewsItem[] | null = null;
  private newsCheckedAt = -Infinity;
  private newsLoading = false;
  private branding: Branding | null = null;
  private art = new Map<string, { file: string; type: string }>();
  private relay: Relay | null = null;
  private phase: Phase = "loading";
  private hostJob: HostJob | null = null;
  // While a Dumper-7 session runs: the runtime loader set aside so the game starts without it.
  private dumpRestore: { from: string; to: string } | null = null;

  constructor(private readonly p: Platform) {
    this.settings = new SettingsStore(p.userDataDir, p.defaultLanguage, p.hostPlatform ?? process.platform);
    this.keys = new KeyStore(path.join(p.userDataDir, "keys"), p.encryptor, p.documentsDir ? path.join(p.documentsDir, "Dauntless Reforged Revival", "Account Keys") : undefined);
    this.game = new GameProcess(p.spawn);
    this.hashes = new HashCache(path.join(p.userDataDir, "file-hashes.json"));
    this.game.onChange((running, code) => {
      log.info(running ? "game started" : `game exited (code ${code ?? "none"})`);
      if (!running) {
        if (code !== null && code !== 0 && !this.dumpRestore) this.lastError = { code: "launch_failed", detail: gameExitDetail(code) };
        void this.restoreAfterDump()
          .then(() => this.stopRelay())
          .then(() => this.inspectRuntime())
          .then(() => this.publish());
        return;
      }
      this.publish();
    });
  }

  // ------------------------------------------------------------------ basics

  private get s(): StoredSettings {
    return this.settings.get();
  }

  private get hostPlatform(): NodeJS.Platform {
    return this.p.hostPlatform ?? process.platform;
  }

  private get pathApi(): typeof path.win32 | typeof path.posix {
    return this.hostPlatform === "win32" ? path.win32 : path.posix;
  }

  // True while the game runs through the local relay: closing the launcher would cut the game off.
  get relayActive(): boolean {
    return this.relay !== null && this.relay.running;
  }

  get gameRunning(): boolean {
    return this.game.running;
  }

  private endpoint(): Endpoint | null {
    const sv = this.s.server;
    return sv ? endpointFor(sv) : null;
  }

  private slot(): KeySlot | null {
    const sv = this.s.server;
    return sv ? { host: sv.host, port: sv.port, mode: sv.mode, fp: sv.fp } : null;
  }

  private sid(): string | null {
    const sv = this.s.server;
    return sv ? serverId(sv.host, sv.port, sv.mode) : null;
  }

  private win64Dir(): string | null {
    const root = this.gameInfo.root;
    return root ? this.pathApi.join(root, ...WIN64_RELATIVE_DIR.split("/")) : null;
  }

  async init(): Promise<void> {
    await this.refreshKeyFlag();
    await this.inspectGame({ detect: true });
    await this.inspectRuntime();
    this.publish();
    if (this.s.server) void this.connect();
    // A game found but never checked: check it now (the executable is hashed once per change).
    if (this.gameInfo.problem === "unverified") void this.verifyGame();
  }

  private computePhase(): Phase {
    if (!this.s.server) return "join";
    if (this.task) return "installing";
    if (this.game.running) return "running";
    if (this.reachable !== true) return "connect";
    if (!this.hasKey || this.keyRejected) return "register";
    if (this.gameInfo.problem !== null) return "locate";
    if (!this.runtimePlayable) return "runtime";
    return "ready";
  }

  private currentSettings(): Settings {
    const s = this.s;
    return {
      graphics: s.graphics,
      windowed: s.windowed,
      language: s.language,
      gameLanguage: s.gameLanguage,
      runtimeProfile: s.runtimeProfile,
      streamerMode: s.streamerMode,
      hostTools: s.hostTools,
    };
  }

  snapshot(): Snapshot {
    this.phase = this.computePhase();
    const sv = this.s.server;
    const sid = this.sid();
    return {
      phase: this.phase,
      busy: this.busy,
      savedServers: this.s.savedServers.map((o) => {
        const id = serverId(o.host, o.port, o.mode);
        return { id, mode: o.mode, host: o.host, port: o.port, name: o.name, current: sid === id, username: this.s.usernames[id] ?? null };
      }),
      server: sv
        ? {
            mode: sv.mode,
            host: sv.host,
            port: sv.port,
            name: sv.name,
            hasShare: sv.share !== null,
            hasPendingInvite: sv.code !== null,
            loopback: isLoopbackHost(sv.host),
            fingerprint: sv.fp,
          }
        : null,
      connect: { checking: this.checking, problem: this.connectProblem, tailscaleInstalled: this.tailscaleInstalled, lastCheckedAt: this.lastCheckedAt },
      account: {
        username: sid ? this.s.usernames[sid] ?? null : null,
        hasKey: this.hasKey && !this.keyRejected,
        offerBackup: sid !== null && this.hasKey && !this.keyRejected && this.s.backupOffered[sid] !== true,
      },
      game: { ...this.gameInfo, detected: [...this.gameInfo.detected] },
      runtime: { ...this.runtimeInfo, files: [...this.runtimeInfo.files] },
      task: this.task,
      running: { game: this.game.running, relayPort: this.relay?.port ?? null },
      settings: this.currentSettings(),
      app: { version: this.p.appVersion, packaged: this.p.packaged, updateReady: this.updateReady, platform: this.hostPlatform },
      status: this.status,
      statusUnsupported: this.statusUnsupported,
      lastError: this.lastError,
      notice: this.notice,
    };
  }

  private publish(): void {
    this.p.emitSnapshot(this.snapshot());
  }

  private fail(code: ErrorCode, detail?: string): { ok: false; error: LauncherError } {
    const e = err(code, detail);
    this.lastError = e.error;
    this.publish();
    return e;
  }

  private async withBusy<T>(fn: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.lastError = null;
    this.publish();
    try {
      return await fn();
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  setUpdateReady(): void {
    this.updateReady = true;
    this.publish();
  }

  installUpdate(): void {
    if (this.updateReady && !this.task && !this.game.running) this.p.installUpdate?.();
  }

  setNotice(code: NoticeCode | null): void {
    this.notice = code;
    this.publish();
  }

  dismissNotice(): void {
    this.setNotice(null);
  }

  dismissError(): void {
    this.lastError = null;
    this.publish();
  }

  // ------------------------------------------------------------------ join / connect

  // Public invites: is there a key for this host:port that belongs to another certificate? The
  // page asks before it offers to join, so that it can warn instead of offering a one-click join.
  async checkInvite(text: unknown): Promise<InviteCheck> {
    const parsed = parseInvite(text);
    if (!parsed.ok) return err("invite_invalid_format", parsed.error);
    const change = await this.certificateChange(parsed.invite);
    return { ok: true, certificateChanged: change !== null, previousFingerprint: change?.fp ?? null };
  }

  private async certificateChange(inv: Pick<Invite, "mode" | "host" | "port" | "fp">): Promise<{ fp: string | null } | null> {
    if (inv.mode !== "public") return null;
    const bound = await this.keys.certificateOf({ host: inv.host, port: inv.port, mode: "public", fp: inv.fp });
    return bound && bound.fp !== inv.fp ? bound : null;
  }

  // Joins the server from an invite. When a public invite carries another certificate than the
  // one this PC's key for that host:port belongs to, nothing is changed or sent (error
  // cert_changed, detail = the saved fingerprint) until the user confirms the new certificate.
  async submitInvite(text: unknown, opts: { acceptNewCertificate?: boolean } = {}): Promise<ActionResult> {
    if (this.busy || this.task) return err("busy");
    if (this.game.running) return this.fail("already_running");
    const parsed = parseInvite(text);
    if (!parsed.ok) return this.fail("invite_invalid_format", parsed.error);
    return this.join(parsed.invite, opts);
  }

  // Back to a server joined before, with what its invite said then: no invite to paste again.
  async switchServer(id: string): Promise<ActionResult> {
    if (this.busy || this.task) return err("busy");
    if (this.game.running) return this.fail("already_running");
    const saved = this.s.savedServers.find((sv) => serverId(sv.host, sv.port, sv.mode) === id);
    if (!saved) return this.fail("invite_invalid_format");
    return this.join({ ...saved });
  }

  async removeSavedServer(id: string): Promise<ActionResult> {
    const cur = this.sid();
    if (id === cur) return err("busy"); // the current server stays in the list
    await this.settings.update((s) => {
      s.savedServers = s.savedServers.filter((sv) => serverId(sv.host, sv.port, sv.mode) !== id);
    });
    this.publish();
    return OK;
  }

  private async join(inv: Omit<Invite, "code"> & { code: string | null }, opts: { acceptNewCertificate?: boolean } = {}): Promise<ActionResult> {
    const change = await this.certificateChange(inv);
    if (change) {
      if (opts.acceptNewCertificate !== true) {
        log.warn(`invite for ${inv.host}:${inv.port} has a new certificate; the stored key stays with the old one until the user confirms`);
        return err("cert_changed", change.fp ?? "");
      }
      await this.keys.rebind({ host: inv.host, port: inv.port, mode: "public", fp: change.fp }, inv.fp as string);
      log.warn(`the user accepted a new certificate for ${inv.host}:${inv.port} (was ${change.fp ?? "not recorded"}, now ${inv.fp})`);
    }
    const current = this.s.server;
    const same = current !== null && current.mode === inv.mode && current.host === inv.host && current.port === inv.port && current.fp === inv.fp;
    const hasKeyForIt = await this.keys.has({ host: inv.host, port: inv.port, mode: inv.mode, fp: inv.fp });
    await this.settings.update((s) => {
      s.server = {
        mode: inv.mode,
        host: inv.host,
        port: inv.port,
        name: inv.name,
        share: inv.share,
        fp: inv.fp,
        // A friend who already has an account on this server does not need the code again.
        code: hasKeyForIt ? null : inv.code,
      };
    });
    if (!same) this.resetServerState();
    log.info(`joined ${inv.mode} server ${inv.host}:${inv.port}`);
    await this.refreshKeyFlag();
    this.lastError = null;
    await this.connect();
    return OK;
  }

  private resetServerState(): void {
    this.reachable = null;
    this.status = null;
    this.statusUnsupported = false;
    this.connectProblem = null;
    this.news = null;
    this.branding = null;
    this.keyRejected = false;
    this.failedPolls = 0;
    this.runtimeManifest = null;
    this.statusGen++;
  }

  async forgetServer(): Promise<ActionResult> {
    if (this.task || this.game.running) return err("busy");
    await this.settings.update((s) => {
      s.server = null;
    });
    this.resetServerState();
    this.hasKey = false;
    await this.inspectRuntime();
    this.publish();
    return OK;
  }

  async connect(): Promise<ActionResult> {
    const sv = this.s.server;
    const ep = this.endpoint();
    if (!sv || !ep) return err("server_unreachable");
    if (this.checking) return OK;
    this.checking = true;
    this.publish();
    try {
      this.tailscaleInstalled = sv.mode === "private" ? this.p.findTailscale() !== null : false;
      const { res, stale } = await this.fetchStatus(ep);
      this.lastCheckedAt = new Date().toISOString();
      if (res.kind === "ok" || res.kind === "unsupported") {
        this.reachable = true;
        this.connectProblem = null;
        this.failedPolls = 0;
        // Overtaken (logout, new key, other server): the server still answers, but never show a
        // list that was asked for with a key the launcher no longer has.
        this.status = res.kind === "ok" ? (stale ? limitedView(res.status) : res.status) : null;
        this.statusUnsupported = res.kind === "unsupported";
        if (res.kind === "ok" && !stale) await this.rememberServerName(res.status.name);
        await this.checkAccount();
        await this.refreshRuntimeOffer();
        void this.loadExtras();
      } else {
        this.reachable = false;
        if (res.kind === "bad_answer") this.connectProblem = "bad_answer";
        else if (res.kind === "cert_mismatch") this.connectProblem = "cert_mismatch";
        else if (sv.mode === "private" && !this.tailscaleInstalled && !isLoopbackHost(ep.host)) this.connectProblem = "tailscale_missing";
        else this.connectProblem = "unreachable";
        if (this.connectProblem === "cert_mismatch") log.error(`server ${ep.host}:${ep.port} presented a certificate that does not match the invite`);
        else log.warn(`server ${ep.host}:${ep.port} not reachable (${this.connectProblem})`);
      }
      return OK;
    } finally {
      this.checking = false;
      this.publish();
    }
  }

  private async rememberServerName(name: string): Promise<void> {
    const sv = this.s.server;
    if (sv && sv.name !== name) {
      await this.settings.update((s) => {
        if (s.server) s.server.name = name;
      });
    }
  }

  private async refreshKeyFlag(): Promise<void> {
    const slot = this.slot();
    this.hasKey = slot ? await this.keys.has(slot) : false;
  }

  // The key sent with ServerStatus, so the server lists who is online (it shows the list to
  // registered players only). Read from the key store for each request, never kept in memory.
  private async statusKey(): Promise<string | null> {
    const slot = this.slot();
    if (!slot || !this.hasKey || this.keyRejected) return null;
    return this.keys.load(slot).catch(() => null);
  }

  private async fetchStatus(ep: Endpoint): Promise<{ res: StatusResult; stale: boolean }> {
    const gen = this.statusGen;
    const res = await fetchServerStatus(ep, { key: await this.statusKey() });
    return { res, stale: gen !== this.statusGen };
  }

  // Confirms the stored key with GetUserInfo and refreshes the username.
  private async checkAccount(): Promise<void> {
    const ep = this.endpoint();
    const slot = this.slot();
    const sid = this.sid();
    if (!ep || !slot || !sid) return;
    let key: string | null = null;
    try {
      key = await this.keys.load(slot);
    } catch {
      key = null;
    }
    this.hasKey = key !== null;
    if (!key) return;
    const info = await fetchUserInfo(ep, key);
    if (info.ok) {
      this.keyRejected = false;
      if (this.s.usernames[sid] !== info.info.username) {
        await this.settings.update((s) => {
          s.usernames[sid] = info.info.username;
        });
      }
    } else if (info.error === "account_banned") {
      this.keyRejected = true;
      this.lastError = { code: "account_banned", detail: info.detail };
    } else if (info.error === "key_rejected") {
      this.keyRejected = true;
      this.lastError = { code: "key_rejected" };
      log.warn("the server does not accept the stored key");
    }
  }

  // ------------------------------------------------------------------ status polling, news, art

  setStatusPolling(on: boolean): void {
    this.polling = on === true;
    if (this.polling && !this.pollTimer) {
      this.pollTimer = setInterval(() => void this.pollStatus(), STATUS_POLL_MS);
      void this.pollStatus();
    } else if (!this.polling && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollStatus(): Promise<void> {
    const ep = this.endpoint();
    if (!ep || this.checking) return;
    if (this.reachable !== true) {
      // Keep retrying quietly in the background while the guide is shown.
      if (this.connectProblem !== "cert_mismatch") await this.connect();
      return;
    }
    const { res, stale } = await this.fetchStatus(ep);
    // Overtaken: drop it; the next poll asks again under the new state.
    if (stale) return;
    if (res.kind === "ok") {
      this.status = res.status;
      this.statusUnsupported = false;
      this.failedPolls = 0;
      if (this.branding === null) void this.loadExtras();
      else void this.refreshNews();
      // The host may have published a runtime meanwhile.
      if (!this.game.running && !this.task && (this.runtimeInfo.state === "unavailable" || this.runtimeManifest === null)) await this.refreshRuntimeOffer();
    } else if (res.kind === "unsupported") {
      this.statusUnsupported = true;
      this.failedPolls = 0;
    } else if (res.kind === "cert_mismatch") {
      this.reachable = false;
      this.connectProblem = "cert_mismatch";
      if (this.status) this.status = { ...this.status, online: false };
      log.error("the server's certificate changed and no longer matches the invite");
    } else {
      this.failedPolls++;
      if (this.status) this.status = { ...this.status, online: false };
      // While the game runs, a busy moment on the server must not flip the launcher back to the
      // connect guide.
      if (this.failedPolls >= 2 && !this.game.running) {
        this.reachable = false;
        this.connectProblem = "unreachable";
      }
    }
    this.publish();
  }

  async refreshStatus(): Promise<void> {
    await this.pollStatus();
  }

  private async refreshNews(): Promise<void> {
    const ep = this.endpoint();
    if (!ep || this.newsLoading || (this.news !== null && Date.now() - this.newsCheckedAt < 60000)) return;
    this.newsLoading = true;
    const generation = this.statusGen;
    this.newsCheckedAt = Date.now();
    try {
      const items = await fetchNews(ep, this.news ?? []);
      if (generation === this.statusGen) {
        this.news = items;
        this.publish();
      }
    } finally {
      this.newsLoading = false;
    }
  }

  private async loadExtras(): Promise<void> {
    const ep = this.endpoint();
    if (!ep) return;
    await this.refreshNews();
    if (this.branding === null) {
      const generation = this.statusGen;
      const index = await fetchBrandingIndex(ep);
      const backgrounds: Branding["backgrounds"] = [];
      const cacheDir = path.join(this.p.userDataDir, "art-cache");
      await fsp.mkdir(cacheDir, { recursive: true });
      for (const b of index.backgrounds) {
        const img = await fetchBrandingImage(ep, b.path);
        if (!img) continue;
        const id = createHash("sha256").update(img.data).digest("hex");
        const file = path.join(cacheDir, id);
        await fsp.writeFile(file, img.data);
        this.art.set(id, { file, type: img.type });
        backgrounds.push({ url: `rr-art://bg/${id}`, credit: b.credit });
      }
      if (generation === this.statusGen) this.branding = { backgrounds, accent: index.accent };
    }
    this.publish();
  }

  getNews(): NewsItem[] {
    return this.news ?? [];
  }

  getBranding(): Branding {
    return this.branding ?? { backgrounds: [], accent: null };
  }

  // Used by the rr-art:// protocol handler: only ids this session downloaded are served.
  resolveArt(id: string): { file: string; type: string } | null {
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    return this.art.get(id) ?? null;
  }

  // ------------------------------------------------------------------ account

  async register(username: unknown): Promise<RegisterOutcome> {
    if (this.busy || this.task) return err("busy");
    const check = checkUsername(username);
    if (check !== "ok") return this.fail("username_invalid", check);
    const ep = this.endpoint();
    const sv = this.s.server;
    const slot = this.slot();
    const sid = this.sid();
    if (!ep || !sv || !slot || !sid) return err("server_unreachable");
    return this.withBusy(async () => {
      const res = await registerAccount(ep, username as string, sv.code ?? "");
      if (!res.ok) {
        log.warn(`registration refused: ${res.error}`);
        this.lastError = { code: res.error };
        return err(res.error);
      }
      try {
        await this.keys.save(slot, res.key);
      } catch (e) {
        log.error(`could not store the key: ${describeError(e)}`);
        this.lastError = { code: "key_storage_unavailable" };
        return err("key_storage_unavailable");
      }
      await this.settings.update((s) => {
        if (s.server) s.server.code = null;
        s.usernames[sid] = username as string;
        delete s.backupOffered[sid];
      });
      this.hasKey = true;
      this.keyRejected = false;
      this.statusGen++;
      log.info(`registered as ${username as string}`);
      await this.checkAccount();
      // Now a registered player: ask again, with the key, so the player list shows at once.
      await this.pollStatus();
      return { ok: true as const, username: username as string };
    });
  }

  async useExistingKey(text: unknown): Promise<ActionResult> {
    if (this.busy || this.task) return err("busy");
    const key = typeof text === "string" ? extractAccountKey(text) : null;
    if (!key) return this.fail("key_invalid");
    return this.withBusy(() => this.adoptKey(key));
  }

  async importKeyFile(): Promise<ActionResult> {
    if (this.busy || this.task) return err("busy");
    const file = await this.p.chooseOpenFile();
    if (!file) return err("cancelled");
    let text: string;
    try {
      const st = await fsp.stat(file);
      if (st.size > 8192) return this.fail("key_invalid");
      text = await fsp.readFile(file, "utf8");
    } catch {
      return this.fail("key_invalid");
    }
    const key = extractAccountKey(text);
    if (!key) return this.fail("key_invalid");
    return this.withBusy(() => this.adoptKey(key));
  }

  private async adoptKey(key: string): Promise<ActionResult> {
    const ep = this.endpoint();
    const slot = this.slot();
    const sid = this.sid();
    if (!ep || !slot || !sid) return err("server_unreachable");
    const info = await fetchUserInfo(ep, key);
    if (!info.ok) {
      this.lastError = { code: info.error, detail: info.detail };
      return { ok: false, error: this.lastError };
    }
    try {
      await this.keys.save(slot, key);
    } catch (e) {
      this.lastError = { code: e instanceof KeyStoreError && e.code === "invalid" ? "key_invalid" : "key_storage_unavailable" };
      return err(this.lastError.code);
    }
    await this.settings.update((s) => {
      s.usernames[sid] = info.info.username;
      s.backupOffered[sid] = true; // they already have a copy
      if (s.server) s.server.code = null;
    });
    this.hasKey = true;
    this.keyRejected = false;
    this.statusGen++;
    log.info(`using an existing key for ${info.info.username}`);
    await this.pollStatus();
    return OK;
  }

  async saveKeyBackup(): Promise<ActionResult> {
    const sv = this.s.server;
    const slot = this.slot();
    const sid = this.sid();
    if (!sv || !slot || !sid) return err("server_unreachable");
    const key = await this.keys.load(slot).catch(() => null);
    if (!key) return this.fail("key_invalid");
    const username = this.s.usernames[sid] ?? null;
    const file = await this.p.chooseSaveFile(`Dauntless Reforged Revival key${username ? ` - ${username}` : ""}.txt`);
    if (!file) return err("cancelled");
    try {
      await fsp.writeFile(
        file,
        backupFileText({ key, username, serverName: sv.name, host: sv.host, port: sv.port, fingerprint: sv.fp, date: new Date() }),
        { mode: 0o600 },
      );
    } catch (e) {
      log.error(`backup not saved: ${describeError(e)}`);
      return this.fail("unknown");
    }
    log.info("key backup saved");
    await this.settings.update((s) => {
      s.backupOffered[sid] = true;
    });
    this.notice = "backup_saved";
    this.publish();
    return OK;
  }

  async dismissBackupOffer(): Promise<void> {
    const sid = this.sid();
    if (!sid) return;
    await this.settings.update((s) => {
      s.backupOffered[sid] = true;
    });
    this.publish();
  }

  async logout(): Promise<ActionResult> {
    if (this.task || this.game.running) return err("busy");
    const slot = this.slot();
    const sid = this.sid();
    if (!slot || !sid) return OK;
    await this.keys.remove(slot);
    await this.settings.update((s) => {
      delete s.usernames[sid];
      delete s.backupOffered[sid];
    });
    this.hasKey = false;
    this.keyRejected = false;
    // Without a key the server no longer lists who is online; stop showing the old list now, and
    // drop any status request still on its way with the old key (it would bring the list back).
    this.statusGen++;
    if (this.status) this.status = limitedView(this.status);
    log.info("logged out; key removed");
    this.publish();
    return OK;
  }

  // ------------------------------------------------------------------ the game folder

  // Looks at the chosen game folder (and, with detect, asks the stores what is installed). Uses the
  // cached hash of the executable only: verifyGame() hashes it.
  async inspectGame(opts: { detect?: boolean } = {}): Promise<void> {
    const env = this.p.env ?? process.env;
    const detected: DetectedGame[] = opts.detect ? await detectStoreInstalls(env, this.hostPlatform).catch(() => []) : this.gameInfo.detected;
    let root = this.s.gameRoot;
    // Nothing chosen yet: take an install the stores know about, the 1.14.7 one first.
    if (root === null && detected.length > 0) {
      const versions = await Promise.all(detected.map((d) => readGameVersion(d.root, this.hostPlatform)));
      const pick = detected[versions.findIndex((v) => v.ok)] ?? (detected.length === 1 ? detected[0] : undefined);
      if (pick) {
        root = pick.root;
        await this.settings.update((s) => {
          s.gameRoot = pick.root;
        });
        log.info(`using the Dauntless install found through ${pick.source}`);
      }
    }
    const info: GameInfo = { root, problem: null, versionText: null, versionOk: false, exeVerified: false, detected };
    if (root === null) {
      info.problem = "not_set";
    } else if (!(await hasGameExe(root, this.hostPlatform))) {
      info.problem = "not_found";
    } else {
      const version = await readGameVersion(root, this.hostPlatform);
      info.versionText = version.text;
      info.versionOk = version.ok;
      const exe = this.pathApi.join(root, ...EXE_RELATIVE_PATH.split("/"));
      const cached = await this.hashes.cached(exe);
      const pin = this.p.exePin ?? PINNED_EXE_SHA256;
      if (cached === null) info.problem = version.text !== null && !version.ok ? "wrong_version" : "unverified";
      else if (cached !== pin) info.problem = "wrong_version";
      else {
        info.exeVerified = true;
        info.problem = null;
      }
    }
    this.gameInfo = info;
  }

  // Hashes the executable (about 120 MB) and compares it with the pinned 1.14.7 one.
  async verifyGame(): Promise<ActionResult> {
    if (this.task || this.busy || this.game.running) return err("busy");
    const root = this.gameInfo.root;
    if (root === null) return this.fail("game_folder_not_found");
    const exe = this.pathApi.join(root, ...EXE_RELATIVE_PATH.split("/"));
    const abort = new AbortController();
    this.taskAbort = abort;
    let total = 0;
    try {
      total = (await fsp.stat(exe)).size;
    } catch {
      await this.inspectGame();
      return this.fail("game_folder_not_found");
    }
    const started = Date.now();
    let done = 0;
    let last = 0;
    const progress = (): TaskProgress => ({
      kind: "verify",
      totalBytes: total,
      doneBytes: done,
      filesTotal: 1,
      filesDone: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      currentFile: EXE_NAME,
    });
    this.task = progress();
    this.publish();
    try {
      const digest = await this.hashes.hash(exe, abort.signal, (n) => {
        done += n;
        if (Date.now() - last > 150) {
          last = Date.now();
          this.task = progress();
          this.p.emitProgress(this.task);
        }
      });
      await this.hashes.save().catch(() => undefined);
      log.info(`game executable checked in ${Date.now() - started} ms: ${digest === (this.p.exePin ?? PINNED_EXE_SHA256) ? "Dauntless 1.14.7" : "another build"}`);
      this.task = null;
      await this.inspectGame();
      await this.inspectRuntime();
      if (this.gameInfo.problem === "wrong_version") return this.fail("game_wrong_version");
      this.notice = "game_verified";
      return OK;
    } catch (e) {
      this.task = null;
      if (abort.signal.aborted) return err("cancelled");
      log.error(`could not check the game executable: ${describeError(e)}`);
      return this.fail("game_folder_not_found");
    } finally {
      this.task = null;
      this.taskAbort = null;
      this.publish();
    }
  }

  async chooseGameFolder(): Promise<ActionResult> {
    if (this.task || this.busy || this.game.running) return err("busy");
    const picked = await this.p.chooseFolder("game", this.gameInfo.root ?? "");
    if (!picked) return err("cancelled");
    return this.useGamePath(picked);
  }

  // A pasted path or a picked folder: the Dauntless folder, its parent, Archon or Win64.
  async useGamePath(input: string): Promise<ActionResult> {
    if (this.task || this.busy || this.game.running) return err("busy");
    const found = await locateExistingGame(input, this.hostPlatform);
    if (this.task || this.busy || this.game.running) return err("busy");
    if (!found.ok) return this.fail(found.reason === "not_found" ? "game_folder_not_found" : "folder_invalid");
    await this.settings.update((s) => {
      s.gameRoot = found.root;
    });
    await this.inspectGame();
    await this.inspectRuntime();
    this.publish();
    return this.gameInfo.problem === "unverified" ? this.verifyGame() : OK;
  }

  async useDetectedGame(index: number): Promise<ActionResult> {
    const d = this.gameInfo.detected[index];
    if (!Number.isInteger(index) || !d) return this.fail("folder_invalid");
    return this.useGamePath(d.root);
  }

  async openGameFolder(): Promise<void> {
    const root = this.gameInfo.root;
    if (root && existsSync(root)) await this.p.openPath(root);
  }

  // ------------------------------------------------------------------ the game runtime

  private trustedSet(): boolean {
    const sid = this.sid();
    const m = this.runtimeManifest;
    if (!sid || !m) return false;
    return (this.s.trustedRuntimes[sid] ?? []).includes(runtimeSetId(m.files));
  }

  private async refreshRuntimeOffer(): Promise<void> {
    const ep = this.endpoint();
    if (!ep) return;
    const res = await fetchRuntimeManifest(ep);
    if (res.kind === "ok") this.runtimeManifest = res.manifest;
    else if (res.kind === "none") this.runtimeManifest = null;
    else if (res.kind === "cert_mismatch") {
      this.reachable = false;
      this.connectProblem = "cert_mismatch";
    }
    await this.inspectRuntime();
  }

  async inspectRuntime(): Promise<void> {
    const dir = this.win64Dir();
    const m = this.runtimeManifest;
    const localDir = this.s.localRuntimeDir;
    if (!dir) {
      this.runtimeInfo = { state: m ? "missing" : "unavailable", version: m?.version ?? null, files: m?.files ?? [], localDir };
      this.runtimePlayable = false;
      return;
    }
    const check = await checkRuntime(dir, m, this.trustedSet(), localDir).catch(() => ({ state: "missing" as const, playable: false }));
    this.runtimeInfo = { state: check.state, version: m?.version ?? null, files: m?.files ?? [], localDir };
    this.runtimePlayable = check.playable;
  }

  // The player accepted this server's runtime: remember the exact file set, then install it.
  async trustRuntime(): Promise<ActionResult> {
    const sid = this.sid();
    const m = this.runtimeManifest;
    if (!sid || !m) return this.fail("runtime_unavailable");
    const id = runtimeSetId(m.files);
    await this.settings.update((s) => {
      const list = s.trustedRuntimes[sid] ?? [];
      if (!list.includes(id)) list.push(id);
      s.trustedRuntimes[sid] = list;
    });
    log.info(`runtime ${m.version} of this server accepted (${id.slice(0, 12)})`);
    return this.installServerRuntime();
  }

  async installServerRuntime(): Promise<ActionResult> {
    if (this.task || this.busy) return err("busy");
    if (this.game.running) return this.fail("already_running");
    const m = this.runtimeManifest;
    const ep = this.endpoint();
    const slot = this.slot();
    const dir = this.win64Dir();
    if (!ep || !slot) return this.fail("server_unreachable");
    if (!dir) return this.fail("game_folder_not_found");
    if (!m) return this.fail("runtime_unavailable");
    if (!this.trustedSet()) return this.fail("runtime_untrusted");
    const key = await this.keys.load(slot).catch(() => null);
    if (!key) return this.fail("key_invalid");
    const abort = new AbortController();
    this.taskAbort = abort;
    this.lastError = null;
    const started = Date.now();
    const total = m.files.reduce((s, f) => s + f.size, 0);
    this.task = { kind: "runtime", totalBytes: total, doneBytes: 0, filesTotal: m.files.length, filesDone: 0, bytesPerSecond: 0, etaSeconds: null, currentFile: null };
    this.publish();
    try {
      await installRuntime({
        endpoint: ep,
        key,
        manifest: m,
        win64Dir: dir,
        signal: abort.signal,
        onProgress: (p) => {
          const seconds = Math.max(0.001, (Date.now() - started) / 1000);
          const rate = p.doneBytes / seconds;
          this.task = { kind: "runtime", ...p, bytesPerSecond: rate, etaSeconds: rate > 0 ? (p.totalBytes - p.doneBytes) / rate : null };
          this.p.emitProgress(this.task);
        },
      });
      log.info(`runtime ${m.version} installed next to the game`);
      this.notice = "runtime_installed";
      return OK;
    } catch (e) {
      if (e instanceof RuntimeError) {
        log.error(`runtime install stopped: ${e.code} ${e.file ?? ""} ${e.message}`);
        if (e.code === "cancelled") return err("cancelled");
        if (e.code === "key_rejected") this.keyRejected = true;
        if (e.code === "cert_mismatch") {
          this.reachable = false;
          this.connectProblem = "cert_mismatch";
          return this.fail("cert_mismatch");
        }
        const map: Record<RuntimeError["code"], ErrorCode> = {
          key_rejected: "key_rejected",
          not_found: "runtime_unavailable",
          different: "runtime_different_on_server",
          download_failed: "download_failed",
          cert_mismatch: "cert_mismatch",
          disk_error: "folder_invalid",
          in_use: "already_running",
          cancelled: "cancelled",
        };
        return this.fail(map[e.code], e.file ?? undefined);
      }
      log.error(`runtime install failed: ${describeError(e)}`);
      return this.fail("runtime_failed");
    } finally {
      this.task = null;
      this.taskAbort = null;
      await this.inspectRuntime().catch(() => undefined);
      this.publish();
    }
  }

  // Host/developer option: a folder with MysticParadox.dll and winmm.dll built on this PC, used
  // instead of what the server offers.
  async chooseLocalRuntime(): Promise<ActionResult> {
    if (this.task || this.busy || this.game.running) return err("busy");
    const picked = await this.p.chooseFolder("runtime", this.s.localRuntimeDir ?? "");
    if (!picked) return err("cancelled");
    if (!(await isCompleteRuntimeDir(picked))) return this.fail("local_runtime_invalid", RUNTIME_FILE_NAMES.join(", "));
    await this.settings.update((s) => {
      s.localRuntimeDir = picked;
    });
    await this.inspectRuntime();
    this.publish();
    return OK;
  }

  async clearLocalRuntime(): Promise<ActionResult> {
    await this.settings.update((s) => {
      s.localRuntimeDir = null;
    });
    await this.inspectRuntime();
    this.publish();
    return OK;
  }

  cancelTask(): void {
    this.taskAbort?.abort();
  }

  // ------------------------------------------------------------------ play

  async play(): Promise<ActionResult> {
    if (this.busy || this.task) return err("busy");
    if (this.game.running) return this.fail("already_running");
    const sv = this.s.server;
    const slot = this.slot();
    if (!sv || !slot) return this.fail("server_unreachable");
    return this.withBusy(async () => {
      const missingVc = missingVcRuntime(this.p.env ?? process.env, this.p.runtimeFilesExist ?? existsSync, this.hostPlatform);
      if (missingVc.length) log.warn(`Visual C++ runtime files missing: ${missingVc.join(", ")}`);

      const others = await this.p.findRunningClients();
      if (others.length > 0) return this.fail("already_running");
      const key = await this.keys.load(slot).catch(() => null);
      if (!key) return this.fail("key_invalid");
      const ep = this.endpoint();
      if (!ep) return this.fail("server_unreachable");
      const account = await fetchUserInfo(ep, key);
      if (!account.ok) {
        this.keyRejected = account.error === "key_rejected" || account.error === "account_banned";
        return this.fail(account.error, account.detail);
      }
      this.keyRejected = false;

      // The executable by hash on every launch, like Dauntless Revived's play.ps1.
      const root = this.gameInfo.root;
      const dir = this.win64Dir();
      if (!root || !dir) return this.fail("game_folder_not_found");
      const exe = this.pathApi.join(root, ...EXE_RELATIVE_PATH.split("/"));
      let exeHash = "";
      try {
        exeHash = await this.hashes.hash(exe);
        await this.hashes.save().catch(() => undefined);
      } catch {
        exeHash = "";
      }
      if (exeHash !== (this.p.exePin ?? PINNED_EXE_SHA256)) {
        await this.inspectGame();
        return this.fail(exeHash === "" ? "game_folder_not_found" : "game_wrong_version");
      }

      // The runtime: a local build, or the server's files checked again by hash.
      if (this.s.localRuntimeDir) {
        try {
          await installLocalRuntime(this.s.localRuntimeDir, dir);
        } catch (e) {
          log.error(`local runtime not installed: ${describeError(e)}`);
          return this.fail(e instanceof RuntimeError && e.code === "in_use" ? "already_running" : "local_runtime_invalid");
        }
      }
      await this.inspectRuntime();
      if (!this.runtimePlayable) {
        return this.fail(this.runtimeInfo.state === "untrusted" ? "runtime_untrusted" : this.runtimeInfo.state === "unavailable" ? "runtime_unavailable" : "runtime_failed");
      }

      const started = await this.startRelay(sv);
      if (!started.ok) return started;
      const relayPort = this.relay?.port ?? DEFAULT_RELAY_PORT;
      let launched = false;
      try {
        let displayRepaired = false;
        try {
          const config = await applyGameConfig({ host: "127.0.0.1", port: relayPort, graphics: this.s.graphics, safeWindow: this.s.windowed, configDir: this.p.gameConfigDir });
          displayRepaired = config.displayRepaired;
        } catch (e) {
          log.error(`could not write the game config: ${describeError(e)}`);
          return this.fail("config_failed");
        }
        const args = buildLaunchArgs({
          key,
          userId: account.info.userId,
          username: account.info.username,
          windowed: this.s.windowed || displayRepaired,
          gameLocale: gameLocale(this.s.gameLanguage, this.p.systemLocale ?? "en-US"),
        });
        const env = launchEnvironment(this.p.env ?? process.env, `http://127.0.0.1:${relayPort}`, this.s.runtimeProfile);
        log.info(`starting ${describeLaunch(EXE_NAME, args)} (relay to ${sv.host}:${sv.port}, ${sv.mode})`);
        try {
          await this.game.start(dir, args, env);
        } catch (e) {
          log.error(`launch failed: ${describeError(e)}`);
          return this.fail("launch_failed");
        }
        launched = true;
        return OK;
      } finally {
        if (!launched) await this.stopRelay();
      }
    });
  }

  private async startRelay(sv: StoredServer): Promise<ActionResult> {
    await this.stopRelay();
    if (sv.mode === "public" && sv.fp === null) return this.fail("relay_failed");
    const port = this.p.relayPort ?? DEFAULT_RELAY_PORT;
    let relay: Relay;
    try {
      relay = new Relay({
        target: { host: sv.host, port: sv.port, fingerprint: sv.mode === "public" ? sv.fp : null },
        port,
        qosPort: this.p.qosPort === undefined ? 80 : this.p.qosPort,
        onPinError: () => {
          this.lastError = { code: "cert_mismatch" };
          this.publish();
        },
        onLog: (level, message) => log[level](`relay: ${message}`),
      });
      await relay.start();
    } catch (e) {
      log.error(`relay could not start: ${describeError(e)}`);
      return this.fail(e instanceof RelayError && e.code === "port_busy" ? "relay_port_busy" : "relay_failed", String(port));
    }
    this.relay = relay;
    return OK;
  }

  private async stopRelay(): Promise<void> {
    const relay = this.relay;
    this.relay = null;
    if (relay) {
      await relay.stop().catch(() => undefined);
      log.info(`relay stopped (${relay.requests} requests, ${relay.upgrades} upgrades, ${relay.failures} failures, ${relay.qosAnswers} QoS answers)`);
    }
  }

  // ------------------------------------------------------------------ settings / links

  async setSettings(patch: unknown): Promise<Settings> {
    if (typeof patch === "object" && patch !== null) {
      const p = patch as Record<string, unknown>;
      await this.settings.update((s) => {
        if (GRAPHICS_PRESETS.includes(p.graphics as GraphicsPreset)) s.graphics = p.graphics as GraphicsPreset;
        if (typeof p.windowed === "boolean") s.windowed = p.windowed;
        if (typeof p.streamerMode === "boolean") s.streamerMode = p.streamerMode;
        if (typeof p.hostTools === "boolean") s.hostTools = p.hostTools;
        if (LANGUAGES.includes(p.language as Language)) s.language = p.language as Language;
        if (GAME_LANGUAGES.includes(p.gameLanguage as GameLanguage)) s.gameLanguage = p.gameLanguage as GameLanguage;
        if (RUNTIME_PROFILES.includes(p.runtimeProfile as RuntimeProfile)) s.runtimeProfile = p.runtimeProfile as RuntimeProfile;
      });
    }
    this.publish();
    return this.currentSettings();
  }

  async openExternal(target: ExternalTarget): Promise<ActionResult> {
    let url: string | null;
    switch (target) {
      case "tailscale_share":
        url = this.s.server?.mode === "private" ? this.s.server.share : null;
        break;
      case "server_source":
        url = this.status?.sourceUrl ?? PROJECT_URL;
        break;
      default:
        // Every other target opens its one fixed URL; an unknown name gets null.
        url = fixedLinkUrl(target);
    }
    if (!url || !isAllowedExternalUrl(url, this.status?.sourceUrl ?? null)) return err("unknown");
    await this.p.openExternal(url);
    return OK;
  }

  async openLogsFolder(): Promise<void> {
    const dir = path.join(this.p.userDataDir, "logs");
    if (existsSync(dir)) await this.p.openPath(dir);
  }

  // ------------------------------------------------------------------ Host tools

  async hostKit(): Promise<HostKit> {
    const kit = await detectHostKit(this.s.hostWorkspace, { env: this.p.env ?? process.env, platform: this.hostPlatform, dumpRoot: this.p.dumpRoot });
    return { ...kit, dumperDll: this.s.dumperDll, job: this.hostJob };
  }

  private async emitHostKit(): Promise<void> {
    if (!this.p.emitHostKit) return;
    try {
      this.p.emitHostKit(await this.hostKit());
    } catch (e) {
      log.warn(`host kit not refreshed: ${describeError(e)}`);
    }
  }

  async hostChooseWorkspace(): Promise<ActionResult> {
    const picked = await this.p.chooseFolder("workspace", this.s.hostWorkspace ?? "");
    if (!picked) return err("cancelled");
    if (!existsSync(path.join(picked, "ReforgedHost", "package.json"))) return this.fail("host_failed", "workspace");
    await this.settings.update((s) => {
      s.hostWorkspace = picked;
    });
    await this.emitHostKit();
    this.publish();
    return OK;
  }

  async hostChooseDumper(): Promise<ActionResult> {
    const picked = await this.p.chooseDll(this.s.dumperDll ?? "");
    if (!picked) return err("cancelled");
    if (!/\.dll$/i.test(picked) || !existsSync(picked)) return this.fail("host_failed", "dumper");
    await this.settings.update((s) => {
      s.dumperDll = picked;
    });
    await this.emitHostKit();
    return OK;
  }

  async hostOpen(folder: HostFolder): Promise<ActionResult> {
    const ws = this.s.hostWorkspace;
    const w = ws ? workspacePaths(ws) : null;
    const target: Record<HostFolder, string | null> = {
      workspace: ws,
      runtime_source: w?.runtimeSource ?? null,
      dumps: this.p.dumpRoot ?? DUMPER_OUTPUT_ROOT,
      game_data: w ? path.dirname(w.backendGameData) : null,
      runtime_publish: w?.publish ?? null,
      host_logs: w?.logs ?? null,
    };
    const dir = target[folder];
    if (!dir || !existsSync(dir)) return this.fail("host_failed", "folder");
    await this.p.openPath(dir);
    return OK;
  }

  private setJob(job: HostJob | null): void {
    this.hostJob = job;
    void this.emitHostKit();
  }

  private async finishJob(kind: HostJob["kind"], ok: boolean, message: string | null, logFile: string | null = null): Promise<ActionResult> {
    this.setJob({ kind, state: ok ? "done" : "failed", message, logFile });
    if (ok) {
      this.notice = kind === "import_sdk" ? "sdk_imported" : "host_done";
      this.publish();
      return OK;
    }
    return this.fail("host_failed", message ?? kind);
  }

  async hostAction(action: HostAction): Promise<ActionResult> {
    if (this.hostJob?.state === "running") return err("busy");
    const ws = this.s.hostWorkspace;
    const needsWorkspace = action !== "inject_dumper" && action !== "inject_exporter";
    if (needsWorkspace && !ws) return this.fail("host_failed", "workspace");
    const w = ws ? workspacePaths(ws) : null;
    try {
      switch (action) {
        case "inject_dumper":
          return await this.startDump();
        case "inject_exporter":
          return await this.injectExporter(w);
        case "import_sdk": {
          const dumps = await findDumps(this.p.dumpRoot ?? DUMPER_OUTPUT_ROOT);
          if (dumps.length === 0) return this.fail("host_failed", "no_dump");
          this.setJob({ kind: "import_sdk", state: "running", message: dumps[0].name, logFile: null });
          const n = await importSdk(dumps[0].dir, w!.runtimeSource);
          log.info(`host: imported ${n} SDK files from ${dumps[0].name}`);
          return this.finishJob("import_sdk", true, `${n} files`);
        }
        case "build_runtime":
        case "build_exporter": {
          const tools = await findToolchain(this.p.env ?? process.env, this.hostPlatform);
          if (!tools.msbuild) return this.fail("host_failed", "msbuild");
          const project = action === "build_runtime" ? w!.runtimeSolution : w!.exporterProject;
          const logFile = path.join(w!.logs, `${action}.log`);
          this.setJob({ kind: action, state: "running", message: null, logFile });
          const r = await runLogged(tools.msbuild, msbuildArgs(project, platformToolset(tools.majorVersion)), path.dirname(project), logFile);
          return this.finishJob(action, r.code === 0, r.lastLine, logFile);
        }
        case "build_loader": {
          const tools = await findToolchain(this.p.env ?? process.env, this.hostPlatform);
          if (!tools.cargo) return this.fail("host_failed", "cargo");
          const logFile = path.join(w!.logs, "build_loader.log");
          this.setJob({ kind: "build_loader", state: "running", message: null, logFile });
          const r = await runLogged(tools.cargo, ["build", "--release"], w!.loaderDir, logFile);
          return this.finishJob("build_loader", r.code === 0, r.lastLine, logFile);
        }
        case "copy_exports": {
          const dir = this.win64Dir();
          const from = dir ? path.join(dir, "Items_Analysis") : null;
          if (!from || !existsSync(from)) return this.fail("host_failed", "no_exports");
          this.setJob({ kind: "copy_exports", state: "running", message: null, logFile: null });
          const n = await copyTree(from, w!.exports);
          return this.finishJob("copy_exports", true, `${n} files`);
        }
        case "synthetic_data": {
          this.setJob({ kind: "synthetic_data", state: "running", message: null, logFile: null });
          const n = (await useSyntheticData(w!.backendGameData, BACKEND_GAME_DATA)) + (await useSyntheticData(w!.directorGameData, DIRECTOR_GAME_DATA));
          return this.finishJob("synthetic_data", true, `${n} files`);
        }
        case "publish_runtime": {
          this.setJob({ kind: "publish_runtime", state: "running", message: null, logFile: null });
          const r = await publishRuntime(w!);
          log.info(`host: runtime ${r.version} published to the content server`);
          return this.finishJob("publish_runtime", true, r.version);
        }
      }
    } catch (e) {
      log.error(`host action ${action} failed: ${describeError(e)}`);
      return this.finishJob(action === "inject_dumper" || action === "inject_exporter" ? "inject" : action, false, describeError(e));
    }
  }

  // Dumper-7 session: the game starts without the runtime (its loader is set aside until the game
  // closes), and Dumper-7 is loaded into it once its window is up. The SDK appears under
  // C:\Dumper-7 a minute or two later; "Import SDK" copies it into the workspace.
  private async startDump(): Promise<ActionResult> {
    if (this.busy || this.task || this.game.running) return err("busy");
    if (this.hostPlatform !== "win32" || !this.p.inject) return this.fail("host_failed", "windows_only");
    const dll = this.s.dumperDll;
    if (!dll || !existsSync(dll)) return this.fail("host_failed", "dumper");
    const dir = this.win64Dir();
    if (!dir || this.gameInfo.problem === "not_found" || this.gameInfo.problem === "not_set") return this.fail("game_folder_not_found");
    // The SDK must come from the exact build the runtime targets.
    if (this.gameInfo.problem === "wrong_version") return this.fail("game_wrong_version");
    const loader = path.join(dir, "winmm.dll");
    if (existsSync(loader)) {
      const aside = `${loader}.rr-off`;
      await fsp.rename(loader, aside);
      this.dumpRestore = { from: aside, to: loader };
    }
    this.setJob({ kind: "inject", state: "running", message: "Dumper-7", logFile: null });
    const env = { ...(this.p.env ?? process.env) };
    for (const k of Object.keys(env)) if (/^(REFORGED_|MYSTICPARADOX_)/i.test(k)) delete env[k];
    try {
      await this.game.start(dir, ["-NoEAC", "-EpicPortal", "-DisableEOS"], env);
    } catch (e) {
      await this.restoreAfterDump();
      return this.finishJob("inject", false, describeError(e));
    }
    const pid = this.game.pid;
    if (pid === null) return this.finishJob("inject", false, "no_process");
    const result = await this.p.inject({ pid, dll });
    log.info(`host: Dumper-7 ${result.event} (${result.detail})`);
    return this.finishJob("inject", result.event === "injected", result.event === "injected" ? "Dumper-7" : result.detail);
  }

  private async restoreAfterDump(): Promise<void> {
    const r = this.dumpRestore;
    this.dumpRestore = null;
    if (!r) return;
    try {
      if (!existsSync(r.to)) await fsp.rename(r.from, r.to);
    } catch (e) {
      log.error(`could not put the runtime loader back: ${describeError(e)}`);
    }
  }

  // CatalogExporter into the game this launcher started with Play (it reads export_flags.txt from
  // the game's working folder and writes Items_Analysis there).
  private async injectExporter(w: ReturnType<typeof workspacePaths> | null): Promise<ActionResult> {
    if (!w) return this.fail("host_failed", "workspace");
    if (this.hostPlatform !== "win32" || !this.p.inject) return this.fail("host_failed", "windows_only");
    if (!this.game.running || this.game.pid === null) return this.fail("host_failed", "game_not_running");
    if (!existsSync(w.exporterDll)) return this.fail("host_failed", "exporter");
    const dir = this.win64Dir();
    if (!dir) return this.fail("game_folder_not_found");
    await fsp.writeFile(path.join(dir, "export_flags.txt"), EXPORT_FLAGS);
    this.setJob({ kind: "inject", state: "running", message: "CatalogExporter", logFile: null });
    const result = await this.p.inject({ pid: this.game.pid, dll: w.exporterDll, waitWindowSeconds: 1, extraDelaySeconds: 0 });
    log.info(`host: CatalogExporter ${result.event} (${result.detail})`);
    return this.finishJob("inject", result.event === "injected", result.event === "injected" ? "CatalogExporter" : result.detail);
  }

  async shutdown(): Promise<void> {
    this.setStatusPolling(false);
    this.taskAbort?.abort();
    await this.stopRelay();
    await this.hashes.save().catch(() => undefined);
  }
}

// For the renderer's "what is wrong with the game folder" text, re-exported for tests.
export type { GameProblem };
