import json
from pathlib import Path
import sys
import tempfile
import unittest
from datetime import date, timedelta

sys.path.insert(0, str(Path(__file__).parent))
import pipeline

try:
    from PIL import Image, ImageDraw
    import cv2
except ImportError:
    Image = None


def source(start="2026-10-12"):
    first = date.fromisoformat(start)
    return {"url": "https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941660",
            "imageUrl": "https://scc.sogang.ac.kr/dataview/board/1185/example.jpg",
            "published": (first - timedelta(days=4)).isoformat(), "start": start,
            "end": (first + timedelta(days=6)).isoformat()}


def identity(start="2026-10-12"):
    first = date.fromisoformat(start)
    last = first + timedelta(days=6)
    banner = [f"{first:%Y.%m.%d}~{last:%Y.%m.%d}"]
    headers = [[f"{(first + timedelta(days=i)).month}월 {(first + timedelta(days=i)).day}일",
                f"{pipeline.WEEKDAYS[i]}요일"] for i in range(7)]
    return banner, headers


def grid(dx=0):
    picture = Image.new("RGB", (2000, 1000), "white")
    draw = ImageDraw.Draw(picture)
    ys = [125, 175, 380, 406, 560, 586, 612, 670, 856, 882, 910]
    xs = [100, 180, 300, 520, 740, 960, 1180, 1400, 1620, 1840]
    for y in ys:
        draw.line((xs[0] + dx, y, xs[-1] + dx, y), fill="black", width=3)
    for x in xs:
        draw.line((x + dx, 175, x + dx, 586), fill="black", width=3)
        draw.line((x + dx, 612, x + dx, 910), fill="black", width=3)
    return picture


def inline_grid(first_day=100, second_day=225):
    # Measured rules from the 1046x770 official PNG, without any source text.
    picture = Image.new("RGB", (1046, 770), "white")
    draw = ImageDraw.Draw(picture)
    ys = [89, 127, 290, 310, 431, 452, 472, 526, 668, 689, 709]
    xs = [22, 60, first_day, second_day, 352, 476, 606, 734, 875, 1014]
    for y in ys:
        draw.line((xs[0], y, xs[-1], y), fill="black", width=3)
    for x in xs:
        draw.line((x, 127, x, 452), fill="black", width=3)
        draw.line((x, 472, x, 709), fill="black", width=3)
    return picture


def detections(lines):
    return [{"text": text, "confidence": .99,
             "box": [[10, i * 20 + 2], [100, i * 20 + 2], [100, i * 20 + 16], [10, i * 20 + 16]]}
            for i, text in enumerate(lines)]


