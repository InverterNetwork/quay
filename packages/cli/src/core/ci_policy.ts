import type { QuayConfig } from "../cli/config.ts";

export type CiIgnoreMode = "inherit" | "extend" | "replace";

export interface CiIgnorePolicy {
  ignoredCheckNames: string[];
  ignoredWorkflowNames: string[];
}

export interface RepoCiIgnorePolicy {
  ci_ignore_mode: CiIgnoreMode;
  ignored_check_names: string[];
  ignored_workflow_names: string[];
}

export const EMPTY_CI_IGNORE_POLICY: CiIgnorePolicy = {
  ignoredCheckNames: [],
  ignoredWorkflowNames: [],
};

export function normalizeCiIgnoreName(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeCiIgnoreNames(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(normalizeCiIgnoreName))).filter(
    (value) => value !== "",
  );
}

export function ciPolicyFromConfig(config: QuayConfig): CiIgnorePolicy {
  return {
    ignoredCheckNames: normalizeCiIgnoreNames(config.ci?.ignored_check_names ?? []),
    ignoredWorkflowNames: normalizeCiIgnoreNames(
      config.ci?.ignored_workflow_names ?? [],
    ),
  };
}

export function resolveCiIgnorePolicy(
  global: CiIgnorePolicy,
  repo: RepoCiIgnorePolicy | null | undefined,
): CiIgnorePolicy {
  if (repo === null || repo === undefined || repo.ci_ignore_mode === "inherit") {
    return {
      ignoredCheckNames: [...global.ignoredCheckNames],
      ignoredWorkflowNames: [...global.ignoredWorkflowNames],
    };
  }

  const local: CiIgnorePolicy = {
    ignoredCheckNames: normalizeCiIgnoreNames(repo.ignored_check_names),
    ignoredWorkflowNames: normalizeCiIgnoreNames(repo.ignored_workflow_names),
  };
  if (repo.ci_ignore_mode === "replace") return local;
  return {
    ignoredCheckNames: normalizeCiIgnoreNames([
      ...global.ignoredCheckNames,
      ...local.ignoredCheckNames,
    ]),
    ignoredWorkflowNames: normalizeCiIgnoreNames([
      ...global.ignoredWorkflowNames,
      ...local.ignoredWorkflowNames,
    ]),
  };
}

export function parseCiIgnoreListJson(value: string | null): string[] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}
