#!/usr/bin/env python3
"""Exercise both native CPU engines and verify the approved downloaded weight files."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import tempfile
import time

import pipeline


def check_weights(snapshot, home=Path.home()):
    models = {"PP-OCRv5_server_det": ".paddlex/official_models/PP-OCRv5_server_det/inference.pdiparams",
              "korean_PP-OCRv5_mobile_rec": ".paddlex/official_models/korean_PP-OCRv5_mobile_rec/inference.pdiparams",
              "craft_mlt_25k": ".EasyOCR/model/craft_mlt_25k.pth",
              "korean_g2": ".EasyOCR/model/korean_g2.pth"}
    expected = {item["model"]: item for item in snapshot["model_weights"]}
    if set(expected) != set(models):
        raise ValueError("Unexpected model snapshot")
    checked = []
    for name, relative in models.items():
        path = home / relative
        item = expected[name]
        if path.stat().st_size != item["bytes"]:
            raise ValueError("Model size changed")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != item["sha256"]:
            raise ValueError("Model weights changed")
        checked.append({"model": name, "sha256": digest})
    return checked


def run(output):
    from PIL import Image, ImageDraw
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"nativeRuntimeVerified": False, "engines": []}
    try:
        with tempfile.TemporaryDirectory() as directory:
            image = Image.new("RGB", (600, 160), "white")
            ImageDraw.Draw(image).text((30, 40), "2026.10.12", fill="black", font_size=40)
            path = Path(directory) / "smoke.png"
            image.save(path)
            for name in ("paddle", "easy"):
                started = time.perf_counter()
                infer = pipeline.load_engine(name)
                detections = infer(path)
                if not isinstance(detections, list):
                    raise ValueError("Invalid native-engine output")
                report["engines"].append({"engine": name, "inferenceCompleted": True,
                                          "elapsedSeconds": time.perf_counter() - started})
        snapshot = json.loads(Path(__file__).with_name("evaluation-summary.json").read_text(encoding="utf-8"))
        report["checkedWeights"] = check_weights(snapshot)
        report["packages"] = {name: importlib.metadata.version(name)
                              for name in ("paddleocr", "paddlepaddle", "easyocr", "torch", "torchvision", "numpy", "opencv-contrib-python")}
        report["nativeRuntimeVerified"] = True
    except Exception:
        report["reason"] = "native_engine_or_weight_verification_failed"
    with output.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    return 0 if report["nativeRuntimeVerified"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    raise SystemExit(run(parser.parse_args().output))
