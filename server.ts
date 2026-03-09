/**
 * Paint-by-Numbers Backend — server.ts  v3.0 (ColorArt-compatible)
 * ─────────────────────────────────────────────────────────────────
 * Single  POST /api/process  (and alias  POST /generate)
 * returns a response 100% compatible with the ColorArt React-Native
 * frontend's  DecodedProcessResponse  shape — no frontend changes
 * other than swapping BASE_URL in api.ts.
 *
 * Response shape emitted:
 * {
 *   width, height,
 *   thumbnail_b64,
 *   mega_paths_by_color,
 *   regions[],          ← Region interface (region_id, path_data, …)
 *   palette,            ← string[]  (hex per color index)
 *   palette_stats[],
 *   adjacency,          ← { "regionId": [neighborId, …] }
 *   region_map_b64,     ← zlib-deflated Uint16Array, base64
 *   region_map_width,
 *   region_map_height,
 *   region_map_scale,   ← = MULT (3)
 *   timing, meta
 * }
 */

import express from "express";
import multer from "multer";
import zlib from "zlib";
import compression from "compression";
import { createCanvas, loadImage, Path2D } from "@napi-rs/canvas";

import { ColorReducer } from "./src/colorreductionmanagement";
import { FacetBorderSegmenter } from "./src/facetBorderSegmenter";
import { FacetBorderTracer } from "./src/facetBorderTracer";
import { FacetCreator } from "./src/facetCreator";
import { FacetLabelPlacer } from "./src/facetLabelPlacer";
import { FacetResult } from "./src/facetmanagement";
import { FacetReducer } from "./src/facetReducer";
import { Settings } from "./src/settings";
import { RGB } from "./src/common";
import { FacetPath } from "./src/layerExtractor";

// ─── Settings type ────────────────────────────────────────────────────────────

interface GenerateSettings extends Settings {
    // Layer toggles (all default false for game mode — saves processing time)
    enableShadowLayer?: boolean;
    enableHighlightLayer?: boolean;
    enableDepthLayer?: boolean;
}

// ─── Express setup ────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1); // Trust first proxy (useful for Railway)

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.use(compression()); // Compress responses (gzip/deflate) for performance
app.use(express.json({ limit: "5mb" }));

// CORS
app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next();
});
app.options("*", (_req: express.Request, res: express.Response) => res.sendStatus(204));

// ─── Health (both path variants the frontend may call) ────────────────────────

