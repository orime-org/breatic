-- Each message as it was sent to the model (inner#1549), so later turns replay
-- it byte for byte and the provider's cached prefix still matches. `json`, not
-- `jsonb`: jsonb reorders an object's keys, which changes a tool call's
-- arguments as sent. Rows written before this have none and are rendered from
-- `parts` as before.
ALTER TABLE "conversation_messages" ADD COLUMN "for_model" json;
