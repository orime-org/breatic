-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: Elastic-2.0

-- Product database (#1378): stored fields named after the person using the
-- product move from reader to user. A tool failure's readerKey inside
-- conversation_messages.parts becomes userKey; reader_locale in tasks.params
-- and in node_history.metadata.params becomes user_locale. Where both names
-- are present the new one keeps its value. Rows already on the new names do
-- not match, so the SQL runs again with no change; #1387 replays it in a
-- migration file of its own to rename what was written during the deploy.
--
-- Rollback, run by hand:
--   UPDATE conversation_messages AS m SET parts = (
--     SELECT jsonb_agg(CASE WHEN jsonb_typeof(e.elem->'failure') = 'object' AND e.elem->'failure' ? 'userKey'
--       THEN jsonb_set(e.elem, '{failure}', ((e.elem->'failure') - 'userKey')
--         || jsonb_build_object('readerKey', e.elem->'failure'->'userKey'))
--       ELSE e.elem END ORDER BY e.ord)
--     FROM jsonb_array_elements(m.parts) WITH ORDINALITY AS e(elem, ord))
--   WHERE jsonb_typeof(m.parts) = 'array' AND EXISTS (
--     SELECT 1 FROM jsonb_array_elements(m.parts) AS x(elem)
--     WHERE jsonb_typeof(x.elem->'failure') = 'object' AND x.elem->'failure' ? 'userKey');
--   UPDATE tasks SET params = (params - 'user_locale')
--     || jsonb_build_object('reader_locale', params->'user_locale')
--   WHERE jsonb_typeof(params) = 'object' AND params ? 'user_locale';
--   UPDATE node_history SET metadata = jsonb_set(metadata, '{params}', ((metadata->'params') - 'user_locale')
--     || jsonb_build_object('reader_locale', metadata->'params'->'user_locale'))
--   WHERE jsonb_typeof(metadata->'params') = 'object' AND metadata->'params' ? 'user_locale';
UPDATE conversation_messages AS m
SET parts = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(e.elem->'failure') = 'object' AND e.elem->'failure' ? 'readerKey'
      THEN jsonb_set(
        e.elem,
        '{failure}',
        ((e.elem->'failure') - 'readerKey')
          || jsonb_build_object('userKey', coalesce(e.elem->'failure'->'userKey', e.elem->'failure'->'readerKey'))
      )
      ELSE e.elem
    END
    ORDER BY e.ord
  )
  FROM jsonb_array_elements(m.parts) WITH ORDINALITY AS e(elem, ord)
)
WHERE m.parts::text LIKE '%"readerKey"%'
  AND jsonb_typeof(m.parts) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(m.parts) AS x(elem)
    WHERE jsonb_typeof(x.elem->'failure') = 'object' AND x.elem->'failure' ? 'readerKey'
  );
--> statement-breakpoint
UPDATE tasks
SET params = (params - 'reader_locale')
  || jsonb_build_object('user_locale', coalesce(params->'user_locale', params->'reader_locale'))
WHERE jsonb_typeof(params) = 'object' AND params ? 'reader_locale';
--> statement-breakpoint
UPDATE node_history
SET metadata = jsonb_set(
  metadata,
  '{params}',
  ((metadata->'params') - 'reader_locale')
    || jsonb_build_object('user_locale', coalesce(metadata->'params'->'user_locale', metadata->'params'->'reader_locale'))
)
WHERE jsonb_typeof(metadata->'params') = 'object' AND metadata->'params' ? 'reader_locale';
