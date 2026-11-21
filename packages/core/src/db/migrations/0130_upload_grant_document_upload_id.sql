-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: AGPL-3.0-only

-- The Document body block an upload's result is written into (breatic#1574), as node_id names the canvas node.
ALTER TABLE upload_grants ADD COLUMN document_upload_id text;
