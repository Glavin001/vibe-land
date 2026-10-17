#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"

#include "VibeCityDirector.generated.h"

class UInstancedStaticMeshComponent;
class UMaterialInterface;
class UStaticMesh;
class UStaticMeshComponent;
class UVibeNetSubsystem;
struct VlFrameView;

/**
 * Draws what the shared client core reports: the city's chunks and the players.
 *
 * Milestone 1 ("the bike") draws every chunk as a box (a hull as its bounds), one instance per
 * chunk in an instanced static mesh per colour. A chunk stands at its rest pose, rides a dynamic
 * body (body pose applied to its local offset), or is hidden once removed. Each frame only the
 * chunks of bodies that moved are rewritten.
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
		int32 Component = INDEX_NONE;
		int32 Instance = INDEX_NONE;
		FTransform Rest;
		FVector Scale = FVector::OneVector;
		uint64 Body = 0; // 0: standing
		FVector Local = FVector::ZeroVector;
		bool bRemoved = false;
	};

	UVibeNetSubsystem* Net() const;
	void BuildCity(UVibeNetSubsystem* Net);
	void ApplyFrame(const VlFrameView& Frame);
	void PlaceChunk(int32 ChunkIndex);
	void SyncPlayers(const VlFrameView& Frame);
	void ShowStatus(const VlFrameView& Frame) const;
	void LogTransitions(const VlFrameView& Frame, float DeltaSeconds);
	void MaybeScreenshot(float DeltaSeconds);
	void LookAtPlayerOnce(const FVector& PlayerPosition);

	static uint64 BodyKey(uint32 Structure, uint32 Body) { return (uint64(Structure) << 32) | uint64(Body) | (1ull << 63); }

	UPROPERTY(Transient)
	TArray<TObjectPtr<UInstancedStaticMeshComponent>> ChunkComponents;

	UPROPERTY(Transient)
	TMap<uint32, TObjectPtr<UStaticMeshComponent>> PlayerComponents;

	UPROPERTY(Transient)
	TObjectPtr<UStaticMesh> CubeMesh;

	UPROPERTY(Transient)
	TObjectPtr<UStaticMesh> CylinderMesh;

	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> BaseMaterial;

	TArray<FChunkSlot> Slots;
	TMap<uint64, TArray<int32>> BodyChunks;
	TMap<uint64, FTransform> BodyPoses;
	TSet<int32> DirtyComponents;
	FBox Bounds = FBox(ForceInit);
	bool bCityBuilt = false;
	uint32 LastTransportState = 0;
	uint32 LastCoreState = 0;
	float SecondsSinceStatus = 0.0f;
	FString ShotDir;
	float ShotEvery = -1.0f;
	float SecondsSinceShot = 0.0f;
	int32 ShotCount = 0;
	bool bLookedAtPlayer = false;
};
