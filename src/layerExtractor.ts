/**
 * layerExtractor.ts
 *
 * Extracts perceptual sub-layers from a paint-by-numbers image:
 *   - shadow    : pixels darker than their k-means cluster mean
 *   - highlight : pixels brighter than their k-means cluster mean
 *   - depth     : absolute-luminance cel-shading bands (dark/mid/light/bright)
 *   - lineart   : thick-stroke SVG built directly from base facets
 *
 * Each layer is returned as a LayerData object containing palette,
 * facets, and pre-built SVG variants — ready to be composited in Android.
 */

import { rgb2lab }                  from "./lib/colorconversion";
import { FacetBorderSegmenter }     from "./facetBorderSegmenter";
import { FacetBorderTracer }        from "./facetBorderTracer";
import { FacetCreator }             from "./facetCreator";
import { FacetLabelPlacer }         from "./facetLabelPlacer";
import { FacetResult }              from "./facetmanagement";
import { FacetReducer }             from "./facetReducer";
import { RGB }                      from "./common";
import { ColorMapResult }           from "./colorreductionmanagement";
import { Uint8Array2D }             from "./structs/typedarrays";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface PaletteEntry {
    index:          number;
    color:          RGB;
    hex:            string;
    frequency:      number;
    areaPercentage: number;
}

export interface FacetPath {
    id:         number;
    colorIndex: number;
    colorHex:   string;
    d:          string;
    label:      { x: number; y: number; w: number; h: number; number: number } | null;
}

export interface SVGVariants {
    outline:  string;
    colored:  string;
    numbered: string;
    animated: string;
}

export interface LayerData {
    id:           string;
    label:        string;
    description:  string;
    /** Android PorterDuff blend mode key */
    blendMode:    "NORMAL" | "MULTIPLY" | "SCREEN" | "OVERLAY" | "ADD";
    opacity:      number;
    zIndex:       number;
    /** true = user can paint this layer; false = auto/decorative */
    paintable:    boolean;
    colorCount:   number;
    palette:      PaletteEntry[];
    facets:       FacetPath[];
    svg:          SVGVariants;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SENTINEL = 252; // color index used for "transparent/background" regions

function toHex(c: RGB): string {
    return "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
}

/** Perceptual LAB lightness (L in 0-100) */
function labL(r: number, g: number, b: number): number {
    return rgb2lab([r, g, b])[0];
}

/** Clamp to [0, 255] */
function clamp255(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v)));
}

/** Run the full facet pipeline on a custom color-index map */
async function runFacetPipeline(
    colorIndices:        Uint8Array2D,
    colorsByIndex:       RGB[],
    width:               number,
    height:              number,
    minFacetSize:        number,
    halveBorderSegments: number,
): Promise<FacetResult> {
    const fr = await FacetCreator.getFacets(width, height, colorIndices, null);

    await FacetReducer.reduceFacets(
        minFacetSize,
        true,
        Number.MAX_VALUE,
        colorsByIndex,
        fr,
        colorIndices,
        null,
    );

    await FacetBorderTracer.buildFacetBorderPaths(fr, null);
    await FacetBorderSegmenter.buildFacetBorderSegments(fr, halveBorderSegments, null);
    await FacetLabelPlacer.buildFacetLabelBounds(fr, null);

    return fr;
}

