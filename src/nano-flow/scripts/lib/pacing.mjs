// note 状态推进的告警：active Plan 里还挂着 `pending` 的 note，
// 但工作区已经有它的未提交改动——说明正文改过而状态没跟上。
// 只看工作区（`git status`）而不是提交历史：流程是「写 → check → commit」，
// check 这一时点上提交还没发生。
import { spawnSync } from "node:child_process";
import path from "node:path";

import { addIssue, byteLength, relativePath } from "./base.mjs";

/** git 卡住（大仓、网络盘）时宁可放过，也不拖慢 check。 */
const GIT_TIMEOUT_MS = 2000;

/** 正文超过这个字节数才算“动过”：标题加空行的空壳不算开工。 */
const PACING_MIN_BODY_BYTES = 120;

/** 占位 note 是刚建的空壳，写它是建 note 的一部分。 */
const PACING_PLACEHOLDER = "占位";

/** 已跟踪文件的改动才算；新建（`??` / `A`）的 note 还没进入历史。 */
const isModification = (status) => {
  const [index, worktree] = status;
  if (index === "?" || index === "A") return false;
  return index === "M" || index === "R" || worktree === "M" || worktree === "R";
};

/**
 * 取工作区未提交的改动路径（相对 `rootDir`，正斜杠）。
 *
 * git 缺失、不在仓库里、命令失败、超时都返回 `null`——调用方据此静默跳过，
 * 不该因为环境没有 git 就让 check 变红。
 * @param rootDir - 工作区根。
 * @param domainsRelative - 只看这个子路径（相对 `rootDir`）。
 * @returns 脏路径集合，或 `null`。
 */
const collectDirtyPaths = (rootDir, domainsRelative) => {
  const top = spawnSync("git", ["-C", rootDir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  if (top.error !== undefined && top.error !== null) return null;
  if (top.status !== 0 || typeof top.stdout !== "string") return null;
  const repoRoot = top.stdout.trim();
  if (repoRoot === "") return null;
  const result = spawnSync(
    "git",
    [
      "-C",
      rootDir,
      "status",
      "--porcelain",
      "-z",
      "--",
      domainsRelative === "" ? "." : domainsRelative,
    ],
    { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error !== undefined && result.error !== null) return null;
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const dirty = new Set();
  const tokens = result.stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.length < 4) continue;
    const status = token.slice(0, 2);
    const renamed = /[RC]/u.test(status);
    // `-z` 下重命名/复制占两段：第二段是旧路径，跳过。
    if (renamed) index += 1;
    if (!isModification(status)) continue;
    dirty.add(relativePath(rootDir, path.resolve(repoRoot, token.slice(3))));
  }
  return dirty;
};

/**
 * 给「pending 但已经改过正文」的 note 报一条警告。
 * 只提醒，不改状态、不影响 `ok`、不写盘。
 * @param ctx - 校验上下文（warnings / rootDir）。
 * @param plan - `{ lifecycle, notes }`。
 * @param dirty - `collectDirtyPaths` 的结果，`null` 表示没有 git 信号。
 */
const pacingWarnings = (ctx, plan, dirty) => {
  if (dirty === null || plan.lifecycle !== "active") return;
  for (const note of plan.notes) {
    if (note.status !== "pending") continue;
    if (typeof note.description === "string" && note.description.startsWith(PACING_PLACEHOLDER)) {
      continue;
    }
    if (byteLength(note.body.trim()) <= PACING_MIN_BODY_BYTES) continue;
    if (!dirty.has(relativePath(ctx.rootDir, note.file))) continue;
    addIssue(
      ctx.warnings,
      ctx.rootDir,
      note.file,
      "pacing",
      "note 仍是 pending，但工作区有未提交改动；第一次改正文前应置 in_progress",
    );
  }
};

export { collectDirtyPaths, pacingWarnings };
