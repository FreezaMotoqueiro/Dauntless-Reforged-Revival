// Running other programs: npm, git, node scripts. Always with an argument list (never a shell
// string), output into a log file and, unless quiet, onto the console.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface RunOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    logFile?: string;
    quiet?: boolean;
}

export interface RunResult {
    code: number;
    lastLine: string | null;
    output: string;
}

const isWindows = process.platform === "win32";

// npm on Windows is npm.cmd, which Node only starts through cmd.exe. Under `npm run`, npm names its
// own entry script in npm_execpath: that runs with this Node and no shell. Otherwise cmd.exe it is;
// the arguments here are always fixed words (no user input), so that is safe.
function resolveCommand(command: string, args: string[]): { file: string; args: string[]; shell: boolean } {
    const npmCli = process.env.npm_execpath;
    if (isWindows && command === "npm" && npmCli && /npm-cli\.js$/i.test(npmCli) && fs.existsSync(npmCli)) return { file: process.execPath, args: [npmCli, ...args], shell: false };
    if (isWindows && (command === "npm" || command === "npx")) return { file: `${command}.cmd`, args, shell: true };
    return { file: command, args, shell: false };
}

export function run(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
    const resolved = resolveCommand(command, args);
    return new Promise((resolve) => {
        if (opts.logFile) fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
        const log = opts.logFile ? fs.createWriteStream(opts.logFile, { flags: "a" }) : null;
        log?.write(`\n$ ${command} ${args.join(" ")}  (in ${opts.cwd})\n`);
        let output = "";
        let lastLine: string | null = null;
        const child = spawn(resolved.file, resolved.args, { cwd: opts.cwd, env: opts.env ?? process.env, shell: resolved.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const onData = (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            output = (output + text).slice(-64 * 1024);
            log?.write(text);
            if (!opts.quiet) process.stdout.write(text);
            const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            if (lines.length) lastLine = lines[lines.length - 1].slice(0, 300);
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (e) => {
            log?.end();
            resolve({ code: -1, lastLine: e.message, output });
        });
        child.on("close", (code) => {
            log?.end(() => resolve({ code: code ?? -1, lastLine, output }));
            if (!log) resolve({ code: code ?? -1, lastLine, output });
        });
    });
}

// A quick synchronous call for checks (git --version, tailscale ip -4). Null when it fails.
export function capture(command: string, args: string[], cwd?: string): string | null {
    const resolved = resolveCommand(command, args);
    const r = spawnSync(resolved.file, resolved.args, { cwd, encoding: "utf8", windowsHide: true, shell: resolved.shell, timeout: 20000 });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout.trim();
}
