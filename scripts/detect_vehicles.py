"""Offline vehicle-detection check for the camera feasibility study.

Runs facebook/detr-resnet-50 (the same model Cloudflare Workers AI hosts as
@cf/facebook/detr-resnet-50) and, for comparison, YOLOv8n over the frames saved
by discover-cameras.mjs. Writes feasibility/detections.json and two contact
sheets (raw + annotated).

This is a development tool for GitHub Actions; the production app calls
Workers AI instead.
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "feasibility"
VEHICLES = {"car", "truck", "bus", "motorcycle"}
MIN_SCORE = 0.3


def load_detr():
    import torch
    from transformers import DetrForObjectDetection, DetrImageProcessor

    processor = DetrImageProcessor.from_pretrained("facebook/detr-resnet-50", revision="no_timm")
    model = DetrForObjectDetection.from_pretrained("facebook/detr-resnet-50", revision="no_timm").eval()

    def run(img):
        inputs = processor(images=img, return_tensors="pt")
        with torch.no_grad():
            outputs = model(**inputs)
        target = torch.tensor([img.size[::-1]])
        res = processor.post_process_object_detection(outputs, target_sizes=target, threshold=MIN_SCORE)[0]
        dets = []
        for score, label, box in zip(res["scores"], res["labels"], res["boxes"]):
            x0, y0, x1, y1 = [round(float(v), 1) for v in box]
            dets.append({"label": model.config.id2label[int(label)], "score": round(float(score), 3),
                         "box": {"xmin": x0, "ymin": y0, "xmax": x1, "ymax": y1}})
        return dets

    return run


def load_yolo():
    try:
        from ultralytics import YOLO
    except ImportError:
        return None
    model = YOLO("yolov8n.pt")

    def run(img):
        r = model.predict(img, conf=MIN_SCORE, verbose=False, imgsz=640)[0]
        dets = []
        for b in r.boxes:
            x0, y0, x1, y1 = [round(float(v), 1) for v in b.xyxy[0]]
            dets.append({"label": r.names[int(b.cls)], "score": round(float(b.conf), 3),
                         "box": {"xmin": x0, "ymin": y0, "xmax": x1, "ymax": y1}})
        return dets

    return run


def caption_font():
    for path in ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if Path(path).exists():
            return ImageFont.truetype(path, 12)
    return ImageFont.load_default()


def draw_boxes(img, dets, color):
    d = ImageDraw.Draw(img)
    for det in dets:
        if det["label"] not in VEHICLES or det["score"] < 0.5:
            continue
        b = det["box"]
        d.rectangle([b["xmin"], b["ymin"], b["xmax"], b["ymax"]], outline=color, width=2)


def contact_sheet(cards, path, cols=4):
    if not cards:
        return
    w, h, cap = 352, 240, 34
    rows = (len(cards) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (w + 6) + 6, rows * (h + cap + 6) + 6), (17, 17, 17))
    font = caption_font()
    d = ImageDraw.Draw(sheet)
    for i, (img, line1, line2) in enumerate(cards):
        x = 6 + (i % cols) * (w + 6)
        y = 6 + (i // cols) * (h + cap + 6)
        sheet.paste(img.resize((w, h)), (x, y))
        d.text((x + 2, y + h + 2), line1, fill=(255, 255, 255), font=font)
        d.text((x + 2, y + h + 17), line2, fill=(170, 170, 170), font=font)
    sheet.save(path, quality=85)


def main():
    report = json.loads((OUT / "discovery.json").read_text())
    detr = load_detr()
    yolo = load_yolo()
    results = {}
    raw_cards, ann_cards = [], []

    cams = report["nearby"] + report["context"]
    for idx, cam in enumerate(cams):
        frames = [f for f in cam["frames"] if f.get("file")]
        per_frame = []
        for f in frames:
            img = Image.open(OUT / f["file"]).convert("RGB")
            entry = {"n": f["n"], "file": f["file"], "detr": detr(img)}
            if yolo:
                entry["yolo"] = yolo(img)
            per_frame.append(entry)
        results[cam["id"]] = {"name": cam["name"], "distanceMi": cam["distanceMi"], "frames": per_frame}

        tag = f"#{idx + 1} {cam['distanceMi']:.2f} mi  {cam['name']}"[:52]
        if not frames:
            blank = Image.new("RGB", (352, 240), (60, 20, 20))
            ImageDraw.Draw(blank).text((120, 110), "NO FRAME", fill=(255, 255, 255))
            raw_cards.append((blank, tag, cam["id"]))
            ann_cards.append((blank, tag, cam["id"]))
            continue
        first = Image.open(OUT / frames[0]["file"]).convert("RGB")
        raw_cards.append((first, tag, f"{cam['id'][:8]}  {cam['distinctFrames']}/{cam['fetchedOk']} distinct"))
        ann = first.copy()
        if yolo:
            draw_boxes(ann, per_frame[0].get("yolo", []), (0, 170, 255))
        draw_boxes(ann, per_frame[0]["detr"], (0, 255, 120))
        nveh = sum(1 for d in per_frame[0]["detr"] if d["label"] in VEHICLES and d["score"] >= 0.5)
        nyolo = sum(1 for d in per_frame[0].get("yolo", []) if d["label"] in VEHICLES and d["score"] >= 0.5)
        ann_cards.append((ann, tag, f"DETR(green) {nveh} veh  YOLOv8n(blue) {nyolo} veh"))
        if cam in report["nearby"]:
            (OUT / "annotated").mkdir(exist_ok=True)
            ann.save(OUT / "annotated" / f"{cam['id']}.jpg", quality=90)
        print(f"{cam['distanceMi']:.3f} mi  DETR {nveh:2d}  YOLO {nyolo:2d}  {cam['name']}", flush=True)

    (OUT / "detections.json").write_text(json.dumps(results, indent=1))
    contact_sheet(raw_cards, OUT / "contact-sheet.jpg")
    contact_sheet(ann_cards, OUT / "contact-sheet-annotated.jpg")


if __name__ == "__main__":
    sys.exit(main())
