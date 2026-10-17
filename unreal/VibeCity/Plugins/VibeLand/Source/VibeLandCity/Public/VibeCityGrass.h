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
 *
 * The shared painted grass (the server's /match-stats/<match>/grass, the web's GrassPaint layout)
 * is polled every 2 s with If-None-Match, as the web's GrassLayoutSync does; a new revision
 * regenerates every patch over it (the old blades stay until the new ones land).
 */
UCLASS()
class VIBELANDCITY_API AVibeCityGrass : public AActor
{
	GENERATED_BODY()

public:
	AVibeCityGrass();

	virtual void Tick(float DeltaSeconds) override;

	/** For tests: patches with a mesh, and blades drawn across them. */
	int32 DrawnPatches() const;
	int64 DrawnBlades() const;
	/** For tests: plants of a species (foliageProfiles.ts order) drawn now. */
	int64 DrawnOfSpecies(uint32 Species) const;

	/** The bare footprints (server space), from the client core once the manifest arrived. */
	void SetExclusions(TArrayView<const VlGrassExclusion> InExclusions);

	/** Where the shared grass layout is served (empty: the default meadow only). */
	void SetLayoutUrl(const FString& Url) { LayoutUrl = Url; }

	/** Apply a `/match-stats/<id>/grass` response (from the poll, or `vibe.grassfile <path>`, which
	 * also stops polling). False when it is not a valid layout. */
	bool ApplyLayout(TConstArrayView<uint8> Body);

	/** For tests: the shared layout's revision and painted tiles (empty and 0 before one loads). */
	const FString& PaintRevision() const { return Revision; }
	int32 PaintTiles() const;
	/** Patches generated over the current layout so far. */
	int32 PatchesOnCurrentPaint() const { return GeneratedOnPaint; }

private:
	struct FPatch
	{
		TFuture<TArray<VlGrassBlade>> Pending;
		TArray<VlGrassBlade> Blades;
		bool bReady = false;
		int32 Band = -1;
		int32 Drawn = 0;
		int32 DrawnSpecies[5] = {};
		TObjectPtr<UProceduralMeshComponent> Mesh;
	};

	void Rebuild(FPatch& Patch, int32 Band);
	void Generate(FPatch& Patch, FIntPoint Key);
	void PollLayout();

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> GrassMaterial;

	/** Components owned by patches (kept here so the GC sees them). */
	UPROPERTY(Transient)
	TArray<TObjectPtr<UProceduralMeshComponent>> Meshes;

	TMap<FIntPoint, FPatch> Patches;
	TArray<VlGrassExclusion> Exclusions;
	bool bHasExclusions = false;
	float SinceUpdate = 0.0f;

	/** Owns a parsed layout (shared with patch generations still running on it). */
	struct FPaint
	{
		VlGrassPaint* Handle = nullptr;
		explicit FPaint(VlGrassPaint* InHandle) : Handle(InHandle) {}
		~FPaint() { vl_grass_paint_free(Handle); }
	};
	TSharedPtr<FPaint, ESPMode::ThreadSafe> Paint;
	FString Revision;
	FString LayoutUrl;
	float SincePoll = 2.0f;
	bool bPolling = false;
	int32 GeneratedOnPaint = 0;
};