/** Build the SVG path string for a facet result, skipping sentinel facets */
function buildLayerSVG(
    facets:   FacetPath[],
    W:        number,
    H:        number,
    variant:  "outline" | "colored" | "numbered" | "animated",
    bgColor:  string = "none",
): string {
    let body = "";

    facets.forEach((f, i) => {
        let fill: string, stroke: string, strokeW: string, extra = "";

        switch (variant) {
            case "outline":
                fill = "white"; stroke = "#2a2a2a"; strokeW = "0.9";
                break;
            case "colored":
                fill = f.colorHex; stroke = "rgba(0,0,0,0.12)"; strokeW = "0.4";
                break;
            case "animated":
                fill = "white"; stroke = "#2a2a2a"; strokeW = "0.9";
                extra = `class="ap" style="--c:${f.colorHex};animation-delay:${(i * 31) % 4000}ms"`;
                break;
            case "numbered":
            default:
                fill = "white"; stroke = "#2a2a2a"; strokeW = "0.9";
        }

        body += `<path d="${f.d}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" stroke-linejoin="round" ${extra}/>\n`;

        if (variant === "numbered" && f.label) {
            const { x, y, w, h, number } = f.label;
            const digits   = String(number).length;
            const fontSize = Math.max(4, Math.min(18, (Math.min(w, h) * 0.5) / digits));
            body += `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2).toFixed(1)}"
  font-family="Arial,sans-serif" font-size="${fontSize.toFixed(1)}"
  font-weight="700" fill="#111" opacity="0.85"
  dominant-baseline="middle" text-anchor="middle"
  pointer-events="none">${number}</text>\n`;
        }
    });

    const animStyle = variant === "animated" ? `<style>
  .ap{fill:white}
  @keyframes layerFill{0%{fill:white}100%{fill:var(--c)}}
  .playing .ap{animation:layerFill 0.7s ease forwards}
</style>\n` : "";

    const bg = bgColor !== "none" ? ` style="background:${bgColor}"` : "";

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"${bg}>\n${animStyle}${body}</svg>`;
}

/** Convert a facet result + color list into FacetPath[], skipping sentinels */
function facetResultToPaths(fr: FacetResult, colors: RGB[], mult: number, sentinelIdx: number): FacetPath[] {
    const out: FacetPath[] = [];

    for (const f of fr.facets) {
        if (!f || f.borderSegments.length === 0) continue;
        if (f.color === sentinelIdx) continue;           // skip background

        let pts = f.getFullPathFromBorderSegments(false);
        if (pts[0].x !== pts[pts.length - 1].x || pts[0].y !== pts[pts.length - 1].y) {
            pts.push(pts[0]);
        }

        let d = `M ${pts[0].x * mult} ${pts[0].y * mult} `;
        for (let k = 1; k < pts.length; k++) {
            const mx = (pts[k].x + pts[k - 1].x) / 2;
            const my = (pts[k].y + pts[k - 1].y) / 2;
            d += `Q ${mx * mult} ${my * mult} ${pts[k].x * mult} ${pts[k].y * mult} `;
        }

        const c = colors[f.color];
        out.push({
            id:         f.id,
            colorIndex: f.color,
            colorHex:   toHex(c),
            d,
            label: f.labelBounds ? {
                x:      f.labelBounds.minX   * mult,
                y:      f.labelBounds.minY   * mult,
                w:      f.labelBounds.width  * mult,
                h:      f.labelBounds.height * mult,
                number: f.color,
            } : null,
        });
    }

    return out;
}

function buildPalette(facets: FacetPath[], colors: RGB[], W: number, H: number): PaletteEntry[] {
    const freq = colors.map(() => 0);
    for (const f of facets) { freq[f.colorIndex] = (freq[f.colorIndex] || 0) + 1; }
    const total = Math.max(1, freq.reduce((s, v) => s + v, 0));

    return colors.map((c, idx) => ({
        index:          idx,
        color:          c,
        hex:            toHex(c),
        frequency:      freq[idx],
        areaPercentage: parseFloat((freq[idx] / total).toFixed(4)),
    }));
}

// ─── Shadow Layer ─────────────────────────────────────────────────────────────

export interface ShadowHighlightOptions {
    /** Minimum delta-L (0-100 scale) to qualify as shadow */
    shadowThreshold?:       number;
    /** Minimum delta-L to qualify as highlight */
    highlightThreshold?:    number;
    /** Minimum pixel count in a cluster to produce a shadow/highlight color */
    minClusterPixels?:      number;
    /** Minimum facet size for the sub-layer pipeline */
    minFacetSize?:          number;
    halveBorderSegments?:   number;
}

/**
 * Builds a Shadow sub-layer.
 * Pixels whose LAB lightness is at least `shadowThreshold` units below
 * their k-means cluster mean are grouped into per-cluster shadow colors
 * and processed through a full facet pipeline.
 */
