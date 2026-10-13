#!/usr/bin/env python3
"""Manual, local-only meal crop/OCR evaluation; never produces serving meal data."""
import argparse
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import time
import unicodedata
from datetime import date, timedelta

DAY_REGIONS = ("day_header", "breakfast_korean", "breakfast_western", "cup_rice", "dinner")
REGION_ORDER = ("day_header", "breakfast_korean", "breakfast_western", "breakfast_common", "cup_rice", "dinner", "drinks")
CROP_NAMES = ("selected_day", "banner", "labels") + REGION_ORDER
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 20_000_000


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def real_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalized(values, length):
    return (isinstance(values, list) and len(values) == length
            and all(real_number(x) and 0 <= x <= 1 for x in values))


def parse_date(value):
    if not isinstance(value, str):
        raise ValueError("Date must be YYYY-MM-DD")
    result = date.fromisoformat(value)
    if result.isoformat() != value:
        raise ValueError("Date must be YYYY-MM-DD")
    return result


def validate_layout(layout, target, size):
    required = {"start", "end", "aspect_ratio", "aspect_tolerance", "day_boundaries", "banner", "labels", "regions"}
    if not isinstance(layout, dict) or set(layout) != required:
        raise ValueError("Layout must contain exactly: " + ", ".join(sorted(required)))
    start, end, target = parse_date(layout["start"]), parse_date(layout["end"]), parse_date(target)
    if start.weekday() != 0 or end - start != timedelta(days=6):
        raise ValueError("Layout period must be one Monday-Sunday week")
    index = (target - start).days
    if not 0 <= index < 7 or target.weekday() != index:
        raise ValueError("Target date must belong to the layout week")
    width, height = size
    if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
        raise ValueError("Image dimensions exceed evaluation limits")
    ratio, tolerance = layout["aspect_ratio"], layout["aspect_tolerance"]
    if not real_number(ratio) or ratio <= 0 or not real_number(tolerance) or not 0 <= tolerance <= 0.05:
        raise ValueError("Aspect ratio must be positive; relative tolerance must be 0..0.05")
    if abs(width / height / ratio - 1) > tolerance:
        raise ValueError("Image aspect ratio does not match reviewed layout")
    boundaries = layout["day_boundaries"]
    if not normalized(boundaries, 8) or any(a >= b for a, b in zip(boundaries, boundaries[1:])):
        raise ValueError("Eight strictly increasing normalized day boundaries required")
    for name in ("banner", "labels"):
        rect = layout[name]
        if not normalized(rect, 4) or rect[0] >= rect[2] or rect[1] >= rect[3]:
            raise ValueError("Invalid " + name + " rectangle")
    if layout["labels"][2] > boundaries[0]:
        raise ValueError("Labels must be left of the day columns")
    regions = layout["regions"]
    if not isinstance(regions, dict) or set(regions) != set(REGION_ORDER):
        raise ValueError("All named meal regions are required")
    previous = 0
    for name in REGION_ORDER:
        span = regions[name]
        if not normalized(span, 2) or span[0] >= span[1] or span[0] < previous:
            raise ValueError("Meal regions must be ordered, non-overlapping normalized Y-ranges")
        previous = span[1]
    if layout["banner"][3] > regions["day_header"][0]:
        raise ValueError("Banner must be above the day header")
    if layout["labels"][1] < regions["day_header"][0] or layout["labels"][3] > regions["drinks"][1]:
        raise ValueError("Labels must remain inside reviewed table bounds")
    return index


