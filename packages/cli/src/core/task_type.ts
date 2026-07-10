export const TASK_TYPES = ["bugfix", "feature", "chore", "refactor"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && TASK_TYPES.includes(value as TaskType);
}

export function inferTaskType(input: {
  title: string;
  body: string;
  tags: readonly string[];
}): TaskType {
  const tags = input.tags.map((tag) => tag.toLowerCase());
  const text = `${input.title}\n${input.body}`.toLowerCase();

  if (
    tags.some((tag) => tag === "bug" || tag === "bugfix" || tag === "tasktype-bugfix") ||
    /\b(bug|bugfix|fix|fixes|fixed|hotfix|regression|broken|crash|error|incorrect|failing|failure)\b/.test(text)
  ) {
    return "bugfix";
  }
  if (
    tags.some((tag) => tag === "refactor" || tag === "tasktype-refactor") ||
    /\b(refactor|cleanup|rework|restructure)\b/.test(text)
  ) {
    return "refactor";
  }
  if (
    tags.some((tag) => tag === "chore" || tag === "tasktype-chore") ||
    /\b(chore|maintenance|docs|documentation|ci|build|deps|dependency|dependencies|upgrade|bump)\b/.test(text)
  ) {
    return "chore";
  }
  return "feature";
}
