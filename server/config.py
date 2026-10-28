import os
from pathlib import Path

INVALID_BACKUP_DIR = Path("/data2/lzh/data_collection/server/data_invalid")
INVALID_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR = Path("data_emo")
DATA_DIR.mkdir(exist_ok=True)

PASSWORD = os.getenv("SERVER_PASSWORD", "xzy123456!")
LOCK_TTL = 120  # 样本锁过期时间（秒）

EMOTIONS = {"happy", "sad", "angry", "fear", "disgust", "surprise", "neutral"}