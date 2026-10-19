import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
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

/**
 * `Atom.family` keys on its argument, and members arrays are usually rebuilt
 * every render, so the members are folded into one string: the derived atom
 * (and therefore the subscription set) stays stable across renders. Workspace
 * roots and entity ids never contain these control characters.
 */
const MEMBER_FIELD_DELIMITER = "\u0000";
const MEMBER_DELIMITER = "\u0001";

const workspaceDriftMembersKey = (members: ReadonlyArray<WorkspaceDriftWatchedMember>): string =>
  members
    .map((member) =>
      [member.environmentId, member.projectId, member.workspaceRoot].join(MEMBER_FIELD_DELIMITER),
    )
    .join(MEMBER_DELIMITER);

const parseWorkspaceDriftMembersKey = (key: string): ReadonlyArray<WorkspaceDriftWatchedMember> =>
  key === ""
    ? []
    : key.split(MEMBER_DELIMITER).map((entry) => {
        const [environmentId = "", projectId = "", workspaceRoot = ""] =
          entry.split(MEMBER_FIELD_DELIMITER);
        return {
          environmentId: EnvironmentId.make(environmentId),
          projectId: ProjectId.make(projectId),
          workspaceRoot,
        };
      });

const workspaceDriftVerdictAtom = Atom.family((membersKey: string) => {
  const members = parseWorkspaceDriftMembersKey(membersKey);
  return Atom.make((get): WorkspaceDriftVerdict | null => {
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
  return useAtomValue(workspaceDriftVerdictAtom(workspaceDriftMembersKey(members)));
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
