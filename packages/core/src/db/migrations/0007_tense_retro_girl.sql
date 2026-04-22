ALTER TABLE "conversation_attachments" DROP CONSTRAINT "conversation_attachments_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_memories" DROP CONSTRAINT "conversation_memories_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "credit_transactions" DROP CONSTRAINT "credit_transactions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "custom_skills" DROP CONSTRAINT "custom_skills_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_history_entries" DROP CONSTRAINT "memory_history_entries_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "node_history" DROP CONSTRAINT "node_history_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "project_memories" DROP CONSTRAINT "project_memories_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "project_memory_entries" DROP CONSTRAINT "project_memory_entries_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_installs" DROP CONSTRAINT "skill_installs_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_installs" DROP CONSTRAINT "skill_installs_skill_id_custom_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_memories" DROP CONSTRAINT "user_memories_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_memory_entries" DROP CONSTRAINT "user_memory_entries_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_memories" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_history_entries" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_memories" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_memory_entries" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_memory_entries" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_memories" ADD CONSTRAINT "conversation_memories_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_skills" ADD CONSTRAINT "custom_skills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_history_entries" ADD CONSTRAINT "memory_history_entries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_history" ADD CONSTRAINT "node_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memory_entries" ADD CONSTRAINT "project_memory_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_skill_id_custom_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."custom_skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_entries" ADD CONSTRAINT "user_memory_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;