/**
 * Type shim: makes the engine source (which was written for browser ImageData/Canvas)
 * compile cleanly against @napi-rs/canvas, which exposes compatible but differently
 * named types.
 */
import type { Canvas, CanvasRenderingContext2D, ImageData } from "@napi-rs/canvas";

declare global {
    interface ImageData extends import("@napi-rs/canvas").ImageData {}
    interface CanvasRenderingContext2D extends import("@napi-rs/canvas").CanvasRenderingContext2D {}
}
