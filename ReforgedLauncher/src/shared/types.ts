// Types shared by the main process, the preload bridge and the renderer.
// The main process owns all state; the renderer only draws a Snapshot and sends intents.

import type { ServerStatus } from "./status";
import type { ServerMode } from "./invite";

export type { ServerMode };

// The launcher's own text: English and Brazilian Portuguese.
export type Language = "en" | "pt-BR";
export const LANGUAGES: readonly Language[] = ["en", "pt-BR"];

// -1 = leave graphics to the in-game menu, 0..4 = Low, Medium, High, Epic, Cinematic.
export type GraphicsPreset = -1 | 0 | 1 | 2 | 3 | 4;
export const GRAPHICS_PRESETS: readonly GraphicsPreset[] = [-1, 0, 1, 2, 3, 4];
export const DEFAULT_GRAPHICS: GraphicsPreset = -1;

// The game's own text language, sent to it as -epiclocale; "auto" follows the operating system.
export type GameLanguage = "auto" | "en-US" | "de-DE" | "es-ES" | "fr-FR" | "it-IT" | "ja-JP" | "pt-BR" | "ru-RU";
export const GAME_LANGUAGES: readonly GameLanguage[] = ["auto", "en-US", "de-DE", "es-ES", "fr-FR", "it-IT", "ja-JP", "pt-BR", "ru-RU"];

// The game runtime's log profile (MYSTICPARADOX_RUNTIME_PROFILE). "development" also honours the
// runtime's diagnostic .flag files next to the game executable.
export type RuntimeProfile = "production" | "development";
export const RUNTIME_PROFILES: readonly RuntimeProfile[] = ["production", "development"];

export type Phase =
  | "loading"
  | "join" // no server yet: paste an invite
  | "connect" // server known, not reachable (or still checking)
  | "register" // server reachable, no account key yet
  | "locate" // account ready, but no Dauntless 1.14.7 folder chosen, found or accepted
  | "runtime" // game found; the server's game runtime is not installed, out of date or not trusted yet
  | "installing" // a check or the runtime download is running
  | "ready" // PLAY
  | "running"; // the game is running

export type ConnectProblem =
  | "tailscale_missing" // private mode only
  | "unreachable" // no answer within 5 s
  | "bad_answer" // something answered but it is not a Reforged server
  | "cert_mismatch" // public mode: the certificate is not the one from the invite
  | null;

// Why the chosen game folder cannot be used yet.
export type GameProblem =
  | "not_set" // nothing chosen and nothing found on this PC
  | "not_found" // the chosen folder no longer holds the game
  | "unverified" // found, but its executable has not been checked yet (or changed since)
  | "wrong_version" // the executable is not the Dauntless 1.14.7 build (CL 647472)
  | null;

// The server's game runtime (the Mystic Paradox DLL and its loader, built by the host).
export type RuntimeState =
  | "ok" // installed next to the game and matching the server's list
  | "missing" // not installed yet
  | "outdated" // installed, but the server now offers another build
  | "untrusted" // offered, but not accepted on this PC yet (the player is asked first)
  | "unavailable" // the server offers no runtime: its host has not built one yet
  | "local"; // a local runtime folder is used instead (Settings > Advanced)

export type ErrorCode =
  | "account_banned"
  | "invite_invalid_format"
  | "invite_invalid"
  | "username_invalid"
  | "username_taken"
  | "registration_closed"
  | "bad_request"
  | "server_unreachable"
  | "server_error"
  | "key_invalid"
  | "key_rejected"
  | "key_storage_unavailable"
  | "folder_invalid"
  | "game_folder_not_found" // no Dauntless game in the layouts looked at
  | "game_wrong_version" // the executable is not the 1.14.7 build
  | "runtime_unavailable" // the server offers no runtime yet
  | "runtime_untrusted" // the player has not accepted this server's runtime
  | "runtime_failed" // downloading or installing the runtime failed
  | "runtime_different_on_server" // a file did not match the server's own list
  | "local_runtime_invalid"
  | "download_failed"
  | "disk_space"
  | "already_running"
  | "launch_failed"
  | "config_failed"
  | "busy"
  | "cancelled"
  | "cert_mismatch"
  | "cert_changed" // a public invite whose certificate differs from the one this PC's key belongs to
  | "rate_limited"
  | "relay_port_busy"
  | "relay_failed"
  | "host_failed" // a Host tools action failed (detail says which)
  | "unknown";

// Short messages that are not errors.
export type NoticeCode = "keep_open" | "backup_saved" | "runtime_installed" | "game_verified" | "sdk_imported" | "host_done";

export interface LauncherError {
  code: ErrorCode;
  // Extra detail for the message, e.g. a file path or a byte count. Never a key.
  detail?: string;
}

