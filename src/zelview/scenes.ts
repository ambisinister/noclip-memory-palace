
import * as Viewer from '../viewer.js';
import { GfxDevice, GfxCullMode } from '../gfx/platform/GfxPlatform.js';
import { makeBackbufferDescSimple, makeAttachmentClearDescriptor } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { OpaqueBlack } from '../Color.js';
import { SceneContext } from '../SceneBase.js';
import { readZELVIEW0, Headers, ZELVIEW0 } from './zelview0.js';
import { RootMeshRenderer, MeshData, Mesh } from './render.js';
import { RSPState, RSPOutput } from './f3dzex.js';
import { CameraController } from '../Camera.js';
import * as UI from '../ui.js';
import { GfxrAttachmentClearDescriptor, GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { GfxRenderInstList } from '../gfx/render/GfxRenderInstManager.js';
import { BillboardRenderer } from './BillboardRenderer.js';
import { PhysicsCameraController } from './PhysicsCameraController.js';
import { mat4, vec3 } from 'gl-matrix';
import OpenAI from 'openai';

const pathBase = `ZeldaOcarinaOfTime`;

class ZelviewRenderer implements Viewer.SceneGfx {
    private clearAttachmentDescriptor: GfxrAttachmentClearDescriptor;

    public meshDatas: MeshData[] = [];
    public meshRenderers: RootMeshRenderer[] = [];
    public billboardRenderers: BillboardRenderer[] = [];
    public selectedBillboardIndex: number = -1;
    private dialogBoxElement: HTMLDivElement | null = null;
    private dialogTextElement: HTMLDivElement | null = null;
    public sceneId: string = 'spot04_scene'; // Default to Kokiri Forest
    private lastWarpTime: number = 0; // Timestamp of last warp to prevent loops
    private warpCooldown: number = 3000; // 3 second cooldown between warps

    public renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    private device: GfxDevice;
    private currentCamera: Viewer.ViewerRenderInput | null = null;

    constructor(device: GfxDevice, private zelview: ZELVIEW0, sceneId?: string) {
        if (sceneId) {
            this.sceneId = sceneId;
        }
        this.device = device;
        this.renderHelper = new GfxRenderHelper(device);
        this.clearAttachmentDescriptor = makeAttachmentClearDescriptor(OpaqueBlack);

        // Create dialog box UI element
        this.createDialogBoxUI();

        // Add keyboard handler for dialogue toggle
        window.addEventListener('keydown', (e) => {
            if (e.code === 'KeyC') {
                this.toggleDialogueBox();
            }
        });

        // Auto-load billboards from localStorage
        this.autoLoadBillboards();

        // Check for warp cooldown from previous scene
        const lastWarpTimeStr = localStorage.getItem('lastWarpTime');
        if (lastWarpTimeStr) {
            this.lastWarpTime = parseInt(lastWarpTimeStr);
            const timeSinceWarp = Date.now() - this.lastWarpTime;
            if (timeSinceWarp < this.warpCooldown) {
                console.log(`🛡️ Warp cooldown active: ${((this.warpCooldown - timeSinceWarp) / 1000).toFixed(1)}s remaining`);
            }
        }
    }

    private createDialogBoxUI(): void {
        // Create dialog box container
        this.dialogBoxElement = document.createElement('div');
        this.dialogBoxElement.style.position = 'fixed';
        this.dialogBoxElement.style.top = '80px';
        this.dialogBoxElement.style.left = '50%';
        this.dialogBoxElement.style.transform = 'translateX(-50%)';
        this.dialogBoxElement.style.width = '600px';
        this.dialogBoxElement.style.maxWidth = '90%';
        this.dialogBoxElement.style.backgroundColor = 'rgba(20, 20, 30, 0.95)';
        this.dialogBoxElement.style.border = '3px solid #4a9eff';
        this.dialogBoxElement.style.borderRadius = '8px';
        this.dialogBoxElement.style.padding = '20px 30px';
        this.dialogBoxElement.style.fontFamily = 'monospace';
        this.dialogBoxElement.style.fontSize = '14px';
        this.dialogBoxElement.style.color = '#ffffff';
        this.dialogBoxElement.style.lineHeight = '1.5';
        this.dialogBoxElement.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.5)';
        this.dialogBoxElement.style.zIndex = '10000';
        this.dialogBoxElement.style.display = 'none';
        this.dialogBoxElement.style.pointerEvents = 'none'; // Don't block mouse events

        // Create text content element
        this.dialogTextElement = document.createElement('div');
        this.dialogBoxElement.appendChild(this.dialogTextElement);

        // Create instruction hint
        const hintElement = document.createElement('div');
        hintElement.textContent = 'Press C to close';
        hintElement.style.marginTop = '15px';
        hintElement.style.fontSize = '11px';
        hintElement.style.color = '#888';
        hintElement.style.textAlign = 'right';
        this.dialogBoxElement.appendChild(hintElement);

        // Add to document body
        document.body.appendChild(this.dialogBoxElement);
    }

    private toggleDialogueBox(): void {
        if (!this.dialogBoxElement || !this.dialogTextElement) return;

        const isVisible = this.dialogBoxElement.style.display !== 'none';

        if (isVisible) {
            // Hide dialog box
            this.dialogBoxElement.style.display = 'none';
            console.log('✗ Dialog box hidden (Press C to show)');
        } else {
            // Find nearest billboard to show dialogue for
            const nearestBillboard = this.findNearestBillboard();

            if (nearestBillboard) {
                const billboardIndex = this.billboardRenderers.indexOf(nearestBillboard);

                // Auto-select this billboard in the control panel
                this.selectedBillboardIndex = billboardIndex;

                // Use the billboard's custom dialogue text, or show a default message if empty
                const dialogue = nearestBillboard.dialogueText || '(No text set for this billboard. Edit it in the Billboard Controls panel!)';

                // Set text and show
                this.dialogTextElement.textContent = dialogue;
                this.dialogBoxElement.style.display = 'block';
                console.log(`✓ Dialog box shown for billboard #${billboardIndex + 1} (Press C to hide) - Billboard auto-selected in panel`);
            } else {
                console.log('⚠ No billboards nearby to interact with');
            }
        }
    }

    private findNearestBillboard(): BillboardRenderer | null {
        if (this.billboardRenderers.length === 0 || !this.currentCamera) {
            return null;
        }

        // Get camera position from view matrix
        const viewMatrix = this.currentCamera.camera.viewMatrix;
        const camX = -(viewMatrix[0] * viewMatrix[12] + viewMatrix[1] * viewMatrix[13] + viewMatrix[2] * viewMatrix[14]);
        const camY = -(viewMatrix[4] * viewMatrix[12] + viewMatrix[5] * viewMatrix[13] + viewMatrix[6] * viewMatrix[14]);
        const camZ = -(viewMatrix[8] * viewMatrix[12] + viewMatrix[9] * viewMatrix[13] + viewMatrix[10] * viewMatrix[14]);

        // Find nearest billboard
        let nearestBillboard: BillboardRenderer | null = null;
        let nearestDistance = Infinity;

        for (const billboard of this.billboardRenderers) {
            const dx = billboard.position[0] - camX;
            const dy = billboard.position[1] - camY;
            const dz = billboard.position[2] - camZ;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestBillboard = billboard;
            }
        }

        return nearestBillboard;
    }

    private checkWarpBillboardCollisions(): void {
        if (!this.currentCamera) return;

        // Check cooldown to prevent infinite warp loops
        const currentTime = Date.now();
        if (currentTime - this.lastWarpTime < this.warpCooldown) {
            return; // Still in cooldown period
        }

        // Get camera position from view matrix
        const viewMatrix = this.currentCamera.camera.viewMatrix;
        const camX = -(viewMatrix[0] * viewMatrix[12] + viewMatrix[1] * viewMatrix[13] + viewMatrix[2] * viewMatrix[14]);
        const camY = -(viewMatrix[4] * viewMatrix[12] + viewMatrix[5] * viewMatrix[13] + viewMatrix[6] * viewMatrix[14]);
        const camZ = -(viewMatrix[8] * viewMatrix[12] + viewMatrix[9] * viewMatrix[13] + viewMatrix[10] * viewMatrix[14]);

        // Check each warp billboard for collision
        for (const billboard of this.billboardRenderers) {
            if (!billboard.isWarpBillboard || !billboard.targetScene) continue;

            const dx = billboard.position[0] - camX;
            const dy = billboard.position[1] - camY;
            const dz = billboard.position[2] - camZ;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

            // Check if within warp radius
            if (distance < billboard.warpRadius) {
                this.triggerSceneWarp(billboard.targetScene);
                break; // Only warp to one scene at a time
            }
        }
    }

    private triggerSceneWarp(targetSceneId: string): void {
        // Set cooldown timestamp in localStorage to persist across page reloads
        const warpTimestamp = Date.now();
        localStorage.setItem('lastWarpTime', warpTimestamp.toString());

        console.log(`🌀 Warping to scene: ${targetSceneId} (3s cooldown activated)`);

        // Reload the page with the new scene hash
        window.location.hash = `zelview/${targetSceneId}`;
        window.location.reload();
    }

    private teleportToBillboard(billboardIndex: number): void {
        if (!this.currentCamera || billboardIndex < 0 || billboardIndex >= this.billboardRenderers.length) {
            return;
        }

        const billboard = this.billboardRenderers[billboardIndex];
        const camera = this.currentCamera.camera;

        // Check if billboard has a saved viewing angle
        if (billboard.savedCameraPosition && billboard.savedCameraOrientation) {
            // Use saved position and orientation
            mat4.copy(camera.worldMatrix, billboard.savedCameraOrientation);
            camera.worldMatrix[12] = billboard.savedCameraPosition[0];
            camera.worldMatrix[13] = billboard.savedCameraPosition[1];
            camera.worldMatrix[14] = billboard.savedCameraPosition[2];
            camera.worldMatrixUpdated();
            console.log(`🎯 Teleported to billboard #${billboardIndex + 1} (using saved viewing angle)`);
            return;
        }

        // Default behavior: position in front of billboard and look at it
        const billboardPos = vec3.clone(billboard.position);
        const distance = 300;

        // Calculate camera position (300 units in front along Z axis)
        const cameraPos = vec3.fromValues(
            billboardPos[0],
            billboardPos[1],
            billboardPos[2] - distance
        );

        // Create a "look at" matrix that faces the billboard
        const eye = cameraPos;
        const target = billboardPos;
        const up = vec3.fromValues(0, 1, 0);

        // Calculate forward vector (from camera to billboard)
        const forward = vec3.create();
        vec3.subtract(forward, target, eye);
        vec3.normalize(forward, forward);

        // Calculate right vector
        const right = vec3.create();
        vec3.cross(right, up, forward);
        vec3.normalize(right, right);

        // Recalculate up vector to ensure orthogonality
        const newUp = vec3.create();
        vec3.cross(newUp, forward, right);
        vec3.normalize(newUp, newUp);

        // Build world matrix (camera-to-world transform)
        // In OpenGL/WebGL, camera looks down -Z, so forward is actually -Z
        camera.worldMatrix[0] = right[0];
        camera.worldMatrix[1] = right[1];
        camera.worldMatrix[2] = right[2];
        camera.worldMatrix[3] = 0;

        camera.worldMatrix[4] = newUp[0];
        camera.worldMatrix[5] = newUp[1];
        camera.worldMatrix[6] = newUp[2];
        camera.worldMatrix[7] = 0;

        camera.worldMatrix[8] = forward[0];
        camera.worldMatrix[9] = forward[1];
        camera.worldMatrix[10] = forward[2];
        camera.worldMatrix[11] = 0;

        camera.worldMatrix[12] = cameraPos[0];
        camera.worldMatrix[13] = cameraPos[1];
        camera.worldMatrix[14] = cameraPos[2];
        camera.worldMatrix[15] = 1;

        camera.worldMatrixUpdated();
        console.log(`🎯 Teleported to billboard #${billboardIndex + 1} at (${cameraPos[0].toFixed(1)}, ${cameraPos[1].toFixed(1)}, ${cameraPos[2].toFixed(1)})`);
    }

    public createCameraController(): CameraController {
        return new PhysicsCameraController();
    }

    public createPanels(): UI.Panel[] {
        const renderHacksPanel = new UI.Panel();

        renderHacksPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderHacksPanel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');
        const enableCullingCheckbox = new UI.Checkbox('Force Backfacing Culling', false);
        enableCullingCheckbox.onchanged = () => {
            for (let i = 0; i < this.meshRenderers.length; i++)
                this.meshRenderers[i].setCullModeOverride(enableCullingCheckbox.checked ? GfxCullMode.Back : GfxCullMode.None);
        };
        renderHacksPanel.contents.appendChild(enableCullingCheckbox.elem);

        // Billboard spawn panel
        const billboardPanel = new UI.Panel();
        billboardPanel.customHeaderBackgroundColor = UI.HIGHLIGHT_COLOR;
        billboardPanel.setTitle(UI.LAYER_ICON, 'Billboard Controls');

        const instructionsDiv = document.createElement('div');
        instructionsDiv.style.marginBottom = '10px';
        instructionsDiv.style.fontSize = '11px';
        instructionsDiv.style.color = '#ccc';
        instructionsDiv.textContent = 'Spawns a white square where you\'re looking';
        billboardPanel.contents.appendChild(instructionsDiv);

        const spawnButton = document.createElement('button');
        spawnButton.textContent = '+ Spawn Billboard Here';
        spawnButton.style.width = '100%';
        spawnButton.style.padding = '10px';
        spawnButton.style.marginBottom = '10px';
        spawnButton.style.cursor = 'pointer';
        spawnButton.style.backgroundColor = '#4a9eff';
        spawnButton.style.border = 'none';
        spawnButton.style.color = 'white';
        spawnButton.style.fontWeight = 'bold';
        spawnButton.onclick = () => {
            console.log('=== SPAWN BUTTON CLICKED ===');
            console.log('Current camera:', this.currentCamera ? 'EXISTS' : 'NULL');
            console.log('Current billboard count:', this.billboardRenderers.length);

            if (this.currentCamera) {
                // Get camera position and forward direction
                const viewMatrix = this.currentCamera.camera.viewMatrix;
                console.log('View matrix:', viewMatrix);

                // Camera position from view matrix (inverted)
                const camX = -(viewMatrix[0] * viewMatrix[12] + viewMatrix[1] * viewMatrix[13] + viewMatrix[2] * viewMatrix[14]);
                const camY = -(viewMatrix[4] * viewMatrix[12] + viewMatrix[5] * viewMatrix[13] + viewMatrix[6] * viewMatrix[14]);
                const camZ = -(viewMatrix[8] * viewMatrix[12] + viewMatrix[9] * viewMatrix[13] + viewMatrix[10] * viewMatrix[14]);

                console.log(`Camera position: (${camX.toFixed(1)}, ${camY.toFixed(1)}, ${camZ.toFixed(1)})`);

                // Forward direction (negative Z in view space, transformed to world space)
                const forwardX = -viewMatrix[2];
                const forwardY = -viewMatrix[6];
                const forwardZ = -viewMatrix[10];

                console.log(`Camera forward: (${forwardX.toFixed(3)}, ${forwardY.toFixed(3)}, ${forwardZ.toFixed(3)})`);

                // Spawn 300 units in front of camera
                const distance = 300;
                const x = camX + forwardX * distance;
                const y = camY + forwardY * distance;
                const z = camZ + forwardZ * distance;

                console.log(`Target spawn position: (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
                console.log('Calling addBillboard...');

                this.addBillboard(this.device, x, y, z, 150, 1.0, 1.0, 1.0, 1.0, false);
                this.selectedBillboardIndex = this.billboardRenderers.length - 1;

                console.log(`✓ Billboard spawned! New count: ${this.billboardRenderers.length}`);
                console.log(`Selected index: ${this.selectedBillboardIndex}`);
                updateControls();
            } else {
                console.warn('⚠ Camera not ready, try again');
            }
            console.log('=== SPAWN BUTTON END ===\n');
        };
        billboardPanel.contents.appendChild(spawnButton);

        // Export/Import buttons container
        const exportImportContainer = document.createElement('div');
        exportImportContainer.style.display = 'flex';
        exportImportContainer.style.gap = '5px';
        exportImportContainer.style.marginBottom = '10px';
        billboardPanel.contents.appendChild(exportImportContainer);

        const exportButton = document.createElement('button');
        exportButton.textContent = '💾 Export JSON';
        exportButton.style.flex = '1';
        exportButton.style.padding = '8px';
        exportButton.style.cursor = 'pointer';
        exportButton.style.backgroundColor = '#2a7f2a';
        exportButton.style.border = 'none';
        exportButton.style.color = 'white';
        exportButton.style.fontSize = '11px';
        exportButton.style.fontWeight = 'bold';
        exportButton.onclick = () => {
            const json = this.exportBillboardsToJSON();
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${this.sceneId}_billboards.json`;
            a.click();
            URL.revokeObjectURL(url);
            console.log(`💾 Exported ${this.billboardRenderers.length} billboards to JSON`);
        };
        exportImportContainer.appendChild(exportButton);

        const importButton = document.createElement('button');
        importButton.textContent = '📂 Import JSON';
        importButton.style.flex = '1';
        importButton.style.padding = '8px';
        importButton.style.cursor = 'pointer';
        importButton.style.backgroundColor = '#2a5f7f';
        importButton.style.border = 'none';
        importButton.style.color = 'white';
        importButton.style.fontSize = '11px';
        importButton.style.fontWeight = 'bold';
        importButton.onclick = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const json = event.target?.result as string;
                        this.importBillboardsFromJSON(json);
                        updateControls();
                    };
                    reader.readAsText(file);
                }
            };
            input.click();
        };
        exportImportContainer.appendChild(importButton);

        const countDiv = document.createElement('div');
        countDiv.style.fontSize = '11px';
        countDiv.style.color = '#aaa';
        countDiv.style.marginBottom = '10px';
        countDiv.textContent = `Total billboards: ${this.billboardRenderers.length}`;
        billboardPanel.contents.appendChild(countDiv);

        // Selected billboard controls
        const selectedDiv = document.createElement('div');
        selectedDiv.style.fontSize = '11px';
        selectedDiv.style.color = '#ffa';
        selectedDiv.style.marginBottom = '5px';
        selectedDiv.style.fontWeight = 'bold';
        billboardPanel.contents.appendChild(selectedDiv);

        // Navigation buttons container
        const navContainer = document.createElement('div');
        navContainer.style.display = 'flex';
        navContainer.style.gap = '5px';
        navContainer.style.marginBottom = '10px';
        billboardPanel.contents.appendChild(navContainer);

        const prevButton = document.createElement('button');
        prevButton.textContent = '← Previous';
        prevButton.style.flex = '1';
        prevButton.style.padding = '6px';
        prevButton.style.cursor = 'pointer';
        prevButton.style.backgroundColor = '#555';
        prevButton.style.border = 'none';
        prevButton.style.color = 'white';
        prevButton.style.fontSize = '11px';
        prevButton.onclick = () => {
            if (this.billboardRenderers.length > 0) {
                this.selectedBillboardIndex = (this.selectedBillboardIndex - 1 + this.billboardRenderers.length) % this.billboardRenderers.length;
                this.teleportToBillboard(this.selectedBillboardIndex);
                updateControls();
                console.log(`◄ Selected billboard #${this.selectedBillboardIndex + 1}`);
            }
        };
        navContainer.appendChild(prevButton);

        const nextButton = document.createElement('button');
        nextButton.textContent = 'Next →';
        nextButton.style.flex = '1';
        nextButton.style.padding = '6px';
        nextButton.style.cursor = 'pointer';
        nextButton.style.backgroundColor = '#555';
        nextButton.style.border = 'none';
        nextButton.style.color = 'white';
        nextButton.style.fontSize = '11px';
        nextButton.onclick = () => {
            if (this.billboardRenderers.length > 0) {
                this.selectedBillboardIndex = (this.selectedBillboardIndex + 1) % this.billboardRenderers.length;
                this.teleportToBillboard(this.selectedBillboardIndex);
                updateControls();
                console.log(`► Selected billboard #${this.selectedBillboardIndex + 1}`);
            }
        };
        navContainer.appendChild(nextButton);

        const controlsDiv = document.createElement('div');
        controlsDiv.style.display = 'none';
        billboardPanel.contents.appendChild(controlsDiv);

        const updateControls = () => {
            countDiv.textContent = `Total billboards: ${this.billboardRenderers.length}`;

            if (this.selectedBillboardIndex >= 0 && this.selectedBillboardIndex < this.billboardRenderers.length) {
                const billboard = this.billboardRenderers[this.selectedBillboardIndex];
                selectedDiv.textContent = `Billboard ${this.selectedBillboardIndex + 1} of ${this.billboardRenderers.length}`;
                controlsDiv.style.display = 'block';
                navContainer.style.display = 'flex';
                prevButton.disabled = this.billboardRenderers.length <= 1;
                nextButton.disabled = this.billboardRenderers.length <= 1;
                posXInput.value = billboard.position[0].toFixed(1);
                posYInput.value = billboard.position[1].toFixed(1);
                posZInput.value = billboard.position[2].toFixed(1);
                sizeInput.value = billboard.size.toFixed(0);
                sizeValueLabel.textContent = billboard.size.toFixed(0);
                colorRInput.value = billboard.color[0].toFixed(1);
                colorGInput.value = billboard.color[1].toFixed(1);
                colorBInput.value = billboard.color[2].toFixed(1);
                dialogueTextInput.value = billboard.dialogueText;
                renderBehindCheckbox.checked = billboard.renderBehindWalls;
                warpBillboardCheckbox.checked = billboard.isWarpBillboard;
                warpTargetInput.value = billboard.targetScene || '';
                warpTargetContainer.style.display = billboard.isWarpBillboard ? 'block' : 'none';
            } else {
                selectedDiv.textContent = 'No billboard selected';
                controlsDiv.style.display = 'none';
                navContainer.style.display = 'none';
            }
        };

        // Position controls
        const posLabel = document.createElement('div');
        posLabel.textContent = 'Position (X, Y, Z):';
        posLabel.style.fontSize = '10px';
        posLabel.style.marginTop = '5px';
        posLabel.style.marginBottom = '3px';
        controlsDiv.appendChild(posLabel);

        const posContainer = document.createElement('div');
        posContainer.style.display = 'flex';
        posContainer.style.gap = '5px';
        posContainer.style.marginBottom = '8px';
        controlsDiv.appendChild(posContainer);

        const posXInput = document.createElement('input');
        posXInput.type = 'number';
        posXInput.style.width = '33%';
        posXInput.style.padding = '4px';
        posXInput.oninput = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].position[0] = parseFloat(posXInput.value) || 0;
                this.autoSaveBillboards();
            }
        };
        posContainer.appendChild(posXInput);

        const posYInput = document.createElement('input');
        posYInput.type = 'number';
        posYInput.style.width = '33%';
        posYInput.style.padding = '4px';
        posYInput.oninput = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].position[1] = parseFloat(posYInput.value) || 0;
                this.autoSaveBillboards();
            }
        };
        posContainer.appendChild(posYInput);

        const posZInput = document.createElement('input');
        posZInput.type = 'number';
        posZInput.style.width = '33%';
        posZInput.style.padding = '4px';
        posZInput.oninput = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].position[2] = parseFloat(posZInput.value) || 0;
                this.autoSaveBillboards();
            }
        };
        posContainer.appendChild(posZInput);

        // Size control
        const sizeLabel = document.createElement('div');
        sizeLabel.textContent = 'Size:';
        sizeLabel.style.fontSize = '10px';
        sizeLabel.style.marginBottom = '3px';
        controlsDiv.appendChild(sizeLabel);

        const sizeInput = document.createElement('input');
        sizeInput.type = 'range';
        sizeInput.min = '10';
        sizeInput.max = '500';
        sizeInput.value = '150';
        sizeInput.style.width = '100%';
        sizeInput.oninput = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].size = parseFloat(sizeInput.value);
                sizeValueLabel.textContent = sizeInput.value;
                this.autoSaveBillboards();
            }
        };
        controlsDiv.appendChild(sizeInput);

        const sizeValueLabel = document.createElement('div');
        sizeValueLabel.style.fontSize = '10px';
        sizeValueLabel.style.color = '#aaa';
        sizeValueLabel.style.marginBottom = '8px';
        sizeValueLabel.textContent = '150';
        controlsDiv.appendChild(sizeValueLabel);

        // Color controls
        const colorLabel = document.createElement('div');
        colorLabel.textContent = 'Color (R, G, B):';
        colorLabel.style.fontSize = '10px';
        colorLabel.style.marginBottom = '3px';
        controlsDiv.appendChild(colorLabel);

        const colorContainer = document.createElement('div');
        colorContainer.style.display = 'flex';
        colorContainer.style.gap = '5px';
        colorContainer.style.marginBottom = '8px';
        controlsDiv.appendChild(colorContainer);

        const colorRInput = document.createElement('input');
        colorRInput.type = 'number';
        colorRInput.min = '0';
        colorRInput.max = '1';
        colorRInput.step = '0.1';
        colorRInput.value = '1.0';
        colorRInput.style.width = '33%';
        colorRInput.style.padding = '4px';
        colorRInput.oninput = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].color[0] = parseFloat(colorRInput.value) || 0;
                this.autoSaveBillboards();
            }
        };
        colorContainer.appendChild(colorRInput);

        const colorGInput = document.createElement('input');
        colorGInput.type = 'number';
        colorGInput.min = '0';
        colorGInput.max = '1';
        colorGInput.step = '0.1';
        colorGInput.value = '1.0';
        colorGInput.style.width = '33%';
        colorGInput.style.padding = '4px';
        colorGInput.oninput = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].color[1] = parseFloat(colorGInput.value) || 0;
                this.autoSaveBillboards();
            }
        };
        colorContainer.appendChild(colorGInput);

        const colorBInput = document.createElement('input');
        colorBInput.type = 'number';
        colorBInput.min = '0';
        colorBInput.max = '1';
        colorBInput.step = '0.1';
        colorBInput.value = '1.0';
        colorBInput.style.width = '33%';
        colorBInput.style.padding = '4px';
        colorBInput.oninput = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].color[2] = parseFloat(colorBInput.value) || 0;
                this.autoSaveBillboards();
            }
        };
        colorContainer.appendChild(colorBInput);

        // Dialogue text input
        const dialogueTextLabel = document.createElement('div');
        dialogueTextLabel.textContent = 'Dialogue Text:';
        dialogueTextLabel.style.fontSize = '10px';
        dialogueTextLabel.style.marginBottom = '3px';
        dialogueTextLabel.style.marginTop = '5px';
        controlsDiv.appendChild(dialogueTextLabel);

        const dialogueTextInput = document.createElement('textarea');
        dialogueTextInput.style.width = '100%';
        dialogueTextInput.style.padding = '4px';
        dialogueTextInput.style.marginBottom = '8px';
        dialogueTextInput.style.fontFamily = 'monospace';
        dialogueTextInput.style.fontSize = '11px';
        dialogueTextInput.style.resize = 'vertical';
        dialogueTextInput.rows = 3;
        dialogueTextInput.placeholder = 'Enter text to display when pressing C...';
        dialogueTextInput.oninput = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].dialogueText = dialogueTextInput.value;
                this.autoSaveBillboards();
            }
        };
        controlsDiv.appendChild(dialogueTextInput);

        // Image file upload
        const imageFileLabel = document.createElement('div');
        imageFileLabel.textContent = 'Upload Image (optional):';
        imageFileLabel.style.fontSize = '10px';
        imageFileLabel.style.marginBottom = '3px';
        controlsDiv.appendChild(imageFileLabel);

        const imageFileInput = document.createElement('input');
        imageFileInput.type = 'file';
        imageFileInput.accept = 'image/*';
        imageFileInput.style.width = '100%';
        imageFileInput.style.padding = '4px';
        imageFileInput.style.marginBottom = '5px';
        imageFileInput.style.fontSize = '10px';
        imageFileInput.onchange = () => {
            if (this.selectedBillboardIndex >= 0 && imageFileInput.files && imageFileInput.files[0]) {
                this.billboardRenderers[this.selectedBillboardIndex].loadImageFromFile(imageFileInput.files[0]);
                // Auto-save will happen after image loads
                setTimeout(() => this.autoSaveBillboards(), 100);
            }
        };
        controlsDiv.appendChild(imageFileInput);

        // Image Generation section
        const aiImageLabel = document.createElement('div');
        aiImageLabel.textContent = 'Or Generate:';
        aiImageLabel.style.fontSize = '10px';
        aiImageLabel.style.marginTop = '10px';
        aiImageLabel.style.marginBottom = '3px';
        aiImageLabel.style.fontWeight = 'bold';
        controlsDiv.appendChild(aiImageLabel);

        // Model dropdown
        const modelLabel = document.createElement('div');
        modelLabel.textContent = 'Model:';
        modelLabel.style.fontSize = '10px';
        modelLabel.style.marginBottom = '3px';
        controlsDiv.appendChild(modelLabel);

        const modelSelect = document.createElement('select');
        modelSelect.style.width = '100%';
        modelSelect.style.padding = '4px';
        modelSelect.style.marginBottom = '8px';
        modelSelect.style.fontFamily = 'monospace';
        modelSelect.style.fontSize = '11px';

        const models = [
            { id: 'google/gemini-3-pro-image-preview', name: 'Gemini 3 Pro Image' },
            { id: 'google/gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image' },
        ];

        models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            modelSelect.appendChild(option);
        });
        controlsDiv.appendChild(modelSelect);

        // Prompt input
        const promptLabel = document.createElement('div');
        promptLabel.textContent = 'Prompt:';
        promptLabel.style.fontSize = '10px';
        promptLabel.style.marginBottom = '3px';
        controlsDiv.appendChild(promptLabel);

        const promptInput = document.createElement('textarea');
        promptInput.style.width = '100%';
        promptInput.style.padding = '4px';
        promptInput.style.marginBottom = '8px';
        promptInput.style.fontFamily = 'monospace';
        promptInput.style.fontSize = '11px';
        promptInput.style.resize = 'vertical';
        promptInput.rows = 3;
        promptInput.placeholder = 'e.g., A beautiful sunset over mountains';
        controlsDiv.appendChild(promptInput);

        // Generate button
        const generateButton = document.createElement('button');
        generateButton.textContent = '✨ Generate Image';
        generateButton.style.width = '100%';
        generateButton.style.padding = '10px';
        generateButton.style.marginBottom = '10px';
        generateButton.style.cursor = 'pointer';
        generateButton.style.backgroundColor = '#9b59b6';
        generateButton.style.border = 'none';
        generateButton.style.color = 'white';
        generateButton.style.fontWeight = 'bold';
        generateButton.onclick = async () => {
            if (this.selectedBillboardIndex < 0) {
                console.warn('No billboard selected');
                return;
            }

            const prompt = promptInput.value.trim();
            if (!prompt) {
                console.warn('Please enter a prompt');
                return;
            }

            const model = modelSelect.value;

            // Disable button and show loading state
            generateButton.disabled = true;
            generateButton.textContent = '⏳ Generating...';
            generateButton.style.backgroundColor = '#666';

            try {
                console.log(`🎨 Generating image with ${model}...`);
                const imagePath = await this.generateImage(prompt, model);

                if (imagePath && this.selectedBillboardIndex >= 0) {
                    const billboard = this.billboardRenderers[this.selectedBillboardIndex];

                    // Extract filename from path for display
                    const filename = imagePath.split('/').pop() || 'ai-generated.png';

                    // Store the path (not data URL) for persistence
                    billboard.imageData = imagePath;
                    billboard.imageName = filename;

                    // Load image from path (loadImageFromDataURL works with regular URLs too)
                    billboard.loadImageFromDataURL(imagePath, filename);
                    this.autoSaveBillboards();
                    console.log('✓ Image generated and applied to billboard!');
                }
            } catch (error) {
                console.error('Failed to generate image:', error);
                alert('Failed to generate image. Check console for details.');
            } finally {
                // Re-enable button
                generateButton.disabled = false;
                generateButton.textContent = '✨ Generate Image';
                generateButton.style.backgroundColor = '#9b59b6';
            }
        };
        controlsDiv.appendChild(generateButton);

        // Render Behind Walls checkbox
        const renderBehindLabel = document.createElement('label');
        renderBehindLabel.style.fontSize = '10px';
        renderBehindLabel.style.display = 'flex';
        renderBehindLabel.style.alignItems = 'center';
        renderBehindLabel.style.marginBottom = '8px';
        renderBehindLabel.style.cursor = 'pointer';
        controlsDiv.appendChild(renderBehindLabel);

        const renderBehindCheckbox = document.createElement('input');
        renderBehindCheckbox.type = 'checkbox';
        renderBehindCheckbox.checked = false;
        renderBehindCheckbox.style.marginRight = '5px';
        renderBehindCheckbox.onchange = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].renderBehindWalls = renderBehindCheckbox.checked;
                this.autoSaveBillboards();
            }
        };
        renderBehindLabel.appendChild(renderBehindCheckbox);

        const renderBehindText = document.createElement('span');
        renderBehindText.textContent = 'Painting mode (only visible behind walls)';
        renderBehindLabel.appendChild(renderBehindText);

        // Warp Billboard checkbox
        const warpBillboardLabel = document.createElement('label');
        warpBillboardLabel.style.fontSize = '10px';
        warpBillboardLabel.style.display = 'flex';
        warpBillboardLabel.style.alignItems = 'center';
        warpBillboardLabel.style.marginBottom = '8px';
        warpBillboardLabel.style.cursor = 'pointer';
        controlsDiv.appendChild(warpBillboardLabel);

        const warpBillboardCheckbox = document.createElement('input');
        warpBillboardCheckbox.type = 'checkbox';
        warpBillboardCheckbox.checked = false;
        warpBillboardCheckbox.style.marginRight = '5px';
        warpBillboardCheckbox.onchange = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].isWarpBillboard = warpBillboardCheckbox.checked;
                warpTargetContainer.style.display = warpBillboardCheckbox.checked ? 'block' : 'none';
                this.autoSaveBillboards();
            }
        };
        warpBillboardLabel.appendChild(warpBillboardCheckbox);

        const warpBillboardText = document.createElement('span');
        warpBillboardText.textContent = '🌀 Warp Billboard (teleport to another scene)';
        warpBillboardLabel.appendChild(warpBillboardText);

        // Warp target scene input (hidden by default)
        const warpTargetContainer = document.createElement('div');
        warpTargetContainer.style.display = 'none';
        warpTargetContainer.style.marginBottom = '8px';
        controlsDiv.appendChild(warpTargetContainer);

        const warpTargetLabel = document.createElement('div');
        warpTargetLabel.textContent = 'Warp to Scene:';
        warpTargetLabel.style.fontSize = '10px';
        warpTargetLabel.style.marginBottom = '3px';
        warpTargetContainer.appendChild(warpTargetLabel);

        const warpTargetInput = document.createElement('select');
        warpTargetInput.style.width = '100%';
        warpTargetInput.style.padding = '4px';
        warpTargetInput.style.fontFamily = 'monospace';
        warpTargetInput.style.fontSize = '11px';

        // Populate dropdown with all available scenes
        const sceneOptions = [
            { id: '', name: '-- Select a scene --' },
            { id: 'spot04_scene', name: 'Kokiri Forest' },
            { id: 'ydan_scene', name: 'Inside the Deku Tree' },
            { id: 'ydan_boss_scene', name: 'Inside the Deku Tree (Boss)' },
            { id: 'spot10_scene', name: 'Lost Woods' },
            { id: 'spot05_scene', name: 'Sacred Forest Meadow' },
            { id: 'Bmori1_scene', name: 'Forest Temple' },
            { id: 'moribossroom_scene', name: 'Forest Temple (Boss)' },
            { id: 'spot01_scene', name: 'Kakariko Village' },
            { id: 'kinsuta_scene', name: 'Skulltula House' },
            { id: 'mahouya_scene', name: "Granny's Potion Shop" },
            { id: 'spot02_scene', name: 'Kakariko Graveyard' },
            { id: 'hakasitarelay_scene', name: "Dampé's Grave & Kakariko Windmill" },
            { id: 'hakaana_ouke_scene', name: "Royal Family's Tomb" },
            { id: 'HAKAdan_scene', name: 'Shadow Temple' },
            { id: 'HAKAdan_bs_scene', name: 'Shadow Temple (Boss)' },
            { id: 'HAKAdanCH_scene', name: 'Bottom of the Well' },
            { id: 'hakaana_scene', name: 'Heart Piece Grave' },
            { id: 'hakaana2_scene', name: 'Fairy Fountain Grave' },
            { id: 'syatekijyou_scene', name: 'Shooting Gallery' },
            { id: 'spot16_scene', name: 'Death Mountain' },
            { id: 'spot17_scene', name: 'Death Mountain Crater' },
            { id: 'spot18_scene', name: 'Goron City' },
            { id: 'ddan_scene', name: "Dodongo's Cavern" },
            { id: 'ddan_boss_scene', name: "Dodongo's Cavern (Boss)" },
            { id: 'HIDAN_scene', name: 'Fire Temple' },
            { id: 'FIRE_bs_scene', name: 'Fire Temple (Boss)' },
            { id: 'spot00_scene', name: 'Hyrule Field' },
            { id: 'spot20_scene', name: 'Lon Lon Ranch' },
            { id: 'spot03_scene', name: "Zora's River" },
            { id: 'daiyousei_izumi_scene', name: 'Great Fairy Fountain' },
            { id: 'yousei_izumi_tate_scene', name: 'Small Fairy Fountain' },
            { id: 'yousei_izumi_yoko_scene', name: 'Magic Fairy Fountain' },
            { id: 'kakusiana_scene', name: 'Grottos' },
            { id: 'hiral_demo_scene', name: 'Cutscene Map' },
            { id: 'spot15_scene', name: 'Hyrule Castle' },
            { id: 'hairal_niwa_scene', name: 'Castle Courtyard' },
            { id: 'hairal_niwa_n_scene', name: 'Castle Courtyard (Night)' },
            { id: 'nakaniwa_scene', name: "Zelda's Courtyard" },
            { id: 'miharigoya_scene', name: "Lots'o'Pots" },
            { id: 'bowling_scene', name: 'Bombchu Bowling Alley' },
            { id: 'takaraya_scene', name: 'Treasure Chest Game' },
            { id: 'tokinoma_scene', name: 'Temple of Time (Interior)' },
            { id: 'kenjyanoma_scene', name: 'Chamber of Sages' },
            { id: 'spot06_scene', name: 'Lake Hylia' },
            { id: 'hylia_labo_scene', name: 'Hylia Lakeside Laboratory' },
            { id: 'turibori_scene', name: 'Fishing Pond' },
            { id: 'MIZUsin_scene', name: 'Water Temple' },
            { id: 'MIZUsin_bs_scene', name: 'Water Temple (Boss)' },
            { id: 'spot07_scene', name: "Zora's Domain" },
            { id: 'spot08_scene', name: "Zora's Fountain" },
            { id: 'bdan_scene', name: "Jabu-Jabu's Belly" },
            { id: 'bdan_boss_scene', name: "Jabu-Jabu's Belly (Boss)" },
            { id: 'ice_doukutu_scene', name: 'Ice Cavern' },
            { id: 'spot09_scene', name: 'Gerudo Valley' },
            { id: 'spot12_scene', name: "Gerudo's Fortress" },
            { id: 'men_scene', name: 'Gerudo Training Grounds' },
            { id: 'gerudoway_scene', name: "Thieves' Hideout" },
            { id: 'spot13_scene', name: 'Haunted Wasteland' },
            { id: 'spot11_scene', name: 'Desert Colossus' },
            { id: 'jyasinzou_scene', name: 'Spirit Temple' },
            { id: 'jyasinboss_scene', name: 'Spirit Temple (Mid-Boss)' },
            { id: 'ganontika_scene', name: "Ganon's Castle" },
            { id: 'ganontikasonogo_scene', name: "Ganon's Castle (Crumbling)" },
            { id: 'ganon_tou_scene', name: "Ganon's Castle (Outside)" },
            { id: 'ganon_scene', name: "Ganon's Castle Tower" },
            { id: 'ganon_sonogo_scene', name: "Ganon's Castle Tower (Crumbling)" },
            { id: 'ganon_boss_scene', name: 'Second-To-Last Boss Ganondorf' },
            { id: 'ganon_demo_scene', name: 'Final Battle Against Ganon' },
            { id: 'ganon_final_scene', name: "Ganondorf's Death" },
            { id: 'test01_scene', name: 'Collision Testing Area' },
            { id: 'besitu_scene', name: 'Besitu / Treasure Chest Warp' },
            { id: 'depth_test_scene', name: 'Depth Test' },
            { id: 'syotes_scene', name: 'Stalfos Middle Room' },
            { id: 'syotes2_scene', name: 'Stalfos Boss Room' },
            { id: 'sutaru_scene', name: 'Dark Link Testing Area' },
            { id: 'hairal_niwa2_scene', name: 'Beta Castle Courtyard' },
            { id: 'sasatest_scene', name: 'Action Testing Room' },
            { id: 'testroom_scene', name: 'Item Testing Room' },
        ];

        sceneOptions.forEach(option => {
            const optionElement = document.createElement('option');
            optionElement.value = option.id;
            optionElement.textContent = option.name;
            warpTargetInput.appendChild(optionElement);
        });

        warpTargetInput.onchange = () => {
            if (this.selectedBillboardIndex >= 0) {
                this.billboardRenderers[this.selectedBillboardIndex].targetScene = warpTargetInput.value;
                this.autoSaveBillboards();
            }
        };
        warpTargetContainer.appendChild(warpTargetInput);

        // Set Default Viewing Angle button
        const setViewAngleButton = document.createElement('button');
        setViewAngleButton.textContent = '📷 Set Default Viewing Angle';
        setViewAngleButton.style.width = '100%';
        setViewAngleButton.style.padding = '8px';
        setViewAngleButton.style.marginBottom = '8px';
        setViewAngleButton.style.cursor = 'pointer';
        setViewAngleButton.style.backgroundColor = '#4a9eff';
        setViewAngleButton.style.border = 'none';
        setViewAngleButton.style.color = 'white';
        setViewAngleButton.style.fontWeight = 'bold';
        setViewAngleButton.onclick = () => {
            if (this.selectedBillboardIndex >= 0 && this.currentCamera) {
                const billboard = this.billboardRenderers[this.selectedBillboardIndex];
                const camera = this.currentCamera.camera;

                // Save current camera position
                billboard.savedCameraPosition = vec3.fromValues(
                    camera.worldMatrix[12],
                    camera.worldMatrix[13],
                    camera.worldMatrix[14]
                );

                // Save current camera orientation (copy the entire matrix)
                billboard.savedCameraOrientation = mat4.clone(camera.worldMatrix);

                console.log(`📷 Saved viewing angle for billboard #${this.selectedBillboardIndex + 1}`);
                console.log(`   Position: (${billboard.savedCameraPosition[0].toFixed(1)}, ${billboard.savedCameraPosition[1].toFixed(1)}, ${billboard.savedCameraPosition[2].toFixed(1)})`);
                this.autoSaveBillboards();
            }
        };
        controlsDiv.appendChild(setViewAngleButton);

        // Delete button
        const deleteButton = document.createElement('button');
        deleteButton.textContent = 'Delete Billboard';
        deleteButton.style.width = '100%';
        deleteButton.style.padding = '6px';
        deleteButton.style.cursor = 'pointer';
        deleteButton.style.backgroundColor = '#ff4444';
        deleteButton.style.border = 'none';
        deleteButton.style.color = 'white';
        deleteButton.onclick = () => {
            if (this.selectedBillboardIndex >= 0) {
                const deletedIndex = this.selectedBillboardIndex;
                this.billboardRenderers[deletedIndex].destroy(this.device);
                this.billboardRenderers.splice(deletedIndex, 1);

                // Select a valid billboard after deletion
                if (this.billboardRenderers.length > 0) {
                    // If we deleted the last billboard, select the new last one
                    // Otherwise, keep the same index (which now points to the next billboard)
                    this.selectedBillboardIndex = Math.min(deletedIndex, this.billboardRenderers.length - 1);
                } else {
                    // No billboards left
                    this.selectedBillboardIndex = -1;
                }

                console.log('Billboard deleted');
                this.autoSaveBillboards();
                updateControls();
            }
        };
        controlsDiv.appendChild(deleteButton);

        updateControls();

        return [renderHacksPanel, billboardPanel];
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(16/60);

        // Pass mesh data to physics camera controller for collision detection
        if (c instanceof PhysicsCameraController) {
            c.setMeshDatas(this.meshDatas);
            console.log(`🎮 Physics camera controller initialized with ${this.meshDatas.length} collision meshes`);
        }
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        // Store camera reference for UI
        this.currentCamera = viewerInput;

        // Check for warp billboard collisions
        this.checkWarpBillboardCollisions();

        this.renderHelper.pushTemplateRenderInst();

        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListMain);
        for (let i = 0; i < this.meshRenderers.length; i++)
            this.meshRenderers[i].prepareToRender(device, this.renderHelper.renderInstManager, viewerInput);

        // Render billboards after world geometry
        for (let i = 0; i < this.billboardRenderers.length; i++)
            this.billboardRenderers[i].prepareToRender(device, this.renderHelper.renderInstManager, viewerInput);

        this.renderHelper.renderInstManager.popTemplate();
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const renderInstManager = this.renderHelper.renderInstManager;
        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, this.clearAttachmentDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, this.clearAttachmentDescriptor);

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        this.renderInstListMain.reset();
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
        for (let i = 0; i < this.meshDatas.length; i++)
            this.meshDatas[i].destroy(device);
        for (let i = 0; i < this.meshRenderers.length; i++)
            this.meshRenderers[i].destroy(device);
        for (let i = 0; i < this.billboardRenderers.length; i++)
            this.billboardRenderers[i].destroy(device);

        // Clean up dialog box UI element
        if (this.dialogBoxElement) {
            document.body.removeChild(this.dialogBoxElement);
            this.dialogBoxElement = null;
            this.dialogTextElement = null;
        }
    }

    private async generateImage(prompt: string, model: string): Promise<string | null> {
        const apiKey = __OPENROUTER_API_KEY;

        if (!apiKey) {
            throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable.');
        }

        const client = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: apiKey,
            dangerouslyAllowBrowser: true, // Required for browser usage
        });

        try {
            // Generate image with OpenRouter
            const apiResponse = await client.chat.completions.create({
                model: model,
                messages: [
                    {
                        role: 'user' as const,
                        content: prompt,
                    },
                ],
                modalities: ['image', 'text'] as any,
            });

            const response = apiResponse.choices[0].message;
            if ((response as any).images && (response as any).images.length > 0) {
                const imageDataUrl = (response as any).images[0].image_url.url;
                console.log(`✓ Image generated successfully`);

                // Save image to disk via backend endpoint
                try {
                    const saveResponse = await fetch('/api/save-image', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ imageData: imageDataUrl }),
                    });

                    if (!saveResponse.ok) {
                        throw new Error('Failed to save image to disk');
                    }

                    const { path } = await saveResponse.json();
                    console.log(`✓ Image saved to: ${path}`);
                    return path; // Return the file path instead of data URL
                } catch (saveError) {
                    console.error('Failed to save image, using data URL fallback:', saveError);
                    return imageDataUrl; // Fallback to data URL if save fails
                }
            } else {
                console.warn('No images returned from API');
                return null;
            }
        } catch (error) {
            console.error('OpenRouter API error:', error);
            throw error;
        }
    }

    public addBillboard(device: GfxDevice, x: number, y: number, z: number, size: number = 100, r: number = 1.0, g: number = 1.0, b: number = 1.0, a: number = 1.0, renderBehindWalls: boolean = false): void {
        const billboard = new BillboardRenderer(device, this.renderHelper.renderCache, x, y, z, size, r, g, b, a, renderBehindWalls);
        billboard.dialogueText = 'Hello! This is a new billboard. Edit this text in the Billboard Controls panel.';

        // Save current camera position/orientation as default viewing angle
        if (this.currentCamera) {
            const camera = this.currentCamera.camera;
            billboard.savedCameraPosition = vec3.fromValues(
                camera.worldMatrix[12],
                camera.worldMatrix[13],
                camera.worldMatrix[14]
            );
            billboard.savedCameraOrientation = mat4.clone(camera.worldMatrix);
            console.log(`📷 Saved spawn position as default viewing angle for new billboard`);
        }

        this.billboardRenderers.push(billboard);
        this.autoSaveBillboards();
    }

    private autoSaveBillboards(): void {
        try {
            const json = this.exportBillboardsToJSON();
            const storageKey = `billboards_${this.sceneId}`;
            localStorage.setItem(storageKey, json);
            console.log(`💾 Auto-saved ${this.billboardRenderers.length} billboards to localStorage (${this.sceneId})`);
        } catch (error) {
            console.error('Failed to auto-save billboards:', error);
        }
    }

    private autoLoadBillboards(): void {
        try {
            const storageKey = `billboards_${this.sceneId}`;
            const json = localStorage.getItem(storageKey);
            if (json) {
                this.importBillboardsFromJSON(json);
                console.log(`📂 Auto-loaded billboards from localStorage (${this.sceneId})`);
            }
        } catch (error) {
            console.error('Failed to auto-load billboards:', error);
        }
    }

    public exportBillboardsToJSON(): string {
        const billboardData = this.billboardRenderers.map((billboard, index) => ({
            index,
            position: [billboard.position[0], billboard.position[1], billboard.position[2]],
            size: billboard.size,
            color: [billboard.color[0], billboard.color[1], billboard.color[2], billboard.color[3]],
            dialogueText: billboard.dialogueText,
            renderBehindWalls: billboard.renderBehindWalls,
            imageName: billboard.imageName,
            imageData: billboard.imageData,
            savedCameraPosition: billboard.savedCameraPosition ? [
                billboard.savedCameraPosition[0],
                billboard.savedCameraPosition[1],
                billboard.savedCameraPosition[2]
            ] : null,
            savedCameraOrientation: billboard.savedCameraOrientation ? Array.from(billboard.savedCameraOrientation) : null,
            isWarpBillboard: billboard.isWarpBillboard,
            targetScene: billboard.targetScene,
            warpRadius: billboard.warpRadius,
        }));

        return JSON.stringify({
            version: 1,
            scene: this.sceneId,
            billboards: billboardData
        }, null, 2);
    }

    public importBillboardsFromJSON(jsonString: string): void {
        try {
            const data = JSON.parse(jsonString);

            if (!data.billboards || !Array.isArray(data.billboards)) {
                console.error('Invalid billboard data format');
                return;
            }

            // Clear existing billboards
            for (const billboard of this.billboardRenderers) {
                billboard.destroy(this.device);
            }
            this.billboardRenderers = [];

            // Create billboards from JSON
            for (const billboardData of data.billboards) {
                const billboard = new BillboardRenderer(
                    this.device,
                    this.renderHelper.renderCache,
                    billboardData.position[0],
                    billboardData.position[1],
                    billboardData.position[2],
                    billboardData.size,
                    billboardData.color[0],
                    billboardData.color[1],
                    billboardData.color[2],
                    billboardData.color[3],
                    billboardData.renderBehindWalls
                );

                billboard.dialogueText = billboardData.dialogueText || '';
                billboard.imageName = billboardData.imageName || 'bocchi.png';

                // Restore warp billboard properties
                billboard.isWarpBillboard = billboardData.isWarpBillboard || false;
                billboard.targetScene = billboardData.targetScene || '';
                billboard.warpRadius = billboardData.warpRadius || 150;

                // Restore saved camera position/orientation
                if (billboardData.savedCameraPosition) {
                    billboard.savedCameraPosition = vec3.fromValues(
                        billboardData.savedCameraPosition[0],
                        billboardData.savedCameraPosition[1],
                        billboardData.savedCameraPosition[2]
                    );
                }

                if (billboardData.savedCameraOrientation) {
                    const orient = billboardData.savedCameraOrientation;
                    billboard.savedCameraOrientation = mat4.fromValues(
                        orient[0], orient[1], orient[2], orient[3],
                        orient[4], orient[5], orient[6], orient[7],
                        orient[8], orient[9], orient[10], orient[11],
                        orient[12], orient[13], orient[14], orient[15]
                    );
                }

                // Load image if present
                if (billboardData.imageData) {
                    billboard.imageData = billboardData.imageData;
                    billboard.loadImageFromDataURL(billboardData.imageData, billboard.imageName);
                }

                this.billboardRenderers.push(billboard);
            }

            console.log(`✓ Loaded ${this.billboardRenderers.length} billboards from JSON`);
            this.selectedBillboardIndex = this.billboardRenderers.length > 0 ? 0 : -1;
            this.autoSaveBillboards(); // Save to localStorage after importing
        } catch (error) {
            console.error('Failed to import billboards:', error);
        }
    }
}

