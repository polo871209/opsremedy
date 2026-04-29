import { describe, expect, it } from "bun:test";
import {
  ERROR_LOG_SEVERITIES,
  EVENT_REASON_FAILURES,
  isFailureEventReason,
  isUnhealthyTermination,
  isUnhealthyWaiting,
  TERMINATION_REASON_FAILURES,
  UNHEALTHY_CONTAINER_REASONS,
  WAITING_REASON_FAILURES,
} from "./checks.ts";

describe("waiting reason catalog", () => {
  it("classifies CrashLoopBackOff and ImagePullBackOff as failures", () => {
    expect(isUnhealthyWaiting("CrashLoopBackOff")).toBe(true);
    expect(isUnhealthyWaiting("ImagePullBackOff")).toBe(true);
  });
  it("does not classify PodInitializing/ContainerCreating", () => {
    expect(isUnhealthyWaiting("PodInitializing")).toBe(false);
    expect(isUnhealthyWaiting("ContainerCreating")).toBe(false);
    expect(isUnhealthyWaiting(undefined)).toBe(false);
  });
});

describe("termination reason catalog", () => {
  it("classifies OOMKilled and Evicted as failures", () => {
    expect(isUnhealthyTermination("OOMKilled")).toBe(true);
    expect(isUnhealthyTermination("Evicted")).toBe(true);
  });
  it("does not classify Completed", () => {
    expect(isUnhealthyTermination("Completed")).toBe(false);
  });
});

describe("combined container reason set", () => {
  it("includes both waiting and termination reasons", () => {
    for (const r of WAITING_REASON_FAILURES) expect(UNHEALTHY_CONTAINER_REASONS.has(r)).toBe(true);
    for (const r of TERMINATION_REASON_FAILURES) expect(UNHEALTHY_CONTAINER_REASONS.has(r)).toBe(true);
  });
});

describe("event reason catalog", () => {
  it("classifies BackOff/FailedScheduling/ProvisioningFailed", () => {
    expect(isFailureEventReason("BackOff")).toBe(true);
    expect(isFailureEventReason("FailedScheduling")).toBe(true);
    expect(isFailureEventReason("ProvisioningFailed")).toBe(true);
  });
  it("excludes Pulled/Created/Started", () => {
    expect(EVENT_REASON_FAILURES.has("Pulled")).toBe(false);
    expect(EVENT_REASON_FAILURES.has("Created")).toBe(false);
  });
});

describe("error log severities", () => {
  it("includes ERROR/CRITICAL/ALERT/EMERGENCY", () => {
    expect(ERROR_LOG_SEVERITIES.has("ERROR")).toBe(true);
    expect(ERROR_LOG_SEVERITIES.has("CRITICAL")).toBe(true);
    expect(ERROR_LOG_SEVERITIES.has("ALERT")).toBe(true);
    expect(ERROR_LOG_SEVERITIES.has("EMERGENCY")).toBe(true);
  });
  it("excludes WARNING/INFO/DEBUG", () => {
    expect(ERROR_LOG_SEVERITIES.has("WARNING")).toBe(false);
    expect(ERROR_LOG_SEVERITIES.has("INFO")).toBe(false);
  });
});
