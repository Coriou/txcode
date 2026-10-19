import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  computeWorkspaceDrift,
  type WorkspaceDriftMemberStatus,
  type WorkspaceDriftVerdict,
} from "@t3tools/client-runtime/state/workspace-drift";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { vcsEnvironment } from "./vcs";

/** One clone of a logical project whose checkout should be compared to its siblings. */
export interface WorkspaceDriftWatchedMember {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

type WorkspaceDriftMemberKey = readonly [
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workspaceRoot: string,
];

// Members arrays are usually rebuilt every render; keying the family by their
// identifying fields keeps the derived atom (and its subscriptions) stable.
const workspaceDriftVerdictAtom = Atom.family((membersKey: string) => {
  const members = JSON.parse(membersKey) as ReadonlyArray<WorkspaceDriftMemberKey>;
  return Atom.make((get): WorkspaceDriftVerdict | null => {
    const statuses = members.map(([environmentId, projectId, workspaceRoot]) => {
      const result = get(vcsEnvironment.status({ environmentId, input: { cwd: workspaceRoot } }));
      return {
        environmentId,
        projectId,
        status: Option.getOrNull(AsyncResult.value(result)),
      } satisfies WorkspaceDriftMemberStatus;
    });
    return statuses.some((member) => member.status === null)
      ? null
      : computeWorkspaceDrift(statuses);
  }).pipe(Atom.withLabel(`web:workspace-drift:${membersKey}`));
});

/**
 * Cross-environment drift verdict for one logical project group, or null while
 * any member's status has not been observed yet (callers treat null like
 * "unknown" and stay quiet — never warn off partial data).
 */
export function useWorkspaceDriftVerdict(
  members: ReadonlyArray<WorkspaceDriftWatchedMember>,
): WorkspaceDriftVerdict | null {
  return useAtomValue(
    workspaceDriftVerdictAtom(
      JSON.stringify(
        members.map((member): WorkspaceDriftMemberKey => [
          member.environmentId,
          member.projectId,
          member.workspaceRoot,
        ]),
      ),
    ),
  );
}

const UNKNOWN_PREFERRED_COPY_LABEL = "your preferred copy";
const UNKNOWN_ENVIRONMENT_LABEL = "another environment";

/**
 * Warning copy for a diverged verdict, phrased against the group's preferred
 * copy. Returns null for anything that should not be surfaced (including
 * diverged verdicts with no distinguishable cause).
 */
export function describeWorkspaceDrift(input: {
  readonly verdict: WorkspaceDriftVerdict;
  /** Environment whose copy is the comparison baseline for the surface. */
  readonly preferredEnvironmentId: EnvironmentId;
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
}): string | null {
  const { verdict, resolveEnvironmentLabel } = input;
  if (verdict.kind !== "diverged") {
    return null;
  }
  if (verdict.heads.length > 1) {
    return `Differs from ${
      resolveEnvironmentLabel(input.preferredEnvironmentId) ?? UNKNOWN_PREFERRED_COPY_LABEL
    }: different branch or commit`;
  }
  if (verdict.dirtyMembers.length > 0) {
    const labels = [
      ...new Set(
        verdict.dirtyMembers.map(
          (member) => resolveEnvironmentLabel(member.environmentId) ?? UNKNOWN_ENVIRONMENT_LABEL,
        ),
      ),
    ];
    return `Uncommitted changes on ${labels.join(", ")}`;
  }
  return null;
}
