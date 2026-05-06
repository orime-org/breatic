export interface TextEditorProps {
  nodeId: string;
}

export interface TocHeading {
  level: number;
  text: string;
  pos: number;
  id: string;
}

export interface TocNode {
  heading: TocHeading;
  children: TocNode[];
  collapsed: boolean;
}
