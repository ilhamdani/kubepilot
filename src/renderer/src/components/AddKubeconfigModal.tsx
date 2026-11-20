import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../state/store';
import { Modal } from './Overlays';

const PLACEHOLDER = `apiVersion: v1
kind: Config
clusters:
  - name: my-cluster
    cluster:
      server: https://127.0.0.1:6443
contexts:
  - name: my-cluster
    context:
      cluster: my-cluster
      user: admin
current-context: my-cluster
users:
  - name: admin
    user:
      token: ...`;

/** Paste a kubeconfig as text, or fall back to the native file picker. */
export function AddKubeconfigModal() {
  const open = useApp((s) => s.kubeconfigModalOpen);
  const toggle = useApp((s) => s.toggleKubeconfigModal);
  const refreshClusters = useApp((s) => s.refreshClusters);
  const setActiveCluster = useApp((s) => s.setActiveCluster);
  const toast = useApp((s) => s.toast);

  const [content, setContent] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) {
      setContent('');
      setName('');
      setError(undefined);
      setBusy(false);
      return;
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);

  if (!open) return null;

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setError('The clipboard is empty — copy a kubeconfig first.');
        return;
      }
      setContent(text);
      setError(undefined);
      textareaRef.current?.focus();
    } catch {
      setError('Clipboard access was denied. Click the text area and press Ctrl+V instead.');
    }
  };

  const importFile = async () => {
    try {
      const result = await api.kubeconfig.add();
      if (!result.added.length) return;
      await refreshClusters();
      toast(`${result.added.length} kubeconfig file${result.added.length === 1 ? '' : 's'} added.`, 'success', {
        title: 'Kubeconfig added',
        detail: result.added.join('\n'),
      });
      toggle(false);
    } catch (err: any) {
      setError(err?.message ?? 'Could not open the kubeconfig file.');
      toast(err?.message ?? 'Could not add the kubeconfig file.', 'error', {
        title: 'Kubeconfig import failed',
        detail: err?.message,
      });
    }
  };

  const importPasted = async () => {
    setError(undefined);
    if (!content.trim()) {
      setError('Paste the contents of a kubeconfig file first.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.kubeconfig.paste({ content, name: name.trim() || undefined });
      await refreshClusters();
      const lines = [
        result.contexts.length ? `Contexts: ${result.contexts.join(', ')}` : '',
        result.path ? `Saved to ${result.path}` : '',
        ...result.warnings,
      ].filter(Boolean);
      toast(
        result.contexts.length
          ? `Imported ${result.contexts.length} context${result.contexts.length === 1 ? '' : 's'}.`
          : 'Kubeconfig saved, but no connectable context was found.',
        result.contexts.length ? 'success' : 'info',
        { title: 'Kubeconfig imported', detail: lines.join('\n') },
      );
      // With no cluster selected, jump straight into the one just imported.
      if (!useApp.getState().activeClusterId && result.contexts.length) {
        await setActiveCluster(`live:${result.contexts[0]}`);
      }
      toggle(false);
    } catch (err: any) {
      const message = err?.message ?? 'Could not import that kubeconfig.';
      setError(message);
      toast(message, 'error', { title: 'Kubeconfig import failed', detail: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add kubeconfig"
      wide
      onClose={() => toggle(false)}
      footer={
        <>
          <button className="btn btn--ghost" onClick={() => void importFile()} disabled={busy}>
            Choose file…
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn btn--ghost" onClick={() => toggle(false)}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || !content.trim()}
            onClick={() => void importPasted()}
          >
            {busy ? 'Importing…' : 'Import pasted config'}
          </button>
        </>
      }
    >
      <div className="hint" style={{ marginBottom: 12 }}>
        Paste the YAML from <span className="mono">~/.kube/config</span> or from your cloud provider. It is
        validated before being saved to your KubePilot profile — your original files are never modified.
      </div>

      <div className="field-row">
        <div className="field" style={{ flex: 1 }}>
          <label>Label (optional)</label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. staging-eks"
            spellCheck={false}
          />
        </div>
        <div className="field" style={{ justifyContent: 'flex-end' }}>
          <label aria-hidden="true" style={{ visibility: 'hidden' }}>clipboard</label>
          <button className="btn" onClick={() => void pasteFromClipboard()}>
            Paste from clipboard
          </button>
        </div>
      </div>

      <div className="field">
        <label>Kubeconfig YAML</label>
        <textarea
          ref={textareaRef}
          className="kube-input mono"
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setError(undefined);
          }}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void importPasted();
            }
          }}
        />
      </div>

      {error && <div className="warning-box">{error}</div>}
      <div className="hint" style={{ marginTop: 8 }}>
        Ctrl+Enter imports. Context names that already exist are renamed in the imported copy.
      </div>
    </Modal>
  );
}
