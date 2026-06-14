// web/kinrol_batch_load_images.js
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// ===================== 工具函数 =====================
function getImageListWidget(node) { return node?.widgets?.find(w => w.name === "image_list"); }
function getMaxRowsWidget(node) { return node?.widgets?.find(w => w.name === "max_rows"); }
function getThumbSizeWidget(node) { return node?.widgets?.find(w => w.name === "thumb_size"); }
function parseImageList(value) { return (value || "").split(/[\n,;]+/).map(s => s.trim()).filter(s => s.length > 0); }
function setImageList(node, names) {
    const w = getImageListWidget(node);
    if (!w) return;
    w.value = names.join("\n");
    w.callback?.(w.value);
}
function getViewUrl(filename) {
    return `/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=&width=150`;
}

// ===================== 全局拖拽（文件上传） =====================
function isFilesDragEvent(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    return Array.from(dt.types || []).includes("Files");
}
const _batchLoadImagesDomUIs = new Set();
function _setDraggingUI(activeEntry) { for (const entry of _batchLoadImagesDomUIs) entry?.setDragging?.(entry === activeEntry); }
let _globalDragDropInstalled = false;
function ensureGlobalDragDropPrevention() {
    if (_globalDragDropInstalled) return;
    _globalDragDropInstalled = true;
    window.addEventListener("dragover", e => {
        if (!isFilesDragEvent(e)) return;
        const hit = [..._batchLoadImagesDomUIs].find(entry => entry?.container?.contains(e.target));
        if (hit) {
            e.preventDefault();
            _setDraggingUI(hit);
        } else {
            _setDraggingUI(null);
        }
    }, { capture: true });
    window.addEventListener("drop", async e => {
        if (!isFilesDragEvent(e)) return;
        const hit = [..._batchLoadImagesDomUIs].find(entry => entry?.container?.contains(e.target));
        _setDraggingUI(null);
        if (hit) {
            e.preventDefault();
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length) await uploadFilesSequential(hit.node, files, { replace: false });
        }
    }, { capture: true });
    window.addEventListener("dragleave", () => _setDraggingUI(null), { capture: true });
}

// ===================== 图片上传 =====================
async function uploadOneImage(file) {
    const body = new FormData();
    body.append("image", file, file.name);
    body.append("type", "input");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!resp.ok) throw new Error(await resp.text());
    const json = await resp.json();
    return json?.name;
}
async function uploadFilesSequential(node, files, { replace = false } = {}) {
    const w = getImageListWidget(node);
    if (!w) return [];
    const existing = replace ? [] : parseImageList(w.value);
    const uploaded = [];
    const ui = node._kinrolBatchLoadImagesUI;
    if (ui) ui.setStatus(`正在上传 0/${files.length} ...`);
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file || (file.type && !file.type.startsWith("image/"))) continue;
        const name = await uploadOneImage(file);
        if (name) uploaded.push(name);
        if (ui) ui.setStatus(`正在上传 ${i + 1}/${files.length} ...`);
    }
    const merged = existing.concat(uploaded);
    setImageList(node, merged);
    if (ui) ui.setStatus("");
    return uploaded;
}

// ===================== 文件选择 =====================
function openMultiSelect(node, { replace = false } = {}) {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file"; input.accept = "image/png,image/jpeg,image/webp"; input.multiple = true; input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async e => {
            try { const files = Array.from(e.target.files || []); await uploadFilesSequential(node, files, { replace }); resolve(); }
            catch (err) { console.error(err); }
            finally { document.body.removeChild(input); }
        };
        input.click();
    });
}
function openFolderSelect(node, { replace = false } = {}) {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file"; input.accept = "image/png,image/jpeg,image/webp"; input.multiple = true;
        input.webkitdirectory = true; input.directory = true; input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async e => {
            try {
                let files = Array.from(e.target.files || []);
                const allowExt = new Set([".png", ".jpg", ".jpeg", ".webp"]);
                files = files.filter(f => allowExt.has((f?.name || "").toLowerCase().slice(-4)) || allowExt.has((f?.name || "").toLowerCase().slice(-5)));
                files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
                await uploadFilesSequential(node, files, { replace });
                resolve();
            } catch (err) { console.error(err); }
            finally { document.body.removeChild(input); }
        };
        input.click();
    });
}

