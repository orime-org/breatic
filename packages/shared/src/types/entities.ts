/**
 * Shared entity interfaces for cross-layer data transfer.
 *
 * These are the "clean" types that cross layer boundaries — routes,
 * services, and the frontend all use these. ORM/Drizzle types stay
 * inside the server package.
 */

/** User entity (excludes hashed_password for safety). */
export interface UserEntity {
  id: string;
  email: string;
  username: string | null;
  avatarUrl: string | null;
  credits: number;
  membershipType: string;
  membershipExpiresAt: Date | null;
  emailVerified: boolean;
  googleId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Conversation entity (without inline messages). */
export interface ConversationEntity {
  id: string;
  userId: string;
  title: string;
  projectId: string | null;
  /** Turn index up to which messages have been consolidated into memory. */
  lastConsolidatedTurn: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Structured tool call info within a message. */
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Single message within a conversation. */
export interface MessageData {
  role: "user" | "assistant" | "tool";
  content: string;
  ts: string;
  /** Turn index — increments on each user message. */
  turnIndex: number;
  /** Model reasoning/thinking content (not sent back to LLM). */
  thinking?: string;
  tool_calls?: ToolCallInfo[];
  tool_call_id?: string;
  name?: string;
}

/** Task entity. */
export interface TaskEntity {
  id: string;
  userId: string;
  projectId: string | null;
  taskType: string;
  model: string | null;
  skillName: string | null;
  status: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  arqJobId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  creditsUsed: number;
  durationMs: number | null;
  resolvedSkills: string[];
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Kinds of uploadable assets. */
export type AssetKind = "image" | "video" | "audio" | "3d" | "document";

/** Conversation attachment — per-conversation reference pool. */
export interface ConversationAttachmentEntity {
  id: string;
  conversationId: string;
  userId: string;
  url: string;
  thumbnailUrl: string | null;
  name: string;
  mimeType: string;
  size: number;
  kind: AssetKind;
  deletedAt: Date | null;
  createdAt: Date;
}

/** Node history entry — per-node content timeline (generation + upload). */
export interface NodeHistoryEntity {
  id: string;
  projectId: string;
  nodeId: string;
  userId: string;
  entryType: "generation" | "upload";
  status: "success" | "failed";
  content: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  taskId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** Payment entity. */
export interface PaymentEntity {
  id: string;
  userId: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  amountCents: number;
  currency: string;
  status: string;
  creditsGranted: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Credit transaction entity. */
export interface CreditTransactionEntity {
  id: string;
  userId: string;
  txType: string;
  amount: number;
  balanceAfter: number;
  tokensUsed: number | null;
  model: string | null;
  provider: string | null;
  description: string | null;
  referenceId: string | null;
  createdAt: Date;
}

/** Project entity. */
export interface ProjectEntity {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  canvasData: Record<string, unknown>;
  thumbnailUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Three-layer memory context for LLM prompts. */
export interface MemoryContext {
  userMemory: string;
  projectMemory: string;
  conversationMemory: string;
}

/** Skill metadata (from built-in SkillRegistry). */
export interface SkillMeta {
  name: string;
  description: string;
  category: string;
  tools: string[];
  outputType: string;
  keywords: string[];
}
