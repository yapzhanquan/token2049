"use client";
// Pan + zoom for an SVG canvas, as a translate/scale transform on one <g>.
// - Ctrl/⌘ + wheel or a pinch: zoom at the pointer. Plain wheel / trackpad: pan. Drag: pan.
// - Keys + − 0 (fit). Buttons call zoomBy / fit.
// - Until the user zooms or pans, the view keeps fitting the content as it grows.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as RPointerEvent, type RefObject } from "react";

interface View {
  x: number;
  y: number;
  k: number;
}
const MIN_K = 0.25;
const MAX_K = 2.5;
const DRAG_PX = 4;
export const ZOOM_STEP = 1.25;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function usePanZoom(ref: RefObject<SVGSVGElement | null>, contentW: number, contentH: number) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [touched, setTouched] = useState(false);
  const [panning, setPanning] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dropClick = useRef(false);

  const fitView = useCallback(
    (b: { w: number; h: number }): View => {
      const k = clamp(Math.min(b.w / contentW, b.h / contentH, 1), MIN_K, 1);
      return { k, x: Math.max(8, (b.w - contentW * k) / 2), y: (b.h - contentH * k) / 2 };
    },
    [contentW, contentH],
  );

  // Measure the box.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (width > 0 && height > 0) setBox((b) => (b && b.w === width && b.h === height ? b : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  // Keep fitting until the reader takes over.
  useEffect(() => {
    if (box && !touched) setView(fitView(box));
  }, [box, touched, fitView]);

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const el = ref.current;
      if (!el || !box) return;
      const r = el.getBoundingClientRect();
      const px = clientX === undefined ? box.w / 2 : clientX - r.left;
      const py = clientY === undefined ? box.h / 2 : clientY - r.top;
      setTouched(true);
      setView((v) => {
        const cur = v ?? fitView(box);
        const k = clamp(cur.k * factor, MIN_K, MAX_K);
        return { k, x: px - (px - cur.x) * (k / cur.k), y: py - (py - cur.y) * (k / cur.k) };
      });
    },
    [box, fitView, ref],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      if (!box) return;
      setTouched(true);
      setView((v) => {
        const cur = v ?? fitView(box);
        return { ...cur, x: cur.x + dx, y: cur.y + dy };
      });
    },
    [box, fitView],
  );

  const fit = useCallback(() => {
    setTouched(false);
    if (box) setView(fitView(box));
  }, [box, fitView]);

  /** Bring a content point into view (centre on it) if it is outside. */
  const reveal = useCallback(
    (p: { x: number; y: number }) => {
      if (!box || !view) return;
      const sx = view.x + p.x * view.k;
      const sy = view.y + p.y * view.k;
      if (sx > 40 && sx < box.w - 160 && sy > 30 && sy < box.h - 30) return;
      setTouched(true);
      setView({ ...view, x: box.w / 2 - 120 - p.x * view.k, y: box.h / 2 - p.y * view.k });
    },
    [box, view],
  );

  // Native wheel listener (needs passive: false to stop the page scrolling).
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (box?.h ?? 400) : 1;
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-clamp(e.deltaY * unit, -40, 40) * 0.01), e.clientX, e.clientY);
    else panBy(-(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit, -(e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, [ref]);

  const onPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const active = pointers.current;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size > 1) return;
    dropClick.current = false;
    let travel = 0;
    const move = (ev: PointerEvent) => {
      const last = active.get(ev.pointerId);
      if (!last) return;
      const now = { x: ev.clientX, y: ev.clientY };
      const other = [...active.entries()].find(([pid]) => pid !== ev.pointerId)?.[1];
      active.set(ev.pointerId, now);
      if (other) {
        const before = Math.hypot(last.x - other.x, last.y - other.y);
        const after = Math.hypot(now.x - other.x, now.y - other.y);
        travel = Infinity;
        if (before > 0) zoomAt(after / before, (now.x + other.x) / 2, (now.y + other.y) / 2);
        return;
      }
      travel += Math.abs(now.x - last.x) + Math.abs(now.y - last.y);
      if (travel <= DRAG_PX) return;
      setPanning(true);
      panBy(now.x - last.x, now.y - last.y);
    };
    const up = (ev: PointerEvent) => {
      active.delete(ev.pointerId);
      if (active.size > 0) return;
      dropClick.current = travel > DRAG_PX;
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const onClickCapture = (e: MouseEvent) => {
    if (dropClick.current) {
      dropClick.current = false;
      e.stopPropagation();
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomAt(ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoomAt(1 / ZOOM_STEP);
    else if (e.key === "0") fit();
    else return;
    e.preventDefault();
  };

  const v = view ?? { x: 0, y: 0, k: 1 };
  return {
    transform: `translate(${v.x} ${v.y}) scale(${v.k})`,
    zoom: view?.k ?? null,
    panning,
    zoomBy: (f: number) => zoomAt(f),
    fit,
    reveal,
    svgProps: { onPointerDown, onClickCapture, onKeyDown },
  };
}
