import { z } from "zod";
import { isValidGitRef } from "./branch_slug.ts";

export const BASE_BRANCH_ERROR =
  "base_branch must be a branch name like 'main', 'dev', or 'release/2026.05' (no refs/, origin/, spaces, '..', path traversal, or unsafe git ref characters)";

export function isValidBaseBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.length > 255) return false;
  if (branch === "@" || branch.includes("@{")) return false;
  if (branch.startsWith("refs/") || branch.startsWith("origin/")) return false;
  return isValidGitRef(branch);
}

export const baseBranchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isValidBaseBranchName, {
    message: BASE_BRANCH_ERROR,
  });