// ===================== 队列操作 =====================
async function queueAllSequential(node) {
    const w = getImageListWidget(node);
    if (!w) return;
    const names = parseImageList(w.value);
    if (names.length === 0) { alert("没有图片可以入队"); return; }
    const modeWidget = node.widgets?.find(w => w.name === "mode");
    const indexWidget = node.widgets?.find(w => w.name === "index");
    if (modeWidget) { modeWidget.value = "single"; modeWidget.callback?.("single"); }
    for (let i = 0; i < names.length; i++) {
        if (indexWidget) { indexWidget.value = i; indexWidget.callback?.(i); }
        await app.queuePrompt();
    }
}

// ===================== 批量加载节点 UI =====================
function createBatchLoadUI(node) {
    let selectedFiles = new Set();
    let copiedFiles = [];

    const container = document.createElement("div");
    container.tabIndex = 0;
    container.style.cssText = `width:100%; padding:8px; background:var(--comfy-menu-bg); border:1px solid var(--border-color); border-radius:6px; margin:5px 0; pointer-events:auto; display:flex; flex-direction:column; outline:none;`;

    const thumbSizeWidget = getThumbSizeWidget(node);
    let currentThumbSize = thumbSizeWidget ? (parseInt(thumbSizeWidget.value) || 120) : 120;

    // 按钮布局
    const btnGrid = document.createElement("div");
    btnGrid.style.cssText = "display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; margin-bottom:8px;";
    const mkBtn = (label) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = "padding:6px 4px; background:var(--comfy-input-bg); color:var(--input-text); border:1px solid var(--border-color); border-radius:4px; cursor:pointer; font-size:12px; white-space:nowrap;";
        return b;
    };
    const replaceBtn = mkBtn("选择图片");
    const addBtn = mkBtn("追加图片");
    const folderBtn = mkBtn("选择文件夹");
    const queueAllBtn = mkBtn("逐张入队");
    const queueSelectedBtn = mkBtn("入队选中");
    const selectAllBtn = mkBtn("全选");
    const deselectBtn = mkBtn("取消选中");
    const invertSelBtn = mkBtn("反选");
    const deleteSelectedBtn = mkBtn("删除选中");
    const clearBtn = mkBtn("清空");
    const moveUpBtn = mkBtn("↑");
    const moveDownBtn = mkBtn("↓");
    btnGrid.append(replaceBtn, addBtn, folderBtn, queueAllBtn);
    btnGrid.append(queueSelectedBtn, deleteSelectedBtn, selectAllBtn, invertSelBtn);
    btnGrid.append(deselectBtn, clearBtn, moveUpBtn, moveDownBtn);

    // 搜索框
    const searchRow = document.createElement("div");
    searchRow.style.cssText = "display:flex; gap:6px; margin-bottom:8px; align-items:center;";
    const searchInput = document.createElement("input");
    searchInput.type = "text"; searchInput.placeholder = "搜索文件名...";
    searchInput.style.cssText = "flex:1; padding:4px 8px; background:var(--comfy-input-bg); color:var(--input-text); border:1px solid var(--border-color); border-radius:4px; font-size:12px;";
    const searchClear = document.createElement("button");
    searchClear.textContent = "✕";
    searchClear.style.cssText = "padding:4px 8px; background:var(--comfy-input-bg); color:var(--input-text); border:1px solid var(--border-color); border-radius:4px; cursor:pointer; font-size:12px;";
    searchRow.append(searchInput, searchClear);

    const brand = document.createElement("div");
    brand.textContent = "Kinrol Batch Load Images | Ctrl+C/V 粘贴(含文件) | Del 删除 | ↑↓ | Shift+点击范围选择";
    brand.style.cssText = "font-size:10px; opacity:0.7; margin-bottom:8px; text-align:center; color:var(--input-text); flex-shrink:0;";

    const statusBar = document.createElement("div");
    statusBar.style.cssText = "font-size:12px; color:#4a6; margin-bottom:6px; min-height:1.2em; flex-shrink:0;";

    const infoRow = document.createElement("div");
    infoRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; flex-shrink:0; gap:10px; flex-wrap:wrap;";

    const info = document.createElement("div");
    info.style.cssText = "font-size:12px; opacity:0.85; flex:1;";

    const rowControl = document.createElement("div");
    rowControl.style.cssText = "display:flex; align-items:center; gap:4px; font-size:12px;";
    const rowLabel = document.createElement("span"); rowLabel.textContent = "行数:";
    const rowInput = document.createElement("input");
    rowInput.type = "number"; rowInput.min = 1; rowInput.max = 20; rowInput.step = 1;
    rowInput.style.cssText = "width:45px; background:var(--comfy-input-bg); color:var(--input-text); border:1px solid var(--border-color); border-radius:4px; padding:2px 4px; font-size:12px;";
    rowControl.append(rowLabel, rowInput);

    const sizeControl = document.createElement("div");
    sizeControl.style.cssText = "display:flex; align-items:center; gap:4px; font-size:12px;";
    const sizeLabel = document.createElement("span");
    const sizeSlider = document.createElement("input");
    sizeSlider.type = "range"; sizeSlider.min = 80; sizeSlider.max = 300; sizeSlider.value = currentThumbSize;
    sizeSlider.style.cssText = "width:70px;";
    const sizeValue = document.createElement("span");
    sizeValue.style.cssText = "min-width:40px; text-align:right;";
    sizeValue.textContent = currentThumbSize + "px";
    sizeControl.append(sizeLabel, sizeSlider, sizeValue);

    const toggleModeBtn = document.createElement("button");
    toggleModeBtn.style.cssText = "padding:4px 8px; background:var(--comfy-input-bg); color:var(--input-text); border:1px solid var(--border-color); border-radius:4px; cursor:pointer; font-size:12px; white-space:nowrap;";
    toggleModeBtn.textContent = "高度优先";

    infoRow.append(info, rowControl, sizeControl, toggleModeBtn);

    const grid = document.createElement("div");
    grid.style.cssText = `display:none; gap:12px; overflow-y:auto; background:var(--comfy-input-bg); padding:10px; border-radius:4px; flex:1 1 auto; min-height:0; user-select:none; -webkit-user-select:none;`;

    let searchTerm = "";
    let alignHeight = false;
    let redrawTimeout = null;
    let lastShiftSelectedIndex = -1;

    const syncThumbSize = (val) => {
        const numVal = parseInt(val) || 120;
        if (thumbSizeWidget) {
            thumbSizeWidget.value = numVal;
            thumbSizeWidget.callback?.(numVal);
        }
        currentThumbSize = numVal;
    };

    const applyLayoutMode = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        if (alignHeight) {
            grid.style.display = names.length ? 'flex' : 'none';
            grid.style.flexWrap = 'wrap';
            grid.style.gridTemplateColumns = '';
            sizeLabel.textContent = "高度:";
            toggleModeBtn.textContent = "宽度优先";
        } else {
            grid.style.display = names.length ? 'grid' : 'none';
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${currentThumbSize}px, 1fr))`;
            grid.style.flexWrap = '';
            sizeLabel.textContent = "大小:";
            toggleModeBtn.textContent = "高度优先";
        }
        sizeValue.textContent = currentThumbSize + "px";
        updateGridMaxHeight();
    };

    toggleModeBtn.onclick = () => {
        alignHeight = !alignHeight;
        applyLayoutMode();
        redraw();
    };

    sizeSlider.addEventListener("input", () => {
        const val = parseInt(sizeSlider.value, 10);
        sizeValue.textContent = val + "px";
        syncThumbSize(val);
        applyLayoutMode();
        redraw();
    });

    const updateInfo = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        const selectedCount = selectedFiles.size;
        const copyInfo = copiedFiles.length ? ` | 已复制 ${copiedFiles.length} 张` : "";
        info.textContent = names.length ? `已选择 ${names.length} 张${selectedCount > 0 ? ` (选中 ${selectedCount})` : ""}${copyInfo}` : "暂无图片";
    };
    const getMaxRows = () => getMaxRowsWidget(node)?.value || 5;
    const setMaxRows = val => {
        const widget = getMaxRowsWidget(node);
        if (widget) { widget.value = val; widget.callback?.(val); }
    };
    const getEstimatedRowHeight = () => {
        const thumbVal = currentThumbSize;
        const labelHeight = 30;
        return alignHeight ? thumbVal + labelHeight + 3 + 12 : thumbVal * 2 + labelHeight + 3 + 12;
    };
    const updateGridMaxHeight = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        if (!names.length) return;
        const maxRows = getMaxRows();
        const estimatedRow = getEstimatedRowHeight();
        const baseHeight = maxRows * estimatedRow;
        const containerHeight = container.clientHeight;
        if (!containerHeight) return;
        const fixedHeight = btnGrid.offsetHeight + searchRow.offsetHeight + brand.offsetHeight + statusBar.offsetHeight + infoRow.offsetHeight + 16;
        let availableHeight = containerHeight - fixedHeight;
        if (availableHeight < 100) availableHeight = 100;
        const targetHeight = Math.min(baseHeight, availableHeight);
        grid.style.maxHeight = `${targetHeight}px`;
    };
    const resizeObserver = new ResizeObserver(() => updateGridMaxHeight());
    resizeObserver.observe(container);

    const clearSelection = () => {
        selectedFiles.clear();
        grid.querySelectorAll(".kinrol-selected").forEach(el => el.classList.remove("kinrol-selected"));
        updateInfo();
    };
    const updateElementSelection = (el, filename) => {
        if (selectedFiles.has(filename)) el.classList.add("kinrol-selected");
        else el.classList.remove("kinrol-selected");
    };

    // ===================== 键盘快捷键 =====================
    container.addEventListener("keydown", async (e) => {
        if (e.ctrlKey && e.key === "c") {
            e.preventDefault(); e.stopPropagation();
            const names = parseImageList(getImageListWidget(node)?.value);
            if (selectedFiles.size > 0) copiedFiles = [...selectedFiles];
            else if (names.length > 0) copiedFiles = [...names];
            else return;
            updateInfo();
            setStatus(`已复制 ${copiedFiles.length} 张文件名`);
            return;
        }
        if (e.ctrlKey && e.key === "v") {
            e.preventDefault(); e.stopPropagation();
            try {
                const clipboardItems = await navigator.clipboard.read();
                let hasImage = false;
                for (const item of clipboardItems) {
                    const imageTypes = item.types.filter(t => t.startsWith("image/"));
                    if (imageTypes.length > 0) {
                        const blob = await item.getType(imageTypes[0]);
                        const file = new File([blob], `clipboard_${Date.now()}.png`, { type: imageTypes[0] });
                        await uploadFilesSequential(node, [file], { replace: false });
                        hasImage = true;
                    }
                }
                if (hasImage) { setStatus("已从剪贴板粘贴图片"); return; }
            } catch (err) {}
            if (copiedFiles.length === 0) { setStatus("剪贴板无图片，且无内部复制的文件名"); return; }
            const existing = parseImageList(getImageListWidget(node)?.value);
            const newFiles = copiedFiles.filter(f => !existing.includes(f));
            if (newFiles.length === 0) { setStatus("所有图片已存在列表中"); return; }
            const merged = existing.concat(newFiles);
            setImageList(node, merged);
            setStatus(`已追加 ${newFiles.length} 张图片（内部复制）`);
            return;
        }
        if (e.key === "Delete" || e.key === "Del") {
            e.preventDefault(); e.stopPropagation();
            if (selectedFiles.size === 0) { setStatus("没有选中的图片"); return; }
            const names = parseImageList(getImageListWidget(node)?.value);
            const remaining = names.filter(n => !selectedFiles.has(n));
            const deletedCount = selectedFiles.size;
            selectedFiles.clear();
            setImageList(node, remaining);
            setStatus(`已删除 ${deletedCount} 张图片`);
            return;
        }
    });

    // 全局粘贴拦截（仅当焦点在插件内）
    const handleGlobalPaste = async (e) => {
        if (!container.contains(document.activeElement)) return;
        const items = e.clipboardData?.items;
        if (items) {
            const files = [];
            for (const item of items) {
                if (item.kind === "file" && item.type.startsWith("image/")) {
                    const file = item.getAsFile();
                    if (file) files.push(file);
                }
            }
            if (files.length > 0) {
                e.preventDefault();
                await uploadFilesSequential(node, files, { replace: false });
                setStatus(`已粘贴 ${files.length} 个文件`);
                return;
            }
            let hasImage = false;
            const imageBlobs = [];
            for (const item of items) {
                if (item.type.startsWith("image/")) {
                    const blob = item.getAsFile();
                    if (blob) { imageBlobs.push(blob); hasImage = true; }
                }
            }
            if (hasImage) {
                e.preventDefault();
                await uploadFilesSequential(node, imageBlobs, { replace: false });
                setStatus("已粘贴剪贴板图片");
            }
        }
    };
    document.addEventListener("paste", handleGlobalPaste);
    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        document.removeEventListener("paste", handleGlobalPaste);
        originalOnRemoved?.apply(this, arguments);
    };

    // ===================== 事件处理：单击 / Shift+范围选择 / 框选 =====================
    const DRAG_THRESHOLD = 3;
    let selectionRect = null;
    let startX = 0, startY = 0;
    let isSelecting = false;

    const onMouseMove = (e) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!isSelecting && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
            isSelecting = true;
            selectionRect = document.createElement("div");
            selectionRect.style.cssText = `position:fixed; border:2px dashed #4a6; background:rgba(74,170,102,0.15); pointer-events:none; z-index:9999; left:${startX}px; top:${startY}px; width:0; height:0;`;
            document.body.appendChild(selectionRect);
        }
        if (isSelecting && selectionRect) {
            e.preventDefault();
            const left = Math.min(startX, e.clientX);
            const top = Math.min(startY, e.clientY);
            selectionRect.style.left = `${left}px`;
            selectionRect.style.top = `${top}px`;
            selectionRect.style.width = `${Math.abs(e.clientX - startX)}px`;
            selectionRect.style.height = `${Math.abs(e.clientY - startY)}px`;
        }
    };

    const onMouseUp = (e) => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (isSelecting && selectionRect) {
            const rect = selectionRect.getBoundingClientRect();
            const cells = grid.querySelectorAll(".kinrol-thumb-cell");
            const inside = new Set();
            cells.forEach(cell => {
                const cr = cell.getBoundingClientRect();
                if (!(rect.right < cr.left || rect.left > cr.right || rect.bottom < cr.top || rect.top > cr.bottom)) {
                    inside.add(cell.dataset.filename);
                }
            });
            if (inside.size > 0) {
                const allInside = [...inside].every(f => selectedFiles.has(f));
                if (allInside) inside.forEach(f => selectedFiles.delete(f));
                else inside.forEach(f => selectedFiles.add(f));
                cells.forEach(c => updateElementSelection(c, c.dataset.filename));
                updateInfo();
            }
            selectionRect.remove();
            selectionRect = null;
        } else if (!isSelecting) {
            const cell = e.target.closest(".kinrol-thumb-cell");
            if (cell) {
                const filename = cell.dataset.filename;
                const cellIndex = parseInt(cell.dataset.index, 10);
                if (e.shiftKey && lastShiftSelectedIndex >= 0) {
                    const names = parseImageList(getImageListWidget(node)?.value);
                    const startIdx = Math.min(lastShiftSelectedIndex, cellIndex);
                    const endIdx = Math.max(lastShiftSelectedIndex, cellIndex);
                    selectedFiles.clear();
                    for (let i = startIdx; i <= endIdx; i++) {
                        if (i < names.length) selectedFiles.add(names[i]);
                    }
                } else {
                    if (selectedFiles.has(filename)) selectedFiles.delete(filename);
                    else selectedFiles.add(filename);
                    lastShiftSelectedIndex = cellIndex;
                }
                grid.querySelectorAll(".kinrol-thumb-cell").forEach(c => updateElementSelection(c, c.dataset.filename));
                updateInfo();
            }
        }
        isSelecting = false;
    };

    grid.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest("button")) return;
        container.focus();
        e.preventDefault(); e.stopPropagation();
        startX = e.clientX; startY = e.clientY;
        isSelecting = false;
        if (selectionRect) { selectionRect.remove(); selectionRect = null; }
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
    });

    window.addEventListener("blur", () => {
        if (selectionRect) { selectionRect.remove(); selectionRect = null; }
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        isSelecting = false;
    });

    searchInput.addEventListener("input", () => {
        searchTerm = searchInput.value.toLowerCase().trim();
        redraw();
    });
    searchClear.onclick = () => {
        searchInput.value = "";
        searchTerm = "";
        redraw();
    };

    selectAllBtn.onclick = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        names.forEach(n => selectedFiles.add(n));
        grid.querySelectorAll(".kinrol-thumb-cell").forEach(c => updateElementSelection(c, c.dataset.filename));
        updateInfo();
        setStatus("已全选");
    };
    invertSelBtn.onclick = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        const newSet = new Set();
        names.forEach(n => { if (!selectedFiles.has(n)) newSet.add(n); });
        selectedFiles = newSet;
        grid.querySelectorAll(".kinrol-thumb-cell").forEach(c => updateElementSelection(c, c.dataset.filename));
        updateInfo();
        setStatus("已反选");
    };
    deselectBtn.onclick = () => {
        clearSelection();
        setStatus("已取消选中");
    };
    moveUpBtn.onclick = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        if (selectedFiles.size === 0) { setStatus("请先选中要移动的图片"); return; }
        const selectedArr = [...selectedFiles].filter(f => names.includes(f));
        if (selectedArr.length === 0) { setStatus("选中的图片不在列表中"); return; }
        const indices = selectedArr.map(f => names.indexOf(f)).filter(i => i !== -1).sort((a, b) => a - b);
        if (indices[0] === 0) { setStatus("已经在最前面，无法向前移动"); return; }
        for (const idx of indices) {
            if (idx > 0) [names[idx], names[idx - 1]] = [names[idx - 1], names[idx]];
        }
        setImageList(node, names);
        setStatus("已向前移动选中图片");
    };
    moveDownBtn.onclick = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        if (selectedFiles.size === 0) { setStatus("请先选中要移动的图片"); return; }
        const selectedArr = [...selectedFiles].filter(f => names.includes(f));
        if (selectedArr.length === 0) { setStatus("选中的图片不在列表中"); return; }
        const indices = selectedArr.map(f => names.indexOf(f)).filter(i => i !== -1).sort((a, b) => b - a);
        if (indices[0] === names.length - 1) { setStatus("已经在最后面，无法向后移动"); return; }
        for (const idx of indices) {
            if (idx < names.length - 1) [names[idx], names[idx + 1]] = [names[idx + 1], names[idx]];
        }
        setImageList(node, names);
        setStatus("已向后移动选中图片");
    };
    clearBtn.onclick = () => {
        selectedFiles.clear();
        setImageList(node, []);
        setStatus("已清空所有图片");
    };

    deleteSelectedBtn.onclick = () => {
        if (selectedFiles.size === 0) {
            setStatus("请先选中要删除的图片");
            return;
        }
        const names = parseImageList(getImageListWidget(node)?.value);
        const remaining = names.filter(n => !selectedFiles.has(n));
        const deletedCount = selectedFiles.size;
        selectedFiles.clear();
        setImageList(node, remaining);
        setStatus(`已删除 ${deletedCount} 张图片`);
    };

    const redraw = () => {
        if (redrawTimeout) clearTimeout(redrawTimeout);
        redrawTimeout = setTimeout(() => _redraw(), 300);
    };

    const _redraw = () => {
        let names = parseImageList(getImageListWidget(node)?.value);
        if (searchTerm) names = names.filter(name => name.toLowerCase().includes(searchTerm));
        grid.innerHTML = "";
        if (names.length === 0) {
            grid.style.display = "none";
            selectedFiles.clear();
            updateInfo();
            return;
        }
        if (alignHeight) {
            grid.style.display = "flex";
            grid.style.flexWrap = "wrap";
        } else {
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${currentThumbSize}px, 1fr))`;
        }

        const frag = document.createDocumentFragment();
        names.forEach((name, idx) => {
            const cell = document.createElement("div");
            cell.className = "kinrol-thumb-cell";
            cell.dataset.filename = name;
            cell.dataset.index = idx;
            cell.style.cssText = "display:flex; flex-direction:column; gap:3px;";
            if (alignHeight) { cell.style.flex = "0 0 auto"; cell.style.maxWidth = "100%"; }

            const thumb = document.createElement("div");
            thumb.style.cssText = "position:relative; border-radius:4px; overflow:hidden; border:2px solid transparent; background:#000; transition:border-color 0.15s; display:flex; align-items:center; justify-content:center;";
            if (alignHeight) {
                thumb.style.height = `${currentThumbSize}px`;
                thumb.style.width = "fit-content";
                thumb.style.minWidth = "60px";
                thumb.style.maxWidth = "100%";
            } else {
                thumb.style.width = "100%";
                thumb.style.maxHeight = `${currentThumbSize * 2}px`;
            }

            const img = document.createElement("img");
            img.src = getViewUrl(name); img.alt = name; img.loading = "lazy"; img.draggable = false;
            img.style.cssText = "display:block; object-fit:contain; pointer-events:none;";
            if (alignHeight) { img.style.height = "100%"; img.style.width = "auto"; img.style.maxWidth = "100%"; }
            else { img.style.width = "100%"; img.style.height = "auto"; img.style.maxHeight = `${currentThumbSize * 2}px`; }

            const label = document.createElement("div");
            label.textContent = name; label.title = name;
            label.style.cssText = "font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0.9; pointer-events:none;";

            const sizeLabel = document.createElement("div");
            sizeLabel.style.cssText = "font-size:10px; opacity:0.7; pointer-events:none; min-height:14px;";
            sizeLabel.textContent = "加载中...";
            const setSize = (imgEl) => {
                if (imgEl.naturalWidth && imgEl.naturalHeight) sizeLabel.textContent = `${imgEl.naturalWidth} x ${imgEl.naturalHeight}`;
                else sizeLabel.textContent = "尺寸未知";
            };
            if (img.complete && img.naturalWidth) setSize(img);
            else { img.onload = () => setSize(img); img.onerror = () => { sizeLabel.textContent = "无法加载"; }; }

            const del = document.createElement("button");
            del.textContent = "×"; del.title = "删除此图片";
            del.style.cssText = "position:absolute; top:2px; right:2px; width:20px; height:20px; background:rgba(255,0,0,0.75); color:#fff; border:none; border-radius:3px; cursor:pointer; font-size:16px; line-height:1; z-index:5;";
            del.onclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                const next = parseImageList(getImageListWidget(node)?.value).filter(n => n !== name);
                selectedFiles.delete(name);
                setImageList(node, next);
            };

            thumb.append(img, del);
            cell.append(thumb, label, sizeLabel);
            frag.appendChild(cell);
        });

        grid.appendChild(frag);
        grid.querySelectorAll(".kinrol-thumb-cell").forEach(cell => updateElementSelection(cell, cell.dataset.filename));
        updateInfo();
        updateGridMaxHeight();
        app.graph?.setDirtyCanvas(true);
    };

    const setStatus = (text) => { statusBar.textContent = text || ""; };

    rowInput.value = getMaxRows();
    rowInput.addEventListener("change", () => {
        let val = parseInt(rowInput.value, 10);
        if (isNaN(val)) val = 5;
        val = Math.min(20, Math.max(1, val));
        rowInput.value = val;
        setMaxRows(val);
        updateGridMaxHeight();
        app.graph?.setDirtyCanvas(true);
    });

    container.addEventListener("dragover", e => { if (isFilesDragEvent(e)) { e.preventDefault(); e.stopPropagation(); } });
    container.addEventListener("drop", async e => {
        if (!isFilesDragEvent(e)) return;
        e.preventDefault(); e.stopPropagation();
        const files = Array.from(e.dataTransfer?.files || []);
        await uploadFilesSequential(node, files, { replace: false });
    });

    const setDragging = (on) => { container.style.border = on ? "2px dashed #4a6" : "1px solid var(--border-color)"; };

    replaceBtn.onclick = () => openMultiSelect(node, { replace: true });
    addBtn.onclick = () => openMultiSelect(node, { replace: false });
    folderBtn.onclick = () => openFolderSelect(node, { replace: true });
    queueAllBtn.onclick = () => queueAllSequential(node);
    queueSelectedBtn.onclick = async () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        const toQueue = names.filter(n => selectedFiles.has(n));
        if (toQueue.length === 0) { alert("请先选中至少一张图片"); return; }
        const modeWidget = node.widgets?.find(w => w.name === "mode");
        const indexWidget = node.widgets?.find(w => w.name === "index");
        if (modeWidget) { modeWidget.value = "single"; modeWidget.callback?.("single"); }
        for (let i = 0; i < toQueue.length; i++) {
            const name = toQueue[i];
            const idx = names.indexOf(name);
            if (idx !== -1 && indexWidget) { indexWidget.value = idx; indexWidget.callback?.(idx); }
            await app.queuePrompt();
        }
    };

    container.append(searchRow, btnGrid, brand, statusBar, infoRow, grid);
    const style = document.createElement("style");
    style.textContent = `.kinrol-thumb-cell.kinrol-selected > div:first-child { border-color: #4a6 !important; box-shadow: 0 0 0 1px #4a6; }`;
    container.appendChild(style);

    applyLayoutMode();
    setTimeout(() => redraw(), 50);

    return { container, redraw, setDragging, setStatus };
}

