/**
 * Keeps the live Zustand store mirrored to localStorage, and on first
 * paint tries to reload the last YAML config file the user opened/saved
 * (File System Access handle in IndexedDB).
 */

import { currentSnapshot, useSimStore } from "../state";
import { saveSnapshot } from "./persistence";
import { autosaveBoundFileIfPermitted } from "./fileIO";

const AUTOSAVE_MS = 400;

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Call once from the app entrypoint. */
export function startPersistence(): void {
  if (started) return;
  started = true;

  useSimStore.subscribe((state, previous) => {
    const colorAuthoringChanged =
      state.sky.sunStops !== previous.sky.sunStops ||
      state.sky.moonStops !== previous.sky.moonStops ||
      state.sky.ambientStops !== previous.sky.ambientStops ||
      state.ambient !== previous.ambient ||
      state.strand.colorProfile !== previous.strand.colorProfile;
    if (colorAuthoringChanged) {
      saveSnapshot(currentSnapshot());
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      saveSnapshot(currentSnapshot());
      void autosaveBoundFileIfPermitted();
    }, AUTOSAVE_MS);
  });

  // Flush the latest state before the page is hidden or unloaded. This
  // closes the debounce window when refreshing, closing, or backgrounding.
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    saveSnapshot(currentSnapshot());
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  // Do not silently reload the previously bound YAML here. The browser
  // snapshot is the live autosave and may be newer; files remain available
  // through the explicit Load controls.
}
