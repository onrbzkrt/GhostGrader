import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  seededAnswers,
  seededAssignments,
  seededStudents,
  type Answer,
  type Assignment,
  type Course,
  type Decision,
  type PushRecord,
  type Student,
  type Teacher,
} from "@gg/shared";

/**
 * Bump when StoreData changes shape, or when the seed changes in a way an
 * existing demo data file should pick up. A data file on another version is
 * discarded and reseeded. 3: the Grade 8 English exam joins the seed.
 */
export const SCHEMA_VERSION = 3;

export interface SessionState {
  decisions: Decision[];
  overrides: string[];
  /** Answers whose rubric check has already been counted. */
  checksRaisedFor?: string[];
  alertsRaised: number;
  alertsAligned: number;
  checksRaised: number;
  checksApproved: number;
}

export interface StoreData {
  schemaVersion: number;
  teachers: Teacher[];
  courses: Course[];
  students: Student[];
  /** Questions and their rubrics are embedded in each assignment. */
  assignments: Assignment[];
  answers: Answer[];
  sessions: Record<string, SessionState>;
  /** What has been sent to the LMS, keyed by assignment id. */
  pushes: Record<string, PushRecord[]>;
}

export function emptySession(): SessionState {
  return { decisions: [], overrides: [], checksRaisedFor: [], alertsRaised: 0, alertsAligned: 0, checksRaised: 0, checksApproved: 0 };
}

export interface SeedOptions {
  /**
   * Seed the demo questions' answers into the store. On by default, so the
   * demo has student answers to grade without any LMS. Sync tests turn it off
   * to watch answers arrive through a pull.
   */
  withAnswers?: boolean;
}

export function seedData(opts: SeedOptions = {}): StoreData {
  const withAnswers = opts.withAnswers ?? true;
  return {
    schemaVersion: SCHEMA_VERSION,
    teachers: [
      { id: "t-demo", name: "Dr. Selin Demir", email: "selin.demir@example.edu" },
      { id: "t-second", name: "Mr. James Park", email: "james.park@example.edu" },
    ],
    courses: [
      { id: "c-chem101", teacherId: "t-demo", name: "CHEM 101: General Chemistry", term: "Fall 2026", lmsCourseId: "lms-c-chem101" },
      { id: "c-eng8", teacherId: "t-demo", name: "ENG 8: English", term: "Fall 2026", lmsCourseId: "lms-c-eng8" },
      { id: "c-hist210", teacherId: "t-second", name: "HIST 210: Modern Europe", term: "Fall 2026", lmsCourseId: "" },
    ],
    students: withAnswers ? [...seededStudents] : [],
    // The seeded assignments ship with their rubrics written. Their LMS ids let a
    // configured LMS pull into them later without clobbering those rubrics.
    assignments: seededAssignments.map((a) => ({ ...a, updatedAt: Date.now() })),
    answers: withAnswers ? seededAnswers.map((a) => ({ ...a, pulledAt: Date.now() })) : [],
    sessions: {},
    pushes: {},
  };
}

/**
 * Tiny JSON-file persistence. Teachers, courses, assignments with their
 * questions and rubrics, the roster, answers pulled from the LMS, grading
 * sessions and push records live in one file rewritten atomically on every
 * change. Pass no path for a memory-only store (tests).
 */
export class Store {
  private data: StoreData;