// ===================== 注册扩展（仅批量加载节点） =====================
app.registerExtension({
    name: "Kinrol.BatchLoadImages.Extension",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "KinrolBatchLoadImages") return;

        ensureGlobalDragDropPrevention();
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

            const thumbSizeWidget = getThumbSizeWidget(this);
            if (thumbSizeWidget) {
                thumbSizeWidget.type = "hidden";
                thumbSizeWidget.computeSize = () => [0, -4];
            }

            const imageListWidget = getImageListWidget(this);
            if (imageListWidget) {
                imageListWidget.type = "hidden";
                imageListWidget.computeSize = () => [0, -4];
                const prevCallback = imageListWidget.callback;
                imageListWidget.callback = (value) => {
                    prevCallback?.(value);
                    this._kinrolBatchLoadImagesUI?.redraw();
                };
            }

            const maxRowsWidget = getMaxRowsWidget(this);
            if (maxRowsWidget) {
                maxRowsWidget.type = "hidden";
                maxRowsWidget.computeSize = () => [0, -4];
            }

            const ui = createBatchLoadUI(this);
            this._kinrolBatchLoadImagesUI = ui;
            this.addDOMWidget("kinrol_batch_load_images", "customwidget", ui.container);
            this.setSize([430]);
            _batchLoadImagesDomUIs.add({ node: this, container: ui.container, redraw: ui.redraw, setDragging: ui.setDragging });

            const prevOnRemoved = this.onRemoved;
            this.onRemoved = function () {
                for (const entry of _batchLoadImagesDomUIs) {
                    if (entry?.node === this) { _batchLoadImagesDomUIs.delete(entry); break; }
                }
                prevOnRemoved?.apply(this, arguments);
            };

            return r;
        };
    },
});