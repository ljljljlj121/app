"""Download and verify the mobile model bundle from a GitHub Release."""
import hashlib
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "android_app/docs/unified-emotion/release-models.json"


def sha256(path):
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def main():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    archive = ROOT / "android_app" / "delivery" / manifest["asset"]
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists() or sha256(archive) != manifest["sha256"]:
        print(f"Downloading {manifest['url']}")
        urllib.request.urlretrieve(manifest["url"], archive)
    if sha256(archive) != manifest["sha256"]:
        raise SystemExit("Model bundle SHA-256 mismatch")
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None:
            raise SystemExit("Model bundle is corrupt")
        for row in manifest["files"]:
            target = ROOT / "android_app" / "modules" / "edge-emotion" / "android" / "src" / "main" / "assets" / Path(row["path"]).relative_to("modules/edge-emotion/android/src/main/assets")
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(row["path"]) as source, target.open("wb") as dest:
                dest.write(source.read())
            if target.stat().st_size != row["bytes"] or sha256(target) != row["sha256"]:
                raise SystemExit(f"Model file verification failed: {row['path']}")
            print(f"OK {row['path']} ({row['bytes']} bytes)")


if __name__ == "__main__":
    main()
