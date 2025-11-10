import { vec3 } from 'gl-matrix';
import { BillboardRenderer } from './BillboardRenderer.js';
import { GfxDevice, GfxFormat, makeTextureDescriptor2D, GfxCompareMode } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import * as Viewer from '../viewer.js';
import { GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager.js';

export class TextBillboardRenderer extends BillboardRenderer {
    private textContent: string = '';

    constructor(device: GfxDevice, cache: GfxRenderCache, x: number, y: number, z: number, size: number, text: string) {
        super(device, cache, x, y, z, size, 1.0, 1.0, 1.0, 1.0, false, true);
        this.textContent = text;
        this.useTexture = true;
        this.createTextTexture(device, cache);
    }

    public setText(text: string): void {
        this.textContent = text;
        this.createTextTexture(this.device, this.cache);
    }

    public override prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        // Override depth settings before rendering to always render on top
        // Don't write to depth buffer, and always pass depth test
        this.megaStateFlags.depthWrite = false;
        this.megaStateFlags.depthCompare = GfxCompareMode.Always;

        // Call parent to do the actual rendering
        super.prepareToRender(device, renderInstManager, viewerInput);
    }

    private createTextTexture(device: GfxDevice, cache: GfxRenderCache): void {
        // Create canvas for text rendering - wider than tall for dialog box look
        const canvas = document.createElement('canvas');
        const width = 640;
        const height = 180;
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

        // Background - semi-transparent dark panel
        ctx.fillStyle = 'rgba(20, 20, 30, 0.95)';
        ctx.fillRect(0, 0, width, height);

        // Border
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, width - 4, height - 4);

        // Text styling - smaller font to fit more text
        ctx.fillStyle = '#ffffff';
        ctx.font = '14px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        // Word wrap the text
        const maxWidth = width - 40;
        const lineHeight = 18;
        const padding = 20;

        this.wrapText(ctx, this.textContent, padding, padding, maxWidth, lineHeight);

        // Convert canvas to texture
        const imageData = ctx.getImageData(0, 0, width, height);
        const pixels = new Uint8Array(imageData.data.buffer);

        // Destroy old texture if it exists
        if (this.textureMapping.gfxTexture !== null) {
            device.destroyTexture(this.textureMapping.gfxTexture);
        }

        // Create new texture
        const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, width, height, 1));
        device.setResourceName(gfxTexture, 'Text Billboard Texture');
        device.uploadTextureData(gfxTexture, 0, [pixels]);

        const gfxSampler = cache.createSampler({
            wrapS: 1, // Clamp
            wrapT: 1, // Clamp
            minFilter: 1, // Bilinear
            magFilter: 1, // Bilinear
            mipFilter: 0, // Nearest
            minLOD: 0,
            maxLOD: 0,
        });

        this.textureMapping.gfxTexture = gfxTexture;
        this.textureMapping.gfxSampler = gfxSampler;
        this.textureMapping.width = width;
        this.textureMapping.height = height;
    }

    private wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number): void {
        const words = text.split(' ');
        let line = '';
        let yPos = y;

        for (let i = 0; i < words.length; i++) {
            const testLine = line + words[i] + ' ';
            const metrics = ctx.measureText(testLine);
            const testWidth = metrics.width;

            if (testWidth > maxWidth && i > 0) {
                ctx.fillText(line, x, yPos);
                line = words[i] + ' ';
                yPos += lineHeight;
            } else {
                line = testLine;
            }
        }
        ctx.fillText(line, x, yPos);
    }
}