const healthHandler = (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok", version: "3.0.0-colorart" });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// ─── Main generate handler (shared by both route aliases) ─────────────────────

const generateHandler = upload.single("image");

async function handleGenerate(req: express.Request, res: express.Response): Promise<void> {
    const reqStart = Date.now();
    try {
        if (!req.file) {
            res.status(400).json({ error: "No image uploaded. Use field name 'image'." });
            return;
        }

        // ── Parse settings ──────────────────────────────────────────────────────
        let settings: GenerateSettings = new Settings() as GenerateSettings;
        if (req.body?.settings) {
            try { settings = Object.assign(settings, JSON.parse(req.body.settings)); }
            catch { res.status(400).json({ error: "Invalid JSON in 'settings' field." }); return; }
        }
        // Allow form fields for num_colors / min_region_area (matches api.ts formData.append)
        if (req.body?.num_colors) settings.kMeansNrOfClusters = Number(req.body.num_colors);
        if (req.body?.min_region_area) settings.removeFacetsSmallerThanNrOfPoints = Number(req.body.min_region_area);
        // Game mode: always disable sub-layers unless explicitly requested
        settings.enableShadowLayer = settings.enableShadowLayer ?? false;
        settings.enableHighlightLayer = settings.enableHighlightLayer ?? false;
        settings.enableDepthLayer = settings.enableDepthLayer ?? false;

        // ── Load + optional resize ───────────────────────────────────────────────
        console.log("[0] Loading image …");
        const img = await loadImage(req.file.buffer);
        let c = createCanvas(img.width, img.height);
        let ctx = c.getContext("2d")!;
        ctx.drawImage(img as any, 0, 0);
        let imgData: any = ctx.getImageData(0, 0, c.width, c.height);

        if (
            settings.resizeImageIfTooLarge &&
            (c.width > settings.resizeImageWidth || c.height > settings.resizeImageHeight)
        ) {
            let w = c.width, h = c.height;
            if (w > settings.resizeImageWidth) { h = Math.round(h / w * settings.resizeImageWidth); w = settings.resizeImageWidth; }
            if (h > settings.resizeImageHeight) { w = Math.round(w / h * settings.resizeImageHeight); h = settings.resizeImageHeight; }
            const tmp = createCanvas(w, h);
            tmp.getContext("2d")!.drawImage(c as any, 0, 0, w, h);
            c = createCanvas(w, h); ctx = c.getContext("2d")!;
            ctx.drawImage(tmp as any, 0, 0, w, h);
            imgData = ctx.getImageData(0, 0, w, h);
            console.log(`[resize] ${img.width}×${img.height} → ${w}×${h}`);
        }

        const origW = imgData.width;
        const origH = imgData.height;

        // ── K-Means ──────────────────────────────────────────────────────────────
        console.log("[1] K-means clustering …");
        const kc = createCanvas(origW, origH);
        const kctx = kc.getContext("2d")!;
        kctx.fillStyle = "white";
        kctx.fillRect(0, 0, origW, origH);
        const kImgData: any = kctx.getImageData(0, 0, origW, origH);
        await ColorReducer.applyKMeansClustering(imgData, kImgData, ctx as any, settings, () => {
            kctx.putImageData(kImgData, 0, 0);
        });
        const colormap = ColorReducer.createColorMap(kImgData);

        // ── Facet pipeline ───────────────────────────────────────────────────────
        let facetResult = new FacetResult();
        const runs = settings.narrowPixelStripCleanupRuns || 0;
        for (let run = 0; run < Math.max(runs, 1); run++) {
            if (runs > 0) {
                console.log(`[2] Strip cleanup run ${run + 1}/${runs} …`);
                await ColorReducer.processNarrowPixelStripCleanup(colormap);
            }
            console.log("[3] Creating facets …");
            facetResult = await FacetCreator.getFacets(origW, origH, colormap.imgColorIndices, null);
            console.log("[4] Reducing facets …");
            await FacetReducer.reduceFacets(
                settings.removeFacetsSmallerThanNrOfPoints,
                settings.removeFacetsFromLargeToSmall,
                settings.maximumNumberOfFacets,
                colormap.colorsByIndex, facetResult, colormap.imgColorIndices, null
            );
            if (runs === 0) break;
        }

        console.log("[5] Tracing borders …");
        await FacetBorderTracer.buildFacetBorderPaths(facetResult, null);
        await FacetBorderSegmenter.buildFacetBorderSegments(
            facetResult, settings.nrOfTimesToHalveBorderSegments, null
        );

        console.log("[6] Placing labels …");
        await FacetLabelPlacer.buildFacetLabelBounds(facetResult, null);

        // ── Build facet paths (SVG coordinates, scale = MULT) ────────────────────
        const MULT = 3;
        const SvgW = facetResult.width * MULT;
        const SvgH = facetResult.height * MULT;

        const rawFacets = buildFacetPaths(facetResult, colormap.colorsByIndex, MULT);
        // Re-index facets so IDs are 0, 1, 2, … (some may have been filtered out)
        rawFacets.forEach((f, idx) => { f.id = idx; });

        // ── Region map ───────────────────────────────────────────────────────────
        console.log("[7] Building region map, adjacency, thumbnail …");
        const {
            region_map_b64,
            region_map_width,
            region_map_height,
            region_map_scale,
            facetAreas,
        } = await buildRegionMap(rawFacets, SvgW, SvgH, origW, origH, MULT);

        // Decode our own region map for adjacency (avoid a second canvas pass)
        const rmBytes = Buffer.from(region_map_b64, "base64");
        const rmRaw = zlib.inflateSync(rmBytes);
        const rmArray = new Uint16Array(region_map_width * region_map_height);
        for (let i = 0; i < rmArray.length; i++) {
            rmArray[i] = rmRaw.readUInt16LE(i * 2);
        }

        const adjacency = buildAdjacency(rmArray, region_map_width, region_map_height);
        const thumbnail_b64 = await buildThumbnail(rawFacets, SvgW, SvgH);

        // ── Build palette (string[]) ─────────────────────────────────────────────
        const paletteEntries = buildPaletteInfo(facetResult, colormap.colorsByIndex, settings);
        const palette: string[] = paletteEntries.map(e => e.hex);

        // ── Build regions[] ──────────────────────────────────────────────────────
        // IMPORTANT: region_id = facet.id + 1 (1-indexed; 0 means "no region" in the map)
        const totalMapPixels = region_map_width * region_map_height;
        const regions = rawFacets.map(f => {
            const regionId = f.id + 1;          // 1-indexed to match map storage
            const area = facetAreas.get(f.id) ?? 1;
            const lbl = f.label;
            return {
                region_id: regionId,
                color_number: f.colorIndex + 1,   // 1-indexed display label
                color_idx: f.colorIndex,
                color_hex: f.colorHex,
                path_data: f.d,
                area,
                bbox: lbl
                    ? { x: lbl.x, y: lbl.y, w: lbl.w, h: lbl.h }
                    : { x: 0, y: 0, w: SvgW, h: SvgH },
                label_x: lbl ? lbl.x + lbl.w / 2 : null,
                label_y: lbl ? lbl.y + lbl.h / 2 : null,
                label_font_size: lbl
                    ? Math.max(8, Math.min(24, Math.min(lbl.w, lbl.h) * 0.45))
                    : 12,
                hint_priority: area,   // larger regions shown first in hint
                parent_id: null,
                children: [] as number[],
            };
        });

        // ── palette_stats ────────────────────────────────────────────────────────
        const totalArea = regions.reduce((s, r) => s + r.area, 0) || 1;
        const statsAccum = new Map<number, { area: number; count: number }>();
        for (const r of regions) {
            const cur = statsAccum.get(r.color_idx) ?? { area: 0, count: 0 };
            statsAccum.set(r.color_idx, { area: cur.area + r.area, count: cur.count + 1 });
        }
        const palette_stats = palette.map((hex, i) => {
            const s = statsAccum.get(i) ?? { area: 0, count: 0 };
            return { color_idx: i, hex, area_fraction: s.area / totalArea, region_count: s.count };
        });

        // ── mega_paths_by_color ──────────────────────────────────────────────────
        const megaAccum = new Map<number, string[]>();
        for (const f of rawFacets) {
            if (!megaAccum.has(f.colorIndex)) megaAccum.set(f.colorIndex, []);
            megaAccum.get(f.colorIndex)!.push(f.d);
        }
        const mega_paths_by_color: Record<string, string> = {};
        megaAccum.forEach((paths, ci) => { mega_paths_by_color[String(ci)] = paths.join(" "); });

        // ── Final response ───────────────────────────────────────────────────────
        console.log(`✓  ${regions.length} regions, ${palette.length} colors, ${Date.now() - reqStart}ms`);
        res.json({
            // Coordinate space: SVG (paths are MULT × original pixel coordinates)
            width: SvgW,
            height: SvgH,

            thumbnail_b64,
            mega_paths_by_color,
            regions,
            palette,
            palette_stats,
            adjacency,
            region_map_b64,
            region_map_width,
            region_map_height,
            region_map_scale,

            timing: {
                load: 0,
                quantize: 0,
                segment: 0,
                labels: 0,
                adjacency: 0,
                svg: 0,
                region_map: 0,
                total: Date.now() - reqStart,
            },
            meta: {
                num_colors_requested: settings.kMeansNrOfClusters,
                num_regions: regions.length,
                is_illustration: true,
            },
        });

    } catch (err: any) {
        console.error("[error]", err?.message, err?.stack);
        res.status(500).json({ error: err?.message || "Internal server error" });
    }
}

// Register both route names the frontend may use
app.post("/api/process", generateHandler, handleGenerate as any);
app.post("/generate", generateHandler, handleGenerate as any);

// ─── Region Map Builder ───────────────────────────────────────────────────────
// Rasterises every facet onto a canvas at original-image resolution.
// Each pixel stores the 1-indexed region_id as a 16-bit little-endian value
// (r_byte = high byte, g_byte = low byte).
// Returns: zlib-deflated base64 string + pixel-area counts per facet.
async function buildRegionMap(
    facets: FacetPath[],
    svgW: number,
    svgH: number,
    origW: number,
    origH: number,
    mult: number,
): Promise<{
    region_map_b64: string;
    region_map_width: number;
    region_map_height: number;
    region_map_scale: number;
    facetAreas: Map<number, number>;
}> {
    const mapW = origW;
    const mapH = origH;
    const scaleX = mapW / svgW;   // = 1/MULT
    const scaleY = mapH / svgH;

    const mc = createCanvas(mapW, mapH);
    const mctx = mc.getContext("2d")!;
    mctx.fillStyle = "#000000";
    mctx.fillRect(0, 0, mapW, mapH);

    // Draw each facet with a unique colour encoding its 1-indexed ID
    for (const facet of facets) {
        if (!facet.d) continue;
        const rid = facet.id + 1;            // 1-indexed; 0 = empty
        const rByte = (rid >> 8) & 0xFF;     // high byte → R channel
        const gByte = rid & 0xFF;     // low  byte → G channel
        mctx.save();
        mctx.scale(scaleX, scaleY);
        mctx.fillStyle = `rgb(${rByte},${gByte},0)`;
        const p2d = new Path2D(facet.d);
        mctx.fill(p2d);
        mctx.restore();
    }

    // Read back and encode
    const imgData = mctx.getImageData(0, 0, mapW, mapH);
    const pixels = imgData.data;
    const regionMap = new Uint16Array(mapW * mapH);
    const facetAreas = new Map<number, number>();

    for (let i = 0; i < mapW * mapH; i++) {
        const rB = pixels[i * 4];
        const gB = pixels[i * 4 + 1];
        const rid = (rB << 8) | gB;
        if (rid === 0) continue;
        regionMap[i] = rid;                              // store 1-indexed regionId
        const facetId = rid - 1;
        facetAreas.set(facetId, (facetAreas.get(facetId) ?? 0) + 1);
    }

    // Encode as little-endian bytes → zlib deflate → base64
    const bytes = Buffer.alloc(regionMap.length * 2);
    for (let i = 0; i < regionMap.length; i++) {
        bytes.writeUInt16LE(regionMap[i], i * 2);
    }
    const compressed = zlib.deflateSync(bytes, { level: 6 });
    const region_map_b64 = compressed.toString("base64");

    return {
        region_map_b64,
        region_map_width: mapW,
        region_map_height: mapH,
        region_map_scale: mult,   // svgW / mapW = MULT
        facetAreas,
    };
}

// ─── Adjacency Builder ────────────────────────────────────────────────────────
// Scans the region map horizontally + vertically.
// Whenever two neighbouring pixels belong to different regions, they are
// neighbours.  Returns { "regionId": [neighbourId, …] }.
// NOTE: IDs here are 1-indexed region_ids (matching what's in the map and
// in regions[].region_id).
function buildAdjacency(
    regionMap: Uint16Array,
    mapW: number,
    mapH: number,
): Record<string, number[]> {
    const adj = new Map<number, Set<number>>();

    const register = (a: number, b: number) => {
        if (a === 0 || b === 0 || a === b) return;
        if (!adj.has(a)) adj.set(a, new Set());
        if (!adj.has(b)) adj.set(b, new Set());
        adj.get(a)!.add(b);
        adj.get(b)!.add(a);
    };

    // Horizontal neighbours
    for (let y = 0; y < mapH; y++) {
        for (let x = 0; x < mapW - 1; x++) {
            register(regionMap[y * mapW + x], regionMap[y * mapW + x + 1]);
        }
    }
    // Vertical neighbours
    for (let y = 0; y < mapH - 1; y++) {
        for (let x = 0; x < mapW; x++) {
            register(regionMap[y * mapW + x], regionMap[(y + 1) * mapW + x]);
        }
    }

    const result: Record<string, number[]> = {};
    adj.forEach((neighbours, id) => {
        result[String(id)] = Array.from(neighbours);
    });
    return result;
}

// ─── Thumbnail Builder ────────────────────────────────────────────────────────
// Renders a coloured preview at ≤200px wide.  Returns a base64 JPEG string.
async function buildThumbnail(
    facets: FacetPath[],
    svgW: number,
    svgH: number,
    thumbW: number = 200,
): Promise<string> {
    const scale = thumbW / svgW;
    const thumbH = Math.round(svgH * scale);

    const tc = createCanvas(thumbW, thumbH);
    const tctx = tc.getContext("2d")!;
    tctx.fillStyle = "#FFFFFF";
    tctx.fillRect(0, 0, thumbW, thumbH);

    tctx.save();
    tctx.scale(scale, scale);
    for (const f of facets) {
        if (!f.d) continue;
        const p2d = new Path2D(f.d);
        tctx.fillStyle = f.colorHex;
        tctx.fill(p2d);
        tctx.strokeStyle = "rgba(0,0,0,0.25)";
        tctx.lineWidth = 0.6;
        tctx.stroke(p2d);
    }
    tctx.restore();

    const buf = await tc.encode("jpeg", 80);
    return buf.toString("base64");
}

// ─── Facet path builder ───────────────────────────────────────────────────────
function buildFacetPaths(
    facetResult: FacetResult,
    colorsByIndex: RGB[],
    mult: number,
): FacetPath[] {
    const out: FacetPath[] = [];
    for (const f of facetResult.facets) {
        if (!f || f.borderSegments.length === 0) continue;

        let pts = f.getFullPathFromBorderSegments(false);
        if (pts[0].x !== pts[pts.length - 1].x || pts[0].y !== pts[pts.length - 1].y) {
            pts.push(pts[0]);
        }

        let d = `M ${pts[0].x * mult} ${pts[0].y * mult} `;
        for (let i = 1; i < pts.length; i++) {
            const mx = (pts[i].x + pts[i - 1].x) / 2;
            const my = (pts[i].y + pts[i - 1].y) / 2;
            d += `Q ${mx * mult} ${my * mult} ${pts[i].x * mult} ${pts[i].y * mult} `;
        }

        const [r, g, b] = colorsByIndex[f.color];
        const hex = "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");

        out.push({
            id: f.id,
            colorIndex: f.color,
            colorHex: hex,
            d,
            label: f.labelBounds ? {
                x: f.labelBounds.minX * mult,
                y: f.labelBounds.minY * mult,
                w: f.labelBounds.width * mult,
                h: f.labelBounds.height * mult,
                number: f.color,
            } : null,
        });
    }
    return out;
}

