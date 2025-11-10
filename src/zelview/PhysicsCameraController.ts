import { mat4, vec3 } from 'gl-matrix';
import { FPSCameraController, CameraUpdateResult } from '../Camera.js';
import InputManager from '../InputManager.js';
import { Vec3Zero, Vec3UnitY, Vec3UnitX, Vec3UnitZ, getMatrixAxisY, transformVec3Mat4w0, getMatrixAxisZ, clampRange } from '../MathHelpers.js';
import { MeshData } from './render.js';

const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();
const scratchVec3c = vec3.create();
const scratchVec3d = vec3.create();
const scratchVec3e = vec3.create();
const scratchVec3f = vec3.create();

const FPS = 60;

export class PhysicsCameraController extends FPSCameraController {
    // Physics properties
    private verticalVelocity = 0;
    private gravity = -800; // Units per second squared
    private jumpSpeed = 400; // Initial jump velocity
    private terminalVelocity = -1000;
    private isGrounded = false;
    private isFlyMode = false;

    // Collision properties
    private playerHeight = 100; // Height of player capsule
    private playerRadius = 30;  // Radius of player capsule
    private groundCheckDistance = 500; // How far below to check for ground

    // References to scene geometry (to be set externally)
    private meshDatas: MeshData[] = [];

    public setMeshDatas(meshDatas: MeshData[]): void {
        this.meshDatas = meshDatas;
    }

