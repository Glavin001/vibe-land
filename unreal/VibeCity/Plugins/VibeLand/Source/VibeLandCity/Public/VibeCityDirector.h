#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"

#include "VibeCityDirector.generated.h"

class UMaterialBillboardComponent;
class UMaterialInstanceDynamic;
class UMaterialInterface;
class UProceduralMeshComponent;
class UVibeNetSubsystem;
struct VlFrameView;

/**
 * Draws what the shared client core reports: the city's chunks and the players.
 *
 * Chunks are the core's meshes (convex hulls and boxes, `vl_client_chunk_meshes`) wearing the shared
 * material catalog (`M_VibeCityChunk`, texture arrays built by scripts/unreal/import-city-materials.sh;
 * glass in `M_VibeCityGlass`). Standing chunks are merged into one procedural mesh per 32 m cell; each
 * live dynamic body is its own mesh in the body's frame, moved by its pose. A fracture rebuilds only
 * the cells it took chunks from and the bodies it changed; removed chunks are left out. Players,
 * vehicles and effects are the game module's (VibeCity).
 */
UCLASS()
class VIBELANDCITY_API AVibeCityDirector : public AActor
{
	GENERATED_BODY()

public:
	AVibeCityDirector();

	virtual void Tick(float DeltaSeconds) override;

	/** Bounds of the city once built (for framing a camera). */
	FBox CityBounds() const { return Bounds; }
	bool IsCityBuilt() const { return bCityBuilt; }

	/** Chunks currently on dynamic bodies, and live bodies with a pose. */
	int32 ChunksOnBodies() const;
	int32 PosedBodies() const { return BodyPoses.Num(); }

	/** Fired once, when the city has been built from the manifest. */
	DECLARE_MULTICAST_DELEGATE_OneParam(FOnCityBuilt, const FBox& /*Bounds*/);
	FOnCityBuilt OnCityBuilt;

private:
	struct FChunkSlot
	{
		int32 Cell = INDEX_NONE;
		FTransform Rest;
		uint64 Body = 0; // 0: standing
		FVector Local = FVector::ZeroVector;
		bool bRemoved = false;
	};

	/** One mesh section's buffers while it is being built. */
	struct FSectionBuffers;

	UVibeNetSubsystem* Net() const;
	void BuildCity(UVibeNetSubsystem* Net);
	void ApplyFrame(const VlFrameView& Frame);
	void RebuildCell(int32 Cell);
	void RebuildBody(uint64 Body);
	void AppendChunk(int32 ChunkIndex, const FTransform& ToComponent, FSectionBuffers& Opaque, FSectionBuffers& Glass) const;
	void ApplySections(UProceduralMeshComponent* Component, FSectionBuffers& Opaque, FSectionBuffers& Glass) const;
	UProceduralMeshComponent* NewChunkComponent();
	void SpawnDust(const VlFrameView& Frame);
	void TickDust(float DeltaSeconds);
	void ShowStatus(const VlFrameView& Frame) const;
	void LogTransitions(const VlFrameView& Frame, float DeltaSeconds);
	void MaybeScreenshot(float DeltaSeconds);

	static uint64 BodyKey(uint32 Structure, uint32 Body) { return (uint64(Structure) << 32) | uint64(Body) | (1ull << 63); }

	UPROPERTY(Transient)
	TArray<TObjectPtr<UProceduralMeshComponent>> CellComponents;

	UPROPERTY(Transient)
	TMap<uint64, TObjectPtr<UProceduralMeshComponent>> BodyComponents;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> ChunkMaterial;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> GlassMaterial;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> DustMaterial;

	/** Live dust puffs (client-core effects.rs VlDust), drawn as soft billboards. */
	struct FDustPuff
	{
		FVector Origin = FVector::ZeroVector;
		FVector Drift = FVector::ZeroVector;
		float Radius = 0.0f;
		float Lifetime = 1.0f;
		float Age = 0.0f;
		int32 Slot = INDEX_NONE;
	};
	TArray<FDustPuff> DustPuffs;

	UPROPERTY(Transient)
	TArray<TObjectPtr<UMaterialBillboardComponent>> DustSlots;

	UPROPERTY(Transient)
	TArray<TObjectPtr<UMaterialInstanceDynamic>> DustMaterials;

	TArray<int32> FreeDustSlots;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> BaseMaterial;

	TArray<FChunkSlot> Slots;
	TArray<TArray<int32>> CellChunks;
	TMap<uint64, TArray<int32>> BodyChunks;
	TMap<uint64, FTransform> BodyPoses;
	TSet<int32> DirtyCells;
	TSet<uint64> DirtyBodies;
	/** Per catalog entry: (texture-array layer, metalness), and whether it is glass. */
	TArray<FVector2D> CatalogLayerMetal;
	/** Per catalog entry: the factor on the core's tile UVs for the material drawn (1, or
	 * metres_per_tile / hd_metres_per_tile with the 2K sources). */
	TArray<float> CatalogUvScale;
	bool bHdMaterial = false;
	TArray<bool> CatalogGlass;
	FBox Bounds = FBox(ForceInit);
	bool bCityBuilt = false;
	uint32 LastTransportState = 0;
	uint32 LastCoreState = 0;
	float SecondsSinceStatus = 0.0f;
	FString ShotDir;
	float ShotEvery = -1.0f;
	float SecondsSinceShot = 0.0f;
	int32 ShotCount = 0;
};
