#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "vibe_client_core.h"

#include "VibeShotEffects.generated.h"

class UMaterialInstanceDynamic;
class UStaticMeshComponent;

/**
 * Shot tracers, from the core's events: this client's shots the moment they are fired
 * (VL_EVENT_LOCAL_SHOT, from the muzzle along the aim), everyone else's as the server resolved them
 * (VL_EVENT_SHOT_FIRED, origin to end). The web's look (scene/shotTrace.ts): a 3.4 cm beam and an
 * 11 cm impact for 140 ms, coloured by what was hit, from a pool of 16.
 */
UCLASS()
class VIBECITY_API AVibeShotEffects : public AActor
{
	GENERATED_BODY()

public:
	AVibeShotEffects();

	/** Tracers currently showing (for tests and overlays). */
	int32 ActiveTracers() const;

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;

private:
	struct FTracer
	{
		TObjectPtr<UStaticMeshComponent> Beam;
		TObjectPtr<UStaticMeshComponent> Impact;
		TObjectPtr<UMaterialInstanceDynamic> Material;
		float Age = 0.0f;
		bool bActive = false;
	};

	void OnFrame(const VlFrameView& Frame);
	void Show(const FVector& From, const FVector& To, const FLinearColor& Color, bool bImpact);

	TArray<FTracer> Pool;
	int32 Next = 0;
	uint32 LocalPlayerId = 0;
	FDelegateHandle FrameHandle;
};
