# Day-cropped Korean OCR evaluation

## Result and recommendation

**Use PaddleOCR as the candidate for the next integration design, not as an
already-approved production replacement.** On two manually cropped days of one
menu image, its Korean recognizer transcribed all scored menu characters correctly.
EasyOCR was faster but made more transcription errors. Both preserved the tested
blank cells. No OpenRouter inference, Discord post, D1 mutation, or production
cutover occurred.

These results do not establish future-week reliability, automatic table detection,
or correctness of a daily serving parser. Cropping alone also does not fix the
current OpenRouter HTTP429 failures.

## Source and crop contract

- [Official post 941660](https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941660): 2026-10-12–18.
- [Official source JPEG](https://scc.sogang.ac.kr/dataview/board/1185/20261008_0923_5910001.jpg): 3508×2480 pixels, 724388 bytes.
- Source SHA-256: `f8f5a60905a10f308495422d6ed5b7629f53f6e1a30594f46d386a05a36b0ff4`.
- Reviewed days: Tuesday 2026-10-13 (cup rice present) and Saturday 2026-10-17 (cup rice and dinner blank).

`layout-941660.json` has manually reviewed normalized column and row boundaries.
Only the target day's header, Korean breakfast, Western breakfast, cup rice, and
dinner are recognized. The banner, section labels, shared breakfast-common row,
and shared drinks row are recognized separately. Calorie rows and the footer are
excluded from the OCR section crops. The whole selected-day column is saved for
visual inspection but is not submitted to the engines.

The profile includes source-week dates as operator input. The tool deliberately
marks identity `unverified`: it does not turn supplied dates into supposedly
observed dates. Same aspect ratio is not sufficient to validate a future layout.

Truth files were transcribed and checked against native-resolution crops. The
Saturday source itself prints `#Self 베이리` and `슬리이스치즈`; these source typos
are preserved rather than counted as OCR errors or silently repaired.

## Measured comparison (2026-10-13)

Environment: macOS arm64, Python 3.9.6, CPU only. See `requirements.lock` for the
resolved package versions/hashes and `evaluation-summary.json` for model-weight
hashes, per-crop metrics, observations, and provenance.

| Engine | Tuesday menu edits / characters | Saturday menu edits / characters | Blank Saturday cup rice/dinner |
| --- | ---: | ---: | --- |
| PaddleOCR 3.3.2 / PaddlePaddle 3.2.2 | 0 / 124 (0%) | 0 / 114 (0%) | No text detected in either |
| EasyOCR 1.7.2 / Torch 2.8.0 | 14 / 124 (11.29%) | 10 / 114 (8.77%) | No text detected in either |

Menu scores include breakfast Korean/Western/common, cup rice, dinner, and drinks.
Banner and day header also matched after NFC normalization and whitespace removal
for both engines. Blank crops have no CER denominator and are assessed separately.

Examples of EasyOCR transcription errors:

- `참치콘샐러드덮밥` → `참치콤썰러드뒷밥`
- `계란찜` → `계란짐`
- `디톡스워터` → `디투스위터`

PaddleOCR split a day heading into separate month/day boxes. Naive sorting by
minimum Y incorrectly reversed them due to a one-pixel vertical offset. The tool
now groups overlapping text rows and orders same-row fragments left-to-right;
a regression test covers this. This is geometry ordering, not text correction.

Single-run, cached-weight timing observations for all named OCR crops, including
banner/labels:

| Engine | Tuesday initialization / inference | Saturday initialization / inference |
| --- | ---: | ---: |
| PaddleOCR | 7.06 s / 12.46 s | 5.84 s / 11.86 s |
| EasyOCR | 3.18 s / 3.54 s | 3.11 s / 3.65 s |

These are not controlled hardware benchmarks or production latency guarantees.
Initialization includes imports and model loading/connectivity checks, but these
runs did not download weights. Peak memory was not measured. Initial downloads
and installation were completed in the isolated ignored environment; no Worker
runtime dependencies were added.

The system Python build uses LibreSSL and urllib3 emitted an OpenSSL compatibility
warning. Downloads and local inference completed without disabling TLS verification.
A future deployed runtime should use a supported Python/OpenSSL build rather than
replicate this old local interpreter blindly.

## Other proposed engines: researched, not run

| Engine | Task fit | Important limitation |
| --- | --- | --- |
| PaddleOCR Korean PP-OCRv5 | Detector + Korean recognizer with text geometry; best result in this sample | Explicitly choose the Korean recognizer; default recognition is not enough. |
| EasyOCR | Korean/English detector + recognizer, CPU baseline | More spelling errors in this small evaluation. |
| VARCO-VISION-2.0-1.7B-OCR | OCR-specialized generative VLM producing text/bounding-box markup | Still contains a Qwen3 language model; roughly 4.25 GB weight file, CC BY-NC 4.0 license. CPU budget unmeasured. |
| ddobokki/ko-trocr | Korean text-line recognizer | Needs line detection/crops; not a whole-day table parser. No task-specific accuracy measured here. |

Primary references:

- [PaddleOCR multilingual recognition](https://paddlepaddle.github.io/PaddleOCR/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html)
- [PaddleOCR OCR pipeline and coordinate output](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/pipeline_usage/OCR.html)
- [EasyOCR usage, CPU support and license](https://github.com/JaidedAI/EasyOCR)
- [VARCO model card](https://huggingface.co/NCSOFT/VARCO-VISION-2.0-1.7B-OCR)
- [ko-trocr model card](https://huggingface.co/ddobokki/ko-trocr)
- [TrOCR intended single-line use](https://huggingface.co/microsoft/trocr-base-stage1)

## Next decisions, not implemented

1. Choose a separate CPU runtime for OCR (e.g. manual/scheduled GitHub Actions or
   an existing host). Python/native OCR is not a drop-in TypeScript Worker module.
2. Validate table geometry and observed banner/date/weekday before accepting a
   crop. Test more weeks, shared rows, missing cells, and changed layouts.
3. Agree on daily result/cache format and authenticated ingestion before replacing
   the current seven-day LLM schema. Preserve original source/image identities,
   retention limits, historical jobs, and all uncertain usage reservations.
4. Map observed OCR text to sections deterministically. Blank/ambiguous cells stay
   unknown; OCR confidence must not become proof of availability.
5. Preserve the official-image fallback and evaluate manually before enabling any
   automatic serving-cache writes or live deliveries.
