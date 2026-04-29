/**
 * Deterministic catalogs of Kubernetes failure signals. Used by short-circuit
 * checks and (later) per-resource analyzers so neither code paths nor LLM
 * prompts have to enumerate terminal states from memory.
 *
 * Adapted from k8sgpt-ai/k8sgpt analyzers (pkg/analyzer/pod.go,
 * pkg/util/util.go). Stays read-only; signals only, no remediation.
 */

/**
 * Container `state.waiting.reason` values that mean a pod is actively broken
 * right now (not transient pull/init). Mirrors k8sgpt's pod analyzer
 * `containerStatusReasons` allowlist.
 */
export const WAITING_REASON_FAILURES = new Set<string>([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "ErrImageNeverPull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);

/**
 * Last-termination reasons (`state.terminated.reason` or
 * `lastState.terminated.reason`) that signal a real fault rather than normal
 * pod lifecycle.
 */
export const TERMINATION_REASON_FAILURES = new Set<string>([
  "OOMKilled",
  "Error",
  "ContainerCannotRun",
  "DeadlineExceeded",
  "Evicted",
]);

/** Combined: any waiting OR termination reason worth surfacing. */
export const UNHEALTHY_CONTAINER_REASONS = new Set<string>([
  ...WAITING_REASON_FAILURES,
  ...TERMINATION_REASON_FAILURES,
]);

/**
 * k8s Event reasons that indicate a real failure (Warning-typed events with
 * these reasons should always be surfaced, never filtered as noise).
 */
export const EVENT_REASON_FAILURES = new Set<string>([
  "FailedCreate",
  "FailedCreatePodSandBox",
  "FailedScheduling",
  "FailedMount",
  "FailedAttachVolume",
  "ProvisioningFailed",
  "Unhealthy",
  "BackOff",
  "FailedKillPod",
  "FailedSync",
  "NodeNotReady",
]);

/**
 * Annotations that opt a resource out of cross-reference checks (e.g. unused
 * ConfigMap detection). Kept here so future analyzers share the same opt-out.
 */
export const SKIP_USAGE_CHECK_ANNOTATION = "k8sgpt.ai/skip-usage-check";

/**
 * Service annotations that mean the empty-endpoints check should not flag the
 * service as broken (leader-election lock, headless services with selector-
 * less semantics, etc.).
 */
export const SERVICE_SKIP_ANNOTATIONS = new Set<string>(["control-plane.alpha.kubernetes.io/leader"]);

/**
 * IngressClass names that are managed by the platform and never created as
 * cluster-scoped IngressClass resources. Skip the "missing IngressClass"
 * check for these.
 */
export const BUILTIN_INGRESS_CLASSES = new Set<string>(["gce", "gce-internal"]);

/** GCP Cloud Logging severities treated as error-level. */
export const ERROR_LOG_SEVERITIES = new Set<string>(["ERROR", "CRITICAL", "ALERT", "EMERGENCY"]);

/** Helpers ------------------------------------------------------------- */

export function isUnhealthyWaiting(reason: string | undefined): boolean {
  return reason !== undefined && WAITING_REASON_FAILURES.has(reason);
}

export function isUnhealthyTermination(reason: string | undefined): boolean {
  return reason !== undefined && TERMINATION_REASON_FAILURES.has(reason);
}

export function isFailureEventReason(reason: string | undefined): boolean {
  return reason !== undefined && EVENT_REASON_FAILURES.has(reason);
}
