"""Shrinks the product photos for the UI preview.

Called by preview/build-fixtures.mjs; not used by the app itself.

    python preview/tools/resize_photos.py <source-dir> <target-dir>

Every file in the source directory is named "<image_id>.src" and holds the original PNG or JPEG.
The target directory gets "<image_id>.jpg", at most 640px on the long edge.
"""

import os
import sys

try:
    from PIL import Image
except ImportError:                     # build-fixtures falls back to drawn placeholders
    sys.exit(2)

MAX_EDGE = 640
QUALITY = 82


def main(source, target):
    os.makedirs(target, exist_ok=True)
    converted = 0
    for name in os.listdir(source):
        stem, extension = os.path.splitext(name)
        if extension.lower() != ".src":
            continue
        try:
            with Image.open(os.path.join(source, name)) as image:
                image.load()
                if image.mode not in ("RGB", "L"):
                    image = image.convert("RGB")
                image.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
                image.save(os.path.join(target, f"{stem}.jpg"), "JPEG", quality=QUALITY, optimize=True)
                converted += 1
        except Exception as error:      # a broken photo must not stop the whole build
            print(f"skipped {name}: {error}", file=sys.stderr)
    print(f"converted {converted} photos")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
