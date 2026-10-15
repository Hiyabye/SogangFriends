# Meal OCR pipeline

Commands below run from the repository root. Development/safety rules are in [AGENTS.md](../../AGENTS.md); operating evidence is in [VERIFICATION.md](../../docs/VERIFICATION.md).

## Active pipeline and responsibilities

GitHub Actions runs **CPU PaddleOCR first, EasyOCR fallback**; the Worker validates signed results into the existing D1 weekly cache. No meal OpenRouter path remains. `pipeline.py` detects table ruling lines and requires independently observed banner dates and all seven column month/day/weekday headers. Menu spelling is not a fallback trigger. Missing/merged boundaries suppress affected offerings rather than inventing menus or moving text across dates.

The output is a seven-day `MealWeek`, observed identity, engine, image hash and `ocr-v1`. Local output is **candidate data**, not an automatic upload; the Worker independently checks dates, identity and meal semantics. Only current+next KST Monday–Sunday weeks are retained. Dependency/model caches accelerate execution but are not serving truth.

`.github/workflows/meal-ocr.yml` refreshes at **06:40 / 17:10 KST** (21:40/08:10 UTC) with ingestion enabled. Manual dispatch defaults to `ingest=false`. Worker meal reports are independently planned at07:00/17:30 KST; GitHub delays mean the20-minute buffer is not a guarantee.

The workflow uses Ubuntu24.04/Python3.11 and `requirements-actions.lock`. Native verification exercises **both** engines and checks four reviewed weight digests in `evaluation-summary.json`. Manual verification also requires at least one real processed source; empty/cache-only work does not prove OCR runtime. Scheduled ingestion may legitimately reuse an exact cache match. Artifacts retain bounded results/diagnostics for three days, not source images or third-party engine logs. Changed weight digests require review.

## Tests without live collection or ingestion

```sh
npm run test:ocr  # standalone Node ingestion-client tests; also included in npm run check
python3 -m unittest discover -s scripts/meal-ocr -p 'test_*.py' -q

# Full geometry/crop tests, using an already installed approved environment:
scripts/meal-ocr/.venv/bin/python -m unittest discover -s scripts/meal-ocr -p 'test_*.py' -q
```

Ordinary CI runs the Node client and Python3.11 stdlib tests. Python image/geometry tests explicitly skip when Pillow/OpenCV are unavailable; a passing lightweight run is not full geometry coverage. The pinned OCR workflow retains the full test step. Synthetic tests use injected engines and do not prove real Korean recognition, native package compatibility or future image layouts.

## Local real-source processing

Preparing sources makes **real read-only HTTPS requests** and downloads official source images. Processing uses the already approved OCR environment; native initialization may download official weights and requires download approval. These commands do **not** upload results or post to Discord:

```sh
NODE_EXTRA_CA_CERTS=certificates/sogang-ov-r36.pem \
  node scripts/meal-ocr/collect.mjs prepare --output scripts/meal-ocr/output/new-run
scripts/meal-ocr/.venv/bin/python scripts/meal-ocr/run-batch.py \
  --output scripts/meal-ocr/output/new-run --require-processed
```

Remote meal images may use the official host's `/dataview/board/1185/` or `/dataview/temp/` directory (one filename, PNG/JPEG only). Both require HTTPS, no query/fragment/credentials, verified TLS and no redirects. The temporary upload path is used by official article941903; this support needs a Worker deployment as well as updated Actions code.

Input is one PNG/JPEG frame, at most5 MiB and20 million pixels. Image bytes/crops are local ignored artifacts, not D1 source identity. Preserve canonical official article identity, including when the article contains an inline PNG. Do not substitute stale weeks or repair contradictory observed dates from article metadata.

### Live cache/ingestion boundary

`prepare --cache` and `ingest` contact the Worker and **mutate D1**. Prior activation is not blanket approval for another manual run. They require `MEAL_OCR_INGEST_URL` ending in `/internal/meal-ocr` and the same dedicated `MEAL_OCR_INGEST_SECRET` (at least32 characters) in Actions/Worker. Neither creates Discord delivery jobs.

Lookup captures source metadata and refreshes only an exact cache identity. Store conditionally matches current source metadata in a D1 transaction. Before the first store request, `ingest()` validates the **entire bounded local batch**: source/image hashes, result files, observed identity, meal semantics and signed-request limits. It then sends sequential, idempotent week writes. This is **not a multi-week remote transaction**: a later network or Worker rejection can leave an earlier valid week stored. Reuse the same reviewed identities rather than resetting state after partial progress.

## Environment and retained evidence

The Actions Linux CPU lockfile and macOS arm64 `requirements.lock` serve different environments; do not interchange them. Python3.9.6 is the checked local compatibility baseline, not a recommendation for a new production runtime. Installation and first-use model downloads require approval:

```sh
python3 -m venv scripts/meal-ocr/.venv
scripts/meal-ocr/.venv/bin/python -m pip install --require-hashes \
  -r scripts/meal-ocr/requirements.lock
```

Official weights may be cached under `~/.paddlex` / `~/.EasyOCR`; the venv, source images and output are Git-ignored. Keep these reviewed artifacts:

