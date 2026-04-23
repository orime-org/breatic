/**
 * Legacy name used by the standalone video editor export panel.
 * Canvas writes use {@link useCanvasActions} in the main project app.
 */
export function useProjectStore() {
  return {
    updateNode: (_nodeId: string, _updates: unknown) => {},
    addNewResultFlag: (_nodeId: string, _type: string) => {},
    newResultsFlag: [] as { nodeId: string; type: 'exported'; time: number }[],
  };
}
