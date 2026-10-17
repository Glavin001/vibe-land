#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "vibe_client_core.h"

#include "VibeAudio.generated.h"

class USoundAttenuation;
class USoundBase;

/**
 * The city's sounds from the core's frame, with the web's clips (client/public/audio/destruction,
 * imported as sound waves under /Game/VibeCity/Audio/ by their catalog names):
 *   * audible contacts (PKT_AUDIO_CONTACTS): an impact or a scrape, loudness from the server's
 *     intensity, pitch lower for bigger bodies;
 *   * fractures (VL_EVENT_FRACTURE): a fracture clip, and a collapse over 40 chunks;
 *   * shots: the local shot at once, others' as the server resolved them;
 *   * meteors: a fly-by from the launch.
 * Like the web's director (audio/director.ts) it plays one sound per kind per 5 m cell per 65 ms
 * and keeps at most 24 voices. Clips not yet imported are skipped (logged once each).
 */
UCLASS()
class VIBECITY_API AVibeAudio : public AActor
{
	GENERATED_BODY()

public:
	AVibeAudio();

	/** Sounds started so far (tests). */
	int32 Played() const { return PlayedCount; }
	/** Sounds asked for whose clip is not imported (tests). */
	int32 Missing() const { return MissingCount; }

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
	void OnFrame(const VlFrameView& Frame);
	void Play(const FString& Kind, const FString& Clip, const FVector& At, float Volume, float Pitch);
	USoundBase* Clip(const FString& Name);

	UPROPERTY(Transient)
	TObjectPtr<USoundAttenuation> Attenuation;
	UPROPERTY(Transient)
	TMap<FString, TObjectPtr<USoundBase>> Clips;
	TSet<FString> Absent;
	TMap<FString, double> RecentCells;
	TArray<double> VoiceEnds;
	uint32 LocalPlayerId = 0;
	int32 PlayedCount = 0;
	int32 MissingCount = 0;
	FDelegateHandle FrameHandle;
};
