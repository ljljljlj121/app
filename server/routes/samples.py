from datetime import datetime
from pathlib import Path
from flask import Blueprint, jsonify, request, send_from_directory

from config import DATA_DIR, EMOTIONS
from services.auth import require_token
from services.storage import next_folder, save_report, load_report, reindex_all_samples

samples_bp = Blueprint("samples", __name__)

@samples_bp.route("/api/samples/reindex", methods=["POST"])
@require_token
def api_reindex_samples():
    """清理无效样本并重新紧凑编号"""
    try:
        result = reindex_all_samples()
        total = result.get("total", 0)
        deleted = result.get("deleted", 0)
        msg = f"已清理 {deleted} 条无效数据，剩余 {total} 条有效样本已重排为 000001~{total:06d}"
        return jsonify({
            "ok": True,
            "count": total,
            "deleted": deleted,
            "msg": msg
        })
    except Exception as e:
        return jsonify({"ok": False, "msg": f"重排失败: {e}"}), 500
@samples_bp.route("/api/upload_sample", methods=["POST"])
@require_token
def upload_sample():
    folder = next_folder()
    saved = []
    
    single = request.files.get("file")
    if single:
        dest = folder / "merged.mp4"
        single.save(str(dest))
        saved.append("merged")
    else:
        for field in ("audio", "video", "merged"):
            f = request.files.get(field)
            if f:
                ext = ".wav" if field == "audio" else ".mp4"
                dest = folder / (field + ext)
                f.save(str(dest))
                saved.append(field)

    board_id = request.form.get("board_id", "unknown")
    has_audio = request.form.get("has_audio", "false").lower() in ("true", "1")
    report = {
        "id": folder.name,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "folder_path": str(folder),
        "board_id": board_id,
        "has_audio": has_audio,  # <-- 写入是否带声音
        "initial_emotion": request.form.get("emotion", None),
        "model_emotion": None,
        "review_emotion": None,
        "review_count": 0,
        "reviews": [],
        "is_invalid": False,
        "is_reviewed": False,
    }
    save_report(folder, report)
    return jsonify({"ok": True, "id": folder.name, "saved": saved})


@samples_bp.route("/api/upload_sample/<sample_id>/emotion", methods=["POST"])
@require_token
def upload_sample_emotion(sample_id: str):
    folder = DATA_DIR / sample_id
    report = load_report(sample_id)
    if not report:
        return jsonify({"ok": False, "msg": "样本不存在"}), 404

    data = request.json or {}
    emotion = data.get("emotion", "")
    is_invalid = bool(data.get("is_invalid", False))

    if not is_invalid and emotion and emotion not in EMOTIONS:
        return jsonify({"ok": False, "msg": "非法情绪标签"}), 400

    report["is_invalid"] = is_invalid
    report["initial_emotion"] = None if is_invalid else (emotion or report.get("initial_emotion"))
    save_report(folder, report)
    return jsonify({"ok": True})


@samples_bp.route("/data/<path:filename>")
@require_token
def serve_data(filename: str):
    return send_from_directory(str(DATA_DIR), filename)