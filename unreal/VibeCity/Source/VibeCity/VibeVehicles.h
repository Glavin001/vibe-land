#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "vibe_client_core.h"

#include "VibeVehicles.generated.h"

class UMaterialInstanceDynamic;
class UProceduralMeshComponent;
class USceneComponent;

/**
 * The cars the city stream carries (VlCar, on the car clock), drawn from the parts the physics
 * simulates: when a car's asset arrives (VL_EVENT_VEHICLE_ASSET) its metadata.json is fetched from
 * the server and turned into a mesh by the shared core (vl_vehicle_mesh_build, off the game
 * thread). Each car is its chassis and the parts the web's suspension rig moves (wheels, hubs,
 * knuckles, wishbones, uprights, dampers, springs, tie rods, half-shafts, steering wheel), each its
 * own component posed every frame from the car's wheel states by the core (vl_vehicle_mesh_pose).
 *
 * Parts that come off a car (VlCarPart, the stream's detached groups) are taken off its mesh and
 * drawn on their own at the pose the stream gives them, as the web's presentVehicleDebris does.
 */
UCLASS()
class VIBECITY_API AVibeVehicles : public AActor
{
	GENERATED_BODY()

public:
	AVibeVehicles();

	/** The nearest car within `RadiusCm` of `Position` (its handle), if any. */
	TOptional<uint32> NearestCar(const FVector& Position, double RadiusCm) const;
	/** Where a car is now (for tests and HUD hints). */
	TOptional<FVector> CarPosition(uint32 Handle) const;
	TOptional<FQuat> CarRotation(uint32 Handle) const;
	/** A wheel's hub in the world at rest height (tests). */
	TOptional<FVector> WheelPosition(uint32 Handle, int32 Wheel) const;
	/** How many of a car's rig parts its current pose puts away from rest (more than 1 mm or 0.5 deg), and how many it has (tests). */
	TPair<int32, int32> PosedPartsMoved(uint32 Handle) const;
	/** How many times a car's rig has been posed (tests). */
	int32 RigPosings(uint32 Handle) const;
	/** Parts that have come off the car (drawn on their own), for tests. */
	int32 DetachedParts(uint32 Handle) const;
	/** Tests: the visible rig component farthest from its car's root (cm), with a description. */
	TPair<double, FString> FarthestRigPart(uint32 Handle) const;
	/** Cars whose rig parts are drawn as moving components now, and rig components in all (tests). */
	int32 ActiveRigs() const;
	int32 RigComponents() const;
	/** The last wheel states drawn for a car, for tests. */
	TOptional<VlCar> LastCar(uint32 Handle) const;
	int32 CarCount() const { return Cars.Num(); }
	int32 BuiltCars() const;
	/** Parts drawn off their cars right now (tests). */
	int32 LooseParts() const;

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
	struct FCar
	{
		TObjectPtr<USceneComponent> Root;
		TObjectPtr<UProceduralMeshComponent> Chassis;
		/** The core's mesh, kept to pose the rig each frame (vl_vehicle_mesh_pose). */
		VlVehicleMesh* Mesh = nullptr;
		/** The posed parts' rest frames, and the component each is drawn with. */
		TArray<VlPosedPart> Posed;
		TArray<TObjectPtr<UProceduralMeshComponent>> PosedMeshes;
		TArray<VlPartPose> Poses;
		/** The wheel states the rig was last posed for: a car whose wheels have not changed (a parked
		 * car) is not posed again, and only parts whose pose changed are moved. */
		VlWheel PosedWheels[4] = {};
		bool bRigPosed = false;
		/** Whether the rig's parts are drawn as their own moving components (while the car's wheels
		 * are changing); otherwise they are baked into the chassis mesh at their current pose. */
		bool bRigActive = false;
		double LastWheelChangeS = 0.0;
		/** Rig posings and part moves (tests: parked cars must cost nothing). */
		int32 RigPosings = 0;
		FVector Hubs[4];
		bool bBuilt = false;
		bool bRequested = false;
		FString GeometryHash;
		/** The mesh, kept so the car can be rebuilt without its detached parts. */
		TArray<VlVehicleVertex> Vertices;
		float OriginHeight = 0.0f;
		/** Parts off the car, and the component each is drawn with. */
		TSet<uint32> Detached;
		TMap<uint32, TObjectPtr<UProceduralMeshComponent>> Loose;
	};

	void Rebuild(uint32 Handle, FCar& Car);
	UProceduralMeshComponent* LoosePart(uint32 Handle, FCar& Car, uint32 Part);

	void OnFrame(const VlFrameView& Frame);
	FCar& CarFor(uint32 Handle);
	void RequestMesh(uint32 Handle);
	void ApplyMesh(uint32 Handle, VlVehicleMesh* Mesh);
	void PoseRig(uint32 Handle, FCar& Car, const VlCar& C);
	void EnsureRigComponents(uint32 Handle, FCar& Car);
	void SetRigActive(uint32 Handle, FCar& Car, bool bActive);
	UMaterialInstanceDynamic* MaterialFor(uint32 Rgba);

	TMap<uint32, FCar> Cars;
	TMap<uint32, VlCar> LastCars;
	TMap<uint32, TObjectPtr<UMaterialInstanceDynamic>> Materials;
	FDelegateHandle FrameHandle;
};
