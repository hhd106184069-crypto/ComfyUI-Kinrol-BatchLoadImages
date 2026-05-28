# nodes.py
import os
import hashlib
import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence
import folder_paths
import node_helpers

class KinrolBatchLoadImages:
    """
    批量加载图片节点，支持逐张入队、选择图片、追加图片、选择文件夹、清空列表等功能。
    图片列表通过前端UI管理，后端负责加载和输出图片。
    """
    
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_list": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                    },
                ),
                "max_images": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "mode": (["batch", "single"], {"default": "batch"}),
                "index": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                # 新增：控制前端预览网格的最大行数
                "max_rows": ("INT", {"default": 5, "min": 1, "max": 20, "step": 1}),
                # 前端缩略图尺寸持久化字段，由自定义 UI 读写
                "thumb_size": ("INT", {"default": 120, "min": 40, "max": 300, "step": 1}),
            }
        }

    CATEGORY = "Kinrol/Batch"
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "filenames")
    FUNCTION = "load_images"

    def load_images(self, image_list: str, max_images: int, mode: str, index: int, max_rows: int, thumb_size: int):
        """
        加载图片列表中的图片。
        - mode="batch": 加载所有图片并作为批次返回。
        - mode="single": 加载指定索引的单张图片。
        """
        names = [x.strip() for x in (image_list or "").splitlines()]
        names = [x for x in names if x]

        if max_images and max_images > 0:
            names = names[:max_images]

        if mode == "single":
            if index < 0:
                index = 0
            if index >= len(names):
                index = len(names) - 1
            names = [names[index]] if len(names) > 0 else []

        if len(names) == 0:
            raise ValueError("image_list is empty")

        output_images = []
        output_names = []
        excluded_formats = ["MPO"]

        for name in names:
            if not folder_paths.exists_annotated_filepath(name):
                continue
            image_path = folder_paths.get_annotated_filepath(name)
            img = node_helpers.pillow(Image.open, image_path)
            
            w, h = None, None
            frames = []
            for i in ImageSequence.Iterator(img):
                i = node_helpers.pillow(ImageOps.exif_transpose, i)
                if i.mode == "I":
                    i = i.point(lambda p: p * (1 / 255))
                pil_image = i.convert("RGB")

                if len(frames) == 0:
                    w = pil_image.size[0]
                    h = pil_image.size[1]
                elif pil_image.size[0] != w or pil_image.size[1] != h:
                    continue

                arr = np.array(pil_image).astype(np.float32) / 255.0
                tensor = torch.from_numpy(arr)[None,]
                frames.append(tensor)

            if len(frames) == 0:
                continue

            if len(frames) > 1 and img.format not in excluded_formats:
                image_tensor = torch.cat(frames, dim=0)
            else:
                image_tensor = frames[0]

            output_images.append(image_tensor)
            output_names.append(name)

        if len(output_images) == 0:
            raise ValueError("No valid images found")

        output_image = torch.cat(output_images, dim=0)
        return (output_image, "\n".join(output_names))

    @classmethod
    def IS_CHANGED(s, image_list: str, max_images: int, mode: str, index: int, max_rows: int, thumb_size: int):
        m = hashlib.sha256()
        names = [x.strip() for x in (image_list or "").splitlines()]
        names = [x for x in names if x]

        if max_images and max_images > 0:
            names = names[:max_images]

        if mode == "single":
            if index < 0:
                index = 0
            if index >= len(names):
                index = len(names) - 1
            names = names[:1] if len(names) == 0 else [names[index]]

        if len(names) == 0:
            return m.digest().hex()

        m.update(str(mode).encode("utf-8"))
        m.update(str(index).encode("utf-8"))
        m.update(str(max_images).encode("utf-8"))
        m.update(str(max_rows).encode("utf-8"))  # 纳入哈希计算
        m.update(str(thumb_size).encode("utf-8"))
        for name in names:
            m.update(name.encode("utf-8"))
            if folder_paths.exists_annotated_filepath(name):
                image_path = folder_paths.get_annotated_filepath(name)
                if os.path.isfile(image_path):
                    with open(image_path, "rb") as f:
                        m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, image_list: str, max_images: int, mode: str, index: int, max_rows: int, thumb_size: int):
        names = [x.strip() for x in (image_list or "").splitlines()]
        names = [x for x in names if x]

        if max_images and max_images > 0:
            names = names[:max_images]

        if mode == "single":
            if len(names) == 0:
                return "image_list is empty"
            if index < 0:
                return "index must be >= 0"
            if index >= len(names):
                return f"index out of range (0..{len(names)-1})"

        if len(names) == 0:
            return "image_list is empty"

        valid = False
        for name in names:
            if folder_paths.exists_annotated_filepath(name):
                valid = True
                break
        if not valid:
            return "No valid images in image_list"
        return True
