-- Announce every committed change to project_members (inner#911).
--
-- collab authorizes a connection once, at the handshake, from this table. A
-- connection only learns that its holder's membership changed when collab is
-- told, and the trigger tells it on every write, whichever code path made it.
-- NOTIFY is delivered at commit and dropped on rollback. The channel name is
-- PROJECT_MEMBER_CHANGED_CHANNEL in packages/core/src/infra/member-change-listener.ts.

CREATE FUNCTION "notify_project_member_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r project_members;
BEGIN
  IF TG_OP = 'DELETE' THEN
    r := OLD;
  ELSE
    r := NEW;
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD.role IS NOT DISTINCT FROM NEW.role
    AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at
    AND OLD.project_id IS NOT DISTINCT FROM NEW.project_id
    AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id THEN
    RETURN NULL;
  END IF;
  -- A row moved to another project or user leaves the old pair as stale as
  -- the new one.
  IF TG_OP = 'UPDATE'
    AND (OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.user_id IS DISTINCT FROM NEW.user_id) THEN
    PERFORM pg_notify(
      'project_member_changed',
      json_build_object('projectId', OLD.project_id, 'userId', OLD.user_id)::text
    );
  END IF;
  PERFORM pg_notify(
    'project_member_changed',
    json_build_object('projectId', r.project_id, 'userId', r.user_id)::text
  );
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "project_members_notify_change"
AFTER INSERT OR UPDATE OR DELETE ON "project_members"
FOR EACH ROW EXECUTE FUNCTION "notify_project_member_change"();
