import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";

export type ReferenceRepoPromptAudience = "worker" | "reviewer";

export interface ReferenceRepo {
  name: string;
  path: string;
}

export interface ReferenceReposContext {
  root: string;
  repos: ReferenceRepo[];
}

export function discoverReferenceRepos(
  root: string | undefined,
): ReferenceReposContext | null {
  if (root === undefined || root.trim() === "") return null;
  const resolvedRoot = resolve(root);
  let entries: Dirent[];
  try {
    const rootStat = statSync(resolvedRoot);
    if (!rootStat.isDirectory()) return null;
    entries = readdirSync(resolvedRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const repos: ReferenceRepo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = join(resolvedRoot, entry.name);
    if (!isWorkingTreeRepo(childPath)) continue;
    repos.push({ name: entry.name, path: childPath });
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return { root: resolvedRoot, repos };
}

export function renderReferenceReposPrompt(
  root: string | undefined,
  audience: ReferenceRepoPromptAudience,
): string | null {
  const context = discoverReferenceRepos(root);
  if (context === null) return null;

  const lines = [
    `<quay-reference-repos root="${escapeAttr(context.root)}">`,
    audience === "worker"
      ? "Hermes keeps read-only reference checkouts here. You may inspect these repos when the task references cross-repo behavior or when doing so helps understand APIs/contracts."
      : "Hermes keeps read-only reference checkouts here. You may inspect these repos only as review context when the PR references cross-repo behavior or when doing so helps verify APIs/contracts.",
    "",
    "Available reference repos:",
  ];

  if (context.repos.length === 0) {
    lines.push("- (none discovered)");
  } else {
    for (const repo of context.repos) {
      lines.push(`- ${escapeXmlText(repo.name)}: ${escapeXmlText(repo.path)}`);
    }
  }

  lines.push("", "Rules:");
  if (audience === "worker") {
    lines.push(
      "- Treat these repos as read-only context.",
      "- Do not edit, commit, branch, or push from these directories.",
      "- Only modify the Quay task worktree.",
      "- If the task requires changes in another repo, write a blocker or note that a separate task is needed.",
    );
  } else {
    lines.push(
      "- Treat these repos as read-only context.",
      "- Do not modify code or git state in these directories.",
      "- Only inspect them to understand cross-repo APIs/contracts.",
      "- Keep findings focused on the PR under review unless cross-repo context proves the PR breaks a contract.",
    );
  }
  lines.push("</quay-reference-repos>");
  return lines.join("\n");
}

function isWorkingTreeRepo(path: string): boolean {
  try {
    const gitPath = join(path, ".git");
    const gitStat = statSync(gitPath);
    return gitStat.isDirectory() || gitStat.isFile();
  } catch {
    return false;
  }
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
