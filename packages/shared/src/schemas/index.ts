// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** Shared Zod schemas for API request validation. */
export {
  registerSchema,
  setupStudioSchema,
  SLUG_REGEX,
  loginSchema,
  googleAuthSchema,
  chatMessageSchema,
  chatAttachedChipSchema,
  skillCommandSchema,
  taskCreateSchema,
  understandSchema,
  projectCreateSchema,
  checkoutSchema,
  paginationSchema,
  chatConversationsQuerySchema,
} from "@shared/schemas/api.js";

export type {
  RegisterInput,
  SetupStudioInput,
  LoginInput,
  ChatMessageInput,
  ChatAttachedChip,
  SkillCommandInput,
  TaskCreateInput,
  UnderstandInput,
  ProjectCreateInput,
  CheckoutInput,
  PaginationInput,
  ChatConversationsQueryInput,
} from "@shared/schemas/api.js";
