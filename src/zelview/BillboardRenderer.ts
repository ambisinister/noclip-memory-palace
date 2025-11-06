import * as Viewer from '../viewer.js';
import { GfxDevice, GfxFormat, GfxTexture, GfxBuffer, GfxBufferUsage, GfxInputLayout, GfxVertexAttributeDescriptor, GfxVertexBufferFrequency, GfxBindingLayoutDescriptor, GfxProgram, GfxBufferFrequencyHint, GfxInputLayoutBufferDescriptor, makeTextureDescriptor2D, GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, GfxSampler, GfxTexFilterMode, GfxMipFilterMode, GfxWrapMode, GfxBlendMode, GfxBlendFactor, GfxCullMode, GfxMegaStateDescriptor, GfxCompareMode } from "../gfx/platform/GfxPlatform.js";
import { mat4, vec3, vec4 } from 'gl-matrix';
import { DeviceProgram } from "../Program.js";
import { GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { fillMatrix4x4, fillMatrix4x3, fillVec4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { computeViewMatrix } from '../Camera.js';
import { TextureMapping } from '../TextureHolder.js';
import { setAttachmentStateSimple } from '../gfx/helpers/GfxMegaStateDescriptorHelpers.js';
import { createBufferFromData } from '../gfx/helpers/BufferHelpers.js';
import { GfxShaderLibrary } from '../gfx/helpers/GfxShaderLibrary.js';

// Simple shader program for billboards
class BillboardProgram extends DeviceProgram {
    public static ub_SceneParams = 0;

    public override vert = `
${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat4x4 u_ModelView;
    vec4 u_Color;
    vec4 u_Params;
};

layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec2 a_TexCoord;

out vec2 v_TexCoord;

void main() {
    v_TexCoord = a_TexCoord;

    // Simple transformation: ModelView * Position
    vec4 viewPos = UnpackMatrix(u_ModelView) * vec4(a_Position, 1.0);
    gl_Position = UnpackMatrix(u_Projection) * viewPos;
}
`;

    public override frag = `
${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat4x4 u_ModelView;
    vec4 u_Color;
    vec4 u_Params; // x: useTexture flag
};

layout(binding = 0) uniform sampler2D u_Texture;

in vec2 v_TexCoord;

void main() {
    if (u_Params.x > 0.5) {
        // Try sampling texture
        vec4 texColor = texture(SAMPLER_2D(u_Texture), v_TexCoord);
        // Output texture directly, force alpha to 1.0
        gl_FragColor = vec4(texColor.rgb, 1.0);
    } else {
        // Use solid color
        gl_FragColor = u_Color;
    }
}
`;
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 1, numSamplers: 1 },
];

export class BillboardRenderer {
    private vertexBuffer: GfxBuffer;
    private indexBuffer: GfxBuffer;
    private inputLayout: GfxInputLayout;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[];
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private program: BillboardProgram;
    private gfxProgram: GfxProgram | null = null;
    private textureMapping = new TextureMapping();
    private megaStateFlags: Partial<GfxMegaStateDescriptor>;

    public position = vec3.create();
    public size = 100.0;
    public visible = true;
    public color = vec4.fromValues(1.0, 1.0, 1.0, 1.0);
    public renderBehindWalls = false;
    public useTexture = true;
    private device: GfxDevice;
    private cache: GfxRenderCache;

    constructor(device: GfxDevice, cache: GfxRenderCache, x: number, y: number, z: number, size: number, r: number = 1.0, g: number = 1.0, b: number = 1.0, a: number = 1.0, renderBehindWalls: boolean = false) {
        this.device = device;
        this.cache = cache;
        vec3.set(this.position, x, y, z);
        this.size = size;
        vec4.set(this.color, r, g, b, a);
        this.renderBehindWalls = renderBehindWalls;

        // Create a simple quad (2 triangles)
        // Centered at origin, will be transformed to world position
        const halfSize = 0.5;
        const vertexData = new Float32Array([
            // Position (x, y, z)     UV (u, v)
            -halfSize, -halfSize, 0,  0, 1,  // Bottom-left
             halfSize, -halfSize, 0,  1, 1,  // Bottom-right
             halfSize,  halfSize, 0,  1, 0,  // Top-right
            -halfSize,  halfSize, 0,  0, 0,  // Top-left
        ]);

        // Two triangles forming a quad
        const indexData = new Uint16Array([
            0, 1, 2,  // First triangle
            0, 2, 3,  // Second triangle
        ]);

        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertexData.buffer);
        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indexData.buffer);

        // Set up vertex format
        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },  // Position
            { location: 1, bufferIndex: 0, format: GfxFormat.F32_RG, bufferByteOffset: 12 },  // TexCoord
        ];

        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 5 * 4, frequency: GfxVertexBufferFrequency.PerVertex },
        ];

        this.inputLayout = cache.createInputLayout({
            indexBufferFormat: GfxFormat.U16_R,
            vertexBufferDescriptors,
            vertexAttributeDescriptors,
        });

        this.vertexBufferDescriptors = [{ buffer: this.vertexBuffer }];
        this.indexBufferDescriptor = { buffer: this.indexBuffer };

        // Create shader program
        this.program = new BillboardProgram();

        // Set up blending for transparency (depth settings will be applied dynamically)
        this.megaStateFlags = {};
        setAttachmentStateSimple(this.megaStateFlags, {
            blendMode: GfxBlendMode.Add,
            blendSrcFactor: GfxBlendFactor.SrcAlpha,
            blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
        });
        this.megaStateFlags.cullMode = GfxCullMode.None;

        // Create a simple test texture
        this.createTestTexture(device, cache);
    }

    public loadImageFromFile(file: File): void {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                // Create canvas to extract image data
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

                // Draw image normally (no flipping needed)
                ctx.drawImage(img, 0, 0);

                const imageData = ctx.getImageData(0, 0, img.width, img.height);
                const pixels = new Uint8Array(imageData.data.buffer);

                // Debug: Sample a few pixels to verify data
                const samplePixels = [
                    Array.from(pixels.slice(0, 4)),           // Top-left
                    Array.from(pixels.slice((img.width - 1) * 4, (img.width - 1) * 4 + 4)),  // Top-right
                    Array.from(pixels.slice((img.width * img.height - img.width) * 4, (img.width * img.height - img.width) * 4 + 4))  // Bottom-left
                ];
                console.log(`Sampled pixels (RGBA) - TL/TR/BL:`, samplePixels);

                // Destroy old texture if it exists
                if (this.textureMapping.gfxTexture !== null) {
                    this.device.destroyTexture(this.textureMapping.gfxTexture);
                }

                // Create new texture from image
                const gfxTexture = this.device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, img.width, img.height, 1));
                this.device.setResourceName(gfxTexture, `Billboard Image: ${file.name}`);
                this.device.uploadTextureData(gfxTexture, 0, [pixels]);

                const gfxSampler = this.cache.createSampler({
                    wrapS: GfxWrapMode.Clamp,
                    wrapT: GfxWrapMode.Clamp,
                    minFilter: GfxTexFilterMode.Bilinear,
                    magFilter: GfxTexFilterMode.Bilinear,
                    mipFilter: GfxMipFilterMode.Nearest,
                    minLOD: 0,
                    maxLOD: 0,
                });

                // Create fresh TextureMapping to avoid any potential caching issues
                this.textureMapping = new TextureMapping();
                this.textureMapping.gfxTexture = gfxTexture;
                this.textureMapping.gfxSampler = gfxSampler;
                this.textureMapping.width = img.width;
                this.textureMapping.height = img.height;
                this.useTexture = true;

                console.log(`✓ Billboard texture loaded: ${file.name} (${img.width}x${img.height})`);
            };
            img.onerror = () => {
                console.error(`✗ Failed to load billboard image: ${file.name}`);
                this.useTexture = false;
            };
            img.src = e.target!.result as string;
        };
        reader.readAsDataURL(file);
    }

    private createTestTexture(device: GfxDevice, cache: GfxRenderCache): void {
        const targetSize = 64;

        // Load bocchi.png and convert to 64x64
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = targetSize;
            canvas.height = targetSize;
            const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

            // Calculate scaling to fit image within 64x64 while maintaining aspect ratio
            const scale = Math.min(targetSize / img.width, targetSize / img.height);
            const scaledWidth = img.width * scale;
            const scaledHeight = img.height * scale;

            // Center the image and pad with transparent pixels
            const offsetX = (targetSize - scaledWidth) / 2;
            const offsetY = (targetSize - scaledHeight) / 2;

            // Clear to transparent
            ctx.clearRect(0, 0, targetSize, targetSize);

            // Draw scaled and centered image
            ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

            const imageData = ctx.getImageData(0, 0, targetSize, targetSize);
            const pixels = new Uint8Array(imageData.data.buffer);

            // Destroy old texture
            device.destroyTexture(this.textureMapping.gfxTexture!);

            // Create new texture from bocchi.png
            const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, targetSize, targetSize, 1));
            device.setResourceName(gfxTexture, 'Billboard Test Texture (bocchi.png)');
            device.uploadTextureData(gfxTexture, 0, [pixels]);

            this.textureMapping.gfxTexture = gfxTexture;

            console.log(`✓ Billboard test texture loaded: bocchi.png (${img.width}x${img.height} → ${targetSize}x${targetSize})`);
        };

        img.onerror = () => {
            console.error('✗ Failed to load bocchi.png');
        };

        // Create initial red placeholder texture
        const pixels = new Uint8Array(targetSize * targetSize * 4);
        for (let i = 0; i < targetSize * targetSize; i++) {
            pixels[i * 4 + 0] = 255;  // R
            pixels[i * 4 + 1] = 0;    // G
            pixels[i * 4 + 2] = 0;    // B
            pixels[i * 4 + 3] = 255;  // A
        }

        const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, targetSize, targetSize, 1));
        device.setResourceName(gfxTexture, 'Billboard Placeholder Texture');
        device.uploadTextureData(gfxTexture, 0, [pixels]);

        const gfxSampler = cache.createSampler({
            wrapS: GfxWrapMode.Clamp,
            wrapT: GfxWrapMode.Clamp,
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
            minLOD: 0,
            maxLOD: 0,
        });

        this.textureMapping.gfxTexture = gfxTexture;
        this.textureMapping.gfxSampler = gfxSampler;
        this.textureMapping.width = targetSize;
        this.textureMapping.height = targetSize;

        // Start loading bocchi.png
        img.src = 'data/ZeldaOcarinaOfTime/bocchi.png';
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        if (!this.visible)
            return;

        if (this.gfxProgram === null)
            this.gfxProgram = renderInstManager.gfxRenderCache.createProgram(this.program);


        // Configure depth testing based on renderBehindWalls flag
        if (this.renderBehindWalls) {
            // Normal mode: render in front of walls, occluded by geometry
            this.megaStateFlags.depthWrite = true;
            this.megaStateFlags.depthCompare = GfxCompareMode.LessEqual;
        } else {
            // Inverted mode: only render when behind walls (for "painting" effect)
            this.megaStateFlags.depthWrite = false;
            this.megaStateFlags.depthCompare = GfxCompareMode.Greater;
        }

        const renderInst = renderInstManager.newRenderInst();
        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setBindingLayouts(bindingLayouts);
        renderInst.setSamplerBindingsFromTextureMappings([this.textureMapping]);
        renderInst.setMegaStateFlags(this.megaStateFlags);
        renderInst.setVertexInput(this.inputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
        renderInst.setDrawCount(6, 0);

        // Compute combined ModelView matrix (View * Billboard)
        const viewMatrix = mat4.create();
        computeViewMatrix(viewMatrix, viewerInput.camera);

        const billboardMatrix = this.computeBillboardMatrix(viewMatrix);

        const modelViewMatrix = mat4.create();
        mat4.multiply(modelViewMatrix, viewMatrix, billboardMatrix);

        // Upload scene params (projection + modelview + color + params)
        let offs = renderInst.allocateUniformBuffer(BillboardProgram.ub_SceneParams, 16 + 16 + 4 + 4);
        const sceneParamsF32 = renderInst.mapUniformBufferF32(BillboardProgram.ub_SceneParams);
        offs += fillMatrix4x4(sceneParamsF32, offs, viewerInput.camera.projectionMatrix);
        offs += fillMatrix4x4(sceneParamsF32, offs, modelViewMatrix);
        offs += fillVec4(sceneParamsF32, offs, this.color[0], this.color[1], this.color[2], this.color[3]);
        offs += fillVec4(sceneParamsF32, offs, this.useTexture ? 1.0 : 0.0, 0.0, 0.0, 0.0);

        renderInstManager.submitRenderInst(renderInst);
    }

    private computeBillboardMatrix(viewMatrix: mat4): mat4 {
        const billboardMatrix = mat4.create();

        // Extract rotation part from view matrix and transpose it
        // This makes the billboard face the camera
        billboardMatrix[0] = viewMatrix[0];
        billboardMatrix[1] = viewMatrix[4];
        billboardMatrix[2] = viewMatrix[8];
        billboardMatrix[3] = 0;

        billboardMatrix[4] = viewMatrix[1];
        billboardMatrix[5] = viewMatrix[5];
        billboardMatrix[6] = viewMatrix[9];
        billboardMatrix[7] = 0;

        billboardMatrix[8] = viewMatrix[2];
        billboardMatrix[9] = viewMatrix[6];
        billboardMatrix[10] = viewMatrix[10];
        billboardMatrix[11] = 0;

        // Scale by billboard size
        mat4.scale(billboardMatrix, billboardMatrix, [this.size, this.size, this.size]);

        // Set position
        billboardMatrix[12] = this.position[0];
        billboardMatrix[13] = this.position[1];
        billboardMatrix[14] = this.position[2];
        billboardMatrix[15] = 1;

        return billboardMatrix;
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.vertexBuffer);
        device.destroyBuffer(this.indexBuffer);
        if (this.textureMapping.gfxTexture !== null)
            device.destroyTexture(this.textureMapping.gfxTexture);
    }
}
