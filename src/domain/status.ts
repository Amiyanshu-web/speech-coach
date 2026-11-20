export const STATUSES = ["pending", "done", "failed", "skipped"] as const;
export type Status = (typeof STATUSES)[number];

export const MAX_FAILED_NIGHTS = 5;

export const onFailure = (input: {
  attempts: number;
  lastAttemptDay: string | null;
  today: string;
}): { status: "failed" | "skipped"; attempts: number; lastAttemptDay: string } => {
  const attempts =
    input.lastAttemptDay === input.today ? input.attempts : input.attempts + 1;
  return {
    status: attempts >= MAX_FAILED_NIGHTS ? "skipped" : "failed",
    attempts,
    lastAttemptDay: input.today,
  };
};
