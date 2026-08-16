import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { basename, join, parse, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface Identity { path: string; dev: number; ino: number }
interface VerifiedDirectory { path: string; identities: Identity[] }
interface TargetSnapshot { name: string; path: string; exists: boolean; dev?: number; ino?: number }
interface StagedArtifact { name: string; path: string; dev: number; ino: number }
interface DirectoryLock extends Identity {}

interface ArtifactWriterOptions {
  /** Test-only fault injection for the atomic stage-to-target rename. */
  publishRename?: (source: string, destination: string) => Promise<void>;
  /** Bounded lock acquisition controls used by fault-injection tests. */
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 20;
const MAX_LOCK_RETRY_MS = 1_000;

const DARWIN_ROOT_ALIASES: Readonly<Record<string, string>> = {
  "/etc": "/private/etc",
  "/tmp": "/private/tmp",
  "/var": "/private/var",
};

function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function existsAlready(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

async function verifiedDarwinRootAlias(path: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const expected = DARWIN_ROOT_ALIASES[path];
  if (expected === undefined) return undefined;
  let actual: string;
  try { actual = await realpath(path); }
  catch { return undefined; }
  if (actual !== expected) return undefined;
  const stat = await lstat(actual);
  return !stat.isSymbolicLink() && stat.isDirectory() ? actual : undefined;
}

async function requireDirectory(path: string): Promise<VerifiedDirectory> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const tail = relative(root, absolute);
  const segments = tail.length === 0 ? [] : tail.split(sep).filter(Boolean);
  const identities: Identity[] = [];
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const candidate = join(current, segment);
    let stat;
    try { stat = await lstat(candidate); }
    catch (error: unknown) {
      if (!missing(error)) throw error;
      try { await mkdir(candidate, { mode: 0o755 }); }
      catch (mkdirError: unknown) { if (!existsAlready(mkdirError)) throw mkdirError; }
      stat = await lstat(candidate);
    }
    if (stat.isSymbolicLink()) {
      const alias = index === 0 ? await verifiedDarwinRootAlias(candidate) : undefined;
      if (alias === undefined) throw new Error(`output path contains a symbolic-link component: ${candidate}`);
      current = alias;
      const aliasStat = await lstat(alias);
      identities.push({ path: alias, dev: aliasStat.dev, ino: aliasStat.ino });
      continue;
    }
    if (!stat.isDirectory()) throw new Error(`output path component is not a real directory: ${candidate}`);
    current = candidate;
    identities.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return { path: current, identities };
}

async function assertDirectoryIdentities(directory: VerifiedDirectory): Promise<void> {
  for (const identity of directory.identities) {
    const stat = await lstat(identity.path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new Error(`output directory identity changed during publication: ${identity.path}`);
    }
  }
}

async function snapshotTarget(output: string, name: string): Promise<TargetSnapshot> {
  const path = join(output, name);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`artifact target is not a regular file: ${name}`);
    return { name, path, exists: true, dev: stat.dev, ino: stat.ino };
  } catch (error: unknown) {
    if (!missing(error)) throw error;
    return { name, path, exists: false };
  }
}

async function assertTargetSnapshot(snapshot: TargetSnapshot): Promise<void> {
  try {
    const stat = await lstat(snapshot.path);
    if (!snapshot.exists || stat.isSymbolicLink() || !stat.isFile() || stat.dev !== snapshot.dev || stat.ino !== snapshot.ino) {
      throw new Error(`artifact target changed during publication: ${snapshot.name}`);
    }
  } catch (error: unknown) {
    if (missing(error) && !snapshot.exists) return;
    throw error;
  }
}

async function assertTargetAbsent(path: string, name: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`artifact target appeared during publication: ${name}`);
  } catch (error: unknown) {
    if (!missing(error)) throw error;
  }
}

