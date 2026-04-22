import { TableCell } from '@tiptap/extension-table/cell';
import { TableHeader } from '@tiptap/extension-table/header';

const backgroundColorAttr = {
  default: null as string | null,
  parseHTML: (element: HTMLElement) => element.style.backgroundColor || null,
  renderHTML: (attributes: { backgroundColor?: string | null }) => {
    if (!attributes.backgroundColor) {
      return {};
    }
    return {
      style: `background-color: ${attributes.backgroundColor}`,
    };
  },
};

const verticalAlignAttr = {
  default: null as 'top' | 'middle' | 'bottom' | null,
  parseHTML: (element: HTMLElement) => {
    const v = (element.style.verticalAlign || '').toLowerCase();
    if (v === 'top' || v === 'middle' || v === 'bottom') return v as 'top' | 'middle' | 'bottom';
    return null;
  },
  renderHTML: (attributes: { verticalAlign?: 'top' | 'middle' | 'bottom' | null }) => {
    const v = attributes.verticalAlign;
    if (!v) return {};
    return { style: `vertical-align: ${v}` };
  },
};

export const BreaticTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.() ?? {},
      backgroundColor: backgroundColorAttr,
      verticalAlign: verticalAlignAttr,
    };
  },
});

export const BreaticTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.() ?? {},
      backgroundColor: backgroundColorAttr,
      verticalAlign: verticalAlignAttr,
    };
  },
});
