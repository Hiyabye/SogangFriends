#!/usr/bin/env python3
"""Bounded CPU meal OCR: detected table geometry, observed dates, no network ingestion."""
import argparse
from datetime import timedelta
import hashlib
import json
from pathlib import Path
import re
import time

import evaluate

VERSION = "ocr-v1"
WEEKDAYS = "월화수목금토일"
FIELDS = {"breakfast_korean": "breakfastKorean", "breakfast_western": "breakfastWestern",
          "breakfast_common": "breakfastCommon", "cup_rice": "cupRice", "dinner": "dinner", "drinks": "drinks"}
SHARED = {"breakfast_common", "drinks"}


class Rejected(ValueError):
    """A deliberately bounded diagnostic code, not an upstream exception body."""


def groups(values, distance):
    output = []
    for value in values:
        value = int(value)
        if not output or value - output[-1][-1] > distance:
            output.append([value])
        else:
            output[-1].append(value)
    return output


def detect_geometry(image):
    """Recognize only the reviewed eleven-rule/seven-column table family; fail closed."""
    import cv2
    import numpy as np
    width, height = image.size
    if width < 700 or height < 500 or width * height > evaluate.MAX_PIXELS:
        raise Rejected("unsupported_image_dimensions")
    rgb = np.asarray(image.convert("RGB"))
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    # Orange/red rules vary by week. Text does not survive the long-line opening.
    warm = (red > 170) & (green < 190) & (blue < 130)
    dark = rgb.max(axis=2) < 120
    mask = (warm | dark).astype("uint8") * 255
    line = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((1, round(width * .55)), np.uint8))
    ys = [round(sum(row) / len(row)) for row in groups(
        np.flatnonzero((line > 0).sum(axis=1) > width * .55), max(2, round(height * .004)))]
    if len(ys) != 11 or not .07 < ys[0] / height < .2 or not .8 < ys[-1] / height < .96:
        raise Rejected("unsupported_horizontal_grid")
    # Header, Korean menu, calories, Western menu, calories, shared row, cup rice,
    # dinner, calories, drinks. Sizes enforce the supported structure, not dates.
    low = [.025, .12, .008, .08, .008, .008, .018, .12, .008, .008]
    high = [.08, .3, .04, .23, .04, .04, .11, .3, .04, .04]
    if any(not a < (right - left) / height < b for left, right, a, b in zip(ys, ys[1:], low, high)):
        raise Rejected("unsupported_row_structure")

    def verticals(top, bottom):
        if bottom - top < 5:
            raise Rejected("empty_table_row")
        values = np.flatnonzero((mask[top:bottom] > 0).mean(axis=0) > .8)
        return [round(sum(col) / len(col)) for col in groups(values, max(2, round(width * .002)))]

    columns = verticals(ys[1] + 8, ys[2] - 8)
    if len(columns) != 10:
        raise Rejected("unsupported_vertical_grid")
    xs = columns[-8:]
    widths = [right - left for left, right in zip(xs, xs[1:])]
    if (not .1 < xs[0] / width < .2 or not .85 < xs[-1] / width < .98
            or min(widths) < width * .08 or max(widths) / min(widths) > 1.3):
        raise Rejected("unsupported_column_structure")
    # A date heading alone cannot establish menu alignment. Recheck the menu
    # rules. Merged cells cannot be assigned to an individual date: suppress BOTH
    # adjacent offerings instead of slicing their text into guessed day cells.
    unknown_cells = {}
    for field, top, bottom in (("breakfast_western", ys[3] + 8, ys[4] - 8),
                               ("cup_rice", ys[6] + 8, ys[7] - 8),
                               ("dinner", ys[7] + 8, ys[8] - 8)):
        observed = verticals(top, bottom)
        matches = [any(abs(x - candidate) <= width * .003 for candidate in observed) for x in xs]
        unexpected = [x for x in observed if xs[0] <= x <= xs[-1]
                      and not any(abs(x - candidate) <= width * .003 for candidate in xs)]
        if not matches[0] or not matches[-1] or unexpected:
            raise Rejected("misaligned_column_rules")
        unknown_cells[field] = sorted({cell for boundary in range(1, 7) if not matches[boundary]
                                       for cell in (boundary - 1, boundary)})
    inset = max(3, round(min(width, height) * .002))
    spans = {"day_header": (ys[0], ys[1]), "breakfast_korean": (ys[1], ys[2]),
             "breakfast_western": (ys[3], ys[4]), "breakfast_common": (ys[5], ys[6]),
             "cup_rice": (ys[6], ys[7]), "dinner": (ys[7], ys[8]), "drinks": (ys[9], ys[10])}
    # This rectangle is centered above the grid and excludes the author/contact
    # areas on the right and the institutional logo on the left.
    banner = [round(width * .4), round(height * .015), round(width * .64), ys[0] - inset]
    crops = {"banner": banner}
    for name, (top, bottom) in spans.items():
        if name in SHARED:
            crops[name] = [xs[0] + inset, top + inset, xs[-1] - inset, bottom - inset]
        else:
            for index in range(7):
                crops[f"{name}_{index}"] = [xs[index] + inset, top + inset, xs[index + 1] - inset, bottom - inset]
    for index in range(7):
        crops[f"selected_day_{index}"] = [xs[index] + inset, ys[0] + inset, xs[index + 1] - inset, ys[-1] - inset]
    for name, (top, bottom) in spans.items():
        if name != "day_header":
            crops[f"labels_{name}"] = [columns[0] + inset, top + inset, xs[0] - inset, bottom - inset]
    if any(left >= right or top >= bottom for left, top, right, bottom in crops.values()):
        raise Rejected("empty_crop")
    return {"imageSize": [width, height], "horizontalRules": ys, "dayBoundaries": xs,
            "inset": inset, "unknownCells": unknown_cells, "crops": crops}


