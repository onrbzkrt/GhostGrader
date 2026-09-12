import assignmentJson from "../fixtures/assignment.json";
import submissionsJson from "../fixtures/submissions.json";
import answersQ2Json from "../fixtures/answers-q2.json";
import groundTruthJson from "../fixtures/ground-truth.json";
import englishAssignmentJson from "../fixtures/english8/assignment.json";
import englishStudentsJson from "../fixtures/english8/students.json";
import englishAnswersJson from "../fixtures/english8/answers.json";
import englishGroundTruthJson from "../fixtures/english8/ground-truth.json";
import { AnswerSchema, AssignmentSchema, GroundTruthSchema, StudentSchema, type Answer, type Assignment, type Criterion, type Student } from "./schemas";

/** The seeded demo assignment: two questions, each carrying its own rubric. */
export const assignment = AssignmentSchema.parse(assignmentJson);

const pad = (n: number) => String(n).padStart(2, "0");

/** Roster derived from the question 1 essays, in their original order. */
export const students: Student[] = submissionsJson.map((s) =>
  StudentSchema.parse({ id: `stu-${pad(s.index)}`, name: s.studentName, lmsStudentId: `stu-${pad(s.index)}` }),
);

/**
 * Every seeded answer. Question 1 answers keep the original ids `sub-01`..
 * `sub-15` on purpose: ground truth and the analysis regression fixtures are
 * keyed by them. Question 2 has five answers and no ground truth, which
 * exercises the heuristic analyzer and partial grade rollups.
 */
export const answers: Answer[] = [
  ...submissionsJson.map((s) =>
    AnswerSchema.parse({
      id: s.id,
      assignmentId: assignment.id,
      questionId: "q-haber-1",
      studentId: `stu-${pad(s.index)}`,
      studentName: s.studentName,
      studentIndex: s.index,
      text: s.text,
      lmsAnswerId: s.id,
    }),
  ),
  ...answersQ2Json.map((s) =>
    AnswerSchema.parse({
      id: s.id,
      assignmentId: assignment.id,
      questionId: "q-haber-2",
      studentId: `stu-${pad(s.studentIndex)}`,
      studentName: s.studentName,
      studentIndex: s.studentIndex,
      text: s.text,
      lmsAnswerId: s.id,
    }),
  ),
];

/**
 * The Grade 8 English exam: five short open-ended questions (a written
 * comparison, two listening tasks, a dialogue question and a short paragraph),
 * each with its own rubric. Every answer has ground truth, so mock mode gives
 * rubric-faithful suggestions for all of them.
 */
export const englishAssignment = AssignmentSchema.parse(englishAssignmentJson);

export const englishStudents: Student[] = englishStudentsJson.map((s) => StudentSchema.parse(s));

export const englishAnswers: Answer[] = englishAnswersJson.map((s) => {
  const student = englishStudents[s.studentIndex - 1]!;
  return AnswerSchema.parse({
    id: s.id,
    assignmentId: englishAssignment.id,
    questionId: s.questionId,
    studentId: student.id,
    studentName: student.name,
    studentIndex: s.studentIndex,
    text: s.text,
    lmsAnswerId: s.id,
  });
});

/** Everything the store seeds, across both demo assignments. */
export const seededAssignments: Assignment[] = [assignment, englishAssignment];
export const seededStudents: Student[] = [...students, ...englishStudents];
export const seededAnswers: Answer[] = [...answers, ...englishAnswers];

/** Ground truth keyed by answer id. Ids are unique across both assignments, so the two files merge safely. */
export const groundTruth = GroundTruthSchema.parse({ ...groundTruthJson, ...englishGroundTruthJson });

/** Find a criterion by id across every question of an assignment (the chemistry assignment by default). */
export function criterionById(id: string, from: Pick<Assignment, "questions"> = assignment): Criterion {
  for (const q of from.questions) {
    const c = q.rubric.criteria.find((x) => x.id === id);
    if (c) return c;
  }
  throw new Error(`Unknown criterion ${id}`);
}
