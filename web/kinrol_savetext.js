// web/kinrol_savetext.js
import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "Kinrol.SaveTextSequential.Extension",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "KinrolSaveTextSequential") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

            const passthroughWidget = this.widgets?.find(w => w.name === "passthrough");
            if (!passthroughWidget) return r;

            // 创建一个全新的显示区域（参照 easy-use 的 showText 节点）
            const displayWidget = this.addDOMWidget(
                "passthrough_display",
                "customtext",  // 使用 "customtext" 类型，这是 ComfyUI 支持的显示文本类型
                {
                    value: passthroughWidget.value || "",
                    readonly: true,
                    multiline: true,
                    placeholder: "连接 passthrough 后此处显示文本…"
                }
            );

            // 实时同步：当 passthrough 值变化时更新显示
            const updateDisplay = () => {
                const val = passthroughWidget.value || "";
                if (displayWidget.value !== val) {
                    displayWidget.value = val;
                }
            };
            updateDisplay();

            const origCallback = passthroughWidget.callback;
            passthroughWidget.callback = (value) => {
                if (origCallback) origCallback(value);
                updateDisplay();
            };

            return r;
        };
    },
});