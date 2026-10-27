"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  canRotate,
  familyOf,
  frameSize,
  getDevice,
  PRIMARY_DEVICE_IDS,
  resolveAddress,
  scaleFor,
  VARIANTS,
  viewport,
  withCacheBust,
  type Zoom,
} from "./devices";
import styles from "./preview.module.css";

const ZOOMS: { value: Zoom; label: string }[] = [
  { value: "fit", label: "Fit" },
  { value: 0.5, label: "50%" },
  { value: 0.75, label: "75%" },
  { value: 1, label: "100%" },
];
const STORAGE_KEY = "vessel.preview.device";

type Props = {
  /** URL of the running app, or null until the sandbox serves it. */
  appUrl: string | null;
  /** Restart the app process and wipe data; undefined until the sandbox runtime exists. */
  onRestart?: () => void;
  onResetData?: () => void;
  /** Shown instead of the empty state while the app is starting, has crashed, or cannot run yet. */
  notice?: { title: string; text: string; tone?: "error" };
};

export function Preview({ appUrl, onRestart, onResetData, notice }: Props) {
  const [deviceId, setDeviceId] = useState("responsive");
  const [landscape, setLandscape] = useState(false);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [url, setUrl] = useState<string | null>(appUrl);
  const [address, setAddress] = useState(appUrl ?? "");
  const [addressError, setAddressError] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [src, setSrc] = useState<string | null>(appUrl);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ width: 0, height: 0 });

  // Remember the chosen device per browser; storage can be unavailable, so failures are ignored.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore a saved preference after mount
      if (saved) setDeviceId(getDevice(saved).id);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, deviceId);
    } catch {}
  }, [deviceId]);

  // Follow the app URL when the runtime starts or changes it.
  useEffect(() => {
    if (!appUrl) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync to a new app URL from the runtime
    setUrl(appUrl);
    setSrc(appUrl);
    setAddress(appUrl);
  }, [appUrl]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setPane({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const device = getDevice(deviceId);
  const responsive = device.kind === "responsive";
  const view = viewport(device, landscape);
  const frame = frameSize(device, landscape);
  const scale = responsive ? 1 : scaleFor(frame, pane, zoom);

  const navigate = (e: React.FormEvent) => {
    e.preventDefault();
    const next = resolveAddress(address, appUrl);
    setAddressError(!next);
    if (!next) return;
    setUrl(next);
    setSrc(next);
    setAddress(next);
    setLoading(true);
    setFrameKey((k) => k + 1);
  };
  const reload = () => {
    if (!url) return;
    setSrc(url);
    setLoading(true);
    setFrameKey((k) => k + 1);
  };
  const hardReload = () => {
    if (!url) return;
    setSrc(withCacheBust(url));
    setLoading(true);
    setFrameKey((k) => k + 1);
  };
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const pickDevice = (id: string) => {
    setDeviceId(id);
    if (!canRotate(getDevice(id))) setLandscape(false);
  };

  return (
    <div className={styles.preview}>
      <div className={styles.devices} role="radiogroup" aria-label="Preview device">
        {PRIMARY_DEVICE_IDS.map((id) => {
          const d = getDevice(id);
          const active = familyOf(deviceId) === id;
          const variants = VARIANTS[id];
          return (
            <span key={id} className={styles.deviceGroup}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                data-on={active}
                className={styles.device}
                title={d.kind === "responsive" ? d.detail : `${d.detail} · ${d.width} × ${d.height}`}
                onClick={() => pickDevice(active && variants ? deviceId : id)}
              >
                <DeviceIcon kind={d.kind} />
                {d.label}
              </button>
              {active && variants && (
                <select
                  className={styles.variant}
                  aria-label={`${d.label} model`}
                  value={deviceId}
                  onChange={(e) => pickDevice(e.target.value)}
                >
                  {variants.map((v) => (
                    <option key={v} value={v}>
                      {getDevice(v).detail}
                    </option>
                  ))}
                </select>
              )}
            </span>
          );
        })}
      </div>

      <div className={styles.toolbar}>
        <div className={styles.group}>
          <IconButton label="Reload" onClick={reload} disabled={!url}>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </IconButton>
          <IconButton label="Hard reload (clear cache)" onClick={hardReload} disabled={!url}>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3M8 5.5v3l2 1" />
          </IconButton>
          <IconButton label="Restart app" onClick={onRestart} disabled={!onRestart} hint="Available once the app runs in its sandbox">
            <path d="M5 3.5v9l7.5-4.5z" />
          </IconButton>
          {confirmReset ? (
            <span className={styles.confirm}>
              Wipe all app data?
              <button type="button" onClick={() => (setConfirmReset(false), onResetData?.())}>
                Reset
              </button>
              <button type="button" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <IconButton label="Reset data" onClick={() => setConfirmReset(true)} disabled={!onResetData} hint="Available once the app has a database">
              <path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9" />
            </IconButton>
          )}
        </div>

        <form className={styles.address} onSubmit={navigate}>
          <i data-live={!!appUrl} />
          <label htmlFor="preview-address" className="sr-only">
            Address
          </label>
          <input
            id="preview-address"
            value={address}
            spellCheck={false}
            placeholder={appUrl ? "/" : "Not running yet · enter any URL to preview"}
            aria-invalid={addressError}
            onChange={(e) => {
              setAddress(e.target.value);
              setAddressError(false);
            }}
          />
          {addressError && <span className={styles.addressError}>{appUrl ? "Stay on the app’s own address" : "Enter an http(s) URL"}</span>}
        </form>

        <div className={styles.group}>
          <IconButton label={copied ? "Copied" : "Copy URL"} onClick={copy} disabled={!url}>
            <path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />
          </IconButton>
          {url ? (
            <a className={styles.icon} href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in new tab" title="Open in new tab">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5v3.5h-8.5v-8.5h3.5" />
              </svg>
            </a>
          ) : (
            <IconButton label="Open in new tab" disabled>
              <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5v3.5h-8.5v-8.5h3.5" />
            </IconButton>
          )}
          <span className={styles.divider} />
          <IconButton label="Rotate" onClick={() => setLandscape((l) => !l)} disabled={!canRotate(device)}>
            <path d="M4.5 2.5h7v11h-7zM2 6.5l1.5-1.5L5 6.5" />
          </IconButton>
          <label htmlFor="preview-zoom" className="sr-only">
            Zoom
          </label>
          <select id="preview-zoom" className={styles.zoom} value={String(zoom)} disabled={responsive} onChange={(e) => setZoom(e.target.value === "fit" ? "fit" : (Number(e.target.value) as Zoom))}>
            {ZOOMS.map((z) => (
              <option key={z.label} value={String(z.value)}>
                {z.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div ref={stageRef} className={styles.stage} data-responsive={responsive}>
        <div
          className={styles.sizer}
          style={responsive ? undefined : { width: frame.width * scale, height: frame.height * scale }}
        >
          <div
            className={styles.frame}
            data-kind={device.kind}
            data-landscape={landscape && canRotate(device)}
            style={responsive ? undefined : { width: frame.width, height: frame.height, transform: `scale(${scale})` }}
          >
            {device.kind === "desktop" && (
              <div className={styles.windowBar}>
                <span>{device.detail}</span>
              </div>
            )}
            {device.kind === "phone" && <span className={styles.notch} />}
            <div className={styles.screen} style={responsive ? undefined : { width: view.width, height: view.height }}>
              {src ? (
                <>
                  <iframe
                    key={frameKey}
                    src={src}
                    title="App preview"
                    className={styles.iframe}
                    sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
                    referrerPolicy="no-referrer"
                    onLoad={() => setLoading(false)}
                  />
                  {loading && <span className={styles.loading} aria-hidden="true" />}
                </>
              ) : (
                <div className={styles.empty}>
                  <strong data-tone={notice?.tone}>{notice?.title ?? "Nothing is running yet."}</strong>
                  <p>{notice?.text ?? "When the app starts in its Wasmer sandbox, it opens here. You can also enter any URL above to try the device sizes."}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.status}>
        <span>{responsive ? "Responsive · fills the pane" : `${device.detail} · ${view.width} × ${view.height}${landscape ? " · landscape" : ""}`}</span>
        <span>{responsive ? "" : `${Math.round(scale * 100)}%`}</span>
      </div>
    </div>
  );
}

function IconButton({ label, hint, onClick, disabled, children }: { label: string; hint?: string; onClick?: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" className={styles.icon} onClick={onClick} disabled={disabled} aria-label={label} title={disabled && hint ? `${label} · ${hint}` : label}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function DeviceIcon({ kind }: { kind: string }) {
  const paths: Record<string, string> = {
    responsive: "M2 4h12v8H2zM5 14h6",
    desktop: "M2.5 3.5h11v7.5h-11zM1 13h14",
    tablet: "M3.5 2h9v12h-9zM7 12.5h2",
    phone: "M5 1.5h6v13H5zM7 13h2",
  };
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.deviceIcon}>
      <path d={paths[kind]} />
    </svg>
  );
}
