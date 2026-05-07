import React, { memo, useState, useEffect } from 'react';
import { message } from '@/ui/message';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import type { RootState } from '@/store';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';
import { type Node, type Edge } from '@xyflow/react';
import i18n from '@/i18n';
import { Icon } from '@/ui/icon';
import Loading from '@/components/loading/Loading';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import DOMPurify from 'dompurify';
import { cn } from '@/utils/classnames';
import './ProjectHeader.css';

interface ProjectHeaderProps {
  projectName?: string;
  className?: string;
  /** Persists renamed title in parent state (no HTTP). */
  onProjectNameCommit?: (name: string) => void;
}

/** Project header toolbar shown at the top-left of the canvas. */
const ProjectHeader: React.FC<ProjectHeaderProps> = ({
  projectName = 'Project_name',
  className,
  onProjectNameCommit,
}) => {
  const { t } = useTranslation();
  const { language, theme, setLanguage, setTheme } = useUserCenterStore();
  const autosaveTime = useSelector((state: RootState) => state.projectInfo.autosaveTime);
  const [inputValue, setInputValue] = useState<string>(projectName);
  const [open, setOpen] = useState<boolean>(false);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const { nodes, edges } = useCanvasData();
  const { setNodes, setEdges } = useCanvasActions();
  const formatAutosaveTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  };

  // Load theme from localStorage on mount.
  useEffect(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      setTheme(stored);
    } else {
      // Default to system when missing.
      setTheme('system');
    }
  }, [setTheme]);

  // Load language from localStorage on mount.
  useEffect(() => {
    const stored = localStorage.getItem('language');
    if (stored && ['en', 'zh-CN', 'zh-TW', 'ja'].includes(stored)) {
      setLanguage(stored);
      i18n.changeLanguage(stored);
    } else {
      // Default to en when missing.
      setLanguage('en');
      i18n.changeLanguage('en');
    }
  }, [setLanguage]);

  // Resolve theme mode from current state.
  const getThemeMode = (): 'system' | 'dark' | 'light' => {
    if (theme === 'system') {
      return 'system';
    } else if (theme === 'dark' || theme === 'light') {
      return theme;
    }
    return 'system';
  };

  const themeMode = getThemeMode();

  const selectedKeys: Record<string, string> = { language };

  // Sync input value when projectName prop changes.
  useEffect(() => {
    setInputValue(projectName);
  }, [projectName]);

  // Save workflow name on input blur.
  const handleInputBlur = () => {
    if (inputValue !== projectName && inputValue.trim()) {
      onProjectNameCommit?.(inputValue.trim());
    }
  };

  // Save workflow name on Enter.
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  // Handle top icon click.
  const handleTopIconClick = (key: string) => {
    if (key === 'monitor') {
      setTheme('system');
    } else if (key === 'moon') {
      setTheme('dark');
    } else if (key === 'sun') {
      setTheme('light');
    }
  };

  // Top icon menu items.
  const topMenuItems = [
    {
      key: 'monitor',
      label: t('project.header.monitor'),
      isSelected: themeMode === 'system',
    },
    {
      key: 'moon',
      label: t('project.header.darkMode'),
      isSelected: themeMode === 'dark',
    },
    {
      key: 'sun',
      label: t('project.header.lightMode'),
      isSelected: themeMode === 'light',
    },
  ];

  // Language label map (i18n codes).
  const languageMap: Record<string, string> = {
    en: 'English',
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    ja: 'Japanese',
  };

  // Main dropdown menu items.
  const menuItems: MenuItemType[] = [
    {
      key: 'language',
      label: (
        <div className='flex items-center gap-2'>
          <Icon name='project-language-icon' width={20} height={20} color='var(--color-text-default-base)' />
          <span className='text-text-default-base text-[12px] font-bold'>{languageMap[language] || 'English'}</span>
        </div>
      ),
      children: [
        {
          key: 'en',
          label: 'English',
        },
        {
          key: 'zh-CN',
          label: 'Simplified Chinese',
        },
        {
          key: 'zh-TW',
          label: 'Traditional Chinese',
        },
        {
          key: 'ja',
          label: 'Japanese',
        },
      ],
    },
    {
      key: 'divider-1',
      type: 'divider',
      label: null,
    },
    {
      key: 'import',
      label: (
        <div className='flex items-center gap-2'>
          <Icon name='project-import-icon' width={20} height={20} color='var(--color-text-default-base)' />
          <span className='text-text-default-base text-[12px] font-bold'>{t('project.header.importWorkflow')}</span>
        </div>
      ),
    },
    {
      key: 'export',
      label: (
        <div className='flex items-center gap-2'>
          <Icon name='project-export-icon' width={20} height={20} color='var(--color-text-default-base)' />
          <span className='text-text-default-base text-[12px] font-bold'>{t('project.header.exportWorkflow')}</span>
        </div>
      ),
      children: [
        {
          key: 'export-with-resources',
          label: t('project.header.exportWithResources'),
        },
        {
          key: 'export-without-resources',
          label: t('project.header.exportWithoutResources'),
        },
      ],
    },
    {
      key: 'divider-2',
      type: 'divider',
      label: null,
    },
    {
      key: 'discord',
      label: (
        <div className='flex items-center gap-2'>
          <Icon name='project-discord-icon' width={20} height={20} color='var(--color-text-default-base)' />
          <span className='text-text-default-base text-[12px] font-bold'>{t('project.header.discord')}</span>
        </div>
      ),
    },
    {
      key: 'divider-3',
      type: 'divider',
      label: null,
    },
    {
      key: 'workspace',
      label: (
        <div className='flex items-center gap-2'>
          <Icon name='project-workspace-icon' width={20} height={20} color='var(--color-text-default-base)' />
          <span className='text-text-default-base text-[12px] font-bold'>{t('project.header.backToWorkspace')}</span>
        </div>
      ),
    },
  ];

  // Export workflow with resources.
  const handleExportWithResources = async () => {
    setIsExporting(true);
    try {
      const idMap = new Map<string, string>();
      nodes.forEach((node, index) => {
        const newId = `node-${index + 1}`;
        idMap.set(node.id, newId);
      });
      const processedNodes = nodes.map((node) => ({
        ...node,
        id: idMap.get(node.id) || node.id,
      }));
      const processedEdges = edges.map((edge) => ({
        ...edge,
        source: idMap.get(edge.source) || edge.source,
        target: idMap.get(edge.target) || edge.target,
      }));

      const workflowData = {
        nodes: processedNodes,
        edges: processedEdges,
        exportedAt: new Date().toISOString(),
        version: '1.0.0',
        includeResources: true,
      };

      const dataStr = JSON.stringify(workflowData, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${projectName || 'workflow'}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      message.success(t('project.header.exportSuccessful'));
    } catch (error) {
      console.error('Export with resources error:', error);
      message.error(t('project.header.exportFailed'));
    } finally {
      setIsExporting(false);
    }
  };

  // Export workflow without resources.
  const handleExportWithoutResources = async () => {
    setIsExporting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const idMap = new Map<string, string>();
      nodes.forEach((node, index) => {
        const newId = `node-${index + 1}`;
        idMap.set(node.id, newId);
      });
      const processedNodes = nodes.map((node) => {
        const newData = { ...node.data };
        if (newData.nodeResultData !== undefined) {
          newData.nodeResultData = [];
        }
        if (newData.nodeSelectedResultData !== undefined) {
          newData.nodeSelectedResultData = {};
        }
        return {
          ...node,
          id: idMap.get(node.id) || node.id,
          data: newData,
        };
      });

      // Remap edge source and target ids.
      const processedEdges = edges.map((edge) => ({
        ...edge,
        source: idMap.get(edge.source) || edge.source,
        target: idMap.get(edge.target) || edge.target,
      }));

      const workflowData = {
        nodes: processedNodes,
        edges: processedEdges,
        exportedAt: new Date().toISOString(),
        version: '1.0.0',
        includeResources: false,
      };

      const dataStr = JSON.stringify(workflowData, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${projectName || 'workflow'}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      message.success(t('project.header.exportSuccessful'));
    } catch (error) {
      console.error('Export without resources error:', error);
      message.error(t('project.header.exportFailed'));
    } finally {
      setIsExporting(false);
    }
  };

  // Define workflow data schema via Zod.
  const WorkflowNodeSchema = z
    .object({
      id: z.string().min(1, 'Node id is required'),
      type: z.string().min(1, 'Node type is required'),
      position: z.object({
        x: z.number(),
        y: z.number(),
      }),
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
      nodes: z.array(WorkflowNodeSchema).min(0, 'Nodes array is required'),
      edges: z.array(WorkflowEdgeSchema).min(0, 'Edges array is required'),
    })
    .catchall(z.unknown());

  // Validate workflow data with Zod.
  const validateWorkflowData = (
    data: unknown,
  ): { valid: boolean; error?: string; data?: z.infer<typeof WorkflowDataSchema> } => {
    try {
      const sanitizedData =
        typeof data === 'string' ? DOMPurify.sanitize(data, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }) : data;
      const result = WorkflowDataSchema.safeParse(sanitizedData);

      if (result.success) {
        return { valid: true, data: result.data };
      }
      const errorMessages = result.error.issues.map((err) => {
        const path = err.path.join('.');
        return path ? `${path}: ${err.message}` : err.message;
      });
      return {
        valid: false,
        error: `Validation failed: ${errorMessages.join('; ')}`,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown validation error',
      };
    }
  };

  // Import workflow.
  const handleImportWorkflow = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) {
        return;
      }
      setIsImporting(true);
      try {
        const rawText = await file.text();
        const sanitizedText = DOMPurify.sanitize(rawText, {
          ALLOWED_TAGS: [],
          ALLOWED_ATTR: [],
        });

        let parsedData: unknown;

        try {
          parsedData = JSON.parse(sanitizedText);
        } catch {
          throw new Error('Invalid JSON format');
        }

        // Validate data shape with Zod.
        const validation = validateWorkflowData(parsedData);
        if (!validation.valid) {
          throw new Error(validation.error || 'Invalid workflow data format');
        }

        const workflowData = validation.data!;

        const idMap = new Map<string, string>();
        const processedNodes = (workflowData.nodes as Node[]).map((node) => {
          const timestamp = Date.now();
          const randomString = nanoid(5);
          const newNodeId = `${node.type}-${timestamp}-${randomString}`;
          idMap.set(node.id, newNodeId);
          return {
            ...node,
            id: newNodeId,
          };
        });

        const processedEdges = (workflowData.edges as Edge[]).map((edge) => ({
          ...edge,
          source: idMap.get(edge.source) || edge.source,
          target: idMap.get(edge.target) || edge.target,
        }));

        const mergedNodes = [...nodes, ...processedNodes];
        const mergedEdges = [...edges, ...processedEdges];

        setNodes(mergedNodes);
        setEdges(mergedEdges);

        message.success(t('project.header.importSuccessful'));
        setOpen(false);
      } catch (error) {
        console.error('Import workflow error:', error);
        message.error(t('project.header.importFailed'));
      } finally {
        setIsImporting(false);
        document.body.removeChild(input);
      }
    };
    document.body.appendChild(input);
    input.click();
  };

  // Handle dropdown menu click.
  const handleMenuClick = (key: string) => {
    // eslint-disable-next-line no-console
    console.log('Menu item clicked:', key);
    if (key === 'import') {
      handleImportWorkflow();
      return;
    }
    if (key === 'export-with-resources') {
      handleExportWithResources();
      return;
    }
    if (key === 'export-without-resources') {
      handleExportWithoutResources();
      return;
    }

    if (key === 'workspace') {
      window.location.href = '/workspace';
      return;
    }

    if (key === 'discord') {
      window.open('https://discord.gg/Yeu6A4aejN', '_blank');
      return;
    }

    if (key === 'en' || key === 'zh-CN' || key === 'zh-TW' || key === 'ja') {
      setLanguage(key);
      i18n.changeLanguage(key);
    }
  };

  return (
    <>
      {(isImporting || isExporting) && (
        <Loading text={isExporting ? t('project.header.exporting') : t('project.header.importing')} />
      )}
      <div
        className={cn('pointer-events-auto min-w-0 cursor-default', className)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex min-w-0 items-center gap-3 rounded-[5px]'>
          <div className='relative shrink-0'>
            <Dropdown
              items={menuItems}
              onClick={handleMenuClick}
              selectedKeys={Object.values(selectedKeys).filter(Boolean)}
              trigger='click'
              placement='bottom-start'
              open={open}
              onOpenChange={setOpen}
              expandIcon={
                <Icon name='project-chevron-right-icon' width={5} height={9} color='var(--color-text-default-base)' />
              }
              popupRender={(menus) => (
                <div className='overflow-visible project-header-dropdown w-[190px] rounded-[8px] border border-[var(--color-border-default-base)] mt-[15px]'>
                  <div className='bg-background-default-base flex items-center justify-center gap-2 px-3 py-4 project-header-top-icons rounded-tl-[8px] rounded-tr-[8px] border-b border-[var(--color-border-default-base)]'>
                    {topMenuItems.map((item) => (
                      <div
                        key={item.key}
                        className={`cursor-pointer rounded ${item.isSelected ? 'project-header-icon-selected' : ''}`}
                        title={item.label}
                        onClick={() => handleTopIconClick(item.key)}
                      >
                        <Icon
                          name={
                            item.key === 'monitor'
                              ? 'project-monitor-icon'
                              : item.key === 'moon'
                                ? 'project-moon-icon'
                                : 'project-sun-icon'
                          }
                          width={20}
                          height={18}
                          color='var(--color-icon-secondary-hover)'
                        />
                      </div>
                    ))}
                  </div>
                  <div>{menus}</div>
                </div>
              )}
              popupClassName='border-0 rounded-tl-0 rounded-tr-0 rounded-bl-[8px] rounded-br-[8px] px-4 py-2'
            >
              <div className='cursor-pointer flex items-center justify-center'>
                <Icon name='project-leaf-icon' width={21} height={21} color='var(--color-brand-base)' />
              </div>
            </Dropdown>
          </div>

          <div className='flex min-w-0 flex-1 flex-col'>
            <input
              type='text'
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onBlur={handleInputBlur}
              onKeyDown={handleInputKeyDown}
              className='min-w-0 w-full text-sm text-text-default-base font-bold leading-5 bg-transparent border-none outline-none p-0 m-0'
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
            {autosaveTime > 0 && (
              <div className='text-[9px] text-text-default-base leading-4'>
                {t('project.header.autosavedAt')} {formatAutosaveTime(autosaveTime)}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default memo(ProjectHeader);
