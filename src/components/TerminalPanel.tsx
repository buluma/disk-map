import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalPanel({
  path,
  elevated,
  onClose,
  onError,
}: {
  path: string;
  elevated: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  let container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let host = container.current;
    if (!host) return;

    let term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000 });
    let fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let disposed = false;
    let sessionId: number | null = null;
    let unlisten: UnlistenFn[] = [];

    function resize() {
      fit.fit();
      if (sessionId !== null) {
        invoke("terminal_resize", { id: sessionId, rows: term.rows, cols: term.cols }).catch(() => {});
      }
    }
    let observer = new ResizeObserver(resize);
    observer.observe(host);

    let input = term.onData((data) => {
      if (sessionId !== null) {
        invoke("terminal_write", { id: sessionId, data }).catch((err) => onError(String(err)));
      }
    });

    (async () => {
      try {
        let id = await invoke<number>("terminal_open", {
          cwd: path,
          elevated,
          rows: term.rows,
          cols: term.cols,
        });
        if (disposed) {
          await invoke("terminal_close", { id });
          return;
        }
        sessionId = id;
        unlisten = await Promise.all([
          listen<string>(`terminal-data-${id}`, (event) => term.write(event.payload)),
          listen(`terminal-exit-${id}`, () => term.write("\r\n[process exited]\r\n")),
        ]);
        if (disposed) unlisten.forEach((fn) => fn());
        term.focus();
      } catch (err) {
        onError(String(err));
        onClose();
      }
    })();

    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      unlisten.forEach((fn) => fn());
      if (sessionId !== null) invoke("terminal_close", { id: sessionId }).catch(() => {});
      term.dispose();
    };
    // Session is bound to the folder and elevation it was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, elevated]);

  return (
    <section className={elevated ? "terminal-panel root" : "terminal-panel"}>
      <div className="terminal-head">
        <strong>
          {elevated && <span className="root-badge">ROOT</span>} Terminal
        </strong>
        <span className="terminal-path" title={path}>
          {path}
        </span>
        <button className="collapse-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="terminal-body" ref={container} />
    </section>
  );
}
