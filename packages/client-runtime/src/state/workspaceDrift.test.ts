import { EnvironmentId, ProjectId, type VcsStatusLocalResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { computeWorkspaceDrift, type WorkspaceDriftMemberStatus } from "./workspaceDrift.ts";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");

function makeStatus(overrides: Partial<VcsStatusLocalResult> = {}): VcsStatusLocalResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    headOid: "abc1234",
    ...overrides,
  };
}

function member(
  environmentId: EnvironmentId,
  index: number,
  status: VcsStatusLocalResult | null = makeStatus(),
): WorkspaceDriftMemberStatus {
  return { environmentId, projectId: ProjectId.make(`${environmentId}-project-${index}`), status };
}

function memberIds(members: ReadonlyArray<WorkspaceDriftMemberStatus>) {
  return members.map(({ environmentId, projectId }) => ({ environmentId, projectId }));
}

describe("computeWorkspaceDrift", () => {
  it("reports not-applicable for a single-member group", () => {
    expect(computeWorkspaceDrift([member(environmentA, 0)])).toEqual({
      kind: "not-applicable",
    });
  });

  it("reports not-applicable when fewer than two members are git repos", () => {
    const members = [
      member(environmentA, 0, makeStatus({ isRepo: false, refName: null })),
      member(environmentB, 1, makeStatus({ isRepo: false, refName: null })),
    ];
    expect(computeWorkspaceDrift(members)).toEqual({ kind: "not-applicable" });
  });

  it("reports not-applicable when only one of several members is a git repo", () => {
    const members = [
      member(environmentA, 0),
      member(environmentB, 1, makeStatus({ isRepo: false, refName: null })),
      member(environmentB, 2, makeStatus({ isRepo: false, refName: null })),
    ];
    expect(computeWorkspaceDrift(members)).toEqual({ kind: "not-applicable" });
  });

  it("never warns off partial data: one unobserved member makes the verdict unknown", () => {
    const members = [member(environmentA, 0, null), member(environmentB, 1)];
    expect(computeWorkspaceDrift(members)).toEqual({ kind: "unknown" });
  });

  it("unknown wins even when the observed members would diverge", () => {
    const members = [
      member(environmentA, 0, makeStatus({ refName: "feature", headOid: "aaa" })),
      member(environmentB, 1, null),
      member(environmentB, 2, makeStatus({ refName: "main", headOid: "bbb" })),
    ];
    expect(computeWorkspaceDrift(members)).toEqual({ kind: "unknown" });
  });

  it("reports in-sync when every repo member shares branch, commit, and cleanliness", () => {
    const members = [
      member(environmentA, 0, makeStatus({ headOid: "abc1234" })),
      member(environmentB, 1, makeStatus({ headOid: "abc1234" })),
    ];
    expect(computeWorkspaceDrift(members)).toEqual({ kind: "in-sync" });
  });

  it("reports diverged when members sit on different commits of the same branch", () => {
    const members = [
      member(environmentA, 0, makeStatus({ headOid: "aaa" })),
      member(environmentB, 1, makeStatus({ headOid: "bbb" })),
    ];
    const first = members[0];
    const second = members[1];
    if (!first || !second) throw new Error("unreachable: two members were declared");
    expect(computeWorkspaceDrift(members)).toEqual({
      kind: "diverged",
      heads: [
        {
          environmentId: environmentA,
          projectId: first.projectId,
          refName: "main",
          headOid: "aaa",
        },
        {
          environmentId: environmentB,
          projectId: second.projectId,
          refName: "main",
          headOid: "bbb",
        },
      ],
      dirtyMembers: [],
    });
  });

  it("reports diverged when members sit on different branches", () => {
    const members = [
      member(environmentA, 0, makeStatus({ refName: "main", headOid: "aaa" })),
      member(environmentB, 1, makeStatus({ refName: "feature", headOid: "aaa" })),
    ];
    const first = members[0];
    const second = members[1];
    if (!first || !second) throw new Error("unreachable: two members were declared");
    expect(computeWorkspaceDrift(members)).toEqual({
      kind: "diverged",
      heads: [
        {
          environmentId: environmentA,
          projectId: first.projectId,
          refName: "main",
          headOid: "aaa",
        },
        {
          environmentId: environmentB,
          projectId: second.projectId,
          refName: "feature",
          headOid: "aaa",
        },
      ],
      dirtyMembers: [],
    });
  });

  it("reports diverged by cleanliness when heads match but only some members are dirty", () => {
    const members = [
      member(environmentA, 0, makeStatus({ headOid: "abc1234", hasWorkingTreeChanges: true })),
      member(environmentB, 1, makeStatus({ headOid: "abc1234" })),
    ];
    const first = members[0];
    if (!first) throw new Error("unreachable: one member was declared");
    expect(computeWorkspaceDrift(members)).toEqual({
      kind: "diverged",
      heads: [
        {
          environmentId: environmentA,
          projectId: first.projectId,
          refName: "main",
          headOid: "abc1234",
        },
      ],
      dirtyMembers: memberIds([first]),
    });
  });

  it("treats two old-server members with absent headOid on the same clean branch as in-sync", () => {
    const members = [
      member(environmentA, 0, makeStatus({ headOid: undefined })),
      member(environmentB, 1, makeStatus({ headOid: undefined })),
    ];
    expect(computeWorkspaceDrift(members)).toEqual({ kind: "in-sync" });
  });

  it("falls back to cleanliness when old-server members with absent headOid differ in dirtiness", () => {
    const members = [
      member(environmentA, 0, makeStatus({ headOid: undefined, hasWorkingTreeChanges: true })),
      member(environmentB, 1, makeStatus({ headOid: undefined })),
    ];
    const first = members[0];
    if (!first) throw new Error("unreachable: one member was declared");
    expect(computeWorkspaceDrift(members)).toEqual({
      kind: "diverged",
      heads: [
        {
          environmentId: environmentA,
          projectId: first.projectId,
          refName: "main",
          headOid: undefined,
        },
      ],
      dirtyMembers: memberIds([first]),
    });
  });

  it("never reports a head mismatch from mixed old/new servers on the same branch", () => {
    const members = [
      member(environmentA, 0, makeStatus({ headOid: undefined })),
      member(environmentB, 1, makeStatus({ headOid: "abc1234" })),
    ];
    expect(computeWorkspaceDrift(members)).toEqual({ kind: "in-sync" });
  });

  it("keeps unobserved commits distinct when known commits already disagree", () => {
    const members = [
      member(environmentA, 0, makeStatus({ headOid: "aaa" })),
      member(environmentB, 1, makeStatus({ headOid: "bbb" })),
      member(environmentB, 2, makeStatus({ headOid: undefined })),
    ];
    const verdict = computeWorkspaceDrift(members);
    expect(verdict.kind).toBe("diverged");
    if (verdict.kind !== "diverged") {
      return;
    }
    expect(verdict.heads.map(({ headOid }) => headOid)).toEqual(["aaa", "bbb", undefined]);
  });

  it("ignores non-git members when at least two repo members remain", () => {
    const members = [
      member(environmentA, 0, makeStatus({ isRepo: false, refName: null })),
      member(environmentB, 1),
      member(environmentB, 2, makeStatus({ headOid: "abc1234" })),
    ];
    expect(computeWorkspaceDrift(members)).toEqual({ kind: "in-sync" });
  });
});