export async function buildShadowLayer(
    origData: ImageData,
    colormap: ColorMapResult,
    mult:     number,
    opts:     ShadowHighlightOptions = {},
): Promise<LayerData> {
    const {
        shadowThreshold    = 14,
        minClusterPixels   = 80,
        minFacetSize       = 40,
        halveBorderSegments = 2,
    } = opts;

    const W = origData.width, H = origData.height;
    const K = colormap.colorsByIndex.length;

    // Pre-compute cluster LAB-L values
    const clusterLabL = colormap.colorsByIndex.map(c => labL(c[0], c[1], c[2]));

    // Accumulate shadow pixel sums per cluster
    const sums = Array.from({ length: K }, () => ({ r: 0, g: 0, b: 0, n: 0 }));
    const isShadow = new Uint8Array(W * H);

    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const p   = (j * W + i) * 4;
            const r   = origData.data[p], g = origData.data[p + 1], b = origData.data[p + 2];
            const ci  = colormap.imgColorIndices.get(i, j);
            const dL  = labL(r, g, b) - clusterLabL[ci];

            if (dL < -shadowThreshold) {
                sums[ci].r += r; sums[ci].g += g; sums[ci].b += b; sums[ci].n++;
                isShadow[j * W + i] = 1;
            }
        }
    }

    // Derive shadow colors (one per qualifying cluster)
    const shadowColors: RGB[]       = [];
    const clusterToIdx: number[]    = new Array(K).fill(-1);

    for (let k = 0; k < K; k++) {
        if (sums[k].n >= minClusterPixels) {
            clusterToIdx[k] = shadowColors.length;
            shadowColors.push([
                clamp255(sums[k].r / sums[k].n),
                clamp255(sums[k].g / sums[k].n),
                clamp255(sums[k].b / sums[k].n),
            ]);
        }
    }

    if (shadowColors.length === 0) {
        return emptyLayer("shadow", "Shadows & Shading", "MULTIPLY", 0.8, 1, mult, W * mult, H * mult);
    }

    // Sentinel color appended at the end
    const sentinelIdx = shadowColors.length;
    const allColors: RGB[] = [...shadowColors, [220, 220, 220]];

    // Build shadow color-index map
    const shadowIdx = new Uint8Array2D(W, H);
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const pIdx = j * W + i;
            if (isShadow[pIdx]) {
                const ci  = colormap.imgColorIndices.get(i, j);
                const sci = clusterToIdx[ci];
                shadowIdx.set(i, j, sci !== -1 ? sci : sentinelIdx);
            } else {
                shadowIdx.set(i, j, sentinelIdx);
            }
        }
    }

    // Run facet pipeline
    const fr      = await runFacetPipeline(shadowIdx, allColors, W, H, minFacetSize, halveBorderSegments);
    const SvgW    = W * mult, SvgH = H * mult;
    const facets  = facetResultToPaths(fr, shadowColors, mult, sentinelIdx);
    const palette = buildPalette(facets, shadowColors, SvgW, SvgH);

    return {
        id:          "shadow",
        label:       "Shadows & Shading",
        description: "Darker regions relative to each base color. Paint with MULTIPLY blend mode in your app.",
        blendMode:   "MULTIPLY",
        opacity:     0.82,
        zIndex:      1,
        paintable:   true,
        colorCount:  shadowColors.length,
        palette,
        facets,
        svg: {
            outline:  buildLayerSVG(facets, SvgW, SvgH, "outline"),
            colored:  buildLayerSVG(facets, SvgW, SvgH, "colored"),
            numbered: buildLayerSVG(facets, SvgW, SvgH, "numbered"),
            animated: buildLayerSVG(facets, SvgW, SvgH, "animated"),
        },
    };
}

// ─── Highlight Layer ──────────────────────────────────────────────────────────

/**
 * Builds a Highlight sub-layer.
 * Pixels whose LAB lightness is at least `highlightThreshold` units above
 * their cluster mean are treated as specular/highlight regions.
 */