function createRendererFromZELVIEW0(device: GfxDevice, zelview: ZELVIEW0, sceneId?: string): ZelviewRenderer {
    const renderer = new ZelviewRenderer(device, zelview, sceneId);

    const headers = zelview.loadScene(zelview.sceneFile);
    // console.log(`headers: ${JSON.stringify(headers, null, '\t')}`);

    function createMeshRenderer(rspOutput: (RSPOutput | null)) {
        if (!rspOutput) {
            return;
        }
        
        const cache = renderer.renderHelper.renderCache;
        const mesh: Mesh = {
            sharedOutput: zelview.sharedOutput,
            rspState: new RSPState(headers.rom, zelview.sharedOutput),
            rspOutput: rspOutput,
        }

        const meshData = new MeshData(device, cache, mesh);
        const meshRenderer = new RootMeshRenderer(device, cache, meshData);
        renderer.meshDatas.push(meshData);
        renderer.meshRenderers.push(meshRenderer);
    }

    function createRenderer(headers: Headers) {
        if (headers.mesh) {
            for (let i = 0; i < headers.mesh.opaque.length; i++) {
                createMeshRenderer(headers.mesh.opaque[i]);
            }
            
            for (let i = 0; i < headers.mesh.transparent.length; i++) {
                // FIXME: sort transparent meshes back-to-front
                createMeshRenderer(headers.mesh.transparent[i]);
            }
        } else {
            for (let i = 0; i < headers.rooms.length; i++) {
                console.log(`Loading ${headers.filename} room ${i}...`);
                createRenderer(headers.rooms[i]);
            }
        }
    }

    createRenderer(headers);

    return renderer;
}

