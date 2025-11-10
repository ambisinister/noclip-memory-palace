
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

const pathBase = `ZeldaOcarinaOfTime`;

class ZelviewRenderer implements Viewer.SceneGfx {
    private clearAttachmentDescriptor: GfxrAttachmentClearDescriptor;

    public meshDatas: MeshData[] = [];
    public meshRenderers: RootMeshRenderer[] = [];
    public billboardRenderers: BillboardRenderer[] = [];
    public selectedBillboardIndex: number = -1;

    public renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    private device: GfxDevice;
    private currentCamera: Viewer.ViewerRenderInput | null = null;

    constructor(device: GfxDevice, private zelview: ZELVIEW0) {
        this.device = device;
        this.renderHelper = new GfxRenderHelper(device);
        this.clearAttachmentDescriptor = makeAttachmentClearDescriptor(OpaqueBlack);
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
        selectedDiv.style.marginBottom = '10px';
        selectedDiv.style.fontWeight = 'bold';
        billboardPanel.contents.appendChild(selectedDiv);

        const controlsDiv = document.createElement('div');
        controlsDiv.style.display = 'none';
        billboardPanel.contents.appendChild(controlsDiv);

        const updateControls = () => {
            countDiv.textContent = `Total billboards: ${this.billboardRenderers.length}`;

            if (this.selectedBillboardIndex >= 0 && this.selectedBillboardIndex < this.billboardRenderers.length) {
                const billboard = this.billboardRenderers[this.selectedBillboardIndex];
                selectedDiv.textContent = `Selected: Billboard #${this.selectedBillboardIndex + 1}`;
                controlsDiv.style.display = 'block';
                posXInput.value = billboard.position[0].toFixed(1);
                posYInput.value = billboard.position[1].toFixed(1);
                posZInput.value = billboard.position[2].toFixed(1);
                sizeInput.value = billboard.size.toFixed(0);
                sizeValueLabel.textContent = billboard.size.toFixed(0);
                colorRInput.value = billboard.color[0].toFixed(1);
                colorGInput.value = billboard.color[1].toFixed(1);
                colorBInput.value = billboard.color[2].toFixed(1);
                renderBehindCheckbox.checked = billboard.renderBehindWalls;
            } else {
                selectedDiv.textContent = 'No billboard selected';
                controlsDiv.style.display = 'none';
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
            }
        };
        colorContainer.appendChild(colorBInput);

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
            }
        };
        controlsDiv.appendChild(imageFileInput);

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
            }
        };
        renderBehindLabel.appendChild(renderBehindCheckbox);

        const renderBehindText = document.createElement('span');
        renderBehindText.textContent = 'Painting mode (only visible behind walls)';
        renderBehindLabel.appendChild(renderBehindText);

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
                this.billboardRenderers[this.selectedBillboardIndex].destroy(this.device);
                this.billboardRenderers.splice(this.selectedBillboardIndex, 1);
                this.selectedBillboardIndex = -1;
                console.log('Billboard deleted');
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
    }

    public addBillboard(device: GfxDevice, x: number, y: number, z: number, size: number = 100, r: number = 1.0, g: number = 1.0, b: number = 1.0, a: number = 1.0, renderBehindWalls: boolean = false): void {
        const billboard = new BillboardRenderer(device, this.renderHelper.renderCache, x, y, z, size, r, g, b, a, renderBehindWalls);
        this.billboardRenderers.push(billboard);
    }
}

function createRendererFromZELVIEW0(device: GfxDevice, zelview: ZELVIEW0): ZelviewRenderer {
    const renderer = new ZelviewRenderer(device, zelview);

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
        const renderer = createRendererFromZELVIEW0(device, zelview0);

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
