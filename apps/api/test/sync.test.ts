import { describe, expect, it } from "vitest";
import { answers, assignment, type Assignment, type Decision } from "@gg/shared";
import { selectAnalyzer } from "../src/analyzer";
import { createApp } from "../src/app";
import { Store } from "../src/store";
import { placeholderRubric } from "../src/sync";
import { fakeLms } from "./fake-lms";

const T1 = "t-demo";
const T2 = "t-second";
const LMS_ID = "lms-a-haber";

function setup(opts: Parameters<typeof fakeLms>[0] = {}) {
  // No answers seeded: they have to come from the LMS.
  const store = new Store(undefined, { withAnswers: false });
  const lms = fakeLms(opts);
  const app = createApp({ analyzer: selectAnalyzer({ GG_MOCK: "1", NODE_ENV: "test" }), store, lms: lms.adapter });
  const hdr = (t: string) => ({ "content-type": "application/json", "x-teacher-id": t });
  const post = (path: string, body: unknown, t = T1) => app.request(path, { method: "POST", headers: hdr(t), body: JSON.stringify(body) });
  const get = (path: string, t = T1) => app.request(path, { headers: hdr(t) });
  return { app, store, lms, post, get };
}

function grade(answerId: string, points: number, comment = "", at = 1): Decision {
  const a = answers.find((x) => x.id === answerId)!;
  return {
    id: `${answerId}:grade`,
    assignmentId: assignment.id,
    questionId: a.questionId,
    answerId,
    studentId: a.studentId,
    studentIndex: a.studentIndex,
    studentName: a.studentName,
    points,
    maxPoints: 30,
    suggestedPoints: null,
    missingConcepts: [],
    comment,
    at,
  };
}

describe("pull", () => {
  it("lists what the LMS has available", async () => {
    const { get } = setup();
    const list = await (await get("/sync/available")).json();
    expect(list).toEqual([{ lmsId: LMS_ID, courseName: assignment.course, title: assignment.title, questionCount: 2 }]);
  });

  it("brings in questions, the roster and every answer, without touching rubrics already written", async () => {
    const { post, get } = setup();
    expect(await (await get(`/assignments/${assignment.id}/answers`)).json()).toEqual([]);

    const res = await post("/sync/pull", { lmsAssignmentId: LMS_ID });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The seeded assignment is already linked, so this pull attaches to it rather than creating a copy.
    expect(body.assignment.id).toBe(assignment.id);
    expect(body.questions).toEqual({ created: 0, updated: 0 });
    expect(body.answers).toEqual({ created: 20, updated: 0, unchanged: 0, skipped: 0 });

    const pulled = (await (await get(`/assignments/${assignment.id}`)).json()) as Assignment;
    expect(pulled.questions[0]!.rubric.criteria).toHaveLength(6);
    expect(pulled.lastPulledAt).toBeGreaterThan(0);

    const list = await (await get(`/assignments/${assignment.id}/answers?questionId=q-haber-1`)).json();
    expect(list).toHaveLength(15);
    // Pulled answers keep the LMS id as their local id, so ground truth and analysis still line up.
    expect(list[3]).toMatchObject({ id: "sub-04", studentId: "stu-04", studentIndex: 4, studentName: "Daniel Okafor", lmsAnswerId: "sub-04" });
  });

  it("is idempotent: a second pull creates nothing and keeps local ids", async () => {
    const { post, get } = setup();
    await post("/sync/pull", { lmsAssignmentId: LMS_ID });
    const before = await (await get(`/assignments/${assignment.id}/answers`)).json();
    const assignmentsBefore = (await (await get("/assignments")).json()).length;
    const second = await (await post("/sync/pull", { lmsAssignmentId: LMS_ID })).json();
    expect(second.answers).toEqual({ created: 0, updated: 0, unchanged: 20, skipped: 0 });
    expect(await (await get(`/assignments/${assignment.id}/answers`)).json()).toEqual(
      before.map((a: { pulledAt: number }) => ({ ...a, pulledAt: expect.any(Number) })),
    );
    expect((await (await get("/assignments")).json()).length).toBe(assignmentsBefore);
  });

  it("does not invalidate cached prompts when nothing about the questions changed", async () => {
    const { post, get } = setup();
    const first = (await (await post("/sync/pull", { lmsAssignmentId: LMS_ID })).json()).assignment as Assignment;
    const again = (await (await get(`/assignments/${assignment.id}`)).json()) as Assignment;
    await post("/sync/pull", { lmsAssignmentId: LMS_ID });
    const after = (await (await get(`/assignments/${assignment.id}`)).json()) as Assignment;
    expect(after.updatedAt).toBe(first.updatedAt);
    expect(after.updatedAt).toBe(again.updatedAt);
  });

  it("updates a resubmitted answer in place, keeping its grade attached", async () => {
    const { post, get, lms } = setup();
    await post("/sync/pull", { lmsAssignmentId: LMS_ID });
    await post("/decision", { decision: grade("sub-04", 20) });

    lms.resubmit("sub-04", "A revised essay that now explains reversibility.");
    const res = await (await post("/sync/pull", { lmsAssignmentId: LMS_ID })).json();
    expect(res.answers.updated).toBe(1);

    const list = await (await get(`/assignments/${assignment.id}/answers?questionId=q-haber-1`)).json();
    expect(list.find((a: { id: string }) => a.id === "sub-04").text).toMatch(/revised essay/);
    const session = await (await get(`/session/${assignment.id}`)).json();
    expect(session.decisions.map((d: Decision) => d.answerId)).toEqual(["sub-04"]);
  });

  it("creates a new assignment with placeholder rubrics for an LMS assignment it has never seen", async () => {
    // Teacher 2 has no linked copy of the Haber assignment, so their pull creates one.
    const { post, get } = setup();
    const res = await post("/sync/pull", { lmsAssignmentId: LMS_ID }, T2);
    const body = await res.json();
    expect(body.questions).toEqual({ created: 2, updated: 0 });
    const created = body.assignment as Assignment;
    expect(created.id).not.toBe(assignment.id);
    expect(created.teacherId).toBe(T2);
    expect(created.questions[0]!.rubric.criteria[0]!.id).toBe("overall");
    expect(created.questions[0]!.rubric.criteria[0]!.maxPoints).toBe(30);
    // Teacher 1 still cannot see it.
    expect((await get(`/assignments/${created.id}`)).status).toBe(404);
  });

  it("reports an unknown LMS assignment as a failed LMS call", async () => {
    const { post } = setup();
    const res = await post("/sync/pull", { lmsAssignmentId: "nope" });
    expect(res.status).toBe(502);
    expect((await res.json()).retryable).toBe(false);
  });
});

