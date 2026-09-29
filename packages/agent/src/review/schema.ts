import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FindingSchema = z
  .object({
    severity: z.enum(SEVERITIES),
    file: z.string().min(1).max(500).describe("Path relative to the repository root"),
    line: z.number().int().min(1).describe("1-based line number the finding refers to"),
    issue: z.string().min(10).max(2000).describe("What is wrong and its concrete consequence"),
    suggestion: z.string().min(5).max(2000).describe("The change that fixes it"),
    category: z
      .enum([
        "correctness",
        "security",
        "data-integrity",
        "error-handling",
        "concurrency",
        "performance",
        "testing",
        "maintainability",
      ])
      .optional(),
  })
  .strict();

export type Finding = z.infer<typeof FindingSchema>;

export const ReviewSubmissionSchema = z
  .object({
    summary: z
      .string()
      .min(1)
      .max(2000)
      .describe("Two or three sentences on the overall state of the change"),
    findings: z.array(FindingSchema).max(50),
  })
  .strict();

export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

export interface RejectedFinding {
  finding: Finding;
  reason: string;
}

/** The validated, grounded result of a review run. */
export interface ReviewReport {
  summary: string;
  findings: Finding[];
  /** Findings whose file/line could not be verified; kept for transparency, not presented as results. */
  rejectedFindings: RejectedFinding[];
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}
