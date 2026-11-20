import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

/** Theme registered below; both the YAML editor and the diff view use it. */
export const YAML_THEME = 'kubepilot-yaml';

let initialised = false;

/**
 * Monaco needs an explicit worker factory under Vite, and the theme has to be
 * defined before an editor is created. Both are process-wide, so this runs
 * once no matter how many editors are mounted.
 */
export function ensureMonaco(): void {
  if (initialised) return;
  initialised = true;

  (self as any).MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };

  monaco.editor.defineTheme(YAML_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string.yaml', foreground: '9ecb7a' },
      { token: 'number.yaml', foreground: 'd9a441' },
      { token: 'keyword.yaml', foreground: '3d90ce' },
      { token: 'comment.yaml', foreground: '6b7781', fontStyle: 'italic' },
      { token: 'type.yaml', foreground: 'c93dce' },
    ],
    colors: {
      'editor.background': '#262b2f',
      'editor.foreground': '#f1f3f5',
      'editorLineNumber.foreground': '#5c666e',
      'editorLineNumber.activeForeground': '#aaacae',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.selectionBackground': '#3d90ce55',
      'editorCursor.foreground': '#3d90ce',
      'editorIndentGuide.background1': '#ffffff12',
      'editorWidget.background': '#1f2123',
      'editorGutter.background': '#262b2f',
      'scrollbarSlider.background': '#41434980',
      'diffEditor.insertedTextBackground': '#4caf5033',
      'diffEditor.removedTextBackground': '#ce393344',
    },
  });
}
