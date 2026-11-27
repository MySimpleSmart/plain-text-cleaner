import { Editor, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { ListKit } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Mathematics } from '@tiptap/extension-mathematics';
import katex from 'katex';
import 'katex/dist/katex.min.css';

const DocumentLimit = Extension.create({
  name: 'documentLimit',
  addProseMirrorPlugins() {
    return [new Plugin({ filterTransaction: transaction => !transaction.docChanged || transaction.doc.textContent.length <= 100000 })];
  }
});

window.renderDocumentMath = (latex, displayMode) => katex.renderToString(latex, {
  displayMode, trust: false, throwOnError: false, maxSize: 8, maxExpand: 1000
});

window.createDocumentEditor = (element, content, onUpdate, onSelectionUpdate) => new Editor({
  element,
  injectCSS: false,
  extensions: [
    StarterKit.configure({ bulletList: false, orderedList: false, listItem: false, listKeymap: false }),
    ListKit.configure({ taskItem: { nested: true } }),
    TableKit.configure({ table: { resizable: false } }),
    Mathematics.configure({ katexOptions: { trust: false, throwOnError: false, maxSize: 8, maxExpand: 1000 } }),
    DocumentLimit
  ],
  content,
  onUpdate,
  onSelectionUpdate,
  editorProps: {
    attributes: { 'aria-label': 'Document. Type or paste here.', 'role': 'textbox', 'aria-multiline': 'true', 'spellcheck': 'true' },
    handleDrop: () => true,
    handlePaste: (_view, event) => {
      if (window.handleDocumentPaste) return window.handleDocumentPaste(event);
      return false;
    }
  }
});
