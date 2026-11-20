import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { YAML_THEME, ensureMonaco } from '../lib/monaco';

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
  // setValue() fires onDidChangeModelContent too; without this guard a refresh
  // from the cluster would mark the document dirty again right after saving.
  const syncingRef = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;
    ensureMonaco();
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language: 'yaml',
      theme: YAML_THEME,
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
      if (syncingRef.current) return;
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
    if (editor.getValue() === value) return;
    syncingRef.current = true;
    editor.setValue(value);
    syncingRef.current = false;
  }, [value]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div ref={hostRef} className="editor-host" />;
}
