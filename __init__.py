from .nodes import KinrolBatchLoadImages, KinrolSaveTextSequential

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "KinrolBatchLoadImages": KinrolBatchLoadImages,
    "KinrolSaveTextSequential": KinrolSaveTextSequential,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KinrolBatchLoadImages": "Kinrol Batch Load Images",
    "KinrolSaveTextSequential": "Kinrol Save Text Sequential",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]