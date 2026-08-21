import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  computeWorkspaceDrift,
  type WorkspaceDriftMemberStatus,
  type WorkspaceDriftVerdict,
} from "@t3tools/client-runtime/state/workspace-drift";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { vcsEnvironment } from "./vcs";

/** One clone of a logical project whose checkout should be compared to its siblings. */
export interface WorkspaceDriftWatchedMember {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

/**
 * Cross-environment drift verdict for one logical project group, or null while
 * any member's status has not been observed yet (callers treat null like
 * "unknown" and stay quiet — never warn off partial data).
 */
export function useWorkspaceDriftVerdict(
  members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }>,
): WorkspaceDriftVerdict | null {
  // Members arrays are usually rebuilt every render; the key keeps the derived
  // atom (and therefore the subscription set) stable across them.
  const membersKey = JSON.stringify(members);
  const verdictAtom = useMemo(
    () =>
      Atom.make((get): WorkspaceDriftVerdict | null => {
        const statuses = members.map((member): WorkspaceDriftMemberStatus => {
          const result = get(
            vcsEnvironment.status({
              environmentId: member.environmentId,
              input: { cwd: member.workspaceRoot },
            }),
          );
          return {
            environmentId: member.environmentId,
            projectId: member.projectId,
            status: Option.getOrNull(AsyncResult.value(result)),
          };
        });
        return statuses.some((member) => member.status === null)
          ? null
          : computeWorkspaceDrift(statuses);
      }).pipe(Atom.withLabel(`web:workspace-drift:${membersKey}`)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- membersKey fully determines members
    [membersKey],
  );
  return useAtomValue(verdictAtom);
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
