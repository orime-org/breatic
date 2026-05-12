/**
 * ExportPicker — workflow import / export dropdown. Mock 05 @1111
 * sits between CreditsPill and SharePopover.
 *
 * Carries the heavy lifting extracted from the old `ProjectHeader`:
 *   - Import: file picker → DOMPurify sanitize → JSON parse → Zod
 *     validate → remap node + edge ids → append to canvas.
 *   - Export: snapshot current canvas nodes + edges (with or without
 *     per-node result data) → JSON blob → trigger browser download.
 *
 * Both flows surface a global loading overlay so the user knows long
 * imports aren't stuck.
 */
import { memo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { type Node, type Edge } from '@xyflow/react';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import DOMPurify from 'dompurify';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import Loading from '@/app/shell/loading/Loading';
import { message } from '@/ui/message';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';

const WorkflowNodeSchema = z
  .object({
    id: z.string().min(1, 'Node id is required'),
    type: z.string().min(1, 'Node type is required'),
    position: z.object({ x: z.number(), y: z.number() }),
  })
  .catchall(z.unknown());

const WorkflowEdgeSchema = z
  .object({
    source: z.string().min(1, 'Edge source is required'),
    target: z.string().min(1, 'Edge target is required'),
  })
  .catchall(z.unknown());

const WorkflowDataSchema = z
  .object({
    nodes: z.array(WorkflowNodeSchema).min(0),
    edges: z.array(WorkflowEdgeSchema).min(0),
  })
  .catchall(z.unknown());

type WorkflowData = z.infer<typeof WorkflowDataSchema>;

function validateWorkflowData(data: unknown): { valid: boolean; error?: string; data?: WorkflowData } {
  try {
    const sanitized = typeof data === 'string'
      ? DOMPurify.sanitize(data, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
      : data;
    const result = WorkflowDataSchema.safeParse(sanitized);
    if (result.success) return { valid: true, data: result.data };
    const errors = result.error.issues.map((iss) => {
      const path = iss.path.join('.');
      return path ? `${path}: ${iss.message}` : iss.message;
    });
    return { valid: false, error: `Validation failed: ${errors.join('; ')}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

const DownloadGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export interface ExportPickerProps {
  projectName: string;
}

const ExportPicker: React.FC<ExportPickerProps> = memo(function ExportPicker({ projectName }) {
  const { t } = useTranslation();
  const { nodes, edges } = useCanvasData();
  const { setNodes, setEdges } = useCanvasActions();
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const downloadJson = useCallback((workflowData: object) => {
    const dataStr = JSON.stringify(workflowData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${projectName || 'workflow'}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [projectName]);

  const handleExport = useCallback(async (includeResources: boolean) => {
    setIsExporting(true);
    try {
      const idMap = new Map<string, string>();
      nodes.forEach((node, index) => idMap.set(node.id, `node-${index + 1}`));
      const processedNodes = nodes.map((node) => {
        const newData = includeResources ? node.data : { ...node.data };
        if (!includeResources) {
          if ((newData as { nodeResultData?: unknown }).nodeResultData !== undefined) {
            (newData as { nodeResultData: unknown[] }).nodeResultData = [];
          }
          if ((newData as { nodeSelectedResultData?: unknown }).nodeSelectedResultData !== undefined) {
            (newData as { nodeSelectedResultData: object }).nodeSelectedResultData = {};
          }
        }
        return { ...node, id: idMap.get(node.id) || node.id, data: newData };
      });
      const processedEdges = edges.map((edge) => ({
        ...edge,
        source: idMap.get(edge.source) || edge.source,
        target: idMap.get(edge.target) || edge.target,
      }));
      downloadJson({
        nodes: processedNodes,
        edges: processedEdges,
        exportedAt: new Date().toISOString(),
        version: '1.0.0',
        includeResources,
      });
      message.success(t('project.header.exportSuccessful'));
    } catch (e) {
      console.error('Export error:', e);
      message.error(t('project.header.exportFailed'));
    } finally {
      setIsExporting(false);
    }
  }, [nodes, edges, downloadJson, t]);

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      setIsImporting(true);
      try {
        const rawText = await file.text();
        const sanitized = DOMPurify.sanitize(rawText, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
        let parsed: unknown;
        try {
          parsed = JSON.parse(sanitized);
        } catch {
          throw new Error('Invalid JSON format');
        }
        const validation = validateWorkflowData(parsed);
        if (!validation.valid || !validation.data) {
          throw new Error(validation.error || 'Invalid workflow data');
        }
        const data = validation.data;
        const idMap = new Map<string, string>();
        const processedNodes = (data.nodes as Node[]).map((n) => {
          const newId = `${n.type}-${Date.now()}-${nanoid(5)}`;
          idMap.set(n.id, newId);
          return { ...n, id: newId };
        });
        const processedEdges = (data.edges as Edge[]).map((edge) => ({
          ...edge,
          source: idMap.get(edge.source) || edge.source,
          target: idMap.get(edge.target) || edge.target,
        }));
        setNodes([...nodes, ...processedNodes]);
        setEdges([...edges, ...processedEdges]);
        message.success(t('project.header.importSuccessful'));
      } catch (e) {
        console.error('Import error:', e);
        message.error(t('project.header.importFailed'));
      } finally {
        setIsImporting(false);
        if (document.body.contains(input)) document.body.removeChild(input);
      }
    };
    document.body.appendChild(input);
    input.click();
  }, [nodes, edges, setNodes, setEdges, t]);

  const items: MenuItemType[] = [
    { key: 'import', label: t('project.header.importWorkflow') },
    { key: 'export-with-resources', label: t('project.header.exportWithResources') },
    { key: 'export-without-resources', label: t('project.header.exportWithoutResources') },
  ];

  const handleClick = (key: string) => {
    if (key === 'import') handleImport();
    else if (key === 'export-with-resources') handleExport(true);
    else if (key === 'export-without-resources') handleExport(false);
  };

  return (
    <>
      {(isImporting || isExporting) && (
        <Loading text={isExporting ? t('project.header.exporting') : t('project.header.importing')} />
      )}
      <Dropdown items={items} onClick={handleClick} trigger='click' placement='bottom-end'>
        <button
          type='button'
          title={t('project.header.exportImport', { defaultValue: 'Export / Import' })}
          className='inline-flex items-center justify-center w-8 h-8 rounded-sm text-text-default-secondary hover:bg-background-default-secondary hover:text-text-default-base transition-colors'
        >
          <DownloadGlyph />
        </button>
      </Dropdown>
    </>
  );
});

export default ExportPicker;