async function acquireDirectoryLock(directory: VerifiedDirectory, timeoutMs: number, retryMs: number): Promise<DirectoryLock> {
  const path = join(directory.path, ".artifact-write.lock");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await assertDirectoryIdentities(directory);
    try {
      await mkdir(path, { mode: 0o700 });
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`artifact publication lock is not a real directory: ${path}`);
      await assertDirectoryIdentities(directory);
      return { path, dev: stat.dev, ino: stat.ino };
    } catch (error: unknown) {
      if (!existsAlready(error)) throw error;
    }

    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`artifact publication lock is not a real directory: ${path}`);
    } catch (error: unknown) {
      if (missing(error)) continue;
      throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`artifact publication lock is held or stale: ${path}`);
    await delay(Math.min(retryMs, remaining));
  }
}

async function releaseDirectoryLock(directory: VerifiedDirectory, lock: DirectoryLock): Promise<void> {
  await assertDirectoryIdentities(directory);
  const stat = await lstat(lock.path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== lock.dev || stat.ino !== lock.ino) {
    throw new Error(`artifact publication lock identity changed: ${lock.path}`);
  }
  await rmdir(lock.path);
  await assertDirectoryIdentities(directory);
}

type ArtifactIdentityState = "matching" | "missing" | "other";

async function artifactIdentityState(path: string, artifact: StagedArtifact): Promise<ArtifactIdentityState> {
  try {
    const stat = await lstat(path);
    return !stat.isSymbolicLink() && stat.isFile() && stat.dev === artifact.dev && stat.ino === artifact.ino ? "matching" : "other";
  } catch (error: unknown) {
    if (missing(error)) return "missing";
    throw error;
  }
}

