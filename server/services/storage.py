import json
import threading
import time
from datetime import datetime
from pathlib import Path
from config import DATA_DIR, LOCK_TTL,INVALID_BACKUP_DIR
from typing import Any, Dict, List, Optional, Tuple
import shutil
import secrets
# 样本复核锁: {sample_id: {"board_id": str, "expires": float}}
_sample_locks: Dict[str, Dict[str, Any]] = {}
_locks_mutex = threading.Lock()


def next_folder() -> Path:
    """生成下一个递增样本目录"""
    existing = list(DATA_DIR.glob("data_emo_*"))
    idx = max([int(p.name.rsplit("_", 1)[-1]) for p in existing], default=0) + 1
    folder = DATA_DIR / f"data_emo_{idx:06d}"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def save_report(folder: Path, report_data: dict) -> None:
    """写入或更新样本的 report.json"""
    rp = folder / "report.json"
    rp.write_text(json.dumps(report_data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_report(sample_id: str) -> Optional[dict]:
    """读取指定样本的 report.json"""
    rp = DATA_DIR / sample_id / "report.json"
    if not rp.exists():
        return None
    try:
        return json.loads(rp.read_text(encoding="utf-8"))
    except Exception:
        return None


def get_all_reports() -> List[dict]:
    """遍历拉取全部样本报告"""
    samples = []
    for folder in sorted(DATA_DIR.glob("data_emo_*")):
        rp = folder / "report.json"
        if rp.exists():
            try:
                samples.append(json.loads(rp.read_text(encoding="utf-8")))
            except Exception:
                pass
    return samples


# ── 锁机制管理 ──

def _cleanup_locks_unlocked():
    now = time.time()
    expired = [k for k, v in _sample_locks.items() if v["expires"] < now]
    for k in expired:
        del _sample_locks[k]


def try_lock_sample(sample_id: str, board_id: str) -> Tuple[bool, str]:
    with _locks_mutex:
        _cleanup_locks_unlocked()
        existing = _sample_locks.get(sample_id)
        if existing and existing["board_id"] != board_id:
            return False, f"已被 {existing['board_id']} 锁定"
        _sample_locks[sample_id] = {"board_id": board_id, "expires": time.time() + LOCK_TTL}
        return True, ""


def release_lock_sample(sample_id: str, board_id: str) -> None:
    with _locks_mutex:
        existing = _sample_locks.get(sample_id)
        if existing and existing["board_id"] == board_id:
            del _sample_locks[sample_id]
def _backup_invalid_folder(folder: Path, reason: str = "invalid") -> None:
    """将异常样本移动到备份目录，目录命名格式为 invalid_emo_000001"""
    existing_backups = list(INVALID_BACKUP_DIR.glob("invalid_emo_*"))
    idx = max([int(p.name.rsplit("_", 1)[-1]) for p in existing_backups], default=0) + 1
    dest = INVALID_BACKUP_DIR / f"invalid_emo_{idx:06d}"
    
    # 记录剔除原因至该样本的 report.json
    rp = folder / "report.json"
    if rp.exists():
        try:
            data = json.loads(rp.read_text(encoding="utf-8"))
            data["drop_reason"] = reason
            data["original_id"] = folder.name
            rp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
            
    shutil.move(str(folder), str(dest))


def reindex_all_samples() -> dict:
    """
    1. 扫描所有样本：
       - 任一人或初始标记为 is_invalid=True 的样本备份移出
       - 只要存在多个标注（例如采集初始1次+复核多次）且标注结果不一致（出现分歧），备份移出
    2. 备份至 INVALID_BACKUP_DIR，递增命名 invalid_emo_000001 起
    3. 剩余完全一致的有效样本按升序重新编号为 data_emo_000001 到 data_emo_N
    """
    with _locks_mutex:
        existing = []
        for p in DATA_DIR.glob("data_emo_*"):
            if p.is_dir():
                try:
                    num = int(p.name.rsplit("_", 1)[-1])
                    existing.append((num, p))
                except ValueError:
                    continue

        if not existing:
            return {"total": 0, "deleted": 0}

        valid_folders = []
        deleted_count = 0

        for num, folder in existing:
            rp_file = folder / "report.json"
            should_remove = False
            drop_reason = ""

            if not rp_file.exists():
                should_remove = True
                drop_reason = "missing_report_json"
            else:
                try:
                    data = json.loads(rp_file.read_text(encoding="utf-8"))
                    
                    # 1. 检查是否存在无效标记
                    if data.get("is_invalid") or any(r.get("is_invalid") for r in data.get("reviews", [])):
                        should_remove = True
                        drop_reason = "marked_as_invalid"
                    else:
                        # 2. 收集所有情绪标注（初始 + 所有复核人）
                        labels = []
                        if data.get("initial_emotion"):
                            labels.append(data.get("initial_emotion"))
                        for r in data.get("reviews", []):
                            if r.get("emotion"):
                                labels.append(r.get("emotion"))

                        # 标注数量 >= 2 且出现标签不一致，直接判定冲突移出
                        if len(labels) >= 2 and len(set(labels)) > 1:
                            should_remove = True
                            drop_reason = f"label_conflict: {labels}"
                except Exception as e:
                    should_remove = True
                    drop_reason = f"parse_error: {e}"

            if should_remove:
                try:
                    _backup_invalid_folder(folder, reason=drop_reason)
                    deleted_count += 1
                except Exception as e:
                    print(f"备份移出样本失败 {folder.name}: {e}")
            else:
                valid_folders.append((num, folder))

        if not valid_folders:
            _sample_locks.clear()
            return {"total": 0, "deleted": deleted_count}

        valid_folders.sort(key=lambda x: x[0])

        # 第一阶段：加上临时前缀避免文件名覆盖
        temp_paths = []
        for i, (_, folder) in enumerate(valid_folders):
            tmp_name = DATA_DIR / f"_tmp_reindex_{i}_{secrets.token_hex(4)}"
            folder.rename(tmp_name)
            temp_paths.append(tmp_name)

        # 第二阶段：重命名为规范升序连续编号，并刷新内部 report.json
        for idx, tmp_folder in enumerate(temp_paths, start=1):
            target_name = f"data_emo_{idx:06d}"
            target_folder = DATA_DIR / target_name
            tmp_folder.rename(target_folder)

            rp = target_folder / "report.json"
            if rp.exists():
                try:
                    data = json.loads(rp.read_text(encoding="utf-8"))
                    data["id"] = target_name
                    data["folder_path"] = str(target_folder)
                    rp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                except Exception:
                    pass

        _sample_locks.clear()
        return {"total": len(temp_paths), "deleted": deleted_count}