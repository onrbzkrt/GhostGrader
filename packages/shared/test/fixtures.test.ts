import { describe, expect, it } from "vitest";
import { answers, assignment, criterionById, englishAnswers, englishAssignment, englishStudents, groundTruth, seededAnswers, students } from "../src/data";
import { mockAnalyze } from "../src/mock-analyzer";
import { AnalysisResultSchema, type Question } from "../src/schemas";

const q1 = assignment.questions[0]!;
const q2 = assignment.questions[1]!;
const q1Answers = answers.filter((a) => a.questionId === q1.id);
const q2Answers = answers.filter((a) => a.questionId === q2.id);

describe("seeded dataset", () => {
  it("has two ordered questions, each with its own rubric and closed concept vocabulary", () => {
    expect(assignment.questions.map((q) => q.index)).toEqual([1, 2]);
    expect(q1.rubric.criteria).toHaveLength(6);
    expect(q2.rubric.criteria).toHaveLength(3);
    for (const q of assignment.questions) {
      for (const c of q.rubric.criteria) {
        expect(c.concepts.length).toBeGreaterThan(0);
        expect(c.bands[0]!.points).toBe(c.maxPoints);
      }
    }
  });

  it("is linked to the LMS at every level so pushes have somewhere to land", () => {
    expect(assignment.lmsAssignmentId).not.toBe("");
    for (const q of assignment.questions) expect(q.lmsQuestionId).not.toBe("");
    for (const a of answers) expect(a.lmsAnswerId).not.toBe("");
  });

  it("has a fifteen-student roster with unique, sequential indices", () => {
    expect(students).toHaveLength(15);
    expect(new Set(students.map((s) => s.id)).size).toBe(15);
    expect(q1Answers.map((a) => a.studentIndex)).toEqual([...Array(15)].map((_, i) => i + 1));
  });

  it("has fifteen answers to question 1 and five to question 2, all from rostered students", () => {
    expect(q1Answers).toHaveLength(15);
    expect(q2Answers).toHaveLength(5);
    const roster = new Set(students.map((s) => s.id));
    for (const a of answers) expect(roster.has(a.studentId), a.id).toBe(true);
    expect(new Set(answers.map((a) => a.id)).size).toBe(answers.length);
  });

  it("has ground truth for every question 1 answer covering every criterion, and none for question 2", () => {
    for (const a of q1Answers) {
      const gt = groundTruth[a.id];
      expect(gt, a.id).toBeDefined();
      expect(gt!.criteria.map((c) => c.criterionId).sort()).toEqual(q1.rubric.criteria.map((c) => c.id).sort());
    }
    for (const a of q2Answers) expect(groundTruth[a.id], a.id).toBeUndefined();
  });

  it("quotes evidence verbatim from the essay", () => {
    for (const a of q1Answers) {
      for (const c of groundTruth[a.id]!.criteria) {
        for (const quote of c.evidence) {
          expect(a.text, `${a.id}/${c.criterionId}: "${quote}"`).toContain(quote);
        }
      }
    }
  });

  it("only uses concept tags from the criterion vocabulary and valid band levels", () => {
    for (const a of q1Answers) {
      for (const c of groundTruth[a.id]!.criteria) {
        const crit = criterionById(c.criterionId);
        for (const tag of c.missingConcepts) expect(crit.concepts, `${a.id}/${c.criterionId}`).toContain(tag);
        expect(crit.bands.map((b) => b.level)).toContain(c.level);
      }
    }
  });

  it("sets up the demo: answers 4 and 11 share the reversibility omission", () => {
    for (const id of ["sub-04", "sub-11"]) {
      const rev = groundTruth[id]!.criteria.find((c) => c.criterionId === "reversibility")!;
      expect(rev.missingConcepts).toContain("reversibility");
    }
  });

  it("reuses a concept tag across questions, so per-question drift scoping is demonstrable", () => {
    const tags = (q: Question) => new Set(q.rubric.criteria.flatMap((c) => c.concepts));
    const shared = [...tags(q1)].filter((t) => tags(q2).has(t));
    expect(shared).toContain("quantitative_reference");
  });
});

describe("mockAnalyze", () => {
  it("produces a schema-valid result for every answer, scoped to its own question", () => {
    for (const a of answers) {
      const question = assignment.questions.find((q) => q.id === a.questionId)!;
      const result = mockAnalyze(a, assignment, question, groundTruth);
      expect(() => AnalysisResultSchema.parse(result)).not.toThrow();
      expect(result.answerId).toBe(a.id);
      expect(result.questionId).toBe(question.id);
      expect(result.criteria).toHaveLength(question.rubric.criteria.length);
      expect(result.feedbackDraft.length).toBeGreaterThan(40);
    }
  });
});