export async function buildHighlightLayer(
    origData: ImageData,
    colormap: ColorMapResult,
    mult:     number,
    opts:     ShadowHighlightOptions = {},
): Promise<LayerData> {
    const {
        highlightThreshold  = 20,
        minClusterPixels    = 60,
        minFacetSize        = 30,
        halveBorderSegments  = 2,
    } = opts;

    const W = origData.width, H = origData.height;
    const K = colormap.colorsByIndex.length;

    const clusterLabL = colormap.colorsByIndex.map(c => labL(c[0], c[1], c[2]));

    const sums     = Array.from({ length: K }, () => ({ r: 0, g: 0, b: 0, n: 0 }));
    const isHigh   = new Uint8Array(W * H);

    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const p  = (j * W + i) * 4;
            const r  = origData.data[p], g = origData.data[p + 1], b = origData.data[p + 2];
            const ci = colormap.imgColorIndices.get(i, j);
            const dL = labL(r, g, b) - clusterLabL[ci];

            if (dL > highlightThreshold) {
                sums[ci].r += r; sums[ci].g += g; sums[ci].b += b; sums[ci].n++;
                isHigh[j * W + i] = 1;
            }
        }
    }

    const highColors: RGB[]      = [];
    const clusterToIdx: number[] = new Array(K).fill(-1);

    for (let k = 0; k < K; k++) {
        if (sums[k].n >= minClusterPixels) {
            clusterToIdx[k] = highColors.length;
            // Boost towards white for highlight visual
            const baseR = sums[k].r / sums[k].n;
            const baseG = sums[k].g / sums[k].n;
            const baseB = sums[k].b / sums[k].n;
            highColors.push([
                clamp255(baseR * 0.5 + 255 * 0.5),
                clamp255(baseG * 0.5 + 255 * 0.5),
                clamp255(baseB * 0.5 + 255 * 0.5),
            ]);
        }
    }

    if (highColors.length === 0) {
        return emptyLayer("highlight", "Highlights & Sparkle", "SCREEN", 0.7, 2, mult, W * mult, H * mult);
    }

    const sentinelIdx  = highColors.length;
    const allColors: RGB[] = [...highColors, [30, 30, 30]];

    const highIdx = new Uint8Array2D(W, H);
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const pIdx = j * W + i;
            if (isHigh[pIdx]) {
                const ci  = colormap.imgColorIndices.get(i, j);
                const hci = clusterToIdx[ci];
                highIdx.set(i, j, hci !== -1 ? hci : sentinelIdx);
            } else {
                highIdx.set(i, j, sentinelIdx);
            }
        }
    }

    const fr      = await runFacetPipeline(highIdx, allColors, W, H, minFacetSize, halveBorderSegments);
    const SvgW    = W * mult, SvgH = H * mult;
    const facets  = facetResultToPaths(fr, highColors, mult, sentinelIdx);
    const palette = buildPalette(facets, highColors, SvgW, SvgH);

    return {
        id:          "highlight",
        label:       "Highlights & Sparkle",
        description: "Brighter/specular regions. Paint with SCREEN blend for shimmer and sparkle effects.",
        blendMode:   "SCREEN",
        opacity:     0.70,
        zIndex:      2,
        paintable:   true,
        colorCount:  highColors.length,
        palette,
        facets,
        svg: {
            outline:  buildLayerSVG(facets, SvgW, SvgH, "outline"),
            colored:  buildLayerSVG(facets, SvgW, SvgH, "colored"),
            numbered: buildLayerSVG(facets, SvgW, SvgH, "numbered"),
            animated: buildLayerSVG(facets, SvgW, SvgH, "animated"),
        },
    };
}

// ─── Depth / Cel-shading Layer ────────────────────────────────────────────────

export interface DepthLayerOptions {
    /** Number of luminance bands (2–6). Default: 4 */
    bands?:              number;
    minFacetSize?:       number;
    halveBorderSegments?: number;
}

/**
 * Splits the image into absolute-luminance bands (dark → bright).
 * Useful for cel-shading overlays.
 */
