"""Generate reproducible PC references; real sample pixels stay in ignored test assets."""
import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("--model-project", type=Path, default=Path(r"F:\边端\edge_image_text_emotion"))
args = parser.parse_args()
project = args.model_project
root = Path(__file__).resolve().parents[1]
module = root / "modules/edge-emotion/android"
assets = module / "src/androidTest/assets/validation"
resources = module / "src/test/resources/validation"
assets.mkdir(parents=True, exist_ok=True)
resources.mkdir(parents=True, exist_ok=True)
model = module / "src/main/assets/edge_emotion/model.onnx"
manifest = json.loads((model.parent / "manifest.json").read_text(encoding="utf-8-sig"))
assert hashlib.sha256(model.read_bytes()).hexdigest() == manifest["onnx_sha256"]
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])


def preprocess(image):
    image = image.convert("RGB").resize((128, 128), Image.Resampling.BILINEAR)
    tensor = np.asarray(image, dtype=np.float32) / np.float32(255)
    tensor = (tensor - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
    return np.ascontiguousarray(tensor.transpose(2, 0, 1)[None])


def probability(tensor):
    logits = session.run(None, {session.get_inputs()[0].name: tensor})[0].astype(np.float64)
    logits /= manifest["temperature"]
    logits -= logits.max()
    p = np.exp(logits)
    return (p / p.sum())[0].tolist()


cases = []
rng = np.random.default_rng(2026)
for index, (w, h, crop) in enumerate([
    (317, 239, [31, 24, 193]), (79, 61, [-11, -8, 98]),
    (48, 48, [0, 0, 48]), (256, 257, [2, 1, 250]),
    (128, 128, [0, 0, 128]), (640, 480, [100, 40, 350]),
]):
    rgb = rng.integers(0, 256, (h, w, 3), dtype=np.uint8)
    image = Image.fromarray(rgb)
    left, top, side = crop
    tensor = preprocess(image.crop((left, top, left + side, top + side)))
    case = dict(id=f"synthetic_{index}", width=w, height=h, crop=crop, probability=probability(tensor))
    for dest in (assets, resources):
        image.save(dest / f"{case['id']}.png")
        # JVM tests do not depend on Android Bitmap or PNG decoders.
        argb = (np.uint32(0xff000000) | rgb[:, :, 0].astype(np.uint32) << 16 |
                rgb[:, :, 1].astype(np.uint32) << 8 | rgb[:, :, 2].astype(np.uint32))
        argb.astype("<u4").tofile(dest / f"{case['id']}.argb")
        tensor.astype("<f4").tofile(dest / f"{case['id']}.tensor")
    cases.append(case)
for dest in (assets, resources):
    (dest / "cases.json").write_text(json.dumps(cases, indent=2), encoding="utf-8")
    # A simple tab format is also readable by dependency-free JVM tests.
    (dest / "cases.tsv").write_text("\n".join(
        "\t".join(map(str, [c["id"], c["width"], c["height"], *c["crop"]])) for c in cases), encoding="ascii")

# Existing real face crops check tensor inference independently of detector change.
runtime = json.loads((project / "artifacts/sfemo_D0_B05_L1_128_s2026_fp32/runtime_samples.json").read_text())
real_crops = []
for index, row in enumerate(runtime[:10]):
    source = project / row["relative_path"]
    image = Image.open(source).convert("RGB")
    tensor = preprocess(image)
    name = f"realcrop_{index}"
    tensor.astype("<f4").tofile(assets / f"{name}.tensor")
    real_crops.append(dict(id=name, source=str(source), probability=probability(tensor)))
(assets / "real_crops.json").write_text(json.dumps(real_crops, indent=2), encoding="utf-8")

# Sample one midpoint per source group without choosing examples based on predictions.
samples = [json.loads(line) for line in (project / "reports/client_real_20261025_v1/sample_manifest.jsonl").read_text(
    encoding="utf-8").splitlines()]
storage = cv2.FileStorage((project / "models/detector/haarcascade_frontalface_default.xml").read_text(
    encoding="utf-8"), cv2.FILE_STORAGE_READ | cv2.FILE_STORAGE_MEMORY)
haar = cv2.CascadeClassifier()
assert haar.read(storage.getFirstTopLevelNode())
seen = set()
detector_cases = []
for sample in samples:
    group = sample["group_key"]
    if group in seen:
        continue
    source = Path(sample["directory"]) / "video.mp4"
    cap = cv2.VideoCapture(str(source))
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(cap.get(cv2.CAP_PROP_FRAME_COUNT) // 2))
    ok, bgr = cap.read()
    cap.release()
    if not ok:
        continue
    seen.add(group)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    name = f"detector_{len(detector_cases)}"
    Image.fromarray(rgb).save(assets / f"{name}.png")
    boxes = haar.detectMultiScale(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), scaleFactor=1.1,
                                  minNeighbors=5, minSize=(24, 24))
    reference = None
    if len(boxes) == 1:
        x, y, w, h = map(int, boxes[0])
        side = int(max(w, h) * 1.2)
        left, top = int(x + w / 2 - side / 2), int(y + h / 2 - side / 2)
        tensor = preprocess(Image.fromarray(rgb).crop((left, top, left + side, top + side)))
        reference = probability(tensor)
    detector_cases.append(dict(id=name, source=str(source), group=group,
                               haar_boxes=[list(map(int, box)) for box in boxes], haar_probability=reference))
    if len(detector_cases) == 12:
        break
(assets / "detector_cases.json").write_text(json.dumps(detector_cases, indent=2), encoding="utf-8")
summary = dict(model_sha256=manifest["onnx_sha256"], synthetic_cases=len(cases),
               real_tensor_cases=len(real_crops), original_frame_cases=len(detector_cases),
               ort_pc=ort.__version__, pil=Image.__version__,
               scope="References generated on PC; Android comparisons are separate instrumentation tests.",
               detector_samples=detector_cases)
(root / "docs/edge-emotion/pc-reference.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
print(json.dumps({key: value for key, value in summary.items() if key != "detector_samples"}, indent=2))
