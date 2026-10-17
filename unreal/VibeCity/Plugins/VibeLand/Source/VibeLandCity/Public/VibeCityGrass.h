#pragma once

#include "CoreMinimal.h"
#include "Async/Future.h"
#include "GameFramework/Actor.h"
#include "vibe_client_core.h"

#include "VibeCityGrass.generated.h"

class UMaterialInterface;
class UProceduralMeshComponent;

/**
 * The meadow the web client shows over the city's ground (client-core grass.rs, a port of
 * client/src/scene/grass): 8 m patches of blades around the camera out to 48 m, generated off the
 * game thread by the shared core, each drawn as one procedural mesh of single-triangle blades. A
 * patch draws the prefix of its blades its distance allows (grass.rs density_at_distance, quantized
 * to a few bands so meshes rebuild only when the band changes).
 */
UCLASS()
class VIBELANDCITY_API AVibeCityGrass : public AActor
{
	GENERATED_BODY()

public:
	AVibeCityGrass();

	virtual void Tick(float DeltaSeconds) override;

	/** The bare footprints (server space), from the client core once the manifest arrived. */
	void SetExclusions(TArrayView<const VlGrassExclusion> InExclusions);

private:
	struct FPatch
	{
		TFuture<TArray<VlGrassBlade>> Pending;
		TArray<VlGrassBlade> Blades;
		bool bReady = false;
		int32 Band = -1;
		TObjectPtr<UProceduralMeshComponent> Mesh;
	};

	void Rebuild(FPatch& Patch, int32 Band);

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> GrassMaterial;

	/** Components owned by patches (kept here so the GC sees them). */
	UPROPERTY(Transient)
	TArray<TObjectPtr<UProceduralMeshComponent>> Meshes;

	TMap<FIntPoint, FPatch> Patches;
	TArray<VlGrassExclusion> Exclusions;
	bool bHasExclusions = false;
	float SinceUpdate = 0.0f;
};
