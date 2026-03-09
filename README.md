# PBN Layered Backend v2.0

Paint-by-Numbers generator with **multi-layer shader/shadow support** built for ColorArt, ColorAnime, and similar Android apps targeting girls, kids, and anime lovers.

---

## What's new in v2.0

The v1 backend produced a single flat paint-by-number. v2.0 adds a **layer pipeline** that analyzes the image and emits separate, stackable SVG layers:

| Layer | Blend Mode | Description |
|-------|-----------|-------------|
| `base` | NORMAL | Classic paint-by-number flat colors |
| `shadow` | MULTIPLY | Per-cluster darker regions — cel-shading effect |
| `highlight` | SCREEN | Bright/specular regions — sparkle, sheen, gloss |
| `depth` | OVERLAY | Absolute luminance cel-shading bands (opt-in) |
| `lineart` | MULTIPLY | Crisp anime-style outlines, always on top |

---

## Quick start

```bash
npm install
npm run dev
```

```bash
curl -X POST http://localhost:3000/generate \
  -F "image=@anime.jpg" \
  -F 'settings={"kMeansNrOfClusters":16,"enableShadowLayer":true,"enableHighlightLayer":true}'
```

---

## API Reference

### `POST /generate`

| Field | Type | Description |
|-------|------|-------------|
| `image` | File | JPEG/PNG/WebP, max 20 MB |
| `settings` | JSON string | Optional settings (see below) |

**Settings**

```jsonc
{
  // Base pipeline
  "kMeansNrOfClusters": 16,
  "kMeansClusteringColorSpace": 2,   // 0=RGB 1=HSL 2=LAB (LAB best for anime)
  "narrowPixelStripCleanupRuns": 3,
  "removeFacetsSmallerThanNrOfPoints": 20,
  "resizeImageIfTooLarge": true,
  "resizeImageWidth": 1024,
  "resizeImageHeight": 1024,

  // Layer toggles
  "enableShadowLayer":    true,      // default: ON
  "enableHighlightLayer": true,      // default: ON
  "enableDepthLayer":     false,     // default: OFF (opt-in)
  "enableSobelDetail":    false,     // default: OFF (opt-in)

  // Shadow tuning
  "shadowThreshold":   14,           // delta-LAB-L to qualify as shadow (8–25)
  "shadowMinPixels":   80,

  // Highlight tuning
  "highlightThreshold": 20,
  "highlightMinPixels": 60,

  // Depth/cel shading
  "depthBands": 4,                   // luminance bands (2–6)

  // Lineart
  "lineartStrokeColor": "#1a1a1a",
  "lineartStrokeWidth": 2.2,

  // Sobel fine detail
  "sobelThreshold": 60,
  "sobelOpacity":   0.35
}
```

**Response**

```jsonc
{
  "width": 512, "height": 512, "svgWidth": 1536, "svgHeight": 1536,

  "layers": [
    {
      "id": "base",
      "label": "Base Colors",
      "description": "...",
      "blendMode": "NORMAL",      // Android PorterDuff key
      "opacity": 1.0,
      "zIndex": 0,
      "paintable": true,          // user paints this layer
      "colorCount": 16,
      "palette": [
        { "index": 0, "color": [255,182,193], "hex": "#ffb6c1",
          "frequency": 4200, "areaPercentage": 0.0163 }
      ],
      "facets": [
        { "id": 0, "colorIndex": 3, "colorHex": "#ffb6c1",
          "d": "M 12 9 Q ...",
          "label": { "x": 45, "y": 60, "w": 30, "h": 20, "number": 3 } }
      ],
      "svg": {
        "outline":  "<svg>...</svg>",
        "colored":  "<svg>...</svg>",
        "numbered": "<svg>...</svg>",
        "animated": "<svg>...</svg>"
      }
    },
    { "id": "shadow",    ... },
    { "id": "highlight", ... },
    { "id": "lineart",   ... }
  ],

  "layerMeta": [...],           // lightweight metadata without svg/facets

  "composite": {
    "svg": "<svg>...</svg>"     // all layers composited for web preview
  },

  // v1 backward-compat
  "colorCount": 16, "palette": [...], "facets": [...], "svg": { ... }
}
```

### `POST /generate/layer?layer=shadow|highlight|depth`

Fetch a single layer on demand — for progressive loading in Android.

---

## Android Integration

### PorterDuff blend mode mapping

