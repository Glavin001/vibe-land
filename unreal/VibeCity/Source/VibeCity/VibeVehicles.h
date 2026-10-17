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
 * thread). Each car is a chassis and, per wheel, a pivot at its hub that rides the suspension
 * travel and steers, carrying the knuckle, and inside it the spinning wheel and hub.
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
	/** A wheel's world position (its spinning parts' pivot), for tests. */
	TOptional<FVector> WheelPosition(uint32 Handle, int32 Wheel) const;
	/** The last wheel states drawn for a car, for tests. */
	TOptional<VlCar> LastCar(uint32 Handle) const;
	int32 CarCount() const { return Cars.Num(); }
	int32 BuiltCars() const;

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
	struct FCar
	{
		TObjectPtr<USceneComponent> Root;
		TObjectPtr<UProceduralMeshComponent> Chassis;
		TObjectPtr<USceneComponent> Pivots[4];
		TObjectPtr<UProceduralMeshComponent> Knuckles[4];
		TObjectPtr<USceneComponent> Spinners[4];
		TObjectPtr<UProceduralMeshComponent> Wheels[4];
		FVector Hubs[4];
		bool bBuilt = false;
		bool bRequested = false;
		FString GeometryHash;
	};

	void OnFrame(const VlFrameView& Frame);
	FCar& CarFor(uint32 Handle);
	void RequestMesh(uint32 Handle);
	void ApplyMesh(uint32 Handle, VlVehicleMesh* Mesh);
	UMaterialInstanceDynamic* MaterialFor(uint32 Rgba);

	TMap<uint32, FCar> Cars;
	TMap<uint32, VlCar> LastCars;
	TMap<uint32, TObjectPtr<UMaterialInstanceDynamic>> Materials;
	FDelegateHandle FrameHandle;
};