export async function buildDepthLayer(
    origData: ImageData,
    mult:     number,
    opts:     DepthLayerOptions = {},
): Promise<LayerData> {
    const {
        bands               = 4,
        minFacetSize        = 60,
        halveBorderSegments  = 2,
    } = opts;

    const W = origData.width, H = origData.height;

    // Cel colors from dark to bright
    const bandColors: RGB[] = Array.from({ length: bands }, (_, i) => {
        const t = i / (bands - 1);
        const v = clamp255(30 + t * 220);
        // Slightly cool for shadows, warm for lights — anime look
        return [
            clamp255(v - (1 - t) * 15),
            clamp255(v),
            clamp255(v + (1 - t) * 20),
        ];
    });

    const sentinelIdx = bands; // we won't use a real sentinel here — all pixels assigned
    const allColors: RGB[] = [...bandColors];

    const depthIdx = new Uint8Array2D(W, H);
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const p   = (j * W + i) * 4;
            const r   = origData.data[p], g = origData.data[p + 1], b = origData.data[p + 2];
            const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255; // 0-1
            const band = Math.min(bands - 1, Math.floor(lum * bands));
            depthIdx.set(i, j, band);
        }
    }

    const fr      = await runFacetPipeline(depthIdx, allColors, W, H, minFacetSize, halveBorderSegments);
    const SvgW    = W * mult, SvgH = H * mult;
    const facets  = facetResultToPaths(fr, bandColors, mult, sentinelIdx);
    const palette = buildPalette(facets, bandColors, SvgW, SvgH);

    return {
        id:          "depth",
        label:       "Depth / Cel Shading",
        description: "Absolute luminance bands for anime-style cel shading. Use OVERLAY blend mode.",
        blendMode:   "OVERLAY",
        opacity:     0.45,
        zIndex:      3,
        paintable:   true,
        colorCount:  bands,
        palette,
        facets,
        svg: {
            outline:  buildLayerSVG(facets, SvgW, SvgH, "outline"),
            colored:  buildLayerSVG(facets, SvgW, SvgH, "colored"),
            numbered: buildLayerSVG(facets, SvgW, SvgH, "numbered"),
            animated: buildLayerSVG(facets, SvgW, SvgH, "animated"),
        },
    };
}

// ─── Lineart Layer ────────────────────────────────────────────────────────────

/**
 * Builds a lineart (outline) layer from the base facet paths.
 * No numbers, just crisp black strokes — acts as the permanent top layer.
 */
export function buildLineartLayer(
    baseFacets: FacetPath[],
    SvgW:       number,
    SvgH:       number,
    strokeColor: string  = "#1a1a1a",
    strokeWidth: number  = 2.2,
): LayerData {
    // Build the lineart SVG: fill=none, thick strokes only
    let body = "";
    baseFacets.forEach(f => {
        body += `<path d="${f.d}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>\n`;
    });

    const lineartSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SvgW} ${SvgH}" width="${SvgW}" height="${SvgH}">\n${body}</svg>`;

    return {
        id:          "lineart",
        label:       "Line Art / Outlines",
        description: "Permanent top-layer outlines derived from base facet borders. Always rendered on top with MULTIPLY.",
        blendMode:   "MULTIPLY",
        opacity:     1.0,
        zIndex:      10,
        paintable:   false,
        colorCount:  1,
        palette:     [{
            index:          0,
            color:          [26, 26, 26],
            hex:            strokeColor,
            frequency:      baseFacets.length,
            areaPercentage: 1,
        }],
        facets: [],
        svg: {
            outline:  lineartSVG,
            colored:  lineartSVG,
            numbered: lineartSVG,
            animated: lineartSVG,
        },
    };
}

// ─── Sobel Detail Layer ───────────────────────────────────────────────────────

/**
 * Applies a Sobel operator to find fine edge details that k-means may have
 * smoothed over. Returns an SVG of semi-transparent edge strokes.
 * Optional — use when you need maximum detail fidelity.
 */
