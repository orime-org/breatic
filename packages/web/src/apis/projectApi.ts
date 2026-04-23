/**
 * Stubs for legacy video editor export upload paths.
 * The standalone `/video_editor` route does not call these (local download only).
 */

export async function getOssStsApi(_params: {
  asset_type: string;
}): Promise<{ data: Record<string, string> }> {
  throw new Error('OSS is not configured in this build.');
}

export async function uploadFileSuccessApi(_params: Record<string, unknown>): Promise<{
  data: { resource_url: string };
}> {
  throw new Error('Upload API is not configured in this build.');
}

export async function saveWorkflowApi(_params: Record<string, unknown>): Promise<void> {
  throw new Error('Workflow API is not configured in this build.');
}