class IdentityTests(unittest.TestCase):
    def test_observed_banner_and_every_weekday_required(self):
        banner, headers = identity()
        dates = pipeline.observe_identity(banner, headers, source())
        self.assertEqual([day.isoformat() for day in dates], [f"2026-10-{i}" for i in range(12, 19)])
        headers[1][1] = "월요일"
        with self.assertRaisesRegex(pipeline.Rejected, "conflicting_column_date"):
            pipeline.observe_identity(banner, headers, source())

    def test_observation_bounds_match_ingestion_before_engine_acceptance(self):
        banner, headers = identity()
        for invalid in (banner + ["extra"] * 12, [banner[0], ""], [banner[0], "x" * 151]):
            with self.assertRaises(pipeline.Rejected):
                pipeline.observe_identity(invalid, headers, source())
        headers[0] += ["extra"] * 12
        with self.assertRaises(pipeline.Rejected):
            pipeline.observe_identity(banner, headers, source())

    def test_month_and_year_rollover(self):
        for first in ("2026-09-28", "2026-12-28"):
            banner, headers = identity(first)
            result = pipeline.observe_identity(banner, headers, source(first))
            self.assertEqual(result[-1].isoformat(), source(first)["end"])
        banner, headers = identity("2026-12-28")
        self.assertEqual(pipeline.observe_identity(["2026.12.28~01.03"], headers, source("2026-12-28"))[-1].year, 2027)

    def test_rejects_source_banner_conflict_and_swapped_or_missing_headers(self):
        banner, headers = identity("2026-09-14")
        with self.assertRaisesRegex(pipeline.Rejected, "conflicting_banner_dates"):
            pipeline.observe_identity(["2026.09.07~2026.09.13"], headers, source("2026-09-14"))
        banner, headers = identity()
        headers[0], headers[1] = headers[1], headers[0]
        with self.assertRaises(pipeline.Rejected):
            pipeline.observe_identity(banner, headers, source())
        with self.assertRaises(pipeline.Rejected):
            pipeline.observe_identity(banner, headers[:6], source())
        with self.assertRaises(pipeline.Rejected):
            pipeline.observe_identity([], identity()[1], source())

    def test_day_unit_can_be_missed_without_inventing_numeric_date(self):
        banner, headers = identity("2026-09-21")
        headers[4] = ["09월", "25", "금요일"]
        self.assertEqual(pipeline.observe_identity(banner, headers, source("2026-09-21"))[4].day, 25)
        headers[4] = ["09월", "251", "금요일"]
        with self.assertRaises(pipeline.Rejected):
            pipeline.observe_identity(banner, headers, source("2026-09-21"))

    def test_numeric_date_tokens_cannot_be_substrings_of_extra_digits(self):
        banner, headers = identity()
        for text in ("12026.10.12~10.18", "2026.10.12~10.181"):
            with self.assertRaises(pipeline.Rejected):
                pipeline.observe_identity([text], headers, source())
        headers[0][0] = "110월 12일"
        with self.assertRaises(pipeline.Rejected):
            pipeline.observe_identity(banner, headers, source())

    def test_conflicting_explicit_header_year_rejected(self):
        banner, headers = identity()
        headers[0].insert(0, "2025년")
        with self.assertRaises(pipeline.Rejected):
            pipeline.observe_identity(banner, headers, source())

    def test_omitted_end_year_same_month_and_unicode_spacing(self):
        banner, headers = identity()
        self.assertEqual(pipeline.observe_identity(["주간메뉴표", "2026.10.12 ~10.18"], headers, source())[0].day, 12)
        _, headers = identity("2026-09-28")
        self.assertEqual(pipeline.observe_identity(["2026.09,28~ 10.04"], headers, source("2026-09-28"))[-1].month, 10)


class OfferingTests(unittest.TestCase):
    def test_typo_is_available_blank_is_unknown_explicit_closure_is_closed(self):
        self.assertEqual(pipeline.offering(["계란짐"], "10월 13일 화요일")["items"], ["계란짐"])
        self.assertEqual(pipeline.offering([], "date")["status"], "unknown")
        self.assertEqual(pipeline.offering(["토요일 석식 미운영"], "date")["status"], "closed")

    def test_badges_and_bakery_headings_alone_are_not_menu_items(self):
        for lines in (["강력추"], ["강력추천"], ["HIT"], ["#수제베이커리"]):
            self.assertEqual(pipeline.offering(lines, "date")["status"], "unknown")
        self.assertEqual(pipeline.offering(["#수제베이커리", "갈릭피자"], "date")["items"], ["갈릭피자"])

    def test_time_requires_observed_clock_and_menu_items(self):
        result = pipeline.offering(["11:40", "참치콘샐러드덮밥"], "date")
        self.assertEqual(result["time"], "11:40")
        self.assertIn(result["time"], result["evidence"])
        self.assertIsNone(pipeline.offering(["쌀밥"], "date")["time"])
        self.assertEqual(pipeline.offering(["11:40"], "date")["status"], "unknown")
        self.assertIsNone(pipeline.offering(["11:40", "12:00", "쌀밥"], "date")["time"])