```kotlin
fun String.toPorterDuffMode(): PorterDuff.Mode = when (this) {
    "MULTIPLY" -> PorterDuff.Mode.MULTIPLY
    "SCREEN"   -> PorterDuff.Mode.SCREEN
    "OVERLAY"  -> PorterDuff.Mode.OVERLAY
    "ADD"      -> PorterDuff.Mode.ADD
    else       -> PorterDuff.Mode.SRC_OVER
}
```

### Rendering the layer stack

```kotlin
override fun onDraw(canvas: Canvas) {
    // Layers are sorted by zIndex (0=base → 10=lineart)
    for (layer in layers.sortedBy { it.zIndex }) {
        val paint = Paint().apply {
            alpha = (layer.opacity * 255).toInt()
            xfermode = PorterDuffXfermode(layer.blendMode.toPorterDuffMode())
        }
        // Draw the user-painted bitmap for this layer
        paintBitmaps[layer.id]?.let { canvas.drawBitmap(it, 0f, 0f, paint) }
        // Draw SVG overlay (numbers/outlines) always NORMAL on top
        overlayBitmaps[layer.id]?.let { canvas.drawBitmap(it, 0f, 0f, Paint()) }
    }
}
```

### Fill a facet on a layer

```kotlin
fun fillFacet(facetId: Int, color: Int, activeLayerId: String) {
    val bmp    = paintBitmaps[activeLayerId] ?: return
    val canvas = Canvas(bmp)
    val layer  = layers.find { it.id == activeLayerId } ?: return
    val facet  = layer.facets.find { it.id == facetId } ?: return
    val path   = parseSvgPath(facet.d)   // convert SVG "M...Q..." to Path
    canvas.drawPath(path, Paint().apply {
        this.color = color
        style = Paint.Style.FILL
        isAntiAlias = true
    })
    invalidate()
}
```

### Progressive loading

```kotlin
// Load base first (fast), then shadow + highlight in background
val base = api.generate(imageFile, settings)
showLayers(base.layers)

lifecycleScope.launch {
    val shadow    = async { api.generateLayer(imageFile, "shadow") }
    val highlight = async { api.generateLayer(imageFile, "highlight") }
    addLayer(shadow.await())
    addLayer(highlight.await())
}
```

### UX flow for anime/girls apps

```
┌──────────────┐    ┌─────────────┐    ┌──────────────────┐
│  Step 1      │    │  Step 2     │    │  Step 3          │
│  Paint base  │ →  │  Paint      │ →  │  Add highlight   │
│  colors (PBN)│    │  shadows    │    │  sparkle (opt.)  │
│  numbered    │    │  numbered   │    │  auto or manual  │
└──────────────┘    └─────────────┘    └──────────────────┘
     NORMAL              MULTIPLY            SCREEN
   zIndex: 0            zIndex: 1           zIndex: 2
                                            
                 LINEART always on top (zIndex: 10, not paintable)
```

---

## Algorithm

### Shadow extraction
1. Compute CIELAB lightness `L` for each pixel and its k-means cluster color
2. `ΔL = L_pixel − L_cluster`
3. If `ΔL < −threshold` → shadow pixel, grouped by source cluster
4. Mean RGB per cluster = shadow color (1 shadow color per base cluster)
5. Full facet pipeline on shadow-only pixel map

### Highlight extraction
Same, but `ΔL > +threshold`. Highlight colors boosted 50% toward white.

### Depth / Cel shading
Absolute luminance `Y = 0.299R + 0.587G + 0.114B` quantized into N bands.
Cool-to-warm color ramp — classic anime cel-shade look.

### Lineart
Reuses base facet border paths. No extra computation — zero cost.

### Sobel detail (opt-in)
3×3 Sobel on greyscale, thresholded, run-length-encoded to SVG `<rect>` elements.

---

## Recommended settings

| App type | clusters | shadowThreshold | depthBands |
|----------|----------|----------------|------------|
| Kids coloring | 8–12 | 18 | — |
| Anime / ColorAnime | 14–20 | 12 | 4 |
| Girls portrait | 14–18 | 14 | — |
| Landscape | 12–16 | 16 | 4 |

---

## File structure

```
pbn-backend/
├── server.ts                ← Main entry (v2.0)
├── src/
│   ├── layerExtractor.ts    ← NEW: shadow/highlight/depth/lineart
│   ├── colorreductionmanagement.ts
│   ├── facetCreator.ts
│   ├── facetReducer.ts
│   ├── facetBorderTracer.ts
│   ├── facetBorderSegmenter.ts
│   ├── facetLabelPlacer.ts
│   ├── facetmanagement.ts
│   ├── settings.ts
│   └── lib/colorconversion.ts
└── package.json
```
