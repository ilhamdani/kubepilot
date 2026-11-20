import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { useApp, type DockTab } from '../state/store';
import { CloseIcon } from './Icons';

export function Dock() {
  const dock = useApp((s) => s.dock);
  const closeDockTab = useApp((s) => s.closeDockTab);
  const activateDockTab = useApp((s) => s.activateDockTab);
  const setDockOpen = useApp((s) => s.setDockOpen);
  const setDockHeight = useApp((s) => s.setDockHeight);
  const toggleFullSize = useApp((s) => s.toggleDockFullSize);

  if (!dock.tabs.length) return null;

  const active = dock.tabs.find((t) => t.id === dock.activeTabId) ?? dock.tabs[0];

  const startResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = dock.height;
    const move = (e: MouseEvent) => {
      const next = Math.min(Math.max(120, startHeight + (startY - e.clientY)), window.innerHeight - 200);
      setDockHeight(next);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      className={`dock ${dock.open ? '' : 'dock--closed'}`}
      style={
        dock.fullSize
          ? { position: 'absolute', inset: 0, height: 'auto', zIndex: 60 }
          : { height: dock.open ? dock.height : 32 }
      }
    >
      {dock.open && !dock.fullSize && <div className="dock-resizer" onMouseDown={startResize} />}

      <div className="dock-tabs">
        {dock.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`dock-tab ${tab.id === active.id ? 'dock-tab--active' : ''}`}
            onClick={() => activateDockTab(tab.id)}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: tab.type === 'logs' ? 'var(--colorWarning)' : 'var(--colorOk)',
                flex: '0 0 6px',
              }}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.title}</span>
            <button
              className="icon-btn"
              style={{ width: 18, height: 18 }}
              onClick={(event) => {
                event.stopPropagation();
                closeDockTab(tab.id);
              }}
            >
              <CloseIcon size={10} />
            </button>
          </div>
        ))}

        <div className="dock-actions">
          <button
            className="icon-btn"
            title={dock.fullSize ? 'Restore' : 'Maximize'}
            onClick={toggleFullSize}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              {dock.fullSize ? <path d="M4 1.5v3H1.5M8 10.5v-3h2.5" /> : <path d="M1.5 4V1.5H4M10.5 8v2.5H8" />}
            </svg>
          </button>
          <button className="icon-btn" title="Close panel" onClick={() => setDockOpen(false)}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M2.5 6h7" />
            </svg>
          </button>
        </div>
      </div>

      <div className="dock-body" style={{ display: dock.open ? 'block' : 'none' }}>
        {dock.tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              position: 'absolute',
              inset: 0,
              display: tab.id === active.id ? 'block' : 'none',
            }}
          >
            {tab.type === 'logs' ? <LogsView tab={tab} /> : <TerminalView tab={tab} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function LogsView({ tab }: { tab: DockTab }) {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setLines([]);
    setError(undefined);

    const offData = api.logs.onData((payload) => {
      if (payload.streamId !== streamRef.current) return;
      setLines((prev) => {
        const next = prev.concat(payload.text.split('\n'));
        return next.length > 6000 ? next.slice(next.length - 6000) : next;
      });
    });
    const offEnd = api.logs.onEnd((payload) => {
      if (payload.streamId !== streamRef.current) return;
      if (payload.error) setError(payload.error);
    });

    void api.logs
      .start({
        clusterId: tab.clusterId,
        namespace: tab.namespace,
        pod: tab.pod,
        container: tab.container,
        follow: true,
        tailLines: 400,
      })
      .then((id) => {
        if (!active) {
          void api.logs.stop(id);
          return;
        }
        streamRef.current = id;
      })
      .catch((err: any) => setError(err?.message ?? 'Failed to start logs'));

    return () => {
      active = false;
      offData();
      offEnd();
      if (streamRef.current) void api.logs.stop(streamRef.current);
      streamRef.current = undefined;
    };
  }, [tab.clusterId, tab.namespace, tab.pod, tab.container]);

  useEffect(() => {
    if (!follow) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  return (
    <>
      <div className="logs-toolbar">
        <button className="btn" onClick={() => setFollow((v) => !v)}>
          {follow ? 'Pause' : 'Follow'}
        </button>
        <button className="btn" onClick={() => setWrap((v) => !v)}>
          {wrap ? 'No wrap' : 'Wrap'}
        </button>
        <button className="btn" onClick={() => setLines([])}>
          Clear
        </button>
      </div>
      <div
        className="logs"
        ref={containerRef}
        style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}
        onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {error && <div className="log-error">{error}</div>}
        {lines.map((line, index) => (
          <div className="log-line" key={index}>
            {line.startsWith('level=error') || line.includes('panic:') ? (
              <span className="log-error">{line}</span>
            ) : line.startsWith('level=warn') ? (
              <span className="log-warn">{line}</span>
            ) : (
              line
            )}
          </div>
        ))}
        {!error && lines.length === 0 && <span className="muted">Waiting for log output…</span>}
      </div>
    </>
  );
}

