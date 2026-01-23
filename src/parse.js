
import { parse } from '@typescript-eslint/typescript-estree';
console.log(parse(`import MarkdownViewer from '@/components/MarkdownViewer.vue'
import rawMarkdown from './md/gt.md?raw'`).body[0].specifiers)
