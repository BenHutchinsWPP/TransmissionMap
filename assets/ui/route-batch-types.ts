// ─── Route batch interfaces ──────────────────────────────────────────────────
// Role: the fixed seams of the batch export, types only, no runtime code: the picture ids,
//       the view a capture is asked for, the capture, PDF-render and ZIP-sink signatures. route-batch-run.ts
//       takes all three injected; route-batch-map.ts implements `Capture`, route-batch-pdf.ts `RenderPdf`,
//       route-batch-zip.ts `ZipSink`.
// Deps: route/surface-image.ts (SurfaceImage, type only), ./route-report-model.ts (RouteReportModel, type only).

import type { SurfaceImage } from '../route/surface-image.js';
import type { RouteReportModel } from './route-report-model.js';

export type PictureId = 'route' | 'cause' | 'weight' | 'cost' | 'similar' | 'alternatives';

export interface CaptureView {
  /** lng/lat W,S,E,N of the path + 10 % */
  bounds: [number, number, number, number];
  path: [number, number][];
  alternatives?: [number, number][][];
  /** The solver's RGBA image for an overlay picture (a WeightImage or a similar-cost SurfaceImage); absent when none was made. */
  overlay?: SurfaceImage;
}

export type Captured = { jpeg: Uint8Array } | { note: string };

export type Capture = (picture: PictureId, view: CaptureView) => Promise<Captured>;

export interface PdfPicture {
  picture: PictureId; jpeg?: Uint8Array; note?: string;
  /** Drawn above the picture or note when present. */
  caption?: string;
  /** Colour key drawn under the picture (the cause map's categories). */
  legend?: { colour: string; label: string }[];
}

export type RenderPdf = (model: RouteReportModel, pictures: PdfPicture[]) => Promise<Uint8Array>;

export interface ZipSink { add(path: string, data: Uint8Array | string): void; bytes(): number }
