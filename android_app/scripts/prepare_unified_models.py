"""Fetch pinned Android assets and verify real bytes, never accept an LFS pointer.

Standard library only. Existing correct files are kept. Local text weights are
copied from the authorized evaluated export, not from a pretrained base model.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "docs/unified-emotion/model-lock.json"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text-project", type=Path, default=Path(r"F:\边端\edge_image_text_emotion"))
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    for row in lock["files"]:
        target = ROOT / row["path"]
        if not target.exists() or digest(target) != row["sha256"]:
            if args.verify_only:
                raise ValueError(f'Missing or incorrect file: {row["path"]}')
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".partial")
            try:
                if "url" in row:
                    with urllib.request.urlopen(row["url"], timeout=90) as source, temporary.open("wb") as dest:
                        shutil.copyfileobj(source, dest)
                else:
                    shutil.copyfile(args.text_project / row["text_project_path"], temporary)
                assert temporary.stat().st_size == row["bytes"], f'Incorrect size: {row["path"]}'
                assert digest(temporary) == row["sha256"], f'Incorrect hash: {row["path"]}'
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        with target.open("rb") as stream:
            assert not stream.read(160).startswith(b"version https://git-lfs.github.com/spec/"), target
        assert target.stat().st_size == row["bytes"], target
        print(f'OK {row["path"]} ({row["bytes"]} bytes)')


if __name__ == "__main__":
    main()
