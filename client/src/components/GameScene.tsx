/**
 * GameScene.tsx — React Three Fiber Canvas containing the 3D game world.
 * Renders sky, lighting, ground plane, grid, and all Player entities.
 * Debug helpers (light/shadow camera) toggle with isDebugPanelVisible.
 */

import React, { useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { Box, Plane, Grid, Sky } from '@react-three/drei';
import * as THREE from 'three';
import { DirectionalLightHelper, CameraHelper } from 'three'; // Import the helper
// Import generated types
import { PlayerData, InputState } from '../generated/types';
import { Identity } from 'spacetimedb';
import { Player } from './Player';

interface GameSceneProps {
  players: ReadonlyMap<string, PlayerData>; // Receive the map
  localPlayerIdentity: Identity | null;
  onPlayerRotation?: (rotation: THREE.Euler) => void; // Optional callback for player rotation
  currentInputRef?: React.MutableRefObject<InputState>; // Add input state ref prop
  isDebugPanelVisible?: boolean; // Prop to indicate if the debug panel is visible
  isTouchDevice?: boolean; // Whether running on a touch device (skip pointer lock)
  externalRotationRef?: React.MutableRefObject<THREE.Euler>; // Touch rotation from MobileControls
}

export const GameScene: React.FC<GameSceneProps> = ({ 
  players,
  localPlayerIdentity,
  onPlayerRotation,
  currentInputRef, // Receive input state ref
  isDebugPanelVisible = false, // Destructure the new prop
  isTouchDevice = false,
  externalRotationRef,
}) => {
  // Ref for the main directional light
  const directionalLightRef = useRef<THREE.DirectionalLight>(null!); 

  return (
    <Canvas
      camera={{ position: [0, 10, 20], fov: 60 }}
      style={{
        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 1,
        ...(isTouchDevice ? { touchAction: 'none' } : {}),
      }}
      shadows // Enable shadows
    >
      {/* Remove solid color background */}
      {/* <color attach="background" args={['#add8e6']} /> */}
      
      {/* Add Sky component */}
      <Sky distance={450000} sunPosition={[5, 1, 8]} inclination={0} azimuth={0.25} />

      {/* Ambient light for general scene illumination */}
      <ambientLight intensity={0.5} />
      
      {/* Main directional light with improved shadow settings */}
      <directionalLight 
        ref={directionalLightRef} // Assign ref
        position={[15, 20, 10]} 
        intensity={2.5} 
        castShadow 
        shadow-mapSize-width={2048} // Increased resolution
        shadow-mapSize-height={2048} // Increased resolution
        shadow-bias={-0.0001} // Made bias less negative (closer to 0)
        shadow-camera-left={-30} // Wider frustum
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-camera-near={0.1} // Closer near plane
        shadow-camera-far={100} // Further far plane
      />

      {/* Conditionally render Light and Shadow Camera Helpers */}
      {isDebugPanelVisible && directionalLightRef.current && (
        <>
          <primitive object={new DirectionalLightHelper(directionalLightRef.current, 5)} />
          {/* Add CameraHelper for the shadow camera */}
          <primitive object={new CameraHelper(directionalLightRef.current.shadow.camera)} /> 
        </>
      )}
      
      {/* Visible Background Plane (darker, receives shadows) */}
      <Plane 
        args={[200, 200]} 
        rotation={[-Math.PI / 2, 0, 0]} 
        position={[0, -0.001, 0]} 
        receiveShadow={true} 
      >
        <meshStandardMaterial color="#606060" /> { /* Changed to darker gray */ }
      </Plane>

      {/* Simplified Grid Helper (mid-gray lines) */}
      <Grid 
        position={[0, 0, 0]} 
        args={[200, 200]} 
        cellSize={2} 
        cellThickness={1}
        cellColor={new THREE.Color('#888888')} // Mid-gray grid lines
      />

      {/* Render Players */}
      {Array.from(players.values()).map((player) => {
        const isLocal = localPlayerIdentity?.toHexString() === player.identity.toHexString();
        return (
          <Player
            key={player.identity.toHexString()}
            playerData={player}
            isLocalPlayer={isLocal}
            onRotationChange={isLocal ? onPlayerRotation : undefined}
            currentInputRef={isLocal ? currentInputRef : undefined}
            isDebugArrowVisible={isLocal ? isDebugPanelVisible : false} // Pass down arrow visibility
            isDebugPanelVisible={isDebugPanelVisible} // Pass down general debug visibility
            isTouchDevice={isTouchDevice}
            externalRotationRef={isLocal ? externalRotationRef : undefined}
          />
        );
      })}

      {/* Remove OrbitControls as we're using our own camera controls */}
    </Canvas>
  );
};
