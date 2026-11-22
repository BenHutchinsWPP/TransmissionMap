// ─── The drawer's old per-pane names (tests only) ────────────────────────────
// One name per pane and act (openAsk, vizPanel, proxPanel, routeActions,
// setRouteTall, …) and restoreDrawer(resumeAsk, resumeViz), each mapped onto
// drawer.ts (openPane, closePane, paneOpen, panel, headerSlot, setPaneFloor,
// registerSnapshotPart), for the pane tests written against those names.
// restoreDrawer is drawer.ts's, with ui-table.ts's table halves (prepareRestore, startRestore) called synchronously; showTable
// and closeTable are ui-table.ts's own. Production code imports drawer.ts.
// Deps: drawer.ts, ui-table.ts (static: loads the table chunk), drawer-snapshot.ts (types).

import {
  panel, openPane, closePane, paneOpen, headerSlot, setPaneFloor, registerSnapshotPart,
  restoreDrawer as restore,
} from './drawer.js';
import { prepareRestore, startRestore } from './ui-table.js';
import type { VizSnapshot } from './drawer-snapshot.js';

export { drawerPadding, drawerChanged, mapIdle } from './drawer.js';
export { showTable, closeTable } from './ui-table.js';

type Open = (onClose?: () => void, from?: HTMLElement | null) => void;
const opener = (id: 'ask' | 'viz' | 'line' | 'prox' | 'gops'): Open => (onClose, from) => openPane(id, onClose, from);

export const askPanel = (): HTMLElement => panel('ask');
export const openAsk = opener('ask');
export const closeAsk = (): void => closePane('ask');
export const vizPanel = (): HTMLElement => panel('viz');
export const openViz = opener('viz');
export const closeViz = (): void => closePane('viz');
export const vizOpen = (): boolean => paneOpen('viz');
export const linePanel = (): HTMLElement => panel('line');
export const openLine = opener('line');
export const closeLine = (): void => closePane('line');
export const lineOpen = (): boolean => paneOpen('line');
export const proxPanel = (): HTMLElement => panel('prox');
export const openProx = opener('prox');
export const closeProx = (): void => closePane('prox');
export const proxOpen = (): boolean => paneOpen('prox');
export const gopsPanel = (): HTMLElement => panel('gops');
export const openGops = opener('gops');
export const closeGops = (): void => closePane('gops');
export const gopsOpen = (): boolean => paneOpen('gops');
export const routePanel = (): HTMLElement => panel('route');
export const routeActions = (): HTMLElement => headerSlot('route');
export const openRoute = (onClose?: () => void, from?: HTMLElement | null, opts?: { background?: boolean }): void =>
  openPane('route', onClose, from, opts);
export const closeRoute = (): void => closePane('route');
export const routeOpen = (): boolean => paneOpen('route');
/** On: the Route pane's tall floor (540 px); off: none. */
export const setRouteTall = (on: boolean): void => setPaneFloor('route', on ? 540 : 0);
export const registerVizSnapshot = (get: () => VizSnapshot | null): void => registerSnapshotPart('viz', get);

export function restoreDrawer(resumeAsk: () => Promise<void>, resumeViz?: (viz: VizSnapshot) => Promise<void>): Promise<void> {
  return restore({ ask: resumeAsk, viz: resumeViz, table: { prepare: prepareRestore, start: startRestore } });
}
