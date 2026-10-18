/** Outcome of one read-only chapter check. */
export type CheckResult =
  | { passed: true; data: unknown; message: string }
  | {
      passed: false;
      issues: string[];
      message: string;
      repairAction: string;
      /** Present only when a bounded wait may change the answer. */
      retryAfterMs?: number;
      /** Visual-review flags that would sit in data on a pass. */
      review?: string[];
    };

export function verdict(
  issues: string[],
  data: unknown,
  pass: string,
  fail: string,
  repairAction: string,
  review: string[] = [],
): CheckResult {
  if (issues.length === 0) return { data, message: pass, passed: true };
  return review.length
    ? { issues, message: fail, passed: false, repairAction, review }
    : { issues, message: fail, passed: false, repairAction };
}