    public override update(inputManager: InputManager, dt: number): CameraUpdateResult {
        const camera = this.camera;
        let updated = false;
        let important = false;

        // Reset camera with B key
        if (inputManager.isKeyDown('KeyB')) {
            mat4.identity(camera.worldMatrix);
            this.cameraUpdateForced();
            this.verticalVelocity = 0;
            this.isGrounded = false;
            updated = true;
        }

        // Speed modifiers
        const isShiftPressed = inputManager.isKeyDown('ShiftLeft') || inputManager.isKeyDown('ShiftRight');
        const isSlashPressed = inputManager.isKeyDown('IntlBackslash') || inputManager.isKeyDown('Backslash');

        let keyMoveMult = 1;
        if (isShiftPressed)
            keyMoveMult = this['keyMoveShiftMult'];
        if (isSlashPressed)
            keyMoveMult = this['keyMoveSlashMult'];

        const keyMoveSpeedCap = this['keyMoveSpeed'] * keyMoveMult;
        const keyMoveVelocity = keyMoveSpeedCap * this['keyMoveVelocityMult'];

        // Horizontal movement (WASD) - same as FPS controller but only horizontal
        const keyMovement = this['keyMovement'];
        const keyMoveLowSpeedCap = 0.1;

        // Forward/Backward (W/S)
        if (inputManager.isKeyDown('KeyW') || inputManager.isKeyDown('ArrowUp')) {
            keyMovement[2] = clampRange(keyMovement[2] - keyMoveVelocity, keyMoveSpeedCap);
        } else if (inputManager.isKeyDown('KeyS') || inputManager.isKeyDown('ArrowDown')) {
            keyMovement[2] = clampRange(keyMovement[2] + keyMoveVelocity, keyMoveSpeedCap);
        } else if (Math.abs(keyMovement[2]) >= keyMoveLowSpeedCap) {
            keyMovement[2] *= this['keyMoveDrag'];
            if (Math.abs(keyMovement[2]) < keyMoveLowSpeedCap) {
                important = true;
                keyMovement[2] = 0.0;
            }
        }

        // Left/Right (A/D)
        if (inputManager.isKeyDown('KeyA') || inputManager.isKeyDown('ArrowLeft')) {
            keyMovement[0] = clampRange(keyMovement[0] - keyMoveVelocity, keyMoveSpeedCap);
        } else if (inputManager.isKeyDown('KeyD') || inputManager.isKeyDown('ArrowRight')) {
            keyMovement[0] = clampRange(keyMovement[0] + keyMoveVelocity, keyMoveSpeedCap);
        } else if (Math.abs(keyMovement[0]) >= keyMoveLowSpeedCap) {
            keyMovement[0] *= this['keyMoveDrag'];
            if (Math.abs(keyMovement[0]) < keyMoveLowSpeedCap) {
                important = true;
                keyMovement[0] = 0.0;
            }
        }

        // Space bar for jumping/flying
        const isSpacePressed = inputManager.isKeyDown('Space');

        if (isSpacePressed) {
            // Toggle fly mode if held
            this.isFlyMode = true;
            // Apply upward force when flying
            this.verticalVelocity = Math.min(this.verticalVelocity + 30, 300);
        } else {
            this.isFlyMode = false;
            // Apply gravity
            this.verticalVelocity += this.gravity * (dt / 1000);
            this.verticalVelocity = Math.max(this.verticalVelocity, this.terminalVelocity);
        }

        // Get camera position
        const cameraPos = scratchVec3a;
        cameraPos[0] = camera.worldMatrix[12];
        cameraPos[1] = camera.worldMatrix[13];
        cameraPos[2] = camera.worldMatrix[14];

        // Check ground collision (simple Y-axis check for now)
        const groundY = this.checkGroundHeight(cameraPos);
        const minY = groundY + this.playerHeight;

        // Apply vertical movement
        const newY = cameraPos[1] + this.verticalVelocity * (dt / 1000);

        if (newY <= minY && !this.isFlyMode) {
            // Hit ground
            cameraPos[1] = minY;
            this.verticalVelocity = 0;
            this.isGrounded = true;

            // Allow jumping when grounded and space pressed
            if (isSpacePressed && this.isGrounded) {
                this.verticalVelocity = this.jumpSpeed;
                this.isGrounded = false;
            }
        } else {
            // In air
            cameraPos[1] = newY;
            this.isGrounded = false;
        }

        // Apply horizontal movement
        const viewRight = scratchVec3b;
        const viewForward = scratchVec3c;

        // Get camera forward direction (on XZ plane only for ground movement)
        getMatrixAxisZ(viewForward, camera.worldMatrix);
        viewForward[1] = 0; // Flatten to horizontal plane
        vec3.normalize(viewForward, viewForward);

        // Get camera right direction (perpendicular to forward on XZ plane)
        vec3.cross(viewRight, Vec3UnitY, viewForward);
        vec3.normalize(viewRight, viewRight);

        if (!vec3.exactEquals(keyMovement, Vec3Zero) || Math.abs(this.verticalVelocity) > 0.1) {
            const finalMovement = scratchVec3d;
            vec3.zero(finalMovement);

            // Add horizontal movement
            vec3.scaleAndAdd(finalMovement, finalMovement, viewRight, keyMovement[0]);
            vec3.scaleAndAdd(finalMovement, finalMovement, viewForward, keyMovement[2]);

            vec3.scale(finalMovement, finalMovement, this.sceneMoveSpeedMult * (dt / FPS));

            // Apply horizontal movement with collision
            const newPos = vec3.create();
            vec3.add(newPos, cameraPos, finalMovement);

            // Simple collision: check if new position is valid
            if (this.checkHorizontalCollision(newPos)) {
                vec3.copy(cameraPos, newPos);
            }

            // Update camera position
            camera.worldMatrix[12] = cameraPos[0];
            camera.worldMatrix[13] = cameraPos[1];
            camera.worldMatrix[14] = cameraPos[2];

            vec3.copy(camera.linearVelocity, finalMovement);
            updated = true;
        } else {
            // Still need to update if vertical movement occurred
            camera.worldMatrix[12] = cameraPos[0];
            camera.worldMatrix[13] = cameraPos[1];
            camera.worldMatrix[14] = cameraPos[2];
            vec3.copy(camera.linearVelocity, Vec3Zero);
            if (Math.abs(this.verticalVelocity) > 0.1) {
                updated = true;
            }
        }

        // Handle mouse look (same as parent class)
        const invertXMult = inputManager.invertX ? -1 : 1;
        const invertYMult = inputManager.invertY ? -1 : 1;
        const dx = inputManager.getMouseDeltaX() * (-1 / this['mouseLookSpeed']) * invertXMult;
        const dy = inputManager.getMouseDeltaY() * (-1 / this['mouseLookSpeed']) * invertYMult;

        const mouseMovement = this['mouseMovement'];
        mouseMovement[0] += dx;
        mouseMovement[1] += dy;

        const viewUp = scratchVec3a;
        getMatrixAxisY(viewUp, camera.viewMatrix);

        if (!vec3.exactEquals(mouseMovement, Vec3Zero)) {
            mat4.rotate(camera.worldMatrix, camera.worldMatrix, mouseMovement[0], Vec3UnitY);
            mat4.rotate(camera.worldMatrix, camera.worldMatrix, mouseMovement[1], Vec3UnitX);
            updated = true;

            const mouseLookDrag = inputManager.isDragging() ? this['mouseLookDragFast'] : this['mouseLookDragSlow'];
            vec3.scale(mouseMovement, mouseMovement, mouseLookDrag);

            const mouseMoveLowSpeedCap = 0.0001;
            if (Math.abs(mouseMovement[0]) < mouseMoveLowSpeedCap) mouseMovement[0] = 0.0;
            if (Math.abs(mouseMovement[1]) < mouseMoveLowSpeedCap) mouseMovement[1] = 0.0;
        }

        // Keep camera upright - prevent roll/tilt by ensuring up vector is always world up
        this.enforceUprightOrientation(camera.worldMatrix);

        this.camera.isOrthographic = false;
        this.camera.worldMatrixUpdated();

        this.forceUpdate = false;

        return important ? CameraUpdateResult.ImportantChange : updated ? CameraUpdateResult.Changed : CameraUpdateResult.Unchanged;
    }

