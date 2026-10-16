# Fictional cinema artwork provenance

`cinema-atlas.png` was generated with Codex's built-in `image_gen` tool on 2026-10-16 for the isolated Shinema design comparison. It is an original synthetic fixture, not a still from a real film, a private library, or a downloaded artwork service. No external image sources, credentials, reference images, real performer identities, film titles, logos, or artwork licenses were used.

The image is a readable PNG, **2048 × 768 px**, 2,959,296 bytes. It contains three columns × two rows, with no gutters. This **8:3 overall ratio** preserves six equal **16:9 panels**. Individual column boundaries fall at one-third and two-thirds of the width. CSS cropping can therefore use a 300% × 200% background with column positions 0%, 50%, 100% and row positions 0%, 100%.

| Index | Grid cell     | Fictional scene                                      |
| ----- | ------------- | ---------------------------------------------------- |
| 0     | Top left      | Red-jacket explorer, teal alpine lake and snow peaks |
| 1     | Top center    | Detective silhouette in a rain-soaked Tokyo alley    |
| 2     | Top right     | Sunlit Italian coastline                             |
| 3     | Bottom left   | Astronaut on an orange desert planet                 |
| 4     | Bottom center | Black-and-white jazz trumpeter                       |
| 5     | Bottom right  | Cabin in a misty green forest                        |

Generation used the built-in tool rather than the API/CLI fallback. The tool returned an image data URL; the PNG bytes were decoded without visual modification into this workspace. Visual inspection confirmed the six requested scenes, equal touching panels and no overlaid text or logos. The artwork is a concept fixture; it does not represent the user's media collection. Any movie names applied by the prototype are fictional UI copy and are not baked into this atlas.

## Final generation prompt

```text
Use case: photorealistic-natural.
Asset type: original fictional film artwork atlas for a premium media library UI prototype.
Generate exactly one high resolution WIDE ATLAS image, 3840×1440 pixels if possible, 8:3 overall aspect ratio. Precisely divide it into THREE COLUMNS and TWO ROWS of six equal 16:9 landscape panels. Panels touch edge-to-edge with no gutters, no border, no frames. The six images must be separate scenes occupying the exact equal rectangular grid cells, with crisp straight boundaries.
Top left (panel 0): one lone explorer in a red jacket beside a vast calm teal alpine lake at dawn, monumental snow peaks, striking scale, elegant cinematic wide composition.
Top middle (panel 1): moody rain-soaked Tokyo alley at night, a lone detective silhouette in a dark coat, luminous distant neon color reflections with NO legible writing anywhere.
Top right (panel 2): sunlit Italian coast, cinematic vintage summer travel feeling, cliffside pastel architecture and clear blue sea, warm natural film color.
Bottom left (panel 3): one lone astronaut on a vast orange desert planet, atmospheric dust, sculpted dunes and distant mountains, cinematic science fiction photography, original fictional spacesuit.
Bottom middle (panel 4): a black-and-white cinematic photograph of a jazz trumpeter playing on a smoky intimate concert stage, dramatic side lighting, rich silver-gelatin tones.
Bottom right (panel 5): a secluded simple wooden cabin deep within a misty lush green forest, atmospheric layered trees, contemplative cinematic photography.
Consistent premium film-still photography quality across all panels: beautiful natural texture, subtle film grain, rich dynamic range, restrained art direction. These are fictional and original scenes. Each panel should remain legible when cropped into landscape hero art or a tall poster; keep a clear single focal point near the center and useful negative space.
No text, no title, no lettering, no watermarks, no logos, no UI, no frames or gutters, no collage overlap, no famous people, no recognizable film stills. Preserve exact 3-column by 2-row equal-cell grid.
```