@unittest.skipIf(Image is None, "Approved Pillow/OpenCV environment required")
class GeometryTests(unittest.TestCase):
    def test_detects_shifted_columns_and_insets_every_crop(self):
        first = pipeline.detect_geometry(grid())
        second = pipeline.detect_geometry(grid(35))
        self.assertEqual(second["dayBoundaries"], [x + 35 for x in first["dayBoundaries"]])
        for i in range(7):
            x0, y0, x1, y1 = first["crops"][f"breakfast_korean_{i}"]
            self.assertGreater(x0, first["dayBoundaries"][i])
            self.assertLess(x1, first["dayBoundaries"][i + 1])
        self.assertEqual(first["crops"]["breakfast_common"][0], first["dayBoundaries"][0] + first["inset"])

    def test_inline_png_narrow_labels_keep_all_seven_day_crops_aligned(self):
        geometry = pipeline.detect_geometry(inline_grid())
        boundaries = [100, 225, 352, 476, 606, 734, 875, 1014]
        self.assertEqual(geometry["dayBoundaries"], boundaries)
        self.assertTrue(all(not cells for cells in geometry["unknownCells"].values()))
        for index in range(7):
            for field in ("day_header", "breakfast_korean", "breakfast_western", "cup_rice", "dinner"):
                box = geometry["crops"][f"{field}_{index}"]
                self.assertEqual((box[0], box[2]), (boundaries[index] + 3, boundaries[index + 1] - 3))

    def test_narrow_labels_do_not_allow_bad_offsets_or_unequal_day_widths(self):
        for first, second in ((80, 225), (100, 170), (100, 300)):
            with self.subTest(first=first, second=second):
                with self.assertRaisesRegex(pipeline.Rejected, "unsupported_column_structure"):
                    pipeline.detect_geometry(inline_grid(first, second))

    def test_highlight_border_shift_preserves_observed_horizontal_rule(self):
        # Official replacement JPEG f28b397c has a red dinner highlight spanning
        # Tue--Fri; its top sits a few pixels above the orange cup/dinner rule.
        picture = Image.new("RGB", (3508, 2480), "white")
        draw = ImageDraw.Draw(picture)
        ys = [314, 433, 942, 1007, 1387, 1452, 1516, 1688, 2130, 2196, 2261]
        xs = [195, 318, 441, 834, 1234, 1625, 2031, 2436, 2879, 3312]
        for y in ys:
            draw.line((xs[0], y, xs[-1], y), fill="black", width=3)
        for x in xs:
            draw.line((x, ys[1], x, ys[5]), fill="black", width=3)
            draw.line((x, ys[6], x, ys[-1]), fill="black", width=3)
        # Neither uninterrupted portion is 55% of image width. Both portions
        # must be detected, not a guessed row inserted from expected spacing.
        draw.rectangle((834, 1684, 2436, 1692), fill="white")
        draw.line((834, 1686, 2436, 1686), fill="red", width=5)
        geometry = pipeline.detect_geometry(picture)
        self.assertEqual(len(geometry["horizontalRules"]), 11)
        self.assertLessEqual(abs(geometry["horizontalRules"][7] - 1688), 3)
        self.assertEqual(geometry["dayBoundaries"], xs[-8:])
        self.assertTrue(all(not cells for cells in geometry["unknownCells"].values()))
        # A single short fragment still cannot stand in for a table-wide rule.
        draw.rectangle((0, 1680, 3507, 1695), fill="white")
        draw.line((834, 1685, 2436, 1685), fill="red", width=3)
        with self.assertRaisesRegex(pipeline.Rejected, "unsupported_horizontal_grid"):
            pipeline.detect_geometry(picture)

    def test_missing_horizontal_rule_is_not_guessed(self):
        image = grid()
        ImageDraw.Draw(image).rectangle((0, 377, 1999, 383), fill="white")
        with self.assertRaisesRegex(pipeline.Rejected, "unsupported_horizontal_grid"):
            pipeline.detect_geometry(image)

    def test_merged_cup_cells_are_unknown_not_guessed_day_assignments(self):
        image = grid()
        ImageDraw.Draw(image).rectangle((957, 616, 963, 666), fill="white")
        geometry = pipeline.detect_geometry(image)
        self.assertEqual(geometry["unknownCells"]["cup_rice"], [2, 3])

    def test_shifted_cup_grid_rejected(self):
        image = grid()
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 616, 1999, 666), fill="white")
        for x in [100, 180, 330, 550, 770, 990, 1210, 1430, 1650, 1870]:
            draw.line((x, 616, x, 666), fill="black", width=3)
        with self.assertRaisesRegex(pipeline.Rejected, "misaligned_column_rules"):
            pipeline.detect_geometry(image)

    def run_fake(self, make_engine, picture=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "source.png"
            (picture if picture is not None else grid()).save(image)
            output = root / "result"
            result = pipeline.extract_week(image, source(), output, make_engine)
            diagnostic = json.loads((output / "diagnostic.json").read_text())
            self.assertTrue((output / "selected_day_0.png").exists())
            return result, diagnostic

    def factory(self, events, broken=None):
        banner, headers = identity()
        def create(name):
            events.append(name)
            if broken == "exception" and name == "paddle":
                raise RuntimeError("must not leak this raw provider error")
            def infer(path):
                stem = path.stem
                if stem == "banner":
                    return detections(["2026.10.05~10.11"] if broken == "dates" and name == "paddle" else banner)
                if stem.startswith("day_header_"):
                    return detections(headers[int(stem.rsplit("_", 1)[1])])
                if stem.startswith("cup_rice_") or stem.startswith("dinner_"):
                    return []
                return detections(["계란짐"])
            return infer
        return create

    def test_primary_initialized_once_no_fallback_for_spelling(self):
        events = []
        result, diagnostic = self.run_fake(self.factory(events))
        self.assertEqual(events, ["paddle"])
        self.assertEqual(result["engine"], "paddle")
        self.assertEqual(result["meal"]["days"][0]["breakfastKorean"]["items"], ["계란짐"])
        self.assertEqual(result["meal"]["days"][0]["cupRice"]["status"], "unknown")
        self.assertEqual(len(result["meal"]["days"]), 7)
        self.assertTrue(diagnostic["accepted"])

    def test_merged_cells_never_read_as_date_specific_menu(self):
        image = grid()
        ImageDraw.Draw(image).rectangle((957, 616, 963, 666), fill="white")
        events = []
        factory = self.factory(events)
        def create(name):
            infer = factory(name)
            def read(path):
                if path.stem in ("cup_rice_2", "cup_rice_3"):
                    self.fail("Merged cell must not be recognized as either day's menu")
                return infer(path)
            return read
        result, diagnostic = self.run_fake(create, image)
        self.assertEqual(result["meal"]["days"][2]["cupRice"]["status"], "unknown")
        self.assertEqual(result["meal"]["days"][3]["cupRice"]["status"], "unknown")
        self.assertEqual(diagnostic["geometry"]["unknownCells"]["cup_rice"], [2, 3])

    def test_engine_failure_and_wrong_dates_each_use_one_fallback(self):
        for reason in ("exception", "dates"):
            events = []
            result, diagnostic = self.run_fake(self.factory(events, reason))
            self.assertEqual(events, ["paddle", "easy"])
            self.assertEqual(result["engine"], "easy")
            self.assertFalse(diagnostic["attempts"][0]["accepted"])
            self.assertNotIn("provider error", json.dumps(diagnostic))

    def test_both_invalid_do_not_write_serving_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "source.png"
            grid().save(image)
            def factory(name):
                return lambda path: detections(["unreadable"])
            output = root / "result"
            with self.assertRaisesRegex(pipeline.Rejected, "both_engines_rejected"):
                pipeline.extract_week(image, source(), output, factory)
            self.assertFalse((output / "result.json").exists())
            self.assertFalse(json.loads((output / "diagnostic.json").read_text())["accepted"])


if __name__ == "__main__":
    unittest.main()
