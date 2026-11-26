-- Announce committed changes behind the bell, a Project's transfer and a Studio's credits (#1580).
--
-- A Project page learns that one of these changed only when collab tells it, and the triggers tell collab on every
-- write, whichever code path made it. NOTIFY is delivered at commit and dropped on rollback. The channel name is
-- LIVE_UPDATES_CHANNEL in packages/core/src/infra/member-change-listener.ts. Each payload names the kind and one id,
-- nothing of the row's content.
--
-- The credit columns are the ones the credits figure reads (getCreditPosition: spendable lots, held holds, debt). A
-- lot, hold or debt row that moves to another Studio tells both Studios; a lot designated to no Studio tells none.
--
-- upload_grants also gains focus_image: a focus crop's target in its node's pool, written by the ticket and read at
-- the finish that registers the crop.

CREATE FUNCTION "notify_live_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'notifications' THEN
    IF TG_OP = 'INSERT' OR OLD.read_at IS DISTINCT FROM NEW.read_at OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
      PERFORM pg_notify('live_updates', json_build_object('k', 'notifications', 'u', NEW.user_id)::text);
    END IF;
  ELSIF TG_TABLE_NAME = 'project_transfers' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
      PERFORM pg_notify('live_updates', json_build_object('k', 'project-transfer', 'p', NEW.project_id)::text);
    END IF;
  ELSIF TG_TABLE_NAME = 'credit_lots' THEN
    IF TG_OP = 'UPDATE' AND OLD.designated_studio_id IS DISTINCT FROM NEW.designated_studio_id THEN
      IF OLD.designated_studio_id IS NOT NULL THEN
        PERFORM pg_notify('live_updates', json_build_object('k', 'credits', 's', OLD.designated_studio_id)::text);
      END IF;
      IF NEW.designated_studio_id IS NOT NULL THEN
        PERFORM pg_notify('live_updates', json_build_object('k', 'credits', 's', NEW.designated_studio_id)::text);
      END IF;
    ELSIF NEW.designated_studio_id IS NOT NULL AND (
      TG_OP = 'INSERT'
      OR OLD.remaining_credits IS DISTINCT FROM NEW.remaining_credits
      OR OLD.lifecycle IS DISTINCT FROM NEW.lifecycle
      OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    ) THEN
      PERFORM pg_notify('live_updates', json_build_object('k', 'credits', 's', NEW.designated_studio_id)::text);
    END IF;
  ELSIF TG_TABLE_NAME = 'credit_holds' THEN
    IF TG_OP = 'UPDATE' AND OLD.studio_id IS DISTINCT FROM NEW.studio_id THEN
      PERFORM pg_notify('live_updates', json_build_object('k', 'credits', 's', OLD.studio_id)::text);
      PERFORM pg_notify('live_updates', json_build_object('k', 'credits', 's', NEW.studio_id)::text);
    ELSIF TG_OP = 'INSERT'
      OR OLD.status IS DISTINCT FROM NEW.status
      OR OLD.amount IS DISTINCT FROM NEW.amount
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
      PERFORM pg_notify('live_updates', json_build_object('k', 'credits', 's', NEW.studio_id)::text);
    END IF;
  ELSIF TG_TABLE_NAME = 'studio_credit_debts' THEN
    IF TG_OP = 'UPDATE' AND OLD.studio_id IS DISTINCT FROM NEW.studio_id THEN
      PERFORM pg_notify('live_updates', json_build_object('k', 'credits', 's', OLD.studio_id)::text);
      PERFORM pg_notify('live_updates', json_build_object('k', 'credits', 's', NEW.studio_id)::text);
    ELSIF TG_OP = 'INSERT' OR OLD.amount IS DISTINCT FROM NEW.amount THEN
      PERFORM pg_notify('live_updates', json_build_object('k', 'credits', 's', NEW.studio_id)::text);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "notifications_notify_live_update"
AFTER INSERT OR UPDATE ON "notifications"
FOR EACH ROW EXECUTE FUNCTION "notify_live_update"();--> statement-breakpoint

CREATE TRIGGER "project_transfers_notify_live_update"
AFTER INSERT OR UPDATE ON "project_transfers"
FOR EACH ROW EXECUTE FUNCTION "notify_live_update"();--> statement-breakpoint

CREATE TRIGGER "credit_lots_notify_live_update"
AFTER INSERT OR UPDATE ON "credit_lots"
FOR EACH ROW EXECUTE FUNCTION "notify_live_update"();--> statement-breakpoint

CREATE TRIGGER "credit_holds_notify_live_update"
AFTER INSERT OR UPDATE ON "credit_holds"
FOR EACH ROW EXECUTE FUNCTION "notify_live_update"();--> statement-breakpoint

CREATE TRIGGER "studio_credit_debts_notify_live_update"
AFTER INSERT OR UPDATE ON "studio_credit_debts"
FOR EACH ROW EXECUTE FUNCTION "notify_live_update"();--> statement-breakpoint

ALTER TABLE "upload_grants" ADD COLUMN "focus_image" jsonb;
