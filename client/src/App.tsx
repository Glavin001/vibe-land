/**
 * Vibe Coding Starter Pack: 3D Multiplayer - App.tsx
 *
 * Main application component that orchestrates the entire multiplayer experience.
 * This file serves as the central hub for:
 *
 * 1. SpacetimeDB Connection Management:
 *    - Establishes and maintains WebSocket connection
 *    - Handles authentication and identity
 *    - Subscribes to database tables
 *    - Processes real-time updates
 *
 * 2. Player Input Handling:
 *    - Keyboard and mouse event listeners
 *    - Input state tracking and normalization
 *    - Animation state determination
 *    - Camera/rotation management with pointer lock
 *
 * 3. Game Loop:
 *    - Sends player input to server at appropriate intervals
 *    - Updates local state based on server responses
 *    - Manages the requestAnimationFrame cycle
 *
 * 4. UI Management:
 *    - Renders GameScene (3D view)
 *    - Controls DebugPanel visibility
 *    - Manages JoinGameDialog for player registration
 *    - Displays connection status
 *
 * Extension points:
 *    - Add new input types in currentInputRef and InputState
 *    - Extend determineAnimation for new animation states
 *    - Add new reducers calls for game features (see handleCastSpellInput)
 *    - Modify game loop timing or prediction logic
 *
 * Related files:
 *    - components/GameScene.tsx: 3D rendering with Three.js
 *    - components/Player.tsx: Character model and animation
 *    - components/DebugPanel.tsx: Developer tools and state inspection
 *    - generated/: Auto-generated TypeScript bindings from the server
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import './App.css';
import { Identity } from 'spacetimedb';
import { DbConnection, EventContext, ErrorContext } from './generated';
import { PlayerData, InputState } from './generated/types';
import { DebugPanel } from './components/DebugPanel';
import { GameScene } from './components/GameScene';
import { JoinGameDialog } from './components/JoinGameDialog';
import * as THREE from 'three';
import { PlayerUI } from './components/PlayerUI';
import { MobileControls } from './components/MobileControls';
import { isTouchDevice } from './device';

let conn: DbConnection | null = null;

function App() {
  const [connected, setConnected] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [statusMessage, setStatusMessage] = useState("Connecting...");
  const [players, setPlayers] = useState<ReadonlyMap<string, PlayerData>>(new Map());
  const [localPlayer, setLocalPlayer] = useState<PlayerData | null>(null);
  const [showJoinDialog, setShowJoinDialog] = useState(false);
  const [isDebugPanelExpanded, setIsDebugPanelExpanded] = useState(false);
  const [isPointerLocked, setIsPointerLocked] = useState(false);
  const [isTouch] = useState(() => isTouchDevice());

  // --- Refs for stable access in callbacks (avoid stale closures) ---
  const identityRef = useRef<Identity | null>(null);
  const localPlayerRef = useRef<PlayerData | null>(null);
  const connectedRef = useRef(false);

  // --- Ref for current input state ---
  const currentInputRef = useRef<InputState>({
    forward: false, backward: false, left: false, right: false,
    sprint: false, jump: false, attack: false, castSpell: false,
    sequence: 0,
  });
  const lastSentInputState = useRef<Partial<InputState>>({});
  const animationFrameIdRef = useRef<number | null>(null);

  // Rotation ref for player rotation data
  const playerRotationRef = useRef<THREE.Euler>(new THREE.Euler(0, 0, 0, 'YXZ'));

  // --- Table Callbacks/Subscription Functions ---
  const registerTableCallbacks = useCallback(() => {
    if (!conn) return;
    console.log("Registering table callbacks...");

    conn.db.player.onInsert((_ctx: EventContext, player: PlayerData) => {
        console.log("Player inserted (callback):", player.identity.toHexString());
        setPlayers((prev: ReadonlyMap<string, PlayerData>) => new Map(prev).set(player.identity.toHexString(), player));
        if (identityRef.current && player.identity.toHexString() === identityRef.current.toHexString()) {
            setLocalPlayer(player);
            localPlayerRef.current = player;
            setStatusMessage(`Registered as ${player.username}`);
        }
    });

    conn.db.player.onUpdate((_ctx: EventContext, _oldPlayer: PlayerData, newPlayer: PlayerData) => {
        setPlayers((prev: ReadonlyMap<string, PlayerData>) => {
            const newMap = new Map(prev);
            newMap.set(newPlayer.identity.toHexString(), newPlayer);
            return newMap;
        });
        if (identityRef.current && newPlayer.identity.toHexString() === identityRef.current.toHexString()) {
            setLocalPlayer(newPlayer);
            localPlayerRef.current = newPlayer;
        }
    });

    conn.db.player.onDelete((_ctx: EventContext, player: PlayerData) => {
        console.log("Player deleted (callback):", player.identity.toHexString());
        setPlayers((prev: ReadonlyMap<string, PlayerData>) => {
            const newMap = new Map(prev);
            newMap.delete(player.identity.toHexString());
            return newMap;
        });
        if (identityRef.current && player.identity.toHexString() === identityRef.current.toHexString()) {
            setLocalPlayer(null);
            localPlayerRef.current = null;
            setStatusMessage("Local player deleted!");
        }
    });
    console.log("Table callbacks registered.");
  }, []);

  const onSubscriptionApplied = useCallback(() => {
     console.log("Subscription applied successfully.");
     setPlayers((prev: ReadonlyMap<string, PlayerData>) => {
         if (prev.size === 0 && conn) {
             const currentPlayers = new Map<string, PlayerData>();
             for (const player of conn.db.player.iter()) {
                 currentPlayers.set(player.identity.toHexString(), player);
                 if (identityRef.current && player.identity.toHexString() === identityRef.current.toHexString()) {
                     setLocalPlayer(player);
                     localPlayerRef.current = player;
                 }
             }
             return currentPlayers;
         }
         return prev;
     });
  }, []);

  const onSubscriptionError = useCallback((error: any) => {
      console.error("Subscription error:", error);
      setStatusMessage(`Subscription Error: ${error?.message || error}`);
  }, []);

  const subscribeToTables = useCallback(() => {
    if (!conn) return;
    console.log("Subscribing to tables...");
    conn.subscriptionBuilder()
      .onApplied(onSubscriptionApplied)
      .onError(onSubscriptionError)
      .subscribe("SELECT * FROM player");
  }, [onSubscriptionApplied, onSubscriptionError]);

  // --- Event Handlers ---
  const handleDelegatedClick = useCallback((event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest('.interactive-button');
      if (button) {
          event.preventDefault();
          console.log(`[CLIENT] Button click detected: ${button.getAttribute('data-action')}`);
      }
  }, []);

  // --- Input State Management ---
  const keyMap: { [key: string]: keyof Omit<InputState, 'sequence' | 'castSpell'> } = {
      KeyW: 'forward', KeyS: 'backward', KeyA: 'left', KeyD: 'right',
      ShiftLeft: 'sprint', Space: 'jump',
  };

  const determineAnimation = useCallback((input: InputState): string => {
    if (input.attack) return 'attack1';
    if (input.castSpell) return 'cast';
    if (input.jump) return 'jump';

    const { forward, backward, left, right, sprint } = input;
    const isMoving = forward || backward || left || right;

    if (!isMoving) return 'idle';

    let direction = 'forward';

    if (forward && !backward) {
      direction = 'forward';
    } else if (backward && !forward) {
      direction = 'back';
    } else if (left && !right) {
      direction = 'left';
    } else if (right && !left) {
      direction = 'right';
    } else if (forward && left) {
      direction = 'left';
    } else if (forward && right) {
      direction = 'right';
    } else if (backward && left) {
      direction = 'left';
    } else if (backward && right) {
      direction = 'right';
    }

    const moveType = sprint ? 'run' : 'walk';
    const animationName = `${moveType}-${direction}`;

    return animationName;
  }, []);

  const sendInput = useCallback((currentInputState: InputState) => {
    if (!conn || !identityRef.current || !connectedRef.current) return;
    const currentPosition = localPlayerRef.current?.position || { x: 0, y: 0, z: 0 };

    const currentRotation = {
      x: playerRotationRef.current.x,
      y: playerRotationRef.current.y,
      z: playerRotationRef.current.z
    };

    const currentAnimation = determineAnimation(currentInputState);

    let changed = false;
    for (const key in currentInputState) {
        if (currentInputState[key as keyof InputState] !== lastSentInputState.current[key as keyof InputState]) {
            changed = true;
            break;
        }
    }

    if (changed || currentInputState.sequence !== lastSentInputState.current.sequence) {
        conn.reducers.updatePlayerInput({ input: currentInputState, clientPos: currentPosition, clientRot: currentRotation, clientAnimation: currentAnimation });
        lastSentInputState.current = { ...currentInputState };
    }
  }, [determineAnimation]);

  // Stable ref for sendInput so game loop doesn't restart
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;

  // Add player rotation handler
  const handlePlayerRotation = useCallback((rotation: THREE.Euler) => {
    playerRotationRef.current.copy(rotation);
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
      if (event.repeat) return;
      const action = keyMap[event.code];
      if (action) {
          if (!currentInputRef.current[action]) {
             currentInputRef.current[action] = true;
          }
      }
  }, []);

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
      const action = keyMap[event.code];
      if (action) {
          if (currentInputRef.current[action]) {
              currentInputRef.current[action] = false;
          }
      }
  }, []);

  const handleMouseDown = useCallback((event: MouseEvent) => {
      if (event.button === 0) {
           if (!currentInputRef.current.attack) {
               currentInputRef.current.attack = true;
           }
      }
  }, []);

  const handleMouseUp = useCallback((event: MouseEvent) => {
      if (event.button === 0) {
           if (currentInputRef.current.attack) {
               currentInputRef.current.attack = false;
           }
      }
  }, []);

  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (document.pointerLockElement === document.body) {
      const sensitivity = 0.002;
      playerRotationRef.current.y -= event.movementX * sensitivity;

      playerRotationRef.current.x = Math.max(
        -Math.PI / 2.5,
        Math.min(Math.PI / 2.5, playerRotationRef.current.x - event.movementY * sensitivity)
      );
    }
  }, []);

  // --- Listener Setup/Removal Functions ---
  const handlePointerLockChange = useCallback(() => {
    setIsPointerLocked(document.pointerLockElement === document.body);
    console.log("Pointer Lock Changed: ", document.pointerLockElement === document.body);
  }, []);

  const setupInputListeners = useCallback(() => {
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
      window.addEventListener('mousedown', handleMouseDown);
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('pointerlockchange', handlePointerLockChange);
      console.log("Input listeners added.");
  }, [handleKeyDown, handleKeyUp, handleMouseDown, handleMouseUp, handleMouseMove, handlePointerLockChange]);

  const removeInputListeners = useCallback(() => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      console.log("Input listeners removed.");
  }, [handleKeyDown, handleKeyUp, handleMouseDown, handleMouseUp, handleMouseMove, handlePointerLockChange]);

  const setupDelegatedListeners = useCallback(() => {
      document.body.addEventListener('click', handleDelegatedClick, true);
      console.log("Delegated listener added to body.");
  }, [handleDelegatedClick]);

  const removeDelegatedListeners = useCallback(() => {
      document.body.removeEventListener('click', handleDelegatedClick, true);
      console.log("Delegated listener removed from body.");
  }, [handleDelegatedClick]);

  // --- Game Loop Effect (throttled to ~20Hz, uses stable ref to avoid restarts) ---
  useEffect(() => {
      const INPUT_SEND_INTERVAL = 50; // ms (~20Hz)
      let lastSendTime = 0;
      const gameLoop = () => {
          if (!connectedRef.current || !conn || !identityRef.current) {
              if (animationFrameIdRef.current) {
                  cancelAnimationFrame(animationFrameIdRef.current);
                  animationFrameIdRef.current = null;
              }
              return;
          }
          const now = performance.now();
          if (now - lastSendTime >= INPUT_SEND_INTERVAL) {
              currentInputRef.current.sequence += 1;
              sendInputRef.current(currentInputRef.current);
              lastSendTime = now;
          }
          animationFrameIdRef.current = requestAnimationFrame(gameLoop);
      };

      if (connected && !animationFrameIdRef.current) {
          console.log("[CLIENT] Starting game loop.");
          animationFrameIdRef.current = requestAnimationFrame(gameLoop);
      }

      return () => {
          if (animationFrameIdRef.current) {
              console.log("[CLIENT] Stopping game loop.");
              cancelAnimationFrame(animationFrameIdRef.current);
              animationFrameIdRef.current = null;
          }
      };
  }, [connected]);

  // --- Connection Effect Hook ---
  useEffect(() => {
    console.log("Running Connection Effect Hook...");
    if (conn) {
        console.log("Connection already established, skipping setup.");
         if (connected) {
             setupInputListeners();
             setupDelegatedListeners();
         }
        return;
    }

    const dbHost = "localhost:3000";
    const dbName = "vibe-multiplayer";

    console.log(`Connecting to SpacetimeDB at ${dbHost}, database: ${dbName}...`);

    const onConnect = (connection: DbConnection, id: Identity, _token: string) => {
      console.log("Connected!");
      conn = connection;
      identityRef.current = id;
      connectedRef.current = true;
      setIdentity(id);
      setConnected(true);
      setStatusMessage(`Connected as ${id.toHexString().substring(0, 8)}...`);
      registerTableCallbacks();
      subscribeToTables();
      setupInputListeners();
      setupDelegatedListeners();
      setShowJoinDialog(true);
    };

    const onDisconnect = (_ctx: ErrorContext, reason?: Error | null) => {
      const reasonStr = reason ? reason.message : "No reason given";
      console.log("onDisconnect triggered:", reasonStr);
      setStatusMessage(`Disconnected: ${reasonStr}`);
      conn = null;
      identityRef.current = null;
      connectedRef.current = false;
      localPlayerRef.current = null;
      setIdentity(null);
      setConnected(false);
      setPlayers(new Map());
      setLocalPlayer(null);
    };

    DbConnection.builder()
      .withUri(`ws://${dbHost}`)
      .withDatabaseName(dbName)
      .withConfirmedReads(false)
      .onConnect(onConnect)
      .onDisconnect(onDisconnect)
      .build();

    return () => {
      console.log("Cleaning up connection effect - removing listeners.");
      removeInputListeners();
      removeDelegatedListeners();
    };
  }, []);

  // --- handleJoinGame ---
  const handleJoinGame = (username: string, characterClass: string) => {
    if (!conn) {
        console.error("Cannot join game, not connected.");
        return;
    }
    console.log(`Registering as ${username} (${characterClass})...`);
    conn.reducers.registerPlayer({ username, characterClass });
    setShowJoinDialog(false);
  };

  // --- Render Logic ---
  return (
    <div className="App" style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {showJoinDialog && <JoinGameDialog onJoin={handleJoinGame} />}

      {connected && (
          <DebugPanel
            statusMessage={statusMessage}
            localPlayer={localPlayer}
            identity={identity}
            playerMap={players}
            expanded={isDebugPanelExpanded}
            onToggleExpanded={() => setIsDebugPanelExpanded((prev: boolean) => !prev)}
            isPointerLocked={isPointerLocked}
          />
      )}

      {connected && (
        <>
          <GameScene
            players={players}
            localPlayerIdentity={identity}
            onPlayerRotation={handlePlayerRotation}
            currentInputRef={currentInputRef}
            isDebugPanelVisible={isDebugPanelExpanded}
            isTouchDevice={isTouch}
            externalRotationRef={isTouch ? playerRotationRef : undefined}
          />
          {localPlayer && <PlayerUI playerData={localPlayer} />}
          {isTouch && (
            <MobileControls
              currentInputRef={currentInputRef}
              playerRotationRef={playerRotationRef}
            />
          )}
        </>
      )}

      {!connected && (
          <div style={{ display:'flex', justifyContent:'center', alignItems:'center', height:'100%'}}><h1>{statusMessage}</h1></div>
      )}
    </div>
  );
}

export default App;
