# Copyright (c) 2026 Orime, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Exercise the real isolated detector CLI inside the media image."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest


SCENE = {
    "kind": "scene_cuts", "width": 64, "height": 64, "expectedFrameCount": 60,
    "profile": {"id": "pyscenedetect-content", "version": "0.7.2", "weightsHash": None,
                "params": {"threshold": 27, "minSceneLength": 15}},
}
BLACK = bytes(64 * 64 * 3)
WHITE = bytes([255]) * len(BLACK)
# The lip-sync faces request (frames-split §7.17 lipsync_faces row): every prepared frame of one person, the people YuNet profile.
FACES = {
    "kind": "faces", "width": 64, "height": 64, "expectedFrameCount": 3,
    "profile": {"id": "opencv-yunet-2023mar", "version": "2023mar",
                "weightsHash": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
                "params": {"scoreThreshold": 0.6, "nmsThreshold": 0.3, "topK": 5000}},
}


def load_runtime():
    """Load the installed runtime as a module, as the reader test does."""
    spec = importlib.util.spec_from_file_location("runtime", "/app/analysis-runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AnalysisRuntimeTests(unittest.TestCase):
    """Require complete bytes and actual ContentDetector observations."""

    def invoke(self, request: dict, data: bytes) -> subprocess.CompletedProcess:
        """Run one actual CLI invocation with a trusted temporary request file."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "request.json"
            path.write_text(json.dumps(request))
            return subprocess.run([sys.executable, "/app/analysis-runtime.py", str(path)],
                                  input=data, capture_output=True, timeout=30, check=False)

    def test_exact_content_metric_and_local_index(self) -> None:
        """Black to white changes V by 255, so the three-component mean is 85."""
        result = self.invoke(SCENE, BLACK * 30 + WHITE * 30)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"cuts": [{"detectorFrameIndex": 30, "detectionScore": 85.0}]})

    def test_range_uses_local_index(self) -> None:
        """Source frames 10 through 49 put the same cut at local frame 20."""
        request = {**SCENE, "expectedFrameCount": 40}
        result = self.invoke(request, BLACK * 20 + WHITE * 20)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"cuts": [{"detectorFrameIndex": 20, "detectionScore": 85.0}]})

    def test_no_cut(self) -> None:
        """Complete constant input succeeds with no fabricated cut."""
        result = self.invoke(SCENE, BLACK * 60)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"cuts": []})

    def test_effective_threshold_is_used(self) -> None:
        """A threshold above the mathematical score of 85 suppresses this cut."""
        request = copy.deepcopy(SCENE)
        request["profile"]["params"]["threshold"] = 86
        result = self.invoke(request, BLACK * 30 + WHITE * 30)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"cuts": []})

    def test_people_empty_result_and_complete_eof(self) -> None:
        """Actual YuNet on a black anchor has no face; extra bytes still fail."""
        request = {
            "kind": "people", "width": 64, "height": 64, "expectedFrameCount": 1,
            "profile": {"id": "opencv-yunet-2023mar", "version": "2023mar",
                        "weightsHash": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
                        "params": {"scoreThreshold": 0.6, "nmsThreshold": 0.3, "topK": 5000}},
        }
        result = self.invoke(request, BLACK)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"faces": None})
        for data in [BLACK[:5], BLACK + b"x"]:
            with self.subTest(length=len(data)):
                result = self.invoke(request, data)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"BGR24", result.stderr)
        request["expectedFrameCount"] = 2
        result = self.invoke(request, BLACK * 2)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"exactly one anchor", result.stderr)

    def test_faces_rows_follow_frame_order(self) -> None:
        """Each frame gets its own detector rows or null, in input order (§7.17 lipsync_faces: one row per frame)."""
        module = load_runtime()
        real = module.cv2
        seen = []

        class Detector:
            """Report one face whose x is the frame's first blue byte, none on a black frame."""

            def detect(self, frame):
                """Record the frame and answer as FaceDetectorYN.detect does."""
                value = int(frame[0, 0, 0])
                seen.append(value)
                return (1, None) if value == 0 else (1, module.np.array([[float(value)] + [1.0] * 14], dtype=module.np.float32))

        module.cv2 = types.SimpleNamespace(__version__=real.__version__, setNumThreads=real.setNumThreads,
                                           FaceDetectorYN=types.SimpleNamespace(create=lambda *_args: Detector()))
        values = [0, 40, 0, 120]
        frames = b"".join(bytes([value]) * len(BLACK) for value in values)
        result = module.analyze({**FACES, "expectedFrameCount": 4}, io.BytesIO(frames))
        self.assertEqual(seen, values)
        self.assertEqual(result, {"frames": [None, [[40.0] + [1.0] * 14], None, [[120.0] + [1.0] * 14]]})

    def test_faces_real_yunet_answers_null_per_frame(self) -> None:
        """Actual YuNet finds no face on three black frames: three nulls, never one merged answer."""
        result = self.invoke(FACES, BLACK * 3)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"frames": [None, None, None]})

    def test_faces_single_frame_answers_as_the_anchor(self) -> None:
        """One prepared frame is answered in the people shape, which lipsync-recipes.ts reads as `answer.faces`."""
        result = self.invoke({**FACES, "expectedFrameCount": 1}, BLACK)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"faces": None})

    def test_faces_frame_count_is_enforced(self) -> None:
        """A missing frame, a short frame and a surplus frame all fail without publishing rows."""
        for data in [BLACK * 2, BLACK * 2 + BLACK[:5], BLACK * 3 + b"x", BLACK * 4]:
            with self.subTest(length=len(data)):
                result = self.invoke(FACES, data)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"BGR24", result.stderr)

    def test_faces_profile_is_frozen(self) -> None:
        """Faces takes only the frozen YuNet profile; the scene profile or an extra parameter fails."""
        for profile in [SCENE["profile"], {**FACES["profile"], "params": {**FACES["profile"]["params"], "extra": 1}}]:
            with self.subTest(profile=profile["id"]):
                result = self.invoke({**FACES, "profile": profile}, BLACK * 3)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"analysis runtime:", result.stderr)

    def test_real_reader_reassembles_short_reads_and_bgr_order(self) -> None:
        """The independent 2x2 oracle survives every possible fixed chunk width."""
        spec = importlib.util.spec_from_file_location("runtime", "/app/analysis-runtime.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for chunk_size in range(1, 25):
            with self.subTest(chunk_size=chunk_size):
                class ShortReader:
                    """Expose legal short reads of one continuous byte stream."""

                    def __init__(self) -> None:
                        """Start from the independently specified two-frame bytes."""
                        self.remaining = bytes(range(24))

                    def read(self, count: int) -> bytes:
                        """Return at most the requested bytes and selected chunk width."""
                        size = min(count, chunk_size)
                        chunk, self.remaining = self.remaining[:size], self.remaining[size:]
                        return chunk

                frames = list(module.read_frames(ShortReader(), 2, 2, 2))
                self.assertEqual([frame.shape for frame in frames], [(2, 2, 3), (2, 2, 3)])
                self.assertEqual([str(frame.dtype) for frame in frames], ["uint8", "uint8"])
                self.assertEqual(frames[0].tolist(), [[[0, 1, 2], [3, 4, 5]], [[6, 7, 8], [9, 10, 11]]])
                self.assertEqual(frames[1].tolist(), [[[12, 13, 14], [15, 16, 17]], [[18, 19, 20], [21, 22, 23]]])

    def test_incomplete_input_never_publishes_success(self) -> None:
        """Empty, short frame, missing frame and surplus bytes all fail."""
        for data in [b"", BLACK * 59, BLACK * 59 + BLACK[:5], BLACK * 60 + b"x", BLACK * 61]:
            with self.subTest(length=len(data)):
                result = self.invoke(SCENE, data)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"BGR24", result.stderr)

    def test_frozen_runtime_and_profile_are_required(self) -> None:
        """Unsupported profiles and parameters fail before producing any result."""
        mutations = [
            ("kind", "unknown"), ("width", 0), ("height", True), ("expectedFrameCount", 0),
            ("profile.id", "unknown"), ("profile.version", "0.6.0"),
            ("profile.weightsHash", "other"), ("profile.params.threshold", -1),
            ("profile.params.minSceneLength", 0), ("profile.params.extra", 1),
        ]
        for key, value in mutations:
            with self.subTest(key=key):
                request = copy.deepcopy(SCENE)
                target = request
                parts = key.split(".")
                for part in parts[:-1]:
                    target = target[part]
                target[parts[-1]] = value
                result = self.invoke(request, BLACK * 60)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"analysis runtime:", result.stderr)


if __name__ == "__main__":
    unittest.main()
