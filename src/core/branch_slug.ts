// Branch-slug normalization per quay-spec.md §13.
//
// Two outputs are derived from one external_ref:
//   - branch slug: must satisfy `git check-ref-format refs/heads/quay/<slug>`.
//   - tmux id: stricter charset, always suffixed with -<task_id_short>.

const GIT_REF_INVALID = /[\x00-\x1f\x7f ~^:?*[\\]/;

export const QUAY_BRANCH_PREFIX = "quay/";

export function taskIdShort(taskId: string): string {
  const stripped = taskId.replace(/-/g, "");
  return stripped.slice(0, 8);
}

function normalizeComponent(comp: string): string {
  let c = comp.replace(/^[.\-]+/, "").replace(/[.\-]+$/, "");
  if (c.endsWith(".lock")) {
    c = c.slice(0, -5).replace(/[.\-]+$/, "");
  }
  return c;
}

function applyComponentRules(s: string): string {
  const components = s
    .split("/")
    .map(normalizeComponent)
    .filter((c) => c.length > 0);
  return components.join("/");
}

export function isValidGitRef(slug: string): boolean {
  if (slug === "") return false;
  if (slug.includes("..")) return false;
  if (GIT_REF_INVALID.test(slug)) return false;
  if (slug.startsWith("/") || slug.endsWith("/")) return false;
  for (const c of slug.split("/")) {
    if (c === "") return false;
    if (c.startsWith(".")) return false;
    if (c.endsWith(".")) return false;
    if (c.endsWith(".lock")) return false;
  }
  return true;
}

export function computeBranchSlug(
  externalRef: string | null | undefined,
  taskIdShortValue: string,
): string {
  const fallback = `task-${taskIdShortValue}`;
  if (externalRef === null || externalRef === undefined || externalRef === "") {
    return fallback;
  }

  // Step 1: char substitution.
  let s = externalRef.replace(/[^A-Za-z0-9._/-]/g, "-");
  // Step 2: collapse runs.
  s = s.replace(/\/+/g, "/").replace(/\.+/g, ".").replace(/-+/g, "-");
  // Step 3: per-component normalization.
  s = applyComponentRules(s);
  // Step 4: strip leading/trailing /.
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  // Step 5: truncate to 64 chars and re-run step 3 if we landed badly.
  if (s.length > 64) {
    s = s.slice(0, 64);
    if (/[/.\-]$/.test(s) || s.includes(".lock")) {
      s = applyComponentRules(s).replace(/^\/+/, "").replace(/\/+$/, "");
    }
  }
  // Step 6: empty fallback.
  if (s === "") return fallback;
  // Step 7: final ref-format gate.
  if (!isValidGitRef(`${QUAY_BRANCH_PREFIX}${s}`)) return fallback;
  return s;
}

export function computeTmuxIdHumanPart(externalRef: string | null | undefined): string {
  if (externalRef === null || externalRef === undefined || externalRef === "") {
    return "task";
  }
  let s = externalRef.replace(/[^A-Za-z0-9_-]/g, "-");
  s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 38) {
    s = s.slice(0, 38).replace(/-+$/, "");
  }
  if (s === "") return "task";
  return s;
}

export function computeTmuxId(
  externalRef: string | null | undefined,
  taskIdShortValue: string,
): string {
  return `${computeTmuxIdHumanPart(externalRef)}-${taskIdShortValue}`;
}