describe("English exam seed", () => {
  const eq = (id: string) => englishAssignment.questions.find((q) => q.id === id)!;
  const analyze = (answerId: string) => {
    const a = englishAnswers.find((x) => x.id === answerId)!;
    return mockAnalyze(a, englishAssignment, eq(a.questionId), groundTruth);
  };

  it("has five ordered questions whose rubrics match the exam's scoring", () => {
    expect(englishAssignment.questions.map((q) => q.index)).toEqual([1, 2, 3, 4, 5]);
    const shape = englishAssignment.questions.map((q) => q.rubric.criteria.map((c) => `${c.id}:${c.bands.map((b) => b.points).join("/")}`));
    expect(shape).toEqual([
      ["comparison:10/5/0"],
      ["order_items:20/15/10/5/0"],
      ["order_items:20/15/10/5/0"],
      ["excuse:10/5/0"],
      ["task_content:4/3/2/1/0", "grammar_accuracy:4/3/2/1/0", "vocabulary_range:4/3/2/1/0"],
    ]);
    for (const q of englishAssignment.questions) {
      expect(q.lmsQuestionId).not.toBe("");
      for (const c of q.rubric.criteria) expect(c.bands[0]!.points).toBe(c.maxPoints);
    }
  });

  it("has every rostered student answer every question, with ids unique across the whole seed", () => {
    expect(englishStudents).toHaveLength(10);
    for (const q of englishAssignment.questions) {
      expect(englishAnswers.filter((a) => a.questionId === q.id).map((a) => a.studentIndex)).toEqual([...Array(10)].map((_, i) => i + 1));
    }
    expect(new Set(seededAnswers.map((a) => a.id)).size).toBe(seededAnswers.length);
  });

  it("has ground truth for every answer, with verbatim evidence, vocabulary tags, valid levels, and no gaps at the top band", () => {
    for (const a of englishAnswers) {
      const q = eq(a.questionId);
      const gt = groundTruth[a.id];
      expect(gt, a.id).toBeDefined();
      expect(gt!.criteria.map((c) => c.criterionId)).toEqual(q.rubric.criteria.map((c) => c.id));
      for (const c of gt!.criteria) {
        const crit = criterionById(c.criterionId, englishAssignment);
        for (const quote of c.evidence) expect(a.text, `${a.id}: "${quote}"`).toContain(quote);
        for (const tag of c.missingConcepts) expect(crit.concepts, a.id).toContain(tag);
        expect(crit.bands.map((b) => b.level), a.id).toContain(c.level);
        if (c.level === crit.bands[0]!.level) expect(c.missingConcepts, a.id).toEqual([]);
      }
    }
  });

  it("scores the listening questions at 5 points per correctly written item", () => {
    for (const a of englishAnswers.filter((x) => x.questionId.startsWith("q-eng-order-"))) {
      const r = analyze(a.id);
      expect(r.suggestedTotal, a.id).toBe(20 - 5 * r.missingConcepts.length);
    }
  });

  it("sets up a consistency pair on every question: two students with the same gap", () => {
    const pairs: [string, string, string][] = [
      ["e-q1-02", "e-q1-06", "population_comparison"],
      ["e-q2-02", "e-q2-05", "dessert"],
      ["e-q3-03", "e-q3-06", "main_course"],
      ["e-q4-03", "e-q4-08", "supporting_detail"],
      ["e-q5-03", "e-q5-04", "reason"],
    ];
    for (const [a, b, tag] of pairs) {
      const ra = analyze(a);
      const rb = analyze(b);
      expect(ra.missingConcepts, a).toContain(tag);
      expect(rb.missingConcepts, b).toContain(tag);
      expect(ra.suggestedTotal).toBe(rb.suggestedTotal);
    }
  });

  it("produces a schema-valid mock analysis for every answer", () => {
    for (const a of englishAnswers) {
      const r = analyze(a.id);
      expect(() => AnalysisResultSchema.parse(r)).not.toThrow();
      expect(r.criteria).toHaveLength(eq(a.questionId).rubric.criteria.length);
      expect(r.feedbackDraft.length).toBeGreaterThan(40);
    }
  });
});
