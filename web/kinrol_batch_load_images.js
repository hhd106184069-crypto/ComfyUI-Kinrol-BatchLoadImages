// web/kinrol_batch_load_images.js
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// ===================== 工具函数 =====================

function getImageListWidget(node) {
    return node?.widgets?.find((w) => w.name === "image_list");
}
function getMaxRowsWidget(node) {
    return node?.widgets?.find((w) => w.name === "max_rows");
}
function getThumbSizeWidget(node) {
    return node?.widgets?.find((w) => w.name === "thumb_size");
}
function parseImageList(value) {
    return (value || "").split(/[\n,;]+/).map(s => s.trim()).filter(s => s.length > 0);
}
function setImageList(node, names) {
    const w = getImageListWidget(node);
    if (!w) return;
    w.value = names.join("\n");
    w.callback?.(w.value);
}
function getViewUrl(filename) {
    return `/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=`;
}

// ===================== 全局拖拽（文件上传） =====================
function isFilesDragEvent(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    return Array.from(dt.types || []).includes("Files");
}
const _batchLoadImagesDomUIs = new Set();
function _setDraggingUI(activeEntry) {
    for (const entry of _batchLoadImagesDomUIs) {
        entry?.setDragging?.(entry === activeEntry);
    }
}
let _globalDragDropInstalled = false;
function ensureGlobalDragDropPrevention() {
    if (_globalDragDropInstalled) return;
    _globalDragDropInstalled = true;
    window.addEventListener("dragover", e => {
        if (!isFilesDragEvent(e)) return;
        e.preventDefault();
        const hit = [..._batchLoadImagesDomUIs].find(entry => entry?.container?.contains(e.target));
        _setDraggingUI(hit || null);
    }, { capture: true });
    window.addEventListener("drop", async e => {
        if (!isFilesDragEvent(e)) return;
        e.preventDefault();
        const hit = [..._batchLoadImagesDomUIs].find(entry => entry?.container?.contains(e.target));
        _setDraggingUI(null);
        if (!hit) return;
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;
        await uploadFilesSequential(hit.node, files, { replace: false });
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
            try {
                const files = Array.from(e.target.files || []);
                await uploadFilesSequential(node, files, { replace });
                resolve();
            } catch (err) { console.error(err); }
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

// ===================== UI 构建 =====================
function createBrowserUI(node) {
    let selectedFiles = new Set();
    let lastSelectedIndex = null;

    const container = document.createElement("div");
    container.style.cssText = `
        width: 100%;
        padding: 8px;
        background: var(--comfy-menu-bg);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        margin: 5px 0;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
    `;

    const buttonPanel = document.createElement("div");
    buttonPanel.style.cssText = "display:flex; flex-direction:column; gap:4px; margin-bottom:6px;";
    const mkBtn = label => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = "min-height:26px; padding:4px 6px; background:var(--comfy-input-bg); color:var(--input-text); border:1px solid var(--border-color); border-radius:4px; cursor:pointer; font-size:11px; line-height:1.1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
        return b;
    };
    const mkRow = (...buttons) => {
        const row = document.createElement("div");
        row.style.cssText = "display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:4px;";
        row.append(...buttons);
        return row;
    };
    const replaceBtn = mkBtn("选择图片");
    const addBtn = mkBtn("追加图片");
    const folderBtn = mkBtn("选择文件夹");
    const queueAllBtn = mkBtn("逐张入队");
    const queueSelectedBtn = mkBtn("入队选中");
    const toggleAllBtn = mkBtn("全选");
    const invertBtn = mkBtn("反选");
    const deselectBtn = mkBtn("取消选中");
    const deleteSelectedBtn = mkBtn("删除选中");
    const clearBtn = mkBtn("清空");
    buttonPanel.append(
        mkRow(replaceBtn, addBtn, folderBtn, queueAllBtn, queueSelectedBtn),
        mkRow(toggleAllBtn, invertBtn, deselectBtn, deleteSelectedBtn, clearBtn),
    );

    // 品牌
    const brand = document.createElement("div");
    brand.textContent = "Kinrol Batch Load Images";
    brand.style.cssText = "font-size:10px; opacity:0.7; margin-bottom:8px; text-align:center; color:var(--input-text); flex-shrink:0;";

    // 状态栏
    const statusBar = document.createElement("div");
    statusBar.style.cssText = "font-size:12px; color:#4a6; margin-bottom:6px; min-height:1.2em; flex-shrink:0;";

    // 信息栏 + 行数 + 滑块 + 模式按钮
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
    sizeSlider.type = "range"; sizeSlider.min = 40; sizeSlider.max = 300; sizeSlider.value = 120;
    sizeSlider.style.cssText = "width:70px;";
    const sizeValue = document.createElement("span");
    sizeValue.style.cssText = "min-width:40px; text-align:right;";
    sizeControl.append(sizeLabel, sizeSlider, sizeValue);

    const toggleModeBtn = document.createElement("button");
    toggleModeBtn.style.cssText = "padding:4px 8px; background:var(--comfy-input-bg); color:var(--input-text); border:1px solid var(--border-color); border-radius:4px; cursor:pointer; font-size:12px; white-space:nowrap;";

    infoRow.append(info, rowControl, sizeControl, toggleModeBtn);

    // 图片网格
    const grid = document.createElement("div");
    grid.style.cssText = `
        display: none;
        gap: 12px;
        overflow-y: auto;
        background: var(--comfy-input-bg);
        padding: 10px;
        border-radius: 4px;
        flex: 1 1 auto;
        min-height: 0;
        user-select: none;
        -webkit-user-select: none;
    `;

    // 模式状态
    let alignHeight = false;
    const clampThumbSize = (value) => {
        const parsed = parseInt(value, 10);
        if (Number.isNaN(parsed)) return 120;
        return Math.min(300, Math.max(40, parsed));
    };
    const getThumbSize = () => clampThumbSize(getThumbSizeWidget(node)?.value ?? sizeSlider.value);
    const setThumbSize = (value, { persist = true } = {}) => {
        const normalized = clampThumbSize(value);
        sizeSlider.value = String(normalized);
        sizeValue.textContent = normalized + "px";
        if (persist) {
            const widget = getThumbSizeWidget(node);
            if (widget && widget.value !== normalized) {
                widget.value = normalized;
                widget.callback?.(normalized);
            }
        }
        return normalized;
    };
    const applyLayoutMode = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        const thumbSize = setThumbSize(getThumbSize(), { persist: false });
        if (alignHeight) {
            grid.style.display = names.length ? 'flex' : 'none';
            grid.style.flexWrap = 'wrap';
            grid.style.gridTemplateColumns = '';
            sizeLabel.textContent = "高度:";
            toggleModeBtn.textContent = "宽度优先";
        } else {
            grid.style.display = names.length ? 'grid' : 'none';
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`;
            grid.style.flexWrap = '';
            sizeLabel.textContent = "大小:";
            toggleModeBtn.textContent = "高度优先";
        }
        updateGridMaxHeight();
    };
    toggleModeBtn.onclick = () => { alignHeight = !alignHeight; applyLayoutMode(); redraw(); };
    sizeSlider.addEventListener("input", () => { setThumbSize(sizeSlider.value); applyLayoutMode(); redraw(); });

    const updateInfo = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        const selectedCount = selectedFiles.size;
        info.textContent = names.length ? `已选择 ${names.length} 张${selectedCount > 0 ? ` (选中 ${selectedCount})` : ""}` : "暂无图片";
        toggleAllBtn.textContent = names.length > 0 && selectedCount === names.length ? "全不选" : "全选";
    };
    const getMaxRows = () => getMaxRowsWidget(node)?.value || 5;
    const setMaxRows = val => {
        const widget = getMaxRowsWidget(node);
        if (widget) { widget.value = val; widget.callback?.(val); }
    };

    const getEstimatedRowHeight = () => {
        const thumbVal = clampThumbSize(sizeSlider.value);
        const labelHeight = 30;
        if (alignHeight) return thumbVal + labelHeight + 3 + 12;
        return thumbVal * 2 + labelHeight + 3 + 12;
    };

    const updateGridMaxHeight = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        if (!names.length) return;
        const maxRows = getMaxRows();
        const estimatedRow = getEstimatedRowHeight();
        const baseHeight = maxRows * estimatedRow;
        const containerHeight = container.clientHeight;
        if (!containerHeight) return;
        const fixedHeight = buttonPanel.offsetHeight + brand.offsetHeight + statusBar.offsetHeight + infoRow.offsetHeight + 16;
        let availableHeight = containerHeight - fixedHeight;
        if (availableHeight < 100) availableHeight = 100;
        const targetHeight = Math.min(baseHeight, availableHeight);
        grid.style.maxHeight = `${targetHeight}px`;
    };

    const resizeObserver = new ResizeObserver(() => updateGridMaxHeight());
    resizeObserver.observe(container);

    const clearSelection = () => {
        selectedFiles.clear();
        lastSelectedIndex = null;
        grid.querySelectorAll(".kinrol-selected").forEach(el => el.classList.remove("kinrol-selected"));
        updateInfo();
    };
    const updateElementSelection = (el, filename) => {
        if (selectedFiles.has(filename)) el.classList.add("kinrol-selected");
        else el.classList.remove("kinrol-selected");
    };
    const syncSelectionToVisibleCells = () => {
        grid.querySelectorAll(".kinrol-thumb-cell").forEach(cell => updateElementSelection(cell, cell.dataset.filename));
        updateInfo();
    };
    const toggleAllSelection = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        if (names.length === 0) {
            updateInfo();
            return;
        }
        const shouldClear = selectedFiles.size === names.length;
        if (shouldClear) {
            clearSelection();
            return;
        }
        selectedFiles = new Set(names);
        lastSelectedIndex = names.length - 1;
        syncSelectionToVisibleCells();
    };
    const invertSelection = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        if (names.length === 0) {
            updateInfo();
            return;
        }
        const nextSelected = new Set();
        names.forEach((name, index) => {
            if (!selectedFiles.has(name)) nextSelected.add(name);
            if (nextSelected.has(name)) lastSelectedIndex = index;
        });
        selectedFiles = nextSelected;
        if (selectedFiles.size === 0) lastSelectedIndex = null;
        syncSelectionToVisibleCells();
    };
    const handleCellClick = (cell, event) => {
        const names = parseImageList(getImageListWidget(node)?.value);
        const filename = cell?.dataset?.filename;
        if (!filename) return;
        const clickedIndex = names.indexOf(filename);
        if (clickedIndex === -1) return;

        if (event?.shiftKey && lastSelectedIndex !== null && lastSelectedIndex >= 0 && lastSelectedIndex < names.length) {
            const start = Math.min(lastSelectedIndex, clickedIndex);
            const end = Math.max(lastSelectedIndex, clickedIndex);
            for (let i = start; i <= end; i++) {
                selectedFiles.add(names[i]);
            }
            lastSelectedIndex = clickedIndex;
            syncSelectionToVisibleCells();
            return;
        }

        if (selectedFiles.has(filename)) selectedFiles.delete(filename);
        else selectedFiles.add(filename);
        lastSelectedIndex = clickedIndex;
        updateElementSelection(cell, filename);
        updateInfo();
    };

    // ===== 框选逻辑（临时监听，防冲突） =====
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
            if (cell) handleCellClick(cell, e);
        }
        isSelecting = false;
    };

    grid.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest("button")) return;
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startY = e.clientY;
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

    // ===== 重绘 =====
    const redraw = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        selectedFiles = new Set(names.filter(name => selectedFiles.has(name)));
        if (lastSelectedIndex !== null && (lastSelectedIndex < 0 || lastSelectedIndex >= names.length)) {
            lastSelectedIndex = names.length ? names.length - 1 : null;
        }
        grid.innerHTML = "";
        if (names.length === 0) {
            grid.style.display = "none";
            clearSelection();
            updateInfo();
            return;
        }
        setThumbSize(getThumbSize(), { persist: false });
        if (alignHeight) {
            grid.style.display = "flex";
            grid.style.flexWrap = "wrap";
        } else {
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${sizeSlider.value}px, 1fr))`;
        }

        const frag = document.createDocumentFragment();
        names.forEach((name, idx) => {
            const cell = document.createElement("div");
            cell.className = "kinrol-thumb-cell";
            cell.dataset.filename = name;
            cell.style.cssText = "display:flex; flex-direction:column; gap:3px;";
            if (alignHeight) { cell.style.flex = "0 0 auto"; cell.style.maxWidth = "100%"; }

            const thumb = document.createElement("div");
            thumb.style.cssText = "position:relative; border-radius:4px; overflow:hidden; border:2px solid transparent; background:#000; transition:border-color 0.15s; display:flex; align-items:center; justify-content:center;";
            if (alignHeight) {
                thumb.style.height = `${sizeSlider.value}px`;
                thumb.style.width = "fit-content";
                thumb.style.minWidth = "60px";
                thumb.style.maxWidth = "100%";
            } else {
                thumb.style.width = "100%";
                thumb.style.maxHeight = `${sizeSlider.value * 2}px`;
            }

            const img = document.createElement("img");
            img.src = getViewUrl(name); img.alt = name; img.loading = "lazy"; img.draggable = false;
            img.style.cssText = "display:block; object-fit:contain; pointer-events:none;";
            if (alignHeight) { img.style.height = "100%"; img.style.width = "auto"; img.style.maxWidth = "100%"; }
            else { img.style.width = "100%"; img.style.height = "auto"; img.style.maxHeight = `${sizeSlider.value * 2}px`; }

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
                const next = names.slice(0, idx).concat(names.slice(idx + 1));
                selectedFiles.delete(name);
                if (selectedFiles.size === 0) lastSelectedIndex = null;
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
    setThumbSize(getThumbSize(), { persist: false });
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
    toggleAllBtn.onclick = () => toggleAllSelection();
    invertBtn.onclick = () => invertSelection();
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
    deleteSelectedBtn.onclick = () => {
        if (selectedFiles.size === 0) { alert("请先选中要删除的图片"); return; }
        const names = parseImageList(getImageListWidget(node)?.value);
        const remaining = names.filter(n => !selectedFiles.has(n));
        clearSelection();
        setImageList(node, remaining);
    };
    deselectBtn.onclick = () => clearSelection();
    clearBtn.onclick = () => { clearSelection(); setImageList(node, []); };

    container.append(buttonPanel, brand, statusBar, infoRow, grid);
    const style = document.createElement("style");
    style.textContent = `.kinrol-thumb-cell.kinrol-selected > div:first-child { border-color: #4a6 !important; box-shadow: 0 0 0 1px #4a6; }`;
    container.appendChild(style);

    applyLayoutMode();
    setTimeout(() => redraw(), 50);

    return { container, redraw, setDragging, setStatus };
}

// ===================== 注册扩展 =====================
app.registerExtension({
    name: "Kinrol.BatchLoadImages.Extension",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "KinrolBatchLoadImages") return;
        ensureGlobalDragDropPrevention();
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
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
            const thumbSizeWidget = getThumbSizeWidget(this);
            if (thumbSizeWidget) {
                thumbSizeWidget.type = "hidden";
                thumbSizeWidget.computeSize = () => [0, -4];
            }
            const ui = createBrowserUI(this);
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
