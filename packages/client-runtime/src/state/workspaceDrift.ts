import type { EnvironmentId, ProjectId, VcsStatusLocalResult } from "@t3tools/contracts";

/**
 * One logical-project clone whose drift is being compared. Consumers feed the
 * latest status received over subscribeVcsStatus for each member's workspace root.
 */
export interface WorkspaceDriftMemberStatus {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Latest known local status for the member's workspace root; null = not yet observed. */
  readonly status: VcsStatusLocalResult | null;
}

/**
 * Why a workspace group is or is not in sync. Absence of `headOid` (pre-headOid
 * servers) is treated as unknown, never as a mismatch signal by itself.
 */
export type WorkspaceDriftVerdict =
  | { readonly kind: "not-applicable" } // fewer than two git-repo members
  | { readonly kind: "unknown" } // at least one member unobserved — never warn off partial data
  | { readonly kind: "in-sync" }
  | {
      readonly kind: "diverged";
      /** One entry per distinct (refName, headOid) signature among repo members. */
      readonly heads: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
        readonly refName: string | null;
        readonly headOid: string | undefined;
      }>;
      readonly dirtyMembers: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
      }>;
    };

interface DriftMember {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly refName: string | null;
  readonly headOid: string | undefined;
  readonly dirty: boolean;
}

interface DriftSignature {
  readonly refName: string | null;
  readonly headOid: string | undefined;
  readonly members: ReadonlyArray<DriftMember>;
}

/**
 * Groups members of one branch into commit signatures. An absent headOid folds
 * into the branch's single known commit when there is exactly one (presence
 * beats absence), so an old server never manufactures a head mismatch; several
 * distinct known commits stay separate and unobserved members keep their own
 * signature rather than being pinned to a commit they never reported.
 */
function signaturesForRef(members: ReadonlyArray<DriftMember>): Array<DriftSignature> {
  const knownOids = [
    ...new Set(members.flatMap((member) => (member.headOid === undefined ? [] : [member.headOid]))),
  ];
  const refName = members[0]?.refName ?? null;
  if (knownOids.length <= 1) {
    return [{ refName, headOid: knownOids[0], members }];
  }
  const signatures: Array<DriftSignature> = knownOids.map((headOid) => ({
    refName,
    headOid,
    members: members.filter((member) => member.headOid === headOid),
  }));
  const unobserved = members.filter((member) => member.headOid === undefined);
  if (unobserved.length > 0) {
    signatures.push({ refName, headOid: undefined, members: unobserved });
  }
  return signatures;
}

/**
 * Pure cross-environment drift comparison for one logical project group.
 * Members arrive in caller-defined order; output order follows it.
 */
export function computeWorkspaceDrift(
  members: ReadonlyArray<WorkspaceDriftMemberStatus>,
): WorkspaceDriftVerdict {
  if (members.length < 2) {
    return { kind: "not-applicable" };
  }
  if (members.some((member) => member.status === null)) {
    return { kind: "unknown" };
  }
  const repoMembers: Array<DriftMember> = [];
  for (const member of members) {
    const status = member.status;
    if (!status?.isRepo) {
      continue;
    }
    repoMembers.push({
      environmentId: member.environmentId,
      projectId: member.projectId,
      refName: status.refName,
      headOid: status.headOid,
      dirty: status.hasWorkingTreeChanges,
    });
  }
  if (repoMembers.length < 2) {
    return { kind: "not-applicable" };
  }

  const membersByRef = new Map<string, Array<DriftMember>>();
  for (const member of repoMembers) {
    const key = member.refName ?? "";
    const group = membersByRef.get(key);
    if (group) {
      group.push(member);
    } else {
      membersByRef.set(key, [member]);
    }
  }
  const signatures: Array<DriftSignature> = [];
  for (const group of membersByRef.values()) {
    signatures.push(...signaturesForRef(group));
  }

  const dirtyMembers = repoMembers.filter((member) => member.dirty);
  const hasCleanMembers = repoMembers.some((member) => !member.dirty);
  if (signatures.length > 1 || (dirtyMembers.length > 0 && hasCleanMembers)) {
    return {
      kind: "diverged",
      heads: signatures.flatMap((signature) => {
        const member = signature.members[0];
        if (member === undefined) return [];
        return [
          {
            environmentId: member.environmentId,
            projectId: member.projectId,
            refName: signature.refName,
            headOid: signature.headOid,
          },
        ];
      }),
      dirtyMembers: dirtyMembers.map(({ environmentId, projectId }) => ({
        environmentId,
        projectId,
      })),
    };
  }
  return { kind: "in-sync" };
}
