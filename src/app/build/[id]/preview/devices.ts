// Preview device presets in CSS pixels: the viewport a site actually lays out against.

export type DeviceKind = "responsive" | "desktop" | "tablet" | "phone";
export type Device = { id: string; label: string; detail: string; kind: DeviceKind; width: number; height: number };

export const DEVICES: Device[] = [
  { id: "responsive", label: "Responsive", detail: "Fills the pane", kind: "responsive", width: 0, height: 0 },
  { id: "widescreen", label: "Widescreen", detail: "34″ ultrawide", kind: "desktop", width: 2560, height: 1080 },
  { id: "18in", label: "18″", detail: "18″ laptop at 125%", kind: "desktop", width: 1920, height: 1200 },
  { id: "16in", label: "16″", detail: "MacBook Pro 16″", kind: "desktop", width: 1728, height: 1117 },
  { id: "13in", label: "13″", detail: "MacBook Air 13″", kind: "desktop", width: 1470, height: 956 },
  { id: "12in", label: "12″", detail: "12″ laptop", kind: "desktop", width: 1280, height: 800 },
  { id: "10in", label: "10″", detail: "iPad 10th gen", kind: "tablet", width: 820, height: 1180 },
  { id: "iphone", label: "iPhone", detail: "iPhone 16 Pro", kind: "phone", width: 402, height: 874 },
  { id: "iphone-se", label: "iPhone SE", detail: "iPhone SE", kind: "phone", width: 375, height: 667 },
  { id: "iphone-max", label: "iPhone Pro Max", detail: "iPhone 16 Pro Max", kind: "phone", width: 440, height: 956 },
  { id: "android", label: "Android", detail: "Pixel 9", kind: "phone", width: 412, height: 915 },
  { id: "android-galaxy", label: "Galaxy", detail: "Galaxy S24", kind: "phone", width: 360, height: 780 },
];

/** The main row in the device bar; variants live in a menu under their family. */
export const PRIMARY_DEVICE_IDS = ["responsive", "widescreen", "18in", "16in", "13in", "12in", "10in", "iphone", "android"];
export const VARIANTS: Record<string, string[]> = {
  iphone: ["iphone", "iphone-se", "iphone-max"],
  android: ["android", "android-galaxy"],
};
export const familyOf = (id: string) => Object.entries(VARIANTS).find(([, ids]) => ids.includes(id))?.[0] ?? id;

export const getDevice = (id: string) => DEVICES.find((d) => d.id === id) ?? DEVICES[0];
export const canRotate = (d: Device) => d.kind === "tablet" || d.kind === "phone";

/** Width and height after rotation; landscape swaps the two. */
export function viewport(d: Device, landscape: boolean) {
  return landscape && canRotate(d) ? { width: d.height, height: d.width } : { width: d.width, height: d.height };
}

// Total size the device frame adds around the viewport, so scaling accounts for the whole frame.
export const FRAME_EXTRA: Record<DeviceKind, { width: number; height: number }> = {
  responsive: { width: 0, height: 0 },
  desktop: { width: 2, height: 30 }, // 1px border each side, 28px window bar
  tablet: { width: 56, height: 56 }, // 28px bezel
  phone: { width: 48, height: 48 }, // 24px bezel
};

export function frameSize(d: Device, landscape: boolean) {
  const v = viewport(d, landscape);
  const extra = FRAME_EXTRA[d.kind];
  return { width: v.width + extra.width, height: v.height + extra.height };
}

export type Zoom = "fit" | 0.5 | 0.75 | 1;

/** Scale so the framed device fits the pane; never upscales past 100%. */
export function scaleFor(frame: { width: number; height: number }, pane: { width: number; height: number }, zoom: Zoom, padding = 24) {
  if (zoom !== "fit") return zoom;
  const w = pane.width - padding * 2;
  const h = pane.height - padding * 2;
  if (w <= 0 || h <= 0 || frame.width <= 0 || frame.height <= 0) return 1;
  return Math.min(1, w / frame.width, h / frame.height);
}

/**
 * Resolve what the user typed in the address bar.
 * With an app URL, only paths on that app's origin are allowed. Without one, any http(s) URL can be previewed.
 */
export function resolveAddress(input: string, appUrl: string | null): string | null {
  const text = input.trim();
  if (!text) return appUrl;
  try {
    if (appUrl) {
      const base = new URL(appUrl);
      const next = new URL(text, base);
      return next.origin === base.origin ? next.href : null;
    }
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Same URL with a cache-busting parameter, for a hard reload. */
export function withCacheBust(url: string, now = Date.now()) {
  const u = new URL(url);
  u.searchParams.set("__vessel_reload", String(now));
  return u.href;
}
