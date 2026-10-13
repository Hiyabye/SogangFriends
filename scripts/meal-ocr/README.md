# Meal OCR pipeline and manual evaluation

## Replacement pipeline (staged, not deployed)

`pipeline.py` detects the supported table family's ruling lines, crops individual
days, and requires independently observed banner dates and all seven column
month/day/weekday headers. PaddleOCR runs first; EasyOCR runs once if the engine
or date checks fail. Menu spelling is not a fallback trigger. Missing/merged day
boundaries suppress affected offerings rather than moving text between dates.

`cross-week-evaluation.json` records seven actual source-image tests: six accepted
(including two month transitions), one rejected for a stale banner. October 12–18
used EasyOCR after PaddleOCR missed a complete weekday. Review crops under
`output/pipeline-final-<week-start>/`, including `selected_day_<0..6>.png`.

The local pipeline emits the existing seven-day `MealWeek` plus observed identity,
engine, hash and `ocr-v1`. This is serving-compatible **candidate data**, not an
automatic upload. The Worker independently checks observations on ingestion.

```sh
# Downloads verified official sources; does not contact ingestion or Discord.
NODE_EXTRA_CA_CERTS=certificates/sogang-ov-r36.pem \
  node scripts/meal-ocr/collect.mjs prepare --output scripts/meal-ocr/output/new-run
scripts/meal-ocr/.venv/bin/python scripts/meal-ocr/run-batch.py \
  --output scripts/meal-ocr/output/new-run --require-processed

# Synthetic tests and the standalone Node client tests:
scripts/meal-ocr/.venv/bin/python -m unittest discover -s scripts/meal-ocr -p 'test_*.py' -q
node --test scripts/meal-ocr/collect.node-tests.mjs
```

The optional `prepare --cache` and `ingest` commands contact the scoped Worker
endpoint and mutate D1; do not run them before operational approval. They require
`MEAL_OCR_INGEST_URL` ending in `/internal/meal-ocr` and a dedicated
`MEAL_OCR_INGEST_SECRET` (at least 32 characters) in both Actions and Worker.
The authenticated lookup captures source metadata and refreshes only an exact
cache identity. Store is idempotent and conditionally matches current source
metadata inside a D1 transaction. Neither creates Discord delivery jobs.

`.github/workflows/meal-ocr.yml` is manual-only, with `ingest=false` by default.
It uses Ubuntu 24.04/Python 3.11 and the separate CPU-targeted
`requirements-actions.lock`. Pip/model caches are expendable accelerators;
existing D1 is the authoritative current+next KST-week result cache. Native runtime
verification initializes and exercises **both** engines and checks the four
snapshotted weight-file digests in `evaluation-summary.json`. Date/crop processing
must also accept at least one real source; an empty batch cannot verify runtime.
Artifacts contain only results/diagnostics for three days, no source images or
third-party engine logs. A changed weight digest requires review, not silent use.

**Actions/Linux execution is not yet proven.** Local native execution and
hash verification passed, but Docker's local daemon is unavailable. Existing
OpenRouter code remains intact until the replacement verification gate is met.
No live workflow, remote ingestion, deployment, commit or push has occurred.

## Original diagnostic tool

`evaluate.py` is an isolated local diagnostic tool, not the Worker meal extractor. It does
not call OpenRouter, Discord, D1, or any serving-cache endpoint. It produces no
meal availability JSON and never retries historical jobs.

Python 3.9 and Pillow are required for cropping. OCR engines are imported only
when selected. Use the separately approved/pinned environment prepared by the
operator; the tool itself does not install packages. PaddleOCR/EasyOCR may
**download their official model weights at initialization**. This is not an
image upload, but requires download approval and network access on first use.

## Reproducible environment

The checked baseline uses Python 3.9.6 on macOS arm64. Python 3.9 is an evaluation
compatibility baseline, not a recommendation for a new production runtime.
`requirements.lock` pins all resolved packages and hashes; other Python/platform
combinations need their own compatibility check. No npm/Worker dependencies change.

```sh
python3 -m venv scripts/meal-ocr/.venv
scripts/meal-ocr/.venv/bin/python -m pip install --require-hashes \
  -r scripts/meal-ocr/requirements.lock
```

The virtual environment, downloaded source images, and diagnostic output are ignored
by Git. The Actions lock resolves Linux CPU Torch/Torchvision from the official
PyTorch CPU index; the macOS lock is separate and must not substitute for it. Official weights may also be cached under `~/.paddlex` and `~/.EasyOCR`.

## Usage

```sh
python scripts/meal-ocr/evaluate.py \
  --image /path/to/official-menu.jpg \
  --layout /path/to/reviewed-layout.json \
  --date 2026-10-13 \
  --engine none \
  --output /tmp/meal-crop-tuesday

# In the approved OCR environment, use --engine paddle, easy, or both.
# Add --truth /path/to/tuesday-truth.json for transcription metrics.
python -m unittest discover -s scripts/meal-ocr -p 'test_*.py' -v
```

Output must be a fresh directory. The original image is not copied; only selected
crops and `result.json` are written. Input is limited to one PNG/JPEG frame, 5 MiB,
and 20 million pixels. The selected-day crop is a visual-review artifact, not
submitted to engines; engines process the smaller named crops individually.
Engine initialization time (including possible downloads) is separate from
per-crop inference time. No latency or memory budget is promised.

