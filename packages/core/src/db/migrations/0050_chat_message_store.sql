-- Messages move out of a JSONB array into a row per message.
--
-- `conversations.messages` held the entire history in one column, so every
-- appended message rewrote and re-compressed the whole document while holding a
-- lock on the conversation row — cost growing with the square of the length.
-- Postgres' own guidance is that a JSON document should be an atomic datum;
-- a single message is, a conversation is not.
--
-- Backfill and drop happen in the same migration: leaving the old column
-- behind would leave two sources of truth with nothing marking which is live.

CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"turn_index" integer NOT NULL,
	"seq" integer NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Two messages can never claim the same slot in a turn. This is what stops a
-- racing append from computing a turn index that is already taken, which would
-- collide on the billing idempotency key `turn:<conversation>:<index>`.
CREATE UNIQUE INDEX "conversation_messages_turn_seq_key" ON "conversation_messages" USING btree ("conversation_id","turn_index","seq");--> statement-breakpoint

-- The array is exploded in SQL rather than looped over in the application, so
-- the whole move is one statement inside this migration's transaction.
-- `WITH ORDINALITY` is what preserves the original order; without it the
-- element order of a jsonb array read back out is not something to rely on.
--
-- The flat message shape maps onto parts like this: prose becomes a `text`
-- part, `thinking` a `reasoning` part, each entry of `tool_calls` a `tool-call`
-- part, and a `role='tool'` message a single `tool-result` part. Reasoning
-- comes first because it precedes the prose it produced.
--
-- The markers below are load-bearing: the migration test reads this exact
-- statement out of this file and runs it against a reconstructed old column,
-- so the backfill that ships is the backfill that was verified.
-- >>> backfill
INSERT INTO "conversation_messages"
  ("conversation_id", "user_id", "role", "turn_index", "seq", "parts", "deleted_at", "created_at", "updated_at")
SELECT
  c."id",
  c."user_id",
  COALESCE(m.value->>'role', 'assistant'),
  COALESCE((m.value->>'turnIndex')::int, 0),
  (row_number() OVER (
     PARTITION BY c."id", COALESCE((m.value->>'turnIndex')::int, 0)
     ORDER BY m.ord
   ))::int - 1,
  CASE
    WHEN m.value->>'role' = 'tool' THEN
      jsonb_build_array(jsonb_build_object(
        'type', 'tool-result',
        'toolCallId', COALESCE(m.value->>'tool_call_id', ''),
        'toolName', COALESCE(m.value->>'name', ''),
        'output', COALESCE(m.value->>'content', '')
      ))
    ELSE
      CASE
        WHEN COALESCE(m.value->>'thinking', '') <> '' THEN
          jsonb_build_array(jsonb_build_object('type', 'reasoning', 'text', m.value->>'thinking'))
        ELSE '[]'::jsonb
      END
      ||
      CASE
        WHEN COALESCE(m.value->>'content', '') <> '' THEN
          jsonb_build_array(jsonb_build_object('type', 'text', 'text', m.value->>'content'))
        ELSE '[]'::jsonb
      END
      ||
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'type', 'tool-call',
            'toolCallId', COALESCE(tc->>'id', ''),
            'toolName', COALESCE(tc->>'name', ''),
            'input', COALESCE(tc->'arguments', '{}'::jsonb)
          )
          || CASE WHEN tc ? 'result' THEN jsonb_build_object('output', tc->'result') ELSE '{}'::jsonb END
          ORDER BY tc_ord
        )
        FROM jsonb_array_elements(m.value->'tool_calls') WITH ORDINALITY AS t(tc, tc_ord)
      ), '[]'::jsonb)
  END,
  -- A deleted conversation's messages are deleted too. The FK is RESTRICT so
  -- Postgres never cascades, which makes that a rule the application keeps by
  -- hand — and this statement is the one place rows are written without going
  -- through it. Miss it and every conversation deleted before this migration
  -- keeps messages marked alive forever, since deleting an already-deleted
  -- conversation is refused before the cascade can run.
  c."deleted_at",
  COALESCE((m.value->>'ts')::timestamptz, c."created_at"),
  COALESCE((m.value->>'ts')::timestamptz, c."created_at")
FROM "conversations" c
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c."messages", '[]'::jsonb)) WITH ORDINALITY AS m(value, ord);
-- <<< backfill
--> statement-breakpoint

ALTER TABLE "conversations" DROP COLUMN "messages";
