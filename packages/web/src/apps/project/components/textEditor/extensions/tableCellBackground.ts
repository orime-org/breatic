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

export const BreaticTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.() ?? {},
      backgroundColor: backgroundColorAttr,
    };
  },
});

export const BreaticTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.() ?? {},
      backgroundColor: backgroundColorAttr,
    };
  },
});