  constructor(
    private readonly path?: string,
    seed: SeedOptions = {},
    log?: (m: string) => void,
  ) {
    const loaded = path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<StoreData>) : null;
    if (loaded && loaded.schemaVersion === SCHEMA_VERSION) {
      this.data = loaded as StoreData;
    } else {
      // The file predates the current shape. It is read with a plain cast, so
      // loading it would fail later somewhere confusing; start fresh instead.
      if (loaded) log?.(`Data file ${path} is on schema ${loaded.schemaVersion ?? 1}, expected ${SCHEMA_VERSION}. Reseeding.`);
      this.data = seedData(seed);
      this.flush();
    }
  }

  private flush() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  // ----- teachers -----
  teachers(): Teacher[] {
    return this.data.teachers;
  }
  teacher(id: string): Teacher | undefined {
    return this.data.teachers.find((t) => t.id === id);
  }

  // ----- courses -----
  coursesFor(teacherId: string): Course[] {
    return this.data.courses.filter((c) => c.teacherId === teacherId);
  }
  course(teacherId: string, id: string): Course | undefined {
    return this.data.courses.find((c) => c.id === id && c.teacherId === teacherId);
  }
  courseByLmsId(teacherId: string, lmsCourseId: string): Course | undefined {
    return this.data.courses.find((c) => c.teacherId === teacherId && c.lmsCourseId !== "" && c.lmsCourseId === lmsCourseId);
  }
  createCourse(teacherId: string, name: string, term: string, lmsCourseId = ""): Course {
    const course: Course = { id: newId("c"), teacherId, name, term, lmsCourseId };
    this.data.courses.push(course);
    this.flush();
    return course;
  }

  // ----- assignments -----
  assignmentsFor(teacherId: string, courseId?: string): Assignment[] {
    return this.data.assignments.filter((a) => a.teacherId === teacherId && (!courseId || a.courseId === courseId));
  }
  assignment(teacherId: string, id: string): Assignment | undefined {
    return this.data.assignments.find((a) => a.id === id && a.teacherId === teacherId);
  }
  assignmentByLmsId(teacherId: string, lmsAssignmentId: string): Assignment | undefined {
    return this.data.assignments.find((a) => a.teacherId === teacherId && a.lmsAssignmentId !== "" && a.lmsAssignmentId === lmsAssignmentId);
  }
  createAssignment(a: Assignment): Assignment {
    this.data.assignments.push(a);
    this.flush();
    return a;
  }
  updateAssignment(teacherId: string, id: string, patch: Omit<Assignment, "id" | "teacherId">): Assignment | undefined {
    const idx = this.data.assignments.findIndex((a) => a.id === id && a.teacherId === teacherId);
    if (idx < 0) return undefined;
    const next: Assignment = { ...patch, id, teacherId };
    this.data.assignments[idx] = next;
    this.flush();
    return next;
  }

  // ----- students -----
  student(id: string): Student | undefined {
    return this.data.students.find((s) => s.id === id);
  }
  studentByLmsId(lmsStudentId: string): Student | undefined {
    return this.data.students.find((s) => s.lmsStudentId !== "" && s.lmsStudentId === lmsStudentId);
  }
  upsertStudent(s: Student): Student {
    const idx = this.data.students.findIndex((x) => x.id === s.id);
    if (idx < 0) this.data.students.push(s);
    else this.data.students[idx] = s;
    this.flush();
    return s;
  }

  // ----- answers -----
  answersFor(assignmentId: string, questionId?: string): Answer[] {
    return this.data.answers
      .filter((a) => a.assignmentId === assignmentId && (!questionId || a.questionId === questionId))
      .sort((a, b) => a.studentIndex - b.studentIndex);
  }
  answer(assignmentId: string, id: string): Answer | undefined {
    return this.data.answers.find((a) => a.assignmentId === assignmentId && a.id === id);
  }
  answerByLmsId(assignmentId: string, lmsAnswerId: string): Answer | undefined {
    return this.data.answers.find((a) => a.assignmentId === assignmentId && a.lmsAnswerId !== "" && a.lmsAnswerId === lmsAnswerId);
  }
  upsertAnswer(a: Answer): Answer {
    const idx = this.data.answers.findIndex((x) => x.id === a.id);
    if (idx < 0) this.data.answers.push(a);
    else this.data.answers[idx] = a;
    this.flush();
    return a;
  }

  // ----- sessions -----
  session(assignmentId: string): SessionState {
    return (this.data.sessions[assignmentId] ??= emptySession());
  }
  saveSession(assignmentId: string, s: SessionState) {
    this.data.sessions[assignmentId] = s;
    this.flush();
  }
  resetSession(assignmentId: string) {
    delete this.data.sessions[assignmentId];
    this.flush();
  }

  // ----- pushes -----
  pushesFor(assignmentId: string): PushRecord[] {
    return this.data.pushes[assignmentId] ?? [];
  }
  savePushes(assignmentId: string, records: PushRecord[]) {
    this.data.pushes[assignmentId] = records;
    this.flush();
  }
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