export type ActionResult = { ok: true } | { ok: false; error: LauncherError };

// Asked before joining from an invite. certificateChanged: this PC has a key for the invite's
// host:port that belongs to another certificate (previousFingerprint, null if not recorded).
export type InviteCheck =
  | { ok: true; certificateChanged: boolean; previousFingerprint: string | null }
  | { ok: false; error: LauncherError };

export type TaskKind = "verify" | "runtime";

export interface TaskProgress {
  kind: TaskKind;
  totalBytes: number;
  doneBytes: number;
  filesTotal: number;
  filesDone: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  currentFile: string | null;
}

export interface ServerInfo {
  mode: ServerMode;
  host: string;
  port: number;
  name: string;
  hasShare: boolean;
  hasPendingInvite: boolean; // an invite code is stored and not used yet
  loopback: boolean;
  fingerprint: string | null; // public mode: the pinned certificate fingerprint (not secret)
}

// A server joined before, for switching back to it without the invite.
export interface SavedServerInfo {
  id: string; // the account key slot id (not secret)
  mode: ServerMode;
  host: string;
  port: number;
  name: string;
  current: boolean;
  username: string | null;
}

export type GameSource = "epic" | "legendary" | "heroic" | "chosen";

export interface DetectedGame {
  root: string;
  source: GameSource;
  version: string | null; // what the store says (Legendary/Heroic), or Version.txt
}

export interface GameInfo {
  root: string | null; // the "Dauntless" folder, the one that holds Archon\
  problem: GameProblem;
  versionText: string | null; // Version.txt, e.g. dauntless_rel-1.14.7_Shipping_2024-04-01_14-59-21_647472
  versionOk: boolean; // Version.txt names 1.14.7, changelist 647472
  exeVerified: boolean; // the executable's SHA-256 is the 1.14.7 one (checked once per file change)
  detected: DetectedGame[]; // installs found on this PC (Epic, Legendary, Heroic)
}

export interface RuntimeFileInfo {
  name: string;
  size: number;
  sha256: string;
}

export interface RuntimeInfo {
  state: RuntimeState;
  version: string | null; // the server's runtime version
  files: RuntimeFileInfo[]; // what the server offers (shown when the player is asked to trust it)
  localDir: string | null;
}

export interface Settings {
  graphics: GraphicsPreset;
  windowed: boolean;
  language: Language;
  gameLanguage: GameLanguage;
  runtimeProfile: RuntimeProfile;
  streamerMode: boolean; // hide addresses, fingerprints, paths and player names on screen
  hostTools: boolean; // show the Host page in the rail
}

export interface Snapshot {
  phase: Phase;
  busy: boolean;
  server: ServerInfo | null;
  savedServers: SavedServerInfo[];
  connect: {
    checking: boolean;
    problem: ConnectProblem;
    tailscaleInstalled: boolean;
    lastCheckedAt: string | null;
  };
  account: {
    username: string | null;
    hasKey: boolean;
    offerBackup: boolean;
  };
  game: GameInfo;
  runtime: RuntimeInfo;
  task: TaskProgress | null;
  running: { game: boolean; relayPort: number | null };
  settings: Settings;
  app: { version: string; packaged: boolean; updateReady: boolean; platform: string };
  status: ServerStatus | null;
  statusUnsupported: boolean; // the host answers but has no ServerStatus endpoint
  lastError: LauncherError | null;
  notice: NoticeCode | null;
}

export interface NewsItem {
  date: string | null;
  title: string;
  body: string;
}

export interface Branding {
  backgrounds: { url: string; credit: string | null }[]; // app-internal rr-art:// URLs
  accent: string | null;
}

// ------------------------------------------------------------------ Host tools

// What the Host page shows: the steps a host goes through before friends can play, each one
// detected from files on this PC. Nothing here is secret.
export type GameDataState = "real" | "synthetic" | "missing";

export interface HostKit {
  workspace: string | null; // a Dauntless Reforged Revival checkout (the folder with ReforgedHost\)
  workspaceOk: boolean;
  upstream: {
    present: boolean; // .workspace\Mystic-Paradox holds the pinned source
    patched: boolean; // and the Reforged patches are applied
  };
  sdk: {
    present: boolean; // ParadoxRuntime\SDK.hpp
    functionFiles: number; // ParadoxRuntime\SDK\*_functions.cpp
  };
  dumps: { dir: string; name: string; modified: string }[]; // Dumper-7 CppSDK outputs found on this PC
  dumperDll: string | null; // the Dumper-7 DLL the host picked
  builds: {
    runtime: boolean; // ParadoxRuntime\x64\Release\MysticParadox.dll
    loader: boolean; // tools\RuntimeLoader\target\release\winmm.dll
    exporter: boolean; // tools\CatalogExporter\x64\Release\CatalogExporter.dll
    published: boolean; // both runtime files in the content server's runtime folder
  };
  toolchain: {
    visualStudio: string | null; // e.g. "Visual Studio 2022 (17.14)"
    msbuild: boolean;
    cargo: boolean;
  };
  gameData: { backend: GameDataState; director: GameDataState };
  exports: { present: boolean }; // Items_Analysis in the workspace
  job: HostJob | null;
}