def source_period(source):
    try:
        start, end, published = (evaluate.parse_date(source[key]) for key in ("start", "end", "published"))
    except (ValueError, KeyError, TypeError):
        raise Rejected("invalid_source_period") from None
    if start.weekday() != 0 or end - start != timedelta(days=6) or abs((start - published).days) > 45:
        raise Rejected("invalid_source_period")
    return start, end


def joined(lines):
    if (not isinstance(lines, list) or len(lines) > 40 or any(
            not isinstance(value, str) or len(value) > 500 for value in lines)):
        raise Rejected("invalid_ocr_lines")
    return evaluate.normalize_text("".join(lines))


def identity_lines(lines):
    # Match the bounded Node/Worker ingestion contract before accepting an engine.
    if (not isinstance(lines, list) or not 1 <= len(lines) <= 12 or any(
            not isinstance(line, str) or not line.strip() or len(line) > 150 for line in lines)):
        raise Rejected("invalid_identity_observations")
    return lines


def observe_identity(banner, headers, source):
    identity_lines(banner)
    expected_start, expected_end = source_period(source)
    text = joined(banner)
    # Dot/comma punctuation substitutions do not change observed numeric dates.
    pattern = r"(?<!\d)(\d{4})[.,/-](\d{1,2})[.,/-](\d{1,2})[~～–-](?:(\d{4})[.,/-])?(\d{1,2})[.,/-](\d{1,2})(?!\d)"
    matches = list(re.finditer(pattern, text))
    if len(matches) != 1:
        raise Rejected("unreadable_banner_dates")
    match = matches[0]
    year, month, day = map(int, match.group(1, 2, 3))
    end_month, end_day = map(int, match.group(5, 6))
    end_year = int(match.group(4)) if match.group(4) else year + int(end_month < month)
    try:
        start = evaluate.parse_date(f"{year:04d}-{month:02d}-{day:02d}")
        end = evaluate.parse_date(f"{end_year:04d}-{end_month:02d}-{end_day:02d}")
    except ValueError:
        raise Rejected("invalid_banner_dates") from None
    if start != expected_start or end != expected_end:
        raise Rejected("conflicting_banner_dates")
    if not isinstance(headers, list) or len(headers) != 7:
        raise Rejected("missing_column_headers")
    dates = []
    for index, lines in enumerate(headers):
        text = joined(identity_lines(lines))
        observed_date = list(re.finditer(r"(?<!\d)(\d{1,2})월(\d{1,2})일?(?!\d)", text))
        weekdays = re.findall(r"([월화수목금토일])요일", text)
        candidate = start + timedelta(days=index)
        if len(observed_date) != 1 or len(weekdays) != 1:
            raise Rejected("unreadable_column_date")
        mm, dd = map(int, observed_date[0].group(1, 2))
        years = re.findall(r"(\d{4})년", text)
        if ((mm, dd) != (candidate.month, candidate.day) or weekdays[0] != WEEKDAYS[candidate.weekday()]
                or len(years) > 1 or years and int(years[0]) != candidate.year):
            raise Rejected("conflicting_column_date")
        # Candidate becomes usable only after the independently read header agrees
        # with the independently read banner. Array position alone never authorizes it.
        dates.append(candidate)
    return dates


