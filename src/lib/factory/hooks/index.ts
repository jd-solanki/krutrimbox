import { createHooks, type Hookable } from "hookable";
import type { KrutrimboxHooks } from "./types";

export * from "./names";
export * from "./types";
export * from "./actions";

// Creates a fresh, typed hook bus for one Factory Run. Configured Hook Actions are
// registered onto it (see registerHookActions) and krutrimbox fires lifecycle hooks
// through it with `callHook`.
export function createKrutrimboxHooks(): Hookable<KrutrimboxHooks> {
  return createHooks<KrutrimboxHooks>();
}
