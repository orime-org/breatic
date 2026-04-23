type OssCreds = Record<string, unknown>;

export function createOssClient(_creds: OssCreds, _assetType: string) {
  return {
    put: async (_name: unknown, _file: unknown, _options?: unknown): Promise<never> => {
      throw new Error('OSS client is not configured in this build.');
    },
  };
}
