import { describe, expect, it } from "vitest";
import { answers, assignment, englishAnswers, englishAssignment, type AnalysisResult, type Assignment, type Decision } from "@gg/shared";
import { selectAnalyzer } from "../src/analyzer";
import { createApp } from "../src/app";
import { SCHEMA_VERSION, Store } from "../src/store";

const T1 = "t-demo";
const T2 = "t-second";
const Q1 = "q-haber-1";
const Q2 = "q-haber-2";

function mkApp(store = new Store()) {
  return createApp({ analyzer: selectAnalyzer({ GG_MOCK: "1", NODE_ENV: "test" }), store });
}
type App = ReturnType<typeof mkApp>;

const ans = (id: string) => answers.find((a) => a.id === id)!;

/** A grade for one seeded answer. Ids are deterministic per answer, like the web app's. */
function decision(answerId: string, points: number, missing: string[], suggested: number | null = 20.5): Decision {
  const a = ans(answerId);
  return {
    id: `${answerId}:grade`,
    assignmentId: assignment.id,
    questionId: a.questionId,
    answerId,
    studentId: a.studentId,
    studentIndex: a.studentIndex,
    studentName: a.studentName,
    points,
    maxPoints: a.questionId === Q1 ? 30 : 15,
    suggestedPoints: suggested,
    missingConcepts: missing,
    comment: "",
    at: a.studentIndex,
  };
}

const hdr = (teacher: string) => ({ "content-type": "application/json", "x-teacher-id": teacher });
const post = (app: App, path: string, body: unknown, teacher = T1) =>
  app.request(path, { method: "POST", headers: hdr(teacher), body: JSON.stringify(body) });
const put = (app: App, path: string, body: unknown, teacher = T1) =>
  app.request(path, { method: "PUT", headers: hdr(teacher), body: JSON.stringify(body) });
const get = (app: App, path: string, teacher = T1) => app.request(path, { headers: hdr(teacher) });

const editable = (a: Assignment) => {
  const { id: _i, teacherId: _t, course: _c, updatedAt: _u, lmsAssignmentId: _l, lastPulledAt: _p, ...rest } = a;
  return rest;
};

describe("auth and health", () => {
  it("reports the analyzer, and that no LMS is configured, without a teacher header", async () => {
    const res = await mkApp().request("/health");
    expect(await res.json()).toEqual({ ok: true, analyzer: "mock", model: "mock", fallbacks: [], lms: null });
  });

  it("answers sync routes with a clear error when no LMS is configured", async () => {
    const app = mkApp();
    const res = await post(app, "/sync/push", { assignmentId: assignment.id });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No LMS is configured/);
    expect((await post(app, "/sync/pull", { lmsAssignmentId: "x" })).status).toBe(400);
    expect(await (await get(app, `/sync/status/${assignment.id}`)).json()).toEqual({ linked: false, lms: null });
  });

  it("lists teachers publicly and rejects scoped routes without a known teacher", async () => {
    const app = mkApp();
    expect((await app.request("/teachers")).status).toBe(200);
    expect((await app.request("/courses")).status).toBe(401);
    expect((await get(app, "/courses", "nobody")).status).toBe(401);
  });
});

