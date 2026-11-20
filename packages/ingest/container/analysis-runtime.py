# Copyright (c) 2026 Orime, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Isolated pinned detectors: trusted JSON request, complete BGR24 stdin, owned JSON stdout."""
import json
import math
from pathlib import Path
import platform
import sys
from typing import BinaryIO, Iterator

import cv2
import numpy as np
import scenedetect
from scenedetect import FrameTimecode, StatsManager
from scenedetect.detectors import ContentDetector


def positive_integer(value: object) -> bool:
    """Recognize positive integers without accepting JSON booleans as dimensions."""
    return type(value) is int and 0 < value <= 9007199254740991


def finite_number(value: object) -> bool:
    """Recognize finite JSON numbers without coercion or booleans."""
    return type(value) in (int, float) and math.isfinite(value)


def validate_request(request: object) -> dict:
    """Require the exact implemented profile and all its supported effective parameters."""
    if not isinstance(request, dict) or set(request) != {"kind", "width", "height", "expectedFrameCount", "profile"}:
        raise ValueError("Expected an exact analysis request")
    if not all(positive_integer(request[key]) for key in ("width", "height", "expectedFrameCount")):
        raise ValueError("Expected positive integral analysis geometry and frame count")
    profile = request["profile"]
    if not isinstance(profile, dict) or set(profile) != {"id", "version", "weightsHash", "params"}:
        raise ValueError("Expected a complete frozen detector profile")
    params = profile["params"]
    if not isinstance(params, dict):
        raise ValueError("Expected frozen detector parameters")
    if request["kind"] == "scene_cuts":
        if (profile["id"], profile["version"], profile["weightsHash"]) != ("pyscenedetect-content", "0.7.2", None):
            raise ValueError("Unsupported frozen scene detector profile")
        if set(params) != {"threshold", "minSceneLength"}:
            raise ValueError("Unsupported scene detector parameter keys")
        if not finite_number(params["threshold"]) or params["threshold"] < 0 or not positive_integer(params["minSceneLength"]):
            raise ValueError("Invalid frozen scene detector parameters")
    else:
        raise ValueError("Unsupported analysis kind")
    return request


def read_frames(source: BinaryIO, width: int, height: int, count: int) -> Iterator[np.ndarray]:
    """Reassemble exact BGR24 frames and require natural EOF at the declared count."""
    size = width * height * 3
    for index in range(count):
        data = bytearray()
        while len(data) < size:
            chunk = source.read(size - len(data))
            if not chunk:
                raise ValueError(f"Incomplete BGR24 frame {index}: {len(data)} of {size} bytes")
            data.extend(chunk)
        yield np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
    if source.read(1):
        raise ValueError("Unexpected extra BGR24 bytes after the frozen frame count")


def analyze(request: dict, source: BinaryIO) -> dict:
    """Run the frozen detector against full input; never emit intermediate results."""
    if (platform.python_version(), np.__version__, cv2.__version__, scenedetect.__version__) != ("3.12.16", "2.3.5", "4.12.0", "0.7.2"):
        raise ValueError("Installed analysis runtime versions differ from the built profile")
    cv2.setNumThreads(1)
    frames = read_frames(source, request["width"], request["height"], request["expectedFrameCount"])
    params = request["profile"]["params"]
    # FrameTimecode carries only detector-local indices. Source PTS stay in Node's ledger.
    stats = StatsManager(FrameTimecode(0, fps=30.0))
    detector = ContentDetector(threshold=float(params["threshold"]), min_scene_len=params["minSceneLength"])
    detector.stats_manager = stats
    stats.register_metrics(detector.get_metrics())
    cuts = []
    for index, frame in enumerate(frames):
        for timecode in detector.process_frame(FrameTimecode(index, fps=30.0), frame):
            raw_score = stats.get_metrics(timecode, [ContentDetector.FRAME_SCORE_KEY])[0]
            score = None if raw_score is None else float(raw_score)
            if not finite_number(score):
                raise ValueError("Scene cut lacks a finite content_val metric")
            cuts.append({"detectorFrameIndex": timecode.frame_num, "detectionScore": float(score)})
    return {"cuts": cuts}


def main() -> None:
    """Read one trusted local request and publish JSON only after successful complete input."""
    if len(sys.argv) != 2:
        raise ValueError("Expected exactly one trusted request file path")
    request = validate_request(json.loads(Path(sys.argv[1]).read_text()))
    result = analyze(request, sys.stdin.buffer)
    sys.stdout.write(json.dumps(result, allow_nan=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"analysis runtime: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
