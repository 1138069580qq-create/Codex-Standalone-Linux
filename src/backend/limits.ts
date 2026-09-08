import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import path from "path";

export interface CodexQuotaWindow {
  id: string;
  bucketId?: string;
  name?: string;
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
  limitName?: string;
  planType?: string;
  rateLimitReachedType?: string;
}
export interface CodexResetCredit {
  id: string;
  resetType?: string;
  status?: string;
  grantedAt?: number;
  expiresAt?: number | null;
  title?: string | null;
  description?: string | null;
}
export interface CodexResetCredits {
  availableCount: number;
  details: CodexResetCredit[];
}
export interface CodexRateLimits {
  windows: CodexQuotaWindow[];
  resetCredits: CodexResetCredits | null;
  fetchedAt: number;
}
function object(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}
function boundedPercent(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}
function window(value: unknown, id: string, name?: string): CodexQuotaWindow | null {
  const input = object(value);
  if (!input) return null;
  if (
    input.usedPercent === undefined &&
    input.windowDurationMins === undefined &&
    input.resetsAt === undefined
  )
    return null;
  const result: CodexQuotaWindow = { id, name, usedPercent: boundedPercent(input.usedPercent) };
  if (
    typeof input.windowDurationMins === "number" &&
    Number.isFinite(input.windowDurationMins) &&
    input.windowDurationMins > 0
  )
    result.windowDurationMins = Math.floor(input.windowDurationMins);
  if (typeof input.resetsAt === "number" && Number.isFinite(input.resetsAt) && input.resetsAt > 0)
    result.resetsAt = Math.floor(input.resetsAt);
  if (typeof input.limitName === "string") result.limitName = input.limitName.slice(0, 120);
  if (typeof input.planType === "string") result.planType = input.planType.slice(0, 80);
  if (typeof input.rateLimitReachedType === "string")
    result.rateLimitReachedType = input.rateLimitReachedType.slice(0, 80);
  return result;
}
function normalizeResetCredits(value: unknown): CodexResetCredits | null {
  const input = object(value);
  if (!input) return null;
  const details = Array.isArray(input.details) ? input.details : [];
  const safeDetails: CodexResetCredit[] = [];
  for (const item of details.slice(0, 100)) {
    const credit = object(item);
    if (!credit || typeof credit.id !== "string" || !credit.id || credit.id.length > 256) continue;
    safeDetails.push({
      id: credit.id,
      ...(typeof credit.resetType === "string" ? { resetType: credit.resetType.slice(0, 80) } : {}),
      ...(typeof credit.status === "string" ? { status: credit.status.slice(0, 80) } : {}),
      ...(typeof credit.grantedAt === "number" ? { grantedAt: credit.grantedAt } : {}),
      ...(credit.expiresAt === null || typeof credit.expiresAt === "number"
        ? { expiresAt: credit.expiresAt }
        : {}),
      ...(credit.title === null || typeof credit.title === "string"
        ? { title: typeof credit.title === "string" ? credit.title.slice(0, 160) : null }
        : {}),
      ...(credit.description === null || typeof credit.description === "string"
        ? {
            description:
              typeof credit.description === "string" ? credit.description.slice(0, 500) : null
          }
        : {})
    });
  }
  const availableCount = Number.isSafeInteger(input.availableCount)
    ? Math.max(0, Math.min(100, input.availableCount))
    : safeDetails.length;
  return { availableCount, details: safeDetails };
}
/** Normalize the account payload while omitting opaque/secret fields from the browser response. */
export function normalizeRateLimits(raw: unknown, fetchedAt = Date.now()): CodexRateLimits {
  const input = object(raw) || {};
  const windows: CodexQuotaWindow[] = [];
  const byId = object(input.rateLimitsByLimitId);
  if (byId)
    for (const [id, value] of Object.entries(byId)) {
      const input = object(value);
      if (input && (input.primary || input.secondary)) {
        for (const key of ["primary", "secondary"]) {
          const item = window(input[key], `${id}.${key}`, input.limitName);
          if (item) { item.bucketId=id; if(typeof input.planType === "string") item.planType=input.planType.slice(0,80); windows.push(item); }
        }
      } else {
        const item = window(value, id, input?.limitName);
        if (item) { item.bucketId=id; windows.push(item); }
      }
    }
  const legacy = object(input.rateLimits);
  // The legacy snapshot mirrors a by-id bucket; never append it twice.
  if (legacy && !windows.length) {
    for (const key of ["primary", "secondary"]) {
      const item = window(legacy[key], key, object(legacy[key])?.limitName);
      if (item && !windows.some((current) => current.id === item.id)) windows.push(item);
    }
    if (!windows.length)
      for (const [id, value] of Object.entries(legacy)) {
        const item = window(value, id, object(value)?.limitName);
        if (item) windows.push(item);
      }
  }
  windows.sort(
    (left, right) =>
      (left.windowDurationMins || Number.MAX_SAFE_INTEGER) -
      (right.windowDurationMins || Number.MAX_SAFE_INTEGER)
  );
  return {
    windows: windows.filter((v,index,all)=>all.findIndex(other=>
      other.bucketId===v.bucketId && other.windowDurationMins===v.windowDurationMins && other.resetsAt===v.resetsAt && other.usedPercent===v.usedPercent
    )===index).slice(0,20),
    resetCredits: normalizeResetCredits(input.rateLimitResetCredits),
    fetchedAt
  };
}