describe("multi-tenant data", () => {
  it("seeds the demo teacher's two courses, the second teacher's one, and keeps assignments and answers separate", async () => {
    const app = mkApp();
    const c1 = await (await get(app, "/courses")).json();
    const c2 = await (await get(app, "/courses", T2)).json();
    expect(c1.map((c: { id: string }) => c.id)).toEqual(["c-chem101", "c-eng8"]);
    expect(c2.map((c: { id: string }) => c.id)).toEqual(["c-hist210"]);
    expect((await get(app, `/assignments/${assignment.id}`)).status).toBe(200);
    expect((await get(app, `/assignments/${assignment.id}`, T2)).status).toBe(404);
    expect((await get(app, `/assignments/${assignment.id}/answers`, T2)).status).toBe(404);
  });

  it("lists answers per assignment and per question, in roster order", async () => {
    const app = mkApp();
    const all = await (await get(app, `/assignments/${assignment.id}/answers`)).json();
    const q2 = await (await get(app, `/assignments/${assignment.id}/answers?questionId=${Q2}`)).json();
    expect(all).toHaveLength(20);
    expect(q2.map((a: { studentIndex: number }) => a.studentIndex)).toEqual([1, 4, 7, 11, 15]);
  });

  it("lets a teacher author a course, a question with its own rubric, and local answers, then analyzes against that rubric", async () => {
    const app = mkApp();
    const course = await (await post(app, "/courses", { name: "HIST 210: Modern Europe", term: "Fall 2026" }, T2)).json();
    expect(course.teacherId).toBe(T2);

    const input = {
      courseId: course.id,
      title: "Causes of the First World War",
      learningObjectives: ["Connect long-term causes to the July Crisis."],
      questions: [
        {
          id: "q-ww1",
          index: 1,
          title: "Alliances and nationalism",
          prompt: "Explain how alliance systems and nationalism contributed to the outbreak of war in 1914.",
          anchors: [],
          rubric: {
            id: "r-ww1",
            criteria: [
              {
                id: "alliances",
                title: "Alliance systems",
                description: "Explains how the alliance blocs turned a regional crisis into a general war.",
                maxPoints: 10,
                concepts: ["alliance", "escalation"],
                bands: [
                  { level: "Exemplary", points: 10, descriptor: "Explains both blocs and the escalation mechanism." },
                  { level: "Proficient", points: 7, descriptor: "Names the blocs with partial mechanism." },
                  { level: "Beginning", points: 0, descriptor: "Alliances not addressed." },
                ],
              },
              {
                id: "nationalism",
                title: "Nationalism",
                description: "Explains the role of nationalism in the Balkans and the great powers.",
                maxPoints: 10,
                concepts: ["nationalism", "balkans"],
                bands: [
                  { level: "Exemplary", points: 10, descriptor: "Links Balkan nationalism to great-power rivalry." },
                  { level: "Proficient", points: 7, descriptor: "Describes nationalism generally." },
                  { level: "Beginning", points: 0, descriptor: "Nationalism not addressed." },
                ],
              },
            ],
          },
        },
      ],
    };
    const created = await post(app, "/assignments", input, T2);
    expect(created.status).toBe(201);
    const a = (await created.json()) as Assignment;
    expect(a.teacherId).toBe(T2);
    expect(a.course).toBe("HIST 210: Modern Europe");
    expect(a.lmsAssignmentId).toBe("");
    expect((await get(app, `/assignments/${a.id}`, T1)).status).toBe(404);

    const s = await (await post(app, `/assignments/${a.id}/answers`, { questionId: "q-ww1", studentName: "Ada Lovelace", text: "The alliance blocs meant that a regional crisis caused escalation across the whole continent within weeks." }, T2)).json();
    expect(s.studentIndex).toBe(1);
    expect((await post(app, `/assignments/${a.id}/answers`, { questionId: "nope", studentName: "X", text: "y" }, T2)).status).toBe(404);

    const res = await post(app, "/analyze", { assignmentId: a.id, questionId: "q-ww1", answerId: s.id }, T2);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalysisResult;
    expect(body.criteria.map((c) => c.criterionId)).toEqual(["alliances", "nationalism"]);
    const alliances = body.criteria[0]!;
    expect(alliances.suggestedPoints).toBe(10);
    const nationalism = body.criteria[1]!;
    expect(nationalism.missingConcepts).toContain("balkans");
    expect(nationalism.suggestedPoints).toBeLessThan(10);
    expect(body.maxTotal).toBe(20);
    expect(body.suggestedTotal).toBe(alliances.suggestedPoints + nationalism.suggestedPoints);
    expect(body.feedbackDraft.startsWith("Ada,")).toBe(true);

    // The other teacher cannot analyze against this rubric.
    expect((await post(app, "/analyze", { assignmentId: a.id, questionId: "q-ww1", answerId: s.id }, T1)).status).toBe(404);
  });

  it("validates questions and rubrics on create and update", async () => {
    const app = mkApp();
    const existing = (await (await get(app, `/assignments/${assignment.id}`)).json()) as Assignment;
    const base = editable(existing);

    const noCriteria = { ...base, questions: [{ ...base.questions[0]!, rubric: { id: "r", criteria: [] } }] };
    const res = await post(app, "/assignments", noCriteria);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Question 1: A rubric needs at least one criterion/);

    const misnumbered = { ...base, questions: [base.questions[1]!, base.questions[0]!] };
    expect((await (await post(app, "/assignments", misnumbered)).json()).error).toMatch(/numbered 1, 2, 3/);

    const duplicate = { ...base, questions: [base.questions[0]!, { ...base.questions[1]!, id: base.questions[0]!.id }] };
    expect((await (await post(app, "/assignments", duplicate)).json()).error).toMatch(/Duplicate question id/);

    expect((await post(app, "/assignments", { ...base, questions: [] })).status).toBe(400);
  });

  it("keeps LMS linkage when a teacher edits a pulled assignment's rubric", async () => {
    const app = mkApp();
    const existing = (await (await get(app, `/assignments/${assignment.id}`)).json()) as Assignment;
    const edited = editable(existing);
    edited.title = "Renamed";
    edited.questions[0]!.rubric.criteria[0]!.title = "Reversibility, revised";

    const upd = await put(app, `/assignments/${assignment.id}`, edited);
    expect(upd.status).toBe(200);
    const body = (await upd.json()) as Assignment;
    expect(body.title).toBe("Renamed");
    expect(body.questions[0]!.rubric.criteria[0]!.title).toBe("Reversibility, revised");
    expect(body.lmsAssignmentId).toBe("lms-a-haber");
    expect(body.questions.map((q) => q.lmsQuestionId)).toEqual(["lms-q-haber-1", "lms-q-haber-2"]);
    expect(body.updatedAt).toBeGreaterThanOrEqual(existing.updatedAt);
    expect((await put(app, `/assignments/${assignment.id}`, edited, T2)).status).toBe(404);
  });
});

