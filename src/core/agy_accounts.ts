import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgyAccountOption } from "../shared/types.js";
import { buildAugmentedPath } from "./config.js";

const ACCOUNT_ID = /^[a-f0-9]{24}$/;
const DEFAULT_STORE = path.join(os.homedir(), ".gemini/antigravity/plugin_data/antigravity-account-switch/real-accounts");
const SANDBOX = "/usr/bin/sandbox-exec";

export interface AgyLaunchProfile {
  home: string;
  sandbox: string;
}

export function agyProxyEnv(configured?: Record<string, string>): Record<string, string> {
  const proxyEnv: Record<string, string> = {};
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    const value = configured?.[key] ?? process.env[key];
    if (value) proxyEnv[key] = value;
  }
  return proxyEnv;
}

export function agyProfileCommand(profile: AgyLaunchProfile, binary: string, args: string[], configuredEnv?: Record<string, string>) {
  return {
    command: SANDBOX,
    args: ["-p", profile.sandbox, binary, ...args],
    env: {
      HOME: profile.home,
      TMPDIR: profile.home,
      PATH: buildAugmentedPath(),
      ...agyProxyEnv(configuredEnv),
      ...(process.env.USER ? { USER: process.env.USER } : {}),
      ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    },
    replaceEnv: true,
  };
}

function privatePath(file: string, directory: boolean): fs.Stats {
  const stat = fs.lstatSync(file);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error("Unsafe AGY account storage permissions.");
  }
  return stat;
}

function privateDirectory(dir: string): void {
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  privatePath(dir, true);
}

function readPrivate(file: string): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 128 * 1024) {
      throw new Error("Unsafe AGY account file.");
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivate(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  try { fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}

export class AgyAccounts {
  constructor(
    private readonly dataDir: string,
    private readonly sourceDir = process.env.POLY_SWARM_AGY_ACCOUNTS_DIR || DEFAULT_STORE,
  ) {}

  private readAccount(id: string) {
    if (!ACCOUNT_ID.test(id)) throw new Error("Invalid AGY account ID.");
    try {
      privatePath(this.sourceDir, true);
      const raw = readPrivate(path.join(this.sourceDir, id + ".json")) as {
        id?: unknown; email?: unknown; verifiedAt?: unknown; credential?: Record<string, unknown>;
      };
      if (raw.id !== id || typeof raw.email !== "string" ||
          createHash("sha256").update(raw.email.toLowerCase()).digest("hex").slice(0, 24) !== id ||
          typeof raw.verifiedAt !== "string" || !Number.isFinite(Date.parse(raw.verifiedAt)) ||
          typeof raw.credential?.refresh_token !== "string" || !raw.credential.refresh_token) throw new Error();
      return { email: raw.email, credential: raw.credential, verifiedAt: raw.verifiedAt };
    } catch {
      throw new Error("The bound AGY account is unavailable. Restore it in Antigravity Account Switch.");
    }
  }

  list(): AgyAccountOption[] {
    if (process.platform !== "darwin") return [];
    try {
      privatePath(this.sourceDir, true);
      return fs.readdirSync(this.sourceDir).flatMap((name) => {
        const id = name.slice(0, -5);
        if (!name.endsWith(".json") || !ACCOUNT_ID.test(id)) return [];
        try { return [{ id, email: this.readAccount(id).email }]; }
        catch { return []; }
      }).sort((a, b) => a.email.localeCompare(b.email));
    } catch {
      return [];
    }
  }

  assertAvailable(id: string): void {
    this.readAccount(id);
  }

  prepare(id: string): AgyLaunchProfile {
    try {
      if (process.platform !== "darwin" || !fs.existsSync(SANDBOX) || this.dataDir === ":memory:") {
        throw new Error("Isolated AGY login requires macOS sandbox-exec and a persistent Poly Swarm data directory.");
      }
      const account = this.readAccount(id);
      const root = path.join(fs.realpathSync(this.dataDir), "agy-profiles");
      privateDirectory(root);
      const home = path.join(root, id);
      privateDirectory(home);
      const gemini = path.join(home, ".gemini");
      privateDirectory(gemini);
      const cli = path.join(gemini, "antigravity-cli");
      privateDirectory(cli);
      const tokenFile = path.join(cli, "antigravity-oauth-token");
      const seedFile = path.join(cli, ".poly-swarm-account-version");
      let seeded = false;
      try {
        const native = readPrivate(tokenFile) as { id_token_email?: unknown };
        if (native.id_token_email !== account.email) throw new Error("AGY profile identity does not match its bound account.");
        seeded = readPrivate(seedFile) === account.verifiedAt;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (!seeded) {
        writePrivate(tokenFile, { token: account.credential, auth_method: "consumer", id_token_email: account.email,
          ...(account.credential.id_token ? { id_token: account.credential.id_token } : {}) });
        writePrivate(seedFile, account.verifiedAt);
      }

      const host = fs.realpathSync(os.homedir());
      const source = fs.realpathSync(this.sourceDir);
      if (home.startsWith(source + path.sep)) throw new Error("AGY profiles must be outside the account store.");
      const protectedPaths = [
        source,
        path.join(host, ".gemini"),
        path.join(host, "Library/Keychains"),
        path.join(host, "Library/Application Support/Antigravity"),
        path.join(host, ".config/gcloud"),
      ];
      const sandbox = [
        "(version 1)", "(allow default)",
        '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.secd") (global-name "com.apple.SecurityServer"))',
        `(deny file-read-data file-write* (require-all (require-any ${[...protectedPaths, root].map((dir) => `(subpath ${JSON.stringify(dir)})`).join(" ")}) (require-not (subpath ${JSON.stringify(home)}))))`,
      ].join("\n");
      return { home, sandbox };
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.startsWith("Isolated AGY ") || message.startsWith("The bound AGY ") ||
          message.startsWith("AGY profile identity")) throw err;
      throw new Error("Unable to prepare private storage for the bound AGY account.");
    }
  }
}