// ─── Palette info builder ─────────────────────────────────────────────────────
function buildPaletteInfo(
    facetResult: FacetResult,
    colorsByIndex: RGB[],
    settings: Settings,
) {
    const freq = colorsByIndex.map(() => 0);
    for (const f of facetResult.facets) { if (f) freq[f.color] += f.pointCount; }
    const total = freq.reduce((s, v) => s + v, 0) || 1;

    const aliasesByColor: Record<string, string> = {};
    for (const k of Object.keys(settings.colorAliases)) {
        aliasesByColor[settings.colorAliases[k].join(",")] = k;
    }

    return colorsByIndex.map((color, idx) => ({
        index: idx,
        color,
        hex: "#" + color.map(c => c.toString(16).padStart(2, "0")).join(""),
        colorAlias: aliasesByColor[color.join(",")] || null,
        frequency: freq[idx],
        areaPercentage: parseFloat((freq[idx] / total).toFixed(4)),
    }));
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0"; // Explicitly bind to all interfaces for production (Railway)

app.listen(PORT as number, HOST, () => {
    console.log(`PBN ColorArt backend  →  http://${HOST}:${PORT}`);
    console.log(`Routes: POST /api/process   POST /generate`);
    console.log(`Health: GET  /api/health    GET  /health`);
});

// Top-level unhandled exception/rejection handlers for production stability
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    process.exit(1);
});
