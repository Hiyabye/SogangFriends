#!/usr/bin/env python3
"""Process a prepared retained-week manifest locally; never upload or serve results."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def run(output, require_processed=False):
    manifest_path = output / "manifest.json"
    if manifest_path.stat().st_size > 32 * 1024:
        raise ValueError("Manifest too large")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest.get("entries")
    if manifest.get("version") != "ocr-v1" or not isinstance(entries, list) or len(entries) > 2:
        raise ValueError("Invalid manifest")
    outcomes = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or not isinstance(entry.get("cached"), bool) or entry.get("mime") not in ("image/png", "image/jpeg"):
            raise ValueError("Invalid entry")
        directory = "week-%d" % index
        extension = "png" if entry["mime"] == "image/png" else "jpg"
        expected = {"imageFile": directory + "/source." + extension,
                    "sourceFile": directory + "/source.json", "resultDirectory": directory + "/ocr"}
        if any(entry.get(key) != value for key, value in expected.items()):
            raise ValueError("Untrusted paths")
        image = output / expected["imageFile"]
        source = output / expected["sourceFile"]
        if image.stat().st_size > 5 * 1024 * 1024 or hashlib.sha256(image.read_bytes()).hexdigest() != entry.get("imageHash"):
            raise ValueError("Source image changed")
        if source.stat().st_size > 8192 or json.loads(source.read_text(encoding="utf-8")) != entry.get("source"):
            raise ValueError("Source metadata changed")
        if entry["cached"]:
            outcomes.append({"index": index, "status": "cached"})
            continue
        destination = output / expected["resultDirectory"]
        # Keep third-party model logs out of Actions console/artifacts; errors may contain paths or data.
        with (output / directory / "engine.log").open("xb") as log:
            try:
                result = subprocess.run([sys.executable, str(Path(__file__).with_name("pipeline.py")),
                                         "--image", str(image), "--source", str(source),
                                         "--output", str(destination)], stdout=log, stderr=log,
                                        timeout=600, check=False)
                status = "accepted" if result.returncode == 0 else "rejected"
            except subprocess.TimeoutExpired:
                status = "timeout"
        outcomes.append({"index": index, "status": status})
    failed = sum(item["status"] not in ("accepted", "cached") for item in outcomes)
    processed = sum(item["status"] == "accepted" for item in outcomes)
    verified = processed > 0 and failed == 0
    summary = {"evaluationOnly": True, "outcomes": outcomes, "failed": failed,
               "processed": processed, "runtimeVerified": verified}
    with (output / "batch-summary.json").open("x", encoding="utf-8") as report:
        json.dump(summary, report, indent=2)
        report.write("\n")
    print("OCR batch: %d sources; %d failed" % (len(outcomes), failed))
    return 1 if failed or (require_processed and not verified) else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--require-processed", action="store_true", help="Reject no-work verification runs")
    args = parser.parse_args()
    try:
        return run(args.output.resolve(), args.require_processed)
    except (OSError, ValueError, KeyError, TypeError):
        print("OCR batch preparation failed; no results uploaded.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