describe("placeholderRubric", () => {
  it("is one valid criterion on the question's scale", () => {
    const r = placeholderRubric(15);
    expect(r.criteria).toHaveLength(1);
    expect(r.criteria[0]!.bands.map((b) => b.points)).toEqual([15, 10.5, 6, 0]);
  });
});

describe("push", () => {
  async function graded(opts: Parameters<typeof fakeLms>[0] = {}) {
    const ctx = setup(opts);
    await ctx.post("/sync/pull", { lmsAssignmentId: LMS_ID });
    await ctx.post("/decision", { decision: grade("sub-04", 20, "Explain reversibility.") });
    await ctx.post("/decision", { decision: grade("sub-11", 22) });
    return ctx;
  }

  it("never happens on grade submit: the LMS holds nothing until the teacher pushes", async () => {
    const { lms, get } = await graded();
    expect(lms.pushCalls).toEqual([]);
    expect(lms.grades.size).toBe(0);
    const status = await (await get(`/sync/status/${assignment.id}`)).json();
    expect(status).toMatchObject({ linked: true, answers: 20, graded: 2, pushed: 0, pending: 2, failed: 0 });
  });

  it("sends every pending grade, with its comment, in one bulk call", async () => {
    const { lms, post } = await graded();
    const res = await (await post("/sync/push", { assignmentId: assignment.id })).json();
    expect(res.pushed).toHaveLength(2);
    expect(res.summary).toEqual({ graded: 2, pushed: 2, pending: 0, failed: 0 });
    expect(lms.pushCalls).toHaveLength(1);
    expect(lms.grades.get("lms-q-haber-1|stu-04")).toMatchObject({ points: 20, comment: "Explain reversibility." });
  });

  it("is idempotent: pushing again sends nothing", async () => {
    const { lms, post } = await graded();
    await post("/sync/push", { assignmentId: assignment.id });
    const again = await (await post("/sync/push", { assignmentId: assignment.id })).json();
    expect(again.pushed).toEqual([]);
    expect(lms.pushCalls).toHaveLength(1);
  });

  it("re-sends only the answer that was re-graded, and the LMS keeps one grade per cell", async () => {
    const { lms, post } = await graded();
    await post("/sync/push", { assignmentId: assignment.id });
    await post("/decision", { decision: grade("sub-11", 18, "", 5) });
    const res = await (await post("/sync/push", { assignmentId: assignment.id })).json();
    expect(res.pushed.map((p: { answerId: string }) => p.answerId)).toEqual(["sub-11"]);
    expect(lms.pushCalls[1]).toHaveLength(1);
    expect(lms.grades.get("lms-q-haber-1|stu-11")?.points).toBe(18);
    expect(lms.grades.size).toBe(2);
  });

  it("can be narrowed to specific answers", async () => {
    const { post } = await graded();
    const res = await (await post("/sync/push", { assignmentId: assignment.id, answerIds: ["sub-11"] })).json();
    expect(res.pushed.map((p: { answerId: string }) => p.answerId)).toEqual(["sub-11"]);
    expect(res.summary.pending).toBe(1);
  });

  it("records per-grade rejections as failed and leaves them pending for retry", async () => {
    const { post, get } = await graded({ rejectRefs: ["sub-11:22"] });
    const res = await (await post("/sync/push", { assignmentId: assignment.id })).json();
    expect(res.pushed).toHaveLength(1);
    expect(res.failed).toMatchObject([{ answerId: "sub-11", status: "failed", error: "Student is not enrolled." }]);
    const status = await (await get(`/sync/status/${assignment.id}`)).json();
    expect(status).toMatchObject({ pushed: 1, pending: 1, failed: 1 });
  });

  it("marks everything failed when the LMS is down, surfaces a retryable 502, and keeps the grades", async () => {
    const { post, get } = await graded({ failPush: true });
    const res = await post("/sync/push", { assignmentId: assignment.id });
    expect(res.status).toBe(502);
    expect((await res.json()).retryable).toBe(true);
    const status = await (await get(`/sync/status/${assignment.id}`)).json();
    expect(status).toMatchObject({ graded: 2, pushed: 0, pending: 2, failed: 2 });
  });

  it("refuses to push an assignment that is not linked to an LMS", async () => {
    const { store, post } = setup();
    const local = store.createAssignment({ ...assignment, id: "a-local", lmsAssignmentId: "" });
    const res = await post("/sync/push", { assignmentId: local.id });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not linked/);
  });

  it("keeps another teacher out", async () => {
    const { post, get } = await graded();
    expect((await post("/sync/push", { assignmentId: assignment.id }, T2)).status).toBe(404);
    expect((await get(`/sync/status/${assignment.id}`, T2)).status).toBe(404);
  });
});