    /**
     * Enforce upright orientation - keeps camera parallel to ground
     * Prevents roll/tilt by ensuring the right vector is always horizontal
     * Still allows looking up and down
     */
    private enforceUprightOrientation(worldMatrix: mat4): void {
        // Extract current position
        const position = scratchVec3a;
        position[0] = worldMatrix[12];
        position[1] = worldMatrix[13];
        position[2] = worldMatrix[14];

        // Extract forward direction (Z axis) - keep as-is to allow looking up/down
        const forward = scratchVec3b;
        forward[0] = worldMatrix[8];
        forward[1] = worldMatrix[9];
        forward[2] = worldMatrix[10];
        vec3.normalize(forward, forward);

        // Calculate right vector - must be horizontal (perpendicular to world up)
        const right = scratchVec3c;
        vec3.cross(right, Vec3UnitY, forward);

        // Handle edge case: if looking straight up or down, forward is parallel to world up
        const rightLength = vec3.length(right);
        if (rightLength < 0.001) {
            // Use a default right vector
            vec3.set(right, 1, 0, 0);
        } else {
            vec3.normalize(right, right);
        }

        // Recalculate up vector to ensure orthogonality (forms proper basis)
        const up = scratchVec3d;
        vec3.cross(up, forward, right);
        vec3.normalize(up, up);

        // Rebuild the matrix with corrected orientation
        // Right vector (X axis) - guaranteed horizontal
        worldMatrix[0] = right[0];
        worldMatrix[1] = right[1];
        worldMatrix[2] = right[2];

        // Up vector (Y axis) - perpendicular to both forward and right
        worldMatrix[4] = up[0];
        worldMatrix[5] = up[1];
        worldMatrix[6] = up[2];

        // Forward vector (Z axis) - preserved from original
        worldMatrix[8] = forward[0];
        worldMatrix[9] = forward[1];
        worldMatrix[10] = forward[2];

        // Restore position
        worldMatrix[12] = position[0];
        worldMatrix[13] = position[1];
        worldMatrix[14] = position[2];
    }

    /**
     * Check the ground height at a given position
     * Returns the Y coordinate of the ground
     */
    private checkGroundHeight(position: vec3): number {
        let maxGroundY = -10000; // Start very low

        // Raycast downward from position to find ground
        for (const meshData of this.meshDatas) {
            const vertices = meshData.mesh.sharedOutput.vertices;
            const indices = meshData.mesh.sharedOutput.indices;

            // Check each triangle
            for (let i = 0; i < indices.length; i += 3) {
                const i0 = indices[i];
                const i1 = indices[i + 1];
                const i2 = indices[i + 2];

                const v0 = vertices[i0];
                const v1 = vertices[i1];
                const v2 = vertices[i2];

                // Simple check: if camera XZ is within triangle XZ bounds
                // and triangle is below camera, use its Y
                const intersectY = this.raycastTriangle(position, v0, v1, v2);
                if (intersectY !== null && intersectY > maxGroundY) {
                    maxGroundY = intersectY;
                }
            }
        }

        // Fallback to Y=0 if no geometry found
        return maxGroundY === -10000 ? 0 : maxGroundY;
    }

    /**
     * Raycast downward onto a triangle
     * Returns the Y coordinate of intersection, or null if no intersection
     */
    private raycastTriangle(rayOrigin: vec3, v0: any, v1: any, v2: any): number | null {
        // Triangle vertices
        const p0 = scratchVec3d;
        const p1 = scratchVec3e;
        const p2 = scratchVec3f;

        vec3.set(p0, v0.x, v0.y, v0.z);
        vec3.set(p1, v1.x, v1.y, v1.z);
        vec3.set(p2, v2.x, v2.y, v2.z);

        // Check if point is within triangle in XZ plane using barycentric coordinates
        const x = rayOrigin[0];
        const z = rayOrigin[2];

        const x0 = p0[0], z0 = p0[2];
        const x1 = p1[0], z1 = p1[2];
        const x2 = p2[0], z2 = p2[2];

        const denom = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
        if (Math.abs(denom) < 0.0001) return null; // Degenerate triangle

        const a = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / denom;
        const b = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / denom;
        const c = 1 - a - b;

        // Point is inside triangle if all barycentric coords are positive
        if (a >= 0 && b >= 0 && c >= 0) {
            // Interpolate Y using barycentric coordinates
            const y = a * p0[1] + b * p1[1] + c * p2[1];

            // Only return if triangle is below the ray origin (within check distance)
            if (y <= rayOrigin[1] && (rayOrigin[1] - y) < this.groundCheckDistance) {
                return y;
            }
        }

        return null;
    }

    /**
     * Check if horizontal movement would cause a collision
     * Returns true if movement is valid, false if collision detected
     */
    private checkHorizontalCollision(newPosition: vec3): boolean {
        // Simple cylinder collision check
        // For now, allow all movement - walls would require more complex collision
        // Could add simple distance checks to triangle edges here
        return true;
    }
}
