"""
Create favicon from myvan.PNG with black background.
Requires: pip install Pillow
"""
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Installing Pillow...")
    import subprocess
    subprocess.check_call(["pip", "install", "Pillow"])
    from PIL import Image

BASE = Path(__file__).resolve().parent
SRC = BASE / "public" / "images" / "myvan.PNG"
OUT_ICO = BASE / "public" / "favicon.ico"
OUT_PNG = BASE / "public" / "images" / "favicon.png"

def main():
    img = Image.open(SRC).convert("RGBA")
    size = 256  # high-res base for favicon.ico
    # Black background canvas
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    # Scale image to fit inside square (letterbox)
    w, h = img.size
    scale = min(size / w, size / h)
    nw, nh = int(w * scale), int(h * scale)
    img_scaled = img.resize((nw, nh), Image.Resampling.LANCZOS)
    # Center on black background
    x = (size - nw) // 2
    y = (size - nh) // 2
    bg.paste(img_scaled, (x, y), img_scaled)
    # Save PNG (no alpha for favicon with black bg)
    out_rgb = bg.convert("RGB")
    out_rgb.save(OUT_PNG, "PNG")
    # Save .ico (Pillow will embed 16, 32, 48 from the 256 image)
    out_rgb.save(OUT_ICO, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"Saved {OUT_ICO} and {OUT_PNG}")

if __name__ == "__main__":
    main()
