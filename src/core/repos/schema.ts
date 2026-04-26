import { z } from "zod";

const nonEmptyString = z.string().min(1);

export const repoAddInputSchema = z
  .object({
    repo_id: nonEmptyString,
    repo_url: nonEmptyString,
    base_branch: nonEmptyString,
    package_manager: nonEmptyString,
    install_cmd: nonEmptyString,
    test_cmd: nonEmptyString.optional(),
    ci_workflow_name: nonEmptyString.optional(),
    contribution_guide_path: nonEmptyString.optional(),
  })
  .strict();

export type RepoAddInput = z.infer<typeof repoAddInputSchema>;

export const repoUpdateInputSchema = z
  .object({
    repo_url: nonEmptyString.optional(),
    base_branch: nonEmptyString.optional(),
    package_manager: nonEmptyString.optional(),
    install_cmd: nonEmptyString.optional(),
    test_cmd: nonEmptyString.nullable().optional(),
    ci_workflow_name: nonEmptyString.nullable().optional(),
    contribution_guide_path: nonEmptyString.nullable().optional(),
  })
  .strict();

export type RepoUpdateInput = z.infer<typeof repoUpdateInputSchema>;
