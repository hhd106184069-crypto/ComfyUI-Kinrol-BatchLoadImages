import os
import re
import folder_paths
import node_helpers
from pathlib import Path
from PIL import Image, ImageOps, ImageSequence
import numpy as np
import torch
import hashlib
import time

# ========== 批量加载节点（合并 GitHub 新功能 + 掉线修复） ==========
class KinrolBatchLoadImages:
    """批量加载图片节点，支持逐张入队、选择图片、追加图片、选择文件夹、清空列表等功能。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_list": ("STRING", {"multiline": True, "default": ""}),
                "max_images": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "mode": (["batch", "single"], {"default": "batch"}),
                "index": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "max_rows": ("INT", {"default": 5, "min": 1, "max": 20, "step": 1}),
                "thumb_size": ("INT", {"default": 120, "min": 80, "max": 300, "step": 1}),
            }
        }

    CATEGORY = "Kinrol/Batch"
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "filenames")
    FUNCTION = "load_images"

    def load_images(self, image_list: str, max_images: int, mode: str, index: int, max_rows: int, thumb_size: int):
        names = [x.strip() for x in (image_list or "").splitlines()]
        names = [x for x in names if x]
        if max_images > 0:
            names = names[:max_images]
        if mode == "single":
            if index < 0: index = 0
            if index >= len(names): index = len(names) - 1
            names = [names[index]] if names else []

        if not names:
            raise ValueError("image_list is empty")

        output_images, output_names = [], []
        excluded_formats = ["MPO"]
        start_time = time.time()
        max_duration = 30  # 最长处理30秒，防止卡死
        for name in names:
            if time.time() - start_time > max_duration:
                print("KinrolBatchLoadImages: 加载超时，已跳过剩余图片")
                break
            try:
                if not folder_paths.exists_annotated_filepath(name): continue
                image_path = folder_paths.get_annotated_filepath(name)
                img = node_helpers.pillow(Image.open, image_path)
                w, h = None, None
                frames = []
                for i in ImageSequence.Iterator(img):
                    i = node_helpers.pillow(ImageOps.exif_transpose, i)
                    if i.mode == "I": i = i.point(lambda p: p * (1 / 255))
                    pil_image = i.convert("RGB")
                    if len(frames) == 0:
                        w, h = pil_image.size
                    elif pil_image.size[0] != w or pil_image.size[1] != h:
                        continue
                    arr = np.array(pil_image).astype(np.float32) / 255.0
                    frames.append(torch.from_numpy(arr)[None,])
                if not frames: continue
                output_images.append(torch.cat(frames, dim=0) if len(frames) > 1 and img.format not in excluded_formats else frames[0])
                output_names.append(name)
            except Exception as e:
                print(f"KinrolBatchLoadImages: 跳过损坏图片 {name} - {str(e)}")
                continue

        if not output_images: raise ValueError("No valid images found")
        return (torch.cat(output_images, dim=0), "\n".join(output_names))

    @classmethod
    def IS_CHANGED(s, image_list, max_images, mode, index, max_rows, thumb_size):
        m = hashlib.sha256()
        names = [x.strip() for x in (image_list or "").splitlines()]
        names = [x for x in names if x]
        if max_images > 0: names = names[:max_images]
        if mode == "single":
            if index < 0: index = 0
            if index >= len(names): index = len(names) - 1
            names = names[:1] if names else [names[index]]
        if not names: return m.digest().hex()
        m.update(mode.encode()); m.update(str(index).encode()); m.update(str(max_images).encode()); m.update(str(max_rows).encode()); m.update(str(thumb_size).encode())
        for name in names:
            m.update(name.encode())
            if folder_paths.exists_annotated_filepath(name):
                image_path = folder_paths.get_annotated_filepath(name)
                if os.path.isfile(image_path):
                    with open(image_path, "rb") as f: m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, image_list, max_images, mode, index, max_rows, thumb_size):
        names = [x.strip() for x in (image_list or "").splitlines()]
        names = [x for x in names if x]
        if max_images > 0: names = names[:max_images]
        if mode == "single":
            if not names: return "image_list is empty"
            if index < 0: return "index must be >= 0"
            if index >= len(names): return f"index out of range (0..{len(names)-1})"
        if not names: return "image_list is empty"
        if not any(folder_paths.exists_annotated_filepath(name) for name in names):
            return "No valid images in image_list"
        return True


# ========== 文本顺序保存节点（前置文字、图片同步、绝对/相对路径） ==========
class KinrolSaveTextSequential:
    """按顺序保存文本文件，用于打标；可同时保存关联图片，统一命名。"""

    ENCODINGS = ["UTF-8", "UTF-8-BOM", "GBK", "GB2312", "ASCII"]

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
                "prefix": ("STRING", {"default": "GPT"}),
                "file_extension": ("STRING", {"default": "txt"}),
                "encoding": (s.ENCODINGS, {"default": "UTF-8"}),
                "subfolder": ("STRING", {"default": "labels"}),
                "prepend_text": ("STRING", {"multiline": False, "default": ""}),
                "save_image_with_text": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "image": ("IMAGE", {"default": None}),
            }
        }

    RETURN_TYPES = ("STRING", "IMAGE")
    RETURN_NAMES = ("filepath", "image")
    FUNCTION = "save_text"
    CATEGORY = "Kinrol/Text"
    OUTPUT_NODE = True

    def save_text(self, text, prefix, file_extension, encoding, subfolder, prepend_text, save_image_with_text, image=None):
        ext = file_extension.strip().lstrip(".")
        if not ext: ext = "txt"

        output_root = Path(folder_paths.get_output_directory())
        sub_path = Path(subfolder)
        if sub_path.is_absolute():
            output_dir = sub_path
        else:
            output_dir = output_root / sub_path
        output_dir.mkdir(parents=True, exist_ok=True)

        # 查找最大序号
        pattern = re.compile(rf"^{re.escape(prefix)}_(\d+)\.{re.escape(ext)}$")
        max_num = 0
        if output_dir.exists():
            for f in output_dir.iterdir():
                if f.is_file():
                    m = pattern.match(f.name)
                    if m:
                        num = int(m.group(1))
                        if num > max_num:
                            max_num = num

        next_num = max_num + 1
        num_str = f"{next_num:02d}" if next_num <= 99 else str(next_num)

        # 合并前置文字与正文
        full_text = (prepend_text or "") + text

        filename = f"{prefix}_{num_str}.{ext}"
        filepath = output_dir / filename
        with open(filepath, "w", encoding=encoding) as f:
            f.write(full_text)

        # 保存图片（如果开关打开且有图片输入）
        saved_image = image
        if save_image_with_text and image is not None:
            from torchvision.transforms.functional import to_pil_image
            img_tensor = image[0].cpu()
            pil_img = to_pil_image(img_tensor.permute(2, 0, 1))
            img_filename = f"{prefix}_{num_str}.png"
            img_path = output_dir / img_filename
            pil_img.save(img_path, "PNG")

        return (str(filepath.absolute()), image)