"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * False while rendering on the server and during the first client render, true
 * afterwards.
 *
 * Values that only exist in the browser — the local timezone, Web Share file
 * support — would otherwise differ between the server's HTML and the client's
 * first render. Rendering a placeholder until this flips keeps both passes
 * identical without a state-setting effect.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