def crop_rectangles(layout, target, size):
    index = validate_layout(layout, target, size)
    xs, regions = layout["day_boundaries"], layout["regions"]
    left, right = xs[index:index + 2]
    rects = {
        "selected_day": [left, regions["day_header"][0], right, regions["drinks"][1]],
        "banner": layout["banner"], "labels": layout["labels"],
    }
    for name in REGION_ORDER:
        x0, x1 = (left, right) if name in DAY_REGIONS else (xs[0], xs[-1])
        rects[name] = [x0, regions[name][0], x1, regions[name][1]]
    width, height = size
    output = {}
    for name, rect in rects.items():
        box = [round(rect[0] * width), round(rect[1] * height), round(rect[2] * width), round(rect[3] * height)]
        if box[0] >= box[2] or box[1] >= box[3]:
            raise ValueError("Crop rounds to an empty region: " + name)
        output[name] = {"normalized": rect, "pixels": box}
    return output


def create_crops(image_path, layout, target, output):
    from PIL import Image
    image_path, output = Path(image_path), Path(output)
    if image_path.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("Source image exceeds 5 MiB")
    with Image.open(image_path) as image:
        if image.format not in ("PNG", "JPEG") or getattr(image, "n_frames", 1) != 1:
            raise ValueError("Only single-frame PNG/JPEG sources supported")
        rectangles = crop_rectangles(layout, target, image.size)
        image.load()
        image = image.convert("RGB")
        output.mkdir(parents=True, exist_ok=True)
        for name, region in rectangles.items():
            image.crop(region["pixels"]).save(output / (name + ".png"))
        return image.size, rectangles


def normalize_text(text):
    return "".join(unicodedata.normalize("NFC", text).split())


def edit_distance(left, right):
    row = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, row[j] + 1, row[j - 1] + (a != b)))
        row = current
    return row[-1]


def text_metrics(expected_lines, observed_lines):
    expected = normalize_text("".join(expected_lines))
    observed = normalize_text("".join(observed_lines))
    distance = edit_distance(expected, observed)
    return {"expected_characters": len(expected), "observed_characters": len(observed),
            "character_edits": distance, "character_error_rate": distance / len(expected) if expected else None,
            "exact_normalized_match": expected == observed, "expected_blank": not expected,
            "unexpected_text_in_blank": not expected and bool(observed)}


def validate_truth(truth):
    if not isinstance(truth, dict) or not truth or any(name not in CROP_NAMES for name in truth):
        raise ValueError("Truth must be a nonempty object keyed by known crop names")
    if any(not isinstance(lines, list) or any(not isinstance(line, str) for line in lines) for lines in truth.values()):
        raise ValueError("Each truth value must be an array of text lines; [] denotes blank")
    return truth


def polygon(value):
    result = value.tolist() if hasattr(value, "tolist") else value
    if not isinstance(result, (list, tuple)) or len(result) != 4:
        raise ValueError("OCR returned an invalid quadrilateral")
    output = []
    for point in result:
        if len(point) != 2 or any(not real_number(float(x)) for x in point):
            raise ValueError("OCR returned invalid coordinates")
        output.append([float(point[0]), float(point[1])])
    return output


def detection(box, text, score):
    score = float(score)
    if not isinstance(text, str) or not math.isfinite(score) or not 0 <= score <= 1:
        raise ValueError("OCR returned invalid text/confidence")
    return {"box": polygon(box), "text": text, "confidence": score}


def reading_order(detections):
    # Same-line fragments can differ by a pixel in Y; sort those left-to-right.
    rows = []
    for item in sorted(detections, key=lambda item: min(p[1] for p in item["box"])):
        top, bottom = min(p[1] for p in item["box"]), max(p[1] for p in item["box"])
        for row in rows:
            overlap = min(bottom, row["bottom"]) - max(top, row["top"])
            if overlap >= 0.5 * min(bottom - top, row["bottom"] - row["top"]):
                row["items"].append(item)
                break
        else:
            rows.append({"top": top, "bottom": bottom, "items": [item]})
    return [item for row in rows for item in sorted(row["items"], key=lambda item: min(p[0] for p in item["box"]))]