| Artifact | Purpose |
|---|---|
| `evaluation-summary.json` | Native runtime's approved model-weight digests and original comparison evidence |
| `actions-verification.json` | Reviewed Linux/Actions provenance and observed dates, consumed by Worker regression tests |
| `cross-week-evaluation.json` | Seven-week evaluation: six accepted, one stale-banner rejection, including month transitions |
| `layout-941660.json`, `truth-2026-10-13.json`, `truth-2026-10-17.json` | Original week-specific reviewed geometry/transcriptions, not future-week templates |
| [EVALUATION.md](EVALUATION.md) | Source hashes, measurements and comparison rationale |

Activation and actual Linux/live-ingestion runs are recorded once in [VERIFICATION.md](../../docs/VERIFICATION.md). Retired inference trial details are historical evidence, not instructions to recreate those paths. Meal display-hash migration0011 was applied to production with explicit approval on2026-10-14. It concerns report deduplication only and does not alter OCR ingestion.

The2026-10-14 verification-only Actions run passed both native engines/weight hashes and all39 Python tests. Current-week OCR passed via EasyOCR fallback, but another retained source failed the existing pre-OCR `unsupported_column_structure` guard, so the two-source batch correctly failed. No ingestion occurred. The geometry/run-batch algorithm was unchanged by the maintenance review. Follow-up inspection identified the rejected image as the next-week1046×770 inline PNG: the first day boundary is x=100 (9.56% of width), below the former10% position guard, while all seven column widths and cross-row boundaries pass. The supported left-position range now starts at8%, with synthetic tests using the measured coordinates and malformed-offset/width counterexamples. Seven-column, merged-cell and independently observed date/weekday validation remain mandatory; this does not bypass a failed source batch. On2026-10-15 the fixed verification-only Actions run accepted both weeks (next week via PaddleOCR, current week via EasyOCR). The subsequent live run accepted the next-week result and reused the exact current-week cache; D1 readback confirmed both retained weeks. See the linked verification record for run IDs.

## Diagnostic CLI and shared helpers

`evaluate.py` is both a local crop/transcription diagnostic CLI **and a shared helper module imported by `pipeline.py`**. Do not remove it as unused legacy. Its CLI does not call model services, Discord, D1 or ingestion; it emits no serving meal-availability JSON and never retries historical jobs. OCR engines are imported only when selected.

```sh
python scripts/meal-ocr/evaluate.py \
  --image /path/to/official-menu.jpg \
  --layout scripts/meal-ocr/layout-941660.json \
  --date 2026-10-13 --engine none \
  --output /tmp/meal-crop-tuesday
```

Use a fresh output directory. `--engine none` crops without loading OCR engines; approved runs may use `paddle`, `easy` or `both`. Add `--truth /path/to/reviewed-truth.json` for transcription metrics. Engine initialization/download time is separate from crop inference; no latency/memory budget is promised.

### Reviewed layout contract

The diagnostic layout is **operator-reviewed geometry**, not detected boundaries or OCR-confirmed dates. See `layout-941660.json` for the real example tied to official post941660/week2026-10-12–18. Do not reuse it merely because a future image's aspect ratio matches.

- Canonical `start`/`end` cover one Monday–Sunday week; the requested date must belong to it.
- Coordinates are normalized from top-left. Rectangles are `[left,top,right,bottom]`; region spans are `[top,bottom]`.
- `aspect_ratio` and relative `aspect_tolerance` (0–0.05) reject different shapes; eight `day_boundaries` delimit seven columns, excluding labels.
- `banner` selects observed year/date text, not authors, contacts or decoration. `labels` stays left of day columns within the table's vertical bounds.
- Ordered, nonoverlapping `regions`: `day_header`, `breakfast_korean`, `breakfast_western`, `breakfast_common`, `cup_rice`, `dinner`, `drinks`. Calorie gaps may be excluded.
- `breakfast_common`/`drinks` use the full seven-column span; other crops use the selected day. `selected_day.png` is visual-review only, not submitted to engines.
- Diagnostic identity stays `unverified`: profile/request dates are not proof of observed dates.

### Engines, output and optional truth

Paddle uses `PP-OCRv5_server_det` + `korean_PP-OCRv5_mobile_rec` on CPU with orientation/unwarping disabled. EasyOCR uses Korean/English with `gpu=False`. Diagnostic `result.json` records package versions, initialization/crop duration, detections (`box`,`text`,`confidence`), reading-order lines and source/layout hashes. Boxes are crop-local pixels. Diagnostic text is not corrected, marked available/closed or reassigned to dates.

Ground truth is an object mapping crop names to arrays of reviewed lines. `[]` means a genuinely blank crop; omitted keys are unscored. `selected_day` truth is reported as unevaluated. Metrics normalize Korean NFC, remove whitespace and compute character edit distance/CER; blank truth has no CER denominator. CER/confidence is **not factual menu accuracy**. Compare wrong-day assignment, blank cells and observed dates with the original image. Preserve source spelling in historical transcriptions rather than silently correcting it.
