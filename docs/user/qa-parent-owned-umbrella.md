# Parent-Owned Umbrella QA Matrix

Use this matrix when validating Quay against a deployed Linear workspace and a
test repository. Each scenario assumes the test repo is registered in Quay and
the Linear issues contain valid ordinary `quay-config` blocks with `repo`,
`tags`, and `authors`.

## Blocked-By Dependencies

| Scenario | Setup | Expected result |
| --- | --- | --- |
| Complete blocker | Issue B is blocked by issue A, and A is already complete in Linear. | Enqueueing B succeeds as a normal task. The ticket snapshot records A, but no blocking dependency row is created. |
| Incomplete tracked blocker | A has an existing Quay task that is not merged. B is blocked by A. | Enqueueing B creates a task in `waiting_dependencies` with a dependency on A requiring `merged`. |
| Incomplete untracked blocker | B is blocked by A, A is incomplete in Linear, and A has no Quay task. | Enqueueing B fails with `dependency_not_tracked` before creating a task, worktree, or artifact. |

## Parent-Owned Umbrella Enqueue

| Scenario | Setup | Expected result |
| --- | --- | --- |
| Parent with incomplete children | Parent P has children C1 and C2, both incomplete. | Enqueueing P creates or verifies the umbrella feature branch, persists the expected child rows, and materializes C1/C2 as Quay tasks targeting the feature branch. No parent worker task is spawned. |
| Parent with completed child | Parent P has child C1 complete in Linear and child C2 incomplete. | Enqueueing P marks C1 `complete_without_quay` and materializes only C2 as a Quay task. |
| Same-umbrella child ordering | Parent P has children C1 and C2, and C2 is blocked by C1. | Enqueueing P materializes both tasks and creates an umbrella-scoped dependency from C2 to C1 requiring `merged_to_feature_branch`. |
| External blocker inside umbrella child | Child C1 is blocked by issue A outside the umbrella. | If A is tracked, C1 waits for A with normal `merged` semantics. If A is incomplete and untracked, parent enqueue fails before side effects. |
| Umbrella dependency cycle | Children C1 and C2 block each other through Linear blocked-by relations. | Parent enqueue fails with `umbrella_dependency_cycle` before creating child tasks or worktrees. |

## Direct Child Enqueue

| Scenario | Setup | Expected result |
| --- | --- | --- |
| Child before parent | Child C1 has parent P, but P has not been enqueued. | Direct enqueue of C1 fails with `umbrella_child_direct_enqueue`. |
| Child after parent | Parent P has already materialized C1 as a Quay task. | Direct enqueue of C1 still fails with `umbrella_child_direct_enqueue`; existing child tasks must not bypass the guard. |
| Child override | C1 has parent P, and the operator passes `--as-normal-task`. | C1 is processed as a normal task, with no umbrella task link. Linear blocked-by relations still become normal dependencies. |

## PR Lifecycle

| Scenario | Setup | Expected result |
| --- | --- | --- |
| Approved subtask PR | A materialized child task opens a PR into the umbrella feature branch and receives approval with green CI. | Quay may merge the child PR into the umbrella feature branch and mark the child `merged_to_feature_branch`. |
| Final umbrella PR | All expected children are either `merged_to_feature_branch` or `complete_without_quay`. | Tick creates or reuses the final umbrella PR from the feature branch into the parent base branch, with a title/body based on the parent issue and links to subtasks. |
| Final PR merge authority | The final umbrella PR is approved and green. | Quay must not merge the final PR. A human merges it; Quay only observes the merge and marks the umbrella workflow complete. |

For every scenario, capture the Linear issue identifiers, task ids, PR numbers,
and the relevant `quay task get --json` output so regressions can be compared
without relying on transient UI state.
