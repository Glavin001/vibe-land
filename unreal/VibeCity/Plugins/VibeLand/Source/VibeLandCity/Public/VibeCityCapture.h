#pragma once

#include "CoreMinimal.h"

class UWorld;

/**
 * The web's capture camera (client/src/scene/captureCamera.ts, window.__VIBE_E2E__.setCapturePose):
 * a camera parked at a point looking at a point, in server space (metres), with a vertical field of
 * view, for comparing the two clients from the same viewpoint. Camera-only: the player, input and
 * the server carry on as before. `vibe.capture px py pz tx ty tz [fov]` parks it; `vibe.capture`
 * releases it.
 */
namespace VibeCityCapture
{
	/** Park the first player's view at the pose; FovDeg ≤ 0 keeps the game's 75°. */
	VIBELANDCITY_API bool Park(UWorld* World, const FVector3f& Position, const FVector3f& LookAt, float FovDeg);
	VIBELANDCITY_API void Release(UWorld* World);
	/** The pose in a "px,py,pz,tx,ty,tz[,fov]" string (the web replay's ?cam= order). */
	VIBELANDCITY_API bool Parse(const FString& Text, FVector3f& Position, FVector3f& LookAt, float& FovDeg);
}
