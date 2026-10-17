#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "vibe_client_core.h"

#include "VibeAudio.generated.h"

class UAudioComponent;
class USoundAttenuation;
class USoundBase;

/**
 * Plays the sounds the shared core decides (VlFrameView::sounds: client-core audio.rs and
 * effects.rs, ports of the web's audio policy, so which clip, how loud, its distance falloff and
 * pitch are the web's): clip vl_audio_clip_id(clip) from /Game/VibeCity/Audio/ (imported by
 * scripts/unreal/import-city-audio.sh) at its position, gain and rate, after its delay, spatialized
 * with SA_VibeCity (no further falloff). The core hears from the player's eye.
 *
 * Continuous sounds (VlFrameView::loops: scrapes, air past fast bodies) keep one looping audio
 * component per loop id, moved and re-levelled each frame, faded out when a frame drops the id.
 */
UCLASS()
class VIBECITY_API AVibeAudio : public AActor
{
	GENERATED_BODY()

public:
	AVibeAudio();

	/** Sounds started so far, and sounds whose clip is not imported (tests). */
	int32 Played() const { return PlayedCount; }
	int32 Missing() const { return MissingCount; }
	/** Loops playing now, and loops started so far (tests). */
	int32 LiveLoops() const { return Loops.Num(); }
	int32 LoopsStarted() const { return LoopsStartedCount; }

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;

private:
	struct FPending
	{
		uint32 Clip;
		FVector Position;
		float Gain;
		float Rate;
		double At;
	};

	void OnFrame(const VlFrameView& Frame);
	void Start(const FPending& Sound);
	USoundBase* Clip(uint32 Index);

	UPROPERTY(Transient)
	TObjectPtr<USoundAttenuation> Attenuation;
	UPROPERTY(Transient)
	TMap<uint32, TObjectPtr<USoundBase>> Clips;
	TSet<uint32> Absent;
	TArray<FPending> Pending;
	UPROPERTY(Transient)
	TMap<uint32, TObjectPtr<UAudioComponent>> Loops;
	int32 LoopsStartedCount = 0;
	int32 PlayedCount = 0;
	int32 MissingCount = 0;
	FDelegateHandle FrameHandle;
};