export function buildSobelDetailSVG(
    origData:  ImageData,
    threshold: number = 60,
    mult:      number = 3,
    opacity:   number = 0.4,
): string {
    const W = origData.width, H = origData.height;
    const gray = new Float32Array(W * H);

    // Greyscale
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const p = (j * W + i) * 4;
            gray[j * W + i] = 0.299 * origData.data[p] + 0.587 * origData.data[p + 1] + 0.114 * origData.data[p + 2];
        }
    }

    // Sobel
    const edges: boolean[] = new Array(W * H).fill(false);
    for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
            const Gx =
                -gray[(j - 1) * W + (i - 1)] + gray[(j - 1) * W + (i + 1)]
                - 2 * gray[j * W + (i - 1)]  + 2 * gray[j * W + (i + 1)]
                - gray[(j + 1) * W + (i - 1)] + gray[(j + 1) * W + (i + 1)];
            const Gy =
                -gray[(j - 1) * W + (i - 1)] - 2 * gray[(j - 1) * W + i] - gray[(j - 1) * W + (i + 1)]
                + gray[(j + 1) * W + (i - 1)] + 2 * gray[(j + 1) * W + i] + gray[(j + 1) * W + (i + 1)];
            edges[j * W + i] = Math.sqrt(Gx * Gx + Gy * Gy) > threshold;
        }
    }

    // Convert to compact SVG rects (group runs per row for efficiency)
    let body = "";
    for (let j = 1; j < H - 1; j++) {
        let runStart = -1;
        for (let i = 1; i < W; i++) {
            const isEdge = edges[j * W + i];
            if (isEdge && runStart === -1) {
                runStart = i;
            } else if (!isEdge && runStart !== -1) {
                const rx = runStart * mult, ry = j * mult;
                const rw = (i - runStart) * mult, rh = mult;
                body += `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}"/>\n`;
                runStart = -1;
            }
        }
        if (runStart !== -1) {
            const rx = runStart * mult, ry = j * mult;
            const rw = (W - runStart) * mult, rh = mult;
            body += `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}"/>\n`;
        }
    }

    const SvgW = W * mult, SvgH = H * mult;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SvgW} ${SvgH}" width="${SvgW}" height="${SvgH}">
<g fill="rgba(0,0,0,${opacity})">
${body}</g></svg>`;
}

// ─── Composite preview SVG ────────────────────────────────────────────────────

/**
 * Builds a single composite SVG that stacks all layer SVGs using
 * mix-blend-mode CSS properties for browser preview.
 */
export function buildCompositeSVG(layers: LayerData[], SvgW: number, SvgH: number): string {
    const blendMap: Record<string, string> = {
        NORMAL:   "normal",
        MULTIPLY: "multiply",
        SCREEN:   "screen",
        OVERLAY:  "overlay",
        ADD:      "lighten",
    };

    let groups = "";
    for (const layer of layers.sort((a, b) => a.zIndex - b.zIndex)) {
        const blend = blendMap[layer.blendMode] || "normal";
        const svgContent = layer.svg.colored
            .replace(/^<svg[^>]*>/, "")
            .replace(/<\/svg>$/, "");
        groups += `<g id="layer-${layer.id}" style="mix-blend-mode:${blend};opacity:${layer.opacity}">\n${svgContent}\n</g>\n`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SvgW} ${SvgH}" width="${SvgW}" height="${SvgH}" style="background:#fff">
${groups}</svg>`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function emptyLayer(
    id: string, label: string, blend: LayerData["blendMode"],
    opacity: number, zIndex: number,
    mult: number, SvgW: number, SvgH: number,
): LayerData {
    const emptySVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SvgW} ${SvgH}" width="${SvgW}" height="${SvgH}"></svg>`;
    return {
        id, label,
        description:  "No significant regions detected for this layer.",
        blendMode:     blend,
        opacity,
        zIndex,
        paintable:    false,
        colorCount:   0,
        palette:      [],
        facets:       [],
        svg:          { outline: emptySVG, colored: emptySVG, numbered: emptySVG, animated: emptySVG },
    };
}
