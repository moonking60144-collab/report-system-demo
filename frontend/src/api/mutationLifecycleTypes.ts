export type MutationLifecycleState =
  | "accepted"
  | "running"
  | "success"
  | "failed"
  | "conflict"
  | "indeterminate"
  | "unknown";

export interface MutationLifecycleTiming {
  lifecycleState?: MutationLifecycleState;
  acceptedAt?: string | null;
  confirmedAt?: string | null;
}
