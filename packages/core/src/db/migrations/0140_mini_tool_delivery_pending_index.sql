-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

CREATE INDEX tasks_mini_tool_delivery_pending_idx ON tasks (id)
  WHERE source = 'mini_tool' AND status IN ('completed', 'failed')
    AND params->'miniToolExecution' IS NOT NULL
    AND jsonb_path_exists(result, '$.miniToolExecution.outputs[*] ? (@.result.status == "registered")')
    AND (result->'miniToolDelivery' IS NULL
      OR jsonb_path_exists(result, '$.miniToolDelivery.outputs[*] ? (@.state == "pending")'));
