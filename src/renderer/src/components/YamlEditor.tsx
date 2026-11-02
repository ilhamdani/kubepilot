import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// Monaco needs an explicit worker factory under Vite.
(self as any).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

const THEME = 'kubepilot-yaml';

let themeRegistered = false;

function registerTheme() {
  if (themeRegistered) return;
  themeRegistered = true;
  monaco.editor.defineTheme(THEME, {
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
    },
  });
}

interface Props {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}

export function YamlEditor({ value, onChange, readOnly }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    registerTheme();
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language: 'yaml',
      theme: THEME,
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12.5,
      fontFamily:
        "'SF Mono', 'Cascadia Mono', Consolas, 'Ubuntu Mono', 'Liberation Mono', monospace",
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      padding: { top: 10, bottom: 10 },
      tabSize: 2,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      wordWrap: 'on',
    });
    editorRef.current = editor;
    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue());
    });
    return () => {
      subscription.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div ref={hostRef} className="editor-host" />;
}