describe("POST /analyze on the seeded assignment", () => {
  it("returns a rubric-aligned result with a suggested grade and the reversibility omission on answer 4", async () => {
    const res = await post(mkApp(), "/analyze", { assignmentId: assignment.id, questionId: Q1, answerId: "sub-04" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalysisResult;
    expect(body).toMatchObject({ answerId: "sub-04", questionId: Q1, suggestedTotal: 20.5, maxTotal: 30 });
    expect(body.criteria).toHaveLength(6);
    const rev = body.criteria.find((c) => c.criterionId === "reversibility")!;
    expect(rev.missingConcepts).toContain("reversibility");
    expect(rev.suggestedPoints).toBe(0);
    expect(body.missingConcepts).toEqual(["reversibility", "dynamic_equilibrium"]);
    expect(body.summary.length).toBeGreaterThan(10);
    expect(body.feedbackDraft).toMatch(/^Daniel,/);
  });

  it("analyzes a question 2 answer against question 2's rubric only", async () => {
    const res = await post(mkApp(), "/analyze", { assignmentId: assignment.id, questionId: Q2, answerId: "q2-sub-04" });
    const body = (await res.json()) as AnalysisResult;
    expect(body.maxTotal).toBe(15);
    expect(body.criteria.map((c) => c.criterionId)).toEqual(["pressure_effect", "tradeoff", "q2_evidence"]);
  });

  it("rejects malformed bodies, unknown assignments, and an answer that belongs to another question", async () => {
    const app = mkApp();
    expect((await post(app, "/analyze", { nope: true })).status).toBe(400);
    expect((await post(app, "/analyze", { assignmentId: "other", questionId: Q1, answerId: "sub-01" })).status).toBe(404);
    expect((await post(app, "/analyze", { assignmentId: assignment.id, questionId: "nope", answerId: "sub-01" })).status).toBe(404);
    expect((await post(app, "/analyze", { assignmentId: assignment.id, questionId: Q2, answerId: "sub-01" })).status).toBe(404);
  });
});

describe("POST /analyze on the English exam", () => {
  it("gives a one-feature comparison half credit and names the missing population comparison", async () => {
    const res = await post(mkApp(), "/analyze", { assignmentId: englishAssignment.id, questionId: "q-eng-compare", answerId: "e-q1-02" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalysisResult;
    expect(body).toMatchObject({ answerId: "e-q1-02", suggestedTotal: 5, maxTotal: 10, missingConcepts: ["population_comparison"] });
    expect(body.feedbackDraft).toMatch(/^Mehmet,/);
  });

  it("scores a listening answer by how many items match that question's answer key", async () => {
    const res = await post(mkApp(), "/analyze", { assignmentId: englishAssignment.id, questionId: "q-eng-order-barbara", answerId: "e-q2-02" });
    const body = (await res.json()) as AnalysisResult;
    expect(body).toMatchObject({ suggestedTotal: 15, maxTotal: 20, missingConcepts: ["dessert"] });
  });

  it("sums the three analytic criteria of the paragraph question", async () => {
    const res = await post(mkApp(), "/analyze", { assignmentId: englishAssignment.id, questionId: "q-eng-weekend", answerId: "e-q5-09" });
    const body = (await res.json()) as AnalysisResult;
    expect(body.criteria.map((c) => c.criterionId)).toEqual(["task_content", "grammar_accuracy", "vocabulary_range"]);
    expect(body).toMatchObject({ suggestedTotal: 11, maxTotal: 12, missingConcepts: ["simple_present"] });
  });
});

describe("decision flow", () => {
  it("flags two English one-feature comparisons graded 10 and 0 against the same half-credit suggestion", async () => {
    const app = mkApp();
    const eng = (answerId: string, points: number): Decision => {
      const a = englishAnswers.find((x) => x.id === answerId)!;
      return {
        id: `${answerId}:grade`, assignmentId: englishAssignment.id, questionId: a.questionId, answerId, studentId: a.studentId,
        studentIndex: a.studentIndex, studentName: a.studentName, points, maxPoints: 10, suggestedPoints: 5,
        missingConcepts: ["population_comparison"], comment: "", at: a.studentIndex,
      };
    };
    expect((await (await post(app, "/decision", { decision: eng("e-q1-02", 10) })).json()).alert).toBeNull();
    const { alert } = await (await post(app, "/decision", { decision: eng("e-q1-06", 0) })).json();
    expect(alert).toMatchObject({ questionId: "q-eng-compare", priorStudentName: "Mehmet Kaya", sharedConcepts: ["population_comparison"], recommendedPoints: 10 });
  });

  it("raises the comparison alert on answer 11 after answer 4, and override silences it", async () => {
    const app = mkApp();
    // First student: no one to compare with.
    let res = await post(app, "/decision", { decision: decision("sub-04", 24, ["reversibility", "dynamic_equilibrium"]) });
    expect((await res.json()).alert).toBeNull();

    // Same gap, graded 8 points harsher relative to the suggestion.
    res = await post(app, "/decision", { decision: decision("sub-11", 16, ["reversibility", "dynamic_equilibrium"]) });
    const { alert } = await res.json();
    expect(alert).toMatchObject({
      questionId: Q1,
      priorStudentIndex: 4,
      priorStudentName: "Daniel Okafor",
      currentStudentIndex: 11,
      sharedConcepts: ["reversibility", "dynamic_equilibrium"],
      priorPoints: 24,
      currentPoints: 16,
      priorOffset: 3.5,
      currentOffset: -4.5,
      spread: 8,
      recommendedPoints: 24,
    });

    expect((await post(app, "/override", { assignmentId: assignment.id, decisionIdA: "sub-11:grade", decisionIdB: "sub-04:grade" })).status).toBe(204);
    res = await post(app, "/decision", { decision: decision("sub-11", 16, ["reversibility"]) });
    expect((await res.json()).alert).toBeNull();

    expect((await post(app, "/check-raised", { assignmentId: assignment.id })).status).toBe(204);
    expect((await post(app, "/check-approved", { assignmentId: assignment.id })).status).toBe(204);

    const session = await (await get(app, `/session/${assignment.id}`)).json();
    // One row per answer: the re-graded answer 11 replaced its first row.
    expect(session.decisions).toHaveLength(2);
    expect(session).toMatchObject({ alertsRaised: 1, checksRaised: 1, checksApproved: 1 });
    expect(session.overrides).toBeUndefined();

    // Another teacher cannot read or record into this session.
    expect((await get(app, `/session/${assignment.id}`, T2)).status).toBe(404);
    expect((await post(app, "/decision", { decision: decision("sub-01", 30, []) }, T2)).status).toBe(404);
  });

  it("does not compare grades across questions", async () => {
    const app = mkApp();
    // Lenient on question 1 for answer 4, harsh on question 2 for answer 11, same shared tag.
    await post(app, "/decision", { decision: { ...decision("sub-04", 24, ["quantitative_reference"]), suggestedPoints: 20.5 } });
    const res = await post(app, "/decision", { decision: { ...decision("q2-sub-11", 4, ["quantitative_reference"]), suggestedPoints: 12 } });
    expect((await res.json()).alert).toBeNull();
  });

  it("keeps only the latest grade per answer", async () => {
    const app = mkApp();
    await post(app, "/decision", { decision: { ...decision("sub-04", 24, ["reversibility"]), at: 1 } });
    await post(app, "/decision", { decision: { ...decision("sub-04", 21, ["reversibility"]), at: 2 } });

    const session = await (await get(app, `/session/${assignment.id}`)).json();
    expect(session.decisions).toHaveLength(1);
    expect(session.decisions[0]).toMatchObject({ id: "sub-04:grade", points: 21 });
  });

  it("rolls per-question grades up to an assignment grade per student", async () => {
    const app = mkApp();
    await post(app, "/decision", { decision: decision("sub-04", 20, []) });
    await post(app, "/decision", { decision: decision("q2-sub-04", 9, []) });
    await post(app, "/decision", { decision: decision("sub-02", 25, []) });

    const grades = await (await get(app, `/assignments/${assignment.id}/grades`)).json();
    expect(grades).toHaveLength(15);
    const daniel = grades.find((g: { studentId: string }) => g.studentId === "stu-04");
    const ben = grades.find((g: { studentId: string }) => g.studentId === "stu-02");
    expect(daniel).toMatchObject({ points: 29, maxPoints: 45, gradedQuestions: 2, complete: true });
    expect(ben).toMatchObject({ points: 25, maxPoints: 45, gradedQuestions: 1, complete: false });
  });

  it("counts a rubric check once per answer, however often it is raised", async () => {
    const app = mkApp();
    // The check is evaluated live as the teacher types, so the same answer
    // can raise it on every keystroke.
    for (const _ of [1, 2, 3]) await post(app, "/check-raised", { assignmentId: assignment.id, answerId: "sub-04" });
    await post(app, "/check-raised", { assignmentId: assignment.id, answerId: "sub-11" });

    const session = await (await get(app, `/session/${assignment.id}`)).json();
    expect(session.checksRaised).toBe(2);
    expect(session.checksRaisedFor).toBeUndefined();
  });

  it("rejects malformed decisions and decisions that do not match a known answer", async () => {
    const app = mkApp();
    expect((await post(app, "/decision", { decision: { ...decision("sub-01", 5, []), points: "high" } })).status).toBe(400);
    expect((await post(app, "/decision", { decision: { ...decision("sub-01", 5, []), questionId: Q2 } })).status).toBe(404);
    expect((await post(app, "/decision", { decision: { ...decision("sub-01", 5, []), studentId: "stu-09" } })).status).toBe(404);
  });

  it("allows CORS from local app origins only", async () => {
    const app = mkApp();
    for (const origin of ["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5174"]) {
      const res = await app.request("/health", { headers: { Origin: origin } });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
    for (const origin of ["https://evil.example", "chrome-extension://abcdefghijklmnop"]) {
      const res = await app.request("/health", { headers: { Origin: origin } });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("Store persistence", () => {
  const tmpPath = async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    return join(mkdtempSync(join(tmpdir(), "gg-store-")), "data.json");
  };

  it("round-trips through a JSON file", async () => {
    const path = await tmpPath();
    const s1 = new Store(path);
    const course = s1.createCourse(T1, "Persisted", "");
    const s2 = new Store(path);
    expect(s2.course(T1, course.id)?.name).toBe("Persisted");
  });

  it("seeds both assignments with their rubrics and the demo answers, ready to grade without an LMS", () => {
    const s = new Store();
    expect(s.assignment(T1, assignment.id)?.questions).toHaveLength(2);
    expect(s.answersFor(assignment.id)).toHaveLength(20);
    expect(s.assignmentsFor(T1, "c-eng8").map((a) => a.id)).toEqual([englishAssignment.id]);
    expect(s.assignment(T1, englishAssignment.id)?.questions).toHaveLength(5);
    expect(s.answersFor(englishAssignment.id)).toHaveLength(50);
    expect(new Store(undefined, { withAnswers: false }).answersFor(assignment.id)).toEqual([]);
  });

  it("reseeds a data file written by an older schema instead of loading it", async () => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const path = await tmpPath();
    // The pre-pivot shape: flat submissions, rubric on the assignment, no version.
    writeFileSync(path, JSON.stringify({ teachers: [], courses: [], assignments: [{ id: "old", rubric: {} }], submissions: [], sessions: {} }));
    const logs: string[] = [];
    const s = new Store(path, {}, (m) => logs.push(m));
    expect(s.teacher(T1)).toBeDefined();
    expect(s.assignment(T1, assignment.id)?.questions).toHaveLength(2);
    expect(logs.some((l) => l.includes("Reseeding"))).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe(SCHEMA_VERSION);
  });
});
