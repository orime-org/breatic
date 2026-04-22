/** Application environment. */
export const Environment = {
  DEV: "dev",
  STAGING: "staging",
  PROD: "prod",
} as const;

/** Application environment type. */
export type Environment = (typeof Environment)[keyof typeof Environment];

/** Login mode — whether accounts are required. */
export const LoginMode = {
  WITH_ACCOUNT: "WithAccount",
  NO_ACCOUNT: "NoAccount",
} as const;

/** Login mode type. */
export type LoginMode = (typeof LoginMode)[keyof typeof LoginMode];

/**
 * Dev user ID for NoAccount mode (valid UUID for DB FK compatibility).
 * Used by API auth middleware and Collab auth hook.
 */
export const DEV_USER_ID = "00000000-0000-0000-0000-000000000000";

/** Task execution status. */
export const TaskStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

/** Task execution status type. */
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** Storage provider. */
export const StorageProvider = {
  S3: "s3",
  ALIYUN_OSS: "aliyun_oss",
} as const;

/** Storage provider type. */
export type StorageProvider =
  (typeof StorageProvider)[keyof typeof StorageProvider];