export type HostJobKind = "inject" | "build_runtime" | "build_loader" | "build_exporter" | "import_sdk" | "copy_exports" | "synthetic_data" | "publish_runtime";

export interface HostJob {
  kind: HostJobKind;
  state: "running" | "done" | "failed";
  message: string | null; // the last line of its log, never a secret
  logFile: string | null;
}

// The links the page can ask the main process to open. The page names one of these; it never passes
// a URL. The main process maps each to its URL (src/main/links.ts).
export type ExternalTarget =
  | "tailscale_download"
  | "tailscale_share"
  | "vc_redist"
  | "server_source"
  | "project_source"
  | "project_license"
  | "project_issues"
  | "project_docs_players"
  | "project_docs_hosting"
  | "project_docs_sdk"
  | "installing_guide"
  | "legendary"
  | "dumper7"
  | "visual_studio"
  | "rust"
  | "nodejs"
  | "mongodb"
  | "revived_source"
  | "mystic_source"
  | "undaunted_source";

export type RegisterOutcome =
  | { ok: true; username: string }
  | { ok: false; error: LauncherError };

// Channel names (renderer -> main are invoke channels, main -> renderer are events).
export const IPC = {
  getSnapshot: "rr:get-snapshot",
  checkInvite: "rr:check-invite",
  submitInvite: "rr:submit-invite",
  retryConnect: "rr:retry-connect",
  forgetServer: "rr:forget-server",
  switchServer: "rr:switch-server",
  removeSavedServer: "rr:remove-saved-server",
  register: "rr:register",
  useExistingKey: "rr:use-existing-key",
  importKeyFile: "rr:import-key-file",
  saveKeyBackup: "rr:save-key-backup",
  dismissBackupOffer: "rr:dismiss-backup-offer",
  chooseGameFolder: "rr:choose-game-folder",
  useGamePath: "rr:use-game-path",
  useDetectedGame: "rr:use-detected-game",
  verifyGame: "rr:verify-game",
  trustRuntime: "rr:trust-runtime",
  installRuntime: "rr:install-runtime",
  chooseLocalRuntime: "rr:choose-local-runtime",
  clearLocalRuntime: "rr:clear-local-runtime",
  cancelTask: "rr:cancel-task",
  play: "rr:play",
  setSettings: "rr:set-settings",
  setStatusPolling: "rr:set-status-polling",
  refreshStatus: "rr:refresh-status",
  getNews: "rr:get-news",
  getBranding: "rr:get-branding",
  openExternal: "rr:open-external",
  openGameFolder: "rr:open-game-folder",
  openLogsFolder: "rr:open-logs-folder",
  logout: "rr:logout",
  installUpdate: "rr:install-update",
  hostGet: "rr:host-get",
  hostChooseWorkspace: "rr:host-choose-workspace",
  hostChooseDumper: "rr:host-choose-dumper",
  hostAction: "rr:host-action",
  hostOpen: "rr:host-open",
  windowMinimize: "rr:window-minimize",
  windowMaximize: "rr:window-maximize",
  windowClose: "rr:window-close",
  takeInviteLink: "rr:take-invite-link",
  dismissNotice: "rr:dismiss-notice",
  dismissError: "rr:dismiss-error",
  // events
  inviteLink: "rr:invite-link",
  snapshot: "rr:snapshot",
  progress: "rr:progress",
  hostKit: "rr:host-kit",
  windowState: "rr:window-state",
} as const;

// Host page actions, by name (the page never passes a path or a command).
export type HostAction =
  | "inject_dumper" // start the game without the runtime and load Dumper-7 into it
  | "import_sdk" // copy the newest Dumper-7 CppSDK into the runtime source
  | "build_runtime"
  | "build_loader"
  | "build_exporter"
  | "inject_exporter" // load CatalogExporter into the running game
  | "copy_exports" // copy the exporter's Items_Analysis into the workspace
  | "synthetic_data" // copy the example game data (startup tests only)
  | "publish_runtime"; // copy the built runtime files to the content server

export type HostFolder = "workspace" | "runtime_source" | "dumps" | "game_data" | "runtime_publish" | "host_logs";
