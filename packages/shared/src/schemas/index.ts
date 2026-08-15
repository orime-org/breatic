// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** Shared Zod schemas for API request validation. */
export {
  registerSchema,
  setupStudioSchema,
  createTeamStudioSchema,
  updateStudioSchema,
  SLUG_REGEX,
  RESERVED_STUDIO_SLUGS,
  STUDIO_SLUG_BOUNDS,
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
  chatOpenSchema,
  chatEarlierMessagesQuerySchema,
  chatCreateConversationSchema,
  chatRenameConversationSchema,
} from "@shared/schemas/api.js";

export type {
  RegisterInput,
  SetupStudioInput,
  CreateTeamStudioInput,
  UpdateStudioInput,
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
  ChatCreateConversationInput,
  ChatRenameConversationInput,
} from "@shared/schemas/api.js";
