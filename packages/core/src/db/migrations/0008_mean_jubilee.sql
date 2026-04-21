ALTER TABLE "node_history" DROP CONSTRAINT "node_history_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "node_history" ADD CONSTRAINT "node_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;