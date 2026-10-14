import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("evaluate", Path(__file__).with_name("evaluate.py"))
evaluate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluate)
try:
    from PIL import Image
except ImportError:
    Image = None


def layout():
    return {"start": "2026-10-12", "end": "2026-10-18", "aspect_ratio": 2,
            "aspect_tolerance": 0.01, "day_boundaries": [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
            "banner": [0.3, 0.02, 0.8, 0.09], "labels": [0.05, 0.1, 0.19, 0.9],
            "regions": {"day_header": [0.1, 0.2], "breakfast_korean": [0.2, 0.35],
                        "breakfast_western": [0.36, 0.5], "breakfast_common": [0.51, 0.55],
                        "cup_rice": [0.56, 0.6], "dinner": [0.61, 0.85], "drinks": [0.86, 0.9]}}


class LayoutTests(unittest.TestCase):
    def test_each_day_uses_its_own_column_and_header(self):
        for index in range(7):
            result = evaluate.crop_rectangles(layout(), "2026-10-%02d" % (12 + index), (2000, 1000))
            self.assertEqual(result["selected_day"]["pixels"], [400 + index * 200, 100, 600 + index * 200, 900])
            self.assertEqual(result["day_header"]["pixels"], [400 + index * 200, 100, 600 + index * 200, 200])
            self.assertEqual(result["breakfast_common"]["pixels"], [400, 510, 1800, 550])
            self.assertEqual(result["drinks"]["pixels"], [400, 860, 1800, 900])

    def test_rejects_bad_date_week_and_aspect(self):
        for target in ("2026-10-11", "2026-10-19", "2026-02-30", "20261012"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                evaluate.crop_rectangles(layout(), target, (2000, 1000))
        for key, value in (("start", "2026-10-13"), ("end", "2026-10-19"), ("aspect_ratio", 1.5), ("aspect_tolerance", 0.2)):
            profile = layout()
            profile[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                evaluate.crop_rectangles(profile, "2026-10-14", (2000, 1000))

    def test_rejects_untrusted_geometry(self):
        cases = []
        profile = layout(); profile["day_boundaries"][3] = profile["day_boundaries"][2]; cases.append(profile)
        profile = layout(); profile["day_boundaries"][0] = float("nan"); cases.append(profile)
        profile = layout(); profile["banner"] = [0, 0, 1, 0.2]; cases.append(profile)
        profile = layout(); profile["labels"][2] = 0.3; cases.append(profile)
        profile = layout(); profile["regions"]["dinner"] = [0.5, 0.9]; cases.append(profile)
        profile = layout(); profile["regions"]["drinks"] = [0.9, 1.1]; cases.append(profile)
        profile = layout(); del profile["regions"]["cup_rice"]; cases.append(profile)
        for profile in cases:
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                evaluate.crop_rectangles(profile, "2026-10-14", (2000, 1000))

    def test_rejects_empty_pixel_crop_and_excessive_pixels(self):
        with self.assertRaises(ValueError):
            evaluate.crop_rectangles(layout(), "2026-10-14", (2, 1))
        with self.assertRaises(ValueError):
            evaluate.crop_rectangles(layout(), "2026-10-14", (10000, 5000))


class MetricTests(unittest.TestCase):
    def test_normalizes_korean_and_ignores_whitespace(self):
        result = evaluate.text_metrics(["한 식", "쌀밥"], ["한식", "쌀 밥"])
        self.assertEqual(result["character_edits"], 0)
        self.assertTrue(result["exact_normalized_match"])

    def test_insertion_deletion_and_substitution(self):
        self.assertEqual(evaluate.edit_distance("abc", "axd"), 2)
        self.assertEqual(evaluate.edit_distance("", "abc"), 3)
        result = evaluate.text_metrics(["쌀밥"], ["현미밥"])
        self.assertEqual(result["character_edits"], 2)
        self.assertEqual(result["character_error_rate"], 1)

    def test_blank_truth_does_not_make_fake_perfect_score(self):
        result = evaluate.text_metrics([], ["invented"])
        self.assertTrue(result["unexpected_text_in_blank"])
        self.assertIsNone(result["character_error_rate"])
        self.assertFalse(result["exact_normalized_match"])
        self.assertTrue(evaluate.text_metrics([], [])["exact_normalized_match"])

    def test_truth_rejects_unknown_regions_and_non_lines(self):
        for truth in ({}, {"footer": []}, {"dinner": "text"}, {"dinner": [123]}):
            with self.assertRaises(ValueError):
                evaluate.validate_truth(truth)
        self.assertEqual(evaluate.validate_truth({"dinner": []}), {"dinner": []})

    def test_same_line_fragments_ignore_small_vertical_offsets(self):
        def item(text, left, top):
            return evaluate.detection([[left, top], [left + 70, top], [left + 70, top + 39], [left, top + 39]], text, 0.9)
        output = evaluate.reading_order([item("13일", 204, 4), item("10월", 124, 5), item("화요일", 148, 63)])
        self.assertEqual([entry["text"] for entry in output], ["10월", "13일", "화요일"])

    def test_paddle_adapter_orders_geometry_and_validates_lengths(self):
        class Result:
            json = {"res": {"rec_texts": ["bottom", "top"], "rec_scores": [0.8, 0.9],
                            "rec_polys": [[[0, 20], [10, 20], [10, 30], [0, 30]], [[0, 0], [10, 0], [10, 10], [0, 10]]]}}
        result = evaluate.paddle_detections([Result()])
        self.assertEqual([item["text"] for item in result], ["top", "bottom"])
        self.assertEqual(result[0]["confidence"], 0.9)
        invalid = copy.deepcopy(Result.json); invalid["res"]["rec_scores"] = []
        Result.json = invalid
        with self.assertRaises(ValueError):
            evaluate.paddle_detections([Result()])


@unittest.skipIf(Image is None, "Pillow required for crop integration tests")
class CropIntegrationTests(unittest.TestCase):
    def test_crop_pixels_and_report_without_engines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            picture = Image.new("RGB", (2000, 1000), "white")
            for x in range(400, 1800):
                for y in range(100, 900):
                    picture.putpixel((x, y), ((x - 400) // 200 * 30, 0, 0))
            picture.save(source)
            profile = root / "layout.json"
            profile.write_text(json.dumps(layout()))
            output = root / "output"
            evaluate.main(["--image", str(source), "--layout", str(profile), "--date", "2026-10-14", "--output", str(output)])
            with Image.open(output / "selected_day.png") as crop:
                self.assertEqual(crop.size, (200, 800))
                self.assertEqual(crop.getpixel((10, 10)), (60, 0, 0))
            report = json.loads((output / "result.json").read_text())
            self.assertTrue(report["evaluation_only"])
            self.assertEqual(report["identity_status"], "unverified")
            self.assertEqual(report["engines"], {})
            self.assertEqual(len(report["source_sha256"]), 64)
            self.assertEqual(set(report["rectangles"]), set(evaluate.CROP_NAMES))
            self.assertFalse((output / "source.png").exists())
            with self.assertRaises(SystemExit):
                evaluate.main(["--image", str(source), "--layout", str(profile), "--date", "2026-10-14", "--output", str(output)])

    def test_rejects_non_png_jpeg_and_oversized_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.bmp"
            Image.new("RGB", (2000, 1000)).save(source)
            with self.assertRaises(ValueError):
                evaluate.create_crops(source, layout(), "2026-10-14", root / "output")
            source.write_bytes(b"x" * (evaluate.MAX_IMAGE_BYTES + 1))
            with self.assertRaises(ValueError):
                evaluate.create_crops(source, layout(), "2026-10-14", root / "output")


if __name__ == "__main__":
    unittest.main()
