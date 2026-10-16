import { describe, expect, it } from "vitest";

import { canRotate, DEVICES, familyOf, frameSize, getDevice, PRIMARY_DEVICE_IDS, resolveAddress, scaleFor, VARIANTS, viewport, withCacheBust } from "./devices";

describe("device presets", () => {
  it("has every requested family and resolvable ids", () => {
    expect(PRIMARY_DEVICE_IDS).toEqual(["responsive", "widescreen", "18in", "16in", "13in", "12in", "10in", "iphone", "android"]);
    for (const id of [...PRIMARY_DEVICE_IDS, ...Object.values(VARIANTS).flat()]) expect(getDevice(id).id).toBe(id);
    expect(new Set(DEVICES.map((d) => d.id)).size).toBe(DEVICES.length);
  });

  it("falls back to responsive for unknown ids and maps variants to their family", () => {
    expect(getDevice("nope").id).toBe("responsive");
    expect(familyOf("iphone-se")).toBe("iphone");
    expect(familyOf("android-galaxy")).toBe("android");
    expect(familyOf("16in")).toBe("16in");
  });

  it("only rotates tablets and phones", () => {
    const phone = getDevice("iphone");
    expect(canRotate(phone)).toBe(true);
    expect(viewport(phone, true)).toEqual({ width: 874, height: 402 });
    const laptop = getDevice("16in");
    expect(canRotate(laptop)).toBe(false);
    expect(viewport(laptop, true)).toEqual({ width: 1728, height: 1117 });
  });
});

it("adds the bezel or window bar to the frame size", () => {
  expect(frameSize(getDevice("16in"), false)).toEqual({ width: 1730, height: 1147 });
  expect(frameSize(getDevice("iphone"), true)).toEqual({ width: 922, height: 450 });
  expect(frameSize(getDevice("responsive"), false)).toEqual({ width: 0, height: 0 });
});

describe("scaleFor", () => {
  it("fits large devices into the pane and never upscales", () => {
    expect(scaleFor({ width: 2562, height: 1110 }, { width: 1000, height: 800 }, "fit")).toBeCloseTo(952 / 2562);
    expect(scaleFor({ width: 450, height: 922 }, { width: 2000, height: 2000 }, "fit")).toBe(1);
    expect(scaleFor({ width: 450, height: 922 }, { width: 2000, height: 600 }, "fit")).toBeCloseTo(552 / 922);
  });

  it("uses fixed zoom levels as given and survives an unmeasured pane", () => {
    expect(scaleFor({ width: 2562, height: 1110 }, { width: 100, height: 100 }, 0.5)).toBe(0.5);
    expect(scaleFor({ width: 100, height: 100 }, { width: 0, height: 0 }, "fit")).toBe(1);
  });
});

describe("resolveAddress", () => {
  const app = "http://127.0.0.1:4321/";

  it("keeps navigation on the app's own origin", () => {
    expect(resolveAddress("/tickets?open=1", app)).toBe("http://127.0.0.1:4321/tickets?open=1");
    expect(resolveAddress("tickets", app)).toBe("http://127.0.0.1:4321/tickets");
    expect(resolveAddress("https://evil.example/", app)).toBeNull();
    expect(resolveAddress("//evil.example/x", app)).toBeNull();
    expect(resolveAddress("", app)).toBe(app);
  });

  it("accepts any http(s) URL when no app is running, and nothing else", () => {
    expect(resolveAddress("wasmer.io", null)).toBe("https://wasmer.io/");
    expect(resolveAddress("http://127.0.0.1:8080/x", null)).toBe("http://127.0.0.1:8080/x");
    expect(resolveAddress("javascript:alert(1)", null)).toBeNull();
    expect(resolveAddress("file:///etc/passwd", null)).toBeNull();
    expect(resolveAddress("data:text/html,hi", null)).toBeNull();
    expect(resolveAddress("   ", null)).toBeNull();
  });
});

it("adds a cache-busting parameter without losing the existing query", () => {
  expect(withCacheBust("https://app.example/list?page=2", 42)).toBe("https://app.example/list?page=2&__vessel_reload=42");
});
