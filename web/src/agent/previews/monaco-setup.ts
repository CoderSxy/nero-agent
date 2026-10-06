import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { Environment } from 'monaco-editor';
import 'monaco-editor/esm/vs/editor/editor.main';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

loader.config({ monaco });
(globalThis as typeof globalThis & { MonacoEnvironment: Environment }).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'json') return new jsonWorker();
    if (['css', 'scss', 'less'].includes(label)) return new cssWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new htmlWorker();
    if (['typescript', 'javascript', 'javascriptreact', 'typescriptreact'].includes(label)) return new tsWorker();
    return new editorWorker();
  },
};