export class ZelviewSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string, private base: string = pathBase) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const dataFetcher = context.dataFetcher;
        const zelviewData = await dataFetcher.fetchData(`${this.base}/${this.id}.zelview0`);

        const zelview0 = readZELVIEW0(zelviewData);
        const renderer = createRendererFromZELVIEW0(device, zelview0, this.id);

        // Expose renderer to browser console for testing
        (window as any).zelviewRenderer = renderer;
        (window as any).zelviewDevice = device;
        (window as any).spawnBillboard = (x: number, y: number, z: number, size: number = 100, r: number = 1.0, g: number = 1.0, b: number = 1.0, a: number = 1.0, renderBehindWalls: boolean = false) => {
            renderer.addBillboard(device, x, y, z, size, r, g, b, a, renderBehindWalls);
        };

        console.log('🎮 Zelda OoT Renderer loaded! Use spawnBillboard(x, y, z, size, r, g, b, a, renderBehindWalls) to add billboards');
        console.log('Example: spawnBillboard(0, 200, 0, 150, 1.0, 0.0, 0.0, 1.0, false) for red billboard');
        console.log('Use the UI to upload images to billboards after spawning');

        return renderer;
    }
}

const id = 'zelview';
const name = 'The Legend of Zelda: Ocarina of Time';
const sceneDescs = [
    // TODO: Implement scenes with JFIF backgrounds. They are commented out.
    "Kokiri Forest",
    new ZelviewSceneDesc('spot04_scene', 'Kokiri Forest'),
    new ZelviewSceneDesc('ydan_scene', 'Inside the Deku Tree'),
    new ZelviewSceneDesc('ydan_boss_scene', 'Inside the Deku Tree (Boss)'),
    new ZelviewSceneDesc('spot10_scene', 'Lost Woods'),
    new ZelviewSceneDesc('spot05_scene', 'Sacred Forest Meadow'),
    new ZelviewSceneDesc('Bmori1_scene', 'Forest Temple'),
    new ZelviewSceneDesc('moribossroom_scene', 'Forest Temple (Boss)'),
    // new ZelviewSceneDesc('kokiri_home_scene', "Know-it-all Brothers' Home"),
    // new ZelviewSceneDesc('kokiri_shop_scene', 'Kokiri Shop'),
    // new ZelviewSceneDesc('link_home_scene', "Link's Home"),
    // new ZelviewSceneDesc('kokiri_home3_scene', 'House of Twins'),
    // new ZelviewSceneDesc('kokiri_home4_scene', "Mido's House"),
    // new ZelviewSceneDesc('kokiri_home5_scene', "Saria's House"),

    "Kakariko Village",
    new ZelviewSceneDesc('spot01_scene', 'Kakariko Village'),
    new ZelviewSceneDesc('kinsuta_scene', 'Skulltula House'),
    // new ZelviewSceneDesc('labo_scene', "Impa's House"),
    new ZelviewSceneDesc('mahouya_scene', "Granny's Potion Shop"),
    // new ZelviewSceneDesc('drag_scene', 'Kakariko Potion Shop'),
    new ZelviewSceneDesc('spot02_scene', 'Kakariko Graveyard'),
    // new ZelviewSceneDesc('hut_scene', "Dampé's Hut"),
    new ZelviewSceneDesc('hakasitarelay_scene', "Dampé's Grave & Kakariko Windmill"),
    new ZelviewSceneDesc('hakaana_ouke_scene', "Royal Family's Tomb"),
    new ZelviewSceneDesc('HAKAdan_scene', 'Shadow Temple'),
    new ZelviewSceneDesc('HAKAdan_bs_scene', 'Shadow Temple (Boss)'),
    new ZelviewSceneDesc('HAKAdanCH_scene', 'Bottom of the Well'),
    new ZelviewSceneDesc('hakaana_scene', 'Heart Piece Grave'),
    new ZelviewSceneDesc('hakaana2_scene', 'Fairy Fountain Grave'),
    // new ZelviewSceneDesc('shop1_scene', 'Kakariko Bazaar'),
    new ZelviewSceneDesc('syatekijyou_scene', 'Shooting Gallery'),
    // new ZelviewSceneDesc('kakariko_scene', 'Kakariko Village House'),
    // new ZelviewSceneDesc('kakariko3_scene', 'Back Alley Village House'),

    "Death Mountain",
    new ZelviewSceneDesc('spot16_scene', 'Death Mountain'),
    new ZelviewSceneDesc('spot17_scene', 'Death Mountain Crater'),
    new ZelviewSceneDesc('spot18_scene', 'Goron City'),
    // new ZelviewSceneDesc('golon_scene', 'Goron Shop'),
    new ZelviewSceneDesc('ddan_scene', "Dodongo's Cavern"),
    new ZelviewSceneDesc('ddan_boss_scene', "Dodongo's Cavern (Boss)"),
    new ZelviewSceneDesc('HIDAN_scene', 'Fire Temple'),
    new ZelviewSceneDesc('FIRE_bs_scene', 'Fire Temple (Boss)'),

    "Hyrule Field",
    new ZelviewSceneDesc('spot00_scene', 'Hyrule Field'),
    new ZelviewSceneDesc('spot20_scene', 'Lon Lon Ranch'),
    // new ZelviewSceneDesc('souko_scene', "Talon's House"),
    // new ZelviewSceneDesc('malon_stable_scene', 'Stables'),
    new ZelviewSceneDesc('spot03_scene', "Zora's River"),
    new ZelviewSceneDesc('daiyousei_izumi_scene', 'Great Fairy Fountain'),
    new ZelviewSceneDesc('yousei_izumi_tate_scene', 'Small Fairy Fountain'),
    new ZelviewSceneDesc('yousei_izumi_yoko_scene', 'Magic Fairy Fountain'),
    new ZelviewSceneDesc('kakusiana_scene', 'Grottos'),
    new ZelviewSceneDesc('hiral_demo_scene', 'Cutscene Map'),

    "Hyrule Castle / Town",
    new ZelviewSceneDesc('spot15_scene', 'Hyrule Castle'),
    new ZelviewSceneDesc('hairal_niwa_scene', 'Castle Courtyard'),
    new ZelviewSceneDesc('hairal_niwa_n_scene', 'Castle Courtyard (Night)'),
    new ZelviewSceneDesc('nakaniwa_scene', "Zelda's Courtyard"),
    // new ZelviewSceneDesc('entra_scene', 'Market Entrance (Day)'),
    // new ZelviewSceneDesc('entra_n_scene', 'Market Entrance (Night)'),
    // new ZelviewSceneDesc('enrui_scene', 'Market Entrance (Ruins)'),
    new ZelviewSceneDesc('miharigoya_scene', "Lots'o'Pots"),
    // new ZelviewSceneDesc('market_day_scene', 'Market (Day)'),
    // new ZelviewSceneDesc('market_night_scene', 'Market (Night)'),
    // new ZelviewSceneDesc('market_ruins_scene', 'Market (Ruins)'),
    // new ZelviewSceneDesc('market_alley_scene', 'Market Back-Alley (Day)'),
    // new ZelviewSceneDesc('market_alley_n_scene', 'Market Back-Alley (Night)'),
    new ZelviewSceneDesc('bowling_scene', 'Bombchu Bowling Alley'),
    // new ZelviewSceneDesc('night_shop_scene', 'Bombchu Shop'),
    new ZelviewSceneDesc('takaraya_scene', 'Treasure Chest Game'),
    // new ZelviewSceneDesc('impa_scene', "Puppy Woman's House"),
    // new ZelviewSceneDesc('alley_shop_scene', 'Market Potion Shop'),
    // new ZelviewSceneDesc('face_shop_scene', 'Happy Mask Shop'),
    // new ZelviewSceneDesc('shrine_scene', 'Temple of Time (Outside, Day)'),
    // new ZelviewSceneDesc('shrine_n_scene', 'Temple of Time (Outside, Night)'),
    // new ZelviewSceneDesc('shrine_r_scene', 'Temple of Time (Outside, Adult)'),
    new ZelviewSceneDesc('tokinoma_scene', 'Temple of Time (Interior)'),
    new ZelviewSceneDesc('kenjyanoma_scene', 'Chamber of Sages'),

    "Lake Hylia",
    new ZelviewSceneDesc('spot06_scene', 'Lake Hylia'),
    new ZelviewSceneDesc('hylia_labo_scene', 'Hylia Lakeside Laboratory'),
    new ZelviewSceneDesc('turibori_scene', 'Fishing Pond'),
    new ZelviewSceneDesc('MIZUsin_scene', 'Water Temple'),
    new ZelviewSceneDesc('MIZUsin_bs_scene', 'Water Temple (Boss)'),

    "Zora's Domain",
    new ZelviewSceneDesc('spot07_scene', "Zora's Domain"),
    new ZelviewSceneDesc('spot08_scene', "Zora's Fountain"),
    // new ZelviewSceneDesc('zoora_scene', 'Zora Shop'),
    new ZelviewSceneDesc('bdan_scene', "Jabu-Jabu's Belly"),
    new ZelviewSceneDesc('bdan_boss_scene', "Jabu-Jabu's Belly (Boss)"),
    new ZelviewSceneDesc('ice_doukutu_scene', 'Ice Cavern'),

    "Gerudo Desert",
    new ZelviewSceneDesc('spot09_scene', 'Gerudo Valley'),
    // new ZelviewSceneDesc('tent_scene', "Carpenter's Tent"),
    new ZelviewSceneDesc('spot12_scene', "Gerudo's Fortress"),
    new ZelviewSceneDesc('men_scene', 'Gerudo Training Grounds'),
    new ZelviewSceneDesc('gerudoway_scene', "Thieves' Hideout"),
    new ZelviewSceneDesc('spot13_scene', 'Haunted Wasteland'),
    new ZelviewSceneDesc('spot11_scene', 'Desert Colossus'),
    new ZelviewSceneDesc('jyasinzou_scene', 'Spirit Temple'),
    new ZelviewSceneDesc('jyasinboss_scene', 'Spirit Temple (Mid-Boss)'),

    "Ganon's Castle",
    new ZelviewSceneDesc('ganontika_scene', "Ganon's Castle"),
    new ZelviewSceneDesc('ganontikasonogo_scene', "Ganon's Castle (Crumbling)"),
    new ZelviewSceneDesc('ganon_tou_scene', "Ganon's Castle (Outside)"),
    new ZelviewSceneDesc('ganon_scene', "Ganon's Castle Tower"),
    new ZelviewSceneDesc('ganon_sonogo_scene', "Ganon's Castle Tower (Crumbling)"),
    new ZelviewSceneDesc('ganon_boss_scene', 'Second-To-Last Boss Ganondorf'),
    new ZelviewSceneDesc('ganon_demo_scene', 'Final Battle Against Ganon'),
    new ZelviewSceneDesc('ganon_final_scene', "Ganondorf's Death"),
    
    "Unused Scenes",
    new ZelviewSceneDesc('test01_scene', 'Collision Testing Area'),
    new ZelviewSceneDesc('besitu_scene', 'Besitu / Treasure Chest Warp'),
    new ZelviewSceneDesc('depth_test_scene', 'Depth Test'),
    new ZelviewSceneDesc('syotes_scene', 'Stalfos Middle Room'),
    new ZelviewSceneDesc('syotes2_scene', 'Stalfos Boss Room'),
    new ZelviewSceneDesc('sutaru_scene', 'Dark Link Testing Area'),
    new ZelviewSceneDesc('hairal_niwa2_scene', 'Beta Castle Courtyard'),
    new ZelviewSceneDesc('sasatest_scene', 'Action Testing Room'),
    new ZelviewSceneDesc('testroom_scene', 'Item Testing Room'),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