## Layout JSON contract

All geometry is **operator-reviewed input**, not automatically detected table
boundaries or proof of dates observed in the image. A layout is specific to its
reviewed week and geometry. Do not reuse it on future images merely because their
aspect ratios match: shifted/changed tables can pass that check.

```json
{
  "start": "2026-10-12",
  "end": "2026-10-18",
  "aspect_ratio": 2.0,
  "aspect_tolerance": 0.01,
  "day_boundaries": [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  "banner": [0.3, 0.02, 0.8, 0.09],
  "labels": [0.05, 0.1, 0.19, 0.9],
  "regions": {
    "day_header": [0.1, 0.2],
    "breakfast_korean": [0.2, 0.35],
    "breakfast_western": [0.36, 0.5],
    "breakfast_common": [0.51, 0.55],
    "cup_rice": [0.56, 0.6],
    "dinner": [0.61, 0.85],
    "drinks": [0.86, 0.9]
  }
}
```

This example is **synthetic**, not the real menu profile.

- Normalized coordinates are measured from top-left: X/image width, Y/image height.
- `aspect_ratio` is width/height; tolerance is relative, 0–0.05.
- Eight X boundaries delimit seven Monday–Sunday columns, **excluding** left labels.
- Rectangles are `[left, top, right, bottom]`.
- Region spans are `[top, bottom]`, in the exact order shown. Calorie-row gaps may
  be excluded. Ranges must be ordered and non-overlapping.
- `banner` should contain only the observed year/date-range text. Exclude source
  authors/contact information, decorative logos, and footer. `labels` must be to
  the left of the day columns and within the reviewed table's vertical bounds.
- Day-specific regions use only the selected column. `breakfast_common` and
  `drinks` use the **full seven-column span**, preserving merged shared rows.
- `selected_day.png` spans the selected column from the header to the drinks row.
  `banner.png`, `labels.png`, and each named region are also saved separately.

Dates must be canonical YYYY-MM-DD; the profile must cover one Monday–Sunday
week and the requested date must be in that week. The output explicitly marks
identity as `unverified`: the requested/profile dates are not OCR-confirmed.

## OCR and result format

Paddle uses `PaddleOCR(text_detection_model_name="PP-OCRv5_server_det",
text_recognition_model_name="korean_PP-OCRv5_mobile_rec", device="cpu")`, with
orientation/unwarping disabled. EasyOCR uses `Reader(["ko", "en"], gpu=False)`.

For each engine, `result.json` contains package versions, CPU device,
initialization duration, and per-crop detections (`box`, `text`, `confidence`),
ordered `lines`, and inference duration. Bounding boxes are **crop-local** pixel
coordinates. Crop rectangles and source/layout SHA-256 hashes preserve provenance.
No text is corrected, interpreted as available/closed, or reassigned to dates.

## Optional human ground truth

Use an object keyed by crop name, with arrays of lines in top-to-bottom,
left-to-right order:

```json
{
  "day_header": ["10월 13일", "화요일"],
  "cup_rice": ["11:40", "참치콘샐러드덮밥"],
  "dinner": ["manually transcribed line 1", "manually transcribed line 2"],
  "drinks": ["manually transcribed shared row"]
}
```

`[]` represents a genuinely blank reviewed crop. Omitted keys are **not scored**.
Only named OCR crops are scored; `selected_day` is visual-only and is reported in
`unevaluated_truth_crops` if supplied. The sample above is illustrative, not a
complete menu truth set.

Metrics concatenate lines, normalize Korean to NFC, remove whitespace, and
compute character-level Levenshtein edits and character error rate. Blank truth
has no CER denominator (`null`); unexpected detected text is flagged separately.
CER is not menu accuracy: it can be affected by line ordering, joined detection
boxes, symbols, and omissions. Confidence is not a factual correctness guarantee.
Review wrong-day assignment, blank-cell handling, dates, and actual text against
the original image before deciding on a production pipeline.

## Reviewed source evaluation

`layout-941660.json` and `truth-2026-10-13.json` / `truth-2026-10-17.json`
are specific to official post 941660, week 2026-10-12–18. The checked source hash,
measured results, model hashes, and comparison rationale are in
[EVALUATION.md](EVALUATION.md) and `evaluation-summary.json`. Source spelling is
preserved, including the printed Saturday words `베이리` and `슬리이스치즈`.
These are not corrected menu outputs or a reusable future-week layout detector.

Place the official source image locally, then run, for example:

```sh
scripts/meal-ocr/.venv/bin/python scripts/meal-ocr/evaluate.py \
  --image /path/to/20261008_0923_5910001.jpg \
  --layout scripts/meal-ocr/layout-941660.json \
  --date 2026-10-13 --engine both \
  --truth scripts/meal-ocr/truth-2026-10-13.json \
  --output scripts/meal-ocr/output/new-tuesday-trial
```

## Validation limits

Synthetic tests validate crop geometry, aspect/date rejection, shared-row
preservation, normalization/metrics, and Paddle result conversion. Pillow-dependent
integration tests skip explicitly if Pillow is absent. These tests do not measure
real Korean recognition, model downloads, package compatibility, GPU behavior,
or future-week layout robustness. Real engine evaluation is a separate approved
operator action.