function TerminalView({ tab }: { tab: DockTab }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | undefined>(undefined);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "'SF Mono', 'Cascadia Mono', Consolas, 'Ubuntu Mono', monospace",
      fontSize: 12.5,
      cursorBlink: true,
      theme: {
        background: '#000000',
        foreground: '#ffffff',
        cursor: '#ffffff',
        cursorAccent: '#000000',
        selectionBackground: '#ffffff77',
        black: '#2e3436',
        red: '#cc0000',
        green: '#4e9a06',
        yellow: '#c4a000',
        blue: '#3465a4',
        magenta: '#75507b',
        cyan: '#06989a',
        white: '#d3d7cf',
        brightBlack: '#555753',
        brightRed: '#ef2929',
        brightGreen: '#8ae234',
        brightYellow: '#fce94f',
        brightBlue: '#729fcf',
        brightMagenta: '#ad7fa8',
        brightCyan: '#34e2e2',
        brightWhite: '#eeeeec',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* host not laid out yet */
      }
    });

    const offData = api.exec.onData((payload) => {
      if (payload.sessionId === sessionRef.current) term.write(payload.data);
    });
    const offExit = api.exec.onExit((payload) => {
      if (payload.sessionId !== sessionRef.current) return;
      setStatus('closed');
      term.write('\r\n\x1b[90m[session closed]\x1b[0m\r\n');
    });

    void api.exec
      .start({
        clusterId: tab.clusterId,
        namespace: tab.namespace,
        pod: tab.pod,
        container: tab.container,
        // Empty: the main process picks a shell the image actually has.
        command: [],
        tty: true,
      })
      .then((id) => {
        sessionRef.current = id;
        setStatus('open');
        void api.exec.resize(id, term.cols, term.rows);
      })
      .catch((err: any) => {
        setStatus('closed');
        // Electron wraps rejections as `Error invoking remote method 'x': Error: ...`
        const message = String(err?.message ?? 'Failed to start session').replace(
          /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
          '',
        );
        for (const line of message.split('\n')) term.write(`\x1b[31m${line}\x1b[0m\r\n`);
      });

    const onData = term.onData((data) => {
      if (sessionRef.current) void api.exec.write(sessionRef.current, data);
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        if (sessionRef.current) void api.exec.resize(sessionRef.current, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      onData.dispose();
      offData();
      offExit();
      if (sessionRef.current) void api.exec.close(sessionRef.current);
      sessionRef.current = undefined;
      term.dispose();
    };
  }, [tab.clusterId, tab.namespace, tab.pod, tab.container]);

  return (
    <>
      <div className="logs-toolbar">
        <span className="btn" style={{ background: 'transparent', color: 'var(--textColorDimmed)' }}>
          {status === 'connecting' ? 'Connecting…' : status === 'open' ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      <div className="terminal-host" ref={hostRef} />
    </>
  );
}
