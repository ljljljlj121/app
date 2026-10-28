from datetime import datetime
from flask import Blueprint, jsonify, request

from config import DATA_DIR, EMOTIONS
from services.auth import require_token
from services.storage import (
    get_all_reports,
    load_report,
    save_report,
    try_lock_sample,
    release_lock_sample,
)

review_bp = Blueprint("review", __name__)


@review_bp.route("/api/samples", methods=["GET"])
@require_token
def list_samples():
    samples = get_all_reports()
    return jsonify(samples)


@review_bp.route("/api/samples/<sample_id>", methods=["GET"])
@require_token
def get_sample(sample_id: str):
    report = load_report(sample_id)
    if not report:
        return jsonify({"ok": False, "msg": "样本不存在"}), 404
    return jsonify(report)


@review_bp.route("/api/samples/<sample_id>/lock", methods=["POST"])
@require_token
def lock_sample(sample_id: str):
    report = load_report(sample_id)
    if not report:
        return jsonify({"ok": False, "msg": "样本不存在"}), 404

    board_id = (request.json or {}).get("board_id", "unknown")
    ok, err_msg = try_lock_sample(sample_id, board_id)
    if not ok:
        return jsonify({"ok": False, "msg": err_msg}), 409
    return jsonify({"ok": True})


@review_bp.route("/api/samples/<sample_id>/unlock", methods=["POST"])
@require_token
def unlock_sample(sample_id: str):
    board_id = (request.json or {}).get("board_id", "unknown")
    release_lock_sample(sample_id, board_id)
    return jsonify({"ok": True})


@review_bp.route("/api/samples/<sample_id>/review", methods=["POST"])
@require_token
def submit_review(sample_id: str):
    folder = DATA_DIR / sample_id
    report = load_report(sample_id)
    if not report:
        return jsonify({"ok": False, "msg": "样本不存在"}), 404

    data = request.json or {}
    emotion = data.get("review_emotion")
    is_invalid = bool(data.get("is_invalid", False))
    board_id = data.get("board_id", "unknown")

    if not is_invalid and emotion and emotion not in EMOTIONS:
        return jsonify({"ok": False, "msg": "非法情绪标签"}), 400

    reviews = report.get("reviews", [])
    reviews.append({
        "reviewer": board_id,
        "emotion": None if is_invalid else emotion,
        "is_invalid": is_invalid,
        "time": datetime.now().isoformat(timespec="seconds"),
    })
    
    report["reviews"] = reviews
    report["review_count"] = len(reviews)
    report["review_emotion"] = None if is_invalid else emotion
    report["is_invalid"] = is_invalid
    report["is_reviewed"] = True if (report["review_count"] >= 2 or is_invalid) else False

    save_report(folder, report)
    release_lock_sample(sample_id, board_id)

    return jsonify({
        "ok": True,
        "review_count": report["review_count"],
        "is_reviewed": report["is_reviewed"],
    })