def paddle_detections(results):
    detections = []
    for result in results:
        data = result.json
        if callable(data):
            data = data()
        if isinstance(data, str):
            data = json.loads(data)
        data = data.get("res", data)
        texts, scores, boxes = data["rec_texts"], data["rec_scores"], data["rec_polys"]
        if not len(texts) == len(scores) == len(boxes):
            raise ValueError("PaddleOCR result array lengths disagree")
        detections.extend(detection(box, text, score) for box, text, score in zip(boxes, texts, scores))
    return reading_order(detections)


def run_engine(engine_name, crop_dir, names):
    started = time.perf_counter()
    if engine_name == "paddle":
        from paddleocr import PaddleOCR
        engine = PaddleOCR(text_detection_model_name="PP-OCRv5_server_det",
                           text_recognition_model_name="korean_PP-OCRv5_mobile_rec",
                           device="cpu", use_doc_orientation_classify=False,
                           use_doc_unwarping=False, use_textline_orientation=False)
        infer = lambda path: paddle_detections(engine.predict(str(path)))
        packages = ("paddleocr", "paddlepaddle")
        models = ["PP-OCRv5_server_det", "korean_PP-OCRv5_mobile_rec"]
    else:
        import easyocr
        engine = easyocr.Reader(["ko", "en"], gpu=False)
        infer = lambda path: reading_order([detection(box, text, score) for box, text, score in engine.readtext(str(path), detail=1, paragraph=False)])
        packages = ("easyocr", "torch", "torchvision")
        models = ["craft_mlt_25k", "korean_g2"]
    initialization_seconds = time.perf_counter() - started
    crops = {}
    for name in names:
        started = time.perf_counter()
        detections = infer(Path(crop_dir) / (name + ".png"))
        crops[name] = {"elapsed_seconds": time.perf_counter() - started, "detections": detections,
                       "lines": [item["text"] for item in detections]}
    return {"packages": {name: importlib.metadata.version(name) for name in packages},
            "models": models, "device": "cpu", "initialization_seconds": initialization_seconds, "crops": crops}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--layout", required=True, type=Path)
    parser.add_argument("--date", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--engine", choices=("none", "paddle", "easy", "both"), default="none")
    parser.add_argument("--truth", type=Path)
    args = parser.parse_args(argv)
    try:
        layout = read_json(args.layout)
        truth = validate_truth(read_json(args.truth)) if args.truth else None
        # No overwrite: a repeated evaluation must use a fresh diagnostic directory.
        if args.output.exists():
            raise ValueError("Output directory already exists; choose a fresh path")
        size, rectangles = create_crops(args.image, layout, args.date, args.output)
        report = {"evaluation_only": True, "identity_status": "unverified",
                  "warning": "Layout dates are operator input, not observed OCR identity. No serving meal JSON is produced. Confidence is not factual accuracy.",
                  "target_date": args.date, "layout_period": {"start": layout["start"], "end": layout["end"]},
                  "source_sha256": hashlib.sha256(args.image.read_bytes()).hexdigest(),
                  "layout_sha256": hashlib.sha256(args.layout.read_bytes()).hexdigest(),
                  "image_size": list(size), "rectangles": rectangles, "engines": {}}
        names = [name for name in rectangles if name != "selected_day"]
        engines = ("paddle", "easy") if args.engine == "both" else (() if args.engine == "none" else (args.engine,))
        for name in engines:
            result = run_engine(name, args.output, names)
            if truth:
                result["metrics"] = {crop: text_metrics(lines, result["crops"][crop]["lines"])
                                     for crop, lines in truth.items() if crop in result["crops"]}
            report["engines"][name] = result
        if truth:
            report["truth_sha256"] = hashlib.sha256(args.truth.read_bytes()).hexdigest()
            report["unevaluated_truth_crops"] = [name for name in truth if name not in names]
        (args.output / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(str(args.output / "result.json"))
    except (OSError, ValueError, ImportError) as error:
        parser.exit(1, "Evaluation failed: " + str(error) + "\n")


if __name__ == "__main__":
    main()
