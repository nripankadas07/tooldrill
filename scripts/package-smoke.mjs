import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageName = packageJson.name;
const binName = Object.keys(packageJson.bin ?? {})[0];
if (typeof packageName !== "string" || typeof binName !== "string") throw new Error("package name and bin are required");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
}

const temporary = await mkdtemp(join(tmpdir(), `${packageName}-package-smoke-`));
try {
  run(npm, ["pack", "--pack-destination", temporary, "--silent"], process.cwd());
  const archives = (await readdir(temporary)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1 || archives[0] === undefined) throw new Error("npm pack did not produce exactly one archive");
  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  run(npm, ["install", join(temporary, archives[0]), "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
  run(process.execPath, ["--input-type=module", "-e", `const loaded=await import(${JSON.stringify(packageName)}); if(Object.keys(loaded).length===0) process.exit(3)`], consumer);
  const executable = join(consumer, "node_modules", ".bin", process.platform === "win32" ? `${binName}.cmd` : binName);
  run(executable, ["--help"], consumer);
  console.log(JSON.stringify({ package: packageName, archive: archives[0], import: "ok", cli: "ok" }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