def offering(lines, date_evidence):
    joined(lines)
    # Real sampled sources put recommendation badges in otherwise empty cells.
    # They are decoration, not offerings; do not turn an OCR-readable badge into food.
    lines = [line.strip() for line in lines if line.strip()
             and not line.strip().startswith("#")
             and not re.fullmatch(r"(?:강력추(?:천)?|추천|HIT|BEST|NEW)", evaluate.normalize_text(line), re.IGNORECASE)]
    if not lines:
        return {"status": "unknown", "items": [], "time": None, "evidence": ""}
    text = " / ".join(lines)
    normalized = evaluate.normalize_text(text)
    closure = any(token in normalized for token in ("미운영", "운영안함", "운영없음", "휴무", "식사없음"))
    evidence = f"{date_evidence}: {text}"[:500]
    if closure:
        return {"status": "closed", "items": [], "time": None, "evidence": evidence}
    clock = re.compile(r"(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)")
    times = clock.findall(text)
    items = [clock.sub("", line).strip(" /&") for line in lines]
    items = [line for line in items if line]
    if not items or len(items) > 20 or any(len(line) > 150 for line in items):
        return {"status": "unknown", "items": [], "time": None, "evidence": evidence}
    explicit_time = times[0] if len(times) == 1 and times[0] in evidence else None
    return {"status": "available", "items": items, "time": explicit_time, "evidence": evidence}


def load_engine(name):
    if name == "paddle":
        from paddleocr import PaddleOCR
        engine = PaddleOCR(text_detection_model_name="PP-OCRv5_server_det",
                           text_recognition_model_name="korean_PP-OCRv5_mobile_rec", device="cpu",
                           use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
        return lambda path: evaluate.paddle_detections(engine.predict(str(path)))
    import easyocr
    engine = easyocr.Reader(["ko", "en"], gpu=False)
    return lambda path: evaluate.reading_order([evaluate.detection(box, text, score)
        for box, text, score in engine.readtext(str(path), detail=1, paragraph=False)])


def extract_week(image_path, source, output, engine_factory=load_engine):
    from PIL import Image
    image_path, output = Path(image_path), Path(output)
    if output.exists():
        raise Rejected("output_already_exists")
    output.mkdir(parents=True)
    attempts = []
    diagnostics = {"version": VERSION, "accepted": False, "attempts": attempts}
    try:
        source_period(source)
        if image_path.stat().st_size > evaluate.MAX_IMAGE_BYTES:
            raise Rejected("source_image_too_large")
        image_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()
        diagnostics["imageHash"] = image_hash
        with Image.open(image_path) as image:
            if image.format not in ("PNG", "JPEG") or getattr(image, "n_frames", 1) != 1:
                raise Rejected("unsupported_image_format")
            if image.width * image.height > evaluate.MAX_PIXELS:
                raise Rejected("unsupported_image_dimensions")
            geometry = detect_geometry(image)
            image.load()
            image = image.convert("RGB")
            diagnostics["geometry"] = geometry
            for name, box in geometry["crops"].items():
                image.crop(box).save(output / f"{name}.png")
        for name in ("paddle", "easy"):
            started = time.perf_counter()
            attempt = {"engine": name, "accepted": False, "observed": {}}
            attempts.append(attempt)
            try:
                infer = engine_factory(name)
                def read(crop):
                    detections = infer(output / f"{crop}.png")
                    lines = [item["text"] for item in evaluate.reading_order(detections)]
                    joined(lines)
                    attempt["observed"][crop] = lines
                    return lines
                banner = read("banner")
                headers = [read(f"day_header_{index}") for index in range(7)]
                dates = observe_identity(banner, headers, source)
                shared = {field: read(field) for field in SHARED}
                days = []
                for index, date in enumerate(dates):
                    evidence = " ".join(headers[index])
                    day = {"date": date.isoformat(), "weekday": date.weekday() + 1}
                    for crop, field in FIELDS.items():
                        if index in geometry["unknownCells"].get(crop, []):
                            lines = []
                        else:
                            lines = shared[crop] if crop in SHARED else read(f"{crop}_{index}")
                        day[field] = offering(lines, evidence)
                    days.append(day)
                meal = {"start": dates[0].isoformat(), "end": dates[-1].isoformat(), "certain": True, "days": days}
                result = {"version": VERSION, "imageHash": image_hash, "engine": name,
                          "identity": {"banner": banner, "headers": headers}, "meal": meal}
                attempt["accepted"] = True
                diagnostics["accepted"] = True
                (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                return result
            except Rejected as error:
                attempt["reason"] = str(error)
            except Exception:
                # Models/imports/system failures can use the fallback; never log a
                # potentially sensitive upstream body or pretend a failed read worked.
                attempt["reason"] = "engine_failure"
            finally:
                attempt["elapsedSeconds"] = time.perf_counter() - started
        raise Rejected("both_engines_rejected")
    except Rejected as error:
        diagnostics["reason"] = str(error)
        raise
    finally:
        (output / "diagnostic.json").write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        extract_week(args.image, evaluate.read_json(args.source), args.output)
    except (Rejected, OSError, ValueError, ImportError):
        parser.exit(1, "OCR rejected; inspect the bounded diagnostic file.\n")
    print(str(args.output / "result.json"))


if __name__ == "__main__":
    main()
