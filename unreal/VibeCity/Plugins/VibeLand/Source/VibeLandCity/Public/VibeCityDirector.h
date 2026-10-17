#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "VibeCityCells.h"

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
 * the cells it took chunks from and the bodies it changed; removed chunks are left out.
 *
 * When this manifest's city was imported (scripts/unreal/import-city.sh: one Nanite static mesh per
 * cell, with mesh distance fields for Lumen, under VibeCityCells::SceneFolder), intact cells draw
 * from those meshes, and a cell swaps to its runtime mesh on its first change. Players,
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

	/** For tests: vertices drawn by standing cells and by bodies, chunks removed, live dust puffs,
	 * whether chunks wear the generated catalog material, sounds seen in frames so far. */
	int64 DrawnCellVertices() const;
	int64 DrawnBodyVertices() const;
	int32 RemovedChunks() const;
	/** The vertices that should be drawn: every chunk's core mesh but the removed ones'. */
	int64 ExpectedVertices() const;
	int32 LiveDust() const { return LiveDustCount; }
	/** Tests: draw `Parcels` as if a frame had brought them (no server needed); returns the ring
	 * slot of the first. */
	int32 InjectDustForTest(TArrayView<const VlDustParcel> Parcels);
	/** Tests: the drawn box of ring slot `Slot` (centre and size, cm), unset while it is not live. */
	TOptional<FBox> DustBox(int32 Slot) const;
	/** Cells drawn from the imported city now, and cells in all. */
	int32 ImportedCellsDrawn() const;
	int32 CellCount() const { return CellChunks.Num(); }
	/** The imported mesh of cell `Cell` (null when it draws its runtime mesh). */
	const class UStaticMesh* ImportedCellMesh(int32 Cell) const;
	/** The cell a chunk belongs to (INDEX_NONE before the city is built). */
	int32 CellOfChunk(int32 Chunk) const { return Slots.IsValidIndex(Chunk) ? Slots[Chunk].Cell : INDEX_NONE; }
	/** The triangles a cell's intact chunks make (opaque, glass). */
	int64 CellTriangles(int32 Cell, bool bGlass) const;
	bool UsesCatalogMaterial() const { return ChunkMaterial != nullptr; }
	int64 SoundsSeen() const { return SoundsSeenCount; }
	/** Loop-frames seen so far: each frame's loop count, summed (scrapes, air). */
	int64 LoopsSeen() const { return LoopsSeenCount; }
	int64 DustSeen() const { return DustSeenCount; }

	/** One frame's cost on the game thread (ms): the core's poll (decode, presentation), applying the
	 * frame to the scene (assignments, body poses, cell rebuilds), and the dust; the frame's time;
	 * poses the frame carried; live bodies and dust parcels. */
	struct FPerfSample
	{
		float FrameMs = 0.0f;
		float PollMs = 0.0f;
		float ApplyMs = 0.0f;
		float DustMs = 0.0f;
		int32 PosesApplied = 0;
		int32 LiveBodies = 0;
		int32 LiveDust = 0;
	};
	/** The last frames' samples (up to 600, oldest overwritten), for tests. */
	const TArray<FPerfSample>& PerfHistory() const { return PerfSamples; }
	void ClearPerfHistory() { PerfSamples.Reset(); PerfHead = 0; }

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

	UVibeNetSubsystem* Net() const;
	void BuildCity(UVibeNetSubsystem* Net);
	void ApplyFrame(const VlFrameView& Frame);
	void RebuildCell(int32 Cell);
	void RebuildBody(uint64 Body);
	void AppendChunk(int32 ChunkIndex, const FTransform& ToComponent, VibeCityCells::FSection& Opaque, VibeCityCells::FSection& Glass) const;
	void ApplySections(UProceduralMeshComponent* Component, VibeCityCells::FSection& Opaque, VibeCityCells::FSection& Glass) const;
	/** Draw cell `Cell` from the imported city, if this manifest's was imported. */
	bool UseImportedCell(int32 Cell, const FString& Folder);
	void DropImportedCell(int32 Cell);
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

	/** Per cell: its imported meshes while it is intact (opaque, glass), else null. */
	UPROPERTY(Transient)
	TArray<TObjectPtr<class UStaticMeshComponent>> ImportedOpaque;
	UPROPERTY(Transient)
	TArray<TObjectPtr<class UStaticMeshComponent>> ImportedGlass;
	TArray<FIntPoint> CellKeys;
	/** Where this manifest's imported cells are (empty: none, or -VibeRuntimeCells). */
	FString ImportedFolder;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> ChunkMaterial;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> GlassMaterial;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> DustMaterial;

	/** Dust parcels (client-core dust.rs, the web's policy), in a ring of the web's capacity
	 * (dustParcelStore.ts DUST_CAPACITY): a full ring overwrites its oldest. Each drawn as one
	 * instance of a sphere stretched to its cloud's box (vl_dust_eval), in M_VibeCityDustVolume. */
	struct FDustParcel
	{
		VlDustParcel P = {};
		float Age = 0.0f;
		bool bAlive = false;
	};
	TArray<FDustParcel> DustParcels;
	int32 DustHead = 0;
	int32 LiveDustCount = 0;

	UPROPERTY(Transient)
	TObjectPtr<class UInstancedStaticMeshComponent> DustInstances;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> DustVolumeMaterial;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> BaseMaterial;

	TArray<FChunkSlot> Slots;
	TArray<TArray<int32>> CellChunks;
	TMap<uint64, TArray<int32>> BodyChunks;
	TMap<uint64, FTransform> BodyPoses;
	TSet<int32> DirtyCells;
	TSet<uint64> DirtyBodies;
	/** What the chunk material reads per catalog entry (VibeCityCells). */
	VibeCityCells::FCatalogMap Catalog;
	bool bHdMaterial = false;
	FBox Bounds = FBox(ForceInit);
	bool bCityBuilt = false;
	UPROPERTY(Transient)
	TObjectPtr<class AVibeCityBatteries> Batteries;
	static constexpr int32 PerfCapacity = 600;
	TArray<FPerfSample> PerfSamples;
	int32 PerfHead = 0;
	int64 SoundsSeenCount = 0;
	int64 LoopsSeenCount = 0;
	int64 DustSeenCount = 0;
	uint32 LastTransportState = 0;
	uint32 LastCoreState = 0;
	float SecondsSinceStatus = 0.0f;
	FString ShotDir;
	float ShotEvery = -1.0f;
	float SecondsSinceShot = 0.0f;
	int32 ShotCount = 0;
};