export async function writeArtifactSet(
  outDir: string,
  artifacts: Readonly<Record<string, string>>,
  options: ArtifactWriterOptions = {},
): Promise<void> {
  const entries = Object.entries(artifacts);
  if (entries.length === 0) throw new Error("artifact set must not be empty");
  for (const [name, content] of entries) {
    if (basename(name) !== name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) throw new Error(`invalid artifact name: ${name}`);
    if (typeof content !== "string") throw new Error(`artifact content must be a string: ${name}`);
  }
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > DEFAULT_LOCK_TIMEOUT_MS) throw new Error(`lockTimeoutMs must be a safe integer between 0 and ${DEFAULT_LOCK_TIMEOUT_MS}`);
  if (!Number.isSafeInteger(lockRetryMs) || lockRetryMs <= 0 || lockRetryMs > MAX_LOCK_RETRY_MS) throw new Error(`lockRetryMs must be a safe integer between 1 and ${MAX_LOCK_RETRY_MS}`);
  const directory = await requireDirectory(outDir);
  await assertDirectoryIdentities(directory);
  const lock = await acquireDirectoryLock(directory, lockTimeoutMs, lockRetryMs);
  let transactionError: unknown;
  let retainLock = false;
  try {
    const targets = await Promise.all(entries.map(([name]) => snapshotTarget(directory.path, name)));
    const staging = await mkdtemp(join(directory.path, ".artifact-stage-"));
    const stagingStat = await lstat(staging);
    if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) throw new Error("artifact staging path is not a real directory");
    const transactionDirectory: VerifiedDirectory = {
      path: directory.path,
      identities: [...directory.identities, lock, { path: staging, dev: stagingStat.dev, ino: stagingStat.ino }],
    };

    const staged: StagedArtifact[] = [];
    const backups = new Map<string, string>();
    const published = new Set<string>();
    let cleanStaging = true;
    try {
      for (const [name, content] of entries) {
        await assertDirectoryIdentities(transactionDirectory);
        const path = join(staging, name);
        const handle = await open(path, "wx", 0o644);
        try { await handle.writeFile(content, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`staged artifact is not a regular file: ${name}`);
        staged.push({ name, path, dev: stat.dev, ino: stat.ino });
      }

      await assertDirectoryIdentities(transactionDirectory);
      for (const target of targets) await assertTargetSnapshot(target);

      try {
        for (let index = 0; index < targets.length; index += 1) {
          const target = targets[index];
          if (target === undefined || !target.exists) continue;
          await assertDirectoryIdentities(transactionDirectory);
          await assertTargetSnapshot(target);
          const backup = join(staging, `.backup-${index}`);
          await rename(target.path, backup);
          backups.set(target.name, backup);
          const backupStat = await lstat(backup);
          if (!backupStat.isFile() || backupStat.dev !== target.dev || backupStat.ino !== target.ino) throw new Error(`artifact backup identity mismatch: ${target.name}`);
        }

        for (const artifact of staged) {
          await assertDirectoryIdentities(transactionDirectory);
          const targetPath = join(directory.path, artifact.name);
          await assertTargetAbsent(targetPath, artifact.name);
          try {
            await (options.publishRename ?? rename)(artifact.path, targetPath);
          } catch (renameError: unknown) {
            try {
              const [sourceState, targetState] = await Promise.all([
                artifactIdentityState(artifact.path, artifact),
                artifactIdentityState(targetPath, artifact),
              ]);
              if (targetState === "matching") published.add(artifact.name);
              const recognized = (sourceState === "matching" && targetState === "missing")
                || (sourceState === "missing" && targetState === "matching");
              if (!recognized) {
                throw new Error(`ambiguous publish state for ${artifact.name}: source=${sourceState}, target=${targetState}`);
              }
            } catch (inspectionError: unknown) {
              throw new AggregateError([renameError, inspectionError], `artifact rename failed with an unsafe state: ${artifact.name}`);
            }
            throw renameError;
          }
          published.add(artifact.name);
          const targetStat = await lstat(targetPath);
          if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.dev !== artifact.dev || targetStat.ino !== artifact.ino) {
            throw new Error(`published artifact identity mismatch: ${artifact.name}`);
          }
        }

        await assertDirectoryIdentities(transactionDirectory);
        for (const artifact of staged) {
          const targetStat = await lstat(join(directory.path, artifact.name));
          if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.dev !== artifact.dev || targetStat.ino !== artifact.ino) {
            throw new Error(`published artifact changed before transaction completion: ${artifact.name}`);
          }
        }
      } catch (publicationError: unknown) {
        try {
          await assertDirectoryIdentities(transactionDirectory);
          for (const artifact of [...staged].reverse()) {
            if (!published.has(artifact.name)) continue;
            await assertDirectoryIdentities(transactionDirectory);
            const target = join(directory.path, artifact.name);
            const stat = await lstat(target);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== artifact.dev || stat.ino !== artifact.ino) {
              throw new Error(`cannot safely roll back changed artifact: ${artifact.name}`);
            }
            await unlink(target);
          }
          for (const target of [...targets].reverse()) {
            const backup = backups.get(target.name);
            if (backup === undefined) continue;
            await assertDirectoryIdentities(transactionDirectory);
            await assertTargetAbsent(target.path, target.name);
            await rename(backup, target.path);
            const restored = await lstat(target.path);
            if (!restored.isFile() || restored.dev !== target.dev || restored.ino !== target.ino) throw new Error(`artifact rollback identity mismatch: ${target.name}`);
          }
        } catch (rollbackError: unknown) {
          cleanStaging = false;
          retainLock = true;
          throw new AggregateError(
            [publicationError, rollbackError],
            `artifact publication failed and rollback was incomplete; recovery files remain in ${staging}`,
          );
        }
        throw publicationError;
      }
    } finally {
      if (cleanStaging) {
        try {
          await assertDirectoryIdentities(transactionDirectory);
          await rm(staging, { recursive: true, force: true });
        } catch (cleanupError: unknown) {
          retainLock = true;
          throw cleanupError;
        }
      }
    }
  } catch (error: unknown) {
    transactionError = error;
    throw error;
  } finally {
    if (!retainLock) {
      try {
        await releaseDirectoryLock(directory, lock);
      } catch (releaseError: unknown) {
        if (transactionError !== undefined) {
          throw new AggregateError([transactionError, releaseError], `artifact transaction failed and its publication lock could not be released: ${lock.path}`);
        }
        throw releaseError;
      }
    }
  }
}
