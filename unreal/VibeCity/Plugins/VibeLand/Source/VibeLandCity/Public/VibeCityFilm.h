#pragma once

#include "CoreMinimal.h"

/**
 * Recording films from the game's own viewport: frames read back asynchronously (the engine's
 * FFrameGrabber, no render stall) at a set rate, each written as a JPEG on a worker thread, named
 * frame_NNNNN.jpg by wall-clock time from the start (a slow frame leaves a gap; the cutter holds the
 * previous frame). PNG screenshots managed about 2.5 frames a second; this keeps up with the game.
 */
namespace VibeCityFilm
{
	/** Start recording into `Dir` at `Fps`. False when there is no game viewport. */
	VIBELANDCITY_API bool Start(const FString& Dir, double Fps);
	/** Stop, finishing the frames in flight; returns how many frames were written. */
	VIBELANDCITY_API int32 Stop();
	VIBELANDCITY_API bool IsRecording();
}